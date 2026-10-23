//! R34.96 PR 2b: a fed child fused into its parent's job. The analysis writes `ir.fused`; the parent is
//! lowered and its job module RUN with bun: it calls the child's job with the bound inputs, and the
//! template reads the child's slots from the parent's output under the renamed keys (root, inside a
//! caller's instance dict, folded by the build), with `Undefined` left out and `null` kept.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::{ComponentIR, FusedInput};
use brust_compiler::lower::{DEFAULT_RUNTIME_IMPORT, LowerCtx, lower};
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const LINK: &str = r##"const cx = (...a: any[]) => a.filter((x) => x).join(' ')
export function Link({ className, size = 'icon', isActive }: any) {
  return <a href="#" data-size={size} className={cx('link', isActive === null ? 'null' : isActive ? 'on' : 'off', size, className)}>go</a>
}
"##;

const NEXT: &str = r#"import { Link } from './link'
const cx = (...a: any[]) => a.filter((x) => x).join(' ')
export default function Next({ className, active }: any) {
  return <nav><Link className={cx('next', className)} size="default" isActive={active} /></nav>
}
"#;

/// Next without `isActive`: the analysis binds that root `Undefined`.
const NEXT_BARE: &str = r#"import { Link } from './link'
const cx = (...a: any[]) => a.filter((x) => x).join(' ')
export default function Next({ className }: any) {
  return <nav><Link className={cx('next', className)} size="default" /></nav>
}
"#;

/// Next passing an explicit `null`: a literal that stays `null`.
const NEXT_NULL: &str = r#"import { Link } from './link'
const cx = (...a: any[]) => a.filter((x) => x).join(' ')
export default function Next({ className }: any) {
  return <nav><Link className={cx('next', className)} size="default" isActive={null} /></nav>
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
            icons_pending: false,
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

/// Compiles `next` (with Link) as the analysis writes it: Link fused into Next's job.
fn tree_of(next_src: &str) -> Tree {
    let dir = tmp();
    std::fs::write(dir.join("link.tsx"), LINK).unwrap();
    std::fs::write(dir.join("next.tsx"), next_src).unwrap();
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
        next.fused.len(),
        1,
        "Link fused into Next: {:?} {:?} {:?}",
        next.tier,
        next.jobs,
        next.instances
    );
    assert!(
        next.instances.is_empty(),
        "a fused child has no record: {:?}",
        next.instances
    );
    let link_ts = lowered(&link, &by_id).server_ts.expect("Link's job module");
    Tree {
        dir,
        by_id,
        next,
        link,
        link_ts,
    }
}

fn tree() -> Tree {
    tree_of(NEXT)
}

/// The output of Next's job that carries Link's `_s1` (its class).
fn link_class(t: &Tree, out: &serde_json::Value) -> String {
    let key = &t.next.fused[0].outputs["_s1"];
    out[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} in {out}"))
        .to_string()
}

#[test]
fn the_parent_job_runs_the_child_job_and_the_template_reads_its_renamed_slots() {
    let t = tree();
    let art = lowered(&t.next, &t.by_id);
    let ts = art.server_ts.unwrap();
    assert!(
        ts.contains(&format!("from \"brust-job:{}\"", t.link.id)),
        "{ts}"
    );
    // F187: every fused output lives under the reserved `_fj_` prefix, which brust-core drops from loader data.
    for f in &t.next.fused {
        for name in f.outputs.values() {
            assert!(name.starts_with("_fj_"), "{name}");
        }
    }
    let out = run_job(
        &t.dir,
        &ts,
        &t.link.id,
        &t.link_ts,
        "{ className: 'x', active: true }",
    );
    assert_eq!(
        link_class(&t, &out),
        "link on default next x",
        "{out}\n{ts}"
    );
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
    // isActive not passed: the key is left out, so Link sees it absent (A3).
    let t = tree_of(NEXT_BARE);
    assert_eq!(t.next.fused[0].inputs["isActive"], FusedInput::Undefined);
    let ts = lowered(&t.next, &t.by_id).server_ts.unwrap();
    assert!(!ts.contains("\"isActive\""), "{ts}");
    let out = run_job(&t.dir, &ts, &t.link.id, &t.link_ts, "{ className: 'x' }");
    assert_eq!(link_class(&t, &out), "link off default next x", "{out}");
    // An explicit null stays null (React keeps `null`).
    let t = tree_of(NEXT_NULL);
    assert_eq!(
        t.next.fused[0].inputs["isActive"],
        FusedInput::Literal {
            value: serde_json::Value::Null
        }
    );
    let ts = lowered(&t.next, &t.by_id).server_ts.unwrap();
    let out = run_job(&t.dir, &ts, &t.link.id, &t.link_ts, "{ className: 'x' }");
    assert_eq!(link_class(&t, &out), "link null default next x", "{out}");
}

