//! M1b-2 Task 2: the §6.2 template subset, one row per production and one per
//! deliberate absence.
use brust_compiler::analyze::component::debug_first_slot;
use brust_compiler::analyze::passes::server_expr::try_server;
use brust_compiler::ir::RawExpr;
use brust_compiler::parse::{parse_tsx, run_on_compiler_thread};

fn slot(body: &str) -> RawExpr {
    let src = format!(
        "import {{ fmt }} from './money'\nimport {{ useState }} from 'react'\nexport default function C({{ a, b, xs, o }}: any) {{ const [n, setN] = useState(1); const x = a + 1; return <p>{{{body}}}</p> }}\n"
    );
    run_on_compiler_thread(move || {
        let parsed = parse_tsx("C.tsx", src.into_bytes()).unwrap();
        debug_first_slot(&parsed).expect("slot")
    })
}

#[test]
fn template_subset_table() {
    let rows: &[(&str, Result<(), &str>)] = &[
        // accepted: one per production
        ("'s'", Ok(())),
        ("3", Ok(())),
        ("true", Ok(())),
        ("null", Ok(())),
        ("undefined", Ok(())),
        ("a", Ok(())),
        ("n", Ok(())),
        ("x", Ok(())),
        ("a.b.c", Ok(())),
        ("a?.b", Ok(())),
        ("a[0]", Ok(())),
        ("!a", Ok(())),
        ("-a", Ok(())),
        ("(a && b || n) ?? 1", Ok(())),
        ("a == b && a != b && a === b && a !== b", Ok(())),
        ("a < b && a <= b && a > b && a >= b", Ok(())),
        ("a + b - n * 2 / 3 % 4", Ok(())),
        ("a ? b : n", Ok(())),
        ("`x ${a} y ${n}`", Ok(())),
        ("xs.length", Ok(())),
        ("a.toUpperCase()", Ok(())),
        ("a.trim().toLowerCase()", Ok(())),
        ("a.slice(0, 3)", Ok(())),
        ("a.startsWith('x') && a.endsWith('y')", Ok(())),
        ("xs.includes('a')", Ok(())),
        (
            "['a', 'b'].includes(a)",
            Err("method arguments must be literals"),
        ),
        ("a.includes(['a', 'b'])", Ok(())),
        ("xs.join(', ')", Ok(())),
        ("Object.keys(o)", Ok(())),
        ("Object.entries(o)", Ok(())),
        ("Array.from({ length: 3 })", Ok(())),
        // rejected: deliberate absences
        ("fmt(a)", Err("call")),
        ("fmt", Err("identifier kind")),
        ("new Date()", Err("opaque")),
        ("/x/.test(a)", Err("call")),
        ("a ** b", Err("opaque")),
        ("xs.map((i: any) => i)", Err("map outside list")),
        ("window.innerWidth", Err("identifier kind")),
        ("setN", Err("identifier kind")),
        ("a[b]", Err("computed index")),
        ("typeof a", Err("operator")),
        ("xs.join(a)", Err("join needs a string literal")),
        ("a.slice(b)", Err("method arguments must be literals")),
        ("Array.from({ length: 2000 })", Err("call")),
        ("Math.max(a, b)", Err("call")),
        ("() => a", Err("function")),
        ("a.foo()", Err("call")),
    ];
    let mut failures = Vec::new();
    for (src, want) in rows {
        let got = try_server(&slot(src)).map(|_| ());
        if got != *want {
            failures.push(format!("{src}: got {got:?}, want {want:?}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert!(rows.len() >= 20);
}
