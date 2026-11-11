//! F523: a component that renders itself compiles to ONE template macro (no React island per node). Eligible: the final
//! tier is static and nothing per instance remains (C3); anything else falls back with `recursion-unsupported` and the
//! reason (C6), mutual recursion says so, a real import cycle keeps its own text, and a call site that would print the
//! macro in a row the browser builds, or link it, falls back (C4). The macro's depth guard names the component (C5).
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::{DiagClass, Diagnostic};
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::sync::atomic::{AtomicUsize, Ordering};

/// One lowered component of a tree.
struct Compiled {
    source: String,
    id: String,
    jinja: String,
    /// The IR as the build receives it (`ComponentIR` serialised).
    ir: serde_json::Value,
    diagnostics: Vec<Diagnostic>,
}

impl Compiled {
    fn is_react(&self) -> bool {
        self.ir["tier"].get("React").is_some()
    }
}

/// `page` compiled as the route component `P.tsx` of a scratch root holding `files`; the root first.
fn compile(page: &str, files: &[(&str, &str)]) -> Result<Vec<Compiled>, Diagnostic> {
    static N: AtomicUsize = AtomicUsize::new(0);
    let n = N.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("brustc-recursive-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    for (path, text) in files.iter().chain([&("P.tsx", page)]) {
        let p = dir.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    let src = page.to_string();
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            "P.tsx",
            Some(src.into_bytes()),
            &AnalyzeOptions {
                root: dir,
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )?;
        Ok(tree
            .iter()
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
            .collect())
    })
}

/// A tree that compiles with no error.
fn ok(page: &str, files: &[(&str, &str)]) -> Vec<Compiled> {
    let tree = compile(page, files).unwrap_or_else(|d| panic!("{d:?}\n{page}"));
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

fn one<'t>(tree: &'t [Compiled], source: &str) -> &'t Compiled {
    let all: Vec<&Compiled> = tree.iter().filter(|c| c.source == source).collect();
    assert_eq!(
        all.len(),
        1,
        "one compiled copy of {source}: {:?}",
        all.iter().map(|c| &c.id).collect::<Vec<_>>()
    );
    all[0]
}

/// The repro shape: a switch on the node's kind, a group maps its children to itself.
const NODE_VIEW: &str = r#"export function NodeView({ n }: any) {
  switch (n.kind) {
    case 'group':
      return (
        <section data-id={n.id}>
          <h2>{n.label}</h2>
          <div>
            {(n.children ?? []).map((c: any) => (
              <NodeView key={c.id} n={c} />
            ))}
          </div>
        </section>
      )
    default:
      return <p data-id={n.id}>{n.label}</p>
  }
}
"#;

/// The page maps loader nodes to `<NodeView>`.
const PAGE: &str = "import { NodeView } from './NodeView'\nexport default function P({ nodes }: any) { return <main>{nodes.map((n: any) => <NodeView key={n.id} n={n} />)}</main> }";

fn macros(jinja: &str) -> usize {
    jinja.matches("{%- macro ").count()
}

/// No finding that keeps the recursion from compiling, nor one that names a cycle or a fed instance.
fn assert_clean(tree: &[Compiled]) {
    for c in tree {
        for d in &c.diagnostics {
            assert!(
                !matches!(d.class, DiagClass::Error | DiagClass::Fallback),
                "{}: {d:?}",
                c.source
            );
            assert!(
                !["recursion-unsupported", "import-cycle", "nested-instance"]
                    .contains(&d.rule.as_str()),
                "{}: {d:?}",
                c.source
            );
        }
    }
}

