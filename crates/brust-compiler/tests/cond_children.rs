//! F384: `{cond && children}` and `{cond ? children : null}` (either arm; `props.children` too) are the `children` slot
//! under a condition, read as markup like `{children}` itself, so an inlined instance with children answers them: a page
//! with such a component was React ('reads `children` as a value'). Radix CollapsibleContentImpl's `{isOpen && children}`
//! is the shape, inside a specialised Provider clone. With F388 a falsy number condition paints the number, as React does.
//! Fixture: packages/brust/test/fixtures/cond-children (served in tests/server/cond-children.chromium.test.ts).
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::*;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

/// Per compiled component (id, tier, diagnostic rules), and the page's first paint.
fn page(path: &str, src: Option<&str>) -> (Vec<(String, Tier, Vec<String>)>, String) {
    let (path, src) = (path.to_string(), src.map(|s| s.as_bytes().to_vec()));
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            &path,
            src,
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        let mut env = minijinja::Environment::new();
        brust_jinja::register(&mut env);
        let html = env
            .render_str(
                &tree[0].artifacts.jinja,
                brust_jinja::value_of(serde_json::json!({ "_props": {} })),
            )
            .unwrap();
        let rows = tree
            .iter()
            .map(|l| {
                (
                    l.ir.id.clone(),
                    l.ir.tier.clone(),
                    l.ir.diagnostics.iter().map(|d| d.rule.clone()).collect(),
                )
            })
            .collect();
        (rows, html)
    })
}

fn native(rows: &[(String, Tier, Vec<String>)]) {
    for (id, tier, rules) in rows {
        assert!(
            matches!(tier, Tier::Static | Tier::Native),
            "{id}: {tier:?} {rules:?}"
        );
        assert!(
            !rules.iter().any(|r| r == "children-read"),
            "{id}: {rules:?}"
        );
    }
}

#[test]
fn conditional_children_plain_and_in_a_provider_clone_are_native() {
    let (rows, html) = page(
        "packages/brust/test/fixtures/cond-children/CondPage.tsx",
        None,
    );
    native(&rows);
    // Closed: no child text is visible (the branch kept for the client is hidden).
    for child in ["plain child", "panel child", "ternary child"] {
        let at = html.find(child).expect(child);
        let open = html[..at].rfind("<brust-if").expect(child);
        assert!(
            html[open..at].contains(" hidden"),
            "{child} must start hidden:\n{html}"
        );
    }
}

#[test]
fn every_spelling_of_the_conditional_slot() {
    for body in [
        "return <div>{props.open && props.children}</div>",
        "return <div>{props.open ? props.children : null}</div>",
        "return <div>{props.open ? null : props.children}</div>",
        "return <div>{props.open ? props.children : undefined}</div>",
        "return <div>{props.open ? props.children : false}</div>",
    ] {
        let src = format!(
            "function P(props: any) {{ {body} }}\nexport default function Q() {{ return <main><P open={{true}}>yes</P><P open={{false}}>no</P></main> }}"
        );
        let (rows, html) = page("crates/brust-compiler/tests/fixtures/Q.tsx", Some(&src));
        native(&rows);
        let flipped = body.contains("? null");
        let (shown, gone) = if flipped {
            ("no", "yes")
        } else {
            ("yes", "no")
        };
        assert!(
            html.contains(&format!("<div>{shown}</div>")),
            "{body}: {html}"
        );
        assert!(!html.contains(gone), "{body}: {html}");
    }
}

#[test]
fn a_falsy_number_condition_paints_the_number() {
    let src = "import { useState } from 'react'\nfunction C({ n, children }: any) { return <div>{n && children}</div> }\nexport default function Z() { const [n, setN] = useState(0); return <main><button onClick={() => setN(n + 1)}>+</button><C n={n}><b>hi</b></C></main> }";
    let (rows, html) = page("crates/brust-compiler/tests/fixtures/Z.tsx", Some(src));
    native(&rows);
    assert!(html.contains("x-text=\"_c2\">0</brust-if>"), "{html}");
}

#[test]
fn children_read_as_a_value_elsewhere_stays_refused() {
    let src = "function P({ children }: any) { return <div title={children ? 'y' : 'n'}>{children}</div> }\nexport default function Q() { return <main><P>yes</P></main> }";
    let (rows, _) = page("crates/brust-compiler/tests/fixtures/Q.tsx", Some(src));
    assert!(
        rows.iter()
            .any(|(_, _, r)| r.iter().any(|x| x == "children-read")),
        "{rows:?}"
    );
}
