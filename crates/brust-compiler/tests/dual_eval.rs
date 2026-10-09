//! M1c Task 7: dual evaluation (spec §6.3). For every fixture with sample
//! props: run the precompute job under bun, render the template with
//! minijinja (brust-jinja's environment) from props + job output, then let
//! `tests/harness/eval.ts` instantiate every behavior on the rendered HTML
//! and compare each directive's initial client value with what the server
//! painted. Any disagreement is a compiler bug.
//!
//! This gate fails closed: missing `bun` is a failure, a fixture without
//! sample props must be pinned in `NO_SAMPLES`, a sampled fixture that checks
//! nothing must be pinned in `NO_DIRECTIVES`. The only skip is
//! `BRUST_DUAL_EVAL_SKIP=1` (local use only, never set in CI).
mod lower_common;
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::JobKind;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use lower_common::{bun, repo};
use std::path::{Path, PathBuf};
use std::process::Command;

fn harness() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/harness")
}

/// Fixtures that intentionally carry no `sample-props*.json`: a new fixture
/// without samples must be added here deliberately.
const NO_SAMPLES: &[&str] = &[
    "arrow-default",
    "client-only",
    "fragment-root",
    "import-cycle",
    "jsx-shapes",
    "lazy-import",
    "missing-key",
    "react-child",
    "react-hook",
    "server-leak",
];

/// Sampled fixtures with no client directives to compare (every other sampled
/// fixture must contribute at least one check).
const NO_DIRECTIVES: &[&str] = &[
    "static-text",
    "cached-card",
    "outlet-layout",
    "react-child-row",
];

fn fixture_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(repo().join("tests/fixtures"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.join("input.tsx").exists())
        .collect();
    dirs.sort();
    dirs
}

/// (case dir, sample props files)
fn cases() -> Vec<(PathBuf, Vec<PathBuf>)> {
    let mut out = Vec::new();
    for d in fixture_dirs() {
        let mut samples: Vec<PathBuf> = std::fs::read_dir(&d)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| {
                let n = p.file_name().unwrap().to_string_lossy();
                n.starts_with("sample-props") && n.ends_with(".json")
            })
            .collect();
        samples.sort();
        if !samples.is_empty() {
            out.push((d, samples));
        }
    }
    out
}

