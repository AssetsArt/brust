//! Shared by the lowering tests.
#![allow(dead_code)]
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::lower::{Artifacts, DEFAULT_RUNTIME_IMPORT};
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

/// L20: the class map of every `*.module.css` in a fixture dir, keyed like the build keys them (a path relative to the
/// repo root): each `.name` selector maps to `name_fx`, a stand-in for the bundler's hashed name.
pub fn css_modules(
    case: &std::path::Path,
) -> std::collections::HashMap<String, std::collections::HashMap<String, String>> {
    let name = case.file_name().unwrap().to_str().unwrap();
    let mut out = std::collections::HashMap::new();
    let Ok(rd) = std::fs::read_dir(case) else {
        return out;
    };
    for e in rd.flatten() {
        let f = e.file_name().to_string_lossy().into_owned();
        if !f.ends_with(".module.css") {
            continue;
        }
        let text = std::fs::read_to_string(e.path()).unwrap();
        let mut map = std::collections::HashMap::new();
        for part in text.split('.').skip(1) {
            let ident: String = part
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
                .collect();
            if !ident.is_empty() {
                map.insert(ident.clone(), format!("{ident}_fx"));
            }
        }
        out.insert(format!("tests/fixtures/{name}/{f}"), map);
    }
    out
}

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
        let css_modules = css_modules(&case);
        let tree = run_on_compiler_thread(move || {
            compile_tree(
                &file,
                None,
                &AnalyzeOptions {
                    root: repo(),
                    css_modules,
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
