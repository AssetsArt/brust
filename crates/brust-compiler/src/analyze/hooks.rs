//! Hook calls and the component body (spec §4.3). Reads the component's
//! top-level statements in order; anything React-only is recorded as a
//! `Fallback` diagnostic (the tier itself is decided in M1b-2).
use crate::analyze::component::AnalyzeOptions;
use crate::analyze::expr::{Js, Reader, Walk, loc_of, print_js_with};
use crate::analyze::names::{Alias, Aliases, NameTable};
use crate::ir::{
    ArrowBody, DerivedDecl, DiagClass, Diagnostic, EffectDecl, Expr, HandlerDecl, IdentKind,
    Literal, PropDecl, RawExpr, RawKind, RefDecl, StateDecl, StoreUse, line_col,
};
use crate::parse::Parsed;
use bun_ast as js_ast;
use js_ast::b::B;
use js_ast::expr::Data as E;
use js_ast::stmt::Data as S;
use std::collections::{HashMap, HashSet};

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
    /// `useStore(handle)` bindings in source order (M3-F D7).
    pub stores: Vec<StoreUse>,
    pub diagnostics: Vec<Diagnostic>,
    /// The first reason this component needs React, if any.
    pub react_reason: Option<String>,
    /// Hook calls already classified as top-level statements, by address.
    classified_hooks: HashSet<usize>,
    /// Custom hooks being inlined (G3).
    inline: Inline,
}

/// The module a body is read in (G3): custom hooks resolve and inline through it.
#[derive(Clone, Copy)]
pub struct Module<'m, 'x> {
    pub parsed: &'m Parsed,
    pub ast: &'m js_ast::Ast<'x>,
    /// `None` when there is no project root: imported hooks are not read.
    pub opts: Option<&'m AnalyzeOptions>,
    /// Not the component's own module: its bindings cannot be reached from the component.
    pub foreign: bool,
}

/// How deep custom hooks may call custom hooks.
const MAX_HOOK_DEPTH: usize = 8;

