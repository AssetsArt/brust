//! F142 (plan 2026-10-14-shadcn-per-instance-jobs, R34.42): a fed child instance inside a list whose
//! job inputs are the same in every row is fed once (`loops: []`, a static instance) and its slot is
//! read without the row index, whatever the list's source; shadcn's table page (TableRow/TableCell
//! over a module const) is the measured case.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::{DiagClass, InstanceRecord, Tier};
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

struct Out {
    jinja: String,
    tier: Tier,
    instances: Vec<InstanceRecord>,
    diags: Vec<(DiagClass, String)>,
}

/// Compiles `src` as `tests/fixtures/per-instance-jobs/P.tsx` (siblings resolve).
fn lower(src: &str) -> Out {
    let s = src.to_string();
    let path = "crates/brust-compiler/tests/fixtures/per-instance-jobs/P.tsx".to_string();
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            &path,
            Some(s.into_bytes()),
            &AnalyzeOptions {
                root: repo(),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        let a = &tree[0].artifacts;
        Out {
            jinja: a.jinja.clone(),
            tier: tree[0].ir.tier.clone(),
            instances: tree[0].ir.instances.clone(),
            diags: tree[0]
                .ir
                .diagnostics
                .iter()
                .chain(&a.diagnostics)
                .map(|d| (d.class, d.rule.clone()))
                .collect(),
        }
    })
}

fn fallback(o: &Out, rule: &str) -> bool {
    o.diags
        .iter()
        .any(|(c, r)| *c == DiagClass::Fallback && r == rule)
}

const STATE: &str = "import { useState } from 'react'\n";

#[test]
fn a_row_invariant_instance_over_a_module_const_is_fed_once() {
    // shadcn's table page: the row's data is children markup, the cell's props are literals.
    let o = lower(
        "import Cell from './Cell'\nconst rows = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }]\nexport default function P() { return <table><tbody>{rows.map((r) => <tr key={r.id}><Cell tone=\"x\">{r.n}</Cell><Cell>{r.id}</Cell></tr>)}</tbody></table> }",
    );
    assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
    assert!(!fallback(&o, "instance-list-path"), "{:?}", o.diags);
    assert_eq!(o.instances.len(), 2);
    assert!(
        o.instances.iter().all(|r| r.loops.is_empty()),
        "{:?}",
        o.instances
    );
    assert_eq!(o.instances[0].literals["tone"], serde_json::json!("x"));
    assert_eq!(o.instances[1].exprs["tone"], "__undefined");
    // One slot per instance, read without a row index (the row's own values stay per row).
    assert!(
        o.jinja.contains("_1[\"_s1\"]") && o.jinja.contains("_2[\"_s1\"]"),
        "{}",
        o.jinja
    );
    assert!(!o.jinja.contains("[_i"), "{}", o.jinja);
    // An inline array literal (shadcn's carousel) is the same case.
    let a = lower(
        "import Cell from './Cell'\nexport default function P() { return <ul>{[1, 2, 3].map((n) => <li key={n}><Cell tone=\"y\">{n}</Cell></li>)}</ul> }",
    );
    assert_eq!(a.tier, Tier::Static, "{:?}", a.diags);
    assert!(a.instances[0].loops.is_empty());
}

#[test]
fn one_rule_for_props_lists_and_derived_lists() {
    // Q1: a props-path list feeds a row-invariant instance once too.
    let p = lower(
        "import Cell from './Cell'\nexport default function P({ items }: any) { return <ul>{items.map((it: any) => <li key={it.id}><Cell tone=\"z\">{it.name}</Cell></li>)}</ul> }",
    );
    assert_eq!(p.tier, Tier::Static, "{:?}", p.diags);
    assert!(p.instances[0].loops.is_empty(), "{:?}", p.instances);
    // A row-reading instance over a props path keeps its per-row record (unchanged).
    let r = lower(
        "import Cell from './Cell'\nexport default function P({ items }: any) { return <ul>{items.map((it: any) => <li key={it.id}><Cell tone={it.tone}>x</Cell></li>)}</ul> }",
    );
    assert_eq!(r.instances[0].loops, vec![Some("items".to_string())]);
    // A list derived from the root's props at render: fixed props, so the rows never change.
    let d = lower(
        "import Cell from './Cell'\nexport default function P({ items }: any) { const shown = items.filter((x: any) => x.on); return <ul>{shown.map((it: any) => <li key={it.id}><Cell tone=\"z\">{it.name}</Cell></li>)}</ul> }",
    );
    assert!(!fallback(&d, "instance-list-path"), "{:?}", d.diags);
    assert!(d.instances[0].loops.is_empty(), "{:?}", d.instances);
}

#[test]
fn what_stays_fail_closed() {
    // A row-reading instance over a module const: rows from the literal are PR 2 (R34.43).
    let c = lower(
        "import Cell from './Cell'\nconst rows = [{ id: 'a', t: 'p' }]\nexport default function P() { return <ul>{rows.map((r) => <li key={r.id}><Cell tone={r.t}>x</Cell></li>)}</ul> }",
    );
    assert!(fallback(&c, "instance-list-path"), "{:?}", c.diags);
    // A state list: rows the client re-creates would get no job output.
    let s = lower(&format!(
        "{STATE}import Cell from './Cell'\nexport default function P() {{ const [rows, setRows] = useState([1, 2]); return <ul><button onClick={{() => setRows([...rows, 3])}}>+</button>{{rows.map((n) => <li key={{n}}><Cell tone=\"q\">{{n}}</Cell></li>)}}</ul> }}"
    ));
    assert!(fallback(&s, "instance-list-path"), "{:?}", s.diags);
    // useId values differ per row.
    let u = lower(
        "import Ided from './Ided'\nconst rows = ['a', 'b']\nexport default function P() { return <ul>{rows.map((r) => <li key={r}><Ided text=\"t\" /></li>)}</ul> }",
    );
    assert!(fallback(&u, "instance-list-path"), "{:?}", u.diags);
}
