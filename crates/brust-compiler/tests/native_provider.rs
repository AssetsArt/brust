//! 2c-2 (R34.116, R34.122-R34.125): a Provider whose context value is state is specialised per call site: the call
//! site's content moves into a clone of the Provider component, compiled as a component of its own. Every shape the
//! splice cannot carry keeps the island Provider the call site had (and says why), never a clone without its content.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

struct Item {
    ir: ComponentIR,
    jinja: String,
    client: Option<String>,
    modules: Vec<(String, String)>,
}

fn compile(file: &str) -> Vec<Item> {
    let file = file.to_string();
    run_on_compiler_thread(move || {
        let opts = AnalyzeOptions {
            root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
            ..Default::default()
        };
        compile_tree(
            &format!("crates/brust-compiler/tests/fixtures/native-provider/{file}"),
            None,
            &opts,
            "/_brust/client/runtime.js",
        )
        .unwrap()
        .into_iter()
        .map(|l| Item {
            ir: (*l.ir).clone(),
            jinja: l.artifacts.jinja.clone(),
            client: l.artifacts.client_js.clone(),
            modules: l.artifacts.client_modules.clone(),
        })
        .collect()
    })
}

fn clones(all: &[Item]) -> Vec<&Item> {
    all.iter().filter(|i| i.ir.specialised).collect()
}

fn has(ir: &ComponentIR, class: DiagClass, rule: &str) -> bool {
    ir.diagnostics
        .iter()
        .any(|d| d.class == class && d.rule == rule)
}

fn is_react(ir: &ComponentIR) -> bool {
    matches!(ir.tier, Tier::React { .. })
}

#[test]
fn a_state_provider_with_markup_content_becomes_one_native_clone() {
    let all = compile("ok.tsx");
    let root = &all[0];
    assert!(!is_react(&root.ir), "{:?}", root.ir.diagnostics);
    let c = clones(&all);
    assert_eq!(
        c.len(),
        1,
        "{:?}",
        all.iter().map(|i| &i.ir.id).collect::<Vec<_>>()
    );
    assert!(
        matches!(c[0].ir.tier, Tier::Native),
        "{:?}",
        c[0].ir.diagnostics
    );
    // The page prints the clone (its host element, the consumers linked to it), no island.
    assert!(!root.jinja.contains("brust-island"), "{}", root.jinja);
    assert!(
        root.jinja.contains(&format!("x-data=\"{}\"", c[0].ir.id)),
        "{}",
        root.jinja
    );
    // The island Provider nobody references is not part of the tree.
    assert!(
        !all.iter()
            .any(|i| i.ir.id.starts_with("p_") && !i.ir.specialised),
        "{:?}",
        all.iter().map(|i| &i.ir.id).collect::<Vec<_>>()
    );
    // The consumers read the frame through x-props-bind to computeds of the clone's own chunk.
    let chunk = c[0]
        .modules
        .iter()
        .map(|m| m.1.as_str())
        .collect::<String>();
    assert!(
        chunk.contains("__ctx_A_") && chunk.contains("open.set(") || chunk.contains(".set("),
        "{chunk}"
    );
}

#[test]
fn call_sites_with_different_text_share_one_factory_module_and_keep_their_own_ids() {
    for (file, n) in [("two.tsx", 2), ("same.tsx", 3)] {
        let all = compile(file);
        let c = clones(&all);
        assert_eq!(c.len(), n, "{file}");
        let ids: std::collections::BTreeSet<_> = c.iter().map(|i| i.ir.id.clone()).collect();
        assert_eq!(ids.len(), n, "{file}: one id per call site");
        let modules: std::collections::BTreeSet<_> = c
            .iter()
            .flat_map(|i| i.modules.iter().map(|m| m.0.clone()))
            .collect();
        assert_eq!(
            modules.len(),
            1,
            "{file}: the factory is one module: {modules:?}"
        );
        for i in &c {
            let stub = i.client.as_deref().unwrap();
            assert!(
                stub.len() < 400,
                "{file}: the chunk of a clone is a stub: {stub}"
            );
            assert!(
                stub.contains(&i.ir.id) && stub.contains("brust-spec:spec-"),
                "{stub}"
            );
        }
        // The text of each call site is its own (the jinja is printed per call site).
        let root = &all[0];
        if file == "two.tsx" {
            assert!(root.jinja.contains("one body") && root.jinja.contains("two body, other text"));
        }
    }
}

