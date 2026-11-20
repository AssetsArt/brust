//! F560: a call of a `const` arrow of the component whose body is one expression is replaced by that expression, so the
//! value is read like any other (it used to be `client-function-in-job`: a function the client owns, called in a job).
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_source};
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;
use std::path::PathBuf;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn analyze(src: &str) -> ComponentIR {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        analyze_source(
            "tests/fixtures/parent-counter/T.tsx",
            s.into_bytes(),
            &AnalyzeOptions {
                root: repo(),
                ..Default::default()
            },
        )
        .unwrap()
    })
}

fn fallbacks(ir: &ComponentIR) -> Vec<&str> {
    ir.diagnostics
        .iter()
        .filter(|d| d.class == DiagClass::Fallback)
        .map(|d| d.rule.as_str())
        .collect()
}

#[test]
fn a_call_of_an_expression_arrow_is_its_expression() {
    for src in [
        // in the markup
        "export default function T(props: { a: number; b: number }) { const sum = (x: number, y: number) => x + y; return <p>{sum(props.a, props.b)}</p> }",
        // in a derived value, beside state
        "import { useState } from 'react'\nexport default function T(props: { a: number }) { const [n, setN] = useState(0); const twice = (x: number) => x * 2; const v = twice(n) + props.a; return <button onClick={() => setN(n + 1)}>{v}</button> }",
        // an arrow that reads a prop itself
        "export default function T(props: { unit: string; n: number }) { const fmt = (x: number) => x + ' ' + props.unit; return <p>{fmt(props.n)}</p> }",
    ] {
        let ir = analyze(src);
        assert!(fallbacks(&ir).is_empty(), "{src}: {:?}", ir.diagnostics);
        assert!(
            !matches!(ir.tier, Tier::React { .. }),
            "{src}: {:?}",
            ir.tier
        );
    }
}

#[test]
fn an_arrow_that_is_not_one_expression_or_is_also_a_value_is_left_alone() {
    for src in [
        // a block body
        "import { useState } from 'react'\nexport default function T() { const [n, setN] = useState(0); const twice = (x: number) => { return x * 2 }; const v = twice(n); return <button onClick={() => setN(n + 1)}>{v}</button> }",
        // an argument that is a call (it would be evaluated once per use of the parameter)
        "import { useState } from 'react'\nexport default function T() { const [n, setN] = useState(0); const twice = (x: number) => x + x; const v = twice(Math.random() + n); return <button onClick={() => setN(n + 1)}>{v}</button> }",
    ] {
        let ir = analyze(src);
        assert!(
            fallbacks(&ir).contains(&"client-function-in-job"),
            "{src}: {:?} {:?}",
            ir.tier,
            ir.diagnostics
        );
    }
}
