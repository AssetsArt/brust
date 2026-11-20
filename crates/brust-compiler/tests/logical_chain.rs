//! F555: `&&` / `||` / `??` chains lower to template text linear in the chain. JS chains nest to the left
//! (`a && b && c` is `(a && b) && c`) and the value form printed its left operand twice (three times for `??`), so a
//! chain of n operands was 2^n (3^n) copies: an app report had one 16-term `||` / `&&` test of 2.5 MB, inlined into
//! templates of 120 MB. A chain now prints nested to the right, and a test of truthiness (a branch, a boolean
//! attribute, the operand of `!`) prints jinja's short-circuit `and` / `or` / `not`, each operand once.
//!
//! The semantics rows render through minijinja and compare with what JS (bun) gives for the same inputs.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

fn jinja(src: &str) -> String {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            "crates/brust-compiler/tests/fixtures/L.tsx",
            Some(s.into_bytes()),
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        tree[0].artifacts.jinja.clone()
    })
}

fn render(jinja: &str, props: &serde_json::Value) -> String {
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    env.render_str(jinja, brust_jinja::value_of(props.clone()))
        .unwrap()
}

/// A static component of props `a1 … a16` (and `x`) returning `body`.
fn component(body: &str) -> String {
    let names: Vec<String> = (1..=16).map(|i| format!("a{i}")).collect();
    format!(
        "export default function L({{ x, {} }}: any) {{ return {body} }}",
        names.join(", ")
    )
}

fn chain(op: &str) -> String {
    (1..=16)
        .map(|i| format!("a{i}"))
        .collect::<Vec<_>>()
        .join(&format!(" {op} "))
}

/// The app report's shape: `x || (y1 && … && y16)` (here over `a1 … a16`).
fn report() -> String {
    format!("(x === 'g' || ({}))", chain("&&"))
}

/// An absolute bound: before F555 these were 0.5 MB – GBs; each now prints every operand a few times.
const BOUND: usize = 4096;

fn assert_small(label: &str, body: &str) -> String {
    let j = jinja(&component(body));
    eprintln!("{label}: {} bytes", j.len());
    // A server template, not the React fallback (an island prints none of the operands).
    assert!(j.contains("a16"), "{label}: not lowered\n{j}");
    assert!(j.len() < BOUND, "{label}: {} bytes\n{j}", j.len());
    j
}

#[test]
fn and_chain_of_16_is_linear() {
    assert_small("&& value", &format!("<p title={{{}}}>t</p>", chain("&&")));
}

#[test]
fn or_chain_of_16_is_linear() {
    assert_small("|| value", &format!("<p title={{{}}}>t</p>", chain("||")));
}

#[test]
fn nullish_chain_of_16_is_linear() {
    assert_small("?? value", &format!("<p title={{{}}}>t</p>", chain("??")));
}

#[test]
fn report_shape_in_a_jsx_test_is_linear_and_prints_each_operand_once() {
    let j = assert_small(
        "report && <jsx>",
        &format!("<p>{{{} && <b>y</b>}}</p>", report()),
    );
    // A test prints jinja's own `and` / `or`: every operand once.
    for i in 1..=16 {
        assert_eq!(
            j.matches(&format!("(a{i} | truthy)")).count(),
            1,
            "a{i}\n{j}"
        );
    }
}

#[test]
fn report_shape_in_value_position_is_linear() {
    assert_small("report value", &format!("<p title={{{}}}>t</p>", report()));
    assert_small(
        "cond && text",
        // A text child: a bare expression this deep is refused as a child (`jsx-const-child`), a template literal is not.
        &format!("<p>{{`${{{} && \"text\"}}`}}</p>", report()),
    );
    assert_small(
        "className",
        &format!("<p className={{{}}}>t</p>", chain("&&")),
    );
}

#[test]
fn boolean_attribute_prints_each_operand_once() {
    let j = assert_small(
        "disabled",
        &format!("<button disabled={{{}}}>t</button>", report()),
    );
    assert_eq!(j.matches("(a16 | truthy)").count(), 1, "{j}");
}

