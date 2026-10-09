//! M1b-2 Task 7: tier decision, needs_worker, diagnostics order.
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_file, analyze_source};
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

fn analyze(src: &str) -> ComponentIR {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        analyze_source("T.tsx", s.into_bytes(), &AnalyzeOptions::default()).unwrap()
    })
}

#[test]
fn fixture_tiers() {
    let ir = fixture("static-text");
    assert_eq!((ir.tier, ir.needs_worker), (Tier::Static, false));

    let ir = fixture("theme-toggle");
    assert_eq!((ir.tier, ir.jobs.len()), (Tier::Native, 0));

    let ir = fixture("product-card");
    assert_eq!(ir.tier, Tier::Native);
    assert_eq!(ir.jobs.len(), 1);
    assert!(ir.needs_worker);

    let ir = fixture("parent-counter");
    assert_eq!(ir.tier, Tier::Native);
    assert_eq!(ir.child_links.len(), 1);

    // Review Focus 5.
    let ir = fixture("react-child");
    assert_eq!(ir.tier, Tier::Static);
    assert!(ir.needs_worker);

    let ir = fixture("client-only");
    assert!(matches!(
        ir.tier,
        Tier::React {
            client_only: true,
            ..
        }
    ));
    assert_eq!(
        ir.jobs,
        [JobDecl {
            kind: JobKind::Ssr { client_only: true },
            inputs: vec!["*".into()],
            outputs: vec![format!("_ssr_{}", ir.id)],
            per_item: None,
            props: None,
        }]
    );

    let ir = fixture("server-leak");
    assert_eq!(ir.tier, Tier::Native);
    assert!(ir.diagnostics.iter().any(|d| d.class == DiagClass::Error));

    let ir = fixture("react-hook");
    assert!(
        matches!(&ir.tier, Tier::React { client_only: false, reason } if reason.contains("useContext"))
    );
}

/// Handoff ruling 1: a handler that builds JSX makes the component React.
#[test]
fn jsx_outside_render_is_info_and_react() {
    let ir = analyze(
        "import { useState } from 'react'\nexport default function J() {\n  const [el, setEl] = useState(null)\n  return <div onClick={() => { const x = 1; setEl(<b>{x}</b>) }}>{el}</div>\n}",
    );
    let d: Vec<_> = ir
        .diagnostics
        .iter()
        .filter(|d| d.rule == "jsx-outside-render")
        .collect();
    assert_eq!(d.len(), 1, "{:?}", ir.diagnostics);
    assert_eq!(d[0].class, DiagClass::Info);
    assert!(d[0].message.starts_with("a handler at line 4 builds JSX"));
    assert!(matches!(ir.tier, Tier::React { .. }));
}

/// F21: a ref that is not a useRef binding.
#[test]
fn foreign_ref_falls_back() {
    let ir = analyze("export default function R({ r }: any) { return <div ref={r} /> }");
    assert!(
        ir.diagnostics.iter().any(|d| d.rule == "ref-shape"),
        "{:?}",
        ir.diagnostics
    );
    assert!(matches!(ir.tier, Tier::React { .. }));
    let ir = analyze(
        "import { useRef } from 'react'\nexport default function R() { const r = useRef(null); return <div ref={r} /> }",
    );
    assert!(ir.diagnostics.is_empty(), "{:?}", ir.diagnostics);
    assert_eq!(ir.tier, Tier::Native);
}

#[test]
fn diagnostics_sort_by_severity_then_position() {
    let ir = analyze(
        "export default function D({ xs, a }: any) {\n  return <>{a ?? <i/>}{xs.map((x: any) => <li>{x}</li>)}</>\n}",
    );
    let order: Vec<_> = ir
        .diagnostics
        .iter()
        .map(|d| (d.class, d.line, d.col))
        .collect();
    let mut sorted = order.clone();
    sorted.sort_by_key(|(c, l, col)| (c.severity_rank(), *l, *col));
    assert_eq!(order, sorted);
    assert_eq!(ir.diagnostics[0].class, DiagClass::Error);
    assert!(ir.diagnostics.iter().any(|d| d.class == DiagClass::Warning));
}
