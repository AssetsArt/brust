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
        .filter_map(|j| j.literals.get("children").map(|v| v.to_value()))
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
    fails("listprops.tsx", "list");
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
        job.literals.get("ratio").map(|v| v.to_value()),
        Some(serde_json::json!(16.0 / 9.0))
    );
    assert!(!job.props.as_ref().unwrap().contains_key("ratio"));
}

fn ssr_job(ir: &ComponentIR) -> &JobDecl {
    ir.jobs
        .iter()
        .find(|j| matches!(j.kind, JobKind::Ssr { .. }))
        .expect("the island job")
}

fn island_ref<'a>(ir: &'a ComponentIR, name: &str) -> &'a ChildRef {
    ir.children
        .iter()
        .find(|r| r.name == name)
        .unwrap_or_else(|| panic!("no ref {name}"))
}

#[test]
fn props_read_by_the_children_are_holes_of_the_island() {
    // F148a R34.116-R34.120: the tree is constant, each prop it reads is one more island prop.
    let (root, _) = page("holes.tsx");
    assert!(
        rule(&root, "island-children").is_none(),
        "{:?}",
        root.diagnostics
    );
    assert!(!is_react(&root), "{:?}", root.tier);
    let job = ssr_job(&root);
    let tree = job.literals.get("children").expect("the skeleton");
    // [ <h3 title=$p0>{$p1}</h3>, if $p2 <u>, <input disabled=$p2> ]
    let items = tree.as_array().expect("array");
    assert_eq!(
        items[0]["p"]["title"],
        serde_json::json!({"$brust": "v", "k": "$p0"})
    );
    assert_eq!(
        items[0]["c"][0],
        serde_json::json!({"$brust": "v", "k": "$p1"})
    );
    assert_eq!(items[1]["$brust"], "if");
    assert_eq!(items[1]["k"], "$p2");
    assert_eq!(items[1]["c"][0]["t"], "u");
    // `cond && <X/>`: React renders a falsy number as text there. F388: the else branch prints the same hole (its
    // falsy value, as React would), so the node needs no `a` flag of its own.
    assert_eq!(
        items[1]["e"],
        serde_json::json!([{"$brust": "v", "k": "$p2"}])
    );
    assert_eq!(items[1]["a"], serde_json::Value::Null);
    // The same prop read twice is one hole.
    assert_eq!(
        items[2]["p"]["disabled"],
        serde_json::json!({"$brust": "v", "k": "$p2"})
    );
    let props = job.props.as_ref().unwrap();
    assert_eq!(props.get("$p0"), Some(&Some("title".to_string())));
    assert_eq!(props.get("$p1"), Some(&Some("who.name".to_string())));
    assert_eq!(props.get("$p2"), Some(&Some("ok".to_string())));
    // The revive may read exactly these names.
    assert_eq!(island_ref(&root, "Card").holes, ["$p0", "$p1", "$p2"]);
}

#[test]
fn a_wrapper_with_children_in_its_island_stays_static() {
    let (root, all) = page("wrapped.tsx");
    assert!(
        rule(&root, "island-children").is_none(),
        "{:?}",
        root.diagnostics
    );
    assert!(!is_react(&root), "{:?}", root.tier);
    let frame = all
        .iter()
        .find(|ir| ir.source.ends_with("wrapper.tsx"))
        .expect("the wrapper");
    assert!(!is_react(frame), "{:?} {:?}", frame.tier, frame.diagnostics);
    assert!(
        rule(frame, "island-children").is_none(),
        "{:?}",
        frame.diagnostics
    );
    // <b>{title}</b>{children}: a value hole and the caller's tree, in source order.
    let job = ssr_job(frame);
    let tree = job.literals.get("children").expect("the skeleton");
    assert_eq!(
        tree[0]["c"][0],
        serde_json::json!({"$brust": "v", "k": "$p0"})
    );
    assert_eq!(tree[1], serde_json::json!({"$brust": "slot", "k": "$c1"}));
    let props = job.props.as_ref().unwrap();
    assert_eq!(props.get("$p0"), Some(&Some("title".to_string())));
    assert_eq!(props.get("$c1"), Some(&Some("__ch".to_string())));
    assert_eq!(island_ref(frame, "Card").holes, ["$c1", "$p0"]);
    // Each call site binds its own tree; a call without children binds none.
    let records: Vec<_> = root.instances.iter().collect();
    assert_eq!(records.len(), 2, "{records:?}");
    assert_eq!(
        records[0].literals.get("__ch").map(|v| v.to_value()),
        Some(serde_json::json!({"$brust": "el", "t": "p", "p": {}, "c": ["hi"]}))
    );
    assert!(records[1].literals.get("__ch").is_none());
    // The registry for the island names what the caller's tree names (here: nothing, but the ref is a host).
    assert!(island_ref(&root, "Frame").nested.is_some());
}

