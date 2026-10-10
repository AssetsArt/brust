//! M1b-2 Task 5: child components — resolution, module cache, tiers, links,
//! island prop checks.
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_file, analyze_source};
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;
use std::path::PathBuf;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn fixture(name: &str) -> ComponentIR {
    let path = format!("tests/fixtures/{name}/input.tsx");
    run_on_compiler_thread(move || {
        analyze_file(
            &path,
            &AnalyzeOptions {
                root: root(),
                ..Default::default()
            },
        )
        .unwrap()
    })
}

fn analyze(src: &str) -> ComponentIR {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        analyze_source(
            "tests/fixtures/parent-counter/Mem.tsx",
            s.into_bytes(),
            &AnalyzeOptions {
                root: root(),
                ..Default::default()
            },
        )
        .unwrap()
    })
}

fn components(n: &Node, out: &mut Vec<Node>) {
    match n {
        Node::Component { children, .. } => {
            out.push(n.clone());
            children.iter().for_each(|c| components(c, out));
        }
        Node::Element { children, .. } | Node::Fragment(children) => {
            children.iter().for_each(|c| components(c, out))
        }
        Node::For { body, .. } => body.iter().for_each(|c| components(c, out)),
        Node::If { then, else_, .. } => then.iter().chain(else_).for_each(|c| components(c, out)),
        _ => {}
    }
}

#[test]
fn parent_counter_links_the_native_child() {
    let ir = fixture("parent-counter");
    assert_eq!(ir.children.len(), 1);
    assert_eq!(ir.children[0].name, "Counter");
    assert_eq!(ir.children[0].tier, Tier::Native);
    assert_eq!(
        ir.children[0].path.as_deref(),
        Some("tests/fixtures/parent-counter/Counter.tsx")
    );
    assert_eq!(ir.child_links.len(), 1);
    let l = &ir.child_links[0];
    assert_eq!((l.id, l.props_member.as_str()), (1, "_p1"));
    assert_eq!(l.child, ir.children[0].id.clone().unwrap());
    assert!(l.item_scoped.is_empty());
    let names: Vec<_> = l.props.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(names, ["n", "onReset"]);
    assert!(matches!(l.props[0].1, Expr::Server(_)));
    assert!(matches!(&l.props[1].1, Expr::ClientOnly { js } if js.contains("setCount(0)")));
    let mut c = Vec::new();
    components(&ir.template, &mut c);
    assert!(matches!(
        &c[0],
        Node::Component {
            link: Some(1),
            tier: Tier::Native,
            ..
        }
    ));
    assert_eq!(ir.tier, Tier::Native);
}

#[test]
fn keyed_list_of_native_children_is_item_scoped() {
    let ir = analyze(
        "import Counter from './Counter'\nexport default function L({ items }: any) { return <ul>{items.map((item: any) => <Counter key={item.id} n={item.n} onReset={() => {}} />)}</ul> }",
    );
    assert_eq!(ir.child_links.len(), 1);
    assert_eq!(ir.child_links[0].item_scoped, ["item"]);
}

/// Review Focus 5: a static parent of a React child stays static but needs
/// the worker for the island's SSR job.
#[test]
fn react_child_is_an_island_with_an_ssr_job() {
    let ir = fixture("react-child");
    assert!(matches!(
        ir.children[0].tier,
        Tier::React {
            client_only: false,
            ..
        }
    ));
    let id = ir.children[0].id.clone().unwrap();
    assert_eq!(
        ir.jobs,
        [JobDecl {
            kind: JobKind::Ssr { client_only: false },
            inputs: vec!["productId".into()],
            outputs: vec![format!("_ssr_{id}")],
            per_item: None,
            props: Some([("productId".to_string(), Some("productId".to_string()))].into()),
            literals: Default::default(),
        }]
    );
    assert_eq!(ir.tier, Tier::Static);
    assert!(ir.needs_worker);
}

#[test]
fn function_and_reactive_props_to_an_island_are_errors() {
    let ir = analyze(
        "import { useState } from 'react'\nimport Reviews from '../react-child/Reviews'\nexport default function P() { const [n, setN] = useState(0); return <div><Reviews onReset={() => setN(0)} count={n} /></div> }",
    );
    let e: Vec<_> = ir
        .diagnostics
        .iter()
        .filter(|d| d.rule == "island-prop" && d.class == DiagClass::Error)
        .map(|d| d.message.clone())
        .collect();
    assert_eq!(e.len(), 2, "{:?}", ir.diagnostics);
    assert!(e[0].contains("`onReset`") && e[0].contains("a function"));
    assert!(e[1].contains("`count`") && e[1].contains("reads state `n`"));
    assert!(ir.jobs.is_empty());
}

