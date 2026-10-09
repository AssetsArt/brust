//! Shared by the lowering tests.
#![allow(dead_code)]
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::lower::{Artifacts, DEFAULT_RUNTIME_IMPORT};
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

pub fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Lowers `src` as a module next to the parent-counter fixture.
pub fn lower(src: &str) -> Artifacts {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        compile_tree(
            "tests/fixtures/parent-counter/T.tsx",
            Some(s.into_bytes()),
            &AnalyzeOptions {
                root: repo(),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap()
        .remove(0)
        .artifacts
    })
}

/// Every fixture case's artifacts (root and children).
pub fn fixture_artifacts() -> Vec<(String, Artifacts)> {
    let mut out = Vec::new();
    let dir = repo().join("tests/fixtures");
    let mut cases: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.join("input.tsx").exists())
        .collect();
    cases.sort();
    for case in cases {
        let name = case.file_name().unwrap().to_str().unwrap().to_string();
        let file = format!("tests/fixtures/{name}/input.tsx");
        let tree = run_on_compiler_thread(move || {
            compile_tree(
                &file,
                None,
                &AnalyzeOptions {
                    root: repo(),
                    ..Default::default()
                },
                DEFAULT_RUNTIME_IMPORT,
            )
            .map(|t| {
                t.into_iter()
                    .map(|l| (l.ir.id.clone(), l.artifacts))
                    .collect::<Vec<_>>()
            })
        });
        if let Ok(t) = tree {
            out.extend(t.into_iter().map(|(id, a)| (format!("{name}/{id}"), a)));
        }
    }
    out
}

pub fn bun() -> Option<&'static str> {
    std::process::Command::new("bun")
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|_| "bun")
}
