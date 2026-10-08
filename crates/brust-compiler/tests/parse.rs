use brust_compiler::parse::{ParseError, parse_tsx};

fn fixture(name: &str) -> (String, Vec<u8>) {
    let path = format!(
        "{}/../../tests/fixtures/{name}/input.tsx",
        env!("CARGO_MANIFEST_DIR")
    );
    let src = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    (path, src)
}

#[test]
fn parses_theme_toggle() {
    let (path, src) = fixture("theme-toggle");
    let parsed = parse_tsx(&path, src).expect("parse ok");
    assert!(
        parsed.symbol_count() > 10,
        "symbols: {}",
        parsed.symbol_count()
    );
    assert_eq!(parsed.import_paths(), vec!["react".to_string()]);
    assert_eq!(
        parsed.default_export_function_name().as_deref(),
        Some("ThemeToggle")
    );
}

#[test]
fn reports_syntax_error_with_position() {
    let err = parse_tsx(
        "bad.tsx",
        b"export default function X() { return <div> }".to_vec(),
    )
    .err()
    .expect("must fail");
    let ParseError {
        message,
        line,
        column,
    } = err;
    assert!(!message.is_empty());
    assert_eq!(line, 1);
    assert!(column > 0);
}

#[test]
fn two_parses_in_one_thread_do_not_interfere() {
    let (path, src) = fixture("theme-toggle");
    let a = parse_tsx(&path, src.clone()).unwrap();
    let b = parse_tsx(&path, src).unwrap();
    assert_eq!(a.symbol_count(), b.symbol_count());
    assert_eq!(
        a.default_export_function_name(),
        b.default_export_function_name()
    );
}
