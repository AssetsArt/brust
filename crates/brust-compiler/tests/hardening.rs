//! m1a-followups F1/F2: input that parses must never abort the process, and the
//! AST accessor must not hand out borrows that outlive `Parsed`.
use brust_compiler::analyze::hir::analyze_hir;
use brust_compiler::parse::{parse_tsx, run_on_compiler_thread};

fn deep_jsx(n: usize) -> Vec<u8> {
    let mut s = String::from("export default function Deep() { return ");
    for _ in 0..n {
        s.push_str("<div>");
    }
    s.push('x');
    for _ in 0..n {
        s.push_str("</div>");
    }
    s.push_str(" }\n");
    s.into_bytes()
}

fn long_sum(n: usize) -> Vec<u8> {
    let mut s = String::from("export default function Sum({ a }: any) { return <p>{a");
    for _ in 1..n {
        s.push_str("+a");
    }
    s.push_str("}</p> }\n");
    s.into_bytes()
}

/// Parse + HIR on the compiler thread; either outcome is fine, an abort is not.
fn analyze(path: &'static str, src: Vec<u8>) -> Result<String, String> {
    run_on_compiler_thread(move || {
        let parsed = parse_tsx(path, src).map_err(|e| e.to_string())?;
        analyze_hir(&parsed)
            .map(|s| s.function)
            .map_err(|e| e.to_string())
    })
}

#[test]
fn six_thousand_deep_jsx_does_not_abort() {
    match analyze("deep.tsx", deep_jsx(6000)) {
        Ok(name) => assert_eq!(name, "Deep"),
        Err(msg) => assert!(!msg.is_empty()),
    }
}

#[test]
fn six_thousand_term_sum_does_not_abort() {
    match analyze("sum.tsx", long_sum(6000)) {
        Ok(name) => assert_eq!(name, "Sum"),
        Err(msg) => assert!(!msg.is_empty()),
    }
}

#[test]
fn compiler_thread_returns_the_closure_value_and_borrows_the_caller() {
    let src = b"export default function A() { return <p/> }".to_vec();
    let path = String::from("a.tsx");
    let name = run_on_compiler_thread(|| {
        parse_tsx(&path, src.clone())
            .unwrap()
            .default_export_function_name()
    });
    assert_eq!(name.as_deref(), Some("A"));
}

#[test]
fn with_ast_borrow_does_not_outlive_parsed() {
    run_on_compiler_thread(|| {
        let parsed = parse_tsx(
            "a.tsx",
            b"export default function A() { return <p/> }".to_vec(),
        )
        .unwrap();
        let n = parsed.with_ast(|ast| ast.symbols.len());
        assert!(n > 0);
    });
}
