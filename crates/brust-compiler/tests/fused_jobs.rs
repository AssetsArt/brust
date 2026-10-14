//! R34.96 PR 2b (lowering half): a fed child fused into its parent's job. The analysis half writes
//! `ir.fused`; here it is written by hand on a real compiled parent (the record of the child removed,
//! the renamed outputs added to the parent's job), lowered, and the job module RUN with bun: the parent's
//! job calls the child's job with the bound inputs, and the template reads the child's slots from the
//! parent's output under the renamed keys.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::{ComponentIR, FusedInput, FusedInstance, Node};
use brust_compiler::lower::{DEFAULT_RUNTIME_IMPORT, LowerCtx, lower};
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

const LINK: &str = r##"const cx = (...a: any[]) => a.filter((x) => x).join(' ')
export function Link({ className, size = 'icon', isActive }: any) {
  return <a href="#" data-size={size} className={cx('link', isActive === null ? 'null' : isActive ? 'on' : 'off', size, className)}>go</a>
}
"##;

const NEXT: &str = r#"import { Link } from './link'
const cx = (...a: any[]) => a.filter((x) => x).join(' ')
export default function Next({ className, active }: any) {
  return <nav className={cx('next', className)}><Link className={className} size="default" isActive={active} /></nav>
}
"#;

