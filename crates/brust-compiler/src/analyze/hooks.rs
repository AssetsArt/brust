//! Hook calls and the component body (spec §4.3). Reads the component's
//! top-level statements in order; anything React-only is recorded as a
//! `Fallback` diagnostic (the tier itself is decided in M1b-2).
use crate::analyze::expr::{Reader, Walk, loc_of};
use crate::analyze::names::NameTable;
use crate::ir::{
    DerivedDecl, Diagnostic, EffectDecl, Expr, HandlerDecl, Literal, PropDecl, RawExpr, RawKind,
    RefDecl, StateDecl,
};
use bun_ast as js_ast;
use js_ast::b::B;
use js_ast::expr::Data as E;
use js_ast::stmt::Data as S;
use std::collections::HashSet;

#[derive(Debug, Default)]
pub struct BodyDecls {
    pub props: Vec<PropDecl>,
    pub state: Vec<StateDecl>,
    pub derived: Vec<DerivedDecl>,
    pub effects: Vec<EffectDecl>,
    pub handlers: Vec<HandlerDecl>,
    pub refs: Vec<RefDecl>,
    /// Locals bound to `useId()`.
    pub id_bindings: Vec<String>,
    pub uses_id: bool,
    pub return_expr: Option<Expr>,
    pub diagnostics: Vec<Diagnostic>,
    /// The first reason this component needs React, if any.
    pub react_reason: Option<String>,
    /// Hook calls already classified as top-level statements, by address.
    classified_hooks: HashSet<usize>,
}

impl BodyDecls {
    fn fallback(&mut self, rule: &str, message: String, loc: u32, remediation: &str) {
        if self.react_reason.is_none() {
            self.react_reason = Some(message.clone());
        }
        self.diagnostics
            .push(Diagnostic::fallback(rule, message, loc, remediation));
    }
}

/// The React hook a call invokes, when its callee is an import from `react`
/// (named, or a member of the default / namespace import). Decided by symbol,
/// so a local `const useState = …` is not a React hook.
pub fn react_hook_name(call: &js_ast::E::Call, names: &NameTable<'_>) -> Option<String> {
    react_hook_target(&call.target, names)
}

fn react_hook_target(target: &js_ast::Expr, names: &NameTable<'_>) -> Option<String> {
    match &target.data {
        E::EImportIdentifier(id) => match names.import_of(id.ref_) {
            Some(("react", imported)) if imported != "default" && imported != "*" => {
                Some(imported.to_string())
            }
            _ => None,
        },
        // `React.useState` on the default or namespace import of `react`.
        E::EDot(d) => {
            let r = match &d.target.data {
                E::EImportIdentifier(id) => id.ref_,
                E::EIdentifier(id) => id.ref_,
                _ => return None,
            };
            match names.import_of(r) {
                Some(("react", "default" | "*")) => {
                    Some(String::from_utf8_lossy(d.name.slice()).into_owned())
                }
                _ => None,
            }
        }
        _ => None,
    }
}

/// Any call that is a hook by React's naming rule (`use` + capital), with the
/// name it is called by: a React hook, a custom hook, or a local named like one.
fn hook_call<'c>(
    e: &'c js_ast::Expr,
    names: &NameTable<'_>,
) -> Option<(String, &'c js_ast::E::Call, bool)> {
    let E::ECall(call) = &e.data else {
        return None;
    };
    let (name, from_react) = hook_target(&call.target, names)?;
    Some((name, call, from_react))
}

/// The hook a callee names, and whether it is React's own.
fn hook_target(target: &js_ast::Expr, names: &NameTable<'_>) -> Option<(String, bool)> {
    if let Some(name) = react_hook_target(target, names) {
        return Some((name, true));
    }
    let name = match &target.data {
        E::EIdentifier(id) => names.name(id.ref_),
        E::EImportIdentifier(id) => names.name(id.ref_),
        E::EDot(d) => String::from_utf8_lossy(d.name.slice()).into_owned(),
        _ => return None,
    };
    let rest = name.strip_prefix("use")?;
    (rest.is_empty() || rest.starts_with(|c: char| c.is_ascii_uppercase() || c.is_ascii_digit()))
        .then_some((name, false))
}

fn call_addr(call: &js_ast::E::Call) -> usize {
    call as *const js_ast::E::Call as usize
}

