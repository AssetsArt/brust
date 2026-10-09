//! M1b-2 Task 1: dependency classification over RawExpr.
use brust_compiler::analyze::component::analyze_component;
use brust_compiler::analyze::passes::deps::{Deps, deps_of};
use brust_compiler::ir::*;
use brust_compiler::parse::{parse_tsx, run_on_compiler_thread};

fn ir(src: &str) -> ComponentIR {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        let p = parse_tsx("D.tsx", s.into_bytes()).unwrap();
        analyze_component(&p).unwrap()
    })
}

fn derived<'a>(ir: &'a ComponentIR, name: &str) -> &'a RawExpr {
    match &ir.derived.iter().find(|d| d.name == name).unwrap().expr {
        Expr::Raw(r) => r,
        e => panic!("{e:?}"),
    }
}

fn set(xs: &[&str]) -> std::collections::BTreeSet<String> {
    xs.iter().map(|s| s.to_string()).collect()
}

/// Review Focus 1: `b` is props-only through `a`.
#[test]
fn derived_chain_is_props_only() {
    let ir = ir(
        "export default function C(props: any) { const a = props.x + 1; const b = a * 2; return <p>{b}</p> }",
    );
    let d = deps_of(derived(&ir, "b"), &ir, &[]);
    assert_eq!(d.props, set(&["x"]));
    assert!(d.state.is_empty());
    assert!(!d.opaque);
}

#[test]
fn state_through_a_ternary() {
    let ir = ir(
        "import { useState } from 'react'\nexport default function T() { const [mode, setMode] = useState('dark'); const label = mode === 'dark' ? 'Light' : 'Dark'; return <b onClick={() => setMode('x')}>{label}</b> }",
    );
    let d = deps_of(derived(&ir, "label"), &ir, &[]);
    assert_eq!(d.state, set(&["mode"]));
    assert!(d.props.is_empty());
}

#[test]
fn member_paths_and_imports() {
    let ir = ir(
        "import { fmt } from './money'\nexport default function P({ a }: any) { const s = fmt(a.price); const u = a.name.toUpperCase(); const i = a.tags[0]; return <p>{s}{u}{i}</p> }",
    );
    let s = deps_of(derived(&ir, "s"), &ir, &[]);
    assert_eq!(s.props, set(&["a.price"]));
    assert_eq!(
        s.imports.into_iter().collect::<Vec<_>>(),
        [("./money".to_string(), "fmt".to_string())]
    );
    // A method call reads its receiver; an index truncates at the last member.
    assert_eq!(deps_of(derived(&ir, "u"), &ir, &[]).props, set(&["a.name"]));
    assert_eq!(deps_of(derived(&ir, "i"), &ir, &[]).props, set(&["a.tags"]));
}

#[test]
fn browser_globals_and_module_locals() {
    let ir = ir(
        "const TAX = 2\nexport default function W() { const w = window.innerWidth * TAX; const m = Math.max(1, 2); return <p>{w}{m}</p> }",
    );
    let w = deps_of(derived(&ir, "w"), &ir, &[]);
    assert!(w.browser);
    assert_eq!(w.module_locals, set(&["TAX"]));
    let m = deps_of(derived(&ir, "m"), &ir, &[]);
    assert!(!m.browser);
    assert_eq!(m.globals, set(&["Math"]));
}

#[test]
fn opaque_reads_through_captures_and_arrows_skip_params() {
    let ir = ir(
        "export default function O({ item }: any) { const d = new Date(item.at); const f = (x: number) => x + item.price; return <p>{d}{f}</p> }",
    );
    let d = deps_of(derived(&ir, "d"), &ir, &[]);
    assert!(d.opaque);
    assert_eq!(d.props, set(&["item"]));
    let f = deps_of(derived(&ir, "f"), &ir, &[]);
    assert_eq!(f.props, set(&["item.price"]));
    assert!(f.module_locals.is_empty(), "{f:?}");
}

#[test]
fn loop_bindings_and_whole_props() {
    let ir = ir(
        "export default function L(props: any) { return <ul>{props.items.map((i: any) => <li key={i.id}>{i.name}{props}</li>)}</ul> }",
    );
    let Node::Element { children, .. } = &ir.template else {
        panic!()
    };
    let Node::For { source, body, .. } = &children[0] else {
        panic!("{children:?}")
    };
    let Expr::Raw(source) = source else { panic!() };
    assert_eq!(deps_of(source, &ir, &[]).props, set(&["items"]));
    let Node::Element { children, .. } = &body[0] else {
        panic!()
    };
    let Node::Slot(Expr::Raw(name)) = &children[0] else {
        panic!()
    };
    let d: Deps = deps_of(name, &ir, &["i".into()]);
    assert_eq!(d.loop_bindings, set(&["i"]));
    assert!(d.props.is_empty());
    let Node::Slot(Expr::Raw(all)) = &children[1] else {
        panic!()
    };
    assert_eq!(deps_of(all, &ir, &[]).prop_paths(), ["*"]);
}

/// `list.length` reads the whole list: the client is seeded with JSON, which has no `length` key.
#[test]
fn trailing_length_reads_the_whole_prop() {
    let ir = ir(
        "export default function C(props: any) { const n = props.rows.length + props.cfg.size.length; return <p>{n}</p> }",
    );
    let d = deps_of(derived(&ir, "n"), &ir, &[]);
    assert_eq!(d.props, set(&["cfg.size", "rows"]));
}
