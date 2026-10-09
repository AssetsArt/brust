//! M1b-2 Task 3: RawExpr::to_js / to_js_in — the JS half of the dual printer.
use brust_compiler::analyze::component::debug_first_slot;
use brust_compiler::ir::{JsCtx, RawExpr, RawKind};
use brust_compiler::parse::{parse_tsx, run_on_compiler_thread};

fn slot(body: &str) -> RawExpr {
    let src = format!(
        "import {{ fmt }} from './money'\nimport {{ useState }} from 'react'\nexport default function C({{ a, b, 'data-x': dx }}: any) {{ const [n, setN] = useState(1); return <p>{{{body}}}</p> }}\n"
    );
    run_on_compiler_thread(move || {
        let parsed = parse_tsx("C.tsx", src.into_bytes()).unwrap();
        debug_first_slot(&parsed).expect("slot")
    })
}

/// Structure without locations.
fn shape(e: &RawExpr) -> String {
    let v = serde_json::to_value(&e.kind).unwrap();
    strip_loc(v).to_string()
}

fn strip_loc(v: serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match v {
        Value::Object(m) => Value::Object(
            m.into_iter()
                .filter(|(k, _)| k != "loc")
                .map(|(k, v)| (k, strip_loc(v)))
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.into_iter().map(strip_loc).collect()),
        v => v,
    }
}

#[test]
fn server_printing_table_round_trips() {
    let rows = [
        ("a.b", "a.b"),
        ("a === 1 ? 'x' : b", "a === 1 ? \"x\" : b"),
        ("`p ${a} \\` $ {b}`", "`p ${a} \\` $ {b}`"),
        ("a?.b", "a?.b"),
        ("a[0]", "a[0]"),
        ("fmt(a.price, 2)", "fmt(a.price, 2)"),
        ("(a + b) * n", "(a + b) * n"),
        ("a - (b - n)", "a - (b - n)"),
        ("a - b - n", "a - b - n"),
        ("(a || b) ?? n", "(a || b) ?? n"),
        ("a && (b ?? n)", "a && (b ?? n)"),
        ("!(a && b)", "!(a && b)"),
        ("-(-a)", "-(-a)"),
        ("(a ? b : n) ? 1 : 2", "(a ? b : n) ? 1 : 2"),
        ("fmt([a, 'x', 1.5])", "fmt([a, \"x\", 1.5])"),
        ("{ k: a, 'two words': 2 }", "{ k: a, \"two words\": 2 }"),
        ("(x: number) => x + a", "(x) => x + a"),
        ("(x: number) => ({ v: x })", "(x) => ({ v: x })"),
        ("(1).toFixed(2)", "(1).toFixed(2)"),
        ("n", "n"),
        ("dx", "data-x"),
    ];
    let mut failures = Vec::new();
    for (src, want) in rows {
        let e = slot(src);
        let got = e.to_js();
        if got != want {
            failures.push(format!("{src}: got {got}, want {want}"));
            continue;
        }
        // `data-x` is not an identifier: skip the round trip for that row.
        if want == "data-x" {
            continue;
        }
        let again = slot(&got);
        if shape(&again) != shape(&e) {
            failures.push(format!(
                "{src}: round trip changed\n {}\n {}",
                shape(&e),
                shape(&again)
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn client_context_reads_props_and_signals() {
    let e = slot("a.price * n + b");
    assert_eq!(
        e.to_js_in(JsCtx::Client),
        "props().a.price * n() + props().b"
    );
    assert_eq!(e.to_js_in(JsCtx::Server), "a.price * n + b");
    let e = slot("dx");
    assert_eq!(e.to_js_in(JsCtx::Client), "props()[\"data-x\"]");
    assert!(matches!(slot("new Date(a)").kind, RawKind::Opaque { .. }));
    assert_eq!(slot("new Date(a)").to_js(), "new Date(a)");
}
