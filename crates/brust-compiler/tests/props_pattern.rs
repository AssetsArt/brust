//! F161: props patterns that compile today to a component that fails every render (a quoted key
//! that is not an identifier, bound to a local) or silently loses its default (an IIFE) fall back to React.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

fn compile(file: &str) -> (ComponentIR, String) {
    let file = file.to_string();
    run_on_compiler_thread(move || {
        let opts = AnalyzeOptions {
            root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
            ..Default::default()
        };
        let out = compile_tree(
            &format!("crates/brust-compiler/tests/fixtures/props-pattern/{file}"),
            None,
            &opts,
            "/_brust/client/runtime.js",
        )
        .unwrap();
        let l = out
            .into_iter()
            .find(|l| l.ir.source.ends_with(&file))
            .expect("the component");
        ((*l.ir).clone(), l.artifacts.jinja.clone())
    })
}

fn rules(ir: &ComponentIR) -> Vec<&str> {
    ir.diagnostics.iter().map(|d| d.rule.as_str()).collect()
}

fn is_react(ir: &ComponentIR) -> bool {
    matches!(ir.tier, Tier::React { .. })
}

/// R39.1: each shape falls back to React with its own named code.
#[test]
fn the_two_broken_shapes_fall_back_with_named_codes() {
    for (f, code) in [
        ("quoted-key.tsx", "prop-quoted-key"),
        ("iife-default.tsx", "prop-default-iife"),
    ] {
        let (ir, _) = compile(f);
        assert!(rules(&ir).contains(&code), "{f}: {:?}", ir.diagnostics);
        assert!(is_react(&ir), "{f}: {:?}", ir.tier);
    }
}

/// The same loss of meaning in neighbouring shapes: a call of a local function, a module constant, JSX and `typeof`.
#[test]
fn a_default_the_template_cannot_evaluate_falls_back() {
    for f in [
        "call-default.tsx",
        "p1.tsx",
        "p2.tsx",
        "p4.tsx",
        "p6.tsx",
        "p7.tsx",
    ] {
        let (ir, jinja) = compile(f);
        assert!(
            rules(&ir).contains(&"prop-default-shape"),
            "{f}: {:?}",
            ir.diagnostics
        );
        assert!(is_react(&ir), "{f}: {:?}", ir.tier);
        assert!(!jinja.contains("else none"), "{f}: {jinja}");
    }
}

/// Defaults the template prints correctly keep their tier: literals, an earlier prop, supported calls, an arrow, a rename.
#[test]
fn printable_defaults_and_renames_still_compile() {
    for f in ["ok-default.tsx", "p3.tsx", "p5ok.tsx"] {
        let (ir, _) = compile(f);
        assert!(
            !is_react(&ir) && rules(&ir).is_empty(),
            "{f}: {:?} {:?}",
            ir.tier,
            ir.diagnostics
        );
    }
}