#[test]
fn a_prop_path_and_a_hostile_key_print_as_data_never_code() {
    let t = tree();
    let mut next = t.next.clone();
    next.fused[0].inputs.insert(
        "isActive".into(),
        FusedInput::Prop {
            path: "cfg.flags[0].on".into(),
        },
    );
    let ts = lowered(&next, &t.by_id).server_ts.unwrap();
    assert!(ts.contains(r#"props["cfg"]["flags"][0]["on"]"#), "{ts}");
    next.fused[0].inputs.insert(
        "isActive".into(),
        FusedInput::Prop {
            path: "a\"]);process.exit(1);//".into(),
        },
    );
    let ts = lowered(&next, &t.by_id).server_ts.unwrap();
    // The keys are data: the props object that has them feeds the value through.
    let props = r#"{ className: 'x', 'a"]);process': { 'exit(1);//': true } }"#;
    let out = run_job(&t.dir, &ts, &t.link.id, &t.link_ts, props);
    assert_eq!(link_class(&t, &out), "link on default next x", "{out}");
}

const APP: &str = r#"import Next from './next'
export default function App() {
  return <main><Next className="x" active={true} /></main>
}
"#;

/// Next inlined in a caller, compiled as one tree: App's IR and every IR by id.
fn app_tree(t: &Tree) -> (ComponentIR, HashMap<String, ComponentIR>) {
    std::fs::write(t.dir.join("App.tsx"), APP).unwrap();
    let by_id = compile(&t.dir, "App.tsx");
    let app = by_id
        .values()
        .find(|c| c.source.ends_with("App.tsx"))
        .unwrap()
        .clone();
    assert_eq!(
        by_id[&t.next.id].fused.len(),
        1,
        "Link fused in Next under App too"
    );
    (app, by_id)
}

/// Next's job output for App's instance (`className: "x", active: true`).
fn next_out(t: &Tree, by_id: &HashMap<String, ComponentIR>) -> serde_json::Value {
    let ts = lowered(&by_id[&t.next.id], by_id).server_ts.unwrap();
    run_job(
        &t.dir,
        &ts,
        &t.link.id,
        &t.link_ts,
        "{ className: 'x', active: true }",
    )
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
    let out = next_out(&t, &by_id);
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
    assert!(html.contains("<nav>"), "{html}");
}

#[test]
fn a_folded_parent_prints_the_fused_slots_as_literals() {
    let t = tree();
    let (mut app, by_id) = app_tree(&t);
    let out = next_out(&t, &by_id);
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
    let path = t.dir.join("next.tsx").to_string_lossy().to_string();
    let ok = instance_job(&next, &path, &opts);
    next.fused[0].eval_refused = Some("its job reads `Date`, which differs between runs".into());
    let refused = instance_job(&next, &path, &opts);
    assert!(ok.is_ok(), "{ok:?}");
    let why = refused.unwrap_err();
    assert!(why.contains(&t.link.id) && why.contains("`Date`"), "{why}");
}

/// Next reads `active` through its own default (`active = true`), as shadcn's ButtonGroupSeparator does.
const NEXT_DEFAULT: &str = r#"import { Link } from './link'
const cx = (...a: any[]) => a.filter((x) => x).join(' ')
export default function Next({ className, active = true }: any) {
  return <nav><Link className={cx('next', className)} size="default" isActive={active} /></nav>
}
"#;

#[test]
fn a_prop_the_parent_defaults_reaches_the_child_with_that_default() {
    let t = tree_of(NEXT_DEFAULT);
    let ts = lowered(&t.next, &t.by_id).server_ts.unwrap();
    // Absent: the parent's default, as the local the JSX read.
    let out = run_job(&t.dir, &ts, &t.link.id, &t.link_ts, "{ className: 'x' }");
    assert_eq!(
        link_class(&t, &out),
        "link on default next x",
        "{out}\n{ts}"
    );
    // An explicit null is not undefined: no default, as in destructuring.
    let out = run_job(
        &t.dir,
        &ts,
        &t.link.id,
        &t.link_ts,
        "{ className: 'x', active: null }",
    );
    assert_eq!(link_class(&t, &out), "link null default next x", "{out}");
    let out = run_job(
        &t.dir,
        &ts,
        &t.link.id,
        &t.link_ts,
        "{ className: 'x', active: false }",
    );
    assert_eq!(link_class(&t, &out), "link off default next x", "{out}");
}

/// Next's default reads another of its props: the job must destructure that prop too.
const NEXT_PROP_DEFAULT: &str = r#"import { Link } from './link'
const cx = (...a: any[]) => a.filter((x) => x).join(' ')
export default function Next({ className, active = className === 'x' }: any) {
  return <nav><Link className={cx('next', className)} size="default" isActive={active} /></nav>
}
"#;

#[test]
fn a_default_that_reads_another_prop_is_computed_in_the_job() {
    let t = tree_of(NEXT_PROP_DEFAULT);
    let ts = lowered(&t.next, &t.by_id).server_ts.unwrap();
    let out = run_job(&t.dir, &ts, &t.link.id, &t.link_ts, "{ className: 'x' }");
    assert_eq!(
        link_class(&t, &out),
        "link on default next x",
        "{out}\n{ts}"
    );
    let out = run_job(&t.dir, &ts, &t.link.id, &t.link_ts, "{ className: 'y' }");
    assert_eq!(link_class(&t, &out), "link off default next y", "{out}");
}

/// A call as a default makes the parent React: it keeps no fused child (`tier.rs`).
#[test]
fn a_react_parent_keeps_no_fused_child() {
    let dir = tmp();
    std::fs::write(dir.join("link.tsx"), LINK).unwrap();
    std::fs::write(
        dir.join("next.tsx"),
        NEXT.replace("active }: any", "active = Math.max(1, 2) > 1 }: any"),
    )
    .unwrap();
    let by_id = compile(&dir, "next.tsx");
    let next = by_id
        .values()
        .find(|c| c.source.ends_with("next.tsx"))
        .unwrap();
    assert!(
        matches!(next.tier, brust_compiler::ir::Tier::React { .. }),
        "{:?}",
        next.tier
    );
    assert!(next.fused.is_empty(), "{:?}", next.fused);
}

/// Review r1 (Afrojack): the parent's own `children` is markup, never a job input, so a child fed it
/// is not fused (the job would read it as absent); without the guard it was `Prop { path: "children" }`.
#[test]
fn a_child_fed_the_parents_children_is_not_fused() {
    let dir = tmp();
    std::fs::write(dir.join("link.tsx"), LINK).unwrap();
    std::fs::write(
        dir.join("next.tsx"),
        NEXT.replace("active }: any", "children }: any")
            .replace("isActive={active}", "isActive={children}"),
    )
    .unwrap();
    let by_id = compile(&dir, "next.tsx");
    let next = by_id
        .values()
        .find(|c| c.source.ends_with("next.tsx"))
        .unwrap();
    assert!(next.fused.is_empty(), "{:?}", next.fused);
}
