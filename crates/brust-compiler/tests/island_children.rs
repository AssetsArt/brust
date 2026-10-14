//! shadcn S1 (R34.21–R34.23): the constant JSX children of a React island lower to a JSON tree in its
//! props, so the page keeps its tier; anything the island could not be handed as JSON keeps the
//! `island-children` fallback and the page renders with React.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

/// The page `fixtures/island-children/<file>` and every component compiled under it.
fn page(file: &str) -> (ComponentIR, Vec<ComponentIR>) {
    let file = file.to_string();
    run_on_compiler_thread(move || {
        let opts = AnalyzeOptions {
            root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
            ..Default::default()
        };
        let out = compile_tree(
            &format!("crates/brust-compiler/tests/fixtures/island-children/{file}"),
            None,
            &opts,
            "/_brust/client/runtime.js",
        )
        .unwrap();
        let all: Vec<ComponentIR> = out.into_iter().map(|l| (*l.ir).clone()).collect();
        let root = all
            .iter()
            .find(|ir| ir.source.ends_with(&file))
            .expect("the page")
            .clone();
        (root, all)
    })
}

fn rule<'a>(ir: &'a ComponentIR, rule: &str) -> Option<&'a Diagnostic> {
    ir.diagnostics.iter().find(|d| d.rule == rule)
}

fn is_react(ir: &ComponentIR) -> bool {
    matches!(ir.tier, Tier::React { .. })
}

fn children_literals(ir: &ComponentIR) -> Vec<serde_json::Value> {
    ir.jobs
        .iter()
        .filter_map(|j| j.literals.get("children").cloned())
        .collect()
}

#[test]
fn constant_children_lower_and_the_page_keeps_its_tier() {
    let (root, all) = page("ok.tsx");
    assert!(
        rule(&root, "island-children").is_none(),
        "{:?}",
        root.diagnostics
    );
    assert!(!is_react(&root), "{:?}", root.tier);
    // Three <Card> instances, three SSR jobs, each carrying its own tree.
    let trees = children_literals(&root);
    assert_eq!(trees.len(), 3, "{trees:?}");
    let a = &trees[0];
    // [ <p className="x">hi <b>there</b></p>, <Badge/>, <Wrap/> ]
    let items = a.as_array().expect("several children are an array");
    assert_eq!(items.len(), 3);
    assert_eq!(items[0]["$brust"], "el");
    assert_eq!(items[0]["t"], "p");
    assert_eq!(items[0]["p"]["className"], "x");
    assert_eq!(items[1]["$brust"], "cmp");
    assert_eq!(items[1]["p"]["n"], 1);
    assert_eq!(items[1]["p"]["tone"], "loud");
    assert_eq!(items[2]["$brust"], "cmp");
    // One child is its own value; a fragment is a marked node; `disabled` is `true`.
    assert_eq!(trees[1], "just text");
    assert_eq!(trees[2]["$brust"], "fr");
    let input = &trees[2]["c"][1];
    assert_eq!(input["p"]["disabled"], true);
    // The island's ref lists what its tree names, so the build can import it.
    let card = root
        .children
        .iter()
        .find(|c| c.name == "Card")
        .expect("Card ref");
    let nested = card.nested.as_ref().expect("lowered children");
    assert_eq!(nested.len(), 2, "{nested:?}");
    for n in nested {
        assert!(all.iter().any(|ir| &ir.id == n), "{n} was compiled");
    }
}

fn fails(file: &str, why: &str) {
    let (root, _) = page(file);
    let d = rule(&root, "island-children")
        .unwrap_or_else(|| panic!("{file}: no island-children, {:?}", root.diagnostics));
    assert!(d.message.contains(why), "{file}: {}", d.message);
    assert!(is_react(&root), "{file}: {:?}", root.tier);
}

#[test]
fn children_the_island_cannot_be_handed_stay_a_fallback() {
    fails("state.tsx", "not a constant");
    fails("handler.tsx", "event handler");
    fails("expr.tsx", "not a constant");
    fails("html.tsx", "dangerouslySetInnerHTML");
    fails("spread.tsx", "spread");
    fails("bare.tsx", "bare or empty attribute");
    fails("cond.tsx", "condition");
    fails("list.tsx", "list");
    fails("renderprop.tsx", "constant");
}

#[test]
fn an_oversize_tree_is_a_fallback() {
    let dir = std::env::temp_dir().join(format!("brust-island-children-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/island-children");
    std::fs::copy(src.join("ui.tsx"), dir.join("ui.tsx")).unwrap();
    let text = "x".repeat(70_000);
    std::fs::write(
        dir.join("big.tsx"),
        format!("import {{ Card }} from './ui'\nexport default function Page() {{ return <Card title=\"a\">{text}</Card> }}\n"),
    )
    .unwrap();
    let dir2 = dir.clone();
    let (root, _) = run_on_compiler_thread(move || {
        let opts = AnalyzeOptions {
            root: dir2,
            ..Default::default()
        };
        let out = compile_tree("big.tsx", None, &opts, "/_brust/client/runtime.js").unwrap();
        let all: Vec<ComponentIR> = out.into_iter().map(|l| (*l.ir).clone()).collect();
        let root = all
            .iter()
            .find(|ir| ir.source.ends_with("big.tsx"))
            .unwrap()
            .clone();
        (root, all)
    });
    let _ = std::fs::remove_dir_all(&dir);
    let d = rule(&root, "island-children").expect("over the cap");
    assert!(d.message.contains("cap"), "{}", d.message);
    assert!(is_react(&root));
}

#[test]
fn arithmetic_on_literals_is_a_literal_prop() {
    // `ratio={16 / 9}` used to be a computed prop the build refused (`ssr-prop-not-a-path`).
    let (root, _) = page("exprprop.tsx");
    let job = root
        .jobs
        .iter()
        .find(|j| matches!(j.kind, JobKind::Ssr { .. }))
        .expect("the island job");
    assert_eq!(
        job.literals.get("ratio"),
        Some(&serde_json::json!(16.0 / 9.0))
    );
    assert!(!job.props.as_ref().unwrap().contains_key("ratio"));
}
