//! M1b-2 Task 4: client props/imports, server-only and request-state checks.
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_source};
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;

fn analyze_with(path: &str, src: &str, opts: AnalyzeOptions) -> ComponentIR {
    let (p, s) = (path.to_string(), src.to_string());
    run_on_compiler_thread(move || analyze_source(&p, s.into_bytes(), &opts).unwrap())
}

fn analyze(path: &str, src: &str) -> ComponentIR {
    analyze_with(path, src, AnalyzeOptions::default())
}

fn fixture(name: &str) -> ComponentIR {
    let src = std::fs::read_to_string(format!(
        "{}/../../tests/fixtures/{name}/input.tsx",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    analyze(&format!("tests/fixtures/{name}/input.tsx"), &src)
}

fn errors(ir: &ComponentIR, rule: &str) -> Vec<Diagnostic> {
    ir.diagnostics
        .iter()
        .filter(|d| d.rule == rule && d.class == DiagClass::Error)
        .cloned()
        .collect()
}

#[test]
fn theme_toggle_ships_nothing() {
    let ir = fixture("theme-toggle");
    assert!(ir.client_props.is_empty(), "{:?}", ir.client_props);
    assert!(ir.client_imports.is_empty(), "{:?}", ir.client_imports);
}

#[test]
fn product_card_ships_item_and_format_price() {
    let ir = fixture("product-card");
    assert_eq!(ir.client_props, ["item"]);
    assert_eq!(
        ir.client_imports,
        [("./money".to_string(), "formatPrice".to_string())]
    );
    assert!(ir.diagnostics.iter().all(|d| d.class != DiagClass::Error));
}

#[test]
fn server_leak_is_an_error_with_the_line() {
    let ir = fixture("server-leak");
    let e = errors(&ir, "server-only-in-client");
    assert_eq!(e.len(), 1, "{:?}", ir.diagnostics);
    assert_eq!(e[0].line, 8);
    assert!(
        e[0].message.contains(
            "readFileSync from node:fs is server-only but is used by a handler at line 8"
        ),
        "{}",
        e[0].message
    );
}

/// A props-only precomputed slot runs in the job: server-only is fine there.
#[test]
fn props_only_job_may_use_server_only_code() {
    let ir = analyze(
        "S.tsx",
        "import { readFileSync } from 'node:fs'\nexport default function S({ path }: any) { const t = readFileSync(path, 'utf8'); return <pre>{t}</pre> }",
    );
    assert!(
        errors(&ir, "server-only-in-client").is_empty(),
        "{:?}",
        ir.diagnostics
    );
    assert_eq!(ir.jobs.len(), 1);
}

/// Review Focus 2: a state-dependent slot whose helper is server-only.
#[test]
fn state_dependent_server_only_helper_is_an_error() {
    let ir = analyze(
        "Q.tsx",
        "import { useState } from 'react'\nimport { db } from './db.server'\nexport default function Q() {\n  const [qty, setQty] = useState(1)\n  const total = db.price(qty)\n  return <b onClick={() => setQty(qty + 1)}>{total}</b>\n}",
    );
    assert!(errors(&ir, "server-only-in-client").is_empty());
    let ir = analyze_with(
        "Q.tsx",
        "import { useState } from 'react'\nimport { db } from './db.server'\nexport default function Q() {\n  const [qty, setQty] = useState(1)\n  const total = db.price(qty)\n  return <b onClick={() => setQty(qty + 1)}>{total}</b>\n}",
        AnalyzeOptions {
            server_only: vec!["./db.server".into()],
            ..Default::default()
        },
    );
    let e = errors(&ir, "server-only-in-client");
    assert_eq!(e.len(), 1, "{:?}", ir.diagnostics);
    assert_eq!(e[0].line, 5);
    assert!(e[0].message.contains("a state-dependent value at line 5"));
}

#[test]
fn request_state_props_are_errors() {
    let ir = analyze(
        "R.tsx",
        "export default function R({ cookies, name }: any) { return <p>{cookies.theme}{name}</p> }",
    );
    assert_eq!(errors(&ir, "request-state-in-render").len(), 1);
    let ir = analyze(
        "R.tsx",
        "export default function R({ cookies, name }: any) { return <p>{name}</p> }",
    );
    assert!(errors(&ir, "request-state-in-render").is_empty());
}

#[test]
fn builtin_detection() {
    use brust_compiler::analyze::passes::captures::is_server_only;
    assert!(is_server_only("node:fs", &[]));
    assert!(is_server_only("bun:sqlite", &[]));
    assert!(is_server_only("fs", &[]));
    assert!(is_server_only("fs/promises", &[]));
    assert!(!is_server_only("fsevents", &[]));
    assert!(!is_server_only("./path-utils", &[]));
    assert!(is_server_only("@app/server/db", &["@app/server".into()]));
}
