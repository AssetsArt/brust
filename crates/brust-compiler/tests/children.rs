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