fn assert_recursive(tree: &[Compiled]) {
    assert_clean(tree);
    let nv = one(tree, "NodeView.tsx");
    assert_eq!(nv.ir["tier"], "Static", "{}", nv.ir);
    assert_eq!(nv.ir["recursion"], serde_json::json!(["n"]), "{}", nv.ir);
    // its own call is a child entry naming itself, not a second copy
    assert!(
        nv.ir["children"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["name"] == "NodeView" && c["id"] == nv.id.as_str() && c["tier"] == "Static"),
        "{}",
        nv.ir
    );
    let page = &tree[0];
    assert_eq!(macros(&page.jinja), 1, "{}", page.jinja);
    assert_eq!(
        page.jinja.matches("{% endmacro %}").count(),
        1,
        "{}",
        page.jinja
    );
    assert!(!page.jinja.contains("<brust-island"), "{}", page.jinja);
    // the depth guard is the body's first line, naming the component and the cap
    assert!(
        page.jinja
            .contains("{% if __rc_depth > 32 %}{{ recursion_limit(\"NodeView\", 32) }}{% endif %}"),
        "{}",
        page.jinja
    );
    // every reference is a call: the page's (depth 1) and the body's own (depth + 1)
    let call = format!("__rc_{}(", nv.id);
    assert!(
        page.jinja.contains(&format!("{{{{ {call}")),
        "{}",
        page.jinja
    );
    assert!(page.jinja.contains(", 1) }}"), "{}", page.jinja);
    assert!(page.jinja.contains("__rc_depth + 1) }}"), "{}", page.jinja);
    // the macro is defined at the head, right after the header
    let header_end = page.jinja.find("-#}\n").unwrap() + 4;
    assert!(
        page.jinja[header_end..].starts_with("{%- macro "),
        "{}",
        page.jinja
    );
    // its parameters are mangled and passed positionally
    assert!(
        page.jinja
            .contains(&format!("{{%- macro {call}_p_n, __rc_depth) %}}")),
        "{}",
        page.jinja
    );
    // NodeView lowered on its own: the macro and one call reading its props from the top-level variables
    assert_eq!(macros(&nv.jinja), 1, "{}", nv.jinja);
    assert!(
        nv.jinja.ends_with(&format!("{{{{ {call}n, 1) }}}}")),
        "{}",
        nv.jinja
    );
}

/// C1/C2: a named export that renders itself is static: one macro, no island.
#[test]
fn a_named_export_that_renders_itself_is_one_macro() {
    let tree = ok(PAGE, &[("NodeView.tsx", NODE_VIEW)]);
    assert_recursive(&tree);
}

/// C1: a default export is cached by its path, but its own `<NodeView/>` is the same component (no second copy).
#[test]
fn a_default_export_that_renders_itself_is_one_macro_and_one_copy() {
    let nv = NODE_VIEW.replace("export function", "export default function");
    let tree = ok(
        &PAGE.replace("{ NodeView }", "NodeView"),
        &[("NodeView.tsx", nv.as_str())],
    );
    assert_recursive(&tree);
}

/// C3: an inlined native leaf with plain props mounts at every level (no server cell): still one macro.
#[test]
fn a_native_leaf_inside_the_recursion_is_fine() {
    let leaf = "import { useState } from 'react'\nexport default function Leaf({ label }: any) { const [c, setC] = useState(0); return <button type=\"button\" data-leaf={label} onClick={() => setC(c + 1)}>{label} {c}</button> }";
    let nv = format!(
        "import Leaf from './Leaf'\n{}",
        NODE_VIEW.replace("<h2>{n.label}</h2>", "<Leaf label={n.label} />")
    );
    let tree = ok(PAGE, &[("NodeView.tsx", nv.as_str()), ("Leaf.tsx", leaf)]);
    assert_recursive(&tree);
    let page = &tree[0];
    // the leaf's host is printed inside the macro body, its props read from the macro's parameter
    let body_start = page.jinja.find("{%- macro ").unwrap();
    let body_end = page.jinja.find("{% endmacro %}").unwrap();
    assert!(
        page.jinja[body_start..body_end].contains("x-data"),
        "{}",
        page.jinja
    );
    assert_eq!(one(&tree, "Leaf.tsx").ir["tier"], "Native");
}

