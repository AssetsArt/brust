//! F194: the primitive-return proof (`analyze::plain_fn`) knows a local by its binding, not its name, so a block-scoped
//! `const` is in scope only inside its block. After the block, or in a sibling branch, the same spelling is whatever the
//! module or the language binds (`document`, `globalThis`, an unbound name): the helper is not proven, and the panel that
//! calls it under a Provider falls back (`jsx-const-child`). Locals read inside their own block stay plain.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::{ComponentIR, Tier};
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

/// The `Panel` component of `tests/fixtures/context/<file>`.
fn panel(file: &str) -> ComponentIR {
    component(file, "panel_")
}

/// The component of `tests/fixtures/context/<file>` whose id starts with `prefix` (`""`: the page, compiled first).
fn component(file: &str, prefix: &'static str) -> ComponentIR {
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
        .find(|l| l.ir.id.starts_with(prefix))
        .map(|l| (*l.ir).clone())
        .expect(prefix)
    })
}

fn refused(ir: &ComponentIR) -> bool {
    ir.diagnostics.iter().any(|d| d.rule == "jsx-const-child")
        && matches!(ir.tier, Tier::React { .. })
}

#[test]
fn a_block_scoped_local_is_not_in_scope_after_its_block() {
    for f in [
        "ph-block-global.tsx",
        "ph-block-sibling.tsx",
        "ph-block-arrow.tsx",
    ] {
        let ir = panel(f);
        assert!(refused(&ir), "{f}: {:?} {:?}", ir.tier, ir.diagnostics);
    }
}

#[test]
fn block_scoped_locals_read_inside_their_block_stay_plain() {
    let ir = panel("ph-block-plain.tsx");
    assert!(
        !refused(&ir) && !matches!(ir.tier, Tier::React { .. }),
        "{:?} {:?}",
        ir.tier,
        ir.diagnostics
    );
}

/// Mellow's N1 repro and its siblings, under a plain wrapper: the page calling the helper falls back. A for-loop body and
/// a catch parameter are refused already (the proof takes no loop and no `try`); they stay refused.
#[test]
fn mellows_n1_and_its_siblings_fall_back_under_a_plain_wrapper() {
    for f in [
        "ph-block-n1.tsx",
        "ph-block-bare.tsx",
        "ph-block-for.tsx",
        "ph-block-catch.tsx",
    ] {
        let ir = component(f, "");
        assert!(refused(&ir), "{f}: {:?} {:?}", ir.tier, ir.diagnostics);
    }
}

/// Shadowing the other way: an outer local shadowed by a block's `const` is the outer primitive again after the block.
#[test]
fn an_outer_local_shadowed_inside_a_block_stays_plain() {
    let ir = component("ph-block-outer.tsx", "");
    assert!(
        !refused(&ir) && !matches!(ir.tier, Tier::React { .. }),
        "{:?} {:?}",
        ir.tier,
        ir.diagnostics
    );
}
