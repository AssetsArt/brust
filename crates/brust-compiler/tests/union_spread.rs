//! shadcn S3 (R34.66): a union spread `{...(c ? {a: 1} : {b: 2})}` (inline, or a `const` holding one) becomes one
//! conditional attribute per key, with React's semantics (a key a branch lacks is `undefined`, which renders nothing).
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::{DiagClass, Tier};
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

struct Out {
    jinja: String,
    chunk: String,
    tier: Tier,
    diags: Vec<(DiagClass, String)>,
}

/// Compiles `src` as `tests/fixtures/union-spread/<file>` (siblings in that directory resolve).
fn lower(file: &str, src: &str) -> Out {
    let s = src.to_string();
    let path = format!("crates/brust-compiler/tests/fixtures/union-spread/{file}");
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            &path,
            Some(s.into_bytes()),
            &AnalyzeOptions {
                root: repo(),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        let a = &tree[0].artifacts;
        Out {
            jinja: a.jinja.clone(),
            chunk: a.client_js.clone().unwrap_or_default(),
            tier: tree[0].ir.tier.clone(),
            diags: tree[0]
                .ir
                .diagnostics
                .iter()
                .chain(&a.diagnostics)
                .map(|d| (d.class, d.rule.clone()))
                .collect(),
        }
    })
}

/// Renders like the server: props are top-level variables and `_props` is the whole object.
fn render(jinja: &str, props: serde_json::Value) -> String {
    let mut ctx = props.clone();
    ctx["_props"] = props;
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    env.render_str(jinja, brust_jinja::value_of(ctx))
        .unwrap()
        .trim()
        .to_string()
}


fn comp(body: &str) -> String {
    format!("export default function T(props: any) {{ {body} }}")
}

#[test]
fn an_inline_union_spread_renders_the_matching_branch() {
    let o = lower(
        "A.tsx",
        &comp("return <button {...(props.primary ? { type: 'submit', 'data-p': '1' } : { disabled: true })}>x</button>"),
    );
    assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
    assert!(o.diags.iter().all(|(_, r)| r != "spread-props"), "{:?}", o.diags);
    assert_eq!(
        render(&o.jinja, serde_json::json!({ "primary": true })),
        "<button type=\"submit\" data-p=\"1\">x</button>"
    );
    assert_eq!(
        render(&o.jinja, serde_json::json!({ "primary": false })),
        "<button disabled>x</button>"
    );
}

#[test]
fn a_body_const_and_a_module_const_hold_the_union() {
    for src in [
        "const extra = props.big ? { 'data-s': 'big' } : { 'data-s': 'small', title: 't' }\n  return <p {...extra}>x</p>",
    ] {
        let o = lower("B.tsx", &comp(src));
        assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
        assert_eq!(
            render(&o.jinja, serde_json::json!({ "big": false })),
            "<p data-s=\"small\" title=\"t\">x</p>"
        );
        assert_eq!(
            render(&o.jinja, serde_json::json!({ "big": true })),
            "<p data-s=\"big\">x</p>"
        );
    }
    let o = lower(
        "C.tsx",
        "const V = true ? { a: '1' } : { b: '2' }\nexport default function T(props: any) { return <p {...(props.k ? { a: 'y' } : null)}>x</p> }",
    );
    assert!(o.diags.iter().all(|(_, r)| r != "spread-props"), "{:?}", o.diags);
    assert_eq!(render(&o.jinja, serde_json::json!({ "k": 1 })), "<p a=\"y\">x</p>");
    assert_eq!(render(&o.jinja, serde_json::json!({ "k": 0 })), "<p>x</p>");
}

#[test]
fn and_and_nested_conditionals_work_and_later_attributes_win() {
    let o = lower(
        "D.tsx",
        &comp("return <i title=\"own\" {...(props.a && { 'data-a': props.v })} {...(props.b ? { title: 'b' } : props.c ? { title: 'c' } : {})}>x</i>"),
    );
    assert!(o.diags.iter().all(|(_, r)| r != "spread-props"), "{:?}", o.diags);
    let r = |v: serde_json::Value| render(&o.jinja, v);
    assert_eq!(r(serde_json::json!({})), "<i title=\"own\">x</i>");
    assert_eq!(
        r(serde_json::json!({ "a": 1, "v": "<&>", "c": 1 })),
        "<i title=\"c\" data-a=\"&lt;&amp;&gt;\">x</i>"
    );
    assert_eq!(r(serde_json::json!({ "b": 1, "c": 1 })), "<i title=\"b\">x</i>");
}

#[test]
fn what_a_conditional_cannot_carry_fails_closed() {
    for body in [
        // a handler, a style object, a ref, innerHTML
        "return <b {...(props.a ? { onClick: props.f } : {})}>x</b>",
        "return <b {...(props.a ? { style: { color: 'red' } } : {})}>x</b>",
        "return <b {...(props.a ? { dangerouslySetInnerHTML: { __html: '<i>' } } : {})}>x</b>",
        // a test with a call is not repeated per key
        "return <b {...(props.f() ? { a: '1', b: '2' } : {})}>x</b>",
        // a branch that is not an object literal
        "return <b {...(props.a ? props.o : {})}>x</b>",
        // a computed key
        "const k = 'a'; return <b {...(props.a ? { [k]: '1' } : {})}>x</b>",
    ] {
        let o = lower("E.tsx", &comp(body));
        assert!(
            o.diags.iter().any(|(_, r)| r == "spread-props") || o.tier != Tier::Static,
            "{body}: {:?} {:?}",
            o.tier,
            o.diags
        );
    }
}

#[test]
fn a_key_that_is_not_an_attribute_name_is_not_rendered() {
    let o = lower(
        "F.tsx",
        &comp("return <b {...(props.a ? { 'a b=\"x\" onload': '1', ok: '2' } : {})}>x</b>"),
    );
    let html = render(&o.jinja, serde_json::json!({ "a": 1 }));
    assert_eq!(html, "<b ok=\"2\">x</b>", "{:?}", o.diags);
    assert!(o.diags.iter().any(|(_, r)| r == "unsafe-attr"), "{:?}", o.diags);
}
