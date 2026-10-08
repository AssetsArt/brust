//! Golden-file runner. For every tests/fixtures/<case>/input.tsx, produce each
//! emit this crate supports and compare with expected.<emit>.<ext>. Set
//! BRUSTC_UPDATE=1 to rewrite expectations after an intentional change.
use std::path::{Path, PathBuf};

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures")
}

fn check(path: &Path, actual: &str) {
    let update = std::env::var_os("BRUSTC_UPDATE").is_some();
    match std::fs::read_to_string(path) {
        Ok(expected) if expected == actual => {}
        Ok(expected) if !update => panic!(
            "mismatch in {}\n--- expected\n{expected}\n--- actual\n{actual}",
            path.display()
        ),
        _ if update => std::fs::write(path, actual).unwrap(),
        Err(e) => panic!(
            "missing {} ({e}); run with BRUSTC_UPDATE=1 to create it",
            path.display()
        ),
        Ok(_) => unreachable!(),
    }
}

#[test]
fn golden_hir() {
    let mut cases: Vec<PathBuf> = std::fs::read_dir(fixtures_dir())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.join("input.tsx").exists())
        .collect();
    cases.sort();
    assert!(!cases.is_empty());
    for case in cases {
        let input = case.join("input.tsx");
        let parsed = brust_compiler::parse::parse_tsx(
            input.to_str().unwrap(),
            std::fs::read(&input).unwrap(),
        )
        .unwrap();
        match brust_compiler::analyze::hir::analyze_hir(&parsed) {
            Ok(summary) => check(
                &case.join("expected.hir.json"),
                &format!("{}\n", serde_json::to_string_pretty(&summary).unwrap()),
            ),
            Err(e) => check(&case.join("expected.error.txt"), &format!("{e}\n")),
        }
    }
}
