//! S2 context lowering (R34.100-R34.104): a Provider hands its value fields to the consumers under it as hidden props.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

/// Every component of the tree of `file`: (source file name, IR, jinja).
fn compile(file: &str) -> Vec<(String, ComponentIR, String)> {
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
        .map(|l| (l.ir.id.clone(), (*l.ir).clone(), l.artifacts.jinja.clone()))
        .collect()
    })
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