/// The recursion-unsupported fallback NodeView gets for `nv` (it is React then), after `<NodeView> renders itself and `.
fn refusal(nv: &str, files: &[(&str, &str)]) -> String {
    let mut all = vec![("NodeView.tsx", nv)];
    all.extend_from_slice(files);
    let tree = ok(PAGE, &all);
    let c = one(&tree, "NodeView.tsx");
    assert!(c.is_react(), "{}", c.ir);
    assert!(c.ir.get("recursion").is_none(), "{}", c.ir);
    let d = c
        .diagnostics
        .iter()
        .find(|d| d.rule == "recursion-unsupported")
        .unwrap_or_else(|| panic!("{:?}", c.diagnostics));
    assert_eq!(d.class, DiagClass::Fallback);
    assert!(
        !c.diagnostics
            .iter()
            .any(|d| d.message.contains("import cycle"))
    );
    d.message
        .strip_prefix("<NodeView> renders itself and ")
        .unwrap_or_else(|| panic!("{}", d.message))
        .to_string()
}

#[test]
fn state_refuses_the_recursion() {
    let nv = format!(
        "import {{ useState }} from 'react'\n{}",
        NODE_VIEW
            .replace(
                "switch (n.kind) {",
                "const [open, setOpen] = useState(false)\n  switch (n.kind) {"
            )
            .replace(
                "<h2>{n.label}</h2>",
                "<h2 onClick={() => setOpen(!open)}>{open ? 'v' : '>'}</h2>"
            )
    );
    assert!(refusal(&nv, &[]).starts_with("has state"));
}

#[test]
fn a_handler_refuses_the_recursion() {
    let nv = NODE_VIEW.replace(
        "<h2>{n.label}</h2>",
        "<h2 onClick={() => console.log(n.id)}>{n.label}</h2>",
    );
    assert!(refusal(&nv, &[]).starts_with("binds an event handler"));
}

#[test]
fn an_effect_refuses_the_recursion() {
    let nv = format!(
        "import {{ useEffect }} from 'react'\n{}",
        NODE_VIEW.replace(
            "switch (n.kind) {",
            "useEffect(() => { console.log(n.id) }, [n])\n  switch (n.kind) {"
        )
    );
    assert!(refusal(&nv, &[]).starts_with("runs an effect"));
}

#[test]
fn a_store_read_refuses_the_recursion() {
    let cart = "import { defineStore, signal } from 'brust/store'\n\nexport const cart = defineStore('cart', () => {\n  const count = signal(0)\n  return { count }\n})\n";
    let nv = format!(
        "import {{ useStore }} from 'brust/store/react'\nimport {{ cart }} from './cart'\n{}",
        NODE_VIEW
            .replace(
                "switch (n.kind) {",
                "const s = useStore(cart)\n  switch (n.kind) {"
            )
            .replace("<h2>{n.label}</h2>", "<h2>{s.count}</h2>")
    );
    assert!(refusal(&nv, &[("cart.ts", cart)]).starts_with("reads a store"));
}

#[test]
fn use_id_refuses_the_recursion() {
    let nv = format!(
        "import {{ useId }} from 'react'\n{}",
        NODE_VIEW
            .replace(
                "switch (n.kind) {",
                "const id = useId()\n  switch (n.kind) {"
            )
            .replace("<h2>{n.label}</h2>", "<h2 id={id}>{n.label}</h2>")
    );
    assert!(refusal(&nv, &[]).starts_with("calls `useId`"));
}

#[test]
fn a_fed_child_refuses_the_recursion() {
    let stamp = "import { useId } from 'react'\nexport function Stamp() { const id = useId(); return <span id={id}>s</span> }";
    let nv = format!(
        "import {{ Stamp }} from './Stamp'\n{}",
        NODE_VIEW.replace("<h2>{n.label}</h2>", "<h2>{n.label}</h2><Stamp />")
    );
    let why = refusal(&nv, &[("Stamp.tsx", stamp)]);
    assert!(
        why.starts_with("renders <Stamp>, which has a job or `useId`"),
        "{why}"
    );
}

#[test]
fn a_rest_of_props_refuses_the_recursion() {
    let nv = NODE_VIEW
        .replace("({ n }: any)", "({ n, ...rest }: any)")
        .replace(
            "<section data-id={n.id}>",
            "<section data-id={n.id} {...rest}>",
        );
    assert!(refusal(&nv, &[]).starts_with("takes the rest of its props"));
}