/// Each row: an expression over props `a`, `b`, `c` printed as text through a template literal (JS `String()` of its
/// value), and the inputs it is rendered with.
const ROWS: &[(&str, &str)] = &[
    ("a && b", r#"{"a": 0, "b": "x"}"#),
    ("a && b", r#"{"a": 1, "b": "x"}"#),
    ("a || b || c", r#"{"a": "", "b": "a", "c": "b"}"#),
    ("a || b || c", r#"{"a": "", "b": 0, "c": null}"#),
    ("a ?? b ?? c", r#"{"a": null, "c": 0}"#),
    ("a ?? b ?? c", r#"{"a": false, "b": 1, "c": 2}"#),
    ("a ?? b ?? c", r#"{"b": "", "c": 2}"#),
    ("a && a.b.c", r#"{}"#),
    ("a && a.b.c", r#"{"a": {"b": {"c": 5}}}"#),
    ("a && b && c", r#"{"a": 1, "b": "", "c": 3}"#),
    ("a && b && c", r#"{"a": 1, "b": 2, "c": 3}"#),
    ("!(a && b)", r#"{"a": 1, "b": 0}"#),
    ("!(a && b)", r#"{"a": 1, "b": 2}"#),
    ("!(a || b)", r#"{"a": 0, "b": ""}"#),
];

/// Inputs for the mixed rows: every pair of a falsy and a truthy value per prop.
const MIXED: &[&str] = &[
    "(a || b) && c",
    "a && (b || c)",
    "(a && b) || c",
    "a || (b && c)",
    "(a ?? b) || c",
    "(a || b) ?? c",
    "!(a && b) || c",
    "a && b ? b : c",
];

fn js_strings(cases: &[(String, serde_json::Value)]) -> Option<Vec<String>> {
    let bun = lower_common::bun()?;
    let body: String = cases
        .iter()
        .map(|(e, p)| format!("(({{a, b, c}}) => String({e}))({p}),"))
        .collect();
    let out = std::process::Command::new(bun)
        .args(["-e", &format!("console.log(JSON.stringify([{body}]))")])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    Some(serde_json::from_slice(&out.stdout).unwrap())
}

mod lower_common;

#[test]
fn chains_render_the_value_js_gives() {
    let mut cases: Vec<(String, serde_json::Value)> = ROWS
        .iter()
        .map(|(e, p)| (e.to_string(), serde_json::from_str(p).unwrap()))
        .collect();
    let values = [
        serde_json::json!(0),
        serde_json::json!("y"),
        serde_json::json!(null),
    ];
    for e in MIXED {
        for a in &values {
            for b in &values {
                for c in &values {
                    cases.push((e.to_string(), serde_json::json!({"a": a, "b": b, "c": c})));
                }
            }
        }
    }
    let Some(js) = js_strings(&cases) else {
        eprintln!("bun not found: skipped");
        return;
    };
    for ((e, p), want) in cases.iter().zip(js) {
        let j = jinja(&format!(
            "export default function L({{ a, b, c }}: any) {{ return <p>{{`${{{e}}}`}}</p> }}"
        ));
        let html = render(&j, p);
        assert_eq!(html, format!("<p>{want}</p>"), "{e} with {p}\n{j}");
        // In a test position (a branch) the same expression picks the branch JS picks.
        let j = jinja(&format!(
            "export default function L({{ a, b, c }}: any) {{ return <p>{{({e}) ? <b>y</b> : <i>n</i>}}</p> }}"
        ));
        let truthy = !matches!(
            want.as_str(),
            "0" | "" | "null" | "undefined" | "false" | "NaN"
        );
        let html = render(&j, p);
        assert_eq!(
            html,
            if truthy {
                "<p><b>y</b></p>"
            } else {
                "<p><i>n</i></p>"
            },
            "{e} with {p}\n{j}"
        );
    }
}
