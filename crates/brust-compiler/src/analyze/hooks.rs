//! Hook calls and the component body (spec §4.3). Reads the component's
//! top-level statements in order; anything React-only is recorded as a
//! `Fallback` diagnostic (the tier itself is decided in M1b-2).
use crate::analyze::component::AnalyzeOptions;
use crate::analyze::expr::{Js, Reader, Walk, loc_of, print_js_with};
use crate::analyze::names::{Alias, Aliases, NameTable};
use crate::analyze::plain_fn;
use crate::ir::{
    ArrowBody, DerivedDecl, DiagClass, Diagnostic, EffectDecl, Expr, HandlerDecl, IdentKind,
    Literal, PolyTag, PropDecl, RawExpr, RawKind, RefDecl, StateDecl, StoreUse, UnOp, line_col,
};
use crate::parse::Parsed;
use bun_ast as js_ast;
use js_ast::OpCode;
use js_ast::b::B;
use js_ast::expr::Data as E;
use js_ast::stmt::Data as S;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Default)]
pub struct BodyDecls {
    pub props: Vec<PropDecl>,
    /// The local of a `...rest` in the props pattern (R34.14).
    pub props_rest: Option<String>,
    /// The whole-props parameter's local when a `...rest` removed its prop (`ComponentIR::props_whole`).
    pub props_whole: Option<String>,
    /// The polymorphic tag `const Comp = asChild ? Slot.Root : "host"` (R34.28).
    pub poly: Option<PolyTag>,
    pub state: Vec<StateDecl>,
    pub derived: Vec<DerivedDecl>,
    pub effects: Vec<EffectDecl>,
    pub handlers: Vec<HandlerDecl>,
    pub refs: Vec<RefDecl>,
    /// Locals bound to `useId()`.
    pub id_bindings: Vec<String>,
    pub uses_id: bool,
    /// W1d PR 3: the tests of an early-return chain (`if (a) return A; if (b) return B; throw …`) whose last statement
    /// throws: the render is valid only when one of them holds. `None`: no throw.
    pub throw_unless: Option<Vec<RawExpr>>,
    /// The props those tests read (frozen: see `ComponentIR::throw_props`).
    pub throw_props: Vec<String>,
    /// R34.140: the component asks for the items of its collection (`useCollection(scope)`).
    pub uses_collection: bool,
    /// F329: the `useRef` cells nothing reads (every use is a component's `ref` prop).
    pub sink_refs: Vec<String>,
    /// F288 G9: render-time `ref.current = v` statements, judged by the `render_ref_writes` pass.
    pub render_ref_writes: Vec<crate::ir::RenderRefWrite>,
    /// F288 G9: the deps array of each `useCallback` binding (`None`: no deps argument).
    pub callback_deps: Vec<(String, Option<Vec<RawExpr>>)>,
    /// F288 (Mellow F2): how many branches of an early-return chain the statements being read sit in (0: every render).
    branch_depth: u32,
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

/// R34.142: the field a context's whole value travels as, for a context declared with a literal default that a consumer
/// reads as a value (`const dir = useContext(DirectionContext)`, not `ctx.field`) and a Provider hands one expression to.
pub(crate) const WHOLE_FIELD: &str = "__whole";

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
    /// R34.142: addresses of the `useId()` calls that seed a state nothing updates (`drop_inert_id_effects`); the state
    /// is that id.
    inert_id_states: HashSet<usize>,
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

fn react_named(names: &NameTable<'_>, r: js_ast::Ref) -> Option<String> {
    match names.import_of(r) {
        Some(("react", imported)) if imported != "default" && imported != "*" => {
            Some(imported.to_string())
        }
        _ => None,
    }
}

/// F237: the callee of a comma call (`(0, useId)()`, what bundlers emit to call an import without a `this`): the
/// right side, when what precedes it is a literal (nothing runs). The call is the hook it names.
fn comma_callee(target: &js_ast::Expr) -> &js_ast::Expr {
    match &target.data {
        E::EBinary(b)
            if b.op == js_ast::OpCode::BinComma
                && matches!(
                    b.left.data,
                    E::ENumber(_) | E::EString(_) | E::EBoolean(_) | E::ENull(_) | E::EUndefined(_)
                ) =>
        {
            comma_callee(&b.right)
        }
        _ => target,
    }
}

fn react_hook_target(target: &js_ast::Expr, names: &NameTable<'_>) -> Option<String> {
    let target = comma_callee(target);
    match &target.data {
        E::EImportIdentifier(id) => react_named(names, id.ref_),
        // A module const read as React's own hook (`names.rs`, `collect_react_hook_aliases`).
        E::EIdentifier(id) => react_named(names, id.ref_),
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
    let target = comma_callee(target);
    if is_use_store(target, names) {
        return Some(("useStore".into(), false));
    }
    // F255: `useId.call(null)`, `.apply(…)`, `.bind(…)()` invoke the hook through a method of the function. The reader
    // does not follow that spelling, so the call is named as the hook it reaches and left unclassified: the body
    // reader refuses it by name instead of compiling it with a variable nothing binds.
    if let E::EDot(d) = &target.data
        && matches!(d.name.slice(), b"call" | b"apply" | b"bind")
        && let Some((inner, _)) = hook_target(&d.target, names)
    {
        return Some((inner, false));
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

pub(crate) fn call_addr(call: &js_ast::E::Call) -> usize {
    call as *const js_ast::E::Call as usize
}

/// Marks `const [a, setA] = useState(…)` bindings in `names` before any
/// expression of the body is read, so reads resolve to `State` / `Setter`;
/// and `useStore(h)` bindings, so reads resolve to `Store` (M3-F D7).
pub fn mark_state_bindings(func: &js_ast::G::Fn, names: &mut NameTable<'_>) {
    let mut w = Walk::default();
    w.stmts(func.body.stmts.slice());
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
            // B4: `const x = useRef(init)` read only as `x.current` in the render and never written.
            if let (Some(value), B::BIdentifier(id)) = (&decl.value, decl.binding.data)
                && let E::ECall(call) = &value.data
                && react_hook_name(call, names).as_deref() == Some("useRef")
                && is_snapshot_ref(&w, names, id.r#ref)
            {
                names.mark_snapshot_ref(id.r#ref);
                continue;
            }
            // F329: `const x = useRef(init)` whose every use is the `ref` prop of a component element: nothing reads it.
            if let (Some(value), B::BIdentifier(id)) = (&decl.value, decl.binding.data)
                && let E::ECall(call) = &value.data
                && react_hook_name(call, names).as_deref() == Some("useRef")
                && is_sink_ref(&w, names, id.r#ref)
            {
                names.mark_sink_ref(id.r#ref);
                continue;
            }
            let (Some(value), B::BArray(arr)) = (&decl.value, decl.binding.data) else {
                continue;
            };
            let E::ECall(call) = &value.data else {
                continue;
            };
            // F285: a reducer's state is a state cell; its dispatch is a handler, not a setter.
            let hook = react_hook_name(call, names);
            if !matches!(hook.as_deref(), Some("useState" | "useReducer")) {
                continue;
            }
            let items = arr.items();
            if let Some(B::BIdentifier(id)) = items.first().map(|i| i.binding.data) {
                names.mark_state(id.r#ref);
            }
            if hook.as_deref() == Some("useState")
                && let Some(B::BIdentifier(id)) = items.get(1).map(|i| i.binding.data)
            {
                names.mark_setter(id.r#ref);
            }
        }
    }
}

/// F329: every use of `r` in `w` is the `ref` prop of a component element, and `r` is never written, assigned or handed on.
fn is_sink_ref(w: &Walk, names: &NameTable<'_>, r: js_ast::Ref) -> bool {
    let uses: Vec<i32> = w
        .used_at
        .iter()
        .filter(|(u, _)| names.same(*u, r))
        .map(|(_, loc)| *loc)
        .collect();
    !uses.is_empty()
        && !w.opaque_write
        && !w.assigned.iter().any(|a| names.same(*a, r))
        && !w.member_written.iter().any(|a| names.same(*a, r))
        && !w.member_writes.iter().any(|(a, _)| names.same(*a, r))
        && !w.fn_uses.iter().any(|a| names.same(*a, r))
        && uses.iter().all(|loc| w.component_ref_props.contains(loc))
}

/// B4: every read of `r` in `w` is `r.current` outside any function, and `r` is never written, assigned, or handed on.
fn is_snapshot_ref(w: &Walk, names: &NameTable<'_>, r: js_ast::Ref) -> bool {
    let uses: Vec<i32> = w
        .used_at
        .iter()
        .filter(|(u, _)| names.same(*u, r))
        .map(|(_, loc)| *loc)
        .collect();
    !uses.is_empty()
        && !w.opaque_write
        && !w.assigned.iter().any(|a| names.same(*a, r))
        && !w.member_written.iter().any(|a| names.same(*a, r))
        && !w.member_writes.iter().any(|(a, _)| names.same(*a, r))
        && !w.fn_uses.iter().any(|a| names.same(*a, r))
        && uses.iter().all(|loc| w.current_reads.contains(loc))
}

/// The component's props: one per destructured property, or `props` for a
/// plain parameter. TS type text is not recovered in M1b-1. Renames, defaults
/// and a `...rest` binding (R34.14: `ir.props_rest`) are read; nested patterns,
/// computed keys and a default for the whole parameter are a `prop-pattern`
/// fallback.
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
            });
            // `const { a, ...rest } = props` in the body reads like a parameter pattern (R34.66).
            let whole = out.props.len() - 1;
            for stmt in func.body.stmts.slice() {
                if let S::SLocal(l) = &stmt.data
                    && let Some(d) = l.decls.first()
                    && r.names.is_absorbed(d.binding.loc.start)
                    && let B::BObject(obj) = d.binding.data
                {
                    read_object_pattern(&obj, r, out, &pattern);
                }
            }
            // the plain `props` binding is not a prop named `props`: a rest must not leave a key of that name out
            if out.props_rest.is_some() {
                let gone = out.props.remove(whole);
                out.props_whole = Some(gone.local);
            }
        }
        B::BObject(obj) => read_object_pattern(&obj, r, out, &pattern),
        B::BArray(_) | B::BMissing(_) => pattern(out, loc, "an array pattern"),
    }
}

/// The props of one object pattern (a parameter, or a body `const { … } = props`): plain keys with their defaults
/// and a trailing `...rest`; anything else is a `prop-pattern` fallback.
fn read_object_pattern(
    obj: &js_ast::B::Object,
    r: &mut Reader<'_, '_>,
    out: &mut BodyDecls,
    pattern: &dyn Fn(&mut BodyDecls, u32, &str),
) {
    for p in obj.properties() {
        let ploc = loc_of(&p.key);
        if p.flags.contains(js_ast::flags::Property::IsSpread) {
            match p.value.data {
                B::BIdentifier(id) => out.props_rest = Some(r.names.name(id.r#ref)),
                _ => pattern(out, ploc, "a pattern after `...`"),
            }
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
        let name = crate::analyze::expr::estring(key);
        // F161 (R39.1): a prop is a template variable named by its key, so a key that is not a plain identifier
        // (`'data-x': dx`) prints as `data-x`, which jinja reads as a subtraction: every render fails. Fail closed;
        // native support for quoted keys is a later F-row.
        if let Some((code, what)) = crate::analyze::names::template_name_problem(&name) {
            out.fallback(
                code,
                format!("the props key `{name}` {what}"),
                ploc,
                "rename the prop at the call sites, or keep this component in React",
            );
            continue;
        }
        let mut default = p.default_value.as_ref().map(|d| r.expr(d));
        // F153b: a default naming module constants (`orientation = DEFAULT_ORIENTATION`) is the folded value.
        if let Some(d) = &default
            && default_unprintable(d, &HashSet::new()).is_some()
            && let Some(folded) = fold_default(r, d)
        {
            default = Some(folded);
        }
        out.props.push(PropDecl {
            name,
            local: r.names.name(id.r#ref),
            ts_type: None,
            default,
        });
    }
}

/// `d` with its module constants folded to a literal value, `None` when it does not fold (the caller keeps `d` and
/// its diagnostic). The constants are the module's never-written `const`s of literal shape; the folder never runs
/// user code and fails closed on anything it does not know.
fn fold_default(r: &mut Reader<'_, '_>, d: &RawExpr) -> Option<RawExpr> {
    let inits: Vec<(String, js_ast::Expr)> = r
        .names
        .module_inits()
        .iter()
        .map(|(n, e)| (n.clone(), *e))
        .collect();
    if inits.is_empty() {
        return None;
    }
    let consts: HashMap<String, RawExpr> =
        inits.into_iter().map(|(n, e)| (n, r.expr(&e))).collect();
    let lookup = |n: &str| consts.get(n).cloned();
    let v = crate::ir::FoldEnv::new(&lookup).fold(d).ok()?;
    value_expr(&v, d.loc)
}

/// A folded value as a literal expression (`undefined` is not one: a default that folds to it stays as written).
fn value_expr(v: &crate::ir::V, loc: u32) -> Option<RawExpr> {
    use crate::ir::{Literal, V};
    let kind = match v {
        V::Undef => return None,
        V::Null => RawKind::Lit(Literal::Null),
        V::Bool(b) => RawKind::Lit(Literal::Bool(*b)),
        V::Num(n) if n.is_finite() => RawKind::Lit(Literal::Num(*n)),
        V::Num(_) => return None,
        V::Str(s) => RawKind::Lit(Literal::Str(s.clone())),
        V::Arr(xs) => RawKind::Array(
            xs.iter()
                .map(|x| value_expr(x, loc))
                .collect::<Option<_>>()?,
        ),
        V::Obj(ps) => RawKind::Object(
            ps.iter()
                .map(|(k, x)| Some((k.clone(), value_expr(x, loc)?)))
                .collect::<Option<_>>()?,
        ),
    };
    Some(RawExpr { loc, kind })
}

/// F161 (R39.1): the server template prints a destructuring default with `lower::server_expr`, which turns
/// anything outside its subset into `none` (an IIFE, a call of a local function, JSX, `typeof`, a module
/// constant it does not fold). The page then renders without the default and no diagnostic says so. `Some((code,
/// what))` names the first part that would be lost; an arrow stays (it is only ever a client value, and a
/// function renders as nothing in React as well).
pub(crate) fn default_unprintable(
    e: &RawExpr,
    defaulted: &HashSet<String>,
) -> Option<(&'static str, &'static str)> {
    const SHAPE: &str = "prop-default-shape";
    let un = |x: &RawExpr| default_unprintable(x, defaulted);
    let all = |xs: &[RawExpr]| xs.iter().find_map(un);
    match &e.kind {
        RawKind::Lit(_) | RawKind::Arrow { .. } => None,
        RawKind::Ident {
            name,
            kind: IdentKind::Prop,
        } if defaulted.contains(name) => Some((
            SHAPE,
            "an earlier prop that has a default of its own (the template reads the prop without it)",
        )),
        RawKind::Ident {
            kind: IdentKind::Prop,
            ..
        } => None,
        RawKind::Ident { .. } => Some((
            SHAPE,
            "a name that is not a prop (a module constant, an import or a global)",
        )),
        RawKind::Member { target, .. } => un(target),
        RawKind::Index { target, index } => un(target).or_else(|| un(index)),
        RawKind::Unary {
            op: UnOp::Typeof, ..
        } => Some((SHAPE, "a `typeof`")),
        RawKind::Unary { value, .. } => un(value),
        RawKind::Binary { left, right, .. } => un(left).or_else(|| un(right)),
        RawKind::Cond { test, yes, no } => un(test).or_else(|| un(yes)).or_else(|| un(no)),
        RawKind::Template { parts, .. } => parts.iter().find_map(|(p, _)| un(p)),
        RawKind::Array(xs) => all(xs),
        RawKind::Object(ps) => ps.iter().find_map(|(_, v)| un(v)),
        RawKind::Jsx(_) => Some((SHAPE, "JSX")),
        RawKind::Opaque { why, .. } if why == "call target" => Some((
            "prop-default-iife",
            "an immediately-invoked function or another call the reader cannot follow",
        )),
        RawKind::Opaque { .. } => Some((SHAPE, "an expression outside the subset")),
        RawKind::Call { callee, args } => {
            let supported = match &callee.kind {
                RawKind::Member { target, name, .. } => match &target.kind {
                    RawKind::Ident {
                        name: obj,
                        kind: IdentKind::Global,
                    } => {
                        matches!(
                            (obj.as_str(), name.as_str()),
                            ("Object", "keys" | "entries")
                        ) || (obj == "Array"
                            && name == "from"
                            && matches!(args.first().map(|a| &a.kind), Some(RawKind::Object(_))))
                    }
                    _ => matches!(
                        name.as_str(),
                        "toUpperCase"
                            | "toLowerCase"
                            | "trim"
                            | "slice"
                            | "startsWith"
                            | "endsWith"
                            | "includes"
                            | "join"
                    ),
                },
                _ => false,
            };
            if !supported {
                return Some((SHAPE, "a call outside the subset"));
            }
            if let RawKind::Member { target, .. } = &callee.kind
                && !matches!(
                    &target.kind,
                    RawKind::Ident {
                        kind: IdentKind::Global,
                        ..
                    }
                )
                && let Some(x) = un(target)
            {
                return Some(x);
            }
            all(args)
        }
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
    // F289: the same rule one step outside a hook: `const o = { cb: toggle }` in the component, with `toggle` a handler.
    if out.react_reason.is_none()
        && let Some(name) = client_function_in_derived(&out, 0)
    {
        out.fallback(
            "client-function-in-job",
            format!(
                "a value computed per request names `{name}`, a handler, setter or function the client owns"
            ),
            0,
            "use the function only in an event handler or the JSX, or keep this component in React",
        );
    }
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
    let mut branched = 0;
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
                // Read as the props pattern (names.rs `absorb_body_patterns`): nothing else to read here.
                if local.decls.len() == 1 && r.names.is_absorbed(local.decls[0].binding.loc.start) {
                    continue;
                }
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
                if let Some(v) = &ret.value {
                    hoist_ids(v, r, out, m);
                }
                returned = Some(ret.value.map(|v| {
                    // R34.143: `return useSyncExternalStore(...)` of the hydration shape is the hook's one state
                    if !out.inline.stack.is_empty()
                        && let Some((_, call, true)) = hook_call(&v, r.names)
                        && react_hook_name(call, r.names).as_deref() == Some("useSyncExternalStore")
                        && hydration_shape(call, m, r.names)
                        && !out.classified_hooks.contains(&call_addr(call))
                    {
                        out.classified_hooks.insert(call_addr(call));
                        let mut n = 1;
                        let name = loop {
                            let name = format!("ret{n}_useSyncExternalStore");
                            if out.inline.taken.insert(name.clone()) {
                                break name;
                            }
                            n += 1;
                        };
                        let vloc = loc_of(&v);
                        hydrated_state(out, name.clone(), vloc);
                        return RawExpr {
                            loc: vloc,
                            kind: RawKind::Ident {
                                name,
                                kind: IdentKind::State,
                            },
                        };
                    }
                    returned_value(&v, r, out, m)
                }));
            }
            // S2 (R34.104): `if (cond) { console.error(…) }` only logs (Radix's dev validation of its props): it is not
            // part of the render, so it is left out; any other effect of a branch keeps the control-flow fallback.
            S::SIf(i) if console_only_if(i, r.names) => {}
            // R34.142: `if (typeof useReactInsertionEffect === 'function') { A } else { B }` where the name is React's own
            // hook (a module const read off the React namespace): React exports its hooks as functions, so the test is
            // decided and only the branch that runs is read (Radix's `useCallbackRef`, written for React versions that
            // lack `useInsertionEffect`).
            S::SIf(i) if let Some(taken) = hook_presence_test(&i.test, r.names) => {
                let branch = if taken { Some(i.yes) } else { i.no };
                if let Some(b) = branch {
                    let inner: Vec<js_ast::Stmt> = match &b.data {
                        S::SBlock(blk) => blk.stmts.slice().to_vec(),
                        _ => vec![b],
                    };
                    if let Some(v) = read_stmts(&inner, r, out, m) {
                        returned = Some(v);
                    }
                }
            }
            // W1d PR 3: `if (a) { const …; return A }` followed by the rest of the body (an early-return chain, ending in a
            // return or a `throw`): one nested conditional, each branch's consts hoisted into the body (they are lazy
            // derived values, so a branch that does not run costs nothing). Components only.
            S::SIf(ifs)
                if out.inline.stack.is_empty()
                    && ends_with_return(&ifs.yes)
                    && ifs.no.as_ref().is_none_or(ends_with_return_or_throw) =>
            {
                // both arms (and what follows the `if`) run on some renders only
                out.branch_depth += 1;
                branched += 1;
                let test = r.expr(&ifs.test);
                let before = out.derived.len();
                let yes_stmts = branch_stmts(&ifs.yes);
                let yes = match read_stmts(&yes_stmts, r, out, m) {
                    Some(Some(v)) => v,
                    _ => {
                        out.fallback(
                            "control-flow",
                            "an early return without a value".into(),
                            loc,
                            "return one JSX tree",
                        );
                        break;
                    }
                };
                let mut rest: Vec<js_ast::Stmt> = match &ifs.no {
                    Some(n) => branch_stmts(n),
                    None => stmts[i + 1..].to_vec(),
                };
                let mut throws = false;
                if let [only] = rest.as_slice()
                    && let S::SThrow(t) = &only.data
                {
                    // W1d PR 3 (ruling A): a render error with a literal message (never printed: the 500 goes through the
                    // server's own error path); any other thrown value is not read
                    if !literal_error_throw(&t.value, m, r.names) {
                        out.fallback(
                            "control-flow",
                            "the throw of an early-return chain is not `throw new Error(<literal>)`".into(),
                            loc,
                            "throw an Error with a literal message, or keep this component in React",
                        );
                        break;
                    }
                    rest.clear();
                    throws = true;
                }
                let no = match read_stmts(&rest, r, out, m) {
                    Some(Some(v)) => v,
                    None if throws => {
                        // the chain ends in the throw: a render error
                        out.throw_unless.get_or_insert_with(Vec::new);
                        throw_arm(loc)
                    }
                    _ => {
                        out.fallback(
                            "control-flow",
                            "an early-return chain must end in a return or a throw".into(),
                            loc,
                            "return one JSX tree",
                        );
                        break;
                    }
                };
                if throws || out.throw_unless.is_some() {
                    out.throw_unless
                        .get_or_insert_with(Vec::new)
                        .push(test.clone());
                    let mut roots = Vec::new();
                    prop_roots(&test, &mut roots);
                    for p in roots {
                        if !out.throw_props.contains(&p) {
                            out.throw_props.push(p);
                        }
                    }
                    // ruling A (3): a test that can change after mount would make the error a client-side one
                    let body_locals: Vec<&str> = out
                        .derived
                        .iter()
                        .map(|d| d.name.as_str())
                        .chain(out.handlers.iter().map(|h| h.name.as_str()))
                        .chain(out.refs.iter().map(|x| x.name.as_str()))
                        .chain(out.state.iter().map(|x| x.name.as_str()))
                        .collect();
                    if !test_is_static(&test, &body_locals) {
                        out.fallback(
                            "control-flow",
                            "the test of an early return that ends in a throw reads something that changes after mount".into(),
                            loc,
                            "decide the render from props, or keep this component in React",
                        );
                        break;
                    }
                }
                // a hoisted const must not shadow another of the body
                let names: Vec<&String> = out.derived.iter().map(|d| &d.name).collect();
                if out.derived[before..]
                    .iter()
                    .any(|d| names.iter().filter(|n| **n == &d.name).count() > 1)
                {
                    out.fallback(
                        "control-flow",
                        "two branches of an early-return chain declare the same name".into(),
                        loc,
                        "give each branch's consts a different name",
                    );
                    break;
                }
                returned = Some(Some(RawExpr {
                    loc,
                    kind: RawKind::Cond {
                        test: Box::new(test),
                        yes: Box::new(yes),
                        no: Box::new(no),
                    },
                }));
                break;
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
    out.branch_depth -= branched;
    returned
}

/// The value a `return` hands out. B2: inside a custom hook, `return React.useCallback(…)` (Radix's `useComposedRefs`)
/// is the same hook as `const x = useCallback(…); return x`: the call is read under a generated name that the return
/// then reads. Any other returned expression is read as it is.
fn returned_value(
    v: &js_ast::Expr,
    r: &mut Reader<'_, '_>,
    out: &mut BodyDecls,
    m: Module<'_, '_>,
) -> RawExpr {
    if !out.inline.stack.is_empty()
        && let Some((hook, call, true)) = hook_call(v, r.names)
        && matches!(
            hook.as_str(),
            "useMemo" | "useCallback" | "useRef" | "useId"
        )
        && !out.classified_hooks.contains(&call_addr(call))
    {
        out.classified_hooks.insert(call_addr(call));
        let mut n = 1;
        let name = loop {
            // Not `use…`: the name must not read as a hook call where the caller invokes the result.
            let name = format!("ret{n}_{}", clean_name(&hook));
            if out.inline.taken.insert(name.clone()) {
                break name;
            }
            n += 1;
        };
        let vloc = loc_of(v);
        let args: Vec<js_ast::Expr> = call.args.to_vec();
        simple_hook(r, out, &hook, Some(name.clone()), &args, vloc, false);
        return RawExpr {
            loc: vloc,
            kind: RawKind::Ident {
                name,
                kind: IdentKind::Local,
            },
        };
    }
    // F286 / F285: `return useState(…)` / `return useReducer(…)` of a custom hook is the pair the call site destructures.
    if !out.inline.stack.is_empty()
        && let Some((hook, call, true)) = hook_call(v, r.names)
        && matches!(hook.as_str(), "useState" | "useReducer")
        && !out.classified_hooks.contains(&call_addr(call))
    {
        out.classified_hooks.insert(call_addr(call));
        let vloc = loc_of(v);
        let args: Vec<js_ast::Expr> = call.args.to_vec();
        let mut n = 1;
        let (state, set) = loop {
            let state = format!("ret{n}_{}", clean_name(&hook));
            let set = format!("{state}_set");
            if !out.inline.taken.contains(&state) && !out.inline.taken.contains(&set) {
                out.inline.taken.insert(state.clone());
                out.inline.taken.insert(set.clone());
                break (state, set);
            }
            n += 1;
        };
        let ident = |name: &str, kind: IdentKind| RawExpr {
            loc: vloc,
            kind: RawKind::Ident {
                name: name.to_string(),
                kind,
            },
        };
        if hook == "useState" {
            let init = match args.first() {
                Some(a) => r.expr(a),
                None => undefined_at(vloc),
            };
            out.state.push(StateDecl {
                name: state.clone(),
                setter: Some(set.clone()),
                init: Expr::Raw(init),
                late: false,
            });
            return RawExpr {
                loc: vloc,
                kind: RawKind::Array(vec![
                    ident(&state, IdentKind::State),
                    ident(&set, IdentKind::Setter),
                ]),
            };
        }
        // A reducer: the second slot is the dispatch handler (a plain local to its readers).
        let dispatch = set;
        reducer_hook(
            r,
            out,
            m,
            &args,
            state.clone(),
            Some(dispatch.clone()),
            vloc,
        );
        return RawExpr {
            loc: vloc,
            kind: RawKind::Array(vec![
                ident(&state, IdentKind::State),
                ident(&dispatch, IdentKind::Local),
            ]),
        };
    }
    r.expr(v)
}

/// `const name = useMemo | useCallback | useRef | useId(…)`, and `return useX(…)` of a custom hook (the result bound to
/// a generated name): the hooks whose result is one named value.
fn simple_hook(
    r: &mut Reader<'_, '_>,
    out: &mut BodyDecls,
    hook: &str,
    ident: Option<String>,
    args: &[js_ast::Expr],
    vloc: u32,
    snapshot: bool,
) {
    match hook {
        "useMemo" => {
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
        "useCallback" => {
            let Some(name) = ident else {
                return hook_binding_shape(out, "useCallback", vloc);
            };
            let body = match args.first() {
                Some(a) => r.expr(a),
                None => undefined_at(vloc),
            };
            let deps = args.get(1).map(|d| match &d.data {
                E::EArray(a) => a.items.iter().map(|x| r.expr(x)).collect(),
                _ => vec![r.expr(d)],
            });
            out.callback_deps.push((name.clone(), deps));
            out.handlers.push(HandlerDecl {
                name,
                body,
                item_scoped: Vec::new(),
                forwarded: None,
            });
        }
        "useRef" => {
            let Some(name) = ident else {
                return hook_binding_shape(out, "useRef", vloc);
            };
            let init = match args.first() {
                Some(a) => r.expr(a),
                None => undefined_at(vloc),
            };
            if snapshot {
                // B4: its initial value is all `.current` ever is: a state cell nothing sets.
                out.state.push(StateDecl {
                    name,
                    setter: None,
                    init: Expr::Raw(init),
                    late: false,
                });
            } else {
                out.refs.push(RefDecl {
                    name,
                    init: Expr::Raw(init),
                    callback: false,
                });
            }
        }
        "useId" => {
            let Some(name) = ident else {
                return hook_binding_shape(out, "useId", vloc);
            };
            out.uses_id = true;
            out.id_bindings.push(name);
        }
        _ => {}
    }
}

/// F285: `useReducer(reducer, init[, initFn])` as a state cell and a dispatch handler:
/// `const [s, set] = useState(init); const dispatch = (a) => set((p) => reducer(p, a))`. The handler is one declaration
/// of the component, so `dispatch` keeps one identity across renders, like a setter. `reducer` is declared once as a
/// handler of its own (so it reads the instance's current props and state, as React's latest-render reducer does) and is
/// required to be a PURE function the compiler can read (`reducer::is_pure`): an inline arrow or function, or a function
/// declared in this module. Anything else is the named refusal `reducer-shape` / `reducer-impure` (the component stays
/// React).
fn reducer_hook(
    r: &mut Reader<'_, '_>,
    out: &mut BodyDecls,
    m: Module<'_, '_>,
    args: &[js_ast::Expr],
    state: String,
    dispatch: Option<String>,
    vloc: u32,
) {
    let refuse = |out: &mut BodyDecls, rule: &str, why: &str| {
        out.fallback(
            rule,
            format!("useReducer: {why}"),
            vloc,
            "pass an inline reducer, or one declared in this module, that returns the next state from (state, action) without side effects",
        )
    };
    let (Some(reducer), true) = (args.first(), args.len() <= 3) else {
        return refuse(out, "reducer-shape", "needs a reducer and an initial state");
    };
    // The reducer's own function: inline, or a module-level declaration or const arrow.
    let names = &*r.names;
    let verdict = |f_args: &[js_ast::G::Arg], f_body: &[js_ast::Stmt]| {
        crate::analyze::reducer::is_pure(names, f_args, f_body)
    };
    let pure: Option<bool> = match &reducer.data {
        E::EArrow(a) if !a.is_async => Some(verdict(a.args.slice(), a.body.stmts.slice())),
        E::EFunction(f)
            if !f.func.flags.contains(js_ast::flags::Function::IsAsync)
                && !f.func.flags.contains(js_ast::flags::Function::IsGenerator) =>
        {
            Some(verdict(f.func.args.slice(), f.func.body.stmts.slice()))
        }
        E::EIdentifier(id) if !m.foreign => {
            let id = id.ref_;
            match module_fn(m.ast, names, id) {
                Some((_, f)) => Some(verdict(f.args.slice(), f.body.stmts.slice())),
                None => match crate::analyze::stores::Module::new(m.ast).const_value(id) {
                    Some(js_ast::Expr {
                        data: E::EArrow(a), ..
                    }) if !a.is_async => Some(verdict(a.args.slice(), a.body.stmts.slice())),
                    _ => None,
                },
            }
        }
        _ => None,
    };
    let Some(pure) = pure else {
        return refuse(
            out,
            "reducer-shape",
            "the reducer is not an inline function or a function declared in this module",
        );
    };
    if !pure {
        return refuse(
            out,
            "reducer-impure",
            "the reducer is not provably pure (an assignment, a loop, `throw`, `new`, a default value or a call it cannot see)",
        );
    }
    let init = match (args.get(1), args.get(2)) {
        (Some(a), None) => r.expr(a),
        (None, _) => undefined_at(vloc),
        // `useReducer(reducer, arg, init)`: the initial state is `init(arg)`.
        (Some(a), Some(f)) => {
            let callee = r.expr(f);
            if !matches!(callee.kind, RawKind::Ident { .. }) {
                return refuse(
                    out,
                    "reducer-shape",
                    "the init function is not a named function",
                );
            }
            RawExpr {
                loc: vloc,
                kind: RawKind::Call {
                    callee: Box::new(callee),
                    args: vec![r.expr(a)],
                },
            }
        }
    };
    let mut taken = |base: &str| {
        let mut n = 1;
        loop {
            let name = format!("rd{n}_{base}");
            if out.inline.taken.insert(name.clone()) {
                break name;
            }
            n += 1;
        }
    };
    let dispatch_name = dispatch.clone().unwrap_or_else(|| "dispatch".into());
    let set = taken(&format!("{}_set", clean_name(&dispatch_name)));
    let reduce = taken(&format!("{}_fn", clean_name(&dispatch_name)));
    out.state.push(StateDecl {
        name: state,
        setter: Some(set.clone()),
        init: Expr::Raw(init),
        late: false,
    });
    let reducer_body = r.expr(reducer);
    out.handlers.push(HandlerDecl {
        name: reduce.clone(),
        body: reducer_body,
        item_scoped: Vec::new(),
        forwarded: None,
    });
    let Some(dispatch) = dispatch else { return };
    let id = |name: &str, kind: IdentKind| RawExpr {
        loc: vloc,
        kind: RawKind::Ident {
            name: name.to_string(),
            kind,
        },
    };
    let next = RawExpr {
        loc: vloc,
        kind: RawKind::Arrow {
            params: vec!["_p".into()],
            body: ArrowBody::Expr(Box::new(RawExpr {
                loc: vloc,
                kind: RawKind::Call {
                    callee: Box::new(id(&reduce, IdentKind::Local)),
                    args: vec![id("_p", IdentKind::Unknown), id("_a", IdentKind::Unknown)],
                },
            })),
            captures: vec![(reduce.clone(), IdentKind::Local)],
        },
    };
    let call = RawExpr {
        loc: vloc,
        kind: RawKind::Arrow {
            params: vec!["_a".into()],
            body: ArrowBody::Expr(Box::new(RawExpr {
                loc: vloc,
                kind: RawKind::Call {
                    callee: Box::new(id(&set, IdentKind::Setter)),
                    args: vec![next],
                },
            })),
            captures: vec![
                (set.clone(), IdentKind::Setter),
                (reduce.clone(), IdentKind::Local),
            ],
        },
    };
    out.handlers.push(HandlerDecl {
        name: dispatch,
        body: call,
        item_scoped: Vec::new(),
        forwarded: None,
    });
}

/// R34.120 / F286: a hook call in the returned expression that runs on every render (`contentId={useId()}`, a custom
/// hook's `return { ref: useCallback(…) }`, `return useCallback(…)`) is the same hook call as `const x = useHook(…)`
/// before the return, in source order. Each is given a generated local (a name no module symbol takes) that the reader
/// prints in its place. The hooks are the ones whose result is one named value (`useId`, `useCallback`, `useMemo`,
/// `useRef`). A call in a conditional, short-circuited or looped position, or inside a function, is left alone, and
/// `nested_hooks` refuses it (`hook-in-expression`).
fn hoist_ids(value: &js_ast::Expr, r: &mut Reader<'_, '_>, out: &mut BodyDecls, m: Module<'_, '_>) {
    let mut found = Vec::new();
    unconditional_calls(value, &mut found);
    for call in found {
        let Some(hook) = react_hook_name(call, r.names) else {
            hoist_custom(call, r, out, m);
            continue;
        };
        if !matches!(
            hook.as_str(),
            "useId" | "useCallback" | "useMemo" | "useRef"
        ) {
            continue;
        }
        let addr = call_addr(call);
        if (hook == "useId" && !call.args.is_empty()) || r.hoisted_calls.contains_key(&addr) {
            continue;
        }
        if hook == "useId" {
            let mut n = out.id_bindings.len() + 1;
            let name = loop {
                let name = format!("_id{n}");
                if out.inline.taken.insert(name.clone()) {
                    break name;
                }
                n += 1;
            };
            out.classified_hooks.insert(addr);
            out.uses_id = true;
            out.id_bindings.push(name.clone());
            r.hoisted_calls.insert(addr, name);
            continue;
        }
        // Not `use…`: the name must not read as a hook call where the caller invokes the result.
        let mut n = 1;
        let name = loop {
            let name = format!("hoist{n}_{}", clean_name(&hook));
            if out.inline.taken.insert(name.clone()) {
                break name;
            }
            n += 1;
        };
        out.classified_hooks.insert(addr);
        let args: Vec<js_ast::Expr> = call.args.to_vec();
        simple_hook(
            r,
            out,
            &hook,
            Some(name.clone()),
            &args,
            loc_of_call(call),
            false,
        );
        r.hoisted_calls.insert(addr, name);
    }
}

/// F442 (W3, F379): an unconditional call of a CUSTOM hook in the returned JSX (`baseId={useId()}` with Radix's `useId` of
/// `@radix-ui/react-id`) is the same call as `const x = useHook(…)` before the return: the hook is inlined where the
/// statements are read (after the statement-level hooks, in the order the JSX evaluates its calls) and its one returned
/// value is bound to a generated local that the reader prints in the call's place. A call the reader cannot inline, or one
/// in a conditional, short-circuited, looped or callback position, is left alone and refused as before.
fn hoist_custom(
    call: &js_ast::E::Call,
    r: &mut Reader<'_, '_>,
    out: &mut BodyDecls,
    m: Module<'_, '_>,
) {
    let addr = call_addr(call);
    if out.classified_hooks.contains(&addr) || r.hoisted_calls.contains_key(&addr) {
        return;
    }
    let Some((hook, false)) = hook_target(&call.target, r.names) else {
        return;
    };
    if is_use_store(&call.target, r.names) {
        return;
    }
    let mut n = 1;
    let name = loop {
        let name = format!("hoist{n}_{}", clean_name(&hook));
        if out.inline.taken.insert(name.clone()) {
            break name;
        }
        n += 1;
    };
    let site = Site {
        hook: &hook,
        call,
        binding: None,
        vloc: loc_of_call(call),
        prior: &[],
        hoist: Some(&name),
    };
    // classified first: a refusal inside the hook is named there, not again as a call inside an expression
    out.classified_hooks.insert(addr);
    if inline_hook(r, out, m, &site) {
        r.hoisted_calls.insert(addr, name);
    } else {
        out.classified_hooks.remove(&addr);
    }
}

fn loc_of_call(call: &js_ast::E::Call) -> u32 {
    call.target.loc.start.max(0) as u32
}

/// The calls of `e` that run on every evaluation of it, in source order: not inside a function, the branches of a
/// conditional, the right side of a short-circuit operator (or of `||=`, `&&=`, `??=`), an optional chain, or an
/// element's `key`.
fn unconditional_calls<'e>(e: &'e js_ast::Expr, out: &mut Vec<&'e js_ast::E::Call>) {
    match &e.data {
        E::ECall(c) => {
            unconditional_calls(&c.target, out);
            if c.optional_chain.is_none() {
                // F235: an element's `key` (the third argument of a lowered JSX call) is evaluated after its props by
                // the JSX runtime, not in source order: a hook there is left to `nested_hooks` (refused).
                let n = if c.was_jsx_element { 2 } else { usize::MAX };
                for a in c.args.iter().take(n) {
                    unconditional_calls(a, out);
                }
            }
            out.push(c);
        }
        E::EDot(d) => unconditional_calls(&d.target, out),
        E::EIndex(i) => {
            unconditional_calls(&i.target, out);
            if i.optional_chain.is_none() {
                unconditional_calls(&i.index, out);
            }
        }
        E::EArray(a) => a.items.iter().for_each(|x| unconditional_calls(x, out)),
        E::EObject(o) => {
            for p in o.properties.iter() {
                if let Some(k) = &p.key {
                    unconditional_calls(k, out);
                }
                if let Some(v) = &p.value {
                    unconditional_calls(v, out);
                }
            }
        }
        E::ESpread(s) => unconditional_calls(&s.value, out),
        E::EUnary(u) => unconditional_calls(&u.value, out),
        E::EBinary(b) => {
            unconditional_calls(&b.left, out);
            // F236: the right side of `a ||= b`, `a &&= b`, `a ??= b` runs only when the short circuit lets it.
            if !matches!(
                b.op,
                js_ast::OpCode::BinLogicalAnd
                    | js_ast::OpCode::BinLogicalOr
                    | js_ast::OpCode::BinNullishCoalescing
                    | js_ast::OpCode::BinLogicalAndAssign
                    | js_ast::OpCode::BinLogicalOrAssign
                    | js_ast::OpCode::BinNullishCoalescingAssign
            ) {
                unconditional_calls(&b.right, out);
            }
        }
        E::EIf(i) => unconditional_calls(&i.test, out),
        E::ETemplate(t) => {
            if let Some(tag) = &t.tag {
                unconditional_calls(tag, out);
            }
            for p in t.parts.slice() {
                unconditional_calls(&p.value, out);
            }
        }
        _ => {}
    }
}

/// Hook calls anywhere but as a classified top-level statement: inside an
/// expression, a JSX attribute, a prop default or a nested function (spec
/// §4.3: such a component is React-only).
fn nested_hooks(func: &js_ast::G::Fn, names: &NameTable<'_>, out: &mut BodyDecls) {
    nested_hooks_in(func, func.body.stmts.slice(), names, out)
}

/// [`nested_hooks`] over `stmts`, the body without the blocks a hook left out.
fn nested_hooks_in(
    func: &js_ast::G::Fn,
    stmts: &[js_ast::Stmt],
    names: &NameTable<'_>,
    out: &mut BodyDecls,
) {
    let mut w = Walk::default();
    for arg in func.args.slice() {
        w.declare_binding(&arg.binding);
        if let Some(d) = &arg.default {
            w.expr(d);
        }
    }
    w.stmts(stmts);
    // F255: React's hook read as a value anywhere but as the callee of a call the reader classified (an alias,
    // `useId['call'](null)`, `Reflect.apply(useId, …)`, an argument) is called by something the reader cannot see:
    // the job it lands in would call it outside a render. Fail closed, like F156 for the JSX runtime.
    let mut callees = HashSet::new();
    for e in &w.calls {
        let E::ECall(call) = &e.data else {
            continue;
        };
        // A classified call is read; an unclassified one is reported by the loop below.
        if out.classified_hooks.contains(&call_addr(call))
            || hook_target(&call.target, names).is_some()
        {
            let c = comma_callee(&call.target);
            match &c.data {
                E::EDot(d) => callees.insert(d.target.loc.start),
                _ => callees.insert(c.loc.start),
            };
        }
    }
    let is_hook_name = |n: &str| {
        n.strip_prefix("use").is_some_and(|rest| {
            rest.is_empty()
                || rest.starts_with(|c: char| c.is_ascii_uppercase() || c.is_ascii_digit())
        })
    };
    let value_reads = w
        .used_at
        .iter()
        .filter(|(r, _)| react_named(names, *r).is_some_and(|n| is_hook_name(&n)))
        .map(|(r, at)| (react_named(names, *r).unwrap_or_default(), *at))
        .chain(w.member_reads.iter().filter_map(|(r, member, at)| {
            matches!(names.import_of(*r), Some(("react", "default" | "*")))
                .then_some(())
                .filter(|()| member.is_empty() || is_hook_name(member))
                .map(|()| (member.clone(), *at))
        }));
    for (hook, at) in value_reads {
        if !callees.contains(&at) {
            out.fallback(
                "hook-unsupported",
                format!("hook {hook} is read as a value, not called directly"),
                at.max(0) as u32,
                "call hooks only as `const x = useHook(...)` at the top of the component",
            );
        }
    }
    for e in &w.calls {
        let E::ECall(call) = &e.data else {
            continue;
        };
        if out.classified_hooks.contains(&call_addr(call)) {
            continue;
        }
        if let Some((hook, _)) = hook_target(&call.target, names) {
            // F288: React's element functions are not hooks. An element is a value brust has no runtime form for: refused
            // by name; a call-site clone that folds every use of it (the element-value model) drops this refusal.
            if matches!(hook.as_str(), "cloneElement" | "isValidElement") {
                out.fallback(
                    "element-value",
                    format!("`{hook}` reads a React element as a value"),
                    loc_of(e),
                    "render the element where it is written, or keep this component in React",
                );
                continue;
            }
            out.fallback(
                if hook == "useId" {
                    "hook-in-expression"
                } else {
                    "hook-unsupported"
                },
                format!("hook {hook} is called inside an expression"),
                loc_of(e),
                "call hooks only as `const x = useHook(...)` at the top of the component",
            );
        }
    }
}

/// "Hook-shape relaxations" (R34.105): `if (FLAG) { const ref = useRef(…); useEffect(() => { … }) }`, the dev-only
/// warning a library keeps behind a module flag. Left out when nothing in it can be seen but a log: the test is a
/// plain name; the block holds only `useRef` bindings and `useEffect`s; an effect only declares consts, reads and
/// writes the block's own refs, branches, and calls `console.*`; and no other statement of the hook names those refs.
/// Anything else stays and is read (or refused) like any statement.
fn dev_only_block(stmt: &js_ast::Stmt, rest: &[js_ast::Stmt], names: &NameTable<'_>) -> bool {
    let S::SIf(i) = &stmt.data else {
        return false;
    };
    if i.no.is_some() || !matches!(i.test.data, E::EIdentifier(_) | E::EImportIdentifier(_)) {
        return false;
    }
    let inner: Vec<js_ast::Stmt> = match &i.yes.data {
        S::SBlock(b) => b.stmts.slice().to_vec(),
        _ => vec![i.yes],
    };
    let mut refs: Vec<js_ast::Ref> = Vec::new();
    let mut effects = Vec::new();
    for st in &inner {
        match &st.data {
            S::SLocal(l) if matches!(l.kind, js_ast::S::Kind::KConst) && l.decls.len() == 1 => {
                let d = &l.decls[0];
                let (B::BIdentifier(id), Some(v)) = (d.binding.data, &d.value) else {
                    return false;
                };
                let E::ECall(c) = &v.data else {
                    return false;
                };
                if react_hook_target(&c.target, names).as_deref() != Some("useRef")
                    || c.args.len() > 1
                    || !c.args.iter().all(pure_expr)
                {
                    return false;
                }
                refs.push(id.r#ref);
            }
            S::SExpr(x) => {
                let E::ECall(c) = &x.value.data else {
                    return false;
                };
                if react_hook_target(&c.target, names).as_deref() != Some("useEffect") {
                    return false;
                }
                let args: Vec<_> = c.args.iter().collect();
                let Some(E::EArrow(a)) = args.first().map(|a| &a.data) else {
                    return false;
                };
                if a.is_async
                    || !a.args.is_empty()
                    || !args.get(1).is_none_or(|d| match &d.data {
                        E::EArray(d) => d.items.iter().all(pure_expr),
                        _ => false,
                    })
                    || args.len() > 2
                {
                    return false;
                }
                effects.push(a.body.stmts.slice().to_vec());
            }
            _ => return false,
        }
    }
    if !effects.iter().all(|e| log_only(e, &refs, names)) {
        return false;
    }
    let mut w = Walk::default();
    w.stmts(rest);
    !w.used
        .iter()
        .any(|u| refs.iter().any(|r| names.same(*r, *u)))
}

/// Effect statements that only declare consts, touch the block's own `refs`, branch and log.
fn log_only(stmts: &[js_ast::Stmt], refs: &[js_ast::Ref], names: &NameTable<'_>) -> bool {
    stmts.iter().all(|st| match &st.data {
        S::SEmpty(_) => true,
        S::SLocal(l) => {
            matches!(l.kind, js_ast::S::Kind::KConst)
                && l.decls.iter().all(|d| {
                    matches!(d.binding.data, B::BIdentifier(_))
                        && d.value.as_ref().is_some_and(pure_expr)
                })
        }
        S::SIf(i) => {
            pure_expr(&i.test)
                && log_only(std::slice::from_ref(&i.yes), refs, names)
                && i.no
                    .as_ref()
                    .is_none_or(|n| log_only(std::slice::from_ref(n), refs, names))
        }
        S::SBlock(b) => log_only(b.stmts.slice(), refs, names),
        S::SExpr(x) => match &x.value.data {
            E::ECall(c) => {
                matches!(&c.target.data,
                    E::EDot(d) if matches!(&d.target.data, E::EIdentifier(id) if names.name(id.ref_) == "console"))
                    && c.args.iter().all(pure_expr)
            }
            E::EBinary(b) if matches!(b.op, OpCode::BinAssign) => {
                matches!(&b.left.data,
                    E::EDot(d) if d.name.slice() == b"current"
                        && matches!(&d.target.data, E::EIdentifier(id) if refs.iter().any(|r| names.same(*r, id.ref_))))
                    && pure_expr(&b.right)
            }
            _ => false,
        },
        _ => false,
    })
}

/// An expression that computes a value without calling anything or writing anything.
fn pure_expr(e: &js_ast::Expr) -> bool {
    match &e.data {
        E::EIdentifier(_)
        | E::EImportIdentifier(_)
        | E::EString(_)
        | E::ENumber(_)
        | E::EBoolean(_)
        | E::ENull(_)
        | E::EUndefined(_) => true,
        E::EDot(d) => pure_expr(&d.target),
        E::EBinary(b) => {
            matches!(b.op.binary_assign_target(), js_ast::AssignTarget::None)
                && pure_expr(&b.left)
                && pure_expr(&b.right)
        }
        E::EUnary(u) => {
            matches!(
                OpCode::unary_assign_target(u.op),
                js_ast::AssignTarget::None
            ) && !matches!(u.op, OpCode::UnDelete)
                && pure_expr(&u.value)
        }
        E::EIf(i) => pure_expr(&i.test) && pure_expr(&i.yes) && pure_expr(&i.no),
        E::ETemplate(t) => t.tag.is_none() && t.parts.slice().iter().all(|p| pure_expr(&p.value)),
        _ => false,
    }
}

/// F437: a refused `useContext(X)` of an imported `X` is remembered (import source, imported name), so the build can tell
/// when a layout above the route provides that context (an island's SSR and hydration do not see the layout's Providers).
fn note_foreign_ctx_read(names: &NameTable<'_>, hook: &str, call: &js_ast::E::Call) {
    if hook == "useContext"
        && let Some(a) = call.args.first().and_then(crate::analyze::names::ident_ref)
        && let Some((src, name)) = names.import_of(a)
    {
        let read = (src.to_string(), name.to_string());
        let mut reads = names.foreign_ctx_reads.borrow_mut();
        if !reads.contains(&read) {
            reads.push(read);
        }
    }
}

/// S2: `useXContext(NAME, scope)` (a Radix hook) or `useContext(C)` (React's) of a context declared in this module:
/// the context's name.
fn context_read(value: &js_ast::Expr, names: &NameTable<'_>) -> Option<String> {
    let E::ECall(call) = &value.data else {
        return None;
    };
    if let Some(r) = crate::analyze::names::ident_ref(&call.target)
        && let Some(c) = names.context_of_hook(r)
    {
        return Some(c.to_string());
    }
    if (names.is_import_call(&call.target, "react", "useContext")
        || names.is_react_call(&call.target, "useContext"))
        && let Some(r) = call.args.first().and_then(crate::analyze::names::ident_ref)
    {
        return names.react_context(r).map(str::to_string);
    }
    None
}

/// `const context = useXContext(…)` binds the local to the context (`context.field` reads a hidden prop);
/// `const { a, b } = useXContext(…)` binds each plain key; any other shape falls back.
fn read_context_use(
    r: &mut Reader<'_, '_>,
    out: &mut BodyDecls,
    decl: &js_ast::G::Decl,
    value: &js_ast::Expr,
    ctx: &str,
    vloc: u32,
) {
    if let E::ECall(call) = &value.data {
        out.classified_hooks.insert(call_addr(call));
        // R34.101: the scope argument is the component's own pass-through (a prop local), or absent.
        // W1d PR 2: also `props.__scopeX` (the component's own scope, read off the whole props parameter)
        let own_scope = |a: &js_ast::Expr| {
            matches!(
                &a.data,
                E::EIdentifier(_) | E::EImportIdentifier(_) | E::EUndefined(_)
            ) || r.names.is_scope_prop_member(a)
        };
        if call.args.len() > 2 || call.args.get(1).is_some_and(|a| !own_scope(a)) {
            out.fallback(
                "context-scope",
                "a context hook is called with a scope other than the component's own scope prop"
                    .into(),
                vloc,
                "pass the scope prop through unchanged, or keep this component in React",
            );
            return;
        }
        // C2 (Mellow): a scoped read; nested same-name frames in its region are refused at the call site
        if call
            .args
            .get(1)
            .is_some_and(|a| !matches!(&a.data, E::EUndefined(_)))
        {
            r.names.note_ctx_scoped(ctx);
        }
    }
    match decl.binding.data {
        B::BIdentifier(id) => r.names.bind_ctx_local(id.r#ref, ctx),
        B::BObject(obj) => {
            for p in obj.properties() {
                let plain = !p.flags.contains(js_ast::flags::Property::IsSpread)
                    && !p.flags.contains(js_ast::flags::Property::IsComputed)
                    && p.default_value.is_none();
                let (true, E::EString(key), B::BIdentifier(id)) =
                    (plain, &p.key.data, p.value.data)
                else {
                    out.fallback(
                        "context-shape",
                        "a context is destructured with a rest, a default, a computed or nested key".into(),
                        vloc,
                        "write const { a, b } = useXContext(…), or read context.a",
                    );
                    return;
                };
                let field = crate::analyze::expr::estring(key);
                if let Some(what) = crate::analyze::context::field_problem(&field) {
                    out.fallback(
                        "context-shape",
                        format!("the context field `{field}` {what}"),
                        vloc,
                        "rename the field to a plain identifier, or keep this component in React",
                    );
                    return;
                }
                r.names.note_ctx_field(ctx, &field);
                r.names
                    .bind_ctx_field_local(id.r#ref, &crate::ir::ctx_prop(ctx, &field));
            }
        }
        _ => out.fallback(
            "context-shape",
            "a context hook result is destructured as an array".into(),
            vloc,
            "write const context = useXContext(…)",
        ),
    }
}

/// A statement that only calls `console.*` (a diagnostic, no value and no render effect).
fn console_only(stmt: &js_ast::Stmt, names: &NameTable<'_>) -> bool {
    match &stmt.data {
        S::SExpr(x) => matches!(
            &x.value.data,
            E::ECall(c) if matches!(
                &c.target.data,
                E::EDot(d) if matches!(&d.target.data, E::EIdentifier(id) if names.name(id.ref_) == "console")
            )
        ),
        S::SBlock(b) => b.stmts.slice().iter().all(|s| console_only(s, names)),
        S::SIf(i) => console_only_if(i, names),
        S::SEmpty(_) => true,
        _ => false,
    }
}

/// `if (test) A else B` where every branch only logs.
/// R34.142: Radix's `useId` seeds `const [id, setId] = useState(useReactId())` (React's `useId`, always a string) and keeps a
/// client-only fallback for React versions without it: `useLayoutEffect(() => { if (!x) setId((r) => r ?? String(count++)) })`.
/// `setId((r) => r ?? …)` returns `r` untouched while `r` is not nullish, and a state seeded by `useId()` never is, so
/// such an effect changes nothing (React bails out of the update). When every use of the setter is in effects of exactly
/// that shape, the effects are dropped (the module counter they read goes with them) and the state is the id
/// (`inert_id_states`). Anything else, any other use of the setter, leaves the body as written.
fn drop_inert_id_effects(
    body: Vec<js_ast::Stmt>,
    names: &NameTable<'_>,
    inert: &mut HashSet<usize>,
) -> (Vec<js_ast::Stmt>, Vec<(Option<js_ast::Ref>, js_ast::Ref)>) {
    // the setters of `useState(useId())`, with the address of that `useId()` call
    let mut setters: Vec<(js_ast::Ref, usize)> = Vec::new();
    let mut pairs: Vec<(Option<js_ast::Ref>, js_ast::Ref)> = Vec::new();
    for st in &body {
        let S::SLocal(l) = &st.data else { continue };
        for d in l.decls.iter() {
            let (Some(v), B::BArray(arr)) = (&d.value, d.binding.data) else {
                continue;
            };
            let E::ECall(c) = &v.data else { continue };
            if react_hook_name(c, names).as_deref() != Some("useState") {
                continue;
            }
            let Some(E::ECall(seed)) = c.args.first().map(|a| &a.data) else {
                continue;
            };
            if !seed.args.is_empty() || react_hook_name(seed, names).as_deref() != Some("useId") {
                continue;
            }
            if let Some(B::BIdentifier(id)) = arr.items().get(1).map(|i| i.binding.data) {
                setters.push((id.r#ref, call_addr(seed)));
                let state = match arr.items().first().map(|i| i.binding.data) {
                    Some(B::BIdentifier(v)) => Some(v.r#ref),
                    _ => None,
                };
                pairs.push((state, id.r#ref));
            }
        }
    }
    if setters.is_empty() {
        return (body, Vec::new());
    }
    let is_setter = |e: &js_ast::Expr| {
        crate::analyze::names::ident_ref(e)
            .is_some_and(|r| setters.iter().any(|(s, _)| names.same(*s, r)))
    };
    // `setId((r) => r ?? X)`
    let identity_update = |e: &js_ast::Expr| -> bool {
        let E::ECall(c) = &e.data else { return false };
        if !is_setter(&c.target) || c.args.len() != 1 {
            return false;
        }
        let E::EArrow(a) = &c.args[0].data else {
            return false;
        };
        let [arg] = a.args.slice() else { return false };
        let (B::BIdentifier(p), None) = (arg.binding.data, arg.default) else {
            return false;
        };
        let Some(body) = expr_body(a) else {
            return false;
        };
        matches!(&body.data, E::EBinary(b)
            if b.op == js_ast::OpCode::BinNullishCoalescing
                && crate::analyze::names::ident_ref(&b.left).is_some_and(|l| names.same(l, p.r#ref)))
    };
    fn update_stmt(st: &js_ast::Stmt, f: &dyn Fn(&js_ast::Expr) -> bool) -> bool {
        match &st.data {
            S::SExpr(x) => f(&x.value),
            // the test runs with the update: only an effect-free one may go with it
            // the test runs with the update: only an effect-free one may go with it
            S::SIf(i) => pure_expr(&i.test) && update_stmt(&i.yes, f) && i.no.is_none(),
            S::SBlock(b) => b.stmts.slice().iter().all(|x| update_stmt(x, f)),
            _ => false,
        }
    }
    let inert_effect = |st: &js_ast::Stmt| -> bool {
        let S::SExpr(x) = &st.data else { return false };
        let E::ECall(c) = &x.value.data else {
            return false;
        };
        if !matches!(
            react_hook_name(c, names).as_deref(),
            Some("useEffect" | "useLayoutEffect" | "useInsertionEffect")
        ) {
            return false;
        }
        let Some(E::EArrow(a)) = c.args.first().map(|a| &a.data) else {
            return false;
        };
        let stmts = a.body.stmts.slice();
        !stmts.is_empty() && stmts.iter().all(|s| update_stmt(s, &identity_update))
    };
    let kept: Vec<js_ast::Stmt> = body.iter().filter(|s| !inert_effect(s)).copied().collect();
    if kept.len() == body.len() {
        return (body, Vec::new());
    }
    // every use of a setter that remains is a real update: leave the hook as written
    let declares_setter = |st: &js_ast::Stmt| {
        matches!(&st.data, S::SLocal(l) if l.decls.iter().any(|d| matches!(d.binding.data,
            B::BArray(arr) if matches!(arr.items().get(1).map(|i| i.binding.data),
                Some(B::BIdentifier(id)) if setters.iter().any(|(s, _)| names.same(*s, id.r#ref))))))
    };
    let mut w = Walk::default();
    let rest: Vec<js_ast::Stmt> = kept
        .iter()
        .filter(|s| !declares_setter(s))
        .copied()
        .collect();
    w.stmts(&rest);
    if setters
        .iter()
        .any(|(s, _)| w.used.iter().any(|u| names.same(*u, *s)))
    {
        return (body, Vec::new());
    }
    inert.extend(setters.iter().map(|(_, a)| *a));
    (kept, pairs)
}

/// R34.143: the call is `useSyncExternalStore(subscribe, () => true, () => false)` with a `subscribe` that subscribes to
/// nothing (returns a no-op unsubscribe): the snapshot is `false` where there is no client (the server render and the
/// hydration pass) and `true` once mounted. This is the only shape lowered; any other store stays `hook-unsupported`.
fn hydration_shape(call: &js_ast::E::Call, m: Module<'_, '_>, names: &NameTable<'_>) -> bool {
    let [subscribe, client, server] = call.args.as_slice() else {
        return false;
    };
    let returns = |e: &js_ast::Expr, want: bool| match &e.data {
        E::EArrow(a) if a.args.is_empty() && !a.is_async => {
            expr_body(a).is_some_and(|b| matches!(&b.data, E::EBoolean(x) if x.value == want))
        }
        _ => false,
    };
    // `subscribe` returns an unsubscribe that does nothing
    let returns_noop = |stmts: &[js_ast::Stmt]| {
        matches!(stmts, [only] if matches!(&only.data, S::SReturn(r)
            if r.value.as_ref().is_some_and(crate::analyze::names::is_noop_fn)))
    };
    let silent = match &subscribe.data {
        E::EArrow(a) => a.args.is_empty() && !a.is_async && returns_noop(a.body.stmts.slice()),
        E::EFunction(f) => f.func.args.is_empty() && returns_noop(f.func.body.stmts.slice()),
        _ => crate::analyze::names::ident_ref(subscribe)
            .and_then(|id| module_fn(m.ast, names, id))
            .is_some_and(|(_, f)| f.args.is_empty() && returns_noop(f.body.stmts.slice())),
    };
    silent && returns(client, true) && returns(server, false)
}

/// R34.143: a state `name` that is `false` until the component is mounted and `true` after: React's `isHydrated`.
fn hydrated_state(out: &mut BodyDecls, name: String, loc: u32) {
    let mut n = 1;
    let set = loop {
        let set = format!("{name}_set{n}");
        if out.inline.taken.insert(set.clone()) {
            break set;
        }
        n += 1;
    };
    let lit = |b: bool| RawExpr {
        loc,
        kind: RawKind::Lit(crate::ir::Literal::Bool(b)),
    };
    out.state.push(StateDecl {
        name,
        setter: Some(set.clone()),
        init: Expr::Raw(lit(false)),
        late: true,
    });
    out.effects.push(EffectDecl {
        // set in a microtask: the effects of the component that start with this one see the render's value (`false`)
        // first, as in React, where an effect closes over the render it ran for; the browser does not paint in between
        body: RawExpr {
            loc,
            kind: RawKind::Arrow {
                params: Vec::new(),
                body: ArrowBody::Expr(Box::new(RawExpr {
                    loc,
                    kind: RawKind::Call {
                        callee: Box::new(RawExpr {
                            loc,
                            kind: RawKind::Ident {
                                name: "queueMicrotask".into(),
                                kind: IdentKind::Global,
                            },
                        }),
                        args: vec![RawExpr {
                            loc,
                            kind: RawKind::Arrow {
                                params: Vec::new(),
                                body: ArrowBody::Expr(Box::new(RawExpr {
                                    loc,
                                    kind: RawKind::Call {
                                        callee: Box::new(RawExpr {
                                            loc,
                                            kind: RawKind::Ident {
                                                name: set.clone(),
                                                kind: IdentKind::Setter,
                                            },
                                        }),
                                        args: vec![lit(true)],
                                    },
                                })),
                                captures: vec![(set.clone(), IdentKind::Setter)],
                            },
                        }],
                    },
                })),
                captures: vec![(set, IdentKind::Setter)],
            },
        },
        deps: Some(Vec::new()),
        layout: false,
    });
}

/// R34.140: `const getItems = useCollection(scope)`: `getItems()` lists the items under this component's nearest collection
/// root (the runtime's `ctx.items`, `collection` feature), in document order, each as the data its item handed over plus
/// `ref.current` and `element`. `getItems` is a function the component may call from handlers and effects, never in the
/// render (the list exists only in the browser). `scope` is the component's own pass-through (a prop local or absent).
fn read_use_collection(
    r: &mut Reader<'_, '_>,
    out: &mut BodyDecls,
    ident: Option<String>,
    args: &[js_ast::Expr],
    vloc: u32,
) {
    let Some(name) = ident else {
        return out.fallback(
            "collection-shape",
            "useCollection(scope) must be bound: const getItems = useCollection(scope)".into(),
            vloc,
            "write const getItems = useCollection(scope)",
        );
    };
    if args.len() > 1
        || args.first().is_some_and(|a| {
            !matches!(
                &a.data,
                E::EIdentifier(_) | E::EImportIdentifier(_) | E::EUndefined(_)
            )
        })
    {
        return out.fallback(
            "collection-scope",
            "useCollection is called with a scope other than the component's own scope prop".into(),
            vloc,
            "pass the scope prop through unchanged, or keep this component in React",
        );
    }
    let _ = r;
    out.uses_collection = true;
    out.handlers.push(HandlerDecl {
        name,
        body: RawExpr {
            loc: vloc,
            kind: RawKind::Arrow {
                params: Vec::new(),
                body: ArrowBody::Expr(Box::new(RawExpr {
                    loc: vloc,
                    kind: RawKind::Call {
                        callee: Box::new(RawExpr {
                            loc: vloc,
                            kind: RawKind::Ident {
                                name: crate::ir::COLLECTION_ITEMS.into(),
                                kind: IdentKind::Global,
                            },
                        }),
                        args: Vec::new(),
                    },
                })),
                captures: Vec::new(),
            },
        },
        item_scoped: Vec::new(),
        forwarded: None,
    });
}

/// A statement the hook keeps: itself, or, for an `if` whose test `hook_presence_test` decides, the statements of the
/// branch that runs (so a hook of the branch that never runs is not seen at all).
fn decided_branch(st: &js_ast::Stmt, names: &NameTable<'_>) -> Vec<js_ast::Stmt> {
    let S::SIf(i) = &st.data else {
        return vec![*st];
    };
    let Some(taken) = hook_presence_test(&i.test, names) else {
        return vec![*st];
    };
    match if taken { Some(i.yes) } else { i.no } {
        None => Vec::new(),
        Some(b) => match &b.data {
            S::SBlock(blk) => blk
                .stmts
                .slice()
                .iter()
                .flat_map(|x| decided_branch(x, names))
                .collect(),
            _ => decided_branch(&b, names),
        },
    }
}

/// `typeof X === 'function'` (or `!==`, `==`, `!=`) where `X` is a local bound to one of React's own hooks (`names.rs`,
/// `collect_react_hook_aliases`): what the test evaluates to, since React's exported hooks are functions. `None` for any
/// other test.
fn hook_presence_test(test: &js_ast::Expr, names: &NameTable<'_>) -> Option<bool> {
    use js_ast::OpCode as Op;
    let E::EBinary(b) = &test.data else {
        return None;
    };
    let equal = match b.op {
        Op::BinStrictEq | Op::BinLooseEq => true,
        Op::BinStrictNe | Op::BinLooseNe => false,
        _ => return None,
    };
    let is_function = |e: &js_ast::Expr| matches!(&e.data, E::EString(s) if crate::analyze::expr::estring(s) == "function");
    let typeof_hook = |e: &js_ast::Expr| {
        let E::EUnary(u) = &e.data else {
            return false;
        };
        u.op == Op::UnTypeof
            && crate::analyze::names::ident_ref(&u.value).is_some_and(
                |r| matches!(names.import_of(r), Some(("react", h)) if crate::analyze::names::REACT_HOOKS.contains(&h)),
            )
    };
    ((typeof_hook(&b.left) && is_function(&b.right))
        || (typeof_hook(&b.right) && is_function(&b.left)))
    .then_some(equal)
}

fn console_only_if(i: &js_ast::S::If, names: &NameTable<'_>) -> bool {
    console_only(&i.yes, names) && i.no.as_ref().is_none_or(|n| console_only(n, names))
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
    // F327: an object of the rest and plain entries used only as `{...x}` is expanded where it is spread, never read here
    if let B::BIdentifier(id) = decl.binding.data
        && r.names.is_spread_only_object(id.r#ref)
    {
        return;
    }
    let vloc = loc_of(value);
    let ident = match decl.binding.data {
        B::BIdentifier(id) => Some(r.names.name(id.r#ref)),
        _ => None,
    };
    if let Some(ctx) = context_read(value, r.names) {
        return read_context_use(r, out, decl, value, &ctx, vloc);
    }
    // R34.144: `const { a, b } = context` of a context local (Radix's `const { onFocusableItemAdd, ... } = context`), or
    // `const c2 = context`: read like the hook's own result
    if let E::EIdentifier(id) = &value.data
        && let Some(ctx) = r.names.ctx_local(id.ref_).map(str::to_string)
    {
        return read_context_use(r, out, decl, value, &ctx, vloc);
    }
    // W1d PR 3: `const alias = rest` (the `...rest` object itself): the alias reads as the rest object
    if let E::EIdentifier(v) = &value.data
        && r.names.is_rest(v.ref_)
        && let B::BIdentifier(id) = decl.binding.data
    {
        r.names.alias_rest(id.r#ref);
        return;
    }
    // W1d PR 2: `const scope = useXScope(props.__scopeX)`, a Radix scope hook: its result is a scope token (no code)
    if let E::ECall(call) = &value.data
        && is_scope_hook_call(m, r.names, call)
    {
        out.classified_hooks.insert(call_addr(call));
        let own_scope = call.args.len() <= 1
            && call.args.first().is_none_or(|a| {
                matches!(
                    &a.data,
                    E::EIdentifier(_) | E::EImportIdentifier(_) | E::EUndefined(_)
                ) || r.names.is_scope_prop_member(a)
            });
        match decl.binding.data {
            B::BIdentifier(id) if own_scope => r.names.bind_scope_token(id.r#ref),
            _ => out.fallback(
                "context-scope",
                "a scope hook is called with a scope other than the component's own scope prop, or its result is not bound to one name".into(),
                vloc,
                "write const scope = useXScope(props.__scopeX), or keep this component in React",
            ),
        }
        return;
    }
    adopt_react_alias(r.names, m, value);
    if let Some((hook, call, from_react)) = hook_call(value, r.names) {
        out.classified_hooks.insert(call_addr(call));
        let args: Vec<js_ast::Expr> = call.args.to_vec();
        if is_use_store(&call.target, r.names) {
            return read_use_store(r, out, decl, &args, vloc);
        }
        // R34.140: `const getItems = useCollection(scope)` of a recognised `createCollection`
        if let Some(callee) = crate::analyze::names::ident_ref(&call.target)
            && r.names.collection_hook(callee)
        {
            return read_use_collection(r, out, ident, &args, vloc);
        }
        if !from_react {
            let site = Site {
                hook: &hook,
                call,
                binding: Some(&decl.binding),
                vloc,
                prior,
                hoist: None,
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
                // R34.142: `useState(useId())` whose state nothing updates is the id itself.
                if let Some(E::ECall(inner)) = args.first().map(|a| &a.data)
                    && out.inline.inert_id_states.contains(&call_addr(inner))
                {
                    out.classified_hooks.insert(call_addr(inner));
                    return simple_hook(r, out, "useId", Some(name), &[], vloc, false);
                }
                let init = match args.first() {
                    Some(a) => r.expr(a),
                    None => undefined_at(vloc),
                };
                out.state.push(StateDecl {
                    name,
                    setter,
                    init: Expr::Raw(init),
                    late: false,
                });
            }
            // R34.143: `useSyncExternalStore(subscribe, () => true, () => false)` (Radix's `useIsHydrated`): false on the
            // server, true once mounted.
            (true, "useSyncExternalStore") if hydration_shape(call, m, r.names) => {
                let Some(name) = ident else {
                    return hook_binding_shape(out, "useSyncExternalStore", vloc);
                };
                if let B::BIdentifier(id) = decl.binding.data {
                    r.names.mark_state(id.r#ref);
                }
                hydrated_state(out, name, vloc);
            }
            (true, "useMemo" | "useCallback" | "useRef" | "useId") => {
                if let B::BIdentifier(id) = decl.binding.data
                    && r.names.is_sink_ref(id.r#ref)
                {
                    out.sink_refs.push(r.names.name(id.r#ref));
                }
                let snapshot = matches!(decl.binding.data, B::BIdentifier(id) if r.names.is_snapshot_ref(id.r#ref));
                simple_hook(r, out, &hook, ident, &args, vloc, snapshot)
            }
            // F285: `const [state, dispatch] = useReducer(reducer, init[, initFn])`.
            (true, "useReducer") => {
                let B::BArray(arr) = decl.binding.data else {
                    return out.fallback(
                        "hook-shape",
                        "useReducer result used without destructuring".into(),
                        vloc,
                        "write const [state, dispatch] = useReducer(reducer, init)",
                    );
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
                    return out.fallback(
                        "hook-shape",
                        "useReducer destructuring must be [state, dispatch]".into(),
                        vloc,
                        "write const [state, dispatch] = useReducer(reducer, init)",
                    );
                }
                let state = name_at(0).unwrap_or_else(|| format!("_st{}", out.state.len() + 1));
                reducer_hook(r, out, m, &args, state, name_at(1), vloc);
            }
            _ => {
                note_foreign_ctx_read(r.names, &hook, call);
                out.fallback(
                    "hook-unsupported",
                    format!("hook {hook} is not supported"),
                    vloc,
                    "move this component to React, or replace the hook with useState/useEffect",
                )
            }
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
    // R34.28: `const Comp = asChild ? Slot.Root : "button"` is not a value: it is the tag of `<Comp>`,
    // which a call site resolves. A second one in the same component stays a plain const (its tag
    // then falls back as `local-component`).
    if out.poly.is_none()
        && let B::BIdentifier(id) = decl.binding.data
        && let Some(tag) = poly_tag(r.names, value, &out.props)
    {
        r.names.set_poly(id.r#ref, tag.clone());
        out.poly = Some(tag);
        return;
    }
    let expr = r.expr(value);
    // F331: `const o = { cb: toggle }` holding the component's own function is read member by member (`o.cb` is
    // `toggle`), as an object a hook returns is; as one derived value it would be a job naming a client function.
    // Not inside a hook: `const obj = {…}; return obj` hands the object out whole, which stays the named refusal.
    if out.inline.stack.is_empty()
        && let B::BIdentifier(id) = decl.binding.data
        && let RawKind::Object(props) = &expr.kind
        && names_client_function(&expr, &client_functions(out)).is_some()
        && bind_literal_members(r, out, id.r#ref, props)
    {
        return;
    }
    out.derived.push(DerivedDecl {
        name,
        expr: Expr::Raw(expr),
    });
}

/// `value` is `flag ? Slot : "host"` (or `flag ? "host" : Slot`): `flag` a prop that defaults to
/// absent or `false`, `Slot` Radix's (`Slot.Root` / `Slot.Slot` of `radix-ui`, or `Root` / `Slot` /
/// `import * as Slot` of `@radix-ui/react-slot`, resolved through the import, never by spelling),
/// `host` a string literal that is an HTML tag name.
fn poly_tag(names: &NameTable<'_>, value: &js_ast::Expr, props: &[PropDecl]) -> Option<PolyTag> {
    let E::EIf(i) = &value.data else { return None };
    let flag_ref = match &i.test.data {
        E::EIdentifier(id) => id.ref_,
        E::EImportIdentifier(id) => id.ref_,
        _ => return None,
    };
    let (flag, kind) = names.kind_of(flag_ref);
    if !matches!(kind, IdentKind::Prop) || flag == "*" {
        return None;
    }
    // A default other than `false` would make an absent flag mean something the call site cannot see.
    let decl = props.iter().find(|p| p.name == flag)?;
    if let Some(d) = &decl.default
        && d.json_literal() != Some(serde_json::Value::Bool(false))
    {
        return None;
    }
    let host_of = |e: &js_ast::Expr| match &e.data {
        E::EString(s) => {
            let h = crate::analyze::expr::estring(s);
            let ok = h.starts_with(|c: char| c.is_ascii_lowercase())
                && h.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
            ok.then_some(h)
        }
        _ => None,
    };
    let (negate, host) = if is_radix_slot(names, &i.yes) {
        (false, host_of(&i.no)?)
    } else if is_radix_slot(names, &i.no) {
        (true, host_of(&i.yes)?)
    } else {
        return None;
    };
    Some(PolyTag { flag, negate, host })
}

/// Radix's `Slot` (R34.28, plan Q5): only `radix-ui` and `@radix-ui/react-slot`.
fn is_radix_slot(names: &NameTable<'_>, e: &js_ast::Expr) -> bool {
    let ident = |e: &js_ast::Expr| match &e.data {
        E::EIdentifier(id) => Some(id.ref_),
        E::EImportIdentifier(id) => Some(id.ref_),
        _ => None,
    };
    match &e.data {
        E::EDot(d) if matches!(d.name.slice(), b"Root" | b"Slot") => ident(&d.target)
            .and_then(|r| names.import_of(r))
            .is_some_and(|i| matches!(i, ("radix-ui", "Slot") | ("@radix-ui/react-slot", "*"))),
        _ => ident(e)
            .and_then(|r| names.import_of(r))
            .is_some_and(|i| matches!(i, ("@radix-ui/react-slot", "Root" | "Slot"))),
    }
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
    adopt_react_alias(r.names, m, value);
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
            hoist: None,
        };
        if inline_hook(r, out, m, &site) {
            return;
        }
    }
    match hook {
        Some((hook, call, true))
            if hook == "useEffect"
                || hook == "useLayoutEffect"
                // R34.105: inside a custom hook only (a library's own bookkeeping effect); written in a
                // component it stays the unsupported hook the spec lists (§3).
                || (hook == "useInsertionEffect" && !out.inline.stack.is_empty()) =>
        {
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
                layout: hook != "useEffect",
            });
        }
        Some((_, call, _)) if is_use_store(&call.target, r.names) => out.fallback(
            "hook-shape",
            "useStore result must be bound".into(),
            vloc,
            "write const s = useStore(handle)",
        ),
        Some((hook, call, _)) => {
            note_foreign_ctx_read(r.names, &hook, call);
            out.fallback(
                "hook-unsupported",
                format!("hook {hook} is not supported"),
                vloc,
                "move this component to React, or replace the hook with useState/useEffect",
            )
        }
        // F288 G9: `r.current = v` on a `useRef` of this component is judged later, by the closed rule (Mellow A2); in a
        // branch of an early-return chain it runs on some renders only (rule 2: `ref-in-render`, Mellow F2).
        None if out.branch_depth > 0
            && let E::EBinary(b) = &value.data
            && matches!(b.op, js_ast::OpCode::BinAssign)
            && let E::EDot(d) = &b.left.data
            && d.name.slice() == b"current" =>
        {
            out.fallback(
                "ref-in-render",
                "a ref is written during render after an early return, so only on some renders"
                    .into(),
                vloc,
                "write the ref in an effect or an event handler",
            )
        }
        None if let E::EBinary(b) = &value.data
            && matches!(b.op, js_ast::OpCode::BinAssign)
            && let E::EDot(d) = &b.left.data
            && d.name.slice() == b"current"
            && let RawKind::Ident { name, .. } = r.expr(&d.target).kind
            && out.refs.iter().any(|x| x.name == name) =>
        {
            let value = r.expr(&b.right);
            out.render_ref_writes.push(crate::ir::RenderRefWrite {
                r#ref: name,
                value,
                loc: vloc,
            });
        }
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
    /// F442 (W3): a call hoisted out of the returned JSX: the generated local its one returned value is bound to.
    hoist: Option<&'s str>,
}

const HOOK_REMEDY: &str = "keep custom hooks to const declarations, React hooks brust supports and one final return, or move this component to React";

/// F268: a hook imported from another module that is, there, a `const` alias of one of React's own hooks
/// (`export const useLayoutEffect = globalThis?.document ? React.useLayoutEffect : () => {}`) is React's hook for every
/// reader of the call, by symbol: the caller's import is recorded as an import of `react`. Nothing is recognised by the
/// package's name; only the module's own declaration (`NameTable::exported_react_hook`) decides.
fn adopt_react_alias(names: &mut NameTable<'_>, m: Module<'_, '_>, value: &js_ast::Expr) {
    let E::ECall(call) = &value.data else {
        return;
    };
    let target = match &comma_callee(&call.target).data {
        E::EIdentifier(id) => id.ref_,
        E::EImportIdentifier(id) => id.ref_,
        _ => return,
    };
    let Some((source, imported)) = names
        .import_of(target)
        .map(|(s, i)| (s.to_string(), i.to_string()))
    else {
        return;
    };
    let Some(opts) = m.opts else {
        return;
    };
    if source == "react" || imported == "*" {
        return;
    }
    let Some(path) = crate::analyze::modules::resolve_module(&m.parsed.path(), &source, opts)
    else {
        return;
    };
    let (path, imported) = follow_reexports(opts, path, imported);
    let Ok(bytes) = std::fs::read(opts.root.join(&path)) else {
        return;
    };
    let Ok(parsed) = crate::parse::parse_tsx(&path, bytes) else {
        return;
    };
    let hook = parsed.with_ast(|ast| NameTable::for_hook(ast).exported_react_hook(ast, &imported));
    if let Some(hook) = hook {
        names.adopt_react_hook(target, &hook);
    }
}

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
        read_hook(r, out, m, func, site, None);
        return true;
    };
    let Some(opts) = m.opts else {
        return false;
    };
    if imported == "*" {
        return false;
    }
    let Some(path) = crate::analyze::modules::resolve_module(&m.parsed.path(), &source, opts)
    else {
        return false;
    };
    let (path, imported) = follow_reexports(opts, path, imported);
    // F442 (W3b): Radix's own `useId`, recognised by its printed shape, is React 19's `useId` under a prefix: an id slot.
    if crate::analyze::radix_id::is_radix_use_id(&path, &imported, opts)
        && crate::analyze::passes::elements::resolves_react_19(&opts.root)
    {
        read_radix_use_id(r, out, site);
        return true;
    }
    // B2: the specifier the component's own module imports the hook by; only then can a name the hook's module exports
    // be imported from the same place (a hook reached through another hook's module has no specifier of the component's).
    let spec = (!m.foreign).then(|| source.clone());
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
            Some(func) => read_hook(r, out, hm, func, site, spec.as_deref()),
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

/// F442 (W3b): a call of Radix's `useId(deterministicId?)` (`analyze/radix_id.rs`) is `deterministicId || \`radix-${id}\``
/// over a fresh id slot (React 19's `useId`, the same slot `const id = useId()` makes), bound like any custom hook's value.
fn read_radix_use_id(r: &mut Reader<'_, '_>, out: &mut BodyDecls, site: &Site<'_>) {
    let vloc = site.vloc;
    if site.call.args.len() > 1 {
        return out.fallback(
            "hook-shape",
            format!("custom hook {}: more than one argument", site.hook),
            vloc,
            HOOK_REMEDY,
        );
    }
    let mut n = out.id_bindings.len() + 1;
    let slot = loop {
        let name = format!("_id{n}");
        if out.inline.taken.insert(name.clone()) {
            break name;
        }
        n += 1;
    };
    out.uses_id = true;
    out.id_bindings.push(slot.clone());
    let at = |kind: RawKind| RawExpr { loc: vloc, kind };
    let prefixed = at(RawKind::Template {
        head: "radix-".into(),
        parts: vec![(
            at(RawKind::Ident {
                name: slot,
                kind: IdentKind::Local,
            }),
            String::new(),
        )],
    });
    let value = match site.call.args.first() {
        Some(a) => {
            let given = r.expr(a);
            at(RawKind::Binary {
                op: crate::ir::BinOp::Or,
                left: Box::new(given),
                right: Box::new(prefixed),
            })
        }
        None => prefixed,
    };
    bind_result(r, out, site, Some(value));
}

/// A package barrel (`export { useX } from "./use-x"`, the build's own P1 barrel) names the hook but does not
/// declare it: follow named re-exports to the module that does. A module that declares it, or any hop that cannot
/// be read, parsed or resolved, ends the walk where it stands and `inline_hook` reports from there.
fn follow_reexports(
    opts: &AnalyzeOptions,
    mut path: String,
    mut imported: String,
) -> (String, String) {
    for _ in 0..4 {
        let Ok(bytes) = std::fs::read(opts.root.join(&path)) else {
            break;
        };
        let Ok(parsed) = crate::parse::parse_tsx(&path, bytes) else {
            break;
        };
        let next = parsed.with_ast(|ast| {
            if exported_fn(ast, &imported).is_some() {
                return None;
            }
            let records = ast.import_records.as_slice();
            ast.parts.iter().find_map(|part| {
                part.stmts.slice().iter().find_map(|stmt| match &stmt.data {
                    S::SExportFrom(f) => f.items.slice().iter().find_map(|item| {
                        if item.alias.slice() != imported.as_bytes() {
                            return None;
                        }
                        let spec = records.get(f.import_record_index as usize)?;
                        let spec = String::from_utf8_lossy(spec.path.text).into_owned();
                        let to = crate::analyze::modules::resolve_module(&path, &spec, opts)?;
                        let original = String::from_utf8_lossy(item.original_name.slice());
                        Some((to, original.into_owned()))
                    }),
                    _ => None,
                })
            })
        });
        match next {
            Some((to, original)) => (path, imported) = (to, original),
            None => break,
        }
    }
    (path, imported)
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
                // R34.143: `export const useX = typeof reactHook === 'function' ? useModern : useLegacy` (Radix's
                // `useIsHydrated`): the test is decided (`hook_presence_test`), the export is the branch that runs.
                S::SLocal(l) if l.is_export && matches!(l.kind, js_ast::S::Kind::KConst) => {
                    for d in l.decls.iter() {
                        if let (B::BIdentifier(id), Some(v)) = (d.binding.data, d.value)
                            && names.name(id.r#ref) == export
                            && let E::EIf(i) = &v.data
                            && let Some(taken) = hook_presence_test(&i.test, &names)
                            && let Some(target) =
                                crate::analyze::names::ident_ref(if taken { &i.yes } else { &i.no })
                        {
                            return local_fn(ast, &names, target);
                        }
                    }
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
    spec: Option<&str>,
) {
    let imported = hm.foreign;
    let (hook, vloc) = (site.hook, site.vloc);
    // Where the call's arguments are declared: just ahead of the hook's own declarations (which sit at `vloc`), so the
    // chunk, which prints in this order, has them before a state or a derived value the hook seeds from them.
    let ploc = vloc.saturating_sub(1);
    let path = hm.parsed.path();
    let fail = |out: &mut BodyDecls, rule: &str, why: String| {
        out.fallback(rule, why, vloc, HOOK_REMEDY);
    };
    let mut hnames = NameTable::for_hook(hm.ast);
    if imported {
        hnames.literal_reads_are_safe(hm.ast);
    }
    // the contexts of the hook's module are named by that module (the same tag its own components get)
    hnames.tag_contexts(&path);
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
    // A parameter is a plain identifier, or (R34.105, "hook-shape relaxations") an object pattern of plain keys
    // with optional defaults, bound to an object literal at the call site.
    let mut params = Vec::new();
    let mut slots: Vec<Slot> = Vec::new();
    for arg in func.args.slice() {
        let last = std::ptr::eq(arg, &func.args.slice()[func.args.len() - 1]);
        match arg.binding.data {
            B::BIdentifier(id)
                if arg.default.is_none() && func.flags.contains(F::HasRestArg) && last =>
            {
                params.push(id.r#ref);
                slots.push(Slot::Rest(id.r#ref));
            }
            B::BIdentifier(id) if arg.default.is_none() && !func.flags.contains(F::HasRestArg) => {
                params.push(id.r#ref);
                slots.push(Slot::Whole(id.r#ref));
            }
            B::BObject(obj) if arg.default.is_none() && !func.flags.contains(F::HasRestArg) => {
                let mut members = Vec::new();
                for p in obj.properties() {
                    let (false, false, E::EString(key), B::BIdentifier(id)) = (
                        p.flags.contains(js_ast::flags::Property::IsSpread),
                        p.flags.contains(js_ast::flags::Property::IsComputed),
                        &p.key.data,
                        p.value.data,
                    ) else {
                        return fail(
                            out,
                            "hook-shape",
                            format!(
                                "custom hook {hook}: a computed key, ...rest or nested pattern in its parameter"
                            ),
                        );
                    };
                    params.push(id.r#ref);
                    members.push(Member {
                        local: id.r#ref,
                        key: crate::analyze::expr::estring(key),
                        default: p.default_value,
                    });
                }
                slots.push(Slot::Object(members));
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
    if site.call.args.len() > func.args.len() && !slots.iter().any(|s| matches!(s, Slot::Rest(_))) {
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
    // R34.105: a dev-only warning block (`if (FLAG) { useRef; useEffect(… console.warn …) }`) is left out.
    let all = func.body.stmts.slice();
    let body: Vec<js_ast::Stmt> = all
        .iter()
        .enumerate()
        .filter(|(i, st)| {
            let rest: Vec<js_ast::Stmt> = all
                .iter()
                .enumerate()
                .filter(|(j, _)| j != i)
                .map(|(_, x)| *x)
                .collect();
            !dev_only_block(st, &rest, &hnames)
        })
        .flat_map(|(_, st)| decided_branch(st, &hnames))
        .collect();
    // a hook imported under another name may be React's own (`useLayoutEffect` of `use-layout-effect`): decided before the
    // statements are looked at, as reading each one would
    for st in &body {
        if let S::SExpr(x) = &st.data {
            adopt_react_alias(&mut hnames, hm, &x.value);
        }
    }
    let (body, inert_states) =
        drop_inert_id_effects(body, &hnames, &mut out.inline.inert_id_states);
    // such a state is a plain id: its reads are not state reads
    for (state, setter) in inert_states {
        if let Some(state) = state {
            hnames.unmark_state(state);
        }
        hnames.unmark_setter(setter);
    }

    let mut w = Walk::default();
    for arg in func.args.slice() {
        w.declare_binding(&arg.binding);
    }
    w.stmts(&body);
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
    let mut helpers: Vec<(js_ast::Ref, js_ast::Stmt, &js_ast::G::Fn)> = Vec::new();
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
    let mut import_aliases: Vec<(js_ast::Ref, Alias)> = Vec::new();
    let mut module_consts: Vec<(String, js_ast::Ref)> = Vec::new();
    // R34.143: the `subscribe` of a hydration-shaped `useSyncExternalStore` is never run: it is not a free name of the hook
    let mut silent_subscribers: Vec<js_ast::Ref> = Vec::new();
    for c in &w.calls {
        if let E::ECall(call) = &c.data
            && react_hook_name(call, &hnames).as_deref() == Some("useSyncExternalStore")
            && hydration_shape(call, hm, &hnames)
            && let Some(s) = call.args.first().and_then(crate::analyze::names::ident_ref)
        {
            silent_subscribers.push(s);
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
        // R34.105: a module function of the hook's file that is proven plain (`plain_fn.rs`) and reads nothing but its
        // own parameters, locals and globals is carried into the component under a generated name.
        if imported
            && !matches!(kind, IdentKind::Global)
            && let Some((stmt, f)) = module_fn(hm.ast, &hnames, *u)
            && plain_fn::plain_fns(hm.ast, &hnames).contains(&spelled)
            && self_contained(f, &hnames)
        {
            if !helpers.iter().any(|(h, _, _)| hnames.same(*h, *u)) {
                helpers.push((*u, stmt, f));
            }
            continue;
        }
        // B2: a function the hook's module EXPORTS (`composeRefs` beside `useComposedRefs`) is imported by the
        // component from the same specifier, under a generated name; it is a call target, never inlined.
        if imported
            && !matches!(kind, IdentKind::Global)
            && let Some(spec) = spec
            && exported_fn(hm.ast, &spelled).is_some()
        {
            if !import_aliases.iter().any(|(s, _)| hnames.same(*s, *u)) {
                let mut g = 1;
                let local = loop {
                    let l = format!("{}_import{g}", clean_name(&spelled));
                    if out.inline.taken.insert(l.clone()) {
                        break l;
                    }
                    g += 1;
                };
                import_aliases.push((
                    *u,
                    Alias {
                        print: local.clone(),
                        kind: Some((
                            local,
                            IdentKind::Import {
                                source: spec.to_string(),
                                imported: spelled.clone(),
                            },
                        )),
                    },
                ));
            }
            continue;
        }
        if spelled == "arguments" {
            return fail(
                out,
                "hook-shape",
                format!("custom hook {hook} reads `arguments`"),
            );
        }
        if silent_subscribers.iter().any(|s| hnames.same(*s, *u)) {
            continue;
        }
        // R34.142: the argument of `useContext(C)`, a context the hook's module declares: the frames pass carries it
        if hnames.react_context(*u).is_some() {
            continue;
        }
        // R34.142: a never-written `const` of literal shape of the hook's module (`Direction.LTR`) is read as its value:
        // folded into what the hook reads; any use that does not fold fails the hook below.
        if imported
            && (hnames.module_inits().contains_key(&spelled) || hnames.object_const(*u).is_some())
        {
            if !module_consts.iter().any(|(n, _)| n == &spelled) {
                module_consts.push((spelled.clone(), *u));
            }
            continue;
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
    for (h, _, _) in &helpers {
        if !locals.iter().any(|(l, _)| hnames.same(*l, *h)) {
            locals.push((*h, hnames.name(*h)));
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
    // `name === undefined ? default : name` for a defaulted member, read once the aliases are set.
    let mut defaulted: Vec<(String, RawExpr, js_ast::Expr)> = Vec::new();
    for (i, slot) in slots.iter().enumerate() {
        let call_arg = site.call.args.get(i);
        match slot {
            Slot::Whole(p) => {
                let alias = match call_arg.and_then(|a| ident_alias(r.names, a)) {
                    Some(alias) => alias,
                    None => {
                        let name = gen_of(&hnames, *p);
                        let mut expr = match call_arg {
                            Some(a) => r.arg(a),
                            None => undefined_at(vloc),
                        };
                        // Declared at the call site, before what the hook declares: the chunk prints in this order.
                        relocate(&mut expr, ploc);
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
            Slot::Rest(p) => {
                let items: Vec<RawExpr> = site.call.args.iter().skip(i).map(|a| r.arg(a)).collect();
                let mut expr = RawExpr {
                    loc: vloc,
                    kind: RawKind::Array(items),
                };
                relocate(&mut expr, ploc);
                let name = gen_of(&hnames, *p);
                out.derived.push(DerivedDecl {
                    name: name.clone(),
                    expr: Expr::Raw(expr),
                });
                param_aliases.push((
                    *p,
                    Alias {
                        print: name,
                        kind: None,
                    },
                ));
            }
            Slot::Object(members) => {
                // Destructuring `undefined` throws; the call site must hand over an object literal of plain keys.
                let Some(E::EObject(lit)) = call_arg.map(|a| &a.data) else {
                    return fail(
                        out,
                        "hook-shape",
                        format!(
                            "custom hook {hook} destructures its argument, which the call site does not write as an object literal"
                        ),
                    );
                };
                let mut given: Vec<(String, &js_ast::Expr)> = Vec::new();
                for prop in lit.properties.iter() {
                    let plain = matches!(prop.kind, js_ast::G::PropertyKind::Normal)
                        && !prop.flags.contains(js_ast::flags::Property::IsComputed)
                        && !prop.flags.contains(js_ast::flags::Property::IsMethod);
                    let (true, Some(E::EString(key)), Some(value)) = (
                        plain,
                        prop.key.as_ref().map(|k| k.data),
                        prop.value.as_ref(),
                    ) else {
                        return fail(
                            out,
                            "hook-shape",
                            format!(
                                "custom hook {hook}: its object argument has a spread, a computed key, a method or an accessor"
                            ),
                        );
                    };
                    given.push((crate::analyze::expr::estring(&key), value));
                }
                for m in members {
                    let value = given
                        .iter()
                        .rev()
                        .find(|(k, _)| *k == m.key)
                        .map(|(_, v)| *v);
                    let mut raw = match value {
                        Some(v) => r.expr(v),
                        None => undefined_at(vloc),
                    };
                    relocate(&mut raw, ploc);
                    match (m.default, value.and_then(|a| ident_alias(r.names, a))) {
                        (None, Some(alias)) => param_aliases.push((m.local, alias)),
                        (None, None) => {
                            let name = gen_of(&hnames, m.local);
                            out.derived.push(DerivedDecl {
                                name: name.clone(),
                                expr: Expr::Raw(raw),
                            });
                            param_aliases.push((
                                m.local,
                                Alias {
                                    print: name,
                                    kind: None,
                                },
                            ));
                        }
                        (Some(d), _) => {
                            // The value is read twice (`v === undefined ? d : v`): only a value whose
                            // computation can be dropped may be.
                            if !inert(&raw) {
                                return fail(
                                    out,
                                    "hook-shape",
                                    format!(
                                        "custom hook {hook}: `{}` has a default and the call site passes a computed value",
                                        m.key
                                    ),
                                );
                            }
                            let name = gen_of(&hnames, m.local);
                            defaulted.push((name.clone(), raw, d));
                            param_aliases.push((
                                m.local,
                                Alias {
                                    print: name,
                                    kind: None,
                                },
                            ));
                        }
                    }
                }
            }
        }
    }
    for (l, _) in &locals {
        if !params.iter().any(|p| hnames.same(*p, *l)) {
            let print = gen_of(&hnames, *l);
            hnames.set_alias(*l, Alias { print, kind: None });
        }
    }
    for (p, a) in param_aliases.into_iter().chain(import_aliases) {
        hnames.set_alias(p, a);
    }

    // The call's defaulted arguments are declared before the hook's own (and before the mark below, which points what
    // the hook declares at the call site): `name === undefined ? default : name`, once the aliases above are set.
    {
        let print = |js: Js<'_>, a: &Aliases| print_js_with(hm.parsed, hm.ast, a, js);
        let mut hr = Reader::new(&mut hnames, &print);
        for (name, raw, default) in defaulted.drain(..) {
            let mut d = hr.expr(&default);
            relocate(&mut d, ploc);
            out.derived.push(DerivedDecl {
                name,
                expr: Expr::Raw(RawExpr {
                    loc: ploc,
                    kind: RawKind::Cond {
                        test: Box::new(RawExpr {
                            loc: ploc,
                            kind: RawKind::Binary {
                                op: crate::ir::BinOp::StrictEq,
                                left: Box::new(raw.clone()),
                                right: Box::new(undefined_at(vloc)),
                            },
                        }),
                        yes: Box::new(d),
                        no: Box::new(raw),
                    },
                }),
            });
        }
        out.diagnostics.append(&mut hr.diagnostics);
    }
    let start = Marks::of(out);
    let reason_before = out.react_reason.clone();
    let saved = std::mem::take(&mut out.classified_hooks);
    out.inline.stack.push(key);
    let returned = {
        let print = |js: Js<'_>, a: &Aliases| print_js_with(hm.parsed, hm.ast, a, js);
        let mut hr = Reader::new(&mut hnames, &print);
        for (h, stmt, f) in &helpers {
            let e = hr.function_decl(stmt, f);
            out.derived.push(DerivedDecl {
                name: hr.names.name(*h),
                expr: Expr::Raw(e),
            });
        }
        let mut returned = read_stmts(&body, &mut hr, out, hm);
        if !module_consts.is_empty() {
            let values: HashMap<String, RawExpr> = module_consts
                .iter()
                .filter_map(|(n, u)| {
                    let e = match hr.names.module_inits().get(n) {
                        Some(e) => *e,
                        None => hr.names.object_const(*u)?,
                    };
                    Some((n.clone(), hr.expr(&e)))
                })
                .collect();
            if !fold_module_consts(&values, &start, out, &mut returned) {
                fail(
                    out,
                    "hook-shape",
                    format!(
                        "custom hook {hook} reads a constant of {path} other than as `NAME` or `NAME.key` of a literal"
                    ),
                );
            }
        }
        nested_hooks_in(func, &body, hr.names, out);
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
    // the context fields the hook read are this component's own needs (hidden props), with their defaults
    for u in hnames.ctx_uses() {
        for f in &u.fields {
            r.names.note_ctx_field(&u.context, f);
        }
    }
    for (c, d) in hnames.scalar_defaults() {
        r.names.adopt_scalar(&c, &d);
    }

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
    // F289: a derived value the hook (or the binding of its result) added is a per-request job; the handlers and setters
    // are the client's, so one that names them is a job that throws (a 500). Whatever shape put it there (a `useMemo`
    // returning the object, a spread in the returned literal) is refused by name.
    if let Some(name) = client_function_in_derived(out, start.derived) {
        let spelled = name
            .rsplit_once('_')
            .filter(|(_, tail)| tail.starts_with(&clean_name(hook)))
            .map_or(name.as_str(), |(head, _)| head)
            .to_string();
        out.fallback(
            "hook-return-shape",
            format!(
                "custom hook {hook} hands out `{spelled}`, a handler or setter, inside a value the compiler computes per request"
            ),
            vloc,
            "return an object or array literal the call site reads as `t.key` or destructures, or keep this component in React",
        );
    }
}

/// The first handler, setter or hook-declared function that a derived value of `out` (from `from` on) names. A
/// derived value is a per-request job, which does not have the client's functions: it would throw (a 500).
fn client_function_in_derived(out: &BodyDecls, from: usize) -> Option<String> {
    let handlers = client_functions(out);
    out.derived[from..].iter().find_map(|d| {
        // a function (`const toggle = () => setOn(…)`) is a handler the component lifts, not a job
        let Expr::Raw(e) = &d.expr else { return None };
        if matches!(e.kind, RawKind::Arrow { .. }) {
            return None;
        }
        names_client_function(e, &handlers)
    })
}

/// The client's functions: the handlers, and a function declared as a const (`const toggle = () => …`).
fn client_functions(out: &BodyDecls) -> HashSet<&str> {
    out.handlers
        .iter()
        .map(|h| h.name.as_str())
        .chain(out.derived.iter().filter_map(|d| match &d.expr {
            Expr::Raw(e) if matches!(e.kind, RawKind::Arrow { .. }) => Some(d.name.as_str()),
            _ => None,
        }))
        .collect()
}

/// The first handler or setter that `e` names (the client's functions, which a per-request job does not have).
fn names_client_function(e: &RawExpr, handlers: &HashSet<&str>) -> Option<String> {
    let all = |items: &[RawExpr]| {
        items
            .iter()
            .find_map(|i| names_client_function(i, handlers))
    };
    match &e.kind {
        RawKind::Ident { name, kind } => (matches!(kind, IdentKind::Setter)
            || handlers.contains(name.as_str()))
        .then(|| name.clone()),
        RawKind::Lit(_) | RawKind::Jsx(_) => None,
        RawKind::Opaque { captures, .. } => captures
            .iter()
            .find(|(n, k)| matches!(k, IdentKind::Setter) || handlers.contains(n.as_str()))
            .map(|(n, _)| n.clone()),
        RawKind::Member { target, .. } => names_client_function(target, handlers),
        RawKind::Index { target, index } => names_client_function(target, handlers)
            .or_else(|| names_client_function(index, handlers)),
        RawKind::Call { callee, args } => {
            names_client_function(callee, handlers).or_else(|| all(args))
        }
        RawKind::Binary { left, right, .. } => {
            names_client_function(left, handlers).or_else(|| names_client_function(right, handlers))
        }
        RawKind::Unary { value, .. } => names_client_function(value, handlers),
        RawKind::Cond { test, yes, no } => names_client_function(test, handlers)
            .or_else(|| names_client_function(yes, handlers))
            .or_else(|| names_client_function(no, handlers)),
        RawKind::Template { parts, .. } => parts
            .iter()
            .find_map(|(p, _)| names_client_function(p, handlers)),
        RawKind::Array(items) => all(items),
        RawKind::Object(props) => props
            .iter()
            .find_map(|(_, v)| names_client_function(v, handlers)),
        RawKind::Arrow { captures, .. } => captures
            .iter()
            .find(|(n, k)| matches!(k, IdentKind::Setter) || handlers.contains(n.as_str()))
            .map(|(n, _)| n.clone()),
    }
}

/// The module-level `function` declaring `target`, with its statement.
fn module_fn<'x>(
    ast: &'x js_ast::Ast<'_>,
    names: &NameTable<'_>,
    target: js_ast::Ref,
) -> Option<(js_ast::Stmt, &'x js_ast::G::Fn)> {
    ast.parts.iter().find_map(|part| {
        part.stmts.slice().iter().find_map(|s| match &s.data {
            S::SFunction(f)
                if f.func
                    .name
                    .as_ref()
                    .is_some_and(|n| names.same(n.ref_, target)) =>
            {
                Some((*s, &f.func))
            }
            _ => None,
        })
    })
}

/// A function whose body reads only its own parameters and locals (and itself) and globals: it can be copied
/// anywhere without the module around it.
fn self_contained(f: &js_ast::G::Fn, names: &NameTable<'_>) -> bool {
    let mut w = Walk::default();
    if let Some(n) = &f.name {
        w.declared.push(n.ref_);
    }
    for arg in f.args.slice() {
        w.declare_binding(&arg.binding);
        if let Some(d) = &arg.default {
            w.expr(d);
        }
    }
    w.stmts(f.body.stmts.slice());
    w.used.iter().all(|u| {
        w.declared.iter().any(|d| names.same(*d, *u))
            || matches!(names.kind_of(*u).1, IdentKind::Global)
    })
}

/// An argument that is a plain identifier is the caller's own binding.
fn ident_alias(names: &NameTable<'_>, a: &js_ast::Expr) -> Option<Alias> {
    match &a.data {
        // B3: the forwarded ref handed to a hook is `null` (`Reader::arg`), not the component's binding.
        E::EIdentifier(js_ast::E::Identifier { ref_, .. }) if names.is_forwarded_ref(*ref_) => None,
        E::EIdentifier(js_ast::E::Identifier { ref_, .. })
        | E::EImportIdentifier(js_ast::E::ImportIdentifier { ref_, .. }) => Some(Alias {
            print: names.name(*ref_),
            kind: Some(names.kind_of(*ref_)),
        }),
        _ => None,
    }
}

/// A custom hook's parameter: a plain identifier, or an object pattern of plain keys.
enum Slot {
    Whole(js_ast::Ref),
    /// B2: `...rest` of the hook's parameters, bound to an array of the call site's remaining arguments.
    Rest(js_ast::Ref),
    Object(Vec<Member>),
}

struct Member {
    local: js_ast::Ref,
    key: String,
    default: Option<js_ast::Expr>,
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

pub(crate) fn relocate(e: &mut RawExpr, loc: u32) {
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

/// R34.142: replaces each read of a module constant of a literal shape in what the hook read since `start` by its value
/// (`Direction.LTR` becomes `'ltr'`, a literal `NAME` itself). `false` when a use is left that does not fold (the constant
/// as a whole object, a key it has no entry for): the hook then reads a name the component does not have.
fn fold_module_consts(
    values: &HashMap<String, RawExpr>,
    start: &Marks,
    out: &mut BodyDecls,
    returned: &mut Option<Option<RawExpr>>,
) -> bool {
    let left = std::cell::Cell::new(false);
    let name_of = |e: &RawExpr| match &e.kind {
        RawKind::Ident { name, kind } if !matches!(kind, IdentKind::Prop | IdentKind::State) => {
            Some(name.clone())
        }
        _ => None,
    };
    let f = |e: &RawExpr| -> Option<RawExpr> {
        match &e.kind {
            RawKind::Member { target, name, .. } => {
                let c = values.get(&name_of(target)?)?;
                let RawKind::Object(props) = &c.kind else {
                    return None;
                };
                match props.iter().find(|(k, _)| k == name) {
                    Some((_, v)) if matches!(v.kind, RawKind::Lit(_)) => Some(RawExpr {
                        loc: e.loc,
                        kind: v.kind.clone(),
                    }),
                    _ => {
                        left.set(true);
                        None
                    }
                }
            }
            RawKind::Ident { .. } => {
                let c = values.get(&name_of(e)?)?;
                if matches!(c.kind, RawKind::Lit(_)) {
                    Some(RawExpr {
                        loc: e.loc,
                        kind: c.kind.clone(),
                    })
                } else {
                    left.set(true);
                    None
                }
            }
            _ => None,
        }
    };
    let fold = |e: &mut RawExpr| *e = crate::analyze::const_fold::map_pre(e, &f);
    let fold_expr = |e: &mut Expr| {
        if let Expr::Raw(r) = e {
            fold(r)
        }
    };
    out.state[start.state..]
        .iter_mut()
        .for_each(|s| fold_expr(&mut s.init));
    out.derived[start.derived..]
        .iter_mut()
        .for_each(|d| fold_expr(&mut d.expr));
    out.refs[start.refs..]
        .iter_mut()
        .for_each(|d| fold_expr(&mut d.init));
    out.handlers[start.handlers..]
        .iter_mut()
        .for_each(|h| fold(&mut h.body));
    for e in &mut out.effects[start.effects..] {
        fold(&mut e.body);
        e.deps.iter_mut().flatten().for_each(&fold);
    }
    if let Some(Some(r)) = returned {
        fold(r);
    }
    !left.get()
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

/// Binds `r` to the members of an object or array literal (`props`): a plain member (an identifier, a literal, an arrow)
/// is read where `t.key` is read, any other becomes its own derived value `{base}_{key}`. An arrow written in the
/// literal is read where `t.key` is read (each read is its own copy, like a function written inline at each use):
/// identity across reads is not kept, as for a destructured arrow. `false`, with nothing bound, when a member is
/// itself an object or array (not read one level deeper).
fn bind_literal_members(
    r: &mut Reader<'_, '_>,
    out: &mut BodyDecls,
    bound: js_ast::Ref,
    props: &[(String, RawExpr)],
) -> bool {
    if props
        .iter()
        .any(|(_, v)| matches!(v.kind, RawKind::Object(_) | RawKind::Array(_)))
    {
        return false;
    }
    let base = clean_name(&r.names.name(bound));
    let mut members: Vec<(String, RawExpr)> = Vec::new();
    for (key, v) in props {
        let plain = matches!(
            v.kind,
            RawKind::Ident { .. } | RawKind::Lit(_) | RawKind::Arrow { .. }
        );
        let v = if plain {
            v.clone()
        } else {
            let mut n = 1;
            let name = loop {
                let name = if n == 1 {
                    format!("{base}_{}", clean_name(key))
                } else {
                    format!("{base}_{}{n}", clean_name(key))
                };
                if out.inline.taken.insert(name.clone()) {
                    break name;
                }
                n += 1;
            };
            out.derived.push(DerivedDecl {
                name: name.clone(),
                expr: Expr::Raw(v.clone()),
            });
            RawExpr {
                loc: v.loc,
                kind: RawKind::Ident {
                    name,
                    kind: IdentKind::Local,
                },
            }
        };
        members.push((key.clone(), v));
    }
    r.names.bind_hook_object(bound, members);
    true
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
    // F442 (W3): a call hoisted out of the returned JSX binds its one value to the generated local.
    if let Some(name) = site.hoist {
        let value = returned.unwrap_or_else(|| undefined_at(vloc));
        if matches!(value.kind, RawKind::Object(_) | RawKind::Array(_)) {
            return shape(
                out,
                format!(
                    "custom hook {hook} is called inside an expression and returns an object or array"
                ),
            );
        }
        out.derived.push(DerivedDecl {
            name: name.to_string(),
            expr: Expr::Raw(value),
        });
        return;
    }
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
        B::BIdentifier(id) => {
            // F289: an object literal bound whole (`const t = useToggle()`) is read member by member (`t.key`), as a
            // destructuring is; one derived value naming a handler's local would be a job that cannot run.
            let named: Option<Vec<(String, RawExpr)>> = match &value.kind {
                RawKind::Object(props) => Some(props.clone()),
                RawKind::Array(items) => Some(
                    items
                        .iter()
                        .enumerate()
                        .map(|(i, v)| (i.to_string(), v.clone()))
                        .collect(),
                ),
                _ => None,
            };
            if let Some(props) = named {
                if bind_literal_members(r, out, id.r#ref, &props) {
                    return;
                }
                return shape(
                    out,
                    format!(
                        "custom hook {hook} returns an object or array inside the one bound whole at the call site"
                    ),
                );
            }
            bind_one(r, out, site, id.r#ref, value)
        }
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

/// W1d PR 2 (Mellow C1): a scope hook is identified by PROVENANCE, never by its name: `const useXScope = createXScope()` at
/// the module level, where `createXScope` is the second binding of `createContextScope` (imported from
/// `@radix-ui/react-context`), declared in this module or in the module it is imported from (as that module exports it).
fn is_scope_hook_call(m: Module<'_, '_>, names: &NameTable<'_>, call: &js_ast::E::Call) -> bool {
    let Some(hook) = crate::analyze::names::ident_ref(&call.target) else {
        return false;
    };
    // `const hook = factory()` at the top level of this module
    let factory = m.ast.parts.iter().find_map(|part| {
        part.stmts.slice().iter().find_map(|st| {
            let S::SLocal(l) = &st.data else { return None };
            if !matches!(l.kind, js_ast::S::Kind::KConst) {
                return None;
            }
            l.decls.iter().find_map(|d| {
                let (B::BIdentifier(id), Some(v)) = (d.binding.data, d.value) else {
                    return None;
                };
                let E::ECall(c) = &v.data else { return None };
                if !names.same(id.r#ref, hook) || !c.args.is_empty() {
                    return None;
                }
                crate::analyze::names::ident_ref(&c.target)
            })
        })
    });
    let Some(factory) = factory else { return false };
    match names
        .import_of(factory)
        .map(|(s, i)| (s.to_string(), i.to_string()))
    {
        None => second_binding_of_context_scope(m.ast, names, |r| names.same(r, factory)),
        Some((source, imported)) => {
            let Some(opts) = m.opts else { return false };
            if imported == "*" || imported == "default" {
                return false;
            }
            let Some(path) =
                crate::analyze::modules::resolve_module(&m.parsed.path(), &source, opts)
            else {
                return false;
            };
            let (path, imported) = follow_reexports(opts, path, imported);
            let Ok(bytes) = std::fs::read(opts.root.join(&path)) else {
                return false;
            };
            let Ok(parsed) = crate::parse::parse_tsx(&path, bytes) else {
                return false;
            };
            parsed.with_ast(|ast| {
                let other = NameTable::for_hook(ast);
                second_binding_of_context_scope(ast, &other, |r| other.name(r) == imported)
            })
        }
    }
}

/// Whether a top-level `const [createX, createXScope] = createContextScope(…)` of `ast` binds, as its second item, a name
/// `is` accepts; `createContextScope` is the import from `@radix-ui/react-context`.
fn second_binding_of_context_scope(
    ast: &js_ast::Ast<'_>,
    names: &NameTable<'_>,
    is: impl Fn(js_ast::Ref) -> bool,
) -> bool {
    ast.parts.iter().any(|part| {
        part.stmts.slice().iter().any(|st| {
            let S::SLocal(l) = &st.data else { return false };
            if !matches!(l.kind, js_ast::S::Kind::KConst) {
                return false;
            }
            l.decls.iter().any(|d| {
                let (B::BArray(arr), Some(v)) = (d.binding.data, d.value) else {
                    return false;
                };
                let E::ECall(c) = &v.data else { return false };
                let items = arr.items();
                items.len() == 2
                    && !arr.has_spread
                    && names.is_import_call(
                        &c.target,
                        "@radix-ui/react-context",
                        "createContextScope",
                    )
                    && matches!(items[1].binding.data, B::BIdentifier(id) if is(id.r#ref))
            })
        })
    })
}

/// The statements of an `if` branch (a block's, or the one statement).
fn branch_stmts(b: &js_ast::Stmt) -> Vec<js_ast::Stmt> {
    match &b.data {
        S::SBlock(blk) => blk.stmts.slice().to_vec(),
        _ => vec![*b],
    }
}

/// Whether a branch ends in a `return` of a value.
fn ends_with_return(b: &js_ast::Stmt) -> bool {
    matches!(branch_stmts(b).last().map(|s| &s.data), Some(S::SReturn(r)) if r.value.is_some())
}

fn ends_with_return_or_throw(b: &js_ast::Stmt) -> bool {
    ends_with_return(b) || matches!(branch_stmts(b).last().map(|s| &s.data), Some(S::SThrow(_)))
}

/// W1d PR 3: the render-error arm of an early-return chain that ends in a `throw`.
fn throw_arm(loc: u32) -> RawExpr {
    RawExpr {
        loc,
        kind: RawKind::Call {
            callee: Box::new(RawExpr {
                loc,
                kind: RawKind::Ident {
                    name: crate::ir::THROW_FN.into(),
                    kind: IdentKind::Global,
                },
            }),
            args: Vec::new(),
        },
    }
}

/// `throw new Error(<literal>)` (or TypeError/RangeError): the message is a string literal, a template of string literals
/// and module consts that are string literals, or absent.
fn literal_error_throw(v: &js_ast::Expr, m: Module<'_, '_>, names: &NameTable<'_>) -> bool {
    let E::ENew(n) = &v.data else { return false };
    let E::EIdentifier(t) = &n.target.data else {
        return false;
    };
    if !matches!(
        names.name(t.ref_).as_str(),
        "Error" | "TypeError" | "RangeError"
    ) || !matches!(names.kind_of(t.ref_).1, IdentKind::Global)
        || n.args.len() > 1
    {
        return false;
    }
    let module = crate::analyze::stores::Module::new(m.ast);
    let lit = |e: &js_ast::Expr| match &e.data {
        E::EString(_) => true,
        E::EIdentifier(id) => matches!(
            module.const_value(id.ref_),
            Some(js_ast::Expr {
                data: E::EString(_),
                ..
            })
        ),
        _ => false,
    };
    match n.args.first().map(|a| &a.data) {
        None | Some(E::EString(_)) => true,
        Some(E::ETemplate(t)) => t.tag.is_none() && t.parts.slice().iter().all(|p| lit(&p.value)),
        _ => false,
    }
}

/// A test that reads only props, literals and module names (not state, a store, a setter, a loop value or a body local).
fn test_is_static(e: &RawExpr, body_locals: &[&str]) -> bool {
    let st = |x: &RawExpr| test_is_static(x, body_locals);
    match &e.kind {
        RawKind::Lit(_) => true,
        RawKind::Ident { kind, name } => match kind {
            IdentKind::Prop => true,
            IdentKind::Local | IdentKind::Import { .. } => !body_locals.contains(&name.as_str()),
            _ => false,
        },
        RawKind::Member { target, .. } => st(target),
        RawKind::Unary { value, .. } => st(value),
        RawKind::Binary { left, right, .. } => st(left) && st(right),
        RawKind::Cond { test, yes, no } => st(test) && st(yes) && st(no),
        _ => false,
    }
}

/// The props `e` reads (`Ident` of kind `Prop`, the root before any path).
fn prop_roots(e: &RawExpr, out: &mut Vec<String>) {
    match &e.kind {
        RawKind::Ident {
            name,
            kind: IdentKind::Prop,
        } => out.push(name.split(['.', '[']).next().unwrap_or(name).to_string()),
        RawKind::Member { target, .. } => prop_roots(target, out),
        RawKind::Unary { value, .. } => prop_roots(value, out),
        RawKind::Binary { left, right, .. } => {
            prop_roots(left, out);
            prop_roots(right, out);
        }
        RawKind::Cond { test, yes, no } => {
            prop_roots(test, out);
            prop_roots(yes, out);
            prop_roots(no, out);
        }
        _ => {}
    }
}