/// State of custom-hook inlining across one component read (G3).
#[derive(Debug, Default)]
struct Inline {
    /// (module path, hook) of each hook being inlined, outermost first.
    stack: Vec<(String, String)>,
    /// Call sites inlined so far per hook: the `n` of `<local>_<hook><n>` (R5.1).
    counters: HashMap<String, usize>,
    /// Names a generated local may not take: every symbol of every module read, and the
    /// names already generated.
    taken: HashSet<String>,
    /// What the component itself declares: a hook's free names must not be among them, or
    /// the inlined code would read the component's binding instead.
    root_declared: HashSet<String>,
    /// Every name the component's module declares (imports included): a global a foreign
    /// hook reads must not be among them, or the inlined code would read that binding.
    root_module: HashSet<String>,
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

/// The hook a callee names, and whether it is React's own. brust's `useStore` is a hook
/// under any alias, so an unbound or nested call never reads as a plain value.
fn hook_target(target: &js_ast::Expr, names: &NameTable<'_>) -> Option<(String, bool)> {
    if let Some(name) = react_hook_target(target, names) {
        return Some((name, true));
    }
    if is_use_store(target, names) {
        return Some(("useStore".into(), false));
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

/// Specifiers `useStore` is recognised from (C6; `brust/store/react` is the compiler-test form).
pub const USE_STORE_SOURCES: &[&str] = &[
    "@brust/core/store/react",
    "@brust/runtime-dom/store/react",
    "brust/store/react",
];

/// The callee is `useStore` from one of USE_STORE_SOURCES, by import identity (an alias included).
pub fn is_use_store(target: &js_ast::Expr, names: &NameTable<'_>) -> bool {
    let r = match &target.data {
        E::EImportIdentifier(id) => id.ref_,
        E::EIdentifier(id) => id.ref_,
        _ => return false,
    };
    matches!(names.import_of(r),
        Some((source, "useStore")) if USE_STORE_SOURCES.contains(&source))
}

/// The handle argument: an import binding (`cart`), or a member of a namespace import
/// (`stores.cart`), with (local, source, imported). `None` for anything else.
pub fn store_handle(
    arg: &js_ast::Expr,
    names: &NameTable<'_>,
) -> Option<(String, (String, String, String))> {
    let import_ref = |e: &js_ast::Expr| match &e.data {
        E::EImportIdentifier(id) => Some(id.ref_),
        E::EIdentifier(id) => Some(id.ref_),
        _ => None,
    };
    match &arg.data {
        E::EImportIdentifier(_) | E::EIdentifier(_) => {
            let r = import_ref(arg)?;
            let (source, imported) = names.import_of(r)?;
            if imported == "*" {
                return None;
            }
            let local = names.name(r);
            Some((
                local.clone(),
                (local, source.to_string(), imported.to_string()),
            ))
        }
        E::EDot(d) if d.optional_chain.is_none() => {
            let r = import_ref(&d.target)?;
            let (source, "*") = names.import_of(r)? else {
                return None;
            };
            let local = names.name(r);
            let member = String::from_utf8_lossy(d.name.slice()).into_owned();
            Some((
                format!("{local}.{member}"),
                (local, source.to_string(), "*".into()),
            ))
        }
        _ => None,
    }
}

/// The two binding shapes `useStore` accepts.
enum StoreBinding {
    /// `const s = useStore(h)`.
    View(js_ast::Ref),
    /// `const { key, key2: local } = useStore(h)`: (key, local) in source order.
    Fields(Vec<(String, js_ast::Ref)>),
}

/// `None` for any other pattern: an array, `...rest`, a default, a computed key, nesting.
fn store_binding(b: &js_ast::Binding) -> Option<StoreBinding> {
    match b.data {
        B::BIdentifier(id) => Some(StoreBinding::View(id.r#ref)),
        B::BObject(obj) => {
            let mut fields = Vec::new();
            for p in obj.properties() {
                if p.flags.contains(js_ast::flags::Property::IsSpread)
                    || p.flags.contains(js_ast::flags::Property::IsComputed)
                    || p.default_value.is_some()
                {
                    return None;
                }
                let (E::EString(key), B::BIdentifier(id)) = (&p.key.data, p.value.data) else {
                    return None;
                };
                fields.push((crate::analyze::expr::estring(key), id.r#ref));
            }
            Some(StoreBinding::Fields(fields))
        }
        B::BArray(_) | B::BMissing(_) => None,
    }
}

/// A well-formed `useStore(h)` declaration: the handle (with its import) and the binding.
/// `None` when `read_use_store` reports it instead.
fn use_store_decl(
    decl: &js_ast::G::Decl,
    names: &NameTable<'_>,
) -> Option<(String, (String, String, String), StoreBinding)> {
    let E::ECall(call) = &decl.value.as_ref()?.data else {
        return None;
    };
    if !is_use_store(&call.target, names) {
        return None;
    }
    let [arg] = &call.args[..] else {
        return None;
    };
    let (handle, import) = store_handle(arg, names)?;
    Some((handle, import, store_binding(&decl.binding)?))
}

fn call_addr(call: &js_ast::E::Call) -> usize {
    call as *const js_ast::E::Call as usize
}

/// Marks `const [a, setA] = useState(…)` bindings in `names` before any
/// expression of the body is read, so reads resolve to `State` / `Setter`;
/// and `useStore(h)` bindings, so reads resolve to `Store` (M3-F D7).
pub fn mark_state_bindings(func: &js_ast::G::Fn, names: &mut NameTable<'_>) {
    for stmt in func.body.stmts.slice() {
        let S::SLocal(local) = &stmt.data else {
            continue;
        };
        for decl in local.decls.iter() {
            if let Some((handle, _, binding)) = use_store_decl(decl, names) {
                match binding {
                    StoreBinding::View(r) => names.mark_store(r, handle, None),
                    StoreBinding::Fields(fields) => {
                        for (key, r) in fields {
                            names.mark_store(r, handle.clone(), Some(key));
                        }
                    }
                }
                continue;
            }
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
pub fn read_body(func: &js_ast::G::Fn, r: &mut Reader<'_, '_>, m: Module<'_, '_>) -> BodyDecls {
    let mut out = BodyDecls::default();
    out.inline.taken.extend(r.names.spellings());
    let mut w = Walk::default();
    for arg in func.args.slice() {
        w.declare_binding(&arg.binding);
    }
    w.stmts(func.body.stmts.slice());
    out.inline.root_declared = w.declared.iter().map(|d| r.names.name(*d)).collect();
    if !m.foreign {
        out.inline.root_module = r.names.declared_spellings().collect();
    }
    read_props(func, r, &mut out);
    let returned = read_stmts(func.body.stmts.slice(), r, &mut out, m);
    out.return_expr = returned.flatten().map(Expr::Raw);
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

/// Reads the statements of a component or custom-hook body in order. `Some(value)` when a
/// top-level `return` was reached (`value` is `None` for a bare `return`).
fn read_stmts(
    stmts: &[js_ast::Stmt],
    r: &mut Reader<'_, '_>,
    out: &mut BodyDecls,
    m: Module<'_, '_>,
) -> Option<Option<RawExpr>> {
    let mut returned = None;
    for (i, stmt) in stmts.iter().enumerate() {
        let loc = stmt.loc.start.max(0) as u32;
        // After the return only hoisted function declarations still mean
        // something; anything else is dead code we will not reason about.
        if returned.is_some()
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
                    read_decl(r, out, m, decl, loc, &stmts[..i]);
                }
            }
            S::SExpr(x) => read_expr_stmt(r, out, m, &x.value),
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
                returned = Some(ret.value.map(|v| r.expr(&v)));
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
    returned
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

fn read_decl(
    r: &mut Reader<'_, '_>,
    out: &mut BodyDecls,
    m: Module<'_, '_>,
    decl: &js_ast::G::Decl,
    loc: u32,
    prior: &[js_ast::Stmt],
) {
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
        if is_use_store(&call.target, r.names) {
            return read_use_store(r, out, decl, &args, vloc);
        }
        if !from_react {
            let site = Site {
                hook: &hook,
                call,
                binding: Some(&decl.binding),
                vloc,
                prior,
            };
            if inline_hook(r, out, m, &site) {
                return;
            }
        }
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
                // An elided value slot still needs a signal name (F17); `_st` keeps
                // it apart from the precompute slots `_sN`.
                let name = name_at(0).unwrap_or_else(|| format!("_st{}", out.state.len() + 1));
                let setter = name_at(1);
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

/// `const s = useStore(h)` / `const { k } = useStore(h)` (M3-F D7). The bindings were
/// marked by `mark_state_bindings`; this records the use or the reason it is refused.
fn read_use_store(
    r: &mut Reader<'_, '_>,
    out: &mut BodyDecls,
    decl: &js_ast::G::Decl,
    args: &[js_ast::Expr],
    vloc: u32,
) {
    let [arg] = args else {
        return out.fallback(
            "hook-shape",
            "useStore takes one store handle".into(),
            vloc,
            "write const s = useStore(handle)",
        );
    };
    let Some((handle, import)) = store_handle(arg, r.names) else {
        // R4: a handle declared in this module (`const cart = defineStore(…)` beside the
        // component) is never read: the worker would have to load a component module.
        if let E::EIdentifier(id) = &arg.data
            && r.names.import_of(id.ref_).is_none()
        {
            let name = r.names.name(id.ref_);
            return out.fallback(
                "store-name-unresolved",
                format!(
                    "useStore({name}): `{name}` is declared in the component's own module, not imported from a store module; the component renders as a React island"
                ),
                vloc,
                "define the store in its own module",
            );
        }
        return out.fallback(
            "store-name-unresolved",
            "useStore(…): the argument is not an imported store handle; the component renders as a React island".into(),
            vloc,
            "pass the handle imported from the module that calls defineStore('<name>', …)",
        );
    };
    let (view, fields) = match store_binding(&decl.binding) {
        Some(StoreBinding::View(id)) => (Some(r.names.name(id)), vec![]),
        Some(StoreBinding::Fields(fields)) => (
            None,
            fields
                .into_iter()
                .map(|(key, id)| (key, r.names.name(id)))
                .collect(),
        ),
        None => {
            return out.fallback(
                "hook-shape",
                "useStore result must be bound to a const or destructured one level deep".into(),
                vloc,
                "write const s = useStore(handle) or const { key } = useStore(handle)",
            );
        }
    };
    out.stores.push(StoreUse {
        handle,
        import,
        view,
        fields,
        loc: vloc,
        resolved: None,
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

fn read_expr_stmt(
    r: &mut Reader<'_, '_>,
    out: &mut BodyDecls,
    m: Module<'_, '_>,
    value: &js_ast::Expr,
) {
    let vloc = loc_of(value);
    let hook = hook_call(value, r.names);
    if let Some((_, call, _)) = &hook {
        out.classified_hooks.insert(call_addr(call));
    }
    if let Some((name, call, false)) = &hook
        && !is_use_store(&call.target, r.names)
    {
        let site = Site {
            hook: name,
            call,
            binding: None,
            vloc,
            prior: &[],
        };
        if inline_hook(r, out, m, &site) {
            return;
        }
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
        Some((_, call, _)) if is_use_store(&call.target, r.names) => out.fallback(
            "hook-shape",
            "useStore result must be bound".into(),
            vloc,
            "write const s = useStore(handle)",
        ),
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

/// One custom-hook call site (G3).
struct Site<'s> {
    /// The name the hook is called by.
    hook: &'s str,
    call: &'s js_ast::E::Call,
    /// `None` for a call as a statement.
    binding: Option<&'s js_ast::Binding>,
    vloc: u32,
    /// The caller's statements before this one.
    prior: &'s [js_ast::Stmt],
}

const HOOK_REMEDY: &str = "keep custom hooks to const declarations, React hooks brust supports and one final return, or move this component to React";

/// Inlines the custom hook `site` calls (G3, plan L5) and binds its result. `false` when
/// the callee is not a function this crate can read (the caller reports
/// `hook-unsupported`); otherwise the hook is inlined or a fallback names why not.
fn inline_hook(
    r: &mut Reader<'_, '_>,
    out: &mut BodyDecls,
    m: Module<'_, '_>,
    site: &Site<'_>,
) -> bool {
    let target = match &site.call.target.data {
        E::EIdentifier(id) => id.ref_,
        E::EImportIdentifier(id) => id.ref_,
        _ => return false,
    };
    let Some((source, imported)) = r
        .names
        .import_of(target)
        .map(|(s, i)| (s.to_string(), i.to_string()))
    else {
        let Some(func) = local_fn(m.ast, r.names, target) else {
            return false;
        };
        read_hook(r, out, m, func, site);
        return true;
    };
    let Some(opts) = m.opts else {
        return false;
    };
    if imported == "*" {
        return false;
    }
    let Some(path) = crate::analyze::modules::resolve(&m.parsed.path(), &source, opts) else {
        return false;
    };
    let hook = site.hook;
    let bytes = match std::fs::read(opts.root.join(&path)) {
        Ok(b) => b,
        Err(e) => {
            out.fallback(
                "hook-unsupported",
                format!("custom hook {hook}: cannot read {path}: {e}"),
                site.vloc,
                HOOK_REMEDY,
            );
            return true;
        }
    };
    let parsed = match crate::parse::parse_tsx(&path, bytes) {
        Ok(p) => p,
        Err(e) => {
            out.fallback(
                "hook-unsupported",
                format!("custom hook {hook}: cannot parse {path}: {}", e.message),
                site.vloc,
                HOOK_REMEDY,
            );
            return true;
        }
    };
    parsed.with_ast(|ast| {
        let hm = Module {
            parsed: &parsed,
            ast,
            opts: m.opts,
            foreign: true,
        };
        match exported_fn(ast, &imported) {
            Some(func) => read_hook(r, out, hm, func, site),
            None => out.fallback(
                "hook-unsupported",
                format!("custom hook {hook}: {path} exports no function declaration `{imported}`"),
                site.vloc,
                HOOK_REMEDY,
            ),
        }
    });
    true
}

/// The module-level `function` declaring `target`.
fn local_fn<'x>(
    ast: &'x js_ast::Ast<'_>,
    names: &NameTable<'_>,
    target: js_ast::Ref,
) -> Option<&'x js_ast::G::Fn> {
    ast.parts.iter().find_map(|part| {
        part.stmts.slice().iter().find_map(|s| match &s.data {
            S::SFunction(f)
                if f.func
                    .name
                    .as_ref()
                    .is_some_and(|n| names.same(n.ref_, target)) =>
            {
                Some(&f.func)
            }
            _ => None,
        })
    })
}

/// The function declaration a module exports as `export`: `export function`, `export default
/// function`, or a local function named in an `export { … }` clause.
fn exported_fn<'x>(ast: &'x js_ast::Ast<'_>, export: &str) -> Option<&'x js_ast::G::Fn> {
    let names = NameTable::for_hook(ast);
    let mut local = None;
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            match &stmt.data {
                S::SFunction(f)
                    if f.func.flags.contains(js_ast::flags::Function::IsExport)
                        && f.func
                            .name
                            .as_ref()
                            .is_some_and(|n| names.name(n.ref_) == export) =>
                {
                    return Some(&f.func);
                }
                S::SExportDefault(ed) if export == "default" => {
                    if let js_ast::StmtOrExpr::Stmt(inner) = &ed.value
                        && let S::SFunction(f) = &inner.data
                    {
                        return Some(&f.func);
                    }
                    return None;
                }
                S::SExportClause(c) => {
                    for item in c.items.slice() {
                        if item.alias.slice() == export.as_bytes() {
                            local = Some(item.name.ref_);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    local_fn(ast, &names, local?)
}

/// `local` made a name the compiler may emit (R5.1): no leading `_` (reserved for the
/// compiler's own names), no `$` (invalid in Jinja).
fn clean_name(local: &str) -> String {
    let s = local.replace('$', "_");
    let s = s.trim_start_matches('_');
    if s.is_empty() { "v".into() } else { s.into() }
}

/// Reads the body of the custom hook `func` (declared in `hm`) into `out` at `site`.
fn read_hook(
    r: &mut Reader<'_, '_>,
    out: &mut BodyDecls,
    hm: Module<'_, '_>,
    func: &js_ast::G::Fn,
    site: &Site<'_>,
) {
    let imported = hm.foreign;
    let (hook, vloc) = (site.hook, site.vloc);
    let path = hm.parsed.path();
    let fail = |out: &mut BodyDecls, rule: &str, why: String| {
        out.fallback(rule, why, vloc, HOOK_REMEDY);
    };
    let mut hnames = NameTable::for_hook(hm.ast);
    let fn_name = func
        .name
        .as_ref()
        .map(|n| hnames.name(n.ref_))
        .unwrap_or_else(|| hook.to_string());
    let key = (path.clone(), fn_name);
    if out.inline.stack.contains(&key) {
        let chain: Vec<&str> = out.inline.stack.iter().map(|(_, h)| h.as_str()).collect();
        return fail(
            out,
            "hook-recursive",
            format!(
                "custom hook {hook} calls itself (through {} → {hook})",
                chain.join(" → ")
            ),
        );
    }
    if out.inline.stack.len() >= MAX_HOOK_DEPTH {
        return fail(
            out,
            "hook-recursive",
            format!("custom hook {hook} nests custom hooks more than {MAX_HOOK_DEPTH} deep"),
        );
    }
    use js_ast::flags::Function as F;
    if func.flags.contains(F::IsAsync) || func.flags.contains(F::IsGenerator) {
        return fail(
            out,
            "hook-shape",
            format!("custom hook {hook} is async or a generator"),
        );
    }
    let mut params = Vec::new();
    for arg in func.args.slice() {
        match arg.binding.data {
            B::BIdentifier(id) if arg.default.is_none() && !func.flags.contains(F::HasRestArg) => {
                params.push(id.r#ref)
            }
            _ => {
                return fail(
                    out,
                    "hook-shape",
                    format!("custom hook {hook} has a default, rest or destructured parameter"),
                );
            }
        }
    }
    if site.call.args.len() > params.len() {
        return fail(
            out,
            "hook-shape",
            format!("custom hook {hook} is called with more arguments than it declares"),
        );
    }
    if site
        .call
        .args
        .iter()
        .any(|a| matches!(a.data, E::ESpread(_)))
    {
        return fail(
            out,
            "hook-shape",
            format!("custom hook {hook} is called with a spread argument"),
        );
    }
    mark_state_bindings(func, &mut hnames);

    let mut w = Walk::default();
    for arg in func.args.slice() {
        w.declare_binding(&arg.binding);
    }
    w.stmts(func.body.stmts.slice());
    if w.calls
        .iter()
        .any(|c| matches!(&c.data, E::ECall(call) if call.was_jsx_element))
    {
        return fail(
            out,
            "hook-shape",
            format!("custom hook {hook} builds JSX; a hook that renders is a component"),
        );
    }
    if w.dynamic_import.is_some() {
        return fail(
            out,
            "hook-shape",
            format!("custom hook {hook} uses a dynamic import()"),
        );
    }
    if let Some(p) = w
        .assigned
        .iter()
        .find(|a| params.iter().any(|p| hnames.same(*p, **a)))
    {
        return fail(
            out,
            "hook-shape",
            format!(
                "custom hook {hook} assigns its parameter `{}`",
                hnames.name(*p)
            ),
        );
    }
    if imported
        && w.calls
            .iter()
            .any(|c| matches!(&c.data, E::ECall(call) if is_use_store(&call.target, &hnames)))
    {
        return fail(
            out,
            "hook-shape",
            format!(
                "custom hook {hook} from {path} uses useStore; only a hook declared beside the component may"
            ),
        );
    }
    // Callees of hook calls never reach the output: inlined, read as React hooks, or a fallback.
    let mut callees: Vec<js_ast::Ref> = Vec::new();
    for c in &w.calls {
        let E::ECall(call) = &c.data else { continue };
        if hook_target(&call.target, &hnames).is_none() {
            continue;
        }
        match &call.target.data {
            E::EIdentifier(id) => callees.push(id.ref_),
            E::EImportIdentifier(id) => callees.push(id.ref_),
            E::EDot(d) => match &d.target.data {
                E::EIdentifier(id) => callees.push(id.ref_),
                E::EImportIdentifier(id) => callees.push(id.ref_),
                _ => {}
            },
            _ => {}
        }
    }
    for u in &w.used {
        if hnames.is_jsx_runtime(*u)
            || w.declared.iter().any(|d| hnames.same(*d, *u))
            || callees.iter().any(|c| hnames.same(*c, *u))
        {
            continue;
        }
        let (_, kind) = hnames.kind_of(*u);
        let spelled = hnames.name(*u);
        if spelled == "arguments" {
            return fail(
                out,
                "hook-shape",
                format!("custom hook {hook} reads `arguments`"),
            );
        }
        if imported && !matches!(kind, IdentKind::Global) {
            return fail(
                out,
                "hook-shape",
                format!(
                    "custom hook {hook} reads `{spelled}` from {path}; an imported hook may use only React hooks and globals"
                ),
            );
        }
        if imported && out.inline.root_module.contains(&spelled) {
            return fail(
                out,
                "hook-shape",
                format!(
                    "custom hook {hook} reads the global `{spelled}`, which the component's module declares"
                ),
            );
        }
        if out.inline.root_declared.contains(&spelled) {
            return fail(
                out,
                "hook-shape",
                format!("custom hook {hook} reads `{spelled}`, which the component also declares"),
            );
        }
    }

    // R5.1: every symbol the hook declares is renamed `<local>_<hook><n>`.
    if imported {
        out.inline.taken.extend(hnames.spellings());
    }
    let mut locals: Vec<(js_ast::Ref, String)> = Vec::new();
    for d in &w.declared {
        if !locals.iter().any(|(l, _)| hnames.same(*l, *d)) {
            locals.push((*d, hnames.name(*d)));
        }
    }
    let suffix = clean_name(hook);
    let mut n = out.inline.counters.get(hook).copied().unwrap_or(0) + 1;
    let generated: HashMap<String, String> = loop {
        let mut g = HashMap::new();
        for (_, l) in &locals {
            g.entry(l.clone())
                .or_insert_with(|| format!("{}_{suffix}{n}", clean_name(l)));
        }
        if g.values().any(|x| out.inline.taken.contains(x)) {
            n += 1;
            continue;
        }
        break g;
    };
    if generated.values().collect::<HashSet<_>>().len() != generated.len() {
        return fail(
            out,
            "hook-shape",
            format!("custom hook {hook} declares names that differ only in `_` or `$`"),
        );
    }
    out.inline.counters.insert(hook.to_string(), n);
    out.inline.taken.extend(generated.values().cloned());
    let gen_of = |names: &NameTable<'_>, r: js_ast::Ref| generated[&names.name(r)].clone();

    // Arguments: an identifier is the caller's binding; anything else is computed once at
    // the call site, under the parameter's generated name.
    let mut param_aliases = Vec::new();
    for (i, p) in params.iter().enumerate() {
        let alias = match site.call.args.get(i).map(|a| (a, &a.data)) {
            Some((_, E::EIdentifier(js_ast::E::Identifier { ref_, .. })))
            | Some((_, E::EImportIdentifier(js_ast::E::ImportIdentifier { ref_, .. }))) => Alias {
                print: r.names.name(*ref_),
                kind: Some(r.names.kind_of(*ref_)),
            },
            arg => {
                let name = gen_of(&hnames, *p);
                let expr = match arg {
                    Some((a, _)) => r.expr(a),
                    None => undefined_at(vloc),
                };
                out.derived.push(DerivedDecl {
                    name: name.clone(),
                    expr: Expr::Raw(expr),
                });
                Alias {
                    print: name,
                    kind: None,
                }
            }
        };
        param_aliases.push((*p, alias));
    }
    for (l, _) in &locals {
        if !params.iter().any(|p| hnames.same(*p, *l)) {
            let print = gen_of(&hnames, *l);
            hnames.set_alias(*l, Alias { print, kind: None });
        }
    }
    for (p, a) in param_aliases {
        hnames.set_alias(p, a);
    }

    let start = Marks::of(out);
    let reason_before = out.react_reason.clone();
    let saved = std::mem::take(&mut out.classified_hooks);
    out.inline.stack.push(key);
    let returned = {
        let print = |js: Js<'_>, a: &Aliases| print_js_with(hm.parsed, hm.ast, a, js);
        let mut hr = Reader::new(&mut hnames, &print);
        let returned = read_stmts(func.body.stmts.slice(), &mut hr, out, hm);
        nested_hooks(func, hr.names, out);
        out.diagnostics.append(&mut hr.diagnostics);
        if !hr.pending_handlers.is_empty() {
            fail(
                out,
                "hook-shape",
                format!("custom hook {hook} declares an inline handler"),
            );
        }
        returned
    };
    out.inline.stack.pop();
    out.classified_hooks = saved;

    // What went wrong inside is reported at the call site, naming the hook (R0.2).
    let text = hm.parsed.text();
    for d in &mut out.diagnostics[start.diagnostics..] {
        let (line, _) = line_col(text, d.loc);
        d.message = format!("{} (in custom hook {hook}, {path}:{line})", d.message);
        d.loc = vloc;
    }
    if reason_before.is_none()
        && let Some(reason) = out.react_reason.clone()
    {
        out.react_reason = out.diagnostics[start.diagnostics..]
            .iter()
            .find(|d| d.message.starts_with(&reason))
            .map(|d| d.message.clone())
            .or(Some(reason));
    }
    let mut returned = returned.flatten();
    if imported {
        start.relocate(out, vloc);
        if let Some(e) = &mut returned {
            relocate(e, vloc);
        }
    }
    if out.diagnostics[start.diagnostics..]
        .iter()
        .any(|d| d.class == DiagClass::Fallback)
    {
        return;
    }
    bind_result(r, out, site, returned);
}

/// Lengths of `out`'s lists before a hook is read, so what it added can be found.
struct Marks {
    diagnostics: usize,
    state: usize,
    derived: usize,
    effects: usize,
    handlers: usize,
    refs: usize,
}

impl Marks {
    fn of(out: &BodyDecls) -> Self {
        Marks {
            diagnostics: out.diagnostics.len(),
            state: out.state.len(),
            derived: out.derived.len(),
            effects: out.effects.len(),
            handlers: out.handlers.len(),
            refs: out.refs.len(),
        }
    }

    /// Points everything read since at `loc`: locations in another file mean nothing here.
    fn relocate(&self, out: &mut BodyDecls, loc: u32) {
        let raw = |e: &mut Expr| {
            if let Expr::Raw(r) = e {
                relocate(r, loc)
            }
        };
        out.state[self.state..]
            .iter_mut()
            .for_each(|s| raw(&mut s.init));
        out.derived[self.derived..]
            .iter_mut()
            .for_each(|d| raw(&mut d.expr));
        out.refs[self.refs..]
            .iter_mut()
            .for_each(|d| raw(&mut d.init));
        out.handlers[self.handlers..]
            .iter_mut()
            .for_each(|h| relocate(&mut h.body, loc));
        for e in &mut out.effects[self.effects..] {
            relocate(&mut e.body, loc);
            e.deps.iter_mut().flatten().for_each(|d| relocate(d, loc));
        }
    }
}

fn relocate(e: &mut RawExpr, loc: u32) {
    e.loc = loc;
    match &mut e.kind {
        RawKind::Lit(_) | RawKind::Ident { .. } | RawKind::Opaque { .. } | RawKind::Jsx(_) => {}
        RawKind::Member { target, .. } => relocate(target, loc),
        RawKind::Index { target, index } => {
            relocate(target, loc);
            relocate(index, loc);
        }
        RawKind::Call { callee, args } => {
            relocate(callee, loc);
            args.iter_mut().for_each(|a| relocate(a, loc));
        }
        RawKind::Binary { left, right, .. } => {
            relocate(left, loc);
            relocate(right, loc);
        }
        RawKind::Unary { value, .. } => relocate(value, loc),
        RawKind::Cond { test, yes, no } => {
            relocate(test, loc);
            relocate(yes, loc);
            relocate(no, loc);
        }
        RawKind::Template { parts, .. } => parts.iter_mut().for_each(|(p, _)| relocate(p, loc)),
        RawKind::Array(items) => items.iter_mut().for_each(|i| relocate(i, loc)),
        RawKind::Object(props) => props.iter_mut().for_each(|(_, v)| relocate(v, loc)),
        RawKind::Arrow { body, .. } => {
            if let ArrowBody::Expr(b) = body {
                relocate(b, loc)
            }
        }
    }
}

/// A value whose computation can be dropped: no call, nothing opaque.
fn inert(e: &RawExpr) -> bool {
    match &e.kind {
        RawKind::Lit(_) | RawKind::Ident { .. } | RawKind::Arrow { .. } => true,
        RawKind::Member { target, .. } => inert(target),
        RawKind::Array(items) => items.iter().all(inert),
        RawKind::Object(props) => props.iter().all(|(_, v)| inert(v)),
        _ => false,
    }
}

/// Binds the hook's returned value to the call site's pattern.
fn bind_result(
    r: &mut Reader<'_, '_>,
    out: &mut BodyDecls,
    site: &Site<'_>,
    returned: Option<RawExpr>,
) {
    let (hook, vloc) = (site.hook, site.vloc);
    let shape = |out: &mut BodyDecls, why: String| {
        out.fallback(
            "hook-return-shape",
            why,
            vloc,
            "return one value, or an array or object literal the call site destructures",
        )
    };
    let Some(binding) = site.binding else {
        if returned.as_ref().is_some_and(|v| !inert(v)) {
            shape(
                out,
                format!("custom hook {hook} computes a value the call site discards"),
            );
        }
        return;
    };
    let value = returned.unwrap_or_else(|| undefined_at(vloc));
    match binding.data {
        B::BIdentifier(id) => bind_one(r, out, site, id.r#ref, value),
        B::BMissing(_) => {}
        B::BArray(arr) => {
            let RawKind::Array(items) = value.kind else {
                return shape(
                    out,
                    format!(
                        "custom hook {hook} is destructured as an array but does not return an array literal"
                    ),
                );
            };
            if arr.has_spread {
                return shape(
                    out,
                    format!("custom hook {hook}: ...rest in the array pattern"),
                );
            }
            let mut binds = Vec::new();
            for (i, item) in arr.items().iter().enumerate() {
                match item.binding.data {
                    B::BMissing(_) => {}
                    B::BIdentifier(id) if item.default_value.is_none() => {
                        let Some(v) = items.get(i) else {
                            return shape(
                                out,
                                format!(
                                    "custom hook {hook} returns fewer items than the pattern binds"
                                ),
                            );
                        };
                        binds.push((id.r#ref, v.clone()));
                    }
                    _ => {
                        return shape(
                            out,
                            format!(
                                "custom hook {hook}: a default or nested pattern in the array pattern"
                            ),
                        );
                    }
                }
            }
            for (b, v) in binds {
                bind_one(r, out, site, b, v);
            }
        }
        B::BObject(obj) => {
            let RawKind::Object(props) = value.kind else {
                return shape(
                    out,
                    format!(
                        "custom hook {hook} is destructured as an object but does not return an object literal"
                    ),
                );
            };
            let mut binds = Vec::new();
            for p in obj.properties() {
                let plain = !p.flags.contains(js_ast::flags::Property::IsSpread)
                    && !p.flags.contains(js_ast::flags::Property::IsComputed)
                    && p.default_value.is_none();
                let (true, E::EString(key), B::BIdentifier(id)) =
                    (plain, &p.key.data, p.value.data)
                else {
                    return shape(
                        out,
                        format!(
                            "custom hook {hook}: a default, computed key, ...rest or nested pattern in the object pattern"
                        ),
                    );
                };
                let key = crate::analyze::expr::estring(key);
                let Some((_, v)) = props.iter().rev().find(|(k, _)| *k == key) else {
                    return shape(out, format!("custom hook {hook} returns no `{key}`"));
                };
                binds.push((id.r#ref, v.clone()));
            }
            for (b, v) in binds {
                bind_one(r, out, site, b, v);
            }
        }
    }
}

/// `binding` is the returned `value`: an identifier the hook returns is the same binding
/// (it keeps its kind: state, setter, store); anything else is derived.
fn bind_one(
    r: &mut Reader<'_, '_>,
    out: &mut BodyDecls,
    site: &Site<'_>,
    binding: js_ast::Ref,
    value: RawExpr,
) {
    if let RawKind::Ident { name, kind } = &value.kind
        && !matches!(kind, IdentKind::Prop)
    {
        // A closure declared earlier read the caller's binding under its own name.
        let mut w = Walk::default();
        w.stmts(site.prior);
        if !w.used.iter().any(|u| r.names.same(*u, binding)) {
            r.names.set_alias(
                binding,
                Alias {
                    print: name.clone(),
                    kind: Some((name.clone(), kind.clone())),
                },
            );
            return;
        }
    }
    out.derived.push(DerivedDecl {
        name: r.names.name(binding),
        expr: Expr::Raw(value),
    });
}