/// Marks `const [a, setA] = useState(…)` bindings in `names` before any
/// expression of the body is read, so reads resolve to `State` / `Setter`.
pub fn mark_state_bindings(func: &js_ast::G::Fn, names: &mut NameTable<'_>) {
    for stmt in func.body.stmts.slice() {
        let S::SLocal(local) = &stmt.data else {
            continue;
        };
        for decl in local.decls.iter() {
            let (Some(value), B::BArray(arr)) = (&decl.value, decl.binding.data) else {
                continue;
            };
            let E::ECall(call) = &value.data else {
                continue;
            };
            if react_hook_name(call, names).as_deref() != Some("useState") {
                continue;
            }
            let items = arr.items();
            if let Some(B::BIdentifier(id)) = items.first().map(|i| i.binding.data) {
                names.mark_state(id.r#ref);
            }
            if let Some(B::BIdentifier(id)) = items.get(1).map(|i| i.binding.data) {
                names.mark_setter(id.r#ref);
            }
        }
    }
}

/// The component's props: one per destructured property, or `props` for a
/// plain parameter. TS type text is not recovered in M1b-1. Renames and
/// defaults are read; nested patterns, `...rest`, computed keys and a default
/// for the whole parameter are a `prop-pattern` fallback.
fn read_props(func: &js_ast::G::Fn, r: &mut Reader<'_, '_>, out: &mut BodyDecls) {
    let Some(arg) = func.args.slice().first() else {
        return;
    };
    let pattern = |out: &mut BodyDecls, loc: u32, what: &str| {
        out.fallback(
            "prop-pattern",
            format!("{what} in the props pattern"),
            loc,
            "destructure props one level deep as { name } or { name = default }",
        )
    };
    let loc = arg.binding.loc.start.max(0) as u32;
    if arg.default.is_some() {
        pattern(out, loc, "a default for the whole props object");
    }
    match arg.binding.data {
        B::BIdentifier(id) => {
            let name = r.names.name(id.r#ref);
            out.props.push(PropDecl {
                local: name.clone(),
                name,
                ts_type: None,
                default: None,
            })
        }
        B::BObject(obj) => {
            for p in obj.properties() {
                let ploc = loc_of(&p.key);
                if p.flags.contains(js_ast::flags::Property::IsSpread) {
                    pattern(out, ploc, "...rest");
                    continue;
                }
                let E::EString(key) = &p.key.data else {
                    pattern(out, ploc, "a computed key");
                    continue;
                };
                let B::BIdentifier(id) = p.value.data else {
                    pattern(out, ploc, "a nested pattern");
                    continue;
                };
                let default = p.default_value.as_ref().map(|d| r.expr(d));
                out.props.push(PropDecl {
                    name: crate::analyze::expr::estring(key),
                    local: r.names.name(id.r#ref),
                    ts_type: None,
                    default,
                });
            }
        }
        B::BArray(_) | B::BMissing(_) => pattern(out, loc, "an array pattern"),
    }
}

fn undefined_at(loc: u32) -> RawExpr {
    RawExpr {
        loc,
        kind: RawKind::Lit(Literal::Undefined),
    }
}

/// Reads the component body. `mark_state_bindings` must have run on `r.names`.
pub fn read_body(func: &js_ast::G::Fn, r: &mut Reader<'_, '_>) -> BodyDecls {
    let mut out = BodyDecls::default();
    read_props(func, r, &mut out);
    let mut returned = false;
    for stmt in func.body.stmts.slice() {
        let loc = stmt.loc.start.max(0) as u32;
        // After the return only hoisted function declarations still mean
        // something; anything else is dead code we will not reason about.
        if returned
            && !matches!(
                &stmt.data,
                S::SFunction(_)
                    | S::STypeScript(_)
                    | S::SEmpty(_)
                    | S::SDirective(_)
                    | S::SComment(_)
            )
        {
            out.fallback(
                "stmt-after-return",
                "statement after the return".into(),
                loc,
                "remove unreachable code; only function declarations may follow the return",
            );
            continue;
        }
        match &stmt.data {
            S::SLocal(local) => {
                if !matches!(local.kind, js_ast::S::Kind::KConst) {
                    out.fallback(
                        "let-var",
                        "let/var in component body".into(),
                        loc,
                        "use const, and useState for values that change",
                    );
                    continue;
                }
                for decl in local.decls.iter() {
                    read_decl(r, &mut out, decl, loc);
                }
            }
            S::SExpr(x) => read_expr_stmt(r, &mut out, &x.value),
            S::SFunction(f) => {
                let name = f
                    .func
                    .name
                    .as_ref()
                    .map(|n| r.names.name(n.ref_))
                    .unwrap_or_default();
                let expr = r.function_decl(stmt, &f.func);
                out.derived.push(DerivedDecl {
                    name,
                    expr: Expr::Raw(expr),
                });
            }
            S::SReturn(ret) => {
                out.return_expr = ret.value.map(|v| Expr::Raw(r.expr(&v)));
                returned = true;
            }
            S::SIf(_)
            | S::SFor(_)
            | S::SForIn(_)
            | S::SForOf(_)
            | S::SWhile(_)
            | S::SDoWhile(_)
            | S::STry(_)
            | S::SSwitch(_)
            | S::SLabel(_)
            | S::SBlock(_)
            | S::SThrow(_) => {
                out.fallback(
                    "control-flow",
                    "control flow before return".into(),
                    loc,
                    "compute values with expressions and return one JSX tree",
                );
                break;
            }
            S::STypeScript(_) | S::SEmpty(_) | S::SDirective(_) | S::SComment(_) => {}
            _ => out.fallback(
                "body-shape",
                "unsupported statement in component body".into(),
                loc,
                "keep the body to const declarations, hooks and one return",
            ),
        }
    }
    nested_hooks(func, r.names, &mut out);
    if out.return_expr.is_none() && out.react_reason.is_none() {
        out.fallback(
            "body-shape",
            "component has no top-level return".into(),
            0,
            "return one JSX tree",
        );
    }
    out.handlers.append(&mut r.pending_handlers);
    out.diagnostics.append(&mut r.diagnostics);
    out
}

/// Hook calls anywhere but as a classified top-level statement: inside an
/// expression, a JSX attribute, a prop default or a nested function (spec
/// §4.3: such a component is React-only).
fn nested_hooks(func: &js_ast::G::Fn, names: &NameTable<'_>, out: &mut BodyDecls) {
    let mut w = Walk::default();
    for arg in func.args.slice() {
        w.declare_binding(&arg.binding);
        if let Some(d) = &arg.default {
            w.expr(d);
        }
    }
    w.stmts(func.body.stmts.slice());
    for e in &w.calls {
        let E::ECall(call) = &e.data else {
            continue;
        };
        if out.classified_hooks.contains(&call_addr(call)) {
            continue;
        }
        if let Some((hook, _)) = hook_target(&call.target, names) {
            out.fallback(
                "hook-unsupported",
                format!("hook {hook} is called inside an expression"),
                loc_of(e),
                "call hooks only as `const x = useHook(...)` at the top of the component",
            );
        }
    }
}

fn read_decl(r: &mut Reader<'_, '_>, out: &mut BodyDecls, decl: &js_ast::G::Decl, loc: u32) {
    let Some(value) = &decl.value else {
        out.fallback(
            "body-shape",
            "declaration without a value".into(),
            loc,
            "initialise every const",
        );
        return;
    };
    let vloc = loc_of(value);
    let ident = match decl.binding.data {
        B::BIdentifier(id) => Some(r.names.name(id.r#ref)),
        _ => None,
    };
    if let Some((hook, call, from_react)) = hook_call(value, r.names) {
        out.classified_hooks.insert(call_addr(call));
        let args: Vec<js_ast::Expr> = call.args.to_vec();
        match (from_react, hook.as_str()) {
            (true, "useState") => {
                let B::BArray(arr) = decl.binding.data else {
                    out.fallback(
                        "hook-shape",
                        "useState result used without destructuring".into(),
                        vloc,
                        "write const [value, setValue] = useState(init)",
                    );
                    return;
                };
                let items = arr.items();
                let name_at = |i: usize| match items.get(i).map(|x| x.binding.data) {
                    Some(B::BIdentifier(id)) => Some(r.names.name(id.r#ref)),
                    _ => None,
                };
                if arr.has_spread
                    || items.len() > 2
                    || items
                        .iter()
                        .any(|x| !matches!(x.binding.data, B::BIdentifier(_) | B::BMissing(_)))
                {
                    out.fallback(
                        "hook-shape",
                        "useState destructuring must be [value, setter]".into(),
                        vloc,
                        "write const [value, setValue] = useState(init)",
                    );
                    return;
                }
                let (name, setter) = (name_at(0).unwrap_or_default(), name_at(1));
                let init = match args.first() {
                    Some(a) => r.expr(a),
                    None => undefined_at(vloc),
                };
                out.state.push(StateDecl {
                    name,
                    setter,
                    init: Expr::Raw(init),
                });
            }
            (true, "useMemo") => {
                let Some(name) = ident else {
                    return hook_binding_shape(out, "useMemo", vloc);
                };
                match args.first().map(|a| (a, &a.data)) {
                    Some((_, E::EArrow(a))) if expr_body(a).is_some() => {
                        let body = expr_body(a).unwrap_or_default();
                        let expr = r.expr(&body);
                        out.derived.push(DerivedDecl {
                            name,
                            expr: Expr::Raw(expr),
                        });
                    }
                    _ => out.fallback(
                        "hook-shape",
                        "useMemo needs an arrow returning an expression".into(),
                        vloc,
                        "write useMemo(() => expr, deps), or compute it as a const",
                    ),
                }
            }
            (true, "useCallback") => {
                let Some(name) = ident else {
                    return hook_binding_shape(out, "useCallback", vloc);
                };
                let body = match args.first() {
                    Some(a) => r.expr(a),
                    None => undefined_at(vloc),
                };
                out.handlers.push(HandlerDecl {
                    name,
                    body,
                    item_scoped: Vec::new(),
                });
            }
            (true, "useRef") => {
                let Some(name) = ident else {
                    return hook_binding_shape(out, "useRef", vloc);
                };
                let init = match args.first() {
                    Some(a) => r.expr(a),
                    None => undefined_at(vloc),
                };
                out.refs.push(RefDecl {
                    name,
                    init: Expr::Raw(init),
                });
            }
            (true, "useId") => {
                let Some(name) = ident else {
                    return hook_binding_shape(out, "useId", vloc);
                };
                out.uses_id = true;
                out.id_bindings.push(name);
            }
            _ => out.fallback(
                "hook-unsupported",
                format!("hook {hook} is not supported"),
                vloc,
                "move this component to React, or replace the hook with useState/useEffect",
            ),
        }
        return;
    }
    let Some(name) = ident else {
        out.fallback(
            "body-shape",
            "destructuring in component body".into(),
            loc,
            "bind each value with its own const",
        );
        return;
    };
    let expr = r.expr(value);
    out.derived.push(DerivedDecl {
        name,
        expr: Expr::Raw(expr),
    });
}

fn hook_binding_shape(out: &mut BodyDecls, hook: &str, loc: u32) {
    out.fallback(
        "hook-shape",
        format!("{hook} result must be bound to a single const"),
        loc,
        "write const name = hook(...)",
    );
}

/// The returned expression of an arrow whose body is `expr` or `{ return expr }`.
fn expr_body(a: &js_ast::E::Arrow) -> Option<js_ast::Expr> {
    match a.body.stmts.slice() {
        [only] => match &only.data {
            S::SReturn(ret) => ret.value,
            _ => None,
        },
        _ => None,
    }
}

fn read_expr_stmt(r: &mut Reader<'_, '_>, out: &mut BodyDecls, value: &js_ast::Expr) {
    let vloc = loc_of(value);
    let hook = hook_call(value, r.names);
    if let Some((_, call, _)) = &hook {
        out.classified_hooks.insert(call_addr(call));
    }
    match hook {
        Some((hook, call, true)) if hook == "useEffect" || hook == "useLayoutEffect" => {
            let args: Vec<js_ast::Expr> = call.args.to_vec();
            let Some(f) = args.first() else {
                return out.fallback(
                    "hook-shape",
                    format!("{hook} needs a function"),
                    vloc,
                    "pass an arrow function",
                );
            };
            let body = r.expr(f);
            let deps = args.get(1).map(|d| match &d.data {
                E::EArray(a) => a.items.iter().map(|x| r.expr(x)).collect(),
                _ => vec![r.expr(d)],
            });
            out.effects.push(EffectDecl {
                body,
                deps,
                layout: hook == "useLayoutEffect",
            });
        }
        Some((hook, _, _)) => out.fallback(
            "hook-unsupported",
            format!("hook {hook} is not supported"),
            vloc,
            "move this component to React, or replace the hook with useState/useEffect",
        ),
        None => out.fallback(
            "body-shape",
            "expression statement in component body (side effect during render)".into(),
            vloc,
            "move side effects into useEffect",
        ),
    }
}
