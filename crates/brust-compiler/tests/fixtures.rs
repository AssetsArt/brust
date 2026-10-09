//! Golden-file runner. For every tests/fixtures/<case>/input.tsx, produce each
//! emit this crate supports and compare with expected.<emit>.<ext>. Set
//! BRUSTC_UPDATE=1 to rewrite expectations after an intentional change; an
//! update also deletes the expectation of the other outcome, so a case never
//! keeps both (m1a-followups F5).
//!
//! | emit | success | failure |
//! |------|---------|---------|
//! | hir  | expected.hir.json | expected.error.txt |
//! | ir   | expected.ir.json + expected.diag.txt | expected.diag.txt only |
//!
//! `ir` is the full analysis (M1b-2 passes included); child components
//! resolve from the repo root, so `parent-counter/Counter.tsx` is compiled too.
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_file};
use brust_compiler::analyze::hir::analyze_hir;
use brust_compiler::ir::render_diagnostics;
use brust_compiler::parse::{parse_tsx, run_on_compiler_thread};
use std::path::{Path, PathBuf};

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures")
}

fn updating() -> bool {
    std::env::var_os("BRUSTC_UPDATE").is_some()
}

fn check(path: &Path, actual: &str) {
    let update = updating();
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

/// The expectation of the outcome that did not happen must not exist.
fn absent(path: &Path) {
    if !path.exists() {
        return;
    }
    if updating() {
        std::fs::remove_file(path).unwrap();
    } else {
        panic!(
            "stale {}: this case no longer produces it; run with BRUSTC_UPDATE=1",
            path.display()
        );
    }
}

fn cases() -> Vec<PathBuf> {
    let mut cases: Vec<PathBuf> = std::fs::read_dir(fixtures_dir())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.join("input.tsx").exists())
        .collect();
    cases.sort();
    assert!(!cases.is_empty());
    cases
}

/// Path the case is compiled under: repo-relative, so ids and diagnostics do
/// not depend on where the checkout lives.
fn display_path(case: &Path) -> String {
    format!(
        "tests/fixtures/{}/input.tsx",
        case.file_name().unwrap().to_str().unwrap()
    )
}

#[test]
fn golden_hir() {
    for case in cases() {
        run_on_compiler_thread(|| {
            let parsed = parse_tsx(
                &display_path(&case),
                std::fs::read(case.join("input.tsx")).unwrap(),
            )
            .unwrap();
            match analyze_hir(&parsed) {
                Ok(summary) => {
                    check(
                        &case.join("expected.hir.json"),
                        &format!("{}\n", serde_json::to_string_pretty(&summary).unwrap()),
                    );
                    absent(&case.join("expected.error.txt"));
                }
                Err(e) => {
                    check(&case.join("expected.error.txt"), &format!("{e}\n"));
                    absent(&case.join("expected.hir.json"));
                }
            }
        });
    }
}

#[test]
fn golden_ir_and_diag() {
    for case in cases() {
        run_on_compiler_thread(|| {
            let file = display_path(&case);
            let opts = AnalyzeOptions {
                root: fixtures_dir().join("../.."),
                ..Default::default()
            };
            match analyze_file(&file, &opts) {
                Ok(ir) => {
                    check(
                        &case.join("expected.ir.json"),
                        &format!("{}\n", serde_json::to_string_pretty(&ir).unwrap()),
                    );
                    check(
                        &case.join("expected.diag.txt"),
                        &render_diagnostics(&ir.diagnostics, &file),
                    );
                }
                Err(d) => {
                    check(
                        &case.join("expected.diag.txt"),
                        &render_diagnostics(&[d], &file),
                    );
                    absent(&case.join("expected.ir.json"));
                }
            }
        });
    }
}

/// M1c: the three lowered artifacts of every case, and of every child module it
/// compiled (`expected.<Stem>.<ext>`); an artifact that is not produced must
/// have no expectation file.
#[test]
fn golden_lowered() {
    use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
    use brust_compiler::pipeline::compile_tree;
    for case in cases() {
        run_on_compiler_thread(|| {
            let file = display_path(&case);
            let opts = AnalyzeOptions {
                root: fixtures_dir().join("../.."),
                ..Default::default()
            };
            let Ok(tree) = compile_tree(&file, None, &opts, DEFAULT_RUNTIME_IMPORT) else {
                for ext in ["jinja", "server.ts", "client.js"] {
                    absent(&case.join(format!("expected.{ext}")));
                }
                return;
            };
            for (i, l) in tree.iter().enumerate() {
                let stem = if i == 0 {
                    String::new()
                } else {
                    let src = l.ir.source.rsplit('/').next().unwrap_or(&l.ir.source);
                    let stem = src.split('.').next().unwrap_or(src);
                    // A component local to a module: `<stem>-<Name>`.
                    match l.ir.id.split_once('_') {
                        Some((lead, _))
                            if !l.ir.source.ends_with(&format!("{stem}.tsx"))
                                || lead != lower_first(stem) =>
                        {
                            format!("{stem}-{}.", upper_first(lead))
                        }
                        _ => format!("{stem}."),
                    }
                };
                let a = &l.artifacts;
                for (ext, text) in [
                    ("jinja", Some(&a.jinja)),
                    ("server.ts", a.server_ts.as_ref()),
                    ("client.js", a.client_js.as_ref()),
                ] {
                    let path = case.join(format!("expected.{stem}{ext}"));
                    match text {
                        Some(t) => check(&path, t),
                        None => absent(&path),
                    }
                }
            }
        });
    }
}

fn lower_first(s: &str) -> String {
    let mut c = s.chars();
    c.next()
        .map(|f| f.to_ascii_lowercase().to_string() + c.as_str())
        .unwrap_or_default()
}

fn upper_first(s: &str) -> String {
    let mut c = s.chars();
    c.next()
        .map(|f| f.to_ascii_uppercase().to_string() + c.as_str())
        .unwrap_or_default()
}
