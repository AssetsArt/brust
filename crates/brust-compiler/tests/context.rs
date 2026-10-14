//! S2 context lowering (R34.100-R34.104): a Provider hands its value fields to the consumers under it as hidden props.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

/// Every component of the tree of `file`: (id, IR, jinja, precompute job module).
fn compile_all(file: &str) -> Vec<(String, ComponentIR, String, Option<String>)> {
    let file = file.to_string();
    run_on_compiler_thread(move || {
        let opts = AnalyzeOptions {
            root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
            ..Default::default()
        };
        compile_tree(
            &format!("crates/brust-compiler/tests/fixtures/context/{file}"),
            None,
            &opts,
            "/_brust/client/runtime.js",
        )
        .unwrap()
        .into_iter()
        .map(|l| {
            (
                l.ir.id.clone(),
                (*l.ir).clone(),
                l.artifacts.jinja.clone(),
                l.artifacts.server_ts.clone(),
            )
        })
        .collect()
    })
}

fn compile(file: &str) -> Vec<(String, ComponentIR, String)> {
    compile_all(file)
        .into_iter()
        .map(|(a, b, c, _)| (a, b, c))
        .collect()
}

fn rules(ir: &ComponentIR) -> Vec<&str> {
    ir.diagnostics.iter().map(|d| d.rule.as_str()).collect()
}

fn page(file: &str) -> (ComponentIR, String) {
    let all = compile(file);
    let want = file
        .trim_end_matches(".tsx")
        .replace('-', "")
        .to_lowercase();
    all.into_iter()
        .find(|(id, ..)| id.to_lowercase().starts_with(&want))
        .map(|(_, ir, j)| (ir, j))
        .expect("the page")
}

fn is_react(ir: &ComponentIR) -> bool {
    matches!(ir.tier, Tier::React { .. })
}

