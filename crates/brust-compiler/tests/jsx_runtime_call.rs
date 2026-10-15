//! shadcn S3 (R34.67): a hand-written call to React's JSX runtime is a fallback, never an opaque slot.
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_source};
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;
use std::path::PathBuf;

fn analyze(src: &str) -> ComponentIR {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        analyze_source(
            "tests/fixtures/jsx-runtime-call/input.tsx",
            s.into_bytes(),
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
        )
        .unwrap()
    })
}

fn flagged(src: &str) -> bool {
    let ir = analyze(src);
    let hit = ir.diagnostics.iter().any(|d| d.rule == "jsx-runtime-call");
    // The fallback makes the component React; without it the component keeps its tier.
    assert_eq!(
        hit,
        matches!(ir.tier, Tier::React { .. }),
        "{:?}",
        ir.diagnostics
    );
    hit
}

#[test]
fn jsx_jsxs_and_jsxdev_calls_fall_back() {
    assert!(flagged(
        "import { jsx } from 'react/jsx-runtime'\nexport default function C() { return jsx('div', {}) }"
    ));
    assert!(flagged(
        "import { jsxs } from 'react/jsx-runtime'\nexport default function C() { return jsxs('div', { children: [] }) }"
    ));
    assert!(flagged(
        "import { jsxDEV } from 'react/jsx-dev-runtime'\nexport default function C() { return jsxDEV('div', {}) }"
    ));
}

#[test]
fn aliases_and_namespace_imports_fall_back() {
    assert!(flagged(
        "import { jsx as h } from 'react/jsx-runtime'\nexport default function C() { return h('p', {}) }"
    ));
    assert!(flagged(
        "import * as R from 'react/jsx-runtime'\nexport default function C() { return R.jsx('p', {}) }"
    ));
}

#[test]
fn a_call_in_another_function_of_the_module_also_falls_back() {
    // esbuild output keeps every component in one module: one hand-written call taints the module.
    assert!(flagged(
        "import { jsx } from 'react/jsx-runtime'\nfunction Other() { return jsx('i', {}) }\nexport default function C() { return <p>x</p> }"
    ));
}

#[test]
fn ordinary_jsx_and_unrelated_names_do_not() {
    assert!(!flagged("export default function C() { return <p>x</p> }"));
    // a local function named jsx, and a `jsx` imported from somewhere else, are not the runtime
    assert!(!flagged(
        "const jsx = (s: string) => s\nexport default function C() { return <p>{jsx('a')}</p> }"
    ));
    assert!(!flagged(
        "import { jsx } from './mine'\nexport default function C() { return <p>{jsx('a')}</p> }"
    ));
}

#[test]
fn value_indirect_spellings_fall_back() {
    // F156: the builder read as a value, then called through another spelling.
    assert!(flagged(
        "import { jsx } from 'react/jsx-runtime'\nconst h = jsx\nexport default function C() { return h('p', {}) }"
    ));
    assert!(flagged(
        "import { jsx } from 'react/jsx-runtime'\nexport default function C() { return (0, jsx)('p', {}) }"
    ));
    assert!(flagged(
        "import { jsxs } from 'react/jsx-runtime'\nconst call = (f: any) => f('p', { children: [] })\nexport default function C() { return call(jsxs) }"
    ));
    assert!(flagged(
        "import * as R from 'react/jsx-runtime'\nconst h = R.jsx\nexport default function C() { return h('p', {}) }"
    ));
    assert!(flagged(
        "import * as R from 'react/jsx-runtime'\nexport default function C() { return (0, R.jsx)('p', {}) }"
    ));
    assert!(flagged(
        "import R from 'react/jsx-runtime'\nconst { jsx: h } = R\nexport default function C() { return h('p', {}) }"
    ));
}

#[test]
fn ordinary_jsx_next_to_an_unused_runtime_import_does_not() {
    // The parser's own JSX calls are not reads of the import.
    assert!(!flagged(
        "import { jsx } from 'react/jsx-runtime'\nexport default function C() { return <p>x</p> }"
    ));
}
