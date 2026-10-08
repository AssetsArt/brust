use brust_compiler::analyze::hir::{HirError, analyze_hir};
use brust_compiler::parse::parse_tsx;

fn parsed(name: &str) -> brust_compiler::parse::Parsed {
    let path = format!("{}/../../tests/fixtures/{name}/input.tsx", env!("CARGO_MANIFEST_DIR"));
    parse_tsx(&path, std::fs::read(&path).unwrap()).unwrap()
}

#[test]
fn theme_toggle_scopes() {
    let s = analyze_hir(&parsed("theme-toggle")).unwrap();
    assert_eq!(s.function, "ThemeToggle");
    assert_eq!(s.params, 1);
    // From the spike: the effect scope depends reactively on `mode`; the JSX scope on
    // `themeLabel` and `label`; the handler scope has no deps.
    let by_deps: Vec<Vec<String>> = s
        .scopes
        .iter()
        .map(|sc| sc.deps.iter().map(|d| d.name.clone()).collect())
        .collect();
    assert!(by_deps.contains(&vec!["mode".to_string()]), "{by_deps:?}");
    assert!(
        by_deps
            .iter()
            .any(|d| d.contains(&"themeLabel".to_string()) && d.contains(&"label".to_string())),
        "{by_deps:?}"
    );
    assert!(
        s.scopes.iter().all(|sc| sc.deps.iter().all(|d| d.reactive)),
        "all deps here are reactive"
    );
}

#[test]
fn static_component_has_no_reactive_scopes_but_succeeds() {
    let s = analyze_hir(&parsed("static-text")).unwrap();
    assert_eq!(s.function, "Hello");
    assert!(
        s.scopes.iter().all(|sc| sc.deps.iter().all(|d| d.name == "name")),
        "{:?}",
        s.scopes
    );
}

#[test]
fn arrow_default_export_is_reported_not_panicked() {
    let err = analyze_hir(&parsed("arrow-default")).unwrap_err();
    assert!(matches!(err, HirError::NoDefaultExportFunction), "{err:?}");
}