/// React's `createContext`: the consumer under a Provider component reads its value, printed at the call site (R34.100).
#[test]
fn a_react_context_resolves_at_compile_time_for_a_consumer_under_a_provider() {
    let (ir, jinja) = page("react-basic.tsx");
    assert!(
        !is_react(&ir) && ir.diagnostics.is_empty(),
        "{:?} {:?}",
        ir.tier,
        ir.diagnostics
    );
    assert!(
        jinja.contains("<section>") && jinja.contains(r#"("hi" ~ "!")"#),
        "{jinja}"
    );
    assert!(
        !jinja.contains("__ctx_"),
        "no hidden prop reaches the page: {jinja}"
    );
}

/// Radix's `createContextScope` (R34.100, R34.101): the Provider takes the fields as props, a default applies.
#[test]
fn a_radix_context_scope_hands_props_and_defaults_to_the_indicator() {
    let (ir, jinja) = page("radix-scope.tsx");
    assert!(
        !is_react(&ir) && ir.diagnostics.is_empty(),
        "{:?} {:?}",
        ir.tier,
        ir.diagnostics
    );
    // value is the call site's 66, max falls back to the Provider's default 100.
    assert!(jinja.contains("(66)") && jinja.contains("(100)"), "{jinja}");
    assert!(!jinja.contains("__ctx_"), "{jinja}");
}

/// A wrapper around a consumer stays a plain component; the page that puts it under the Provider fills the need.
#[test]
fn a_consumer_inside_a_wrapper_gets_its_value_from_the_provider_above_the_wrapper() {
    let (ir, jinja) = page("wrapper.tsx");
    assert!(
        !is_react(&ir) && ir.diagnostics.is_empty(),
        "{:?} {:?}",
        ir.tier,
        ir.diagnostics
    );
    assert!(jinja.contains(r#""L""#), "{jinja}");
    // The wrapper itself carries the hidden prop (it reads the context through its child).
    let all = compile("wrapper.tsx");
    let wrapped = all
        .iter()
        .find(|(id, ..)| id.starts_with("wrapped_"))
        .expect("wrapped");
    assert_eq!(wrapped.1.ctx_uses.len(), 1, "{:?}", wrapped.1.ctx_uses);
}

/// The nearest Provider wins, and a sibling after a nested Provider sees the outer one again.
#[test]
fn the_nearest_provider_wins() {
    let (ir, jinja) = page("nested.tsx");
    assert!(
        !is_react(&ir) && ir.diagnostics.is_empty(),
        "{:?} {:?}",
        ir.tier,
        ir.diagnostics
    );
    assert!(
        jinja.contains(
            "<div><b>{{ (1) | e }}</b><div><b>{{ (2) | e }}</b></div><b>{{ (1) | e }}</b></div>"
        ),
        "{jinja}"
    );
}

/// A route component whose consumer has no Provider falls back (never a build error).
#[test]
fn a_consumer_with_no_provider_falls_back_at_the_route() {
    let (ir, _) = page("no-provider.tsx");
    assert!(
        rules(&ir).contains(&"context-no-provider"),
        "{:?}",
        ir.diagnostics
    );
    assert!(is_react(&ir), "{:?}", ir.tier);
}

/// The context value used as a whole, and a Provider value that is not an object literal, fall back.
#[test]
fn a_whole_context_value_and_a_scalar_provider_value_fall_back() {
    for (f, code) in [
        ("escape.tsx", "context-escape"),
        ("value-shape.tsx", "context-value"),
    ] {
        let all = compile(f);
        let rules: Vec<&str> = all.iter().flat_map(|(_, ir, _)| rules(ir)).collect();
        assert!(rules.contains(&code), "{f}: {rules:?}");
    }
}

/// The Provider's values call helpers of ITS module (`clamp`, `stateOf`, a const default): they are evaluated by the
/// page's precompute job through a copy of the module's declarations, kept in a function scope (S2, R34.103).
#[test]
fn a_provider_value_that_calls_a_helper_of_another_module_is_computed_by_a_job() {
    let out = compile_all("helper-page.tsx");
    let page = out
        .iter()
        .find(|(id, ..)| id.starts_with("helperPage_"))
        .expect("page");
    assert!(
        matches!(page.1.tier, Tier::Static) && page.1.diagnostics.is_empty(),
        "{:?} {:?}",
        page.1.tier,
        page.1.diagnostics
    );
    assert!(
        page.2.contains("(_s1)") && page.2.contains("(_s2)"),
        "{}",
        page.2
    );
    let ts = page.3.as_deref().expect("a precompute job");
    // The helpers travel in a function scope under a private name; the default `MAX` is the literal 100.
    assert!(
        ts.contains("const __ctxm_meter_")
            && ts.contains("function clamp(")
            && ts.contains("function stateOf("),
        "{ts}"
    );
    assert!(ts.contains("clamp(v, 100)"), "{ts}");
    // The Provider and the consumer themselves have no job: they are inlined.
    for id in ["meter_", "fill_"] {
        let c = out.iter().find(|(i, ..)| i.starts_with(id)).expect(id);
        assert!(c.1.jobs.is_empty(), "{id}: {:?}", c.1.jobs);
    }
}

/// R34.104: an `if` whose branches only call `console.*` is a diagnostic, not part of the render; any other effect
/// in a branch keeps the control-flow fallback.
#[test]
fn a_console_only_if_is_left_out_and_any_other_if_still_falls_back() {
    let (ir, jinja) = page("console-if.tsx");
    assert!(
        !is_react(&ir) && ir.diagnostics.is_empty(),
        "{:?} {:?}",
        ir.tier,
        ir.diagnostics
    );
    assert!(jinja.contains("<p>"), "{jinja}");
    let (ir, _) = page("real-if.tsx");
    assert!(is_react(&ir), "{:?}", ir.tier);
}

/// A wrapper that forwards its `...rest` into the Provider component (the shadcn shape): the Provider's value reads the
/// props the rest carries (`max`), a prop the wrapper names and does not forward (`value`) is the Provider's default.
#[test]
fn a_rest_spread_into_the_provider_carries_the_props_the_wrapper_does_not_name() {
    let (ir, jinja) = page("rest-wrapper.tsx");
    assert!(!is_react(&ir), "{:?} {:?}", ir.tier, ir.diagnostics);
    // The page's inlined Wrap: max=5 from the call site through the rest, value=0 (the default).
    assert!(jinja.contains("(5)") && jinja.contains("(0)"), "{jinja}");
    assert!(!jinja.contains("__ctx_"), "{jinja}");
}

/// A Provider that hands out state (a native provider is a later step) stays a React island, as before; the page that
/// renders it stays static and never becomes React because of it.
#[test]
fn a_provider_that_hands_out_state_stays_an_island_and_the_page_stays_static() {
    let all = compile_all("state-provider.tsx");
    let tier = |prefix: &str| {
        all.iter()
            .find(|(id, ..)| id.starts_with(prefix))
            .map(|(_, ir, ..)| ir.clone())
            .expect(prefix)
    };
    let provider = tier("disclosure_");
    assert!(is_react(&provider), "{:?}", provider.tier);
    assert!(
        rules(&provider).contains(&"context-state"),
        "{:?}",
        provider.diagnostics
    );
    let page = tier("stateProvider_");
    assert!(!is_react(&page), "{:?} {:?}", page.tier, page.diagnostics);
}

/// Mellow F1: a context field is part of an identifier, so a key that is not a plain identifier (`'x-y'`) is refused by
/// a named fallback on whichever side writes it, never printed (`const { __ctx_Ctx_x-y } = props`).
#[test]
fn a_context_field_that_is_not_a_plain_identifier_is_refused_by_name() {
    let all = compile_all("field-job.tsx");
    let shapes = all
        .iter()
        .filter(|(_, ir, ..)| rules(ir).contains(&"context-shape"))
        .count();
    assert!(
        shapes >= 1,
        "{:?}",
        all.iter()
            .map(|(i, ir, ..)| (i, rules(ir)))
            .collect::<Vec<_>>()
    );
    for (id, _, jinja, ts) in &all {
        assert!(
            !jinja.contains("x-y") || jinja.contains("brust-island"),
            "{id}: {jinja}"
        );
        assert!(
            ts.as_deref()
                .is_none_or(|t| !t.contains("__ctx_") || !t.contains("x-y")),
            "{id}"
        );
    }
    // The control with a plain key compiles.
    let (ir, _) = page("field-ok.tsx");
    assert!(
        !is_react(&ir) && ir.diagnostics.is_empty(),
        "{:?} {:?}",
        ir.tier,
        ir.diagnostics
    );
}

/// Mellow F2: a context is the declaring module AND its name. Two modules each declare `Ctx`: a consumer of B's never
/// reads A's Provider (React reads B's default).
#[test]
fn a_context_with_the_same_local_name_in_another_module_is_another_context() {
    let (ir, jinja) = page("same-name.tsx");
    assert!(
        !jinja.contains("from-A"),
        "A's value must not reach B's consumer: {jinja}"
    );
    assert!(
        rules(&ir).contains(&"context-no-provider"),
        "{:?}",
        ir.diagnostics
    );
    assert!(is_react(&ir), "{:?}", ir.tier);
}

/// A context declared in a THIRD module and imported by both sides is not recognised across modules (v1): the Provider
/// and the consumer stay React islands (as before this lane), the page stays static, and no value is ever substituted.
#[test]
fn a_context_declared_in_a_shared_module_stays_react() {
    let all = compile_all("shared-ctx.tsx");
    for (id, ir, jinja, _) in &all {
        assert!(!jinja.contains("from-S"), "{id}: {jinja}");
        if id.starts_with("panelS_") || id.starts_with("badgeS_") {
            assert!(is_react(ir), "{id}: {:?}", ir.tier);
        } else {
            assert!(
                !is_react(ir),
                "the page stays static: {:?} {:?}",
                ir.tier,
                ir.diagnostics
            );
        }
    }
}

/// Mellow F3 (lead ruling): an island under a Provider that is lowered away would hydrate standalone and read the
/// context DEFAULT. Any island under an active frame (directly, through a static wrapper, or reading the context from
/// another module) keeps the page React; an island BESIDE the Provider does not, and a Provider with none still lowers.
#[test]
fn an_island_under_a_lowered_provider_keeps_the_page_react() {
    for f in ["island-under.tsx", "island-cross.tsx", "island-wrapped.tsx"] {
        let (ir, _) = page(f);
        assert!(
            rules(&ir).contains(&"context-island"),
            "{f}: {:?}",
            ir.diagnostics
        );
        assert!(is_react(&ir), "{f}: {:?}", ir.tier);
    }
    for f in ["island-beside.tsx", "react-basic.tsx"] {
        let (ir, _) = page(f);
        assert!(
            !rules(&ir).contains(&"context-island"),
            "{f}: {:?}",
            ir.diagnostics
        );
        assert!(!is_react(&ir), "{f}: {:?} {:?}", ir.tier, ir.diagnostics);
    }
}