#[test]
fn shapes_the_splice_cannot_carry_keep_the_island_provider_and_say_why() {
    for (file, why) in [
        ("handler.tsx", "handler"),
        ("prop.tsx", "title"),
        ("gated.tsx", "children as a value"),
        ("local.tsx", "declared in the module"),
    ] {
        let all = compile(file);
        assert!(clones(&all).is_empty(), "{file}: nothing was specialised");
        let root = &all[0];
        let info = root
            .ir
            .diagnostics
            .iter()
            .find(|d| d.rule == "specialise-unsupported")
            .unwrap_or_else(|| panic!("{file}: {:?}", root.ir.diagnostics));
        assert_eq!(info.class, DiagClass::Info, "{file}");
        assert!(
            info.message.contains(why) || info.message.contains("children"),
            "{file}: {}",
            info.message
        );
        // The Provider is the React island it was (with its children), not a clone without them.
        assert!(
            all.iter()
                .any(|i| i.ir.id.starts_with("p_") || i.ir.id.starts_with("gated_")),
            "{file}"
        );
    }
}

#[test]
fn a_consumer_of_an_outer_frame_inside_another_providers_content_is_refused() {
    // `outer reader` reads P's frame from inside Q's content: spliced into Q's clone it would read Q's own members by
    // name (A1). Neither Provider is specialised; both stay the islands they were, and the page stays static.
    let all = compile("outer.tsx");
    assert!(
        clones(&all).is_empty(),
        "{:?}",
        all.iter().map(|i| &i.ir.id).collect::<Vec<_>>()
    );
    let root = &all[0];
    assert!(!is_react(&root.ir), "{:?}", root.ir.diagnostics);
    assert!(
        root.ir
            .diagnostics
            .iter()
            .any(|d| d.rule == "specialise-unsupported"),
        "{:?}",
        root.ir.diagnostics
    );
}

#[test]
fn a_context_value_read_inside_an_effect_keeps_the_consumer_in_react_and_the_provider_an_island() {
    let all = compile("effect.tsx");
    let consumer = all
        .iter()
        .find(|i| i.ir.id.starts_with("pEffect_"))
        .expect("the consumer");
    assert!(
        has(&consumer.ir, DiagClass::Fallback, "context-escape"),
        "{:?}",
        consumer.ir.diagnostics
    );
    // The React consumer cannot move into a native clone (an island would not see the frame): the Provider call site
    // keeps its island, with the consumer inside it, and the page stays what it was.
    assert!(clones(&all).is_empty());
    assert!(!is_react(&all[0].ir), "{:?}", all[0].ir.diagnostics);
}

// B7 (R34.122 b): a render prop the callee only calls is spliced into a clone of the callee, parameters bound to the
// call's arguments; any other use, a computed argument or a name of the caller keeps the island Provider.
#[test]
fn a_render_prop_the_provider_only_calls_is_spliced_into_the_clone() {
    for file in [
        "render_guarded.tsx",
        "render_bare.tsx",
        "render_noparams.tsx",
    ] {
        let all = compile(file);
        let root = &all[0];
        assert!(!is_react(&root.ir), "{file}: {:?}", root.ir.diagnostics);
        assert_eq!(clones(&all).len(), 1, "{file}: {:?}", root.ir.diagnostics);
        assert!(
            !root.jinja.contains("brust-island"),
            "{file}: {}",
            root.jinja
        );
        // the function never crosses: the clone owns the body
        assert!(!root.jinja.contains("\"render\""), "{file}: {}", root.jinja);
    }
    // the parameter is the Provider's own state: the body's condition reads the clone's `on`
    let all = compile("render_guarded.tsx");
    assert!(all[0].jinja.contains(">on</p>"), "{}", all[0].jinja);
    assert!(all[0].jinja.contains("x-if="), "{}", all[0].jinja);
}

#[test]
fn a_render_prop_that_cannot_be_spliced_keeps_the_island_provider() {
    for (file, why) in [
        ("render_used.tsx", "render"),
        ("render_calc.tsx", "computation"),
        ("render_free.tsx", "title"),
    ] {
        let all = compile(file);
        assert!(clones(&all).is_empty(), "{file}: nothing was specialised");
        let info = all[0]
            .ir
            .diagnostics
            .iter()
            .find(|d| d.rule == "specialise-unsupported")
            .unwrap_or_else(|| panic!("{file}: {:?}", all[0].ir.diagnostics));
        assert!(info.message.contains(why), "{file}: {}", info.message);
    }
}

#[test]
fn a_typeof_function_helper_guards_the_render_prop_like_typeof_does() {
    let all = compile("render_helper.tsx");
    let root = &all[0];
    assert!(!is_react(&root.ir), "{:?}", root.ir.diagnostics);
    assert_eq!(clones(&all).len(), 1, "{:?}", root.ir.diagnostics);
    assert!(root.jinja.contains(">on</p>"), "{}", root.jinja);
}
