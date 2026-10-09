//! M1b-2 Task 3: placement — Server / Precomputed / ClientOnly and the
//! precompute job.
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_source};
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;

pub fn analyze(path: &str, src: &str) -> ComponentIR {
    let (p, s) = (path.to_string(), src.to_string());
    run_on_compiler_thread(move || {
        analyze_source(&p, s.into_bytes(), &AnalyzeOptions::default()).unwrap()
    })
}

fn fixture(name: &str) -> ComponentIR {
    let src = std::fs::read_to_string(format!(
        "{}/../../tests/fixtures/{name}/input.tsx",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    analyze(&format!("tests/fixtures/{name}/input.tsx"), &src)
}

fn derived<'a>(ir: &'a ComponentIR, name: &str) -> &'a Expr {
    &ir.derived.iter().find(|d| d.name == name).unwrap().expr
}

/// Slot expressions of the template, document order.
fn slots(n: &Node, out: &mut Vec<Expr>) {
    match n {
        Node::Slot(e) => out.push(e.clone()),
        Node::Element { children, .. } | Node::Fragment(children) => {
            children.iter().for_each(|c| slots(c, out))
        }
        Node::For { body, .. } => body.iter().for_each(|c| slots(c, out)),
        Node::If { then, else_, .. } => then.iter().chain(else_).for_each(|c| slots(c, out)),
        _ => {}
    }
}

#[test]
fn product_card_places_server_and_precomputed() {
    let ir = fixture("product-card");
    let mut s = Vec::new();
    slots(&ir.template, &mut s);
    // `{item.name}`, `{unit}`, `{total}` are template reads.
    assert!(s.iter().all(|e| matches!(e, Expr::Server(_))), "{s:?}");
    assert_eq!(
        derived(&ir, "unit"),
        &Expr::Precomputed {
            slot: "_s1".into(),
            js: "formatPrice(item.price)".into(),
            client_js: None,
            inputs: vec!["item.price".into()],
            state_dependent: false,
            per_item: None,
        }
    );
    assert_eq!(
        derived(&ir, "total"),
        &Expr::Precomputed {
            slot: "_s2".into(),
            js: "formatPrice(item.price * qty)".into(),
            client_js: Some("formatPrice(props().item.price * qty())".into()),
            inputs: vec!["item.price".into()],
            state_dependent: true,
            per_item: None,
        }
    );
    assert!(matches!(ir.state[0].init, Expr::Server(_)));
    assert_eq!(
        ir.jobs,
        [JobDecl {
            kind: JobKind::Precompute,
            inputs: vec!["item.price".into()],
            outputs: vec!["_s1".into(), "_s2".into()],
            per_item: None,
        }]
    );
}

#[test]
fn theme_toggle_needs_no_job() {
    let ir = fixture("theme-toggle");
    assert!(matches!(derived(&ir, "label"), Expr::Server(_)));
    assert!(matches!(
        &ir.state[0].init,
        Expr::Server(ServerExpr(RawExpr {
            kind: RawKind::Lit(_),
            ..
        }))
    ));
    assert!(ir.jobs.is_empty());
}

/// Review Focus 3: a slot in a list body is per item and the list is the input.
#[test]
fn list_slots_are_per_item() {
    let ir = analyze(
        "L.tsx",
        "import { fmt } from './money'\nexport default function L({ items }: any) { return <ul>{items.map((i: any) => <li key={i.id}>{fmt(i.price)}</li>)}</ul> }",
    );
    let mut s = Vec::new();
    slots(&ir.template, &mut s);
    assert_eq!(
        s,
        [Expr::Precomputed {
            slot: "_s1".into(),
            js: "fmt(i.price)".into(),
            client_js: None,
            inputs: vec!["items".into()],
            state_dependent: false,
            per_item: Some("i".into()),
        }]
    );
    assert_eq!(ir.jobs[0].inputs, ["items"]);
}

#[test]
fn unreached_derived_and_refs_are_client_only() {
    let ir = analyze(
        "C.tsx",
        "import { useState, useRef } from 'react'\nexport default function C({ a }: any) { const [n, setN] = useState(0); const r = useRef(null); const next = n + a; return <button ref={r} onClick={() => setN(next)}>{n}</button> }",
    );
    assert_eq!(
        derived(&ir, "next"),
        &Expr::ClientOnly {
            js: "n() + props().a".into()
        }
    );
    assert!(matches!(ir.refs[0].init, Expr::ClientOnly { .. }));
}

#[test]
fn derived_chain_slot_feeds_a_template_read() {
    let ir = analyze(
        "D.tsx",
        "import { fmt } from './money'\nexport default function D({ a }: any) { const p = fmt(a); const q = p + '!'; return <p title={q}>{p}</p> }",
    );
    assert!(matches!(derived(&ir, "p"), Expr::Precomputed { slot, .. } if slot == "_s1"));
    assert!(matches!(derived(&ir, "q"), Expr::Server(_)));
    let Node::Element { attrs, .. } = &ir.template else {
        panic!()
    };
    assert!(matches!(
        &attrs[0],
        Attr::Dynamic {
            value: Expr::Server(_),
            ..
        }
    ));
}

#[test]
fn jsx_in_an_expression_falls_back() {
    let ir = analyze(
        "J.tsx",
        "export default function J({ a }: any) { return <p>{a ?? <b/>}</p> }",
    );
    assert!(ir.diagnostics.iter().any(|d| d.rule == "jsx-expression"));
}
