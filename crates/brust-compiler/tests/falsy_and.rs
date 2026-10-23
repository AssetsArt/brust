//! F388: `left && <X/>` renders a falsy NUMBER left as text (`0`, `-0` as `0`, `NaN`), as React does; `false`, `null`,
//! `undefined` and '' render nothing. The reader gives a side-effect-free `left` an else branch that prints it; the branch
//! is dropped again where it cannot matter (a provably boolean left); in an element whose content model takes no text a
//! non-boolean left is the named refusal `and-falsy-in-table`. `NaN` / `Infinity` are numbers in the template too. Served: tests/server/falsy-and.chromium.test.ts.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::Tier;
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

/// (tier, fallback rules) of `src` compiled as a page.
fn tier(src: &str) -> (Tier, Vec<String>) {
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
        let rules = tree[0]
            .ir
            .diagnostics
            .iter()
            .chain(&tree[0].artifacts.diagnostics)
            .map(|d| d.rule.clone())
            .collect();
        (tree[0].ir.tier.clone(), rules)
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
fn a_provably_boolean_left_keeps_the_old_shape() {
    for src in [
        // a state seeded with a boolean literal, toggled with `!`
        "import { useState } from 'react'\nexport default function F() { const [o, setO] = useState(false); return <div onClick={() => setO(!o)}>{o && <b>x</b>}</div> }",
        // ... set with literals and an updater
        "import { useState } from 'react'\nexport default function F() { const [o, setO] = useState(false); return <div onClick={() => setO(true)} onBlur={() => setO((p) => !p)}>{o && <b>x</b>}</div> }",
        // a derived comparison
        "export default function F({ n }: any) { const big = n > 2; return <div>{big && <b>x</b>}</div> }",
        // a boolean left in a <tbody> is no refusal
        "export default function F({ n }: any) { return <table><tbody>{n > 0 && <tr><td>x</td></tr>}</tbody></table> }",
        // ... nor through two wrappers
        "function TableBody({ children }: any) { return <tbody className=\"b\">{children}</tbody> }\nfunction Body2({ children }: any) { return <TableBody>{children}</TableBody> }\nexport default function F({ n }: any) { return <table><Body2>{n > 0 && <tr><td>x</td></tr>}</Body2></table> }",
        // ... nor through a component that prints its children in a <tbody>
        "function TableBody({ children }: any) { return <tbody className=\"b\">{children}</tbody> }\nexport default function F({ n }: any) { return <table><TableBody>{n > 0 && <tr><td>x</td></tr>}</TableBody></table> }",
    ] {
        let (jinja, _) = page(src, serde_json::json!({ "n": 0 }));
        assert!(!jinja.contains("{% else %}{{"), "{src}\n{jinja}");
        assert!(!jinja.contains("_not"), "{src}\n{jinja}");
        let (t, rules) = tier(src);
        assert!(
            !rules.iter().any(|r| r == "and-falsy-in-table"),
            "{src}\n{rules:?}"
        );
        assert!(matches!(t, Tier::Native | Tier::Static), "{src}\n{t:?}");
    }
}

#[test]
fn a_boolean_seeded_state_with_a_non_boolean_write_prints_its_left() {
    // Mellow F1: `setS(0)` makes `s` a number; React prints `0` after the click.
    for src in [
        "import { useState } from 'react'\nexport default function F() { const [s, setS] = useState<any>(false); return <div><button onClick={() => setS(0)}>z</button>{s && <b>on</b>}</div> }",
        "import { useState } from 'react'\nexport default function F() { const [s, setS] = useState<any>(false); return <div><button onClick={() => setS((p: any) => (p ? 0 : true))}>z</button>{s && <b>on</b>}</div> }",
        // the setter handed on: any write may happen
        "import { useState } from 'react'\nfunction B({ set }: any) { return <button onClick={() => set(0)}>z</button> }\nexport default function F() { const [s, setS] = useState<any>(false); return <div><B set={setS} />{s && <b>on</b>}</div> }",
    ] {
        let (jinja, _) = page(src, serde_json::json!({}));
        assert!(jinja.contains("_not"), "{src}\n{jinja}");
    }
}

#[test]
fn a_non_boolean_left_in_an_element_without_text_is_a_named_refusal() {
    // Mellow F2: the parser moves text out of a table part or a select, so no lowering paints React's `0` there.
    for src in [
        "export default function F({ n }: any) { return <table><tbody>{n && <tr><td>x</td></tr>}</tbody></table> }",
        "export default function F({ n }: any) { return <select>{n && <option>x</option>}</select> }",
        "export default function F({ n }: any) { return <table><tbody><tr>{n && <td>x</td>}</tr></tbody></table> }",
        // N1: a child whose ROOT is the `&&` lands in the caller's <tbody>
        "function Rows({ n }: any) { return <>{n && <tr><td>x</td></tr>}</> }\nexport default function F({ n }: any) { return <table><tbody><Rows n={n} /></tbody></table> }",
        // ... through TWO wrappers (Mellow round 2, h.tsx: state) and with a prop left (d.tsx: static)
        "import { useState } from 'react'\nfunction TableBody({ children }: any) { return <tbody className=\"b\">{children}</tbody> }\nfunction Body2({ children }: any) { return <TableBody>{children}</TableBody> }\nexport default function F() { const [n, setN] = useState(0); return <table><Body2>{n && <tr><td onClick={() => setN(1)}>x</td></tr>}</Body2></table> }",
        "function TableBody({ children }: any) { return <tbody className=\"b\">{children}</tbody> }\nfunction Body2({ children }: any) { return <TableBody>{children}</TableBody> }\nexport default function F({ n }: any) { return <table><Body2>{n && <tr><td>x</td></tr>}</Body2></table> }",
        // ... three wrappers, one of them passing children through a fragment
        "function TableBody({ children }: any) { return <tbody className=\"b\">{children}</tbody> }\nfunction Body2({ children }: any) { return <TableBody><>{children}</></TableBody> }\nfunction Body3({ children }: any) { return <Body2>{children}</Body2> }\nexport default function F({ n }: any) { return <table><Body3>{n && <tr><td>x</td></tr>}</Body3></table> }",
        // ... and a `&&` given as children that the child prints in its own <tbody> (shadcn's TableBody shape)
        "function TableBody({ children }: any) { return <tbody className=\"b\">{children}</tbody> }\nexport default function F({ n }: any) { return <table><TableBody>{n && <tr><td>x</td></tr>}</TableBody></table> }",
    ] {
        let (t, rules) = tier(src);
        assert!(matches!(t, Tier::React { .. }), "{src}\n{t:?} {rules:?}");
        assert!(
            rules.iter().any(|r| r == "and-falsy-in-table"),
            "{src}\n{rules:?}"
        );
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

#[test]
fn a_wrapper_chain_that_ends_in_an_element_with_text_keeps_the_else_slot() {
    // Two wrappers into a <div>: the text can sit there, so no refusal and React's `0` prints.
    let src = "function Box({ children }: any) { return <div className=\"b\">{children}</div> }\nfunction Box2({ children }: any) { return <Box>{children}</Box> }\nexport default function F({ n }: any) { return <section><Box2>{n && <i>x</i>}</Box2></section> }";
    let (t, rules) = tier(src);
    assert!(
        !rules.iter().any(|r| r == "and-falsy-in-table"),
        "{rules:?}"
    );
    assert!(matches!(t, Tier::Native | Tier::Static), "{t:?}");
    let (_, html) = page(src, serde_json::json!({ "n": 0 }));
    assert!(html.contains(">0</div>"), "{html}");
}