fn falls_back(file: &str, rule_name: &str, why: &str) {
    let (root, _) = page(file);
    let d = rule(&root, rule_name)
        .unwrap_or_else(|| panic!("{file}: no {rule_name}, {:?}", root.diagnostics));
    assert!(d.message.contains(why), "{file}: {}", d.message);
    assert!(is_react(&root), "{file}: {:?}", root.tier);
}

#[test]
fn holes_that_are_not_primitives_or_trees_the_compiler_wrote_fall_back() {
    // R34.118: an object-valued attribute is never a hole.
    falls_back("stylehole.tsx", "island-children", "not a hole");
    // R34.116: a value that changes on the client is state, not a hole.
    falls_back("statehole.tsx", "island-children", "not a hole");
    // R34.121: `{children}` of a route component is request data, not a tree.
    falls_back("routechildren.tsx", "island-children", "request data");
    // R34.26 (d): a constant holding the marker key would read back as one of the compiler's nodes.
    falls_back("markerhole.tsx", "island-children", "reserves");
    // R34.121: state in the children a wrapper hands to its island.
    falls_back("wrapstate.tsx", "island-children", "reach a React island");
    // A scalar island prop that is an expression over props has no path for the server to read: a fallback, not the
    // `ssr-prop-not-a-path` build error a wrapper with children used to hide by being React.
    falls_back("nonpath.tsx", "island-prop", "expression over props");
    // `__ch` is the compiler's own prop.
    falls_back("wrapreserved.tsx", "island-prop", "reserved");
    // R34.121: a spread into a wrapper whose island renders `{children}` could carry a `__ch` from request data
    // into a tree the revive walks. Refused by name, with children or without.
    falls_back(
        "wrapspread.tsx",
        "spread-props",
        "comes from the call site only",
    );
    falls_back(
        "wrapspreadkids.tsx",
        "spread-props",
        "comes from the call site only",
    );
}

#[test]
fn more_than_the_hole_cap_falls_back() {
    let dir = std::env::temp_dir().join(format!("brust-island-holes-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/island-children");
    std::fs::copy(src.join("ui.tsx"), dir.join("ui.tsx")).unwrap();
    let names: Vec<String> = (0..65).map(|i| format!("p{i}")).collect();
    let body: String = names.iter().map(|n| format!("<i>{{{n}}}</i>")).collect();
    std::fs::write(
        dir.join("many.tsx"),
        format!(
            "import {{ Card }} from './ui'\nexport default function Page({{ {} }}: any) {{ return <Card title=\"a\">{body}</Card> }}\n",
            names.join(", ")
        ),
    )
    .unwrap();
    let dir2 = dir.clone();
    let root = run_on_compiler_thread(move || {
        let opts = AnalyzeOptions {
            root: dir2,
            ..Default::default()
        };
        let out = compile_tree("many.tsx", None, &opts, "/_brust/client/runtime.js").unwrap();
        out.into_iter()
            .map(|l| (*l.ir).clone())
            .find(|ir| ir.source.ends_with("many.tsx"))
            .unwrap()
    });
    let _ = std::fs::remove_dir_all(&dir);
    let d = rule(&root, "island-children").expect("over the cap");
    assert!(d.message.contains("more than 64"), "{}", d.message);
    assert!(is_react(&root));
}

#[test]
fn a_wrapper_that_is_also_a_route_file_never_takes_a_tree_for_children() {
    // R34.121: a route component's `children` are request data. A file the build lists as a route root keeps
    // `{children}` out of its island's tree even when a page calls it like a wrapper.
    let all = run_on_compiler_thread(|| {
        let opts = AnalyzeOptions {
            root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
            route_roots: [
                "crates/brust-compiler/tests/fixtures/island-children/wrapper.tsx".to_string(),
            ]
            .into_iter()
            .collect(),
            ..Default::default()
        };
        compile_tree(
            "crates/brust-compiler/tests/fixtures/island-children/wrapped.tsx",
            None,
            &opts,
            "/_brust/client/runtime.js",
        )
        .unwrap()
        .into_iter()
        .map(|l| (*l.ir).clone())
        .collect::<Vec<_>>()
    });
    let frame = all
        .iter()
        .find(|ir| ir.source.ends_with("wrapper.tsx"))
        .expect("the wrapper");
    let d = rule(frame, "island-children").expect("a route file takes no tree");
    assert!(d.message.contains("request data"), "{}", d.message);
    assert!(is_react(frame), "{:?}", frame.tier);
}

#[test]
fn the_ternary_form_of_a_condition_has_no_and_flag() {
    let (root, _) = page("condtern.tsx");
    let tree = ssr_job(&root)
        .literals
        .get("children")
        .expect("tree")
        .clone();
    assert_eq!(tree["$brust"], "if", "{tree}");
    assert!(tree.get("a").is_none(), "{tree}");
}
