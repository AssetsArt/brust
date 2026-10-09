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

/// F39: useId is a server-seeded value, not a fallback.
#[test]
fn use_id_is_seeded_from_the_server_context() {
    let ir = analyze(
        "import { useId, useState } from 'react'\nexport default function Field(props: { label: string }) { const id = useId(); const [v, setV] = useState(''); return <div><label htmlFor={id}>{props.label}</label><input id={id} value={v} onChange={e => setV(e.target.value)} /></div> }",
    );
    assert_eq!(ir.use_id_slots, 1);
    assert!(
        !rules(&ir).iter().any(|(_, r)| r == "use-id-in-render"),
        "{:?}",
        rules(&ir)
    );
    assert!(matches!(ir.tier, Tier::Native { .. }), "{:?}", ir.tier);
}

/// Finding 5: refs read during render are not job code.
#[test]
fn ref_in_render_falls_back() {
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

/// F37: a plain memo() wrapper is unwrapped (spec §3).
#[test]
fn memo_default_export_is_unwrapped() {
    let ir = analyze(
        "import { memo, useState } from 'react'\nfunction Inner(props: { n: number }) { const [c, setC] = useState(props.n); return <button onClick={() => setC(c + 1)}>{c}</button> }\nexport default memo(Inner)",
    );
    assert!(
        matches!(ir.tier, Tier::Native { .. }),
        "{:?} {:?}",
        ir.tier,
        rules(&ir)
    );
}

#[test]
fn memo_with_comparator_is_unwrapped_and_forward_ref_is_not() {
    let a = analyze(
        "import { memo } from 'react'\nfunction I() { return <b/> }\nexport default memo(I, (x: any, y: any) => x.n === y.n)",
    );
    assert!(
        matches!(a.tier, Tier::Static | Tier::Native { .. }),
        "{:?}",
        rules(&a)
    );
    let b = analyze(
        "import { memo, forwardRef } from 'react'\nconst I = forwardRef((p: any, r: any) => <b ref={r}/>)\nexport default memo(I)",
    );
    assert!(
        rules(&b).contains(&(DiagClass::Fallback, "default-export-shape".into())),
        "{:?}",
        rules(&b)
    );
    let d = b
        .diagnostics
        .iter()
        .find(|d| d.rule == "default-export-shape")
        .unwrap();
    assert!(d.message.contains("memo() wraps"), "{}", d.message);
}

/// F41 (§8.1): a leftover directive and an incomplete effect dependency array are warnings.
#[test]
fn use_client_directive_is_a_warning() {
    let ir = analyze("'use client'\nexport default function A() { return <b/> }");
    assert!(
        rules(&ir).contains(&(DiagClass::Warning, "use-client-leftover".into())),
        "{:?}",
        rules(&ir)
    );
    assert!(
        matches!(ir.tier, Tier::Static),
        "warning only: {:?}",
        ir.tier
    );
}

#[test]
fn effect_missing_dep_is_a_warning_with_the_name() {
    let ir = analyze(
        "import { useState, useEffect } from 'react'\nexport default function A(props: { n: number }) { const [c] = useState(0); useEffect(() => { document.title = String(props.n + c) }, [c]); return <b/> }",
    );
    let d = ir
        .diagnostics
        .iter()
        .find(|d| d.rule == "effect-deps")
        .expect("effect-deps");
    assert_eq!(d.class, DiagClass::Warning);
    assert!(
        d.message.contains("`props`") && !d.message.contains("`c`"),
        "{}",
        d.message
    );
}

#[test]
fn effect_without_deps_array_or_with_all_deps_does_not_warn() {
    let none = analyze(
        "import { useEffect } from 'react'\nexport default function A(props: { n: number }) { useEffect(() => { document.title = String(props.n) }); return <b/> }",
    );
    assert!(
        !rules(&none).iter().any(|(_, r)| r == "effect-deps"),
        "{:?}",
        rules(&none)
    );
    let all = analyze(
        "import { useState, useEffect } from 'react'\nexport default function A(props: { n: number }) { const [c] = useState(0); useEffect(() => { document.title = String(props.n + c) }, [props.n, c]); return <b/> }",
    );
    assert!(
        !rules(&all).iter().any(|(_, r)| r == "effect-deps"),
        "{:?}",
        rules(&all)
    );
}

/// F42: a dynamic import() inside a class body inside a component falls back instead of panicking.
#[test]
fn dynamic_import_inside_a_class_body_falls_back() {
    let ir = analyze(
        "export default function A() {\n  class Loader { async load() { return import('./x') } static { void import('./y') } }\n  return <b onClick={() => new Loader().load()}/>\n}",
    );
    assert!(
        rules(&ir).contains(&(DiagClass::Fallback, "dynamic-import".into())),
        "{:?}",
        rules(&ir)
    );
}

#[test]
fn dynamic_import_in_a_class_expression_and_field_initialiser_falls_back() {
    let ir = analyze(
        "export default function A() {\n  const L = class { field = () => import('./x') }\n  return <b onClick={() => new L()}/>\n}",
    );
    assert!(
        rules(&ir).contains(&(DiagClass::Fallback, "dynamic-import".into())),
        "{:?}",
        rules(&ir)
    );
}

/// F35: a dynamic child of <script>/<style> falls back; literal text stays native.
#[test]
fn dynamic_child_of_script_or_style_falls_back() {
    let a = analyze(
        "export default function A(props: { js: string }) { return <div><script>{props.js}</script></div> }",
    );
    assert!(
        rules(&a).contains(&(DiagClass::Fallback, "raw-text-child".into())),
        "{:?}",
        rules(&a)
    );
    let b = analyze(
        "export default function B() { return <div><style>{`.a{color:red}`}</style></div> }",
    );
    assert!(
        !rules(&b).iter().any(|(_, r)| r == "raw-text-child"),
        "static text is fine: {:?}",
        rules(&b)
    );
    let c = analyze(
        "export default function C() { return <div><style>{'.a{color:red}'}</style><script>var x = 1</script></div> }",
    );
    assert!(
        !rules(&c).iter().any(|(_, r)| r == "raw-text-child"),
        "{:?}",
        rules(&c)
    );
}

/// Pre-READY review: a useId local named like a prop must not shadow it.
#[test]
fn use_id_named_like_a_prop_does_not_shadow_it() {
    let ir = analyze(
        "import { useId } from 'react'\nexport default function F(props: { id: string }) { const id = useId(); return <label htmlFor={id}>{props.id}</label> }",
    );
    assert!(
        !rules(&ir).iter().any(|(_, r)| r == "use-id-in-render"),
        "{:?}",
        rules(&ir)
    );
}

#[test]
fn only_a_closing_tag_in_static_script_text_falls_back() {
    for src in [
        "export default function A() { return <div><script>{'a </script> b'}</script></div> }",
        "export default function A() { return <div><style>{'x </STYLE> y'}</style></div> }",
    ] {
        let ir = analyze(src);
        assert!(
            rules(&ir).contains(&(DiagClass::Fallback, "raw-text-child".into())),
            "{src}: {:?}",
            rules(&ir)
        );
    }
}

#[test]
fn outlet_inside_a_condition_falls_back() {
    let ir = analyze(
        "import { Outlet } from '@brust/brust/routes'\nimport { useState } from 'react'\nexport default function L() { const [o, setO] = useState(false); return <div onClick={() => setO(!o)}>{o && <aside><Outlet/></aside>}</div> }",
    );
    assert!(
        rules(&ir).contains(&(DiagClass::Fallback, "outlet-in-branch".into())),
        "{:?}",
        rules(&ir)
    );
}

// ---- Mellow round 1 ----

#[test]
fn array_from_over_an_iterable_or_a_shadowed_array_is_not_a_list() {
    for src in [
        "export default function L(props: any) { return <ul>{Array.from(new Set(props.xs), (x: any) => <li key={x}>{x}</li>)}</ul> }",
        "const Array = { from: (a: any, f: any) => [f(a[0], 0)] }\nexport default function L(props: any) { return <ul>{Array.from(props.xs, (x: any) => <li key={x}>{x}</li>)}</ul> }",
        "export default function L(props: any) { const Array = { from: (a: any, f: any) => [f(a[0], 0)] }; return <ul>{Array.from(props.xs, (x: any) => <li key={x}>{x}</li>)}</ul> }",
    ] {
        let ir = analyze(src);
        assert!(
            rules(&ir).contains(&(DiagClass::Fallback, "jsx-expression".into())),
            "{src}: {:?}",
            rules(&ir)
        );
    }
}

#[test]
fn a_printer_panic_in_module_scope_is_a_fallback_not_a_silent_sentinel() {
    let ir = analyze(
        "const m = require('./x')\nexport default function A() { return <b onClick={() => m.go()}/> }",
    );
    // `require` itself prints; this pins that no sentinel survives without a diagnostic.
    let sentinel = format!("{:?}", ir.module_decls).contains("dynamic import");
    assert!(
        !sentinel
            || rules(&ir)
                .iter()
                .any(|(_, r)| r == "printer-panic" || r == "dynamic-import"),
        "{:?}",
        rules(&ir)
    );
}

#[test]
fn job_inputs_name_the_list_not_its_length() {
    let ir = analyze(
        "import { fmt } from './money'\nexport default function C(props: { items: number[] }) { return <p>{fmt(props.items.length, 'x')}</p> }",
    );
    let job = ir
        .jobs
        .iter()
        .find(|j| matches!(j.kind, JobKind::Precompute))
        .unwrap();
    assert_eq!(job.inputs, vec!["items".to_string()]);
}

#[test]
fn outlet_in_a_react_tier_component_is_an_error() {
    let ir = analyze(
        "import { Outlet } from '@brust/brust/routes'\nimport { useReducer } from 'react'\nexport default function L() { const [s] = useReducer((a: number) => a, 0); return <div>{s}<Outlet/></div> }",
    );
    assert!(
        rules(&ir).contains(&(DiagClass::Error, "outlet-in-react".into())),
        "{:?}",
        rules(&ir)
    );
}