#[test]
fn a_children_prop_refuses_the_recursion() {
    let nv = NODE_VIEW
        .replace("({ n }: any)", "({ n, children }: any)")
        .replace("<h2>{n.label}</h2>", "<h2>{n.label}</h2>{children}");
    assert!(refusal(&nv, &[]).starts_with("takes `children`"));
}

#[test]
fn a_spread_into_its_own_call_refuses_the_recursion() {
    let nv = NODE_VIEW.replace(
        "<NodeView key={c.id} n={c} />",
        "<NodeView key={c.id} {...c} />",
    );
    let why = refusal(&nv, &[]);
    assert!(
        why.starts_with("spreads props into its call to itself"),
        "{why}"
    );
}

/// C6: two components of one module that render each other are mutual recursion, not an import cycle.
#[test]
fn mutual_recursion_says_so() {
    let ab = "export function A({ n }: any) { return <div>{(n.kids ?? []).map((k: any) => <B key={k.id} n={k} />)}</div> }\nfunction B({ n }: any) { return <p><A n={n} /></p> }\n";
    let page = "import { A } from './AB'\nexport default function P({ n }: any) { return <main><A n={n} /></main> }";
    let tree = ok(page, &[("AB.tsx", ab)]);
    let all: Vec<&Diagnostic> = tree.iter().flat_map(|c| &c.diagnostics).collect();
    let d = all
        .iter()
        .find(|d| d.message.contains("<B> renders <A>, which renders it"))
        .unwrap_or_else(|| panic!("{all:?}"));
    assert_eq!(d.rule, "recursion-unsupported");
    assert_eq!(d.class, DiagClass::Fallback);
    assert!(
        !all.iter().any(|d| d.message.contains("import cycle")),
        "{all:?}"
    );
}

/// C6: a default export rendered back by a component of its own module (the default is cached by its path alone).
#[test]
fn mutual_recursion_through_a_default_export_says_so() {
    let ab = "export default function A({ n }: any) { return <div>{(n.kids ?? []).map((k: any) => <B key={k.id} n={k} />)}</div> }\nfunction B({ n }: any) { return <p><A n={n} /></p> }\n";
    let page = "import A from './AB'\nexport default function P({ n }: any) { return <main><A n={n} /></main> }";
    let tree = ok(page, &[("AB.tsx", ab)]);
    let all: Vec<&Diagnostic> = tree.iter().flat_map(|c| &c.diagnostics).collect();
    assert!(
        all.iter().any(|d| d.rule == "recursion-unsupported"
            && d.message.contains("<B> renders <A>, which renders it")),
        "{all:?}"
    );
    assert!(
        !all.iter().any(|d| d.message.contains("import cycle")),
        "{all:?}"
    );
}

/// C6: a real import cycle across modules keeps the import-cycle text.
#[test]
fn a_real_import_cycle_keeps_its_text() {
    let a = "import B from './B'\nexport default function A({ n }: any) { return <div><B n={n} /></div> }";
    let b = "import A from './A'\nexport default function B({ n }: any) { return <p>{n ? <A n={n.next} /> : 'end'}</p> }";
    let page = "import A from './A'\nexport default function P({ n }: any) { return <main><A n={n} /></main> }";
    let tree = ok(page, &[("A.tsx", a), ("B.tsx", b)]);
    let all: Vec<&Diagnostic> = tree.iter().flat_map(|c| &c.diagnostics).collect();
    assert!(
        all.iter()
            .any(|d| d.rule == "import-cycle" && d.message.contains("is part of an import cycle")),
        "{all:?}"
    );
    assert!(
        !all.iter().any(|d| d.rule == "recursion-unsupported"),
        "{all:?}"
    );
}