fn tmp() -> PathBuf {
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let root = std::env::temp_dir().join(format!("brust-fused-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

/// Every component of the tree under `entry`, by id.
fn compile(root: &Path, entry: &str) -> HashMap<String, ComponentIR> {
    let opts = AnalyzeOptions {
        root: root.to_path_buf(),
        ..Default::default()
    };
    let entry = entry.to_string();
    run_on_compiler_thread(move || {
        compile_tree(&entry, None, &opts, DEFAULT_RUNTIME_IMPORT)
            .unwrap()
            .into_iter()
            .map(|l| (l.ir.id.clone(), (*l.ir).clone()))
            .collect()
    })
}

fn call_loc(n: &Node, child: &str) -> Option<u32> {
    match n {
        Node::Component { loc, name, .. } if name == child => Some(*loc),
        Node::Element { children, .. } | Node::Fragment(children) => {
            children.iter().find_map(|c| call_loc(c, child))
        }
        Node::Component { children, .. } => children.iter().find_map(|c| call_loc(c, child)),
        _ => None,
    }
}

/// `next`'s IR as the analysis half would write it: Link fused (className = Next's own `_s1`, the
/// `cn(...)` of its `<nav>`, standing in for a `cn(...)` at the call site, which today makes Next React;
/// size a literal; isActive as given), its record gone, its slots renamed into Next's job.
fn fuse(next: &mut ComponentIR, link: &ComponentIR, is_active: FusedInput) {
    let loc = call_loc(&next.template, "Link").expect("Link call site");
    let outputs: BTreeMap<String, String> = link.jobs[0]
        .outputs
        .iter()
        .map(|s| (s.clone(), format!("_fLink_1_{s}")))
        .collect();
    let own = next.jobs[0]
        .outputs
        .first()
        .cloned()
        .expect("Next's own slot");
    let mut inputs = BTreeMap::new();
    for root in &link.jobs[0].inputs {
        let v = match root.as_str() {
            "className" => FusedInput::Slot { name: own.clone() },
            "size" => FusedInput::Literal {
                value: serde_json::json!("default"),
            },
            "isActive" => is_active.clone(),
            other => panic!("unexpected Link job input {other}"),
        };
        inputs.insert(root.clone(), v);
    }
    if matches!(is_active, FusedInput::Prop { .. })
        && !next.jobs[0].inputs.contains(&"active".into())
    {
        next.jobs[0].inputs.push("active".into());
    }
    next.jobs[0].outputs.extend(outputs.values().cloned());
    next.instances.retain(|r| r.child_id != link.id);
    next.fused = vec![FusedInstance {
        child_id: link.id.clone(),
        loc,
        ordinal: 1,
        inputs,
        outputs,
        eval_refused: None,
        stubs: vec![],
    }];
}

fn lowered(
    next: &ComponentIR,
    by_id: &HashMap<String, ComponentIR>,
) -> brust_compiler::lower::Artifacts {
    let (next, by_id) = (next.clone(), by_id.clone());
    run_on_compiler_thread(move || {
        let resolve = |id: &str| by_id.get(id);
        let linked = |_: &str| false;
        let ctx = LowerCtx {
            resolve: &resolve,
            runtime_import: DEFAULT_RUNTIME_IMPORT,
            linked: &linked,
        };
        lower(&next, &ctx).unwrap()
    })
}

/// Runs `next`'s job module (its `brust-job:` import pointed at the child's module) with `props`.
fn run_job(
    dir: &Path,
    next_ts: &str,
    link_id: &str,
    link_ts: &str,
    props: &str,
) -> serde_json::Value {
    std::fs::write(dir.join("link.job.ts"), link_ts).unwrap();
    let next_ts = next_ts.replace(&format!("\"brust-job:{link_id}\""), "\"./link.job.ts\"");
    std::fs::write(dir.join("next.job.ts"), next_ts).unwrap();
    std::fs::write(
        dir.join("run.ts"),
        format!("import {{ precompute }} from './next.job.ts'\nprocess.stdout.write(JSON.stringify(precompute({props})))\n"),
    )
    .unwrap();
    let out = std::process::Command::new("bun")
        .arg("run.ts")
        .current_dir(dir)
        .output()
        .expect("bun on PATH");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

fn render(jinja: &str, ctx: &serde_json::Value) -> String {
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    env.render_str(jinja, brust_jinja::value_of(ctx))
        .unwrap_or_else(|e| panic!("{e:#}\n{jinja}"))
}

struct Tree {
    dir: PathBuf,
    by_id: HashMap<String, ComponentIR>,
    next: ComponentIR,
    link: ComponentIR,
    link_ts: String,
}

fn tree() -> Tree {
    let dir = tmp();
    std::fs::write(dir.join("link.tsx"), LINK).unwrap();
    std::fs::write(dir.join("next.tsx"), NEXT).unwrap();
    let by_id = compile(&dir, "next.tsx");
    let next = by_id
        .values()
        .find(|c| c.source.ends_with("next.tsx"))
        .unwrap()
        .clone();
    let link = by_id
        .values()
        .find(|c| c.source.ends_with("link.tsx"))
        .unwrap()
        .clone();
    assert_eq!(
        next.instances.len(),
        1,
        "Link is Next's fed child today: {:?} {:?} {:?} | link {:?} {:?}",
        next.tier,
        next.jobs,
        next.children,
        link.tier,
        link.jobs
    );
    assert_eq!(next.jobs.len(), 1, "Next has its own precompute job");
    let link_ts = lowered(&link, &by_id).server_ts.expect("Link's job module");
    Tree {
        dir,
        by_id,
        next,
        link,
        link_ts,
    }
}

#[test]
fn the_parent_job_runs_the_child_job_and_the_template_reads_its_renamed_slots() {
    let t = tree();
    let mut next = t.next.clone();
    fuse(
        &mut next,
        &t.link,
        FusedInput::Prop {
            path: "active".into(),
        },
    );
    let art = lowered(&next, &t.by_id);
    let ts = art.server_ts.unwrap();
    assert!(
        ts.contains(&format!("from \"brust-job:{}\"", t.link.id)),
        "{ts}"
    );
    let out = run_job(
        &t.dir,
        &ts,
        &t.link.id,
        &t.link_ts,
        "{ className: 'x', active: true }",
    );
    let class = out["_fLink_1__s1"].as_str().or_else(|| {
        out.as_object()?
            .iter()
            .find(|(k, v)| {
                k.starts_with("_fLink_1_") && v.as_str().is_some_and(|s| s.starts_with("link"))
            })
            .and_then(|(_, v)| v.as_str())
    });
    assert_eq!(class, Some("link on default next x"), "{out}");
    // The page renders from the parent's output alone: no `__<link>_1` dict exists any more.
    let html = render(&art.jinja, &out);
    assert!(
        html.contains("class=\"link on default next x\""),
        "{html}\n{}",
        art.jinja
    );
    assert!(html.contains("data-size=\"default\""), "{html}");
    assert!(
        !art.jinja.contains(&format!("__{}_", t.link.id)),
        "{}",
        art.jinja
    );
}

#[test]
fn an_undefined_input_is_left_out_so_the_default_applies_and_a_null_literal_stays_null() {
    let t = tree();
    // isActive not passed: the key is left out, Link's own default/absent handling applies (A3).
    let mut next = t.next.clone();
    fuse(&mut next, &t.link, FusedInput::Undefined);
    let ts = lowered(&next, &t.by_id).server_ts.unwrap();
    assert!(!ts.contains("\"isActive\""), "{ts}");
    let out = run_job(&t.dir, &ts, &t.link.id, &t.link_ts, "{ className: 'x' }");
    assert!(out.to_string().contains("link off default next x"), "{out}");
    // An explicit null stays null (React keeps `null`).
    let mut next = t.next.clone();
    fuse(
        &mut next,
        &t.link,
        FusedInput::Literal {
            value: serde_json::Value::Null,
        },
    );
    let ts = lowered(&next, &t.by_id).server_ts.unwrap();
    let out = run_job(&t.dir, &ts, &t.link.id, &t.link_ts, "{ className: 'x' }");
    assert!(
        out.to_string().contains("link null default next x"),
        "{out}"
    );
}

#[test]
fn a_prop_path_and_a_hostile_key_print_as_data_never_code() {
    let t = tree();
    let mut next = t.next.clone();
    fuse(
        &mut next,
        &t.link,
        FusedInput::Prop {
            path: "cfg.flags[0].on".into(),
        },
    );
    let ts = lowered(&next, &t.by_id).server_ts.unwrap();
    assert!(ts.contains(r#"props["cfg"]["flags"][0]["on"]"#), "{ts}");
    let mut next = t.next.clone();
    fuse(
        &mut next,
        &t.link,
        FusedInput::Prop {
            path: "a\"]);process.exit(1);//".into(),
        },
    );
    let ts = lowered(&next, &t.by_id).server_ts.unwrap();
    // The keys are data: the props object that has them feeds the value through.
    let props = r#"{ className: 'x', 'a"]);process': { 'exit(1);//': true } }"#;
    let out = run_job(&t.dir, &ts, &t.link.id, &t.link_ts, props);
    assert!(out.to_string().contains("link on default next x"), "{out}");
}

const APP: &str = r#"import Next from './next'
export default function App() {
  return <main><Next className="x" active={true} /></main>
}
"#;

/// The caller of a fused parent: (App's IR, every IR by id with Next fused).
fn app_tree(t: &Tree) -> (ComponentIR, HashMap<String, ComponentIR>) {
    std::fs::write(t.dir.join("App.tsx"), APP).unwrap();
    // Analysis only: lowering App today stops at `nested-instance` (Link is fed inside an inlined Next),
    // which is what fusion removes.
    let opts = AnalyzeOptions {
        root: t.dir.clone(),
        ..Default::default()
    };
    let app = run_on_compiler_thread(move || {
        brust_compiler::analyze::component::analyze_file("App.tsx", &opts).unwrap()
    });
    let mut by_id = t.by_id.clone();
    fuse(
        by_id.get_mut(&t.next.id).unwrap(),
        &t.link,
        FusedInput::Prop {
            path: "active".into(),
        },
    );
    (app, by_id)
}

#[test]
fn inside_a_caller_the_fused_slots_are_read_from_the_parent_instance_dict() {
    let t = tree();
    let (app, by_id) = app_tree(&t);
    let rec = app
        .instances
        .iter()
        .find(|r| r.child_id == t.next.id)
        .unwrap_or_else(|| panic!("App feeds Next: {:?} {:?}", app.tier, app.instances));
    let next = &by_id[&t.next.id];
    let ts = lowered(next, &by_id).server_ts.unwrap();
    let out = run_job(
        &t.dir,
        &ts,
        &t.link.id,
        &t.link_ts,
        "{ className: 'x', active: true }",
    );
    let art = lowered(&app, &by_id);
    assert!(art.diagnostics.is_empty(), "{:?}", art.diagnostics);
    let html = render(
        &art.jinja,
        &serde_json::json!({ format!("__{}_{}", t.next.id, rec.k): out }),
    );
    assert!(
        html.contains("class=\"link on default next x\""),
        "{html}\n{}",
        art.jinja
    );
    assert!(html.contains("<nav class=\"next x\">"), "{html}");
}

#[test]
fn a_folded_parent_prints_the_fused_slots_as_literals() {
    let t = tree();
    let (mut app, by_id) = app_tree(&t);
    let next = &by_id[&t.next.id];
    let ts = lowered(next, &by_id).server_ts.unwrap();
    let out = run_job(
        &t.dir,
        &ts,
        &t.link.id,
        &t.link_ts,
        "{ className: 'x', active: true }",
    );
    // What the build's recompile writes (F149): the record dropped, every output a literal.
    let k = app
        .instances
        .iter()
        .find(|r| r.child_id == t.next.id)
        .unwrap()
        .k;
    app.instances.retain(|r| r.child_id != t.next.id);
    app.folded_instances = vec![brust_compiler::ir::FoldedInstance {
        child_id: t.next.id.clone(),
        k,
        values: out
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    }];
    let art = lowered(&app, &by_id);
    assert!(
        !art.jinja.contains(&format!("__{}_", t.next.id)),
        "{}",
        art.jinja
    );
    let html = render(&art.jinja, &serde_json::json!({}));
    assert!(
        html.contains("class=\"link on default next x\""),
        "{html}\n{}",
        art.jinja
    );
    assert!(html.contains("<nav class=\"next x\">"), "{html}");
}

#[test]
fn a_parent_runs_at_build_only_if_every_fused_child_may() {
    use brust_compiler::analyze::passes::build_eval::instance_job;
    let t = tree();
    let opts = AnalyzeOptions {
        root: t.dir.clone(),
        ..Default::default()
    };
    let mut next = t.next.clone();
    fuse(&mut next, &t.link, FusedInput::Undefined);
    let path = t.dir.join("next.tsx").to_string_lossy().to_string();
    let ok = instance_job(&next, &path, &opts);
    next.fused[0].eval_refused = Some("its job reads `Date`, which differs between runs".into());
    let refused = instance_job(&next, &path, &opts);
    assert!(ok.is_ok(), "{ok:?}");
    let why = refused.unwrap_err();
    assert!(why.contains(&t.link.id) && why.contains("`Date`"), "{why}");
}
