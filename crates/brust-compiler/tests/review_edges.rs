//! Regressions from the pre-READY review of the M1b-2 lane: each test pins
//! one shape that used to produce silently wrong IR.
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_source, analyze_with};
use brust_compiler::analyze::modules::ModuleCache;
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;
use std::path::PathBuf;

fn analyze_opts(path: &str, src: &str, opts: AnalyzeOptions) -> ComponentIR {
    let (p, s) = (path.to_string(), src.to_string());
    run_on_compiler_thread(move || analyze_source(&p, s.into_bytes(), &opts).unwrap())
}

fn analyze(src: &str) -> ComponentIR {
    analyze_opts("T.tsx", src, AnalyzeOptions::default())
}

/// A scratch root with the given files.
fn root(name: &str, files: &[(&str, &str)]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("brustc-m1b2-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    for (path, text) in files {
        let p = dir.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    dir
}

fn rules(ir: &ComponentIR) -> Vec<(DiagClass, String)> {
    ir.diagnostics
        .iter()
        .map(|d| (d.class, d.rule.clone()))
        .collect()
}

const COUNTER: &str = "export default function Counter({ n, set }: any) { return <button onClick={() => set(n + 1)}>{n}</button> }";

/// Finding 1: a setter or an opaque function passed to a child is client code.
#[test]
fn setter_and_opaque_function_props_are_client_only() {
    let dir = root("setter", &[("Counter.tsx", COUNTER)]);
    let ir = analyze_opts(
        "P.tsx",
        "import { useState } from 'react'\nimport Counter from './Counter'\nexport default function P() { const [n, setN] = useState(0); return <div><Counter n={1} set={setN} /><Counter n={2} set={async () => {}} /></div> }",
        AnalyzeOptions {
            root: dir,
            ..Default::default()
        },
    );
    assert!(ir.jobs.is_empty(), "{:?}", ir.jobs);
    assert_eq!(ir.child_links.len(), 2);
    assert!(matches!(&ir.child_links[0].props[1].1, Expr::ClientOnly { js } if js == "setN"));
    assert!(matches!(
        ir.child_links[1].props[1].1,
        Expr::ClientOnly { .. }
    ));
}

/// Finding 2: props read by state-dependent template values and by linked
/// child props are client props.
#[test]
fn reactive_server_values_and_link_props_capture_props() {
    let ir = analyze(
        "import { useState } from 'react'\nexport default function P({ prefix }: any) { const [n, setN] = useState(0); return <b onClick={() => setN(1)}>{prefix + n}</b> }",
    );
    assert_eq!(ir.client_props, ["prefix"]);
    let dir = root("linkprops", &[("Counter.tsx", COUNTER)]);
    let ir = analyze_opts(
        "P.tsx",
        "import { useState } from 'react'\nimport Counter from './Counter'\nexport default function P({ step }: any) { const [n, setN] = useState(0); return <div><Counter n={n} set={step} /></div> }",
        AnalyzeOptions {
            root: dir,
            ..Default::default()
        },
    );
    assert_eq!(ir.client_props, ["step"]);
}

/// Finding 3: a slot in a list whose source is state is state-dependent and
/// the job reads what the state initializer reads.
#[test]
fn slots_in_a_stateful_list_are_state_dependent() {
    let ir = analyze(
        "import { useState } from 'react'\nimport { fmt } from './money'\nexport default function P({ initial }: any) { const [items, setItems] = useState(initial); return <ul onClick={() => setItems([])}>{items.map((i: any) => <li key={i.id}>{fmt(i.price)}</li>)}</ul> }",
    );
    let Node::Element { children, .. } = &ir.template else {
        panic!()
    };
    let Node::For { body, .. } = &children[0] else {
        panic!()
    };
    let Node::Element { children, .. } = &body[0] else {
        panic!()
    };
    assert!(matches!(
        &children[0],
        Node::Slot(Expr::Precomputed { state_dependent: true, per_item: Some(p), client_js: Some(_), .. }) if p == "i"
    ));
    assert_eq!(ir.jobs[0].inputs, ["initial"]);
    assert_eq!(ir.client_props, ["initial"]);
}

/// Finding 5: refs and useId values read during render are not job code.
#[test]
fn ref_and_use_id_in_render_fall_back() {
    let ir = analyze(
        "import { useId } from 'react'\nexport default function P() { const id = useId(); return <label htmlFor={id}>x</label> }",
    );
    assert!(rules(&ir).contains(&(DiagClass::Fallback, "use-id-in-render".into())));
    assert!(
        ir.jobs
            .iter()
            .all(|j| !matches!(j.kind, JobKind::Precompute))
    );
    let ir = analyze(
        "import { useRef } from 'react'\nexport default function P() { const r = useRef(1); return <p ref={r}>{r.current}</p> }",
    );
    assert!(rules(&ir).contains(&(DiagClass::Fallback, "ref-in-render".into())));
}

/// Finding 6: a props-only slot runs in the job, so its server-only import
/// does not leak into a state-dependent value that reads it.
#[test]
fn props_only_slot_imports_stay_on_the_server() {
    let ir = analyze_opts(
        "P.tsx",
        "import { useState } from 'react'\nimport { db } from 'node:sqlite'\nimport { fmt } from './money'\nexport default function P({ id }: any) { const [q, setQ] = useState(1); const price = db.price(id); const total = fmt(price, q); return <b onClick={() => setQ(q + 1)}>{total}</b> }",
        AnalyzeOptions::default(),
    );
    assert!(
        !rules(&ir).iter().any(|(_, r)| r == "server-only-in-client"),
        "{:?}",
        ir.diagnostics
    );
    assert_eq!(
        ir.client_imports,
        [("./money".to_string(), "fmt".to_string())]
    );
    assert_eq!(ir.client_props, ["id"]);
}

/// Finding 7: `serverOnly` prefixes match relative imports by resolved path.
#[test]
fn server_only_prefix_matches_a_relative_import() {
    let ir = analyze_opts(
        "src/app/P.tsx",
        "import { useState } from 'react'\nimport { save } from '../server/db'\nexport default function P() { const [n, setN] = useState(0); return <b onClick={() => save(n)}>{n}</b> }",
        AnalyzeOptions {
            server_only: vec!["src/server/".into()],
            ..Default::default()
        },
    );
    assert!(rules(&ir).contains(&(DiagClass::Error, "server-only-in-client".into())));
}

/// Finding 8: a named import that is not a function declaration makes the
/// child an island (Fallback), not a failed build.
#[test]
fn named_non_function_child_is_an_island() {
    let dir = root(
        "named",
        &[("ui.tsx", "export const Button = () => <button/>\n")],
    );
    let ir = analyze_opts(
        "P.tsx",
        "import { Button } from './ui'\nexport default function P() { return <div><Button /></div> }",
        AnalyzeOptions {
            root: dir,
            ..Default::default()
        },
    );
    assert!(rules(&ir).contains(&(DiagClass::Fallback, "child-component".into())));
    assert!(!rules(&ir).iter().any(|(c, _)| *c == DiagClass::Error));
    assert_eq!(ir.tier, Tier::Static);
    assert!(matches!(ir.children[0].tier, Tier::React { .. }));
}

/// Finding 9: `?.[i]` is not read as a plain index; continuations print `.`.
#[test]
fn optional_chains_keep_their_meaning() {
    let ir =
        analyze("export default function P({ a }: any) { return <p title={a?.b.c}>{a?.[0]}</p> }");
    let Node::Element {
        attrs, children, ..
    } = &ir.template
    else {
        panic!()
    };
    let Attr::Dynamic {
        value: Expr::Server(ServerExpr(t)),
        ..
    } = &attrs[0]
    else {
        panic!("{attrs:?}")
    };
    assert_eq!(t.to_js(), "a?.b.c");
    assert!(matches!(&children[0], Node::Slot(Expr::Precomputed { js, .. }) if js == "a?.[0]"));
}

/// Finding 10: link ids follow document order (parent before nested child).
#[test]
fn link_ids_follow_document_order() {
    let dir = root(
        "order",
        &[
            ("Counter.tsx", COUNTER),
            (
                "Card.tsx",
                "export default function Card({ t, children }: any) { return <section title={t}>{children}</section> }",
            ),
        ],
    );
    let ir = analyze_opts(
        "P.tsx",
        "import { useState } from 'react'\nimport Card from './Card'\nimport Counter from './Counter'\nexport default function P() { const [n, setN] = useState(0); return <div><Card t={n}><Counter n={n} set={setN} /></Card></div> }",
        AnalyzeOptions {
            root: dir,
            ..Default::default()
        },
    );
    let order: Vec<_> = ir
        .child_links
        .iter()
        .map(|l| (l.props_member.as_str(), l.child.split('_').next().unwrap()))
        .collect();
    assert_eq!(order, [("_p1", "card"), ("_p2", "counter")]);
}

/// Finding 12: the root path is normalised, so a child importing it back
/// hits the in-progress marker at once.
#[test]
fn cycle_is_seen_whatever_the_root_spelling() {
    let dir = root(
        "cycle",
        &[
            (
                "input.tsx",
                "import A from './A'\nexport default function Root() { return <div><A /></div> }",
            ),
            (
                "A.tsx",
                "import Root from './input'\nexport default function A() { return <p><Root /></p> }",
            ),
        ],
    );
    let (keys, a_rules) = run_on_compiler_thread(move || {
        let modules = std::cell::RefCell::new(ModuleCache::default());
        let opts = AnalyzeOptions {
            root: dir,
            ..Default::default()
        };
        analyze_with("./input.tsx", None, &opts, &modules).unwrap();
        let done = modules.borrow().done();
        let a = done.iter().find(|(k, _)| k == "A.tsx").unwrap().1.clone();
        (
            done.into_iter().map(|(k, _)| k).collect::<Vec<_>>(),
            a.diagnostics
                .iter()
                .map(|d| d.rule.clone())
                .collect::<Vec<_>>(),
        )
    });
    assert_eq!(keys, ["A.tsx", "input.tsx"]);
    assert!(a_rules.contains(&"import-cycle".to_string()));
}

/// Review round 1 B1 (probe r1): a lazy initializer seeds with its result.
#[test]
fn lazy_use_state_initializer_is_placed_by_its_result() {
    let ir = analyze(
        "import { useState } from 'react'\nexport default function R(props) {\n  const [n, setN] = useState(() => props.start * 2)\n  return <button onClick={() => setN(n + 1)}>{n}</button>\n}",
    );
    let Expr::Server(ServerExpr(init)) = &ir.state[0].init else {
        panic!("{:?}", ir.state[0].init)
    };
    assert_eq!(init.to_js(), "start * 2");
    let ir = analyze(
        "import { useState } from 'react'\nimport { load } from './load'\nexport default function R() {\n  const [n, setN] = useState(() => { const v = load(); return v })\n  return <button onClick={() => setN(1)}>{n}</button>\n}",
    );
    let Expr::Precomputed { js, .. } = &ir.state[0].init else {
        panic!("{:?}", ir.state[0].init)
    };
    assert!(js.starts_with("(() => {") && js.ends_with("})()"), "{js}");
}

/// Review round 1 B2 (probe r2): a module-level helper reached from a
/// handler carries its imports into the client and the server-only check.
#[test]
fn module_helpers_are_followed_transitively() {
    let ir = analyze(
        "import { useState } from 'react'\nimport { readFileSync } from 'node:fs'\nfunction load() { return readFileSync('/x', 'utf8') }\nfunction outer() { return load() }\nexport default function R() {\n  const [n, setN] = useState(0)\n  return <button onClick={() => setN(outer().length)}>{n}</button>\n}",
    );
    assert!(
        rules(&ir).contains(&(DiagClass::Error, "server-only-in-client".into())),
        "{:?}",
        ir.diagnostics
    );
    assert_eq!(
        ir.client_imports,
        [("node:fs".to_string(), "readFileSync".to_string())]
    );
    assert_eq!(ir.client_module_locals, ["load", "outer"]);
}

/// Review round 1 N1 (probe r3): only the parser's own runtime symbols are
/// hidden from captures, not user names spelled like them.
#[test]
fn user_names_spelled_like_the_jsx_runtime_are_captures() {
    let ir = analyze(
        "import { useState } from 'react'\nlet jsxLabel = 'hi'\nexport default function R() {\n  const [n, setN] = useState(0)\n  const FragmentName = 'x'\n  return <button onClick={() => setN(jsxLabel.length + FragmentName.length)}>{n}</button>\n}",
    );
    let RawKind::Arrow { captures, .. } = &ir.handlers[0].body.kind else {
        panic!()
    };
    let names: Vec<_> = captures.iter().map(|(n, _)| n.as_str()).collect();
    assert!(
        names.contains(&"jsxLabel") && names.contains(&"FragmentName"),
        "{names:?}"
    );
    assert_eq!(ir.client_module_locals, ["jsxLabel"]);
}

/// M1c input 1: module declarations keep their printed source (no `export`).
#[test]
fn module_declarations_keep_their_source() {
    let ir = analyze(
        "import { useState } from 'react'\nconst TAX = 2, RATE = 3\nexport function double(x: number) { return x * TAX }\nexport default function R() { const [n, setN] = useState(0); return <b onClick={() => setN(double(n))}>{n}</b> }",
    );
    let decls: Vec<_> = ir
        .module_decls
        .iter()
        .map(|d| (d.names.clone(), d.source.starts_with("export")))
        .collect();
    assert_eq!(
        decls[0],
        (vec!["TAX".to_string(), "RATE".to_string()], false)
    );
    assert_eq!(decls[1], (vec!["double".to_string()], false));
    assert!(ir.module_decls[1].source.starts_with("function double"));
    assert_eq!(ir.client_module_locals, ["TAX", "double"]);
    assert!(ir.structural.is_some());
}

/// F26: `useState(load)` with a module-level `function` seeds the call.
#[test]
fn use_state_with_a_module_function_seeds_its_call() {
    let ir = analyze(
        "import { useState } from 'react'\nfunction load() { return 41 + 1 }\nexport default function R() {\n  const [n, setN] = useState(load)\n  return <button onClick={() => setN(n + 1)}>{n}</button>\n}",
    );
    let init = match &ir.state[0].init {
        Expr::Precomputed { js, .. } | Expr::ClientOnly { js } => js.clone(),
        other => panic!("{other:?}"),
    };
    assert!(
        init.contains("load()"),
        "seeds the call, not the function: {init}"
    );
}

/// F31: a spread of props cannot be expanded by the template backend.
#[test]
fn spread_props_make_the_component_react() {
    for src in [
        "export default function R(props) { return <div {...props}>x</div> }",
        "import Child from './Child'\nexport default function R(props) { return <Child {...props} /> }",
    ] {
        let ir = analyze(src);
        assert!(
            rules(&ir).contains(&(DiagClass::Fallback, "spread-props".into())),
            "{:?}",
            ir.diagnostics
        );
        assert!(matches!(ir.tier, Tier::React { .. }), "{:?}", ir.tier);
    }
}

/// F38: a dynamic `import()` is a Fallback (tier react), never a printer panic —
/// at module level (`lazy(() => import(…))`) and inside a handler.
#[test]
fn dynamic_import_falls_back_instead_of_panicking() {
    let ir = analyze(
        &std::fs::read_to_string(format!(
            "{}/../../tests/fixtures/lazy-import/input.tsx",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap(),
    );
    assert!(
        rules(&ir).contains(&(DiagClass::Fallback, "dynamic-import".into())),
        "{:?}",
        ir.diagnostics
    );
    assert!(matches!(ir.tier, Tier::React { .. }), "{:?}", ir.tier);

    let ir = analyze(
        "import { useState } from 'react'\nexport default function C() {\n  const [m, setM] = useState(null)\n  return <button onClick={() => import('./x').then((v) => setM(v.default))}>{String(m)}</button>\n}",
    );
    assert!(
        rules(&ir).contains(&(DiagClass::Fallback, "dynamic-import".into())),
        "{:?}",
        ir.diagnostics
    );
    assert!(matches!(ir.tier, Tier::React { .. }), "{:?}", ir.tier);
}

/// S8: <Outlet/> imported from @brust/brust/routes is an intrinsic node, not a child component.
#[test]
fn outlet_from_brust_routes_is_an_intrinsic() {
    let ir = analyze(
        "import { Outlet } from '@brust/brust/routes'\nexport default function Layout() { return <div><Outlet/></div> }",
    );
    assert!(ir.uses_outlet);
    assert!(
        ir.children.is_empty(),
        "Outlet must not be recorded as a child: {:?}",
        ir.children
    );
    let json = serde_json::to_value(&ir).unwrap();
    assert_eq!(json["uses_outlet"], true);
}

/// An Outlet that is not the brust one is an ordinary (unresolvable) child → external-component fallback.
#[test]
fn outlet_from_elsewhere_is_a_normal_component() {
    let ir = analyze(
        "import { Outlet } from 'react-router'\nexport default function Layout() { return <div><Outlet/></div> }",
    );
    assert!(!ir.uses_outlet);
    assert!(
        rules(&ir).iter().any(|(_, r)| r == "external-component"),
        "{:?}",
        rules(&ir)
    );
}
