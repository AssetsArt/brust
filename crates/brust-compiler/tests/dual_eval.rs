//! M1c Task 7: dual evaluation (spec §6.3). For every fixture with sample
//! props: run the precompute job under bun, render the template with
//! minijinja (brust-jinja's environment) from props + job output, then let
//! `tests/harness/eval.ts` instantiate every behavior on the rendered HTML
//! and compare each directive's initial client value with what the server
//! painted. Any disagreement is a compiler bug.
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

/// (case dir, sample props files)
fn cases() -> Vec<(PathBuf, Vec<PathBuf>)> {
    let mut out = Vec::new();
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(repo().join("tests/fixtures"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.join("input.tsx").exists())
        .collect();
    dirs.sort();
    for d in dirs {
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
        eprintln!("warning: bun not on PATH; skipping dual evaluation");
        return;
    };
    let eval = harness().join("eval.ts");
    let base = std::env::temp_dir().join(format!("brustc-dual-{}", std::process::id()));
    let mut total = 0;
    let mut cases_run = Vec::new();
    for (case, samples) in cases() {
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
            cases_run.push(format!("{name}:{checked}"));
        }
    }
    eprintln!("dual evaluation: {}", cases_run.join(" "));
    // Every stateful fixture contributes checks.
    assert!(
        total >= 15,
        "only {total} directives checked: {cases_run:?}"
    );
}