/// Review Focus 4: an import cycle stops at the in-progress marker.
#[test]
fn import_cycle_is_a_fallback_not_a_stack_overflow() {
    let ir = fixture("import-cycle");
    // input → A → input (in progress): A records the cycle and is React;
    // input's child A is therefore an island.
    assert!(
        matches!(ir.children[0].tier, Tier::React { .. }),
        "{:?}",
        ir.children
    );
    assert!(
        ir.jobs
            .iter()
            .any(|j| matches!(j.kind, JobKind::Ssr { .. }))
    );
}

#[test]
fn local_and_external_components() {
    let ir = analyze(
        "import { Button } from '@ui/button'\nfunction Item({ label }: any) { return <li>{label}</li> }\nconst Arrow = () => <i/>\nexport default function P({ xs }: any) { return <ul><Item label=\"a\" /><Button /><Arrow /></ul> }",
    );
    let tiers: Vec<_> = ir
        .children
        .iter()
        .map(|c| (c.name.as_str(), c.tier.clone()))
        .collect();
    assert_eq!(tiers[0], ("Item", Tier::Static));
    assert!(matches!(tiers[1], ("Button", Tier::React { .. })));
    assert!(matches!(tiers[2], ("Arrow", Tier::React { .. })));
    let rules: Vec<_> = ir.diagnostics.iter().map(|d| d.rule.as_str()).collect();
    assert!(rules.contains(&"external-component"), "{rules:?}");
    assert!(rules.contains(&"local-component"), "{rules:?}");
    // local-component makes the parent React; external-component alone would not.
    assert!(matches!(ir.tier, Tier::React { .. }));
    let only_external = analyze(
        "import { Button } from '@ui/button'\nexport default function P() { return <div><Button label=\"x\" /></div> }",
    );
    assert_eq!(only_external.tier, Tier::Static);
    assert!(only_external.needs_worker);
}

/// S6: a react child's ssr job (on the parent) maps child prop names to parent paths.
#[test]
fn react_child_ssr_job_carries_the_prop_map() {
    let ir = fixture("react-child");
    let job = ir
        .jobs
        .iter()
        .find(|j| matches!(j.kind, JobKind::Ssr { .. }))
        .expect("ssr job");
    let props = job.props.as_ref().expect("props map");
    assert_eq!(
        props.get("productId"),
        Some(&Some("productId".to_string())),
        "{props:?}"
    );
}

#[test]
fn react_child_in_a_row_maps_with_idx_and_literals_go_to_literals() {
    let ir = fixture("react-child-row");
    let jobs: Vec<_> = ir
        .jobs
        .iter()
        .filter(|j| matches!(j.kind, JobKind::Ssr { .. }))
        .collect();
    assert_eq!(jobs.len(), 1, "{:?}", ir.jobs);
    let props = jobs[0].props.as_ref().unwrap();
    assert_eq!(
        props.get("item"),
        Some(&Some("items[idx]".to_string())),
        "{props:?}"
    );
    assert!(
        !props.contains_key("limit"),
        "a literal prop is not in props: {props:?}"
    );
    assert_eq!(jobs[0].literals.get("limit"), Some(&serde_json::json!(3)));
    assert_eq!(jobs[0].per_item.as_deref(), Some("it"));
}

#[test]
fn same_react_child_twice_gives_two_jobs_with_own_maps() {
    let ir = analyze_in(
        "react-child",
        r#"
import Reviews from './Reviews'
export default function P(props: { a: string; b: string }) { return <div><Reviews productId={props.a}/><Reviews productId={props.b}/></div> }
"#,
    );
    let jobs: Vec<_> = ir
        .jobs
        .iter()
        .filter(|j| matches!(j.kind, JobKind::Ssr { .. }))
        .collect();
    assert_eq!(jobs.len(), 2);
    assert_eq!(
        jobs[0].props.as_ref().unwrap().get("productId"),
        Some(&Some("a".into()))
    );
    assert_eq!(
        jobs[1].props.as_ref().unwrap().get("productId"),
        Some(&Some("b".into()))
    );
    assert!(jobs[1].outputs[0].ends_with("_2"), "{:?}", jobs[1].outputs);
}

#[test]
fn react_page_self_job_has_no_prop_map() {
    let ir = fixture("react-hook");
    let job = ir
        .jobs
        .iter()
        .find(|j| matches!(j.kind, JobKind::Ssr { .. }))
        .expect("self ssr job");
    assert_eq!(job.inputs, vec!["*".to_string()]);
    assert!(job.props.is_none());
}

fn analyze_in(dir: &str, src: &str) -> ComponentIR {
    let s = src.to_string();
    let path = format!("tests/fixtures/{dir}/Mem.tsx");
    run_on_compiler_thread(move || {
        analyze_source(
            &path,
            s.into_bytes(),
            &AnalyzeOptions {
                root: root(),
                ..Default::default()
            },
        )
        .unwrap()
    })
}

