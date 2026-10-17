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

// F304: a context field read inside an effect is a hidden prop of the consumer (it was `context-escape`); the Provider
// call site is specialised as for any other native consumer
#[test]
fn a_context_field_read_inside_an_effect_keeps_the_consumer_native() {
    let all = compile("effect.tsx");
    let consumer = all
        .iter()
        .find(|i| i.ir.id.starts_with("pEffect_"))
        .expect("the consumer");
    assert!(
        !has(&consumer.ir, DiagClass::Fallback, "context-escape") && !is_react(&consumer.ir),
        "{:?} {:?}",
        consumer.ir.tier,
        consumer.ir.diagnostics
    );
    assert!(!is_react(&all[0].ir), "{:?}", all[0].ir.diagnostics);
    assert!(
        !clones(&all).is_empty(),
        "the Provider call site is a clone"
    );
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

// Mellow F1 (switch-provider): a const object that is written (at load, through an alias, or in the body) is not its
// literal: the spread never prints the literal's value.
#[test]
fn a_const_object_that_is_written_is_not_spread_as_its_literal() {
    for file in [
        "mut_module.tsx",
        "mut_alias.tsx",
        "mut_body.tsx",
        "proto_key.tsx",
    ] {
        let all = compile(file);
        let root = &all[0];
        assert!(
            !root.jinja.contains("\"sm\"") && !root.jinja.contains(">sm<"),
            "{file}: {}",
            root.jinja
        );
    }
}

// F267: a `ref` of the component's own bound on the one element an inlined forwardRef child hands its ref to.
#[test]
fn a_ref_passed_to_an_inlined_forward_ref_child_binds_on_its_element() {
    for file in ["fwd_ref.tsx", "fwd_cb.tsx"] {
        let all = compile(file);
        let root = &all[0];
        assert!(!is_react(&root.ir), "{file}: {:?}", root.ir.diagnostics);
        assert!(
            !has(&root.ir, DiagClass::Fallback, "forwardref-ref"),
            "{file}: {:?}",
            root.ir.diagnostics
        );
        // the parent binds its ref cell on the child's own button
        assert!(
            root.jinja.contains("<button") && root.jinja.contains("x-ref=\"_rf")
                || root.jinja.contains("x-ref=\"r\""),
            "{file}: {}",
            root.jinja
        );
    }
}

#[test]
fn a_ref_passed_to_a_forward_ref_child_that_may_not_render_stays_react() {
    // a callback under a condition; a child that renders its element sometimes; a spread after the ref
    for file in ["fwd_cond.tsx", "fwd_child_cond.tsx", "fwd_spread_after.tsx"] {
        let all = compile(file);
        assert!(
            has(&all[0].ir, DiagClass::Fallback, "forwardref-ref"),
            "{file}: {:?}",
            all[0].ir.diagnostics
        );
    }
}

// F267: the content is written in the module of the Provider (Radix's `Switch` renders `SwitchProvider` and
// `SwitchTrigger`): the clone is compiled where the content was written, so a component of that module is reachable.
#[test]
fn content_written_in_the_providers_own_module_is_specialised() {
    let all = compile("same_module.tsx");
    let root = &all[0];
    assert!(!is_react(&root.ir), "{:?}", root.ir.diagnostics);
    let c = clones(&all);
    assert_eq!(
        c.len(),
        1,
        "{:?}",
        all.iter()
            .map(|i| (&i.ir.id, &i.ir.diagnostics))
            .collect::<Vec<_>>()
    );
}

// R34.142: a context field named like a template name (`loop`) is a hidden prop `__ctx_<ctx>_loop`: nothing to shadow.
#[test]
fn a_context_field_named_loop_is_lowered_like_any_other() {
    let all = compile("ctx_loop.tsx");
    let root = &all[0];
    assert!(!is_react(&root.ir), "{:?}", root.ir.diagnostics);
    assert_eq!(clones(&all).len(), 1, "{:?}", root.ir.diagnostics);
    assert!(
        !all.iter()
            .any(|i| i.ir.diagnostics.iter().any(|d| d.rule == "context-shape")),
        "{:?}",
        all.iter().map(|i| &i.ir.diagnostics).collect::<Vec<_>>()
    );
}

// F278: the call site's `...rest` spread into the content crosses as ONE hidden input and is spread there.
// F279: a call of a single-return module helper with a plain-read argument is its expression, so the consumer has no job.
#[test]
fn a_rest_spread_in_the_content_crosses_and_a_plain_helper_call_needs_no_job() {
    let all = compile("rest_input.tsx");
    let root = &all[0];
    assert!(!is_react(&root.ir), "{:?}", root.ir.diagnostics);
    assert_eq!(
        clones(&all).len(),
        1,
        "{:?}",
        all.iter()
            .map(|i| (&i.ir.id, &i.ir.diagnostics))
            .collect::<Vec<_>>()
    );
    assert!(root.jinja.contains("data-x"), "{}", root.jinja);
    // the component that renders the Provider is native too (no island of it is left)
    assert!(
        all.iter()
            .filter(|i| i.ir.id.starts_with("outer_"))
            .all(|i| !is_react(&i.ir)),
        "{:?}",
        all.iter()
            .map(|i| (&i.ir.id, &i.ir.tier))
            .collect::<Vec<_>>()
    );
    for i in &all {
        assert!(
            !i.ir
                .jobs
                .iter()
                .any(|j| matches!(j.kind, JobKind::Precompute)),
            "{}: {:?}",
            i.ir.id,
            i.ir.jobs
        );
    }
}

// F300: the call site's `...rest` crosses into the clone as data, and markup children are not data: a call with JSX
// children is refused (children-rest) instead of printing the clone without them; without children it stays native.
#[test]
fn jsx_children_given_to_a_component_that_passes_its_rest_to_a_clone_are_refused() {
    let all = compile("rest_children_data.tsx");
    let root = &all[0];
    assert!(
        has(&root.ir, DiagClass::Fallback, "children-rest"),
        "{:?}",
        root.ir.diagnostics
    );
    assert!(is_react(&root.ir), "{:?}", root.ir.tier);
    assert!(!root.jinja.contains("hello"), "{}", root.jinja);
    let none = compile("rest_input.tsx");
    assert!(
        !has(&none[0].ir, DiagClass::Fallback, "children-rest"),
        "{:?}",
        none[0].ir.diagnostics
    );
    assert!(!is_react(&none[0].ir));
}

#[test]
fn a_helper_called_with_a_computation_keeps_its_job() {
    let all = compile("helper_neg.tsx");
    assert!(
        all.iter().any(|i| i
            .ir
            .jobs
            .iter()
            .any(|j| matches!(j.kind, JobKind::Precompute))),
        "{:?}",
        all.iter()
            .map(|i| (&i.ir.id, &i.ir.jobs))
            .collect::<Vec<_>>()
    );
}

// Mellow F1 (switch-rest-fed): a LIVE rest crossing as `__in_rest` would stay at its first value (the clone is not
// linked and a spread is expanded into HTML only), so the call that passes one is refused where the rest is spread.
#[test]
fn a_live_caller_rest_is_never_carried_into_a_clone() {
    let all = compile("rest_live.tsx");
    let root = &all[0];
    assert!(
        is_react(&root.ir) || has(&root.ir, DiagClass::Fallback, "spread-props"),
        "{:?}\n{}",
        root.ir.diagnostics,
        root.jinja
    );
    assert!(!root.jinja.contains("data-n=\"0\""), "{}", root.jinja);
}

// R34.142: Radix's `useId` (a React 18 id with a client-only counter fallback) and `useCallbackRef` (`typeof` of React's
// insertion effect picks the effect), imported from other modules, lower with no island: the fallbacks are decided, not read.
#[test]
fn radix_use_id_and_use_callback_ref_lower_without_their_react_version_fallbacks() {
    let all = compile("hooks_page.tsx");
    let panel = all
        .iter()
        .find(|i| i.ir.id.starts_with("panel"))
        .expect("the Panel component");
    assert!(!is_react(&panel.ir), "{:?}", panel.ir.diagnostics);
    assert!(
        !panel
            .ir
            .diagnostics
            .iter()
            .any(|d| d.class == DiagClass::Fallback),
        "{:?}",
        panel.ir.diagnostics
    );
    // the id is the server's: one seeded value, and the counter fallback (`count++`) is gone with its effect
    assert_eq!(panel.ir.id_bindings.len(), 1, "{:?}", panel.ir.id_bindings);
    let client = panel.client.as_deref().expect("a client chunk");
    assert!(!client.contains("count"), "{client}");
}

// An arrow's rest parameter is part of its meaning (`(...xs) => xs.length`): the reader kept only the name, so the chunk
// declared `(xs) => ...` and a call spread an `undefined` where the original took none. It is read verbatim now.
#[test]
fn an_arrow_with_a_rest_parameter_keeps_its_rest() {
    let all = compile("rest_arrow.tsx");
    let client = all[0].client.as_deref().expect("a client chunk");
    assert!(!is_react(&all[0].ir), "{:?}", all[0].ir.diagnostics);
    assert!(client.contains("...xs"), "{client}");
}

// R34.142: a context declared with a literal default (`createContext(undefined)`) read as a VALUE through an imported hook
// (Radix's `useDirection`): the Provider's `value` is the whole value; with no Provider above the page it is the default.
#[test]
fn a_scalar_context_read_through_an_imported_hook_is_the_providers_value_or_its_default() {
    for (file, provided) in [("dir_none.tsx", false), ("dir_provider.tsx", true)] {
        let all = compile(file);
        assert!(!is_react(&all[0].ir), "{file}: {:?}", all[0].ir.diagnostics);
        assert!(
            !all.iter().any(|i| i
                .ir
                .diagnostics
                .iter()
                .any(|d| d.class == DiagClass::Fallback)),
            "{file}: {:?}",
            all.iter().map(|i| &i.ir.diagnostics).collect::<Vec<_>>()
        );
        assert!(
            !all[0].jinja.contains("brust-island"),
            "{file}: {}",
            all[0].jinja
        );
        // the call site's own `dir` wins, then the Provider's value, then the default `ltr`
        let want = if provided { "rtl" } else { "ltr" };
        assert!(all[0].jinja.contains(want), "{file}: {}", all[0].jinja);
    }
}

// R34.142: a scalar context's whole value and an object context's fields are different frame shapes: a consumer that reads
// one while the Provider hands out the other is refused (never silently `undefined`).
#[test]
fn a_consumer_reading_a_whole_value_or_fields_the_provider_does_not_hand_out_falls_back() {
    for file in ["ctx_whole_fields.tsx", "ctx_fields_whole.tsx"] {
        let all = compile(file);
        assert!(
            all.iter()
                .any(|i| has(&i.ir, DiagClass::Fallback, "context-shape")),
            "{file}: {:?}",
            all.iter().map(|i| &i.ir.diagnostics).collect::<Vec<_>>()
        );
        assert!(is_react(&all[0].ir), "{file}: {:?}", all[0].ir.tier);
    }
}

// Review (Afrojack): only React's HOOKS are known to be functions; `typeof version === 'function'` (a string) is not decided.
#[test]
fn typeof_of_a_react_export_that_is_not_a_hook_is_not_decided() {
    let all = compile("typeof_not_hook.tsx");
    assert!(
        all.iter()
            .any(|i| has(&i.ir, DiagClass::Fallback, "control-flow")),
        "{:?}",
        all.iter().map(|i| &i.ir.diagnostics).collect::<Vec<_>>()
    );
}

// Review (Mellow F1): the `if` test of an identity-update effect runs with it; one with a side effect keeps the effect.
#[test]
fn an_identity_update_effect_whose_test_has_a_side_effect_is_not_dropped() {
    let all = compile("hooks_side.tsx");
    assert!(
        all.iter()
            .any(|i| has(&i.ir, DiagClass::Fallback, "hook-shape")),
        "{:?}",
        all.iter().map(|i| &i.ir.diagnostics).collect::<Vec<_>>()
    );
    assert!(is_react(&all[0].ir), "{:?}", all[0].ir.tier);
}

// F280: an entry of a const object that calls a module function proven plain (reads its argument, changes nothing)
// is a read: the object still spreads as its entries, and the call is printed (or computed by the server) at the use.
#[test]
fn a_const_object_entry_may_call_a_proven_plain_function() {
    let all = compile("spread_call.tsx");
    for it in &all {
        assert!(!is_react(&it.ir), "{:?}", it.ir.diagnostics);
        assert!(
            !it.ir.diagnostics.iter().any(|d| d.rule == "spread-props"),
            "{:?}",
            it.ir.diagnostics
        );
    }
    let ri = all
        .iter()
        .find(|i| i.jinja.contains("data-tone"))
        .expect("RI's markup");
    // the helper's comparison is printed over the call site's label (`"x" == "indeterminate"`), not run in a job
    assert!(ri.jinja.contains(r#"== "indeterminate""#), "{}", ri.jinja);
}

// F280: a function that does anything but read its argument (a call of author code, a member read) is not proven plain,
// so the entry that calls it keeps the spread a fallback.
#[test]
fn a_const_object_entry_calling_an_effectful_or_unproven_function_still_falls_back() {
    for file in ["spread_call_effect.tsx", "spread_call_member.tsx"] {
        let all = compile(file);
        assert!(
            all.iter()
                .any(|i| is_react(&i.ir)
                    && i.ir.diagnostics.iter().any(|d| d.rule == "spread-props")),
            "{file}: {:?}",
            all.iter().map(|i| &i.ir.diagnostics).collect::<Vec<_>>()
        );
    }
}

#[test]
fn children_carried_in_the_rest_sit_under_the_clones_provider() {
    // F298: `<KRootStatic><KThumb/></KRootStatic>`, where KRootStatic spreads its rest (children included) into a trigger
    // under its own Provider: the Thumb reads that Provider's frame, as in React.
    let all = compile("rest_children.tsx");
    let root = &all[0];
    assert!(!is_react(&root.ir), "{:?}", root.ir.diagnostics);
    assert!(
        all.iter().any(|i| i.ir.rest_clone_of.is_some()),
        "{:?}",
        all.iter().map(|i| &i.ir.id).collect::<Vec<_>>()
    );
    // The Thumb is printed inside the Provider's clone and linked to it (its state changes on the client).
    let thumb = root
        .jinja
        .find("kThumb_")
        .expect("the thumb is in the page's markup");
    assert!(
        root.jinja[thumb..].contains("x-props-bind"),
        "{}",
        root.jinja
    );
    // ... and the nearest host around it is the Provider's clone (the runtime binds by the nearest x-data): the label
    // between them has no host of its own.
    let clone = root
        .jinja
        .find("x-data=\"kProvider_")
        .expect("the Provider's clone hosts the content");
    let thumb_host = root
        .jinja
        .find("x-data=\"kThumb_")
        .expect("the thumb's own host");
    let between = &root.jinja[clone + 1..thumb_host];
    assert!(!between.contains("x-data="), "{}", root.jinja);
    assert!(
        !root
            .ir
            .diagnostics
            .iter()
            .any(|d| d.rule == "context-no-provider"),
        "{:?}",
        root.ir.diagnostics
    );
}

#[test]
fn a_live_value_hosted_by_a_consumer_in_the_content_is_cloned_with_that_consumer() {
    // O1 (was refused: a live value of the page printed inside another native host's markup would be bound by the wrong
    // instance). F307: inside the Provider's clone the consumer is cloned with that content, which is then its own.
    let all = compile("in_live_nested.tsx");
    assert!(!is_react(&all[0].ir), "{:?}", all[0].ir.diagnostics);
    assert!(
        all.iter()
            .any(|i| i.ir.specialised && i.ir.id.contains("_h")),
        "{:?}",
        all.iter().map(|i| &i.ir.id).collect::<Vec<_>>()
    );
}

#[test]
fn rest_children_a_native_trigger_hosts_are_cloned_with_that_trigger() {
    // The trigger has an instance of its own: content printed inside its host would bind to it (F214), so it was refused
    // (context-no-provider at the page). F307: the trigger is cloned with the Thumb inside the rest clone (served == React
    // in tests/server/host-specialise.chromium.test.ts, page `switch`).
    let all = compile("rest_children_host.tsx");
    let root = &all[0];
    assert!(!is_react(&root.ir), "{:?}", root.ir.diagnostics);
    assert!(
        !has(&root.ir, DiagClass::Fallback, "context-no-provider"),
        "{:?}",
        root.ir.diagnostics
    );
    assert!(
        all.iter()
            .any(|i| i.ir.specialised && i.ir.id.contains("_h")),
        "{:?}",
        all.iter().map(|i| &i.ir.id).collect::<Vec<_>>()
    );
}
// F324: a state Provider that spreads its `...rest` onto an element and never prints `{children}` gets the call site's
// children through that spread in React (the element's own children, since it writes none). The clone puts the call
// site's content into that element, once the rest is spread onto exactly one host or component and the Provider writes
// no children of its own there; the content is printed where React prints it, not dropped. Without children the clone
// is the same as before.
#[test]
fn jsx_children_given_to_a_provider_that_spreads_its_rest_land_in_the_rest_host() {
    let all = compile("spec_drop.tsx");
    assert_eq!(clones(&all).len(), 1, "{:?}", all[0].ir.diagnostics);
    let root = &all[0];
    assert!(!is_react(&root.ir), "{:?}", root.ir.diagnostics);
    assert!(
        root.ir
            .diagnostics
            .iter()
            .all(|d| d.rule != "specialise-unsupported"),
        "{:?}",
        root.ir.diagnostics
    );
    assert!(
        !root.jinja.contains("brust-island")
            && root.jinja.contains("<button")
            && root.jinja.contains("<span>hello</span></button>"),
        "{}",
        root.jinja
    );

    let all = compile("spec_drop_none.tsx");
    assert_eq!(clones(&all).len(), 1, "{:?}", all[0].ir.diagnostics);
    assert!(!is_react(&all[0].ir), "{:?}", all[0].ir.diagnostics);
}

// R34.143: `useSyncExternalStore(subscribe, () => true, () => false)` with a `subscribe` that subscribes to nothing (Radix's
// `useIsHydrated`) is false on the server and true once mounted; every other store stays `hook-unsupported`.
#[test]
fn use_is_hydrated_lowers_to_a_state_that_a_mount_effect_sets() {
    for (file, id) in [("HydrBox.tsx", "hydrBox"), ("HydrBoxNeg.tsx", "hydrBoxNeg")] {
        let all = compile(file);
        let b = all
            .iter()
            .find(|i| i.ir.id.starts_with(id))
            .expect("the component");
        assert!(!is_react(&b.ir), "{file}: {:?}", b.ir.diagnostics);
        // false in the server markup (React's `getServerSnapshot`)
        assert!(
            b.jinja
                .contains("{% set ret1_useSyncExternalStore = false %}"),
            "{file}: {}",
            b.jinja
        );
        let client = b.client.as_deref().expect("a client chunk");
        // seeded from the instance's `late` flag (mounted after the page booted), set true by a mount effect in a microtask
        assert!(client.contains("late:"), "{file}: {client}");
        assert!(
            client.contains("queueMicrotask(() => ret1_useSyncExternalStore.set(true))"),
            "{file}: {client}"
        );
        assert!(
            client.contains("const ret1_useSyncExternalStore = signal(__late)"),
            "{file}: {client}"
        );
    }
}

#[test]
fn another_external_store_keeps_the_hook_unsupported_refusal() {
    for f in ["sync_other.tsx", "sync_subscribes.tsx"] {
        let all = compile(f);
        assert!(
            all.iter()
                .any(|i| has(&i.ir, DiagClass::Fallback, "hook-unsupported")),
            "{f}: {:?}",
            all.iter().map(|i| &i.ir.diagnostics).collect::<Vec<_>>()
        );
        assert!(is_react(&all[0].ir), "{f}");
    }
}

// R34.144: a context local destructured in the body (`const { on, flip } = context`) or aliased (`const again = context`) is
// read field by field, like the hook's own result.
#[test]
fn a_context_local_destructured_or_aliased_in_the_body_reads_its_fields() {
    let all = compile("ctx_destruct.tsx");
    assert!(!is_react(&all[0].ir), "{:?}", all[0].ir.diagnostics);
    assert_eq!(clones(&all).len(), 1, "{:?}", all[0].ir.diagnostics);
    assert!(
        !all.iter().any(|i| i
            .ir
            .diagnostics
            .iter()
            .any(|d| d.class == DiagClass::Fallback)),
        "{:?}",
        all.iter().map(|i| &i.ir.diagnostics).collect::<Vec<_>>()
    );
}

// F304: a context field read in code printed as written (a handler, an effect) is the hidden prop of that field, bound to
// a local around the code; the consumer stays native
#[test]
fn context_fields_read_in_a_handler_or_an_effect_are_hidden_props_of_the_consumer() {
    for (file, consumer, needles) in [
        (
            "ctxv_handler.tsx",
            "cHandler_",
            ["_toggle", "_label", "_open"].as_slice(),
        ),
        ("ctxv_effect.tsx", "cEffect_", ["_open"].as_slice()),
    ] {
        let all = compile(file);
        let c = all
            .iter()
            .find(|i| i.ir.id.starts_with(consumer))
            .unwrap_or_else(|| panic!("{file}: the consumer"));
        assert!(
            !has(&c.ir, DiagClass::Fallback, "context-escape") && !is_react(&c.ir),
            "{file}: {:?} {:?}",
            c.ir.tier,
            c.ir.diagnostics
        );
        let js = c.client.as_deref().unwrap_or_default();
        for n in needles {
            assert!(
                js.contains(&format!("__ctx_")) && js.contains(n),
                "{file} {n}: {js}"
            );
        }
        // the context local itself is not a name in the chunk: it is the object of the field locals
        assert!(!js.contains("useContext"), "{file}: {js}");
    }
}

// F304 (conditions a, b): only non-computed reads of identifier fields qualify; every other use keeps the escape
#[test]
fn every_other_use_of_a_context_in_printed_code_keeps_context_escape() {
    for (file, consumer) in [
        ("ctxv_computed.tsx", "cComputed_"),
        ("ctxv_destruct.tsx", "cDestruct_"),
        ("ctxv_whole.tsx", "cWhole_"),
        ("ctxv_write.tsx", "cWrite_"),
        ("ctxv_delete.tsx", "cDelete_"),
        ("ctxv_proto.tsx", "cProto_"),
    ] {
        let all = compile(file);
        let c = all
            .iter()
            .find(|i| i.ir.id.starts_with(consumer))
            .unwrap_or_else(|| panic!("{file}: the consumer"));
        assert!(
            has(&c.ir, DiagClass::Fallback, "context-escape"),
            "{file}: {:?}",
            c.ir.diagnostics
        );
    }
}

// F304 (condition c): the consumer's `c.f()` runs with `this` = the object of the fields the consumer reads, so a Provider
// value whose methods read `this`, or a class instance, must never reach a native consumer: the Provider stays React
#[test]
fn a_provider_value_that_reads_this_or_is_a_class_instance_stays_react() {
    for (file, provider, rule) in [
        ("ctxthis_method.tsx", "tP_", "context-state"),
        ("ctxthis_class.tsx", "kP_", "context-value"),
    ] {
        let all = compile(file);
        let p = all
            .iter()
            .find(|i| i.ir.id.starts_with(provider))
            .unwrap_or_else(|| panic!("{file}: the Provider"));
        assert!(
            is_react(&p.ir) && has(&p.ir, DiagClass::Fallback, rule),
            "{file}: {:?} {:?}",
            p.ir.tier,
            p.ir.diagnostics
        );
        assert!(
            clones(&all).is_empty(),
            "{file}: no native clone of the Provider"
        );
    }
}

/// `compile`, with the build having vouched for `@radix-ui/react-collection` (version + entry hash, R34.140).
fn compile_collection(file: &str) -> Vec<Item> {
    compile_with(file, true)
}

fn compile_with(file: &str, collection: bool) -> Vec<Item> {
    let file = file.to_string();
    run_on_compiler_thread(move || {
        let mut opts = AnalyzeOptions {
            root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
            ..Default::default()
        };
        if collection {
            opts.packages
                .recognised
                .insert("@radix-ui/react-collection".into(), "1.2.0".into());
        }
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

// R34.140: a recognised `createCollection` (the build vouched for the package): Provider is transparent, Slot makes its
// component child's host the collection root, ItemSlot marks its element an item with its data, `useCollection(scope)` is
// the function that lists the items.
#[test]
fn a_recognised_collection_lowers_to_markers_and_the_items_function() {
    let all = compile_collection("coll_basic.tsx");
    let find = |p: &str| all.iter().find(|i| i.ir.id.starts_with(p)).unwrap();
    let (page, list_impl, item) = (find("collBasic"), find("listImpl"), find("item_"));
    for i in &all {
        assert!(
            !i.ir
                .diagnostics
                .iter()
                .any(|d| d.class == DiagClass::Fallback),
            "{}: {:?}",
            i.ir.id,
            i.ir.diagnostics
        );
        assert!(!is_react(&i.ir), "{}: {:?}", i.ir.id, i.ir.tier);
    }
    // the Slot's component child is the root: its host (here printed in the Page's template) carries the marker, and the
    // component that asks for the items carries the feature marker
    assert!(
        page.jinja.contains("x-data=\"listImpl_") && page.jinja.contains("x-collection-root=\"\""),
        "{}",
        page.jinja
    );
    assert!(
        page.jinja.contains("x-collection-use=\"\""),
        "{}",
        page.jinja
    );
    // an item is marked as React prints it, and hands its data over through a member
    assert!(
        page.jinja
            .contains("data-radix-collection-item=\"\" x-collection-item=\"_c2\""),
        "{}",
        page.jinja
    );
    let ichunk = item.client.as_deref().expect("the item's chunk");
    assert!(
        ichunk.contains(
            "const _c2 = computed(() => ({ id: props().id, focusable: !props().disabled }))"
        ),
        "{ichunk}"
    );
    // `useCollection(scope)` is a handler over the runtime's `ctx.items`
    let lchunk = list_impl.client.as_deref().expect("the list's chunk");
    assert!(lchunk.contains("items: __brust_items"), "{lchunk}");
    assert!(
        lchunk.contains("const getItems = (...__args) => (() => __brust_items())(...__args)"),
        "{lchunk}"
    );
    // the Provider and the Slot print nothing of their own
    assert!(!page.jinja.contains("Collection"), "{}", page.jinja);
}

// F328b: an ItemSlot over a component (Radix's `Primitive.span` shape): a STATIC component whose one root element receives the props
// (the ItemSlot's markers), inside an Item with state and handlers of its own. The Item prints the markers and the item's data
// directive on the row's element, in its own scope.
#[test]
fn an_item_slot_over_a_static_component_marks_its_root_element() {
    let all = compile_collection("coll_item_comp.tsx");
    for i in &all {
        assert!(
            !i.ir
                .diagnostics
                .iter()
                .any(|d| d.class == DiagClass::Fallback)
                && !is_react(&i.ir),
            "{}: {:?} {:?}",
            i.ir.id,
            i.ir.tier,
            i.ir.diagnostics
        );
    }
    let item = all.iter().find(|i| i.ir.id.starts_with("item_")).unwrap();
    let j = &item.jinja;
    // the marker sits on the child's own `<li>`, not on a wrapper, with the item's data member of the Item's scope
    let li = j.find("<li").unwrap_or_else(|| panic!("{j}"));
    let tag_end = li + j[li..].find('>').unwrap();
    assert!(
        j[li..tag_end].contains("data-radix-collection-item=\"\""),
        "{j}"
    );
    assert!(j[li..tag_end].contains("x-collection-item="), "{j}");
}

// Every other shape falls back by name and prints no marker: a native child (its directive would read the child's scope), an Item
// without a chunk (no member to hold the data), a child that drops the props (React's Slot markers never reach an element), a child
// that renders with React.
#[test]
fn an_item_slot_over_any_other_component_falls_back_by_name() {
    for file in [
        "coll_item_native.tsx",
        "coll_item_stateless.tsx",
        "coll_item_noforward.tsx",
        "coll_item_island.tsx",
    ] {
        let all = compile_collection(file);
        assert!(
            all.iter()
                .any(|i| has(&i.ir, DiagClass::Fallback, "collection-shape")),
            "{file}: {:?}",
            all.iter().map(|i| &i.ir.diagnostics).collect::<Vec<_>>()
        );
        assert!(
            !all.iter()
                .any(|i| i.jinja.contains("data-radix-collection-item")),
            "{file}: a marker is printed for a child that cannot carry it"
        );
    }
}

// R34.140: only the build's vouching makes a `createCollection` a collection; the same component without it keeps the
// refusal it had (`member-tag` of the unresolved `Collection.*`), and so does the same export name of another package.
#[test]
fn a_collection_the_build_did_not_vouch_for_stays_what_it_was() {
    let all = compile("coll_basic.tsx");
    assert!(
        all.iter().any(|i| is_react(&i.ir)
            || i.ir
                .diagnostics
                .iter()
                .any(|d| d.class == DiagClass::Fallback)),
        "{:?}",
        all.iter()
            .map(|i| (&i.ir.id, &i.ir.tier))
            .collect::<Vec<_>>()
    );
    assert!(
        !all.iter().any(|i| i.jinja.contains("x-collection-")),
        "no collection marker without the vouching"
    );
    // vouched for, but the call is another package's
    let all = compile_collection("coll_other_pkg.tsx");
    assert!(
        !all.iter().any(|i| i.jinja.contains("x-collection-")),
        "another package's createCollection"
    );
}

#[test]
fn collection_elements_that_are_not_the_librarys_shape_fall_back_with_a_named_code() {
    for (file, code) in [
        ("coll_scope.tsx", "collection-scope"),
        ("coll_shape.tsx", "collection-shape"),
        ("coll_data_keys.tsx", "collection-shape"),
        ("coll_static_slot.tsx", "collection-shape"),
    ] {
        let all = compile_collection(file);
        assert!(
            all.iter().any(|i| has(&i.ir, DiagClass::Fallback, code)),
            "{file}: {:?}",
            all.iter().map(|i| &i.ir.diagnostics).collect::<Vec<_>>()
        );
        assert!(
            !all.iter().any(|i| i.jinja.contains("x-collection-")),
            "{file}"
        );
    }
}

// the list exists only in the browser: `getItems()` read while rendering is refused, never printed as a server value
#[test]
fn the_items_function_is_not_callable_in_the_render() {
    let all = compile_collection("coll_render.tsx");
    let count = all.iter().find(|i| i.ir.id.starts_with("count")).unwrap();
    assert!(
        is_react(&count.ir)
            || count
                .ir
                .diagnostics
                .iter()
                .any(|d| d.class == DiagClass::Fallback),
        "{:?} {:?}",
        count.ir.tier,
        count.ir.diagnostics
    );
}

// A rest spread among a call site's props answers every prop name (`spread_get`), but the reserved collection-root prop is only
// ever written by the compiler: a Label-like instance with a rest spread must NOT become a collection root (it linked the
// collection feature on pages that use no collection, and differed between the fold on and off).
#[test]
fn a_rest_spread_instance_is_not_a_collection_root() {
    let all = compile_collection("coll_rest_spread.tsx");
    assert!(
        all.iter().all(|i| !i.jinja.contains("x-collection-")),
        "{:?}",
        all.iter().map(|i| &i.jinja).collect::<Vec<_>>()
    );
}