/// C4: a recursive component in a list row the browser builds (a list over state) is refused at the call site: the
/// page falls back, the component itself stays a macro.
#[test]
fn a_recursive_instance_in_a_client_row_falls_back() {
    let page = "import { useState } from 'react'\nimport { NodeView } from './NodeView'\nexport default function P({ nodes }: any) { const [items, setItems] = useState(nodes); return <main><button onClick={() => setItems([])}>clear</button>{items.map((n: any) => <NodeView key={n.id} n={n} />)}</main> }";
    let tree = ok(page, &[("NodeView.tsx", NODE_VIEW)]);
    let p = &tree[0];
    assert!(p.is_react(), "{}", p.ir);
    let d = p
        .diagnostics
        .iter()
        .find(|d| d.rule == "recursion-unsupported")
        .unwrap_or_else(|| panic!("{:?}", p.diagnostics));
    assert_eq!(d.class, DiagClass::Fallback);
    assert!(d.message.contains("<NodeView>"), "{}", d.message);
    assert_eq!(one(&tree, "NodeView.tsx").ir["tier"], "Static");
}

/// C4: a value that changes on the client passed to a recursive component is refused at the call site.
#[test]
fn a_reactive_prop_to_a_recursive_instance_falls_back() {
    let page = "import { useState } from 'react'\nimport { NodeView } from './NodeView'\nexport default function P({ nodes }: any) { const [i, setI] = useState(0); return <main><button onClick={() => setI(i + 1)}>next</button><NodeView n={nodes[i]} /></main> }";
    let tree = ok(page, &[("NodeView.tsx", NODE_VIEW)]);
    let p = &tree[0];
    assert!(p.is_react(), "{}", p.ir);
    let d = p
        .diagnostics
        .iter()
        .find(|d| d.rule == "recursion-unsupported")
        .unwrap_or_else(|| panic!("{:?}", p.diagnostics));
    assert!(
        d.message.contains("<NodeView> renders itself")
            && d.message.contains("changes on the client"),
        "{}",
        d.message
    );
}

/// A chain of `levels` groups ending in a text node.
fn chain(levels: usize) -> serde_json::Value {
    let mut node = serde_json::json!({ "id": "leaf", "kind": "text", "label": "deep" });
    for i in (0..levels).rev() {
        node = serde_json::json!({ "id": format!("g{i}"), "kind": "group", "label": format!("G{i}"), "children": [node] });
    }
    node
}

fn render(jinja: &str, nodes: serde_json::Value) -> Result<String, minijinja::Error> {
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    let ctx = serde_json::json!({ "nodes": nodes, "_props": { "nodes": nodes } });
    env.render_str(jinja, minijinja::Value::from_serialize(&ctx))
}

/// C5: the template parses and renders a 3-level tree through brust-jinja; past 32 levels the render fails naming the
/// component and the cap.
#[test]
fn the_macro_renders_a_tree_and_stops_past_the_cap() {
    let tree = ok(PAGE, &[("NodeView.tsx", NODE_VIEW)]);
    let page = &tree[0].jinja;
    let html = render(
        page,
        serde_json::json!([chain(3), { "id": "z", "kind": "text", "label": "z" }]),
    )
    .unwrap_or_else(|e| panic!("{e:#}\n{page}"));
    for id in ["g0", "g1", "g2", "leaf", "z"] {
        assert!(html.contains(&format!("data-id=\"{id}\"")), "{id}: {html}");
    }
    assert!(html.contains(">deep</p>"), "{html}");
    assert!(html.starts_with("<main>"), "{html}");
    assert!(
        html.contains("<section data-id=\"g0\"><h2>G0</h2>"),
        "{html}"
    );
    assert!(!html.contains("macro"), "{html}");
    // 32 nested levels (31 groups and the text node) is the deepest the cap lets through
    render(page, serde_json::json!([chain(31)])).unwrap_or_else(|e| panic!("{e:#}"));
    assert!(render(page, serde_json::json!([chain(32)])).is_err());
    let e = render(page, serde_json::json!([chain(40)])).unwrap_err();
    assert!(
        format!("{e:#}").contains("<NodeView> nested more than 32 levels"),
        "{e:#}"
    );
}
