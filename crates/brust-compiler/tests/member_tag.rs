//! shadcn S1.4 (R34.35): a member of an imported binding is the package member, an island; every other
//! member tag stays `member-tag`.
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_file};
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;
use std::path::PathBuf;

fn fixture(name: &str) -> ComponentIR {
    let path = format!("tests/fixtures/{name}/input.tsx");
    run_on_compiler_thread(move || {
        analyze_file(
            &path,
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
        )
        .unwrap()
    })
}

fn rules(ir: &ComponentIR, rule: &str) -> usize {
    ir.diagnostics.iter().filter(|d| d.rule == rule).count()
}

#[test]
fn members_of_imports_are_islands_with_distinct_ids() {
    let ir = fixture("member-tag-named");
    assert!(matches!(ir.tier, Tier::Static), "{:?}", ir.tier);
    assert_eq!(rules(&ir, "member-tag"), 0);
    // `Dialog.Root` twice is one component; `Trigger`, `Group` (namespace) and `Item` (default) are three more.
    let ids: std::collections::BTreeSet<_> =
        ir.children.iter().filter_map(|c| c.id.clone()).collect();
    assert_eq!(ids.len(), 4, "{ids:?}");
    assert!(
        ir.children
            .iter()
            .all(|c| matches!(c.tier, Tier::React { .. }))
    );
}

#[test]
fn aliases_of_a_member_resolve_here_and_through_an_export() {
    let ir = fixture("member-tag-alias");
    assert!(matches!(ir.tier, Tier::Static), "{:?}", ir.tier);
    assert_eq!(rules(&ir, "member-tag"), 0);
    assert_eq!(rules(&ir, "local-component"), 0);
    // `Root` and `Trigger` come through `./ui` (`export { Root }`, `export const Trigger`), `Close` is local.
    assert_eq!(ir.children.len(), 3);
}

#[test]
fn everything_else_stays_member_tag_or_local_component() {
    let ir = fixture("member-tag-fallback");
    assert!(matches!(ir.tier, Tier::React { .. }));
    assert_eq!(rules(&ir, "member-tag"), 4);
    assert_eq!(rules(&ir, "local-component"), 1);
    assert_eq!(rules(&ir, "external-component"), 0);
}

#[test]
fn a_plain_package_export_serialises_as_before() {
    // `ExternalRef.member` is absent when empty: no existing IR changes.
    let r = ExternalRef {
        source: "lucide-react".into(),
        export: "Heart".into(),
        member: vec![],
    };
    assert_eq!(
        serde_json::to_string(&r).unwrap(),
        r#"{"source":"lucide-react","export":"Heart"}"#
    );
    let m = ExternalRef {
        member: vec!["Root".into()],
        ..r
    };
    assert!(
        serde_json::to_string(&m)
            .unwrap()
            .ends_with(r#""member":["Root"]}"#)
    );
}
