//! F537: `items.slice(a, b)` in a server-rendered expression slices the list, not the list's text. `.map` and `.length` over
//! the result see list items. Strings slice by characters as before.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

/// First paint of `src` compiled as a page, with `props`.
fn paint(src: &str, props: serde_json::Value) -> String {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            "crates/brust-compiler/tests/fixtures/F.tsx",
            Some(s.into_bytes()),
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        let mut env = minijinja::Environment::new();
        brust_jinja::register(&mut env);
        let mut ctx = props;
        ctx["_props"] = serde_json::json!({});
        env.render_str(&tree[0].artifacts.jinja, brust_jinja::value_of(ctx))
            .unwrap()
    })
}

#[test]
fn a_list_slice_renders_list_items() {
    let src = "export default function P({ items }: { items: { id: number; name: string }[] }) {
  return (
    <div>
      <ul>{items.slice(0, 1).map((p) => <li key={p.id}>{p.name}</li>)}</ul>
      <i>{items.slice(1).length}</i>
      <b>{items.slice(-1).length}</b>
      <u>{items.slice(5, 1).length}</u>
    </div>
  )
}";
    let html = paint(
        src,
        serde_json::json!({ "items": [{ "id": 1, "name": "a" }, { "id": 2, "name": "b" }] }),
    );
    assert!(html.contains("<li>a</li>"), "{html}");
    assert!(!html.contains("<li>b</li>"), "{html}");
    assert!(html.contains("<i>1</i>"), "{html}");
    assert!(html.contains("<b>1</b>"), "{html}");
    assert!(html.contains("<u>0</u>"), "{html}");
}

#[test]
fn a_string_slice_is_unchanged() {
    let src = "export default function P({ s }: { s: string }) {
  return <p>{s.slice(1, -1)}|{s.slice(-2)}</p>
}";
    let html = paint(src, serde_json::json!({ "s": "Hello" }));
    assert!(html.contains("<p>ell|lo</p>"), "{html}");
}
