//! F524: a Static shell whose template holds a non-static child fed from its own props (a wrapper `SectionView` that
//! renders `<Custom nodes={s.nodes}/>`, Custom mapping its rows to a native `Node`) is a fixed-props clone candidate at a
//! fixed call site (F494): the clone chain reaches every level, so a page over loader data lowers all static, as when the
//! wrapper's markup is written inline. A prop that changes on the client keeps today's native tiers.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::{DiagClass, Diagnostic};
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::sync::atomic::{AtomicUsize, Ordering};

/// One lowered component of a tree.
#[derive(Debug)]
struct Compiled {
    source: String,
    id: String,
    jinja: String,
    ir: serde_json::Value,
    diagnostics: Vec<Diagnostic>,
}

/// `page` compiled as the route component `P.tsx` of a scratch root holding `files`; the root first.
fn compile(page: &str, files: &[(&str, &str)]) -> Vec<Compiled> {
    static N: AtomicUsize = AtomicUsize::new(0);
    let n = N.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("brustc-f524-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    for (path, text) in files.iter().chain([&("P.tsx", page)]) {
        let p = dir.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    let src = page.to_string();
    let tree = run_on_compiler_thread(move || {
        let tree = compile_tree(
            "P.tsx",
            Some(src.into_bytes()),
            &AnalyzeOptions {
                root: dir,
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )?;
        Ok::<_, Diagnostic>(
            tree.iter()
                .map(|l| Compiled {
                    source: l.ir.source.clone(),
                    id: l.ir.id.clone(),
                    jinja: l.artifacts.jinja.clone(),
                    ir: serde_json::to_value(&*l.ir).unwrap(),
                    diagnostics: l
                        .ir
                        .diagnostics
                        .iter()
                        .chain(&l.artifacts.diagnostics)
                        .cloned()
                        .collect(),
                })
                .collect::<Vec<_>>(),
        )
    })
    .unwrap_or_else(|d| panic!("{d:?}"));
    for c in &tree {
        assert!(
            !c.diagnostics.iter().any(|d| d.class == DiagClass::Error),
            "{}: {:?}",
            c.source,
            c.diagnostics
        );
    }
    tree
}

fn tier(c: &Compiled) -> String {
    match &c.ir["tier"] {
        serde_json::Value::String(s) => s.clone(),
        v => v.as_object().unwrap().keys().next().unwrap().clone(),
    }
}

/// `(source, id, tier, jinja bytes)` of every component of the tree, for a failure message.
fn table(tree: &[Compiled]) -> String {
    tree.iter()
        .map(|c| format!("{} {} {} {}B\n", c.source, c.id, tier(c), c.jinja.len()))
        .collect()
}

const PAGE: &str = "import SectionView from './SectionView'\nexport default function P({ sections }: any) { return <main>{sections.map((s: any) => <SectionView key={s.id} s={s} />)}</main> }";

const SECTION_VIEW: &str = "import Custom from './Custom'\nexport default function SectionView({ s }: any) {\n  switch (s.type) {\n    case 'custom':\n      return <Custom id={s.id} cls={s.cls} nodes={s.nodes} />\n    case 'rule':\n      return <hr data-id={s.id} />\n    default:\n      return <h2 data-id={s.id}>{s.title}</h2>\n  }\n}\n";

/// The same wrapper with Custom's markup written inline in its arm (the shape that is all static on main).
const SECTION_VIEW_INLINE: &str = "import Node from './Node'\nexport default function SectionView({ s }: any) {\n  switch (s.type) {\n    case 'custom':\n      return <section id={s.id} className={s.cls}>{s.nodes.map((n: any) => <Node key={n.id} n={n} />)}</section>\n    case 'rule':\n      return <hr data-id={s.id} />\n    default:\n      return <h2 data-id={s.id}>{s.title}</h2>\n  }\n}\n";

const CUSTOM: &str = "import Node from './Node'\nexport default function Custom({ id, cls, nodes }: any) {\n  return <section id={id} className={cls}>{nodes.map((n: any) => <Node key={n.id} n={n} />)}</section>\n}\n";

const NODE: &str = "import Leaf from './Leaf'\nexport default function Node({ n }: any) {\n  switch (n.kind) {\n    case 'group':\n      return <div data-id={n.id}>{(n.children ?? []).map((c: any) => <Leaf key={c.id} l={c} />)}</div>\n    case 'img':\n      return <img data-id={n.id} src={n.src} alt={n.label} />\n    default:\n      return <p data-id={n.id}>{n.label}</p>\n  }\n}\n";

const LEAF: &str = "export default function Leaf({ l }: any) {\n  return <span data-id={l.id}>{l.label}</span>\n}\n";

fn files<'a>(section_view: &'a str, custom: &'a str, node: &'a str) -> Vec<(&'a str, &'a str)> {
    vec![
        ("SectionView.tsx", section_view),
        ("Custom.tsx", custom),
        ("Node.tsx", node),
        ("Leaf.tsx", LEAF),
    ]
}

/// Every component the page reaches is static; the page's template has no runtime host and no hidden arm; the whole
/// tree's template bytes are at most 1.5x those of `reference` (the inline variant). Returns the clone count.
fn assert_all_static(tree: &[Compiled], reference: &[Compiled]) -> usize {
    for c in tree {
        assert_eq!(tier(c), "Static", "{}\n{}", c.source, table(tree));
    }
    let page = &tree[0];
    assert!(!page.jinja.contains("x-data"), "{}", page.jinja);
    assert!(!page.jinja.contains(" hidden"), "{}", page.jinja);
    assert!(!page.jinja.contains("<brust-island"), "{}", page.jinja);
    let bytes = |t: &[Compiled]| t.iter().map(|c| c.jinja.len()).sum::<usize>();
    assert!(
        bytes(tree) * 2 <= bytes(reference) * 3,
        "{} vs {}\n{}\n{}",
        bytes(tree),
        bytes(reference),
        table(tree),
        table(reference)
    );
    tree.iter()
        .filter(|c| c.ir["fixed_clone_of"].is_string())
        .count()
}

/// A1: the repro: Page -> SectionView (switch) -> Custom (wrapper) -> Node (switch, rows of Leaf): all static, one clone
/// per component (S3: SectionView, Custom, Node), close to the inline variant's size.
#[test]
fn a_static_shell_over_a_native_child_is_cloned_down_the_chain() {
    let inline = compile(PAGE, &files(SECTION_VIEW_INLINE, CUSTOM, NODE));
    let tree = compile(PAGE, &files(SECTION_VIEW, CUSTOM, NODE));
    assert_eq!(assert_all_static(&tree, &inline), 3, "{}", table(&tree));
}

/// A1 variant: Custom renders one `<Node n={first}/>` (no list).
#[test]
fn a_static_shell_over_one_native_child_is_cloned() {
    let one = "import Node from './Node'\nexport default function Custom({ id, cls, nodes }: any) {\n  return <section id={id} className={cls}><Node n={nodes[0]} /></section>\n}\n";
    let inline_one = SECTION_VIEW_INLINE.replace(
        "{s.nodes.map((n: any) => <Node key={n.id} n={n} />)}",
        "<Node n={s.nodes[0]} />",
    );
    let inline = compile(PAGE, &files(&inline_one, one, NODE));
    let tree = compile(PAGE, &files(SECTION_VIEW, one, NODE));
    assert_eq!(assert_all_static(&tree, &inline), 3, "{}", table(&tree));
}

/// A2: three Node levels (Node -> Node2 -> Leaf): the chain reaches every level.
#[test]
fn the_chain_reaches_three_node_levels() {
    let node = NODE
        .replace("<Leaf key={c.id} l={c} />", "<Node2 key={c.id} n={c} />")
        .replace("import Leaf from './Leaf'", "import Node2 from './Node2'");
    let node2 = NODE.replace(
        "export default function Node(",
        "export default function Node2(",
    );
    let mut fs = files(SECTION_VIEW, CUSTOM, &node);
    fs.push(("Node2.tsx", node2.as_str()));
    let mut fs_inline = files(SECTION_VIEW_INLINE, CUSTOM, &node);
    fs_inline.push(("Node2.tsx", node2.as_str()));
    let inline = compile(PAGE, &fs_inline);
    let tree = compile(PAGE, &fs);
    assert_eq!(assert_all_static(&tree, &inline), 4, "{}", table(&tree));
}

/// A3 / S4: sections held in the page's state change on the client: nothing is cloned, Custom and Node stay native as on
/// main (the page is native, its rows client rows).
#[test]
fn sections_from_state_keep_the_native_tiers() {
    let page = "import { useState } from 'react'\nimport SectionView from './SectionView'\nexport default function P({ sections }: any) { const [all, setAll] = useState(sections); return <main><button onClick={() => setAll([])}>clear</button>{all.map((s: any) => <SectionView key={s.id} s={s} />)}</main> }";
    let tree = compile(page, &files(SECTION_VIEW, CUSTOM, NODE));
    assert!(
        !tree.iter().any(|c| c.ir["fixed_clone_of"].is_string()),
        "{}",
        table(&tree)
    );
    let by = |src: &str| tier(tree.iter().find(|c| c.source == src).unwrap());
    assert_eq!(by("Custom.tsx"), "Native", "{}", table(&tree));
    assert_eq!(by("Node.tsx"), "Native", "{}", table(&tree));
}

/// S4: a stateful native child inside the shell is not something fixed props make static: no clone is tried for it.
#[test]
fn a_shell_over_a_stateful_child_is_not_a_candidate() {
    let custom = "import { useState } from 'react'\nexport default function Custom({ id }: any) {\n  const [n, setN] = useState(0)\n  return <button id={id} onClick={() => setN(n + 1)}>{n}</button>\n}\n";
    let tree = compile(PAGE, &files(SECTION_VIEW, custom, NODE));
    assert!(
        !tree.iter().any(|c| c.ir["fixed_clone_of"].is_string()),
        "{}",
        table(&tree)
    );
    let by = |src: &str| tier(tree.iter().find(|c| c.source == src).unwrap());
    assert_eq!(by("SectionView.tsx"), "Static", "{}", table(&tree));
    assert_eq!(by("Custom.tsx"), "Native", "{}", table(&tree));
}
