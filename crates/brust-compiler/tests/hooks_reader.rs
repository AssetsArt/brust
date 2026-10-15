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
    assert_eq!(a.state[1].name, "_st2");
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
fn fragment_root_is_a_synthetic_wrapper_and_diagnostics_have_positions() {
    let ir = ir(
        "export default function R({ items }: any) {\n  return <>\n    <ul>{items.map((i: any) => <li>{i}</li>)}</ul>\n  </>\n}",
    );
    let Node::Element {
        tag,
        host,
        synthetic,
        ..
    } = &ir.template
    else {
        panic!()
    };
    assert_eq!(tag, "brust-host");
    assert!(host);
    // The wrapper is flagged; lowering decides (static: dropped, interactive: kept + warned).
    assert!(synthetic);
    assert!(ir.diagnostics.iter().all(|d| d.rule != "fragment-root"));
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

/// Review B1 (probe p1): renames and defaults are read structurally; nested
/// patterns and `...rest` fail closed.
#[test]
fn destructured_props_keep_rename_and_default() {
    let ok = ir(
        "export default function P({ title: heading, size = 3 }: any) { return <p data-s={size}>{heading}</p> }",
    );
    assert_eq!(ok.props.len(), 2);
    assert_eq!(
        (ok.props[0].name.as_str(), ok.props[0].local.as_str()),
        ("title", "heading")
    );
    assert!(ok.props[0].default.is_none());
    assert_eq!(
        (ok.props[1].name.as_str(), ok.props[1].local.as_str()),
        ("size", "size")
    );
    assert!(matches!(
        ok.props[1].default,
        Some(RawExpr { kind: RawKind::Lit(Literal::Num(n)), .. }) if n == 3.0
    ));
    // Reads of the local name the prop.
    let t = serde_json::to_string(&ok.template).unwrap();
    assert!(t.contains(r#""name":"title","kind":"Prop""#), "{t}");
    assert!(!t.contains("heading"), "{t}");
    assert!(ok.diagnostics.is_empty(), "{:?}", ok.diagnostics);

    let bad = ir(
        "export default function P({ title: heading, size = 3, user: { name }, ...rest }: any) { return <p data-s={size}>{heading}{name}{rest.x}</p> }",
    );
    let pattern: Vec<_> = bad
        .diagnostics
        .iter()
        .filter(|d| d.rule == "prop-pattern")
        .collect();
    // Only the nested pattern: `...rest` is read (shadcn S1.2, R34.14).
    assert_eq!(pattern.len(), 1, "{:?}", bad.diagnostics);
    assert_eq!(bad.props_rest.as_deref(), Some("rest"));
    assert!(pattern.iter().all(|d| d.class == DiagClass::Fallback));
    assert_eq!(
        bad.props
            .iter()
            .map(|p| p.name.as_str())
            .collect::<Vec<_>>(),
        ["title", "size"]
    );
}

/// Review B2 (probe p3): a function declared after the return is hoisted and
/// read; any other statement there fails closed.
#[test]
fn function_after_return_is_read() {
    let ok = ir(
        "export default function P() { return <button onClick={handle}>x</button>\n function handle() { console.log(1) } }",
    );
    assert_eq!(
        ok.derived
            .iter()
            .map(|d| d.name.as_str())
            .collect::<Vec<_>>(),
        ["handle"]
    );
    assert!(ok.diagnostics.is_empty(), "{:?}", ok.diagnostics);

    let bad = ir("export default function P() { return <p/>\n const x = 1 }");
    assert!(
        bad.diagnostics
            .iter()
            .any(|d| d.rule == "stmt-after-return" && d.class == DiagClass::Fallback),
        "{:?}",
        bad.diagnostics
    );
}

/// Review B3 (probe p4): a hook nested in an expression, in JSX or in a prop
/// default is React-only; top-level hooks are not reported twice.
#[test]
fn nested_hook_calls_fall_back() {
    for src in [
        "import { useContext } from 'react'\nimport { Ctx } from './ctx'\nexport default function P() { const v = String(useContext(Ctx)); return <p>{v}</p> }",
        "import { useThing } from './thing'\nexport default function P() { return <p>{useThing()}</p> }",
        "export default function P({ a = useA() }: any) { return <p>{a}</p> }",
        "import { useState } from 'react'\nexport default function P() { const [n, setN] = useState(0); return <b onClick={() => { const [m] = useState(1); setN(m) }}>{n}</b> }",
    ] {
        let ir = ir(src);
        assert_eq!(
            ir.diagnostics
                .iter()
                .filter(|d| d.rule == "hook-unsupported" && d.class == DiagClass::Fallback)
                .count(),
            1,
            "{src}: {:?}",
            ir.diagnostics
        );
    }
    let top = ir(&format!(
        "{PRE}export default function T() {{ const [n] = useState(0); const r = useRef(null); return <p ref={{r}}>{{n}}</p> }}"
    ));
    assert!(top.diagnostics.is_empty(), "{:?}", top.diagnostics);
}

// ---- G3 (plan L5): native-safe custom hooks are inlined ---------------------------

/// The full analysis (tier included) of `entry` in a temporary project made of `files`.
fn project(files: &[(&str, &str)], entry: &str) -> ComponentIR {
    use brust_compiler::analyze::component::{AnalyzeOptions, analyze_file};
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);
    let root = std::env::temp_dir().join(format!(
        "brust-hooks-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    for (path, src) in files {
        let p = root.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, src).unwrap();
    }
    let opts = AnalyzeOptions {
        root: root.clone(),
        ..Default::default()
    };
    let entry = entry.to_string();
    let ir = run_on_compiler_thread(move || analyze_file(&entry, &opts).unwrap());
    std::fs::remove_dir_all(root).ok();
    ir
}

fn fallbacks(ir: &ComponentIR) -> Vec<&Diagnostic> {
    ir.diagnostics
        .iter()
        .filter(|d| d.class == DiagClass::Fallback)
        .collect()
}

const COUNTER: &str = "import { useState } from 'react'\nfunction useCounter() { const [n, setN] = useState(0); return [n, () => setN(n + 1)] as const }\n";

#[test]
fn same_file_hook_inlines_with_renamed_locals() {
    let ir = ir(&format!(
        "{COUNTER}export default function C() {{ const [n, inc] = useCounter(); return <button onClick={{inc}}>{{n}}</button> }}"
    ));
    assert!(ir.diagnostics.is_empty(), "{:?}", ir.diagnostics);
    assert_eq!(ir.state.len(), 1);
    assert_eq!(ir.state[0].name, "n_useCounter1");
    assert_eq!(ir.state[0].setter.as_deref(), Some("setN_useCounter1"));
    // `n` is the hook's state itself; `inc` is derived from the returned arrow.
    assert_eq!(
        ir.derived
            .iter()
            .map(|d| d.name.as_str())
            .collect::<Vec<_>>(),
        ["inc"]
    );
    let Expr::Raw(RawExpr {
        kind: RawKind::Arrow { captures, .. },
        ..
    }) = &ir.derived[0].expr
    else {
        panic!("{:?}", ir.derived[0].expr)
    };
    assert!(
        captures
            .iter()
            .any(|(n, k)| n == "setN_useCounter1" && *k == IdentKind::Setter),
        "{captures:?}"
    );
}

#[test]
fn hook_names_avoid_collisions_and_two_calls_get_their_own() {
    // The component already declares `n_useCounter1`: the call takes the next free `n`.
    let ir = ir(&format!(
        "{COUNTER}export default function C() {{ const n_useCounter1 = 5; const [a, incA] = useCounter(); const [b, incB] = useCounter(); return <p><i onClick={{incA}}>{{a}}</i><b onClick={{incB}}>{{b + n_useCounter1}}</b></p> }}"
    ));
    assert!(ir.diagnostics.is_empty(), "{:?}", ir.diagnostics);
    assert_eq!(
        ir.state.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        ["n_useCounter2", "n_useCounter3"]
    );
}

#[test]
fn hook_arguments_alias_identifiers_and_derive_the_rest() {
    let ir = ir(
        "import { useState, useEffect } from 'react'\nfunction useDebounced(value, ms) { const [d, setD] = useState(value); useEffect(() => { const t = setTimeout(() => setD(value), ms); return () => clearTimeout(t) }, [value, ms]); return d }\nexport default function S() { const [q, setQ] = useState(''); const d = useDebounced(q, 300); return <input value={q} onInput={(e) => setQ(e.currentTarget.value)} title={d} /> }",
    );
    assert!(ir.diagnostics.is_empty(), "{:?}", ir.diagnostics);
    assert_eq!(
        ir.state.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        ["q", "d_useDebounced1"]
    );
    // `value` is the caller's `q`; `ms` is computed once at the call site.
    assert_eq!(ir.derived[0].name, "ms_useDebounced1");
    let deps = ir.effects[0].deps.as_ref().unwrap();
    assert!(
        matches!(&deps[0].kind, RawKind::Ident { name, kind: IdentKind::State } if name == "q"),
        "{deps:?}"
    );
    let printed = format!("{:?}", ir.effects[0].body);
    assert!(printed.contains("setD_useDebounced1(q)"), "{printed}");
    assert!(printed.contains("t_useDebounced1"), "{printed}");
}

#[test]
fn hook_calling_hook_and_recursion() {
    let ok = ir(&format!(
        "{COUNTER}function useTwice() {{ const [n, inc] = useCounter(); return {{ n, twice: n * 2, inc }} }}\nexport default function C() {{ const {{ twice, inc }} = useTwice(); return <button onClick={{inc}}>{{twice}}</button> }}"
    ));
    assert!(ok.diagnostics.is_empty(), "{:?}", ok.diagnostics);
    assert_eq!(ok.state[0].name, "n_useCounter1");
    assert!(ok.derived.iter().any(|d| d.name == "twice"));
    let rec = ir(
        "function useA(n) { const x = useB(n); return x }\nfunction useB(n) { const y = useA(n); return y }\nexport default function C({ n }: any) { const v = useA(n); return <p>{v}</p> }",
    );
    let f = fallbacks(&rec);
    assert_eq!(f.len(), 1, "{f:?}");
    assert_eq!(f[0].rule, "hook-recursive");
    assert!(
        f[0].message.contains("useA → useB → useA"),
        "{}",
        f[0].message
    );
    assert_eq!(f[0].line, 3, "reported at the component's call site");
}

#[test]
fn unsupported_hook_inside_a_custom_hook_names_the_chain() {
    let ir = ir(
        "import { useReducer } from 'react'\nfunction useCart() {\n  const [s, d] = useReducer((a: number, b: number) => a + b, 0)\n  return s\n}\nexport default function C() { const s = useCart(); return <p>{s}</p> }",
    );
    let f = fallbacks(&ir);
    assert_eq!(f.len(), 1, "{f:?}");
    assert_eq!(f[0].rule, "hook-unsupported");
    assert_eq!(
        f[0].message,
        "hook useReducer is not supported (in custom hook useCart, H.tsx:3)"
    );
    assert_eq!((f[0].line, f[0].col), (6, 41));
}

#[test]
fn custom_hook_shapes_that_fall_back() {
    for (src, rule) in [
        // JSX in the hook
        (
            "function useX() { return <i /> }\nexport default function C() { const x = useX(); return <p>{x}</p> }",
            "hook-shape",
        ),
        // early return
        (
            "function useX(a) { return a\n const b = 1 }\nexport default function C({ a }: any) { const x = useX(a); return <p>{x}</p> }",
            "stmt-after-return",
        ),
        // default parameter
        (
            "function useX(a = 1) { return a }\nexport default function C() { const x = useX(); return <p>{x}</p> }",
            "hook-shape",
        ),
        // array pattern against a non-literal return
        (
            "function useX(a) { return a }\nexport default function C({ a }: any) { const [x] = useX(a); return <p>{x}</p> }",
            "hook-return-shape",
        ),
        // the hook reads a module name the component shadows
        (
            "const k = 1\nfunction useX() { return k + 1 }\nexport default function C() { const k = 2; const x = useX(); return <p>{x + k}</p> }",
            "hook-shape",
        ),
        // the hook writes its parameter
        (
            "import { useEffect } from 'react'\nfunction useX(a) { useEffect(() => { a = 2 }, []); return 1 }\nexport default function C({ a }: any) { const x = useX(a); return <p>{x}</p> }",
            "hook-shape",
        ),
    ] {
        let ir = ir(src);
        assert!(
            fallbacks(&ir).iter().any(|d| d.rule == rule),
            "{src}: {:?}",
            ir.diagnostics
        );
    }
}

#[test]
fn imported_hook_inlines_and_its_module_captures_fall_back() {
    let hook = "import { useState } from 'react'\nexport function useToggle(init) { const [on, setOn] = useState(init); return [on, () => setOn(!on)] as const }\n";
    let ir = project(
        &[
            ("hooks/toggle.ts", hook),
            (
                "C.tsx",
                "import { useToggle } from './hooks/toggle'\nexport default function C() { const [on, flip] = useToggle(false); return <button onClick={flip}>{on ? 'on' : 'off'}</button> }",
            ),
        ],
        "C.tsx",
    );
    assert!(fallbacks(&ir).is_empty(), "{:?}", ir.diagnostics);
    assert_eq!(ir.tier, Tier::Native);
    assert_eq!(ir.state[0].name, "on_useToggle1");
    let ir = project(
        &[
            (
                "hooks/toggle.ts",
                "import { fmt } from './fmt'\nexport default function useLabel(n) { return fmt(n) }\n",
            ),
            ("hooks/fmt.ts", "export const fmt = (n) => String(n)\n"),
            (
                "C.tsx",
                "import useLabel from './hooks/toggle'\nexport default function C({ n }: any) { const l = useLabel(n); return <p>{l}</p> }",
            ),
        ],
        "C.tsx",
    );
    let f = fallbacks(&ir);
    assert!(
        f.iter()
            .any(|d| d.rule == "hook-shape"
                && d.message.contains("reads `fmt` from hooks/toggle.ts")),
        "{f:?}"
    );
    assert!(f.iter().all(|d| d.line == 2), "{f:?}");
}

#[test]
fn a_hook_inside_an_imported_module_keeps_that_modules_rules() {
    // `useInner` is local to the imported module: it inlines, and it may not read `LIMIT`.
    let ok = project(
        &[
            (
                "h.ts",
                "import { useState } from 'react'\nfunction useInner(init) { const [n, setN] = useState(init); return [n, setN] as const }\nexport function useOuter() { const [n, setN] = useInner(1); return [n, () => setN(n + 1)] as const }\n",
            ),
            (
                "C.tsx",
                "import { useOuter } from './h'\nexport default function C() { const [n, inc] = useOuter(); return <button onClick={inc}>{n}</button> }",
            ),
        ],
        "C.tsx",
    );
    assert!(fallbacks(&ok).is_empty(), "{:?}", ok.diagnostics);
    assert_eq!(ok.tier, Tier::Native);
    assert_eq!(ok.state[0].name, "n_useInner1");
    let bad = project(
        &[
            (
                "h.ts",
                "const LIMIT = 3\nfunction useInner() { return LIMIT }\nexport function useOuter() { const l = useInner(); return l }\n",
            ),
            (
                "C.tsx",
                "import { useOuter } from './h'\nexport default function C() { const l = useOuter(); return <p>{l}</p> }",
            ),
        ],
        "C.tsx",
    );
    let f = fallbacks(&bad);
    assert!(
        f.iter()
            .any(|d| d.rule == "hook-shape" && d.message.contains("reads `LIMIT` from h.ts")),
        "{f:?}"
    );
    assert!(f.iter().all(|d| d.line == 2), "{f:?}");
}

/// Review F1 (Mellow, round 1): a global a foreign hook reads must not bind to the component
/// module's own import or const of that name once inlined.
#[test]
fn a_foreign_hooks_global_does_not_bind_to_the_component_modules_names() {
    let hook = "import { useState } from 'react'\nexport function useBack(label) { const [n, setN] = useState(0); const go = () => { history.back(); setN(n + 1) }; return [label + n, go] as const }\n";
    for component in [
        "import { useEffect } from 'react'\nimport { history } from './myhistory'\nimport { useBack } from './useNav'\nexport default function C({ title }: any) { const [text, back] = useBack(title); useEffect(() => { history.push('/x') }, []); return <button onClick={back}>{text}</button> }",
        "import { useBack } from './useNav'\nconst history = { back() {} }\nexport default function C({ title }: any) { const [text, back] = useBack(title); return <button onClick={back}>{text}</button> }",
    ] {
        let ir = project(
            &[
                ("useNav.ts", hook),
                (
                    "myhistory.ts",
                    "export const history = { back() {}, push(_p: string) {} }\n",
                ),
                ("C.tsx", component),
            ],
            "C.tsx",
        );
        let f = fallbacks(&ir);
        assert!(
            f.iter().any(|d| d.rule == "hook-shape" && d.message.contains("reads the global `history`")),
            "{component}: {f:?}"
        );
        assert_ne!(ir.tier, Tier::Native);
    }
    // The same hook in a module that declares no `history` still inlines.
    let ok = project(
        &[
            ("useNav.ts", hook),
            (
                "C.tsx",
                "import { useBack } from './useNav'\nexport default function C({ title }: any) { const [text, back] = useBack(title); return <button onClick={back}>{text}</button> }",
            ),
        ],
        "C.tsx",
    );
    assert!(fallbacks(&ok).is_empty(), "{:?}", ok.diagnostics);
    assert_eq!(ok.tier, Tier::Native);
}

const COMPOSE: &str = "import * as React from 'react'\nfunction setRef(ref: any, value: any) { if (typeof ref === 'function') return ref(value); else if (ref !== null && ref !== undefined) ref.current = value }\nexport function composeRefs(...refs: any[]) { return (node: any) => { refs.forEach((r) => setRef(r, node)) } }\nexport function useComposedRefs(...refs: any[]) { return React.useCallback(composeRefs(...refs), refs) }\n";

// B2: a custom hook's `...rest` parameter is the array of the call site's remaining arguments.
#[test]
fn a_rest_parameter_of_a_custom_hook_is_bound_to_the_remaining_arguments() {
    let ir = project(
        &[
            ("compose.ts", COMPOSE),
            (
                "C.tsx",
                "import { useState, useRef } from 'react'\nimport { useComposedRefs } from './compose'\nexport default function C() { const [n, setN] = useState(0); const a = useRef(null); const b = useRef(null); const set = useComposedRefs(a, b); return <button onClick={() => { setN(n + 1); set(null) }}>{n}</button> }",
            ),
        ],
        "C.tsx",
    );
    assert!(fallbacks(&ir).is_empty(), "{:?}", ir.diagnostics);
    assert_eq!(ir.tier, Tier::Native);
}

// B3: the forwarded ref handed whole to a hook is `null`; any other read of it still needs React.
#[test]
fn the_forwarded_ref_handed_to_a_hook_is_null() {
    let ok = project(
        &[
            ("compose.ts", COMPOSE),
            (
                "C.tsx",
                "import * as React from 'react'\nimport { useState, useRef } from 'react'\nimport { useComposedRefs } from './compose'\nexport default React.forwardRef<any, any>(function C(props, forwardedRef) { const [n, setN] = useState(0); const a = useRef(null); const set = useComposedRefs(forwardedRef, a); return <button onClick={() => { setN(n + 1); set(null) }}>{n}</button> })",
            ),
        ],
        "C.tsx",
    );
    assert!(fallbacks(&ok).is_empty(), "{:?}", ok.diagnostics);
    assert_eq!(ok.tier, Tier::Native);
    let bad = project(
        &[
            ("compose.ts", COMPOSE),
            (
                "C.tsx",
                "import * as React from 'react'\nimport { useState, useRef } from 'react'\nimport { useComposedRefs } from './compose'\nexport default React.forwardRef<any, any>(function C(props, forwardedRef) { const [n, setN] = useState(0); const a = useRef(null); const set = useComposedRefs(forwardedRef.current, a); return <button onClick={() => { setN(n + 1); set(null) }}>{n}</button> })",
            ),
        ],
        "C.tsx",
    );
    assert!(
        bad.diagnostics.iter().any(|d| d.rule == "forwardref-ref"),
        "{:?}",
        bad.diagnostics
    );
}

// B1: `ref={fn}` where `fn` is not a `useRef` binding becomes a synthetic ref plus a mount effect that sets it.
#[test]
fn a_callback_ref_becomes_a_synthetic_ref_and_a_mount_effect() {
    for (decls, ref_expr, deps_kind) in [
        (
            "const rec = useCallback((n: any) => {}, [])",
            "rec",
            "Local",
        ),
        (
            "const [node, setNode] = useState<any>(null)",
            "setNode",
            "Setter",
        ),
    ] {
        let a = ir(&format!(
            "{PRE}export default function F() {{ {decls}; const [n, setN] = useState(0); return <button ref={{{ref_expr}}} onClick={{() => setN(n + 1)}}>{{n}}</button> }}"
        ));
        assert!(
            !a.diagnostics.iter().any(|d| d.rule == "ref-shape"),
            "{ref_expr}: {:?}",
            a.diagnostics
        );
        let Node::Element { attrs, .. } = &a.template else {
            panic!()
        };
        assert!(
            attrs
                .iter()
                .any(|x| matches!(x, Attr::Ref { name } if name == "_rf1")),
            "{ref_expr}: {attrs:?}"
        );
        assert!(a.refs.iter().any(|r| r.name == "_rf1"));
        let e = a.effects.last().expect("the mount effect");
        assert!(e.layout);
        assert!(
            matches!(&e.deps.as_deref(), Some([d]) if format!("{:?}", d.kind).contains(deps_kind)),
            "{ref_expr}: {:?}",
            e.deps
        );
    }
}

#[test]
fn a_ref_that_is_not_a_function_value_or_ref_object_stays_a_fallback() {
    for body in [
        // a loop binding
        "<ul>{[1, 2].map((x) => <li key={x} ref={x}>{x}</li>)}</ul>",
        // an element inside a list, even with a callback
        "<ul>{[1, 2].map((x) => <li key={x} ref={cb}>{x}</li>)}</ul>",
    ] {
        let a = ir(&format!(
            "{PRE}export default function F() {{ const cb = useCallback((n: any) => {{}}, []); const [n, setN] = useState(0); return <div onClick={{() => setN(n + 1)}}>{body}</div> }}"
        ));
        // Left as written (the tier pass reports `ref-shape`): no synthetic ref, no effect.
        assert!(a.refs.is_empty() && a.effects.is_empty(), "{body}");
    }
}

// B4: a `useRef(init)` that is only ever read as `.current` in the render is a state cell nothing sets.
#[test]
fn a_never_written_ref_read_in_the_render_is_a_state_cell() {
    let a = ir(&format!(
        "{PRE}export default function F({{ checked }}: any) {{ const [n, setN] = useState(0); const snap = useRef(checked); return <div onClick={{() => setN(n + 1)}}><input defaultChecked={{snap.current}} /></div> }}"
    ));
    assert!(a.diagnostics.is_empty(), "{:?}", a.diagnostics);
    assert!(a.refs.is_empty(), "{:?}", a.refs);
    assert!(
        a.state
            .iter()
            .any(|s| s.name == "snap" && s.setter.is_none())
    );
}

#[test]
fn a_ref_that_is_written_or_read_in_a_function_or_bound_stays_a_ref() {
    for body in [
        // written
        "const snap = useRef(checked); return <div onClick={() => { snap.current = true }}><input defaultChecked={snap.current} /></div>",
        // also read in a handler (verbatim code)
        "const snap = useRef(checked); return <div onClick={() => console.log(snap.current)}><input defaultChecked={snap.current} /></div>",
        // bound to an element
        "const snap = useRef(null); return <div onClick={() => {}}><input ref={snap} data-x={snap.current} /></div>",
        // handed on whole
        "const snap = useRef(checked); const w = snap; return <div onClick={() => {}}><input data-x={String(w.current)} defaultChecked={snap.current} /></div>",
    ] {
        let a = ir(&format!(
            "{PRE}export default function F({{ checked }}: any) {{ const [n, setN] = useState(0); {body} }}"
        ));
        assert!(
            a.refs.iter().any(|r| r.name == "snap") && !a.state.iter().any(|s| s.name == "snap"),
            "{body}: refs {:?} state {:?}",
            a.refs,
            a.state
        );
    }
}
