//! G8 (gaps L8): a static component whose root is not one element prints no `<brust-host>`; an interactive
//! one keeps it and warns.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::Diagnostic;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// (jinja of the root, its lowering diagnostics).
fn root(file: &str) -> (String, Vec<Diagnostic>) {
    let file = format!("tests/fixtures/{file}");
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            &file,
            None,
            &AnalyzeOptions {
                root: repo(),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        let a = &tree[0].artifacts;
        (a.jinja.clone(), a.diagnostics.clone())
    })
}

#[test]
fn static_fragment_root_has_no_wrapper_and_no_warning() {
    let (jinja, diags) = root("transparent-root/Rows.tsx");
    assert!(!jinja.contains("brust-host"), "{jinja}");
    assert!(
        jinja.contains("<tr><td>{{ a | e }}</td></tr><tr><td>{{ b | e }}</td></tr>"),
        "{jinja}"
    );
    assert!(diags.iter().all(|d| d.rule != "fragment-root"));
}

#[test]
fn rows_stay_direct_children_of_tbody_through_a_component_root() {
    let (jinja, _) = root("transparent-root/Page.tsx");
    assert!(!jinja.contains("brust-host"), "{jinja}");
    assert!(jinja.contains("<tbody><tr>"), "{jinja}");
}

#[test]
fn component_root_collapses_when_static() {
    let (jinja, _) = root("transparent-root/Wrap.tsx");
    assert!(!jinja.contains("brust-host"), "{jinja}");
    assert!(jinja.contains("<tr>"), "{jinja}");
}

#[test]
fn interactive_fragment_root_keeps_the_host_and_warns_with_a_location() {
    let (jinja, diags) = root("transparent-root/Counter.tsx");
    assert!(jinja.contains("<brust-host x-data="), "{jinja}");
    let w = diags
        .iter()
        .find(|d| d.rule == "fragment-root")
        .expect("warning");
    assert!(w.message.contains("child combinators"), "{}", w.message);
    assert_eq!((w.line, w.col), (7, 5)); // the `<>` of the return
}