#[test]
fn literal_react_child_props_go_to_literals_not_props() {
    let ir = analyze_in(
        "react-child",
        r#"
import Reviews from './Reviews'
export default function P(props: { a: { id: string } }) { return <Reviews item={props.a} limit={3} title="x" on={true} meta={{ a: 1, b: ['x'] }} n={props.a.id.length + 1} /> }
"#,
    );
    let job = ir
        .jobs
        .iter()
        .find(|j| matches!(j.kind, JobKind::Ssr { .. }))
        .unwrap();
    let props = job.props.as_ref().unwrap();
    assert_eq!(props.get("item"), Some(&Some("a".into())));
    assert_eq!(
        props.get("n"),
        Some(&None),
        "computed values stay null paths: {props:?}"
    );
    assert!(
        !props.contains_key("limit") && !props.contains_key("title"),
        "literals are not in props: {props:?}"
    );
    assert_eq!(job.literals.get("limit"), Some(&serde_json::json!(3)));
    assert_eq!(job.literals.get("title"), Some(&serde_json::json!("x")));
    assert_eq!(job.literals.get("on"), Some(&serde_json::json!(true)));
    assert_eq!(
        job.literals.get("meta"),
        Some(&serde_json::json!({"a": 1, "b": ["x"]}))
    );
    assert!(job.literals.keys().all(|k| !props.contains_key(k)));
}

#[test]
fn react_page_self_job_has_no_literals() {
    let ir = fixture("react-hook");
    let job = ir
        .jobs
        .iter()
        .find(|j| matches!(j.kind, JobKind::Ssr { .. }))
        .unwrap();
    assert!(job.literals.is_empty() && job.props.is_none());
}

/// F70: a static child reading only the row is linked only where the client can re-create the row.
#[test]
fn static_child_link_decisions() {
    const S: &str = "import { useState } from 'react'\nimport Badge from './Badge'\n";
    for (name, src, links, tier) in [
        (
            "prop list, no state",
            "export default function P({ rows }: any) { return <ul>{rows.map((r: any) => <li key={r.id}><Badge type={r.t} label={r.l} color={r.c} /></li>)}</ul> }",
            0,
            Tier::Static,
        ),
        (
            "state-sourced list",
            "export default function P() { const [rows, setRows] = useState([] as any[]); return <ul onClick={() => setRows([])}>{rows.map((r: any) => <li key={r.id}><Badge type={r.t} label={r.l} color={r.c} /></li>)}</ul> }",
            1,
            Tier::Native,
        ),
        (
            "prop list, handler in the row",
            "export default function P({ rows }: any) { const [k, setK] = useState(''); return <ul>{rows.map((r: any) => <li key={r.id} onClick={() => setK(r.id)}><Badge type={r.t} label={r.l} color={r.c} /></li>)}</ul> }",
            1,
            Tier::Native,
        ),
        (
            "prop list, state elsewhere (state makes the props settable: stays linked)",
            "export default function P({ rows }: any) { const [k, setK] = useState(0); return <div><button onClick={() => setK(k + 1)}>{k}</button><ul>{rows.map((r: any) => <li key={r.id}><Badge type={r.t} label={r.l} color={r.c} /></li>)}</ul></div> }",
            1,
            Tier::Native,
        ),
        (
            "nested prop list under a stateful outer list",
            "import { take } from '../reactive-list-child/take'\nexport default function P({ rows }: any) { const [n, setN] = useState(1); const shown = take(rows, n); return <ul onClick={() => setN(n + 1)}>{shown.map((r: any) => <li key={r.id}>{r.bs.map((b: any) => <Badge key={b.t} type={b.t} label={b.l} color={b.c} />)}</li>)}</ul> }",
            1,
            Tier::Native,
        ),
        (
            "state prop",
            "export default function P({ rows }: any) { const [k, setK] = useState(''); return <ul>{rows.map((r: any) => <li key={r.id}><Badge type={r.id === k ? 'on' : 'off'} label={r.l} color={r.c} /></li>)}</ul> }",
            1,
            Tier::Native,
        ),
        (
            "plain prop, no row",
            "export default function P({ t }: any) { return <div><Badge type={t} label=\"x\" color=\"#000\" /></div> }",
            0,
            Tier::Static,
        ),
    ] {
        let ir = analyze_in("static-list-child", &format!("{S}{src}"));
        assert_eq!(ir.child_links.len(), links, "{name}: {:?}", ir.diagnostics);
        assert_eq!(ir.tier, tier, "{name}");
    }
}

/// F70: a dropped row-only link does not renumber the links that survive.
#[test]
fn row_only_links_keep_their_ids() {
    let ir = analyze_in(
        "static-list-child",
        "import Badge from './Badge'\nexport default function P({ rows }: any) { return <div><ul>{rows.map((r: any) => <li key={r.id}><Badge type={r.t} label={r.l} color={r.c} /></li>)}</ul><Badge type=\"t\" label=\"x\" color=\"#000\" onPick={() => 1} /></div> }",
    );
    assert_eq!(ir.child_links.len(), 1, "{:?}", ir.child_links);
    assert_eq!(
        (
            ir.child_links[0].id,
            ir.child_links[0].props_member.as_str()
        ),
        (2, "_p2")
    );
}
