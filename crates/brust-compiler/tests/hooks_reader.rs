//! Hooks and body reader: analyze_component produces the structural IR.
use brust_compiler::analyze::component::analyze_component;
use brust_compiler::ir::*;
use brust_compiler::parse::{parse_tsx, run_on_compiler_thread};

fn ir(src: &str) -> ComponentIR {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        let p = parse_tsx("H.tsx", s.into_bytes()).unwrap();
        analyze_component(&p).unwrap()
    })
}

const PRE: &str = "import { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect, useId } from 'react'\n";

#[test]
fn theme_toggle_decls() {
    let ir = ir(&format!(
        "{PRE}export default function ThemeToggle({{ themeLabel }}: any) {{ const [mode, setMode] = useState('dark'); const label = mode === 'dark' ? 'Light' : 'Dark'; useEffect(() => {{ document.documentElement.dataset.mode = mode }}, [mode]); return <button aria-label={{themeLabel}} onClick={{() => setMode((m: string) => m === 'dark' ? 'light' : 'dark')}}>{{label}}</button> }}"
    ));
    assert_eq!(
        ir.props.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
        ["themeLabel"]
    );
    assert_eq!(ir.state.len(), 1);
    assert_eq!(ir.state[0].name, "mode");
    assert_eq!(ir.state[0].setter.as_deref(), Some("setMode"));
    assert_eq!(ir.derived.len(), 1);
    assert_eq!(ir.derived[0].name, "label");
    assert_eq!(ir.effects.len(), 1);
    assert!(!ir.effects[0].layout);
    assert_eq!(ir.effects[0].deps.as_ref().map(|d| d.len()), Some(1));
    assert_eq!(ir.handlers.len(), 1);
    assert_eq!(ir.handlers[0].name, "_h1");
    let Node::Element { attrs, host, .. } = &ir.template else {
        panic!()
    };
    assert!(host);
    assert!(attrs.iter().any(
        |a| matches!(a, Attr::Event { event, handler } if event == "click" && handler == "_h1")
    ));
    assert!(matches!(ir.tier, Tier::Pending));
    assert!(ir.diagnostics.is_empty(), "{:?}", ir.diagnostics);
    assert!(ir.id.starts_with("h_"));
}

#[test]
fn state_destructuring_variants() {
    let a = ir(&format!(
        "{PRE}export default function A() {{ const [n] = useState(0); const [, setM] = useState(1); return <p>{{n}}</p> }}"
    ));
    assert_eq!(a.state.len(), 2);
    assert_eq!(a.state[0].setter, None);
    assert_eq!(a.state[1].name, "");
    assert_eq!(a.state[1].setter.as_deref(), Some("setM"));
    assert!(a.diagnostics.is_empty(), "{:?}", a.diagnostics);
    let b = ir(&format!(
        "{PRE}export default function B() {{ const s = useState(0); return <p>{{s[0]}}</p> }}"
    ));
    assert!(b.diagnostics.iter().any(|d| d.rule == "hook-shape"));
    let c = ir(&format!(
        "{PRE}export default function C() {{ const [n, setN, extra] = useState(0); return <p>{{n}}</p> }}"
    ));
    assert!(c.diagnostics.iter().any(|d| d.rule == "hook-shape"));
    let d = ir(&format!(
        "{PRE}export default function D() {{ const [n, setN] = useState(); return <p>{{n}}</p> }}"
    ));
    assert!(matches!(
        &d.state[0].init,
        Expr::Raw(RawExpr {
            kind: RawKind::Lit(Literal::Undefined),
            ..
        })
    ));
}

#[test]
fn memo_callback_ref_id_layout() {
    let ir = ir(&format!(
        "{PRE}export default function M({{ a }}: any) {{ const r = useRef(null); const id = useId(); const dbl = useMemo(() => a * 2, [a]); const go = useCallback(() => 1, []); useLayoutEffect(() => {{}}); return <div ref={{r}} id={{id}} onClick={{go}}>{{dbl}}</div> }}"
    ));
    assert_eq!(ir.refs.len(), 1);
    assert!(ir.derived.iter().any(|d| d.name == "dbl"));
    assert!(ir.handlers.iter().any(|h| h.name == "go"));
    assert!(ir.effects[0].layout);
    assert_eq!(ir.effects[0].deps, None);
    assert_eq!(ir.id_bindings, ["id"]);
    let Node::Element {
        attrs, ref_name, ..
    } = &ir.template
    else {
        panic!()
    };
    assert_eq!(ref_name.as_deref(), Some("r"));
    assert!(
        attrs
            .iter()
            .any(|a| matches!(a, Attr::Event { handler, .. } if handler == "go"))
    );
    assert!(ir.diagnostics.is_empty(), "{:?}", ir.diagnostics);
}

