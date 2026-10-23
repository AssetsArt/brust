//! F407 (Assets Art B-7): a compile with lucide icons not rendered yet is provisional (L23). The build renders the
//! icons and compiles again; only that compile may refuse a component as a nested instance.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::{DiagClass, Diagnostic};
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::{Lowered, compile_tree};
use std::path::PathBuf;

const PAGE: &str = "crates/brust-compiler/tests/fixtures/icons-pending/page.tsx";

fn compile(icons_final: bool) -> Result<Vec<Vec<Diagnostic>>, Diagnostic> {
    run_on_compiler_thread(move || {
        let opts = AnalyzeOptions {
            root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
            icons_final,
            ..Default::default()
        };
        compile_tree(PAGE, None, &opts, "/_brust/client/runtime.js")
            .map(|all: Vec<Lowered>| all.into_iter().map(|l| l.artifacts.diagnostics).collect())
    })
}

#[test]
fn the_first_compile_does_not_refuse_a_component_that_only_holds_pending_icons() {
    // Both icons are still island jobs here, so <TryBadge> looks fed inside the inlined <Featured>.
    let all = compile(false).unwrap_or_else(|d| panic!("{d:?}"));
    let ds: Vec<&Diagnostic> = all.iter().flatten().collect();
    assert!(!ds.iter().any(|d| d.class == DiagClass::Error), "{ds:?}");
    assert!(
        ds.iter()
            .any(|d| d.rule == "nested-instance" && d.class == DiagClass::Warning),
        "{ds:?}"
    );
}

#[test]
fn the_final_compile_still_refuses_icons_that_stay_islands_and_names_the_island_and_line() {
    // Final with no markup: the icons stay islands (real jobs), so the refusal stands, with its cause and source line.
    let d = compile(true).expect_err("a real job inside an inlined component is refused");
    assert_eq!(d.rule, "nested-instance");
    assert_eq!(d.class, DiagClass::Error);
    assert!(
        d.message
            .contains("<TryBadge> holds the server-rendered React island <Hand>"),
        "{}",
        d.message
    );
    assert_eq!((d.line, d.col), (20, 28), "{d:?}");
}
