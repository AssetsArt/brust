//! F388: `left && <X/>` renders a falsy NUMBER left as text (`0`, `-0` as `0`, `NaN`), as React does; `false`, `null`,
//! `undefined` and '' render nothing. The reader gives a side-effect-free `left` an else branch that prints it; the branch
//! is dropped again where it cannot print (an element whose content model takes no text) or cannot matter (a provably
//! boolean left). `NaN` / `Infinity` are numbers in the template too. Served: tests/server/falsy-and.chromium.test.ts.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

/// (template, first paint with `props`) of `src` compiled as a page.
fn page(src: &str, props: serde_json::Value) -> (String, String) {
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
        let jinja = tree[0].artifacts.jinja.clone();
        let mut env = minijinja::Environment::new();
        brust_jinja::register(&mut env);
        let mut ctx = props;
        ctx["_props"] = serde_json::json!({});
        let html = env.render_str(&jinja, brust_jinja::value_of(ctx)).unwrap();
        (jinja, html)
    })
}

#[test]
fn a_falsy_number_left_paints_as_react_does() {
    let src = "export default function F({ n, s, b, o }: any) { return <main><p>{n && <i>n</i>}</p><p>{s && <i>s</i>}</p><p>{b && <i>b</i>}</p><p>{o && <i>o</i>}</p></main> }";
    let (_, html) = page(
        src,
        serde_json::json!({ "n": 0, "s": "", "b": false, "o": null }),
    );
    assert!(html.contains("<p>0</p><p></p><p></p><p></p>"), "{html}");
    let (_, html) = page(
        src,
        serde_json::json!({ "n": 2, "s": "x", "b": true, "o": {} }),
    );
    assert!(
        html.contains("<p><i>n</i></p><p><i>s</i></p><p><i>b</i></p><p><i>o</i></p>"),
        "{html}"
    );
}

#[test]
fn nan_and_infinity_are_numbers_in_the_template() {
    let (_, html) = page(
        "export default function F() { const m = NaN; const i = Infinity; return <p>{m && <b>m</b>}|{m}|{i}|{-i}</p> }",
        serde_json::json!({}),
    );
    assert!(html.contains("<p>NaN|NaN|Infinity|-Infinity</p>"), "{html}");
}

#[test]
fn a_provably_boolean_left_or_a_table_parent_keeps_the_old_shape() {
    for src in [
        // a state seeded with a boolean literal
        "import { useState } from 'react'\nexport default function F() { const [o, setO] = useState(false); return <div onClick={() => setO(!o)}>{o && <b>x</b>}</div> }",
        // a derived comparison
        "export default function F({ n }: any) { const big = n > 2; return <div>{big && <b>x</b>}</div> }",
        // no text can sit in a <tbody>
        "export default function F({ n }: any) { return <table><tbody>{n && <tr><td>x</td></tr>}</tbody></table> }",
    ] {
        let (jinja, _) = page(src, serde_json::json!({ "n": 0 }));
        assert!(!jinja.contains("{% else %}{{"), "{src}\n{jinja}");
        assert!(!jinja.contains("_not"), "{src}\n{jinja}");
    }
}

#[test]
fn a_left_with_side_effects_keeps_the_old_shape() {
    // `left` would be read twice (the test and the slot); a call is not a side-effect-free path.
    let (jinja, _) = page(
        "function count(x: any) { return x.length }\nexport default function F({ xs }: any) { return <div>{count(xs) && <b>x</b>}</div> }",
        serde_json::json!({ "xs": [] }),
    );
    assert!(!jinja.contains("{% else %}{{"), "{jinja}");
}

#[test]
fn the_reader_marks_the_else_slot() {
    let (jinja, _) = page(
        "export default function F({ n }: any) { return <div>{n && <b>x</b>}</div> }",
        serde_json::json!({ "n": 0 }),
    );
    assert!(jinja.contains("{% else %}{{ n | e }}"), "{jinja}");
}
