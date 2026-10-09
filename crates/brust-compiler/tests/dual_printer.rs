//! M1c Task 2: one table, both printers. Each row pins the jinja text and the
//! JS text of the same `ServerExpr`, then evaluates both on the same sample
//! data — minijinja in-process, the JS under `bun` — and asserts the painted
//! strings agree (spec §6.3).
use brust_compiler::analyze::component::debug_first_slot;
use brust_compiler::ir::{RawExpr, ServerExpr};
use brust_compiler::lower::server_expr::{JinjaCtx, to_jinja};
use brust_compiler::parse::{parse_tsx, run_on_compiler_thread};

fn slot(body: &str) -> RawExpr {
    let src = format!(
        "import {{ useState }} from 'react'\nexport default function C({{ a, b, xs, o, s, u }}: any) {{ const [n, setN] = useState(3); return <p>{{{body}}}</p> }}\n"
    );
    run_on_compiler_thread(move || {
        let parsed = parse_tsx("C.tsx", src.into_bytes()).unwrap();
        debug_first_slot(&parsed).expect("slot")
    })
}

/// (source, jinja, js)
const ROWS: &[(&str, &str, &str)] = &[
    ("'it\"s'", r#""it\"s""#, r#""it\"s""#),
    ("1.5", "1.5", "1.5"),
    ("null", "none", "null"),
    ("true", "true", "true"),
    ("a", "a", "a"),
    ("n", "n", "n"),
    ("o.k", r#"o["k"]"#, "o.k"),
    (
        "u?.k",
        r#"(u["k"] if u is defined and u is not none else __undefined)"#,
        "u?.k",
    ),
    ("undefined", "__undefined", "undefined"),
    ("xs[1]", "xs[1]", "xs[1]"),
    ("!a", "(not a)", "!a"),
    ("-b", "(-b)", "-b"),
    ("a && b", "(a and b)", "a && b"),
    ("u || b", "(u or b)", "u || b"),
    (
        "u ?? b",
        "(u if u is defined and u is not none else b)",
        "u ?? b",
    ),
    ("b === 2", "(b == 2)", "b === 2"),
    ("b !== n", "(b != n)", "b !== n"),
    (
        "b < n && n >= 3",
        "((b < n) and (n >= 3))",
        "b < n && n >= 3",
    ),
    ("b + n * 2", "(b + (n * 2))", "b + n * 2"),
    ("(b + n) % 2", "((b + n) % 2)", "(b + n) % 2"),
    ("n / 2", "(n / 2)", "n / 2"),
    ("'x' + b", r#"("x" ~ (b | js_string))"#, r#""x" + b"#),
    ("a + '!'", r#"((a | js_string) ~ "!")"#, r#"a + "!""#),
    (
        "b > 1 ? 'big' : 'small'",
        r#"("big" if (b > 1) else "small")"#,
        r#"b > 1 ? "big" : "small""#,
    ),
    (
        "`${a}-${n}`",
        r#"("" ~ (a | js_string) ~ "-" ~ (n | js_string) ~ "")"#,
        "`${a}-${n}`",
    ),
    ("xs.length", "(xs | length)", "xs.length"),
    ("a.toUpperCase()", "(a | upper)", "a.toUpperCase()"),
    ("a.toLowerCase()", "(a | lower)", "a.toLowerCase()"),
    ("s.trim()", "(s | trim)", "s.trim()"),
    ("a.slice(0, 1)", "(a | str_slice(0, 1))", "a.slice(0, 1)"),
    (
        "a.startsWith('H')",
        r#"(a | starts_with("H"))"#,
        r#"a.startsWith("H")"#,
    ),
    (
        "a.endsWith('i')",
        r#"(a | ends_with("i"))"#,
        r#"a.endsWith("i")"#,
    ),
    (
        "xs.includes('y')",
        r#"(xs | includes("y"))"#,
        r#"xs.includes("y")"#,
    ),
    ("xs.join('+')", r#"(xs | join("+"))"#, r#"xs.join("+")"#),
    (
        "Object.keys(o).length",
        "((o | keys) | length)",
        "Object.keys(o).length",
    ),
];

const SAMPLE_JS: &str =
    r#"const a = "Hi", b = 2, xs = ["x", "y"], o = { k: 1 }, s = " Pad ", u = undefined, n = 3;"#;

fn sample_ctx() -> minijinja::Value {
    minijinja::Value::from_serialize(serde_json::json!({
        "a": "Hi", "b": 2, "xs": ["x", "y"], "o": { "k": 1 }, "s": " Pad ", "n": 3
    }))
}

#[test]
fn both_printers_table() {
    assert!(ROWS.len() >= 25);
    let mut failures = Vec::new();
    for (src, jinja, js) in ROWS {
        let e = slot(src);
        let got_j = to_jinja(&ServerExpr(e.clone()), &JinjaCtx::plain());
        let got_js = e.to_js();
        if got_j != *jinja {
            failures.push(format!("{src}: jinja {got_j}  want {jinja}"));
        }
        if got_js != *js {
            failures.push(format!("{src}: js {got_js}  want {js}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Both printers evaluate to the same `String(value)` on the sample.
#[test]
fn both_printers_agree_on_sample_data() {
    let Ok(bun) = which_bun() else {
        eprintln!("warning: bun not on PATH; skipping the JS side of the dual printer");
        return;
    };
    let mut script = String::from(SAMPLE_JS);
    script.push_str("\nconsole.log(JSON.stringify([");
    for (_, _, js) in ROWS {
        script.push_str(&format!("String({js}),"));
    }
    script.push_str("]))\n");
    let out = std::process::Command::new(bun)
        .args(["-e", &script])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let js_values: Vec<String> = serde_json::from_slice(&out.stdout).unwrap();

    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    let mut failures = Vec::new();
    for ((src, jinja, _), want) in ROWS.iter().zip(&js_values) {
        let got = env
            .render_str(&format!("{{{{ ({jinja}) | js_string }}}}"), sample_ctx())
            .unwrap_or_else(|e| format!("<error {e}>"));
        if &got != want {
            failures.push(format!("{src}: jinja paints {got:?}, js {want:?}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn which_bun() -> Result<String, ()> {
    std::process::Command::new("bun")
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|_| "bun".to_string())
        .ok_or(())
}
