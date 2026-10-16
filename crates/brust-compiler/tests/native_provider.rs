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
        // F266: `render(ctx)` with `const ctx = { on }`
        "render_ctx.tsx",
        // F269: `!!el.closest('form')` over state is a boolean
        "render_not.tsx",
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
        // capture: the row binds `on`, which the substituted argument (the Provider's state `on`) also names
        ("render_capture.tsx", "binds `on`"),
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

// Mellow F1 (3b): a Provider written in a render body must not leak into the writer's own `{children}`.
#[test]
fn a_provider_in_a_render_body_does_not_provide_to_the_writers_children() {
    let all = compile("render_provider.tsx");
    for i in &all {
        assert!(!i.jinja.contains("inner"), "{}: {}", i.ir.id, i.jinja);
    }
}

// S2 (R34.123, F262): the call site's names read in the content cross as hidden inputs of the clone.
#[test]
fn a_name_of_the_call_sites_component_in_the_content_is_a_hidden_input_of_the_clone() {
    for (file, seen, input) in [
        ("prop.tsx", "title", "__in_title"),
        ("handler.tsx", "__in_n", "__in_n"),
    ] {
        let all = compile(file);
        let root = &all[0];
        assert!(!is_react(&root.ir), "{file}: {:?}", root.ir.diagnostics);
        let c = clones(&all);
        assert_eq!(c.len(), 1, "{file}: {:?}", root.ir.diagnostics);
        assert!(matches!(c[0].ir.tier, Tier::Native), "{file}");
        // the call site fills the input with its own value
        assert!(root.jinja.contains(seen), "{file}: {}", root.jinja);
        assert!(c[0].ir.props.iter().any(|p| p.name == input), "{file}");
    }
    // a constant name stays fixed in the clone: printed once, no directive
    let all = compile("prop.tsx");
    let c = &clones(&all)[0];
    assert_eq!(c.ir.fixed_props, vec!["__in_title".to_string()]);
    assert!(!c.jinja.contains("x-text"), "{}", c.jinja);
    // a handler of the call site is called through a prop of the clone
    let all = compile("handler.tsx");
    let c = &clones(&all)[0];
    assert!(
        c.ir.handlers.iter().any(|h| h.name == "__inh__h1"),
        "{:?}",
        c.ir.handlers
    );
    assert!(c.jinja.contains("x-on-click=\"__inh__h1\""), "{}", c.jinja);
}

#[test]
fn names_that_cannot_cross_keep_the_island_provider_and_say_which() {
    for (file, why) in [
        ("in_ref.tsx", "ref `r`"),
        ("in_row.tsx", "enclosing list"),
        ("in_props.tsx", "whole props"),
        ("in_fn.tsx", "module-level"),
        ("in_import.tsx", "an import"),
        // O1: a live value of the page printed inside another native host's markup is bound by the wrong instance
        ("in_live_nested.tsx", "changes on the client"),
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

// Q5 (R34.117): `asChild` on a consumer of the Provider the clone was made for merges the frame's bindings into the
// child element: the page stays native and the child element is the consumer's host.
#[test]
fn an_as_child_consumer_of_the_enclosing_provider_is_the_childs_host() {
    let all = compile("aschild.tsx");
    let root = &all[0];
    assert!(!is_react(&root.ir), "{:?}", root.ir.diagnostics);
    let c = clones(&all);
    assert_eq!(c.len(), 1, "{:?}", root.ir.diagnostics);
    assert!(
        matches!(c[0].ir.tier, Tier::Native),
        "{:?}",
        c[0].ir.diagnostics
    );
    assert!(!root.jinja.contains("brust-island"), "{}", root.jinja);
    // The merged element is the caller's <a>, carrying the consumer's host, binding and handler.
    let a = root
        .jinja
        .split("<a ")
        .nth(1)
        .expect("an <a>")
        .split('>')
        .next()
        .unwrap();
    for want in [
        "x-data=\"pAs_",
        "type=\"button\"",
        "x-on-click=",
        "x-bind-aria-expanded=",
        "href=",
    ] {
        assert!(a.contains(want), "{want} in <a {a}>");
    }
    assert!(!root.jinja.contains("<button"), "{}", root.jinja);
}

#[test]
fn an_as_child_consumer_keeps_its_limits() {
    for (file, want) in [
        ("aschild_handler.tsx", "handler"),
        ("aschild_own.tsx", "PAsOwn"),
    ] {
        let all = compile(file);
        assert!(clones(&all).is_empty(), "{file}: nothing was specialised");
        let info = all[0]
            .ir
            .diagnostics
            .iter()
            .find(|d| d.rule == "specialise-unsupported")
            .unwrap_or_else(|| panic!("{file}: {:?}", all[0].ir.diagnostics));
        assert!(info.message.contains(want), "{file}: {}", info.message);
    }
}

// F266: a `const` object literal of plain reads spreads as its entries.
#[test]
fn a_const_object_literal_is_spread_as_its_entries() {
    let all = compile("spread_const.tsx");
    let root = &all[0];
    assert!(!is_react(&root.ir), "{:?}", root.ir.diagnostics);
    assert!(
        !root.ir.diagnostics.iter().any(|d| d.rule == "spread-props"),
        "{:?}",
        root.ir.diagnostics
    );
    assert!(root.jinja.contains("data-tone"), "{}", root.jinja);
}

// F269: a frame field that is a derived value over a prop and state is a member of the clone's own instance.
#[test]
fn a_frame_field_derived_from_a_prop_and_state_is_carried_by_the_clone() {
    let all = compile("derived_frame.tsx");
    let root = &all[0];
    assert!(!is_react(&root.ir), "{:?}", root.ir.diagnostics);
    assert_eq!(clones(&all).len(), 1, "{:?}", root.ir.diagnostics);
}