fn run(cmd: &mut Command) -> String {
    let out = cmd.output().unwrap();
    assert!(
        out.status.success(),
        "{:?} failed:\n{}{}",
        cmd,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// Compiles `case`, writes its job(s) and chunk(s) (and the module stubs the
/// fixture ships) into `dir`; returns (root template, root job file, island outputs).
fn build(case: &Path, dir: &Path) -> (String, Option<PathBuf>, Vec<String>) {
    let name = case.file_name().unwrap().to_str().unwrap().to_string();
    let rt = harness().join("rt.ts").to_string_lossy().into_owned();
    let tree = run_on_compiler_thread(move || {
        compile_tree(
            &format!("tests/fixtures/{name}/input.tsx"),
            None,
            &AnalyzeOptions {
                root: repo(),
                ..Default::default()
            },
            &rt,
        )
        .unwrap_or_else(|d| panic!("{name}: {}", d.message))
        .into_iter()
        .map(|l| {
            let ssr: Vec<String> =
                l.ir.jobs
                    .iter()
                    .filter(|j| matches!(j.kind, JobKind::Ssr { .. }))
                    .flat_map(|j| j.outputs.clone())
                    .collect();
            (l.ir.id.clone(), l.artifacts, ssr)
        })
        .collect::<Vec<_>>()
    });
    std::fs::create_dir_all(dir).unwrap();
    for e in std::fs::read_dir(case).unwrap() {
        let p = e.unwrap().path();
        let n = p.file_name().unwrap().to_string_lossy().into_owned();
        // The modules the fixture imports (`money.ts`), not its expectations.
        if n.ends_with(".ts") && !n.ends_with(".tsx") && !n.starts_with("expected.") {
            std::fs::copy(&p, dir.join(&n)).unwrap();
        }
    }
    let mut root = None;
    for (i, (id, a, ssr)) in tree.into_iter().enumerate() {
        let job = a.server_ts.as_ref().map(|t| {
            let p = dir.join(format!("{id}.server.ts"));
            std::fs::write(&p, t).unwrap();
            p
        });
        if let Some(c) = &a.client_js {
            std::fs::write(dir.join(format!("{id}.client.js")), c).unwrap();
        }
        if i == 0 {
            root = Some((a.jinja, job, ssr));
        }
    }
    root.unwrap()
}

#[test]
fn server_paint_equals_client_initial_values() {
    let Some(bun) = bun() else {
        if std::env::var("BRUST_DUAL_EVAL_SKIP").as_deref() == Ok("1") {
            eprintln!("warning: bun not on PATH; BRUST_DUAL_EVAL_SKIP=1, skipping dual evaluation");
            return;
        }
        panic!(
            "bun not on PATH; dual evaluation cannot run (set BRUST_DUAL_EVAL_SKIP=1 to skip locally)"
        );
    };
    let eval = harness().join("eval.ts");
    let base = std::env::temp_dir().join(format!("brustc-dual-{}", std::process::id()));
    let mut total = 0;
    let mut cases_run = Vec::new();
    let mut per_fixture: std::collections::BTreeMap<String, u64> = Default::default();
    let all = cases();
    let mut skipped: Vec<String> = fixture_dirs()
        .iter()
        .filter(|d| !all.iter().any(|(c, _)| c == *d))
        .map(|d| d.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    skipped.sort();
    let mut pinned: Vec<String> = NO_SAMPLES.iter().map(|s| s.to_string()).collect();
    pinned.sort();
    assert_eq!(
        skipped, pinned,
        "fixtures without sample-props*.json must be pinned in NO_SAMPLES (and only those)"
    );
    for (case, samples) in all {
        let name = case.file_name().unwrap().to_string_lossy().into_owned();
        let dir = base.join(&name);
        let (jinja, job, ssr) = build(&case, &dir);
        for sample in samples {
            let props: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&sample).unwrap()).unwrap();
            let slots: serde_json::Value = match &job {
                Some(j) => serde_json::from_str(&run(Command::new(bun)
                    .arg(&eval)
                    .arg("slots")
                    .arg(j)
                    .arg(&sample)))
                .unwrap(),
                None => serde_json::json!({}),
            };
            let mut ctx = props.as_object().cloned().unwrap_or_default();
            ctx.insert("_props".into(), props.clone());
            for (k, v) in slots.as_object().cloned().unwrap_or_default() {
                ctx.insert(k, v);
            }
            for o in &ssr {
                ctx.insert(o.clone(), serde_json::json!("<i data-ssr></i>"));
            }
            let mut env = minijinja::Environment::new();
            brust_jinja::register(&mut env);
            let html = env
                .render_str(&jinja, minijinja::Value::from_serialize(&ctx))
                .unwrap_or_else(|e| panic!("{name}: template does not render: {e:#}\n{jinja}"));
            let page = dir.join(format!(
                "{}.html",
                sample.file_stem().unwrap().to_string_lossy()
            ));
            std::fs::write(&page, &html).unwrap();
            let report: serde_json::Value = serde_json::from_str(&run(Command::new(bun)
                .arg(&eval)
                .arg("check")
                .arg(&dir)
                .arg(&page)))
            .unwrap();
            let mismatches = report["mismatches"].as_array().unwrap();
            assert!(
                mismatches.is_empty(),
                "{name} ({}): server paint and client disagree:\n{}\n{html}",
                sample.display(),
                mismatches
                    .iter()
                    .map(|m| m.as_str().unwrap_or_default())
                    .collect::<Vec<_>>()
                    .join("\n")
            );
            let checked = report["checked"].as_u64().unwrap();
            total += checked;
            *per_fixture.entry(name.clone()).or_default() += checked;
            cases_run.push(format!("{name}:{checked}"));
        }
    }
    eprintln!("dual evaluation: {}", cases_run.join(" "));
    for (name, n) in &per_fixture {
        if NO_DIRECTIVES.contains(&name.as_str()) {
            assert_eq!(
                *n, 0,
                "{name} is pinned in NO_DIRECTIVES but now has {n} checks: unpin it"
            );
        } else {
            assert!(
                *n >= 1,
                "{name} contributed no checks: fix the fixture or pin it in NO_DIRECTIVES"
            );
        }
    }
    for name in NO_DIRECTIVES {
        assert!(
            per_fixture.contains_key(*name),
            "NO_DIRECTIVES names a fixture that was not run: {name}"
        );
    }
    // Every stateful fixture contributes checks.
    assert!(
        total >= 15,
        "only {total} directives checked: {cases_run:?}"
    );
}
