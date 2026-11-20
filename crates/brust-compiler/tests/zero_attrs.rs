//! F574: an attribute whose value is the number `0` prints `"0"`, in the compiled server template, like React: `0` is a
//! value, not an empty one. (Battery row `a-attr-zero`; the served HTML of that row is also compared with React's in
//! `scripts/battery/ssr-compare.ts`.)
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn jinja_of(src: &str) -> String {
    let src = src.to_string();
    run_on_compiler_thread(move || {
        compile_tree(
            "crates/brust-compiler/tests/fixtures/attr-parity/T.tsx",
            Some(src.into_bytes()),
            &AnalyzeOptions {
                root: repo(),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap()[0]
            .artifacts
            .jinja
            .clone()
    })
}

fn render(jinja: &str) -> String {
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    let ctx = serde_json::json!({ "_props": {} });
    env.render_str(jinja, brust_jinja::value_of(ctx))
        .unwrap()
        .trim()
        .to_string()
}

#[test]
fn a_zero_valued_attribute_prints_zero() {
    let html = render(&jinja_of(
        "export default function T() { return <div tabIndex={0} data-n={0} aria-level={0}><input maxLength={0} value={0} readOnly /></div> }",
    ));
    for want in [
        "tabindex=\"0\"",
        "data-n=\"0\"",
        "aria-level=\"0\"",
        "maxlength=\"0\"",
        "value=\"0\"",
    ] {
        assert!(
            html.to_ascii_lowercase().contains(want),
            "{want} missing from: {html}"
        );
    }
}
