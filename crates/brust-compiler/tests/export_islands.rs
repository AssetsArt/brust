//! shadcn S1.1 (R34.11): a React island is imported by the binding its importer used. Every export form
//! (`export function`, `export const`, `export { A as B }`, a barrel's `export { X } from`) yields one
//! island whose `ir.export` is the importer's binding and whose id does not depend on the way in.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

fn islands() -> Vec<(String, ComponentIR)> {
    run_on_compiler_thread(|| {
        let opts = AnalyzeOptions {
            root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
            ..Default::default()
        };
        let out = compile_tree(
            "crates/brust-compiler/tests/fixtures/export-islands/input.tsx",
            None,
            &opts,
            "/_brust/client/runtime.js",
        )
        .unwrap();
        out.into_iter()
            .map(|l| (l.ir.source.clone(), (*l.ir).clone()))
            .filter(|(_, ir)| matches!(ir.tier, Tier::React { .. }))
            .collect()
    })
}

fn find<'a>(all: &'a [(String, ComponentIR)], export: &str) -> &'a ComponentIR {
    all.iter()
        .map(|(_, ir)| ir)
        .find(|ir| ir.export.as_deref() == Some(export))
        .unwrap_or_else(|| panic!("no React island for the export `{export}`"))
}

#[test]
fn every_export_form_is_an_island_imported_by_its_binding() {
    let all = islands();
    let panel = find(&all, "Panel");
    // The barrel is followed: the island is the declaring module's, not `widgets/index.ts`'s.
    assert!(
        panel.source.ends_with("export-islands/widgets/panel.tsx"),
        "{}",
        panel.source
    );
    assert!(!panel.unexported);
    let arrow = find(&all, "Arrow");
    assert!(arrow.source.ends_with("export-islands/ui.tsx"));
    assert!(!arrow.unexported);
    // `export { Inner as Alias }`: imported as `Alias`, whatever the function is called here.
    let alias = find(&all, "Alias");
    assert!(alias.source.ends_with("export-islands/ui.tsx"));
    assert!(alias.id.starts_with("alias_"), "{}", alias.id);
    assert!(!alias.unexported);
    assert!(!find(&all, "Fn").unexported);
    // A helper the module does not export is still an island, flagged so the build exposes it.
    assert!(find(&all, "Helper").unexported);
}

#[test]
fn island_ids_are_distinct_per_export_of_one_file() {
    let all = islands();
    let mut ids: Vec<&str> = ["Arrow", "Alias", "Fn", "Helper"]
        .iter()
        .map(|e| find(&all, e).id.as_str())
        .collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 4);
}
