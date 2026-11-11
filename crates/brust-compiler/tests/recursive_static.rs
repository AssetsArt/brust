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

/// A loop item spread into the self-call is refused by the generic spread rule first (F31): NodeView is React for
/// that reason, and the recursion check (eligible = final tier Static, C3) stays silent.
#[test]
fn a_loop_item_spread_is_the_spread_rules_refusal() {
    let nv = NODE_VIEW.replace(
        "<NodeView key={c.id} n={c} />",
        "<NodeView key={c.id} {...c} />",
    );
    let tree = ok(PAGE, &[("NodeView.tsx", nv.as_str())]);
    let c = one(&tree, "NodeView.tsx");
    assert!(c.is_react(), "{}", c.ir);
    assert!(c.ir.get("recursion").is_none(), "{}", c.ir);
    assert!(
        c.diagnostics.iter().any(|d| d.rule == "spread-props"),
        "{:?}",
        c.diagnostics
    );
    assert!(
        !c.diagnostics
            .iter()
            .any(|d| d.rule == "recursion-unsupported"),
        "{:?}",
        c.diagnostics
    );
}

/// A spread the generic rule accepts (the component's own `...rest`) into the self-call is the recursion check's
/// refusal: the macro call cannot name each prop.
#[test]
fn a_rest_spread_into_its_own_call_refuses_the_recursion() {
    let nv = NODE_VIEW
        .replace("NodeView({ n }: any)", "NodeView({ n, ...rest }: any)")
        .replace(
            "<NodeView key={c.id} n={c} />",
            "<NodeView key={c.id} n={c} {...rest} />",
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
    env.render_str(jinja, minijinja::Value::from(minijinja::value::Serde(&ctx)))
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

/// F515 (review 98770491): the rows of a fixed list (a module const nothing writes) are the server's for good, so a
/// recursive call as the single node of such a row, in a native page, prints the macro per row: never a build Error.
const FIXED_PAGE: &str = "import { useState } from 'react'\nimport { NodeView } from './NodeView'\nconst NODES = [{ id: 'a', kind: 'group', label: 'A', children: [{ id: 'b', kind: 'group', label: 'B', children: [{ id: 'c', kind: 'text', label: 'deep' }] }] }, { id: 'z', kind: 'text', label: 'z' }]\nexport default function P() { const [k, setK] = useState(0); return <main><button onClick={() => setK(k + 1)}>{k}</button>{NODES.map((n: any) => ROW)}</main> }";

fn fixed_tree(row: &str) -> Vec<Compiled> {
    let page = FIXED_PAGE.replace("ROW", row);
    let tree =
        compile(&page, &[("NodeView.tsx", NODE_VIEW)]).unwrap_or_else(|d| panic!("{d:?}\n{page}"));
    for c in &tree {
        assert!(
            !c.diagnostics.iter().any(|d| d.class == DiagClass::Error),
            "a build Error, not a fallback: {}: {:?}",
            c.source,
            c.diagnostics
        );
    }
    tree
}

#[test]
fn a_recursive_row_of_a_fixed_list_prints_the_macro_per_row() {
    let tree = fixed_tree("<NodeView key={n.id} n={n} />");
    let p = &tree[0];
    assert_eq!(p.ir["tier"], "Native", "{}", p.ir);
    let nv = one(&tree, "NodeView.tsx");
    assert_eq!(nv.ir["tier"], "Static", "{}", nv.ir);
    assert_eq!(nv.ir["recursion"], serde_json::json!(["n"]), "{}", nv.ir);
    assert_eq!(macros(&p.jinja), 1, "{}", p.jinja);
    assert!(!p.jinja.contains("x-for"), "server rows: {}", p.jinja);
    let html =
        render(&p.jinja, serde_json::json!([])).unwrap_or_else(|e| panic!("{e:#}\n{}", p.jinja));
    for id in ["a", "b", "c", "z"] {
        assert!(html.contains(&format!("data-id=\"{id}\"")), "{html}");
    }
    assert!(html.contains(">deep</p>"), "{html}");
}

/// The same fixed row passing a value that changes on the client: a fallback with the reason, never a build Error.
#[test]
fn a_recursive_row_of_a_fixed_list_with_a_reactive_prop_falls_back() {
    let tree = fixed_tree("<NodeView key={n.id} n={n} k={k} />");
    let p = &tree[0];
    assert!(p.is_react(), "{}", p.ir);
    let d = p
        .diagnostics
        .iter()
        .find(|d| d.rule == "recursion-unsupported")
        .unwrap_or_else(|| panic!("{:?}", p.diagnostics));
    assert_eq!(d.class, DiagClass::Fallback);
}

/// A fixed list whose rows carry `x-for` for a handler that reads the row, with the recursive call inside: the client
/// adopts the server's rows and never re-creates them (F515), so the macro prints in each server row and the blank
/// zero-row template holds no call. A correct render, never a build Error.
#[test]
fn a_recursive_call_in_an_x_for_row_of_a_fixed_list_prints_in_the_server_rows() {
    let tree =
        fixed_tree("<li key={n.id} onClick={() => setK(n.label.length)}><NodeView n={n} /></li>");
    let p = &tree[0];
    assert_eq!(p.ir["tier"], "Native", "{}", p.ir);
    assert!(p.jinja.contains("x-for=\"n in "), "{}", p.jinja);
    let blank = &p.jinja[p.jinja.find("{% else %}<!--x-for-->").unwrap()..];
    assert!(
        !blank[..blank.find("{% endfor %}").unwrap()].contains("__rc_"),
        "{}",
        p.jinja
    );
    assert_eq!(macros(&p.jinja), 1, "{}", p.jinja);
    let html =
        render(&p.jinja, serde_json::json!([])).unwrap_or_else(|e| panic!("{e:#}\n{}", p.jinja));
    for id in ["a", "b", "c", "z"] {
        assert!(html.contains(&format!("data-id=\"{id}\"")), "{html}");
    }
}

/// F528: a non-root component that maps its props to a recursive component. Its props could change on the client (it
/// is not the route), so its rows are ones the browser re-creates and the shared copy falls back; a call site whose
/// props are fixed (loader data, a literal) gets a fixed-props clone where those rows are the server's: static.
const BODY: &str = "import { NodeView } from './NodeView'\nexport function Body({ nodes }: any) { return <main>{nodes.map((n: any) => <NodeView key={n.id} n={n} />)}</main> }";

fn tiers(tree: &[Compiled]) -> Vec<(String, String, serde_json::Value)> {
    tree.iter()
        .map(|c| (c.source.clone(), c.id.clone(), c.ir["tier"].clone()))
        .collect()
}

/// Every lowered component is static, the page prints one macro and no island, and no fallback is left.
fn assert_all_static(tree: &[Compiled]) {
    assert_clean(tree);
    for c in tree {
        assert_eq!(c.ir["tier"], "Static", "{}: {:?}", c.source, tiers(tree));
    }
    let page = &tree[0];
    assert_eq!(macros(&page.jinja), 1, "{}", page.jinja);
    assert!(!page.jinja.contains("<brust-island"), "{}", page.jinja);
    assert!(!page.jinja.contains("x-data"), "{}", page.jinja);
}

/// A1: the page hands loader data to `Body`, which maps it to the recursive `NodeView`.
#[test]
fn a_props_fed_wrapper_of_a_recursive_list_is_static_through_a_fixed_clone() {
    let page = "import { Body } from './Body'\nexport default function P({ page }: any) { return <Body nodes={page.nodes} /> }";
    let tree = ok(page, &[("NodeView.tsx", NODE_VIEW), ("Body.tsx", BODY)]);
    assert_all_static(&tree);
    // the page renders the tree through brust-jinja
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    let nodes = serde_json::json!([chain(2), { "id": "z", "kind": "text", "label": "z" }]);
    let ctx =
        serde_json::json!({ "page": { "nodes": nodes }, "_props": { "page": { "nodes": nodes } } });
    let html = env
        .render_str(
            &tree[0].jinja,
            minijinja::Value::from(minijinja::value::Serde(&ctx)),
        )
        .unwrap_or_else(|e| panic!("{e:#}\n{}", tree[0].jinja));
    for id in ["g0", "g1", "leaf", "z"] {
        assert!(html.contains(&format!("data-id=\"{id}\"")), "{id}: {html}");
    }
    assert!(html.starts_with("<main>"), "{html}");
}

/// A2: the same wrapper fed a literal array.
#[test]
fn a_literal_fed_wrapper_of_a_recursive_list_is_static() {
    let page = "import { Body } from './Body'\nexport default function P() { return <Body nodes={[{ id: 'a', kind: 'text', label: 'A' }]} /> }";
    let tree = ok(page, &[("NodeView.tsx", NODE_VIEW), ("Body.tsx", BODY)]);
    assert_all_static(&tree);
}

/// A3: fed a value that changes on the client the wrapper's rows are the browser's: it falls back as before.
#[test]
fn a_state_fed_wrapper_of_a_recursive_list_still_falls_back() {
    let page = "import { useState } from 'react'\nimport { Body } from './Body'\nexport default function P({ page }: any) { const [k, setK] = useState(page.nodes); return <div><button onClick={() => setK([])}>x</button><Body nodes={k} /></div> }";
    let tree = ok(page, &[("NodeView.tsx", NODE_VIEW), ("Body.tsx", BODY)]);
    let body = one(&tree, "Body.tsx");
    assert!(body.is_react(), "{:?}", tiers(&tree));
    assert!(
        body.diagnostics
            .iter()
            .any(|d| d.rule == "recursion-unsupported" && d.class == DiagClass::Fallback),
        "{:?}",
        body.diagnostics
    );
    assert!(
        !body.id.contains("_f"),
        "no fixed clone: {:?}",
        tiers(&tree)
    );
}

/// A4: two call sites, one fixed (the page's loader data) and one state-fed (inside a stateful `Panel`; state handed to
/// it straight from the page would make the page itself React): the fixed one is a static clone, the other keeps the
/// shared React copy.
#[test]
fn only_the_fixed_call_site_of_a_recursive_list_wrapper_is_cloned() {
    let panel = "import { useState } from 'react'\nimport { Body } from './Body'\nexport function Panel({ start }: any) { const [k, setK] = useState(start); return <div><button onClick={() => setK([])}>x</button><Body nodes={k} /></div> }";
    let page = "import { Body } from './Body'\nimport { Panel } from './Panel'\nexport default function P({ page }: any) { return <div><Body nodes={page.nodes} /><Panel start={page.nodes} /></div> }";
    let tree = ok(
        page,
        &[
            ("NodeView.tsx", NODE_VIEW),
            ("Body.tsx", BODY),
            ("Panel.tsx", panel),
        ],
    );
    assert!(!tree[0].is_react(), "{:?}", tiers(&tree));
    assert!(one(&tree, "Panel.tsx").is_react(), "{:?}", tiers(&tree));
    let bodies: Vec<&Compiled> = tree.iter().filter(|c| c.source == "Body.tsx").collect();
    assert_eq!(bodies.len(), 2, "{:?}", tiers(&tree));
    let clone = bodies
        .iter()
        .find(|c| c.id.contains("_f"))
        .unwrap_or_else(|| panic!("{:?}", tiers(&tree)));
    assert_eq!(clone.ir["tier"], "Static", "{:?}", tiers(&tree));
    let shared = bodies
        .iter()
        .find(|c| !c.id.contains("_f"))
        .unwrap_or_else(|| panic!("{:?}", tiers(&tree)));
    assert!(shared.is_react(), "{:?}", tiers(&tree));
    assert!(
        shared
            .diagnostics
            .iter()
            .any(|d| d.rule == "recursion-unsupported"),
        "{:?}",
        shared.diagnostics
    );
}

/// A5: a page → sections → section by type → custom section mapping nodes → element by kind (a group arm renders
/// itself). Every level is a non-root component fed the route's loader data.
const ELEMENT_VIEW: &str = r#"export function ElementView({ n }: any) {
  switch (n.kind) {
    case 'group':
      return (
        <div data-id={n.id} class="group">
          {(n.children ?? []).map((c: any) => (
            <ElementView key={c.id} n={c} />
          ))}
        </div>
      )
    case 'image':
      return <img data-id={n.id} src={n.src} alt={n.alt ?? ''} />
    default:
      return <p data-id={n.id}>{n.text}</p>
  }
}
"#;
const CUSTOM_SECTION_VIEW: &str = "import { ElementView } from './ElementView'\nexport function CustomSectionView({ nodes }: any) { return <div class=\"custom\">{nodes.map((n: any) => <ElementView key={n.id} n={n} />)}</div> }";
const SECTION_VIEW: &str = r#"import { CustomSectionView } from './CustomSectionView'
export function SectionView({ s }: any) {
  switch (s.type) {
    case 'hero':
      return <header data-id={s.id}><h1>{s.title}</h1></header>
    case 'custom':
      return <section data-id={s.id}><CustomSectionView nodes={s.nodes ?? []} /></section>
    default:
      return null
  }
}
"#;
const PAGE_VIEW: &str = "import { SectionView } from './SectionView'\nexport function PageView({ sections }: any) { return <article>{sections.map((s: any) => <SectionView key={s.id} s={s} />)}</article> }";
const CHAIN_PAGE: &str = "import { PageView } from './PageView'\nexport default function P({ page }: any) { return <PageView sections={page.sections} /> }";

#[test]
fn a_page_section_element_chain_with_a_recursive_element_is_static() {
    let tree = ok(
        CHAIN_PAGE,
        &[
            ("ElementView.tsx", ELEMENT_VIEW),
            ("CustomSectionView.tsx", CUSTOM_SECTION_VIEW),
            ("SectionView.tsx", SECTION_VIEW),
            ("PageView.tsx", PAGE_VIEW),
        ],
    );
    assert_all_static(&tree);
}

/// A5 variant: the custom arm holds the list inline instead of through `CustomSectionView`.
#[test]
fn a_section_arm_with_an_inline_recursive_list_is_static() {
    let section = r#"import { ElementView } from './ElementView'
export function SectionView({ s }: any) {
  switch (s.type) {
    case 'hero':
      return <header data-id={s.id}><h1>{s.title}</h1></header>
    case 'custom':
      return <section data-id={s.id}>{(s.nodes ?? []).map((n: any) => <ElementView key={n.id} n={n} />)}</section>
    default:
      return null
  }
}
"#;
    let tree = ok(
        CHAIN_PAGE,
        &[
            ("ElementView.tsx", ELEMENT_VIEW),
            ("SectionView.tsx", section),
            ("PageView.tsx", PAGE_VIEW),
        ],
    );
    assert_all_static(&tree);
}

/// A5 with a plain member prop: `nodes={s.nodes}` (the main chain hands `s.nodes ?? []`, an expression over props the
/// shared copy cannot hand to the React `CustomSectionView`: `island-prop`, cleared by the clone as well).
#[test]
fn a_section_chain_with_a_plain_member_prop_is_static() {
    let tree = ok(
        CHAIN_PAGE,
        &[
            ("ElementView.tsx", ELEMENT_VIEW),
            ("CustomSectionView.tsx", CUSTOM_SECTION_VIEW),
            (
                "SectionView.tsx",
                &SECTION_VIEW.replace("s.nodes ?? []", "s.nodes"),
            ),
            ("PageView.tsx", PAGE_VIEW),
        ],
    );
    assert_all_static(&tree);
}

/// Negative for `island-prop`: an expression over props handed to a child with its own state keeps that child React,
/// so the section's clone is not static and the shared React copy stays.
#[test]
fn an_expression_prop_to_a_stateful_child_still_falls_back() {
    // useTransition keeps Counter a React island (a stateful native child takes the expression as a plain prop)
    let counter = "import { useReducer, useTransition } from 'react'\nexport function Counter({ nodes }: any) { useTransition(); const [c, hit] = useReducer((x: number) => x + 1, 0); return <button onClick={() => hit()}>{nodes.length + c}</button> }";
    let section = "import { Counter } from './Counter'\nexport function SectionView({ s }: any) { return <section data-id={s.id}><Counter nodes={s.nodes ?? []} /></section> }";
    let page = "import { SectionView } from './SectionView'\nexport default function P({ page }: any) { return <SectionView s={page.s} /> }";
    let tree = ok(
        page,
        &[("Counter.tsx", counter), ("SectionView.tsx", section)],
    );
    let sv = one(&tree, "SectionView.tsx");
    assert!(sv.is_react(), "{:?}", tiers(&tree));
    assert!(!sv.id.contains("_f"), "no static clone: {:?}", tiers(&tree));
    assert!(
        sv.diagnostics.iter().any(|d| d.rule == "island-prop"),
        "{:?}",
        sv.diagnostics
    );
}