#[test]
fn unsupported_hook_and_control_flow_record_react_reason() {
    let a = ir(
        "import { useContext } from 'react'\nconst C = null as any\nexport default function U() { const t = useContext(C); return <p>{t}</p> }",
    );
    assert!(
        a.diagnostics
            .iter()
            .any(|d| d.rule == "hook-unsupported" && d.message.contains("useContext"))
    );
    let b = ir(&format!(
        "{PRE}export default function V({{ x }}: any) {{ if (x) {{ return <p/> }} return <i/> }}"
    ));
    assert!(b.diagnostics.iter().any(|d| d.rule == "control-flow"));
    let c = ir(
        "import { useCart } from './cart'\nexport default function W() { const cart = useCart(); return <p>{cart}</p> }",
    );
    assert!(
        c.diagnostics
            .iter()
            .any(|d| d.rule == "hook-unsupported" && d.message.contains("useCart"))
    );
    let d = ir("export default function X() { let n = 1; return <p>{n}</p> }");
    assert!(d.diagnostics.iter().any(|d| d.rule == "let-var"));
}

#[test]
fn react_namespace_hooks_are_hooks() {
    let ir = ir(
        "import * as React from 'react'\nexport default function N() { const [n, setN] = React.useState(0); return <button onClick={() => setN(n + 1)}>{n}</button> }",
    );
    assert_eq!(ir.state.len(), 1);
    assert!(ir.diagnostics.is_empty(), "{:?}", ir.diagnostics);
}

#[test]
fn item_scoped_handler_records_bindings() {
    let ir = ir(&format!(
        "{PRE}export default function L({{ items }}: any) {{ const pick = (i: any) => i; return <ul>{{items.map((it: any) => <li key={{it.id}} onClick={{() => pick(it)}}>{{it.n}}</li>)}}</ul> }}"
    ));
    let h = ir.handlers.iter().find(|h| h.name == "_h1").unwrap();
    assert_eq!(h.item_scoped, vec!["it".to_string()]);
}

#[test]
fn function_declarations_and_plain_props() {
    let ir = ir(
        "export default function F(props: any) { function go() { return props.n } return <p onClick={go}>{props.title}</p> }",
    );
    assert_eq!(
        ir.props.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
        ["props"]
    );
    let go = ir.derived.iter().find(|d| d.name == "go").unwrap();
    assert!(matches!(
        &go.expr,
        Expr::Raw(RawExpr {
            kind: RawKind::Arrow { .. },
            ..
        })
    ));
    assert!(ir.handlers.is_empty());
}

#[test]
fn fragment_root_is_wrapped_and_diagnostics_have_positions() {
    let ir = ir(
        "export default function R({ items }: any) {\n  return <>\n    <ul>{items.map((i: any) => <li>{i}</li>)}</ul>\n  </>\n}",
    );
    let Node::Element { tag, host, .. } = &ir.template else {
        panic!()
    };
    assert_eq!(tag, "brust-host");
    assert!(host);
    assert!(ir.diagnostics.iter().any(|d| d.rule == "fragment-root"));
    let key = ir
        .diagnostics
        .iter()
        .find(|d| d.rule == "list-key")
        .unwrap();
    // `<li` starts at byte column 32 of line 3.
    assert_eq!((key.line, key.col), (3, 32));
}

#[test]
fn arrow_default_export_is_a_fallback() {
    let ir = ir("export default () => <p/>");
    assert!(
        ir.diagnostics
            .iter()
            .any(|d| d.rule == "default-export-shape")
    );
    let err = run_on_compiler_thread(|| {
        let p = parse_tsx("N.tsx", b"export const A = 1".to_vec()).unwrap();
        analyze_component(&p).unwrap_err()
    });
    assert_eq!(err.rule, "no-default-export");
}
