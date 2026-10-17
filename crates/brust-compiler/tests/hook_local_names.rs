//! F290: a diagnostic about an inlined hook's local names what the author wrote (`stylesRef`) and the hook it came from
//! (`useThing`), not the generated local (`stylesRef_useThing1`).
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::spell_hook_locals;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

fn messages(file: &str) -> Vec<String> {
    let file = file.to_string();
    run_on_compiler_thread(move || {
        let opts = AnalyzeOptions {
            root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
            ..Default::default()
        };
        compile_tree(
            &format!("crates/brust-compiler/tests/fixtures/hook-local-names/{file}"),
            None,
            &opts,
            "/_brust/client/runtime.js",
        )
        .unwrap()
        .into_iter()
        .flat_map(|l| {
            l.ir.diagnostics
                .iter()
                .map(|d| d.message.clone())
                .collect::<Vec<_>>()
        })
        .collect()
    })
}

#[test]
fn a_diagnostic_about_an_inlined_hook_local_names_the_source_and_the_hook() {
    for f in ["object.tsx", "array.tsx"] {
        let all = messages(f);
        let hit = all
            .iter()
            .find(|m| m.contains("is read as a child"))
            .unwrap_or_else(|| panic!("{f}: no jsx-const-child in {all:?}"));
        assert!(
            hit.contains("`stylesRef` (from the hook `useThing`)"),
            "{f}: {hit}"
        );
        assert!(!all.iter().any(|m| m.contains("_useThing")), "{f}: {all:?}");
    }
}

#[test]
fn only_a_generated_local_in_backticks_is_respelled() {
    assert_eq!(
        spell_hook_locals("`a_useX1` and `b_useY22` read"),
        "`a` (from the hook `useX`) and `b` (from the hook `useY`) read"
    );
    // Not generated: no digits, no hook name, a lowercase after `use`, no head, outside backticks, an unpaired backtick.
    for m in [
        "`a_useX`",
        "`a_foo1`",
        "`a_usex1`",
        "`_useX1`",
        "a_useX1",
        "`plain` `x_y_z2`",
        "tail `a_useX1",
    ] {
        assert_eq!(spell_hook_locals(m), m, "{m}");
    }
}
