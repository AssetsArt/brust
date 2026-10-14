//! Child components (spec §3.2 rule 4, §3.4, §7.4): resolve and compile each
//! `<Child/>`, record its tier, link reactive props into native children
//! (`ChildLink`, `_pN`), and turn `react` children into islands rendered by an
//! `Ssr` job — refusing props an island cannot hydrate from.
use super::deps::{Deps, minimal_paths};
use super::{PassCtx, PassState, run_passes};
use crate::analyze::component::finish_diagnostics;
use crate::analyze::exports::{declared_in, declared_member, package_member};
use crate::analyze::modules::{
    Entry, Export, Lookup, cache_key, compile, is_package_source, resolve, resolve_package,
};
use crate::ir::{
    Attr, ChildLink, ChildRef, ComponentIR, Diagnostic, Expr, ExternalRef, IdentKind,
    InstanceRecord, JobDecl, JobKind, JsCtx, Node, PolyTag, RawExpr, RawKind, ServerExpr, Tier,
    UnOp, component_id, named_component_id,
};
use std::collections::{BTreeSet, HashMap};
use std::rc::Rc;

/// The walker over `ir`'s template (shared by the context frames pass and the children pass).
fn walker<'s, 'c>(ir: &ComponentIR, st: &'s mut PassState, ctx: &'c PassCtx<'c>) -> Walker<'s, 'c> {
    // Module consts the folder may read (R34.49): never a name the component body declares, and
    // never one with a use that is not a proven read (an array or object another use could change).
    let shadowed = |n: &str| {
        ir.derived.iter().any(|d| d.name == n)
            || ir.state.iter().any(|d| d.name == n)
            || ir.id_bindings.iter().any(|i| i == n)
            || ir.refs.iter().any(|r| r.name == n)
            || st.handler_names.contains(n)
    };
    let module_consts: Rc<HashMap<String, RawExpr>> = Rc::new(
        ir.module_decls
            .iter()
            .flat_map(|d| d.consts.iter())
            .filter(|c| !c.mutated && !shadowed(&c.name))
            .map(|c| (c.name.clone(), c.value.clone()))
            .collect(),
    );
    Walker {
        module_consts,
        st,
        ctx,
        links: Vec::new(),
        refs: Vec::new(),
        jobs: Vec::new(),
        diagnostics: Vec::new(),
        loop_scope: Vec::new(),
        lists: Vec::new(),
        items: Vec::new(),
        indexes: Vec::new(),
        list_uses: Vec::new(),
        loop_sources: Vec::new(),
        loop_literals: Vec::new(),
        instance_counts: HashMap::new(),
        instances: Vec::new(),
        eval_instances: Vec::new(),
        folded_instances: Vec::new(),
        ssr_outputs: HashMap::new(),
        row_only: HashMap::new(),
        // Props can change on the client unless nothing can reach this component: a child may be
        // linked by its parent (x-props-bind), a component with state of its own is a host whose
        // props are settable. Only a stateless root (a route component) has fixed props.
        props_reactive: !ctx.is_root
            || !ir.state.is_empty()
            || !ir.effects.is_empty()
            || !ir.handlers.is_empty()
            || !ir.refs.is_empty(),
        handlers: Vec::new(),
        own_named: ir.props.iter().map(|p| p.name.clone()).collect(),
        absent: BTreeSet::new(),
        holds_island: false,
        provider_locs: Default::default(),
        foreign: Default::default(),
    }
}

/// The Provider modules whose helpers a substituted context value calls: alias → (the module's component, names).
type ForeignModules = std::collections::BTreeMap<String, (Rc<ComponentIR>, BTreeSet<String>)>;

/// What a context Provider hands to the consumers under it (S2, R34.102): each field an expression of the scope that
/// renders the Provider component (its call site), not of the Provider's own body.
struct Frame {
    context: String,
    fields: Vec<(String, RawExpr)>,
}

/// S2 context lowering, BEFORE placement (R34.102-R34.104): a Provider component's value fields become hidden props
/// (`ir::ctx_prop`) of every consumer instance under it, so the inlined consumer, its jobs and its template read
/// them like any prop. A consumer with no Provider in this template bubbles its need up: the component declares the
/// hidden prop itself and its own call site fills it (a wrapper around a consumer stays a plain component); only a
/// route component with an unfilled need falls back (`context-no-provider`).
pub fn contexts(
    ir: &mut ComponentIR,
    st: &mut PassState,
    ctx: &PassCtx<'_>,
) -> std::collections::BTreeSet<u32> {
    let mut w = walker(ir, st, ctx);
    let mut template = std::mem::replace(&mut ir.template, Node::Fragment(vec![]));
    let mut frames: Vec<Frame> = Vec::new();
    let mut bubbled: Vec<(String, String)> = Vec::new();
    let mut diags: Vec<Diagnostic> = Vec::new();
    w.frames_node(&mut template, &mut frames, &mut bubbled, &mut diags);
    ir.template = template;
    // The Provider module's helpers the substituted values call, as module declarations of this component (S2).
    for (alias, (cir, names)) in std::mem::take(&mut *w.foreign.borrow_mut()) {
        let mut imports = BTreeSet::new();
        let code = crate::lower::common::module_code(&cir, &names, &mut imports);
        let exports = names.iter().cloned().collect::<Vec<_>>().join(", ");
        ir.module_decls.push(crate::ir::ModuleDecl {
            names: vec![alias.clone()],
            source: format!("const {alias} = (() => {{\n{code}return {{ {exports} }}\n}})()"),
            consts: Vec::new(),
        });
        ir.module_scope.push((
            alias,
            imports
                .into_iter()
                .map(|(local, source, imported)| (local, IdentKind::Import { source, imported }))
                .collect(),
        ));
    }
    for (c, f) in &bubbled {
        let name = crate::ir::ctx_prop(c, f);
        if !ir.props.iter().any(|p| p.name == name) {
            ir.props.push(crate::ir::PropDecl {
                name: name.clone(),
                local: name,
                ts_type: None,
                default: None,
            });
        }
        match ir.ctx_uses.iter_mut().find(|u| &u.context == c) {
            Some(u) if !u.fields.contains(f) => u.fields.push(f.clone()),
            Some(_) => {}
            None => ir.ctx_uses.push(crate::ir::CtxUse {
                context: c.clone(),
                fields: vec![f.clone()],
            }),
        }
    }
    if ctx.is_root && !bubbled.is_empty() {
        diags.push(Diagnostic::fallback(
            "context-no-provider",
            format!(
                "`{}` reads a context that no Provider above it provides",
                bubbled[0].0
            ),
            0,
            "render it inside the Provider component, or keep this component in React",
        ));
    }
    ir.diagnostics.extend(diags);
    w.provider_locs
}

pub fn children(ir: &mut ComponentIR, st: &mut PassState, ctx: &PassCtx<'_>) {
    let mut w = walker(ir, st, ctx);
    let mut template = std::mem::replace(&mut ir.template, Node::Fragment(vec![]));
    w.node(&mut template);
    w.resolve_row_only(std::slice::from_mut(&mut template), false);
    debug_assert!(
        w.row_only.is_empty(),
        "every RowOnly link is visited by resolve_row_only"
    );
    ir.template = template;
    // A list or condition the children lowered folded its slot away: the precompute job no longer
    // computes what no node reads (the server would warn about the missing output on every request).
    let mut live = BTreeSet::new();
    super::placement::collect_slots(ir, &mut |slot, _, _| {
        live.insert(slot.to_string());
    });
    for j in ir
        .jobs
        .iter_mut()
        .filter(|j| matches!(j.kind, crate::ir::JobKind::Precompute))
    {
        j.outputs.retain(|o| live.contains(o));
    }
    ir.jobs
        .retain(|j| !(matches!(j.kind, crate::ir::JobKind::Precompute) && j.outputs.is_empty()));
    ir.child_links.extend(w.links);
    ir.instances.extend(w.instances);
    ir.build_eval_instances.extend(w.eval_instances);
    ir.folded_instances.extend(w.folded_instances);
    ir.holds_island |= w.holds_island;
    ir.children.extend(w.refs);
    ir.absent_props = w.absent.iter().cloned().collect();
    ir.jobs.extend(w.jobs);
    ir.diagnostics.extend(w.diagnostics);
    ir.handlers.extend(w.handlers);
}

struct Walker<'s, 'c> {
    /// Foldable module `const` initializers by name (see `children`).
    module_consts: Rc<HashMap<String, RawExpr>>,
    st: &'s mut PassState,
    ctx: &'s PassCtx<'c>,
    links: Vec<ChildLink>,
    refs: Vec<ChildRef>,
    jobs: Vec<JobDecl>,
    diagnostics: Vec<Diagnostic>,
    loop_scope: Vec<String>,
    /// Prop paths of the enclosing `For` sources, and whether the source
    /// reads state.
    lists: Vec<(Vec<String>, bool)>,
    /// Item bindings of the enclosing `For`s, innermost last.
    items: Vec<String>,
    /// Index bindings of the enclosing `For`s, aligned with `items`.
    indexes: Vec<Option<String>>,
    /// The enclosing `For` sources as client reads, used when a linked child sits in the row.
    list_uses: Vec<super::ClientUse>,
    /// The enclosing `For` sources as props paths (`None` = not a plain path).
    loop_sources: Vec<Option<String>>,
    /// The enclosing `For` sources as compile-time constant arrays (F142 R34.43), aligned.
    loop_literals: Vec<Option<serde_json::Value>>,
    instance_counts: HashMap<String, u32>,
    instances: Vec<InstanceRecord>,
    /// Instances whose child job the build may run once (F149, R34.88-R34.90).
    eval_instances: Vec<crate::ir::BuildEvalInstance>,
    /// Instances the build ran (the recompile): no record, their slots are literals.
    folded_instances: Vec<crate::ir::FoldedInstance>,
    ssr_outputs: HashMap<String, u32>,
    /// `RowOnly` links by id with the client reads they imply, resolved after the walk.
    /// With the child's name and location when it derives values from its props on the server (F96d).
    row_only: HashMap<u32, RowOnlyLink>,
    /// Whether this component's own props can change after first paint (see `children`).
    props_reactive: bool,
    /// Handlers hoisted from props a static child spreads onto an element (shadcn S1.3).
    handlers: Vec<crate::ir::HandlerDecl>,
    /// This component's named props (its `...rest` holds every other key).
    own_named: BTreeSet<String>,
    /// Keys this component's own call sites must not pass (`ComponentIR::absent_props`, F153c).
    absent: BTreeSet<String>,
    /// S2 F3: a child of this template is a React island, or holds one.
    holds_island: bool,
    /// S2: component instances that push a Provider frame.
    provider_locs: std::collections::BTreeSet<u32>,
    /// S2: names of a Provider's module that a substituted context value reads, per Provider component (the alias
    /// of its module scope in this component's jobs, the component, the names).
    foreign: std::cell::RefCell<ForeignModules>,
}

/// The largest constant list (JSON bytes) a per-row-literal instance carries in the manifest
/// (F142 R34.43, ruling Q3: the same cap as island-children's per-instance tree).
const MAX_ROWS_JSON: usize = 64 * 1024;

/// A resolved child.
struct Child {
    id: Option<String>,
    path: Option<String>,
    tier: Tier,
    /// The compiled child has a precompute job, an island's ssr render or `useId` values the server
    /// must feed per instance (`ir::is_fed`).
    fed: bool,
    /// The compiled child reads a resolved store at render, or a job of its reads `__store` (C5; an
    /// island's ssr render always does).
    stores: bool,
    /// The compiled child has a precompute job (or an island's ssr render, L4) over its props: the
    /// server computes it once, so a link that changes those props later would leave it stale (F96d).
    prop_precompute: bool,
    /// Where the child spreads its props (shadcn S1.2): the call-site keys that land in a spread.
    spread: SpreadSink,
    /// The child's polymorphic tag (`asChild`, R34.28): the call site must resolve it.
    poly: Option<PolyTag>,
    /// The polymorphic element spreads an object of keys known only at render (a props path, not the
    /// props or their rest): a class or style the `asChild` child brings cannot be merged with it at
    /// compile time.
    poly_runtime_spread: bool,
    /// What else the child does with those keys, for a handler the parent may bind (shadcn S1.3).
    onward: HandlerSink,
    /// The props roots the compiled child's jobs read (the server feeds each instance these).
    job_roots: BTreeSet<String>,
    /// The compiled child is a `forwardRef` component (R34.63): a call site that passes `ref` needs React.
    forwards_ref: bool,
    /// The compiled child spreads its props onto an inlined lucide icon (R34.77).
    icon_spread: bool,
    /// The compiled child reads `children` as a value (`children ?? <X/>`, `children ? a : b`), not only as `{children}`:
    /// an inlined instance has the markup, not a value to test.
    reads_children_value: bool,
    /// The compiled child has `useId` values (the server seeds them per instance, per row).
    use_id: bool,
    /// Keys the call site must not pass (`ComponentIR::absent_props`).
    absent: Vec<String>,
    /// The compiled child (S2 context frames read its `provides` / `ctx_uses` / props / derived).
    ir: Option<Rc<ComponentIR>>,
    /// Whether the build may run the child's precompute job for a constant-input instance (F149,
    /// `build_eval::instance_job`); `None` when the child is not fed.
    job_eval: Option<Result<Vec<crate::ir::EvalStub>, String>>,
    /// The child's job outputs (`_sN`), all of which an evaluated instance must get.
    job_outputs: Vec<String>,
}

/// Facts that decide whether a handler landing in a static child's spread can be bound by the
/// parent on the child's element (shadcn S1.3, R34.18). The default refuses every key.
#[derive(Clone, Debug, Default)]
struct HandlerSink {
    /// The keys the child spreads into another component (a binding would be needed there).
    components: SpreadSink,
    /// Prop roots the child reads by name outside its spreads; `None` = the whole props object.
    reads: Option<BTreeSet<String>>,
}

impl HandlerSink {
    fn of(ir: &ComponentIR) -> HandlerSink {
        let mut t = ir.template.clone();
        strip_spreads(&mut t);
        let cx = super::deps::DepsCx::new(ir);
        let mut d = cx.deps_node(&t, &[]);
        for h in &ir.handlers {
            d.union(&cx.deps(&h.body, &h.item_scoped));
        }
        for e in &ir.effects {
            d.union(&cx.deps(&e.body, &[]));
        }
        let roots = d.prop_roots();
        HandlerSink {
            components: SpreadSink::of_where(ir, false),
            reads: (!roots.contains("*")).then_some(roots),
        }
    }
}

/// The polymorphic element of `n` carries a spread that is neither the props nor their rest (a
/// props path such as `{...attrs}`): its keys are known only at render.
fn poly_has_runtime_spread(n: &Node) -> bool {
    match n {
        Node::Element {
            poly,
            attrs,
            children,
            ..
        } => {
            (*poly
                && attrs.iter().any(|a| match a {
                    Attr::Spread(Expr::Raw(r) | Expr::Server(ServerExpr(r))) => !matches!(
                        &r.kind,
                        RawKind::Ident { name, kind: IdentKind::Prop }
                            if name == "*" || name == crate::ir::REST_PROPS
                    ),
                    Attr::Spread(_) => true,
                    _ => false,
                }))
                || children.iter().any(poly_has_runtime_spread)
        }
        Node::Fragment(cs) => cs.iter().any(poly_has_runtime_spread),
        Node::If { then, else_, .. } => then.iter().chain(else_).any(poly_has_runtime_spread),
        Node::For { body, .. } => body.iter().any(poly_has_runtime_spread),
        Node::Component { children, .. } => children.iter().any(poly_has_runtime_spread),
        Node::Text(_) | Node::Slot(_) | Node::Outlet => false,
    }
}

/// `n` without its spreads (attribute and component), for what a child reads by name.
fn strip_spreads(n: &mut Node) {
    match n {
        Node::Element {
            attrs, children, ..
        } => {
            attrs.retain(|a| !matches!(a, Attr::Spread(_)));
            children.iter_mut().for_each(strip_spreads);
        }
        Node::Component {
            props, children, ..
        } => {
            props.retain(|(k, _)| k != crate::ir::SPREAD_KEY);
            children.iter_mut().for_each(strip_spreads);
        }
        Node::Fragment(cs) => cs.iter_mut().for_each(strip_spreads),
        Node::If { then, else_, .. } => then.iter_mut().chain(else_).for_each(strip_spreads),
        Node::For { body, .. } => body.iter_mut().for_each(strip_spreads),
        Node::Text(_) | Node::Slot(_) | Node::Outlet => {}
    }
}

/// Which props of a call site a child spreads onto an element or another component.
#[derive(Clone, Debug, Default)]
enum SpreadSink {
    #[default]
    None,
    /// Every key except these (`{...props}` / `{...rest}`; several spreads union).
    AllBut(Vec<String>),
    /// Exactly these keys (`{...props.attrs}` spreads the call site's `attrs`).
    Only(Vec<String>),
}

impl SpreadSink {
    fn lands(&self, key: &str) -> bool {
        match self {
            SpreadSink::None => false,
            SpreadSink::AllBut(omit) => !omit.iter().any(|k| k == key),
            SpreadSink::Only(keys) => keys.iter().any(|k| k == key),
        }
    }

    /// The child's props spreads, read from its template (React tier: none, it renders itself).
    fn of(ir: &ComponentIR) -> SpreadSink {
        Self::of_where(ir, true)
    }

    /// [`Self::of`], counting spreads onto elements only when `elements` (always those into
    /// components).
    fn of_where(ir: &ComponentIR, elements: bool) -> SpreadSink {
        let named: Vec<String> = ir.props.iter().map(|p| p.name.clone()).collect();
        let mut sink = SpreadSink::None;
        let mut add = |v: &Expr| {
            let raw = match v {
                Expr::Raw(r) | Expr::Server(ServerExpr(r)) => r,
                _ => return,
            };
            let next = match &raw.kind {
                RawKind::Ident {
                    name,
                    kind: IdentKind::Prop,
                } if name == "*" => SpreadSink::AllBut(Vec::new()),
                RawKind::Ident {
                    name,
                    kind: IdentKind::Prop,
                } if name == crate::ir::REST_PROPS => SpreadSink::AllBut(named.clone()),
                _ => match crate::analyze::passes::deps::prop_path(raw) {
                    Some(p) => {
                        SpreadSink::Only(vec![p.split('.').next().unwrap_or(&p).to_string()])
                    }
                    None => return,
                },
            };
            sink = match (std::mem::take(&mut sink), next) {
                (SpreadSink::None, n) => n,
                (SpreadSink::AllBut(a), SpreadSink::AllBut(b)) => {
                    SpreadSink::AllBut(a.into_iter().filter(|k| b.contains(k)).collect())
                }
                (SpreadSink::AllBut(a), SpreadSink::Only(b))
                | (SpreadSink::Only(b), SpreadSink::AllBut(a)) => {
                    SpreadSink::AllBut(a.into_iter().filter(|k| !b.contains(k)).collect())
                }
                (SpreadSink::Only(mut a), SpreadSink::Only(b)) => {
                    a.extend(b);
                    SpreadSink::Only(a)
                }
                (s, SpreadSink::None) => s,
            };
        };
        fn walk(n: &Node, elements: bool, add: &mut dyn FnMut(&Expr)) {
            match n {
                Node::Element {
                    attrs, children, ..
                } => {
                    for a in attrs {
                        if let Attr::Spread(v) = a
                            && elements
                        {
                            add(v);
                        }
                    }
                    children.iter().for_each(|c| walk(c, elements, add));
                }
                Node::Component {
                    props, children, ..
                } => {
                    for (k, v) in props {
                        if k == crate::ir::SPREAD_KEY {
                            add(v);
                        }
                    }
                    children.iter().for_each(|c| walk(c, elements, add));
                }
                Node::Fragment(cs) => cs.iter().for_each(|c| walk(c, elements, add)),
                Node::If { then, else_, .. } => then
                    .iter()
                    .chain(else_)
                    .for_each(|c| walk(c, elements, add)),
                Node::For { body, .. } => body.iter().for_each(|c| walk(c, elements, add)),
                Node::Text(_) | Node::Slot(_) | Node::Outlet => {}
            }
        }
        if !matches!(ir.tier, Tier::React { .. }) {
            walk(&ir.template, elements, &mut add);
        }
        sink
    }
}

/// Client reads a `RowOnly` link implies, and the child's (name, loc) when it precomputes over props.
type RowOnlyLink = (Vec<super::ClientUse>, Option<(String, u32)>);

fn linked_prop_precompute(name: &str, loc: u32) -> Diagnostic {
    Diagnostic::fallback(
        "linked-prop-precompute",
        format!(
            "<{name}> derives values from its props on the server, but its props change on the client"
        ),
        loc,
        "derive the value in the parent, or keep the child's props constant; the component renders as a React island",
    )
}

/// The marker key of a lowered element in an island's `children` prop (read by `reviveSource`).
const MARK: &str = "$brust";

/// The literal prop of an island instance that lists the props holding an element tree (R34.52):
/// the only thing that makes the revive turn a prop back into elements.
const X_KEY: &str = "$x";

/// R34.69 (F158): `name` is a page or layout and takes request data as props, so the caller's lowered JSX
/// (children or an element prop) is never revived for it; the caller renders with React instead.
fn root_host_diag(diagnostics: &mut Vec<Diagnostic>, name: &str, loc: u32) {
    diagnostics.push(Diagnostic::fallback(
        "revive-host-route-root",
        format!(
            "<{name}> is a page or layout, whose props are request data; brust never revives JSX children or element props for it"
        ),
        loc,
        "render it without JSX children, or move the shared part into a component that is not a route",
    ));
}

/// Shadcn S1 (R34.23): the most JSON one island instance's lowered children may take.
const MAX_CHILDREN_JSON: usize = 64 * 1024;

/// The component reads `children` somewhere other than as the child `{children}` itself (a condition, an attribute, a
/// `??`): the only reads an inlined instance can answer is the markup, never a value to test.
fn reads_children_as_value(ir: &ComponentIR) -> bool {
    fn strip(n: &mut Node) {
        match n {
            Node::Slot(Expr::Raw(r) | Expr::Server(ServerExpr(r))) if matches!(&r.kind, RawKind::Ident { name, kind: IdentKind::Prop } if name == "children") =>
            {
                *n = Node::Text(String::new());
            }
            Node::Element { children, .. }
            | Node::Fragment(children)
            | Node::Component { children, .. } => children.iter_mut().for_each(strip),
            Node::If { then, else_, .. } => then.iter_mut().chain(else_).for_each(strip),
            Node::For { body, .. } => body.iter_mut().for_each(strip),
            _ => {}
        }
    }
    let mut t = ir
        .structural
        .as_ref()
        .map_or_else(|| ir.template.clone(), |s| s.template.clone());
    strip(&mut t);
    let d = super::deps::DepsCx::new(ir).deps_node(&t, &[]);
    d.props
        .iter()
        .any(|p| p == "children" || p.starts_with("children."))
}

/// A key lucide-react 1.56 reads itself: any `aria-*`, `role` or `title` (it then drops its own `aria-hidden`),
/// `nonScalingStroke`, `iconNode`, `icon`, besides [`ICON_OWN_PROPS`]. Brust bakes `aria-hidden` at build time, so none of
/// them may reach an icon through a runtime spread.
fn icon_reads_itself(k: &str) -> bool {
    ICON_OWN_PROPS.contains(&k)
        || k.starts_with("aria-")
        || matches!(
            k,
            "role" | "title" | "nonScalingStroke" | "iconNode" | "icon"
        )
}

/// Props a lucide icon component reads itself; none may reach one through a runtime spread (R34.77).
const ICON_OWN_PROPS: &[&str] = &[
    "size",
    "color",
    "strokeWidth",
    "absoluteStrokeWidth",
    "width",
    "height",
    "className",
    "class",
    "children",
    "ref",
    "key",
    "style",
];

/// A prop name an element may travel under (R34.52): never one the revive strips or reads itself.
fn slot_prop_ok(k: &str) -> bool {
    !matches!(
        k,
        "children" | "ref" | "key" | "dangerouslySetInnerHTML" | "__proto__"
    ) && !k.starts_with('$')
}

/// Attributes React reads a bare `<x disabled />` of as `true`; any other bare or empty attribute is
/// ambiguous in the IR (`aria-hidden` is `"true"`, `alt=""` is empty) and does not lower.
const BOOLEAN_ATTRS: &[&str] = &[
    "disabled",
    "checked",
    "selected",
    "readOnly",
    "required",
    "hidden",
    "multiple",
    "autoFocus",
    "autoPlay",
    "controls",
    "loop",
    "muted",
    "open",
    "reversed",
    "defaultChecked",
    "defaultSelected",
    "noValidate",
    "formNoValidate",
    "async",
    "defer",
    "inert",
    "playsInline",
    "allowFullScreen",
    "itemScope",
    "default",
    "noModule",
];

/// A JSON value as the literal expression the template and the SSR job print.
fn raw_json(v: &serde_json::Value, loc: u32) -> crate::ir::RawKind {
    use crate::ir::{Literal, RawKind};
    use serde_json::Value;
    let sub = |v: &Value| RawExpr {
        loc,
        kind: raw_json(v, loc),
    };
    match v {
        Value::Null => RawKind::Lit(Literal::Null),
        Value::Bool(b) => RawKind::Lit(Literal::Bool(*b)),
        Value::Number(n) => RawKind::Lit(Literal::Num(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => RawKind::Lit(Literal::Str(s.clone())),
        Value::Array(a) => RawKind::Array(a.iter().map(sub).collect()),
        Value::Object(o) => RawKind::Object(o.iter().map(|(k, v)| (k.clone(), sub(v))).collect()),
    }
}

/// `lucide-react` + `Heart` → `heart_1a2b3c4d`: the export's name and a hash of where it is from.
fn external_component_id(source: &str, export: &str, member: &[String]) -> String {
    let base = if export == "default" {
        source.rsplit('/').next().unwrap_or(source)
    } else if export == "*" {
        ""
    } else {
        export
    };
    let mut name: String = base
        .chars()
        .chain(member.iter().flat_map(|m| m.chars()))
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    if let Some(first) = name.get(..1).map(str::to_ascii_lowercase) {
        name.replace_range(..1, &first);
    }
    if name.is_empty() {
        name = "external".into();
    }
    // A member path is part of the identity: `Dialog.Root` and `Dialog.Trigger` are two components, and
    // a plain export keeps the id it always had.
    let scope = if member.is_empty() {
        format!("package:{source}")
    } else {
        format!("package:{source}:{export}:{}", member.join("."))
    };
    named_component_id(&scope, &name)
}

/// Why a component compiled from package source cannot be used as compiled (F153c): it, or a component in its
/// subtree, renders as React (an island of a package's SOURCE would run code the React build never ran), or it
/// failed to compile. `None` = static or native all the way down.
fn package_needs_react(
    lookup: &Lookup,
    modules: &crate::analyze::modules::ModuleCache,
) -> Option<String> {
    let ir = match lookup {
        Lookup::Compiled(ir) => ir.clone(),
        Lookup::Cycle => return Some("an import cycle".into()),
        Lookup::Failed(d) => return Some(d.message.clone()),
    };
    let by_id: HashMap<String, Rc<ComponentIR>> = modules
        .done()
        .into_iter()
        .map(|(_, ir)| (ir.id.clone(), ir))
        .collect();
    let mut stack = vec![ir];
    let mut seen = BTreeSet::new();
    while let Some(ir) = stack.pop() {
        if !seen.insert(ir.id.clone()) {
            continue;
        }
        if let Tier::React { reason, .. } = &ir.tier {
            return Some(format!(
                "{} renders as React in its source: {reason}",
                ir.source
            ));
        }
        for c in &ir.children {
            if let Tier::React { reason, .. } = &c.tier {
                return Some(format!(
                    "<{}> in {} renders as React: {reason}",
                    c.name, ir.source
                ));
            }
            if let Some(next) = c.id.as_ref().and_then(|id| by_id.get(id)) {
                stack.push(next.clone());
            }
        }
    }
    None
}

/// The export name of a `Primitive.<tag>` component (R34.65).
const PRIMITIVE_EXPORT: &str = "Primitive";

fn react(reason: &str) -> Tier {
    Tier::React {
        reason: reason.into(),
        client_only: false,
    }
}

impl Walker<'_, '_> {
    fn node(&mut self, n: &mut Node) {
        match n {
            Node::Element { children, .. } | Node::Fragment(children) => {
                children.iter_mut().for_each(|c| self.node(c))
            }
            Node::If { then, else_, .. } => {
                then.iter_mut().for_each(|c| self.node(c));
                else_.iter_mut().for_each(|c| self.node(c));
            }
            Node::For {
                source,
                item,
                index,
                body,
                ..
            } => {
                let src = (self.paths_of(source), self.deps_of(source).reactive());
                let n = self.loop_scope.len();
                self.loop_scope.push(item.clone());
                self.loop_scope.extend(index.iter().cloned());
                let raw = match &*source {
                    Expr::Server(ServerExpr(r)) => Some(r.clone()),
                    Expr::Precomputed { slot, .. } => {
                        self.st.slots.get(slot).map(|i| i.raw.clone())
                    }
                    _ => None,
                };
                let use_ = super::ClientUse {
                    loc: raw.as_ref().map_or(0, |r| r.loc),
                    deps: self.deps_of(source),
                    what: "a list the client updates",
                    raw: raw.map(|r| (r, self.loop_scope[..n].to_vec())),
                };
                let list_path = self.list_path(source);
                let literal = match &*source {
                    Expr::Raw(r) | Expr::Server(ServerExpr(r)) => {
                        r.json_literal().filter(serde_json::Value::is_array)
                    }
                    _ => None,
                };
                self.loop_sources.push(list_path);
                self.loop_literals.push(literal);
                self.lists.push(src);
                self.list_uses.push(use_);
                self.items.push(item.clone());
                self.indexes.push(index.clone());
                body.iter_mut().for_each(|c| self.node(c));
                self.indexes.pop();
                self.items.pop();
                self.loop_sources.pop();
                self.loop_literals.pop();
                self.list_uses.pop();
                self.lists.pop();
                self.loop_scope.truncate(n);
            }
            Node::Component { .. } => self.component(n),
            Node::Text(_) | Node::Slot(_) | Node::Outlet => {}
        }
    }

    /// The frames walk of [`contexts`].
    fn frames_node(
        &mut self,
        n: &mut Node,
        frames: &mut Vec<Frame>,
        bubbled: &mut Vec<(String, String)>,
        diags: &mut Vec<Diagnostic>,
    ) {
        match n {
            Node::Element { children, .. } | Node::Fragment(children) => children
                .iter_mut()
                .for_each(|c| self.frames_node(c, frames, bubbled, diags)),
            Node::If { then, else_, .. } => {
                then.iter_mut()
                    .for_each(|c| self.frames_node(c, frames, bubbled, diags));
                else_
                    .iter_mut()
                    .for_each(|c| self.frames_node(c, frames, bubbled, diags));
            }
            Node::For { body, .. } => body
                .iter_mut()
                .for_each(|c| self.frames_node(c, frames, bubbled, diags)),
            Node::Component {
                loc,
                name,
                source,
                imported,
                member,
                props,
                children,
                ..
            } => {
                if name == "<member>" {
                    children
                        .iter_mut()
                        .for_each(|c| self.frames_node(c, frames, bubbled, diags));
                    return;
                }
                let mark = self.diagnostics.len();
                let child =
                    self.resolve_child(name, source.as_deref(), imported.as_deref(), member, *loc);
                // The children pass resolves it again and reports; these diagnostics are not repeated.
                self.diagnostics.truncate(mark);
                let Some(cir) = child.ir.clone() else {
                    children
                        .iter_mut()
                        .for_each(|c| self.frames_node(c, frames, bubbled, diags));
                    return;
                };
                // A React island (and what it receives as children or element props) renders with React's own
                // context at run time: nothing in its subtree is read here, and it provides nothing at compile time.
                let island = !matches!(cir.tier, Tier::Static | Tier::Native);
                // F3 (fail closed): a Provider that is lowered away no longer shares a React tree with an island
                // under it, which would hydrate standalone and read the context DEFAULT. Any island (or a static
                // child holding one) under an active frame, or inside a Provider's own tree, keeps the page React.
                if ((island || cir.holds_island) && !frames.is_empty())
                    || (!island && cir.holds_island && !cir.provides.is_empty())
                {
                    diags.push(Diagnostic::fallback(
                        "context-island",
                        format!(
                            "<{name}> is, or holds, a React island under a context Provider that is rendered natively; an island would not see the Provider's value"
                        ),
                        *loc,
                        "keep the island outside the Provider, or render the page with React",
                    ));
                }
                if island {
                    return;
                }
                // Consumer: each field it reads comes from the nearest frame of its context, else bubbles up.
                for u in &cir.ctx_uses {
                    for f in &u.fields {
                        let hidden = crate::ir::ctx_prop(&u.context, f);
                        if props.iter().any(|(k, _)| k == &hidden) {
                            continue;
                        }
                        let value = match frames.iter().rev().find(|fr| fr.context == u.context) {
                            Some(fr) => Expr::Raw(
                                fr.fields
                                    .iter()
                                    .find(|(k, _)| k == f)
                                    .map(|(_, v)| v.clone())
                                    .unwrap_or_else(|| RawExpr {
                                        loc: *loc,
                                        kind: RawKind::Lit(crate::ir::Literal::Undefined),
                                    }),
                            ),
                            None => {
                                if !bubbled.iter().any(|(c, g)| c == &u.context && g == f) {
                                    bubbled.push((u.context.clone(), f.clone()));
                                }
                                Expr::Raw(RawExpr {
                                    loc: *loc,
                                    kind: RawKind::Ident {
                                        name: hidden.clone(),
                                        kind: IdentKind::Prop,
                                    },
                                })
                            }
                        };
                        props.push((hidden, value));
                    }
                }
                // Provider: its values, in this scope, for the children passed to it.
                let mut pushed = 0;
                for pd in &cir.provides {
                    let mut fields = Vec::new();
                    let mut failed = None;
                    for (k, raw) in &pd.fields {
                        match self.subst(raw, &cir, props, 0) {
                            Ok(v) => fields.push((k.clone(), v)),
                            Err(why) => {
                                failed = Some(why);
                                break;
                            }
                        }
                    }
                    match failed {
                        None => {
                            frames.push(Frame {
                                context: pd.context.clone(),
                                fields,
                            });
                            pushed += 1;
                        }
                        Some(why) => diags.push(Diagnostic::fallback(
                            "context-value",
                            format!(
                                "<{name}> provides a value brust cannot express where it is used: {why}"
                            ),
                            *loc,
                            "keep this component in React, or provide plain props-derived values",
                        )),
                    }
                }
                if pushed > 0 {
                    self.provider_locs.insert(*loc);
                }
                children
                    .iter_mut()
                    .for_each(|c| self.frames_node(c, frames, bubbled, diags));
                frames.truncate(frames.len() - pushed);
            }
            Node::Text(_) | Node::Slot(_) | Node::Outlet => {}
        }
    }

    /// `raw`, an expression of the Provider component `cir`'s body, as an expression of the scope that renders it
    /// (`props` are the call site's): its props become the call site's values (a default when absent), its derived
    /// locals are expanded, the rest is copied. `Err(why)` for anything this cannot express.
    fn subst(
        &self,
        raw: &RawExpr,
        cir: &Rc<ComponentIR>,
        props: &[(String, Expr)],
        depth: u8,
    ) -> Result<RawExpr, String> {
        if depth > 8 {
            return Err("a chain of derived values deeper than 8".into());
        }
        let go = |r: &RawExpr| self.subst(r, cir, props, depth);
        let b = |r: &RawExpr| -> Result<Box<RawExpr>, String> { Ok(Box::new(go(r)?)) };
        let kind = match &raw.kind {
            RawKind::Lit(_) => raw.kind.clone(),
            RawKind::Ident { name, kind } => match kind {
                IdentKind::Prop if name != "*" => {
                    // Spreads at the call site: the caller's own props object or its `...rest` carries every prop it
                    // does not name (R34.14: `rest.k` is prop `k`); any other spread is not read here.
                    let mut carried = false;
                    for (k, e) in props {
                        if k != crate::ir::SPREAD_KEY {
                            continue;
                        }
                        match e {
                            Expr::Raw(RawExpr {
                                kind:
                                    RawKind::Ident {
                                        name: src,
                                        kind: IdentKind::Prop,
                                    },
                                ..
                            }) if src == "*" || src == crate::ir::REST_PROPS => {
                                carried |= !self.own_named.iter().any(|n| n == name);
                            }
                            _ => {
                                return Err(format!(
                                    "the prop `{name}` may come from a spread of unknown keys"
                                ));
                            }
                        }
                    }
                    let explicit = props.iter().rev().find(|(k, _)| k == name).map(|(_, e)| e);
                    let default = match cir
                        .props
                        .iter()
                        .find(|p| &p.name == name)
                        .and_then(|p| p.default.as_ref())
                    {
                        Some(d) => self.subst(d, cir, props, depth + 1)?,
                        None => RawExpr {
                            loc: raw.loc,
                            kind: RawKind::Lit(crate::ir::Literal::Undefined),
                        },
                    };
                    if carried {
                        if explicit.is_some() {
                            return Err(format!(
                                "the prop `{name}` is given and a spread after it may carry it too"
                            ));
                        }
                        // The caller's own prop `name`; the Provider's default applies when it is undefined.
                        let read = RawExpr {
                            loc: raw.loc,
                            kind: RawKind::Ident {
                                name: name.clone(),
                                kind: IdentKind::Prop,
                            },
                        };
                        let undefined = RawExpr {
                            loc: raw.loc,
                            kind: RawKind::Lit(crate::ir::Literal::Undefined),
                        };
                        if matches!(default.kind, RawKind::Lit(crate::ir::Literal::Undefined)) {
                            return Ok(read);
                        }
                        return Ok(RawExpr {
                            loc: raw.loc,
                            kind: RawKind::Cond {
                                test: Box::new(RawExpr {
                                    loc: raw.loc,
                                    kind: RawKind::Binary {
                                        op: crate::ir::BinOp::StrictEq,
                                        left: Box::new(read.clone()),
                                        right: Box::new(undefined),
                                    },
                                }),
                                yes: Box::new(default),
                                no: Box::new(read),
                            },
                        });
                    }
                    match explicit {
                        Some(Expr::Raw(r)) => return Ok(r.clone()),
                        Some(_) => {
                            return Err(format!("the prop `{name}` is not a plain expression"));
                        }
                        None => return Ok(default),
                    }
                }
                IdentKind::Local => {
                    let derived = cir
                        .structural
                        .as_ref()
                        .map(|s| s.derived.as_slice())
                        .unwrap_or(&[])
                        .iter()
                        .find(|d| &d.name == name);
                    if let Some(Expr::Raw(r)) = derived.map(|d| &d.expr) {
                        return self.subst(r, cir, props, depth + 1);
                    }
                    // A module-level `const` of a primitive literal is that literal.
                    if let Some(c) = cir
                        .module_decls
                        .iter()
                        .flat_map(|d| &d.consts)
                        .find(|c| &c.name == name && !c.mutated)
                        && matches!(c.value.kind, RawKind::Lit(_))
                    {
                        return Ok(RawExpr {
                            loc: raw.loc,
                            kind: c.value.kind.clone(),
                        });
                    }
                    if !cir.module_scope.iter().any(|(n, _)| n == name) {
                        return Err(format!(
                            "`{name}` is not a name the Provider's module declares"
                        ));
                    }
                    if cir.source == self.ctx.path {
                        // The same module: its declarations are this component's own.
                        return Ok(raw.clone());
                    }
                    // Another module (a package's source): the helper runs in this component's jobs through a copy of the
                    // module's declarations, kept apart in a function scope (no export, no rename).
                    let mut imports = BTreeSet::new();
                    let names: BTreeSet<String> = [name.clone()].into();
                    crate::lower::common::module_code(cir, &names, &mut imports);
                    if let Some((_, s, _)) = imports.iter().find(|(_, s, _)| s.starts_with('.')) {
                        return Err(format!(
                            "the Provider's module reads a relative import ({s})"
                        ));
                    }
                    let alias = format!("__ctxm_{}", cir.id);
                    self.foreign
                        .borrow_mut()
                        .entry(alias.clone())
                        .or_insert_with(|| (cir.clone(), BTreeSet::new()))
                        .1
                        .insert(name.clone());
                    return Ok(RawExpr {
                        loc: raw.loc,
                        kind: RawKind::Member {
                            target: Box::new(RawExpr {
                                loc: raw.loc,
                                kind: RawKind::Ident {
                                    name: alias,
                                    kind: IdentKind::Local,
                                },
                            }),
                            name: name.clone(),
                            optional: false,
                        },
                    });
                }
                IdentKind::Global | IdentKind::Import { .. } => raw.kind.clone(),
                _ => return Err(format!("`{name}` is state, a handler or a loop value")),
            },
            RawKind::Member {
                target,
                name,
                optional,
            } => RawKind::Member {
                target: b(target)?,
                name: name.clone(),
                optional: *optional,
            },
            RawKind::Index { target, index } => RawKind::Index {
                target: b(target)?,
                index: b(index)?,
            },
            RawKind::Call { callee, args } => RawKind::Call {
                callee: b(callee)?,
                args: args.iter().map(go).collect::<Result<_, _>>()?,
            },
            RawKind::Binary { op, left, right } => RawKind::Binary {
                op: *op,
                left: b(left)?,
                right: b(right)?,
            },
            RawKind::Unary { op, value } => RawKind::Unary {
                op: *op,
                value: b(value)?,
            },
            RawKind::Cond { test, yes, no } => RawKind::Cond {
                test: b(test)?,
                yes: b(yes)?,
                no: b(no)?,
            },
            RawKind::Template { head, parts } => RawKind::Template {
                head: head.clone(),
                parts: parts
                    .iter()
                    .map(|(p, t)| Ok((go(p)?, t.clone())))
                    .collect::<Result<_, String>>()?,
            },
            RawKind::Array(xs) => RawKind::Array(xs.iter().map(go).collect::<Result<_, _>>()?),
            RawKind::Object(ps) => RawKind::Object(
                ps.iter()
                    .map(|(k, v)| Ok((k.clone(), go(v)?)))
                    .collect::<Result<_, String>>()?,
            ),
            RawKind::Arrow { .. } | RawKind::Jsx(_) | RawKind::Opaque { .. } => {
                return Err("an expression outside the subset".into());
            }
        };
        Ok(RawExpr { loc: raw.loc, kind })
    }

    fn deps_of(&self, e: &Expr) -> Deps {
        match e {
            Expr::Precomputed { slot, per_item, .. } => {
                let mut d = self
                    .st
                    .slots
                    .get(slot)
                    .map(|i| i.deps.clone())
                    .unwrap_or_default();
                if let Some(item) = per_item {
                    d.loop_bindings.insert(item.clone());
                }
                d
            }
            other => self.st.cx.deps_expr(other, &self.loop_scope),
        }
    }

    fn paths_of(&self, e: &Expr) -> Vec<String> {
        match e {
            Expr::Precomputed { inputs, .. } => inputs.clone(),
            other => self.st.cx.deps_expr(other, &self.loop_scope).prop_paths(),
        }
    }

    /// A component that lives in a package, rendered as a React island (L22); a member path
    /// (`Dialog` + `["Root"]`, R34.35) selects a value off the export.
    fn external_child(
        &mut self,
        name: &str,
        source: &str,
        export: &str,
        member: &[String],
        loc: u32,
    ) -> Child {
        self.external_child_why(name, source, export, member, loc, None)
    }

    /// [`Self::external_child`]; `why`: why the package's source was not compiled instead (F153c).
    fn external_child_why(
        &mut self,
        name: &str,
        source: &str,
        export: &str,
        member: &[String],
        loc: u32,
        why: Option<String>,
    ) -> Child {
        let ctx = self.ctx;
        let at = if member.is_empty() {
            String::new()
        } else {
            format!(
                " ({}{})",
                if export == "*" {
                    String::new()
                } else {
                    format!("{export}.")
                },
                member.join(".")
            )
        };
        self.diagnostics.push(Diagnostic::fallback(
            "external-component",
            match &why {
                None => format!("<{name}> comes from the package {source}{at}; it renders as a React island"),
                Some(w) => format!(
                    "<{name}> comes from the package {source}{at}; it renders as a React island (package source: {w})"
                ),
            },
            loc,
            "use a component from this project to keep it native",
        ));
        // The island is the package export itself: a synthetic React-tier component the
        // build resolves as `{package, export}` (L22).
        let id = external_component_id(source, export, member);
        // Not a path: the key and `source` only need to be unique and safe as a file stem.
        let key: String = format!(
            "package {source} {export}{}",
            member.iter().map(|m| format!(" {m}")).collect::<String>()
        )
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
        let known = ctx.modules.borrow().get(&key).is_some();
        if !known {
            let mut synthetic = ComponentIR::new(id.clone(), key.clone());
            synthetic.external = Some(ExternalRef {
                source: source.to_string(),
                export: export.to_string(),
                member: member.to_vec(),
            });
            synthetic.tier = react("external component");
            super::tier::react_jobs(&mut synthetic);
            ctx.modules
                .borrow_mut()
                .insert(key, Entry::Done(Rc::new(synthetic)));
        }
        Child {
            id: Some(id),
            path: None,
            tier: react("external component"),
            fed: false,
            stores: false,
            prop_precompute: false,
            spread: SpreadSink::None,
            poly: None,
            poly_runtime_spread: false,
            onward: HandlerSink::default(),
            job_roots: BTreeSet::new(),
            forwards_ref: false,
            icon_spread: false,
            reads_children_value: false,
            use_id: false,
            absent: Vec::new(),
            ir: None,
            job_eval: None,
            job_outputs: Vec::new(),
        }
    }

    fn resolve_child(
        &mut self,
        name: &str,
        source: Option<&str>,
        imported: Option<&str>,
        member: &[String],
        loc: u32,
    ) -> Child {
        let ctx = self.ctx;
        let Some(source) = source else {
            return self.local_child(name, loc);
        };
        let Some(path) = resolve(ctx.path, source, ctx.opts) else {
            if source.starts_with("./") || source.starts_with("../") {
                self.diagnostics.push(Diagnostic::error(
                    "unresolved-import",
                    format!("cannot resolve component <{name}> from {source}"),
                    loc,
                    "import a .tsx/.ts module or a directory with index.tsx",
                ));
                return Child {
                    id: None,
                    path: None,
                    tier: react("unresolved import"),
                    fed: false,
                    stores: false,
                    prop_precompute: false,
                    spread: SpreadSink::None,
                    poly: None,
                    poly_runtime_spread: false,
                    onward: HandlerSink::default(),
                    job_roots: BTreeSet::new(),
                    forwards_ref: false,
                    icon_spread: false,
                    reads_children_value: false,
                    use_id: false,
                    absent: Vec::new(),
                    ir: None,
                    job_eval: None,
                    job_outputs: Vec::new(),
                };
            }
            // A package export (a member of one included): its source when the build wrote it (F153c), else
            // the island is the export itself.
            return self.package_child(
                name,
                ctx.path,
                source,
                imported.unwrap_or("default"),
                member,
                loc,
            );
        };
        let export = match imported {
            None | Some("default") => Export::Default,
            Some(n) => Export::Named(n.to_string()),
        };
        // The component is the one the export is declared by, however many barrels it crosses (R34.11).
        let (path, export) = declared_in(&path, &export, ctx.opts);
        // `export { Root }` after `const Root = DialogPrimitive.Root`: the component is the package member.
        if let Some(m) = package_member(&path, &export, ctx.opts) {
            return self.package_child(name, &path, &m.source, &m.imported, &m.member, loc);
        }
        let id = match &export {
            Export::Default => component_id(&path),
            Export::Named(n) => named_component_id(&path, n),
        };
        let lookup = compile(&path, &export, None, ctx.opts, ctx.modules);
        self.finish(name, Some(id), Some(path), lookup, loc)
    }

    /// A component a bare import of the module at `from` names (F153c, R34.61): compiled from the package source
    /// the build wrote, like app code. Fails closed to the React island of the export (today's L22 rule) when the
    /// build refused the package, the export cannot be followed, or anything in the compiled subtree needs React:
    /// an island is always the published package export, never its source (G1, R34.62).
    fn package_child(
        &mut self,
        name: &str,
        from: &str,
        source: &str,
        imported: &str,
        member: &[String],
        loc: u32,
    ) -> Child {
        let ctx = self.ctx;
        // Inside a package source, an import the build did not write is not followed either: the subtree is then
        // React, and the app-level import falls back as a whole.
        let entry = match resolve_package(from, source, ctx.opts) {
            Ok(entry) => entry,
            Err(why) => return self.external_child_why(name, source, imported, member, loc, why),
        };
        // R34.65: `Primitive.<tag>` of the Radix factory is the host element.
        if let [tag] = member
            && imported != "*"
        {
            let there = if imported == "default" {
                Export::Default
            } else {
                Export::Named(imported.to_string())
            };
            if let (decl, Export::Named(n)) = declared_in(&entry, &there, ctx.opts)
                && let Some(nodes) = crate::analyze::primitive::primitive_nodes(&decl, &n, ctx.opts)
                && nodes.iter().any(|t| t == tag)
            {
                return self.primitive_child(name, &decl, tag, loc);
            }
        }
        let Some((path, export)) = declared_member(&entry, imported, member, ctx.opts) else {
            return self.external_child_why(
                name,
                source,
                imported,
                member,
                loc,
                Some("the export is not declared in a form the compiler follows".into()),
            );
        };
        let id = match &export {
            Export::Default => component_id(&path),
            Export::Named(n) => named_component_id(&path, n),
        };
        let lookup = compile(&path, &export, None, ctx.opts, ctx.modules);
        let needs_react = package_needs_react(&lookup, &ctx.modules.borrow());
        if let Some(why) = needs_react {
            // Only the outermost package import is the island: a nested one says nothing new.
            if is_package_source(from) {
                return self.external_child(name, source, imported, member, loc);
            }
            return self.external_child_why(name, source, imported, member, loc, Some(why));
        }
        self.finish(name, Some(id), Some(path), lookup, loc)
    }

    /// `Primitive.<tag>` of a recognised Radix factory declared in the module at `decl` (R34.65): the component the
    /// factory makes for `tag`, as the source it is equivalent to (asChild aside, which the call site resolves like
    /// `Button`'s; the write-only `window` marker dropped). Compiled once per tag, beside the factory's module.
    fn primitive_child(&mut self, name: &str, decl: &str, tag: &str, loc: u32) -> Child {
        let ctx = self.ctx;
        let dir = decl.rsplit_once('/').map_or("", |(d, _)| d);
        let path = format!("{dir}/primitive.{tag}.tsx");
        let export = Export::Named(PRIMITIVE_EXPORT.to_string());
        let source = format!(
            "import * as React from 'react'\n\
             import {{ Slot }} from '@radix-ui/react-slot'\n\
             const {PRIMITIVE_EXPORT} = React.forwardRef(function {PRIMITIVE_EXPORT}({{ asChild, ...primitiveProps }}: any, forwardedRef: any) {{\n  \
             const Comp = asChild ? Slot : '{tag}'\n  \
             return <Comp {{...primitiveProps}} ref={{forwardedRef}} />\n\
             }})\n\
             export {{ {PRIMITIVE_EXPORT} }}\n"
        );
        let id = named_component_id(&path, PRIMITIVE_EXPORT);
        let lookup = compile(
            &path,
            &export,
            Some(source.into_bytes()),
            ctx.opts,
            ctx.modules,
        );
        self.finish(name, Some(id), Some(path), lookup, loc)
    }

    /// A component declared in this module.
    fn local_child(&mut self, name: &str, loc: u32) -> Child {
        let ctx = self.ctx;
        let key = cache_key(ctx.path, &Export::Named(name.into()));
        let id = named_component_id(ctx.path, name);
        let cached = ctx.modules.borrow().get(&key).cloned();
        let lookup = match cached {
            Some(Entry::InProgress) => Lookup::Cycle,
            Some(Entry::Done(ir)) => Lookup::Compiled(ir),
            Some(Entry::Failed(d)) => Lookup::Failed(d),
            None => {
                let Some(mut child) = (ctx.local)(name) else {
                    self.diagnostics.push(Diagnostic::fallback(
                        "local-component",
                        format!("<{name}> is not a function declaration in this module"),
                        loc,
                        "declare it as `function Name(props) { … }`",
                    ));
                    return Child {
                        id: None,
                        path: Some(ctx.path.into()),
                        tier: react("local component"),
                        fed: false,
                        stores: false,
                        prop_precompute: false,
                        spread: SpreadSink::None,
                        poly: None,
                        poly_runtime_spread: false,
                        onward: HandlerSink::default(),
                        job_roots: BTreeSet::new(),
                        forwards_ref: false,
                        icon_spread: false,
                        reads_children_value: false,
                        use_id: false,
                        absent: Vec::new(),
                        ir: None,
                        job_eval: None,
                        job_outputs: Vec::new(),
                    };
                };
                ctx.modules
                    .borrow_mut()
                    .insert(key.clone(), Entry::InProgress);
                let child_ctx = PassCtx {
                    text: ctx.text,
                    opts: ctx.opts,
                    path: ctx.path,
                    modules: ctx.modules,
                    local: ctx.local,
                    is_root: false,
                };
                run_passes(&mut child, &child_ctx);
                finish_diagnostics(&mut child, ctx.text);
                let child = Rc::new(child);
                ctx.modules
                    .borrow_mut()
                    .insert(key, Entry::Done(child.clone()));
                Lookup::Compiled(child)
            }
        };
        self.finish(name, Some(id), Some(ctx.path.into()), lookup, loc)
    }

    fn finish(
        &mut self,
        name: &str,
        id: Option<String>,
        path: Option<String>,
        lookup: Lookup,
        loc: u32,
    ) -> Child {
        let mut fed = false;
        let mut stores = false;
        let mut prop_precompute = false;
        let mut spread = SpreadSink::None;
        let mut poly = None;
        let mut poly_runtime_spread = false;
        let mut onward = HandlerSink::default();
        let mut job_roots = BTreeSet::new();
        let mut use_id = false;
        let mut forwards_ref = false;
        let mut icon_spread = false;
        let mut reads_children_value = false;
        let mut absent = Vec::new();
        let mut child_ir = None;
        let mut job_eval = None;
        let mut job_outputs = Vec::new();
        let tier = match lookup {
            Lookup::Compiled(ir) => {
                child_ir = Some(ir.clone());
                forwards_ref = ir.forwards_ref;
                icon_spread = ir.icon_spread;
                absent = ir.absent_props.clone();
                reads_children_value =
                    matches!(ir.tier, Tier::Static | Tier::Native) && reads_children_as_value(&ir);
                job_roots = ir
                    .jobs
                    .iter()
                    .flat_map(|j| &j.inputs)
                    .filter(|i| i.as_str() != "*")
                    .map(|i| {
                        let i = i.strip_prefix("props.").unwrap_or(i);
                        i.split(['.', '[']).next().unwrap_or(i).to_string()
                    })
                    .collect();
                spread = SpreadSink::of(&ir);
                poly = ir.poly.clone();
                poly_runtime_spread = poly.is_some() && poly_has_runtime_spread(&ir.template);
                if matches!(ir.tier, Tier::Static) {
                    onward = HandlerSink::of(&ir);
                }
                if matches!(&ir.tier, Tier::React { reason, .. } if reason == crate::analyze::modules::OPAQUE_EXPORT)
                {
                    self.diagnostics.push(Diagnostic::fallback(
                        "child-component",
                        format!(
                            "<{name}> renders as a React island: {} is not a function declaration",
                            ir.source
                        ),
                        loc,
                        "declare the child as `export function Name(props) { … }`",
                    ));
                }
                // An island's ssr job reads `__store` whether or not the wrapper reads a store (L4).
                stores = ir.stores.iter().any(|s| s.resolved.is_some())
                    || ir
                        .jobs
                        .iter()
                        .any(|j| j.inputs.iter().any(|i| i == "__store"));
                fed = crate::ir::is_fed(&ir);
                if fed && let Some(p) = &path {
                    job_eval = Some(super::build_eval::instance_job(&ir, p, self.ctx.opts));
                    job_outputs = ir.jobs.iter().flat_map(|j| j.outputs.clone()).collect();
                }
                use_id = ir.use_id_slots > 0;
                // An island's ssr render over the wrapper's props is computed once too (L4).
                prop_precompute = ir.jobs.iter().any(|j| {
                    crate::ir::feeds_instances(j) && j.inputs.iter().any(|i| i != "__store")
                });
                ir.tier.clone()
            }
            Lookup::Cycle => {
                self.diagnostics.push(Diagnostic::fallback(
                    "import-cycle",
                    format!("<{name}> is part of an import cycle with this component"),
                    loc,
                    "break the cycle; the child renders as a React island",
                ));
                react("import cycle")
            }
            Lookup::Failed(d) if d.class == crate::ir::DiagClass::Fallback => {
                self.diagnostics.push(Diagnostic::fallback(
                    "child-component",
                    format!("<{name}> renders as a React island: {}", d.message),
                    loc,
                    "declare the child as `export function Name(props) { … }`",
                ));
                react("child is not a function declaration")
            }
            Lookup::Failed(d) => {
                self.diagnostics.push(Diagnostic::error(
                    "child-component",
                    format!("<{name}> could not be compiled: {}", d.message),
                    loc,
                    "fix the child component",
                ));
                react("child failed to compile")
            }
        };
        Child {
            id,
            path,
            tier,
            fed,
            stores,
            prop_precompute,
            spread,
            poly,
            poly_runtime_spread,
            onward,
            job_roots,
            forwards_ref,
            icon_spread,
            reads_children_value,
            use_id,
            absent,
            ir: child_ir,
            job_eval,
            job_outputs,
        }
    }

    /// Whether the props spread into a child at this call site may carry `key` (F153c): `Ok(true)` when one of them is
    /// this component's own props object, or its `...rest` and `key` is not a named prop; `Err` when a spread of
    /// keys known only at render (a props path) is among them.
    fn spread_carries(&self, key: &str, props: &[(String, Expr)]) -> Result<bool, ()> {
        let mut carries = false;
        for (k, v) in props {
            if k != crate::ir::SPREAD_KEY {
                continue;
            }
            match v {
                Expr::Raw(r) | Expr::Server(ServerExpr(r)) => match &r.kind {
                    RawKind::Ident {
                        name,
                        kind: IdentKind::Prop,
                    } if name == "*" => carries = true,
                    RawKind::Ident {
                        name,
                        kind: IdentKind::Prop,
                    } if name == crate::ir::REST_PROPS => carries |= !self.own_named.contains(key),
                    _ => return Err(()),
                },
                _ => return Err(()),
            }
        }
        Ok(carries)
    }

    /// The child must not get `key` (its `absent_props`, F153c): a written literal `false` / `undefined` is fine, a
    /// spread of this component's own props passes the requirement to this component's call sites, anything
    /// else falls back. `true` = satisfied (the child renders as compiled).
    fn require_absent(
        &mut self,
        name: &str,
        key: &str,
        props: &[(String, Expr)],
        loc: u32,
    ) -> bool {
        let written = props.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v);
        let falsy = match written {
            None => true,
            Some(Expr::Raw(r) | Expr::Server(ServerExpr(r))) => {
                matches!(r.json_literal(), Some(serde_json::Value::Bool(false)))
                    || matches!(r.kind, RawKind::Lit(crate::ir::Literal::Undefined))
            }
            Some(_) => false,
        };
        // A route root's props come from the request: no call site checks a requirement passed up to it.
        let carried = self.spread_carries(key, props).and_then(|c| {
            if c && self.ctx.is_root {
                Err(())
            } else {
                Ok(c)
            }
        });
        if falsy && let Ok(carries) = carried {
            if carries {
                self.absent.insert(key.to_string());
            }
            return true;
        }
        self.diagnostics.push(Diagnostic::fallback(
            "slot-dynamic",
            format!(
                "`{key}` of <{name}> is not a literal `false` or absent (or props of unknown keys are spread in), so brust cannot tell which element it renders"
            ),
            loc,
            "leave the prop out, or keep the page on React",
        ));
        false
    }

    /// Mirrors `lower::template::expr_reactive`.
    fn reads_state(&self, e: &Expr) -> bool {
        match e {
            Expr::Precomputed {
                state_dependent, ..
            } => *state_dependent,
            other => self.deps_of(other).reactive(),
        }
    }

    /// A list source the client re-evaluates: it reads state, or it reads props that can change.
    fn source_reactive(&self, e: &Expr) -> bool {
        self.reads_state(e) || (self.props_reactive && !self.deps_of(e).props.is_empty())
    }

    /// Whether the client can re-create the rows of this list: an enclosing list can, its
    /// source changes (state, or props of a component whose props can change), or its body
    /// carries a directive of its own.
    fn row_reactive(&self, source: &Expr, body: &[Node], enclosing: bool) -> bool {
        enclosing || self.source_reactive(source) || body.iter().any(|n| self.body_directive(n))
    }

    /// `lower::template::needs_directives` without the row-only links this pass decides:
    /// a component counts only through an `Always` link (or its slot children).
    fn body_directive(&self, n: &Node) -> bool {
        match n {
            Node::Element {
                attrs, children, ..
            } => {
                attrs.iter().any(|a| match a {
                    Attr::Event { .. } | Attr::Ref { .. } => true,
                    Attr::Dynamic { value, .. } | Attr::InnerHtml { value } => {
                        self.reads_state(value)
                    }
                    _ => false,
                }) || children.iter().any(|c| self.body_directive(c))
            }
            Node::Slot(e) => self.reads_state(e),
            Node::If { cond, then, else_ } => {
                self.reads_state(cond) || then.iter().chain(else_).any(|c| self.body_directive(c))
            }
            Node::For { source, body, .. } => {
                self.source_reactive(source) || body.iter().any(|c| self.body_directive(c))
            }
            Node::Component { link, children, .. } => {
                link.is_some_and(|id| !self.row_only.contains_key(&id))
                    || children.iter().any(|c| self.body_directive(c))
            }
            Node::Fragment(cs) => cs.iter().any(|c| self.body_directive(c)),
            Node::Text(_) | Node::Outlet => false,
        }
    }

    /// Second pass (ledger F70): a `RowOnly` link survives only inside a row the client can
    /// re-create; elsewhere the instance is plain HTML, so the link, its `_pN` member and the
    /// client reads it implied are dropped. Surviving ids keep their numbers (`_pN` is a
    /// name, not an index: a dropped link leaves a gap).
    fn resolve_row_only(&mut self, nodes: &mut [Node], reactive: bool) {
        for n in nodes {
            match n {
                Node::For { source, body, .. } => {
                    let r = self.row_reactive(source, body, reactive);
                    self.resolve_row_only(body, r);
                }
                Node::Component { link, children, .. } => {
                    if let Some(id) = *link
                        && let Some((uses, pc)) = self.row_only.remove(&id)
                    {
                        if reactive {
                            // The client re-creates this row, so its props change: values the
                            // child computed from them on the server would freeze (F96d).
                            if let Some((name, loc)) = pc {
                                self.diagnostics.push(linked_prop_precompute(&name, loc));
                            }
                            self.st.client_uses.extend(uses);
                        } else {
                            *link = None;
                            self.links.retain(|l| l.id != id);
                        }
                    }
                    self.resolve_row_only(children, reactive);
                }
                Node::Element { children, .. } | Node::Fragment(children) => {
                    self.resolve_row_only(children, reactive)
                }
                Node::If { then, else_, .. } => {
                    self.resolve_row_only(then, reactive);
                    self.resolve_row_only(else_, reactive);
                }
                Node::Text(_) | Node::Slot(_) | Node::Outlet => {}
            }
        }
    }

    fn component(&mut self, n: &mut Node) {
        let Node::Component {
            loc,
            name,
            source,
            imported,
            member,
            props,
            children,
            link,
            tier,
            forwarded_ref,
        } = n
        else {
            return;
        };
        if name == "<member>" {
            children.iter_mut().for_each(|c| self.node(c));
            return;
        }
        let child = self.resolve_child(name, source.as_deref(), imported.as_deref(), member, *loc);
        // L23: a lucide icon with reactive props is inlined by the second compile; only if it is
        // still a component then (`icons_final`) is a prop it cannot hydrate from an error.
        let pending_icon = !self.ctx.opts.icons_final
            && source.as_deref().is_some_and(super::icons::is_lucide)
            && !self
                .ctx
                .opts
                .icon_svgs
                .contains_key(&format!("{}@{loc}", self.ctx.path));
        // R34.56: a value an island cannot hydrate from makes the HOST React (React renders the
        // whole subtree, function and all); valid React is never a build error.
        let island_err = |rule: &str, msg: String, loc: u32, fix: &str| {
            if pending_icon {
                Diagnostic::warning(rule, msg, loc, fix)
            } else {
                Diagnostic::fallback(rule, msg, loc, fix)
            }
        };
        *tier = child.tier.clone();
        if !matches!(child.tier, Tier::Static | Tier::Native)
            || child.ir.as_ref().is_some_and(|c| c.holds_island)
        {
            self.holds_island = true;
        }
        // R34.64: a `ref` at the call site of a `forwardRef` component reaches an element React attaches it to; a
        // static or native render has none to give it.
        // F153c: passing this component's own forwarded ref on is React's `ref` chain; it ends on a host element
        // (dropped, R34.63) only when the child forwards it there itself.
        if *forwarded_ref && (!child.forwards_ref || matches!(child.tier, Tier::React { .. })) {
            self.diagnostics.push(Diagnostic::fallback(
                "forwardref-ref",
                format!(
                    "the forwarded ref is passed to <{name}>, which does not forward it to an element; the component renders as a React island"
                ),
                *loc,
                "pass the ref to an element, or to a forwardRef component that does",
            ));
        }
        if child.forwards_ref && props.iter().any(|(k, _)| k == "ref") {
            self.diagnostics.push(Diagnostic::fallback(
                "forwardref-ref",
                format!("`ref` is passed to the forwardRef component <{name}>; brust renders it without a ref"),
                *loc,
                "drop the ref, or keep this component in React",
            ));
        }
        let (hoisted, unbound) = self.forward_handlers(name, *loc, props, &child);
        self.check_children_read(name, children, &child, *loc);
        self.check_spread(name, props, &child, *loc, &hoisted, &unbound);
        // A hoisted handler is the parent's own member: not a prop of the instance.
        let kept: Vec<(String, Expr)> = props
            .iter()
            .filter(|(k, _)| !hoisted.contains(k))
            .cloned()
            .collect();
        self.check_poly(name, props, children, &child, *loc);
        if !matches!(child.tier, Tier::React { .. }) {
            for key in child.absent.clone() {
                if !self.require_absent(name, &key, props, *loc) {
                    break;
                }
            }
        }
        if !self.refs.iter().any(|r| r.name == *name) {
            self.refs.push(ChildRef {
                name: name.clone(),
                id: child.id.clone(),
                path: child.path.clone(),
                tier: child.tier.clone(),
                nested: None,
                x: Vec::new(),
            });
        }
        let child_id = child.id.clone().unwrap_or_else(|| name.clone());
        match &child.tier {
            Tier::React { client_only, .. } => {
                let mut inputs = Vec::new();
                let mut prop_map = std::collections::BTreeMap::new();
                let mut literals = std::collections::BTreeMap::new();
                let mut ok = true;
                let mut element_props: Vec<(String, serde_json::Value)> = Vec::new();
                // R34.69: a route component's props are request data; the revive never runs for it, so the
                // caller may not hand it lowered JSX (children or an element prop).
                // A route component is the default export of its file, so a named or same-file component of a
                // route file is not one: compare ids, not files.
                let root_host = child.id.as_deref().is_some_and(|id| {
                    self.ctx
                        .opts
                        .route_roots
                        .iter()
                        .any(|p| component_id(p) == id)
                });
                for (k, v) in props.iter() {
                    // `$`-prefixed props are the compiler's own (`$x`, the revive switch): a call-site prop of
                    // that name, written or inlined from a literal spread, could make data revive as elements.
                    if k.starts_with('$') {
                        self.diagnostics.push(Diagnostic::fallback(
                            "island-prop",
                            format!("the prop `{k}` of the React island <{name}> starts with `$`, which brust reserves for its own island props"),
                            *loc,
                            "rename the prop",
                        ));
                        continue;
                    }
                    // An element as a prop of the island (R34.52): lowered like children, revived
                    // from the names in the instance's `$x` literal.
                    if let Expr::Raw(RawExpr {
                        kind: RawKind::Jsx(el),
                        ..
                    }) = v
                    {
                        if root_host {
                            root_host_diag(&mut self.diagnostics, name, *loc);
                            continue;
                        }
                        let lowered = if slot_prop_ok(k) {
                            self.lower_children(std::slice::from_ref(&**el))
                        } else {
                            Err("a prop name the revive reserves".to_string())
                        };
                        match lowered {
                            Ok((tree, nested)) => {
                                literals.insert(k.clone(), tree.clone());
                                element_props.push((k.clone(), tree));
                                self.note_nested(name, nested);
                            }
                            Err(why) => self.diagnostics.push(Diagnostic::fallback(
                                "island-children",
                                format!("JSX passed as the prop `{k}` of the React island <{name}> cannot be lowered: {why}"),
                                *loc,
                                "render the element inside the island component, or pass constant markup",
                            )),
                        }
                        continue;
                    }
                    let d = self.deps_of(v);
                    let why = if matches!(v, Expr::ClientOnly { .. }) {
                        Some("a function".to_string())
                    } else if !d.state.is_empty() {
                        Some(format!(
                            "a reactive value (reads state `{}`)",
                            d.state.iter().cloned().collect::<Vec<_>>().join("`, `")
                        ))
                    } else if !d.stores.is_empty() {
                        Some(format!(
                            "a reactive value (reads store `{}`)",
                            d.stores.iter().cloned().collect::<Vec<_>>().join("`, `")
                        ))
                    } else {
                        None
                    };
                    if let Some(why) = why {
                        ok = false;
                        self.diagnostics.push(island_err(
                            "island-prop",
                            format!("prop `{k}` passed to the React island <{name}> is {why}"),
                            *loc,
                            "pass JSON values to keep this component native; it renders with React meanwhile",
                        ));
                        continue;
                    }
                    inputs.extend(self.paths_of(v));
                    let lit = match v {
                        Expr::Raw(r) | Expr::Server(ServerExpr(r)) => r.json_literal(),
                        _ => None,
                    };
                    match lit {
                        Some(j) => {
                            literals.insert(k.clone(), j);
                        }
                        None => {
                            prop_map.insert(k.clone(), self.prop_path(v));
                        }
                    }
                }
                if !element_props.is_empty() {
                    for (k, tree) in &element_props {
                        let raw = RawExpr {
                            loc: *loc,
                            kind: raw_json(tree, *loc),
                        };
                        if let Some(slot) = props.iter_mut().find(|(n, _)| n == k) {
                            slot.1 = Expr::Server(ServerExpr(raw));
                        }
                    }
                    let names = serde_json::Value::Array(
                        element_props
                            .iter()
                            .map(|(k, _)| serde_json::Value::String(k.clone()))
                            .collect(),
                    );
                    let raw = RawExpr {
                        loc: *loc,
                        kind: raw_json(&names, *loc),
                    };
                    props.push((X_KEY.to_string(), Expr::Server(ServerExpr(raw))));
                    if let Some(r) = self.refs.iter_mut().find(|r| r.name == *name) {
                        for (k, _) in &element_props {
                            if !r.x.contains(k) {
                                r.x.push(k.clone());
                            }
                        }
                        r.x.sort();
                    }
                    literals.insert(X_KEY.to_string(), names);
                }
                if !children.is_empty() && root_host {
                    root_host_diag(&mut self.diagnostics, name, *loc);
                } else if !children.is_empty() {
                    match self.lower_children(children) {
                        Ok((tree, nested)) => {
                            let raw = RawExpr {
                                loc: *loc,
                                kind: raw_json(&tree, *loc),
                            };
                            literals.insert("children".to_string(), tree);
                            props.push(("children".into(), Expr::Server(ServerExpr(raw))));
                            children.clear();
                            if let Some(r) = self.refs.iter_mut().find(|r| r.name == *name) {
                                let all = r.nested.get_or_insert_with(Vec::new);
                                for id in nested {
                                    if !all.contains(&id) {
                                        all.push(id);
                                    }
                                }
                            }
                        }
                        Err(why) => self.diagnostics.push(Diagnostic::fallback(
                            "island-children",
                            format!("JSX children passed to the React island <{name}> cannot be lowered: {why}"),
                            *loc,
                            "render the children inside the island component, or pass constant markup",
                        )),
                    }
                }
                if ok && self.lists.iter().any(|(_, stateful)| *stateful) {
                    ok = false;
                    self.diagnostics.push(island_err(
                        "island-prop",
                        format!("the React island <{name}> sits in a list that changes with state"),
                        *loc,
                        "key the list on props only to keep this component native; it renders with React meanwhile",
                    ));
                }
                if ok {
                    for (src, _) in &self.lists {
                        inputs.extend(src.iter().cloned());
                    }
                    let count = self.ssr_outputs.entry(child_id.clone()).or_insert(0);
                    *count += 1;
                    let output = if *count == 1 {
                        format!("_ssr_{child_id}")
                    } else {
                        format!("_ssr_{child_id}_{count}")
                    };
                    self.jobs.push(JobDecl {
                        kind: JobKind::Ssr {
                            client_only: *client_only,
                        },
                        inputs: minimal_paths(inputs),
                        outputs: vec![output],
                        per_item: self.items.last().cloned(),
                        props: Some(prop_map),
                        literals,
                    });
                }
            }
            _ => {
                // An element as a prop travels only to a React island (R34.52); anything else
                // keeps the fallback `placement` used to raise for it.
                if props.iter().any(|(_, v)| {
                    matches!(
                        v,
                        Expr::Raw(RawExpr {
                            kind: RawKind::Jsx(_),
                            ..
                        })
                    )
                }) && !self.diagnostics.iter().any(|d| d.rule == "jsx-expression")
                {
                    self.diagnostics.push(Diagnostic::fallback(
                        "jsx-expression",
                        "JSX inside an expression that is not a list, a condition or a child",
                        *loc,
                        "use a ternary, && or .map directly in the JSX children",
                    ));
                }
                // The template backend numbers every inlined instance of a child id.
                let k = self.instance_counts.entry(child_id.clone()).or_insert(0);
                *k += 1;
                let k = *k;
                let row_invariant = child.fed && self.row_invariant(&kept, &child);
                // F142 R34.43: one enclosing list that is a constant array feeds the instance per
                // row from the literal the manifest carries (capped, ruling Q3).
                let rows_literal = match (&self.loop_sources[..], &self.loop_literals[..]) {
                    ([None], [Some(rows)]) if child.fed && !row_invariant => Some(rows.clone()),
                    _ => None,
                };
                let too_big = rows_literal
                    .as_ref()
                    .map(|r| r.to_string().len())
                    .filter(|n| *n > MAX_ROWS_JSON);
                if let Some(size) = too_big {
                    self.diagnostics.push(Diagnostic::fallback(
                        "instance-list-path",
                        format!(
                            "<{name}> has a job of its own and reads the rows of a constant list of {size} bytes, over the {MAX_ROWS_JSON} byte cap"
                        ),
                        *loc,
                        "move the list into a loader (it then comes from props), or keep the page a React island",
                    ));
                }
                let rows_literal = rows_literal.filter(|_| too_big.is_none());
                if child.fed
                    && !row_invariant
                    && rows_literal.is_none()
                    && too_big.is_none()
                    && self.loop_sources.iter().any(Option::is_none)
                {
                    // Fail closed softly (ruling on challenge 4dc45c45, F142): the server feeds a
                    // per-instance job by indexing the list's props path; over a local or store list
                    // there is none, and the build would refuse the page (`manifest.ts`
                    // instance-list-path). Valid React never becomes a build error: an island instead.
                    self.diagnostics.push(Diagnostic::fallback(
                        "instance-list-path",
                        format!(
                            "<{name}> has a job of its own and sits in a list that is not a props path, so the server cannot feed it per row"
                        ),
                        *loc,
                        "map over a list that comes from props (a loader), or keep the page a React island",
                    ));
                }
                if child.fed {
                    let mut record = InstanceRecord {
                        child_id: child_id.clone(),
                        k,
                        // F142 R34.42: the same inputs in every row, so one job call feeds them all.
                        loops: if row_invariant {
                            Vec::new()
                        } else {
                            self.loop_sources.clone()
                        },
                        props: Default::default(),
                        literals: Default::default(),
                        exprs: Default::default(),
                        rows_literal,
                    };
                    for (name, v) in kept.iter() {
                        if matches!(v, Expr::ClientOnly { .. }) {
                            continue;
                        }
                        // F149 R34.88: folded with this module's consts (`const v = "outline"`).
                        let lit = match v {
                            Expr::Raw(r) | Expr::Server(ServerExpr(r)) => {
                                r.json_literal().or_else(|| self.fold_json(r))
                            }
                            _ => None,
                        };
                        if let Some(p) = self.prop_path(v) {
                            record.props.insert(name.clone(), Some(p));
                        } else if let Some(j) = lit {
                            record.literals.insert(name.clone(), j);
                        } else if let Some(e) = self.instance_expr(v) {
                            record.exprs.insert(name.clone(), e);
                        } else {
                            record.props.insert(name.clone(), None);
                        }
                    }
                    // C5: the child's jobs read `__store`; a fed child sits under a chain component
                    // whose props are the ctx, so the path is `__store` itself (else the manifest
                    // refuses the child job's input root as uncovered).
                    if child.stores {
                        record
                            .props
                            .insert("__store".into(), Some("__store".into()));
                    }
                    // A prop the call site does not pass is `undefined` for the child's job, as in
                    // React (a destructuring default applies): an expression the server evaluates to
                    // undefined drops the key. The manifest requires every input root bound.
                    for root in &child.job_roots {
                        if !record.props.contains_key(root)
                            && !record.literals.contains_key(root)
                            && !record.exprs.contains_key(root)
                        {
                            record.exprs.insert(
                                root.clone(),
                                crate::lower::server_expr::UNDEFINED.to_string(),
                            );
                        }
                    }
                    if !self.fold_instance(name, *loc, &child, &record) {
                        self.instances.push(record);
                    }
                }
                // Native / static child (§7.4, F70): see `instance_needs_link`.
                let need = instance_needs_link(
                    &child.tier,
                    kept.iter()
                        .map(|(_, v)| (matches!(v, Expr::ClientOnly { .. }), self.deps_of(v))),
                );
                if need == LinkNeed::Always && child.prop_precompute {
                    // Fail closed (F96d): the child computed values from its props once, on the
                    // server; a linked prop that changes would leave them stale with no warning.
                    self.diagnostics.push(linked_prop_precompute(name, *loc));
                }
                if need != LinkNeed::None {
                    // The parent chunk rebuilds the row's `_pN` from the list: it reads the source,
                    // and every prop is a client read. For a `RowOnly` link these reads are
                    // committed only if the link survives `resolve_row_only`.
                    let mut uses: Vec<super::ClientUse> = self.list_uses.clone();
                    let id = self.links.len() as u32 + 1;
                    for (_, v) in props.iter() {
                        let deps = self.deps_of(v);
                        let raw = match v {
                            Expr::Server(ServerExpr(r)) => Some(r.clone()),
                            Expr::Precomputed { slot, .. } => {
                                self.st.slots.get(slot).map(|i| i.raw.clone())
                            }
                            _ => None,
                        };
                        uses.push(super::ClientUse {
                            loc: *loc,
                            deps,
                            what: "a prop of a linked child",
                            raw: raw.map(|r| (r, self.loop_scope.clone())),
                        });
                    }
                    let link_props = props
                        .iter()
                        .map(|(k, v)| (k.clone(), self.link_prop(v)))
                        .collect();
                    self.links.push(ChildLink {
                        id,
                        child: child_id,
                        props_member: format!("_p{id}"),
                        item_scoped: self.loop_scope.clone(),
                        props: link_props,
                    });
                    *link = Some(id);
                    match need {
                        LinkNeed::Always => self.st.client_uses.extend(uses),
                        LinkNeed::RowOnly => {
                            let pc = child.prop_precompute.then(|| (name.clone(), *loc));
                            self.row_only.insert(id, (uses, pc));
                        }
                        LinkNeed::None => unreachable!(),
                    }
                }
            }
        }
        // After this node's own link id: `_pN` follow document order.
        children.iter_mut().for_each(|c| self.node(c));
    }

    /// Fail closed (shadcn S1.4, R34.29/R34.31): a child with a polymorphic tag (`asChild`) is
    /// resolved here, at its call site. No `asChild`, or a literal `false`, prints the host
    /// element. A literal `asChild` with exactly one host-element child whose attributes are
    /// plain values prints that child with the component's attributes merged in. Anything else
    /// (a value the call site cannot see, a component or text child, a handler, a ref, a
    /// stateful component) keeps the caller on React.
    fn check_poly(
        &mut self,
        name: &str,
        props: &[(String, Expr)],
        children: &[Node],
        child: &Child,
        loc: u32,
    ) {
        let Some(poly) = &child.poly else { return };
        if matches!(child.tier, Tier::React { .. }) {
            return;
        }
        let refuse = |rule: &str, why: String, fix: &str| Diagnostic::fallback(rule, why, loc, fix);
        let flag = props
            .iter()
            .rev()
            .find(|(k, _)| k == &poly.flag)
            .map(|(_, v)| v);
        let value = match flag {
            None => Some(false),
            Some(Expr::Raw(r)) | Some(Expr::Server(ServerExpr(r))) => match r.json_literal() {
                Some(serde_json::Value::Bool(b)) => Some(b),
                _ => None,
            },
            Some(_) => None,
        };
        let spreads_in = props.iter().any(|(k, _)| k == crate::ir::SPREAD_KEY);
        // F153c: absent (or a literal false) while this component's own props are spread in is the host element,
        // provided this component's call sites leave the flag out too.
        if spreads_in
            && value == Some(false)
            && !poly.negate
            && self.spread_carries(&poly.flag, props).is_ok()
        {
            let flag = poly.flag.clone();
            self.require_absent(name, &flag, props, loc);
            return;
        }
        let Some(value) = value.filter(|_| !spreads_in) else {
            self.diagnostics.push(refuse(
                "slot-dynamic",
                format!(
                    "`{}` of <{name}> is not a literal (or props are spread in), so brust cannot tell which element it renders",
                    poly.flag
                ),
                "write the prop as a literal (`asChild` or `asChild={false}`), or keep the page on React",
            ));
            return;
        };
        if value == poly.negate {
            return; // the host element
        }
        if !matches!(child.tier, Tier::Static) {
            self.diagnostics.push(refuse(
                "slot-native",
                format!(
                    "<{name}> has state of its own and is rendered with `{}`",
                    poly.flag
                ),
                "use `asChild` on a component without state, or keep the page on React",
            ));
            return;
        }
        if props
            .iter()
            .any(|(_, v)| matches!(v, Expr::ClientOnly { .. }))
        {
            self.diagnostics.push(refuse(
                "slot-handler",
                format!("a function is passed to <{name}> with `{}`", poly.flag),
                "put the handler on the child element after the component is static, or keep the page on React",
            ));
            return;
        }
        let [only] = children else {
            self.diagnostics.push(refuse(
                "slot-child-shape",
                format!(
                    "`{}` on <{name}> needs exactly one element between the tags, found {}",
                    poly.flag,
                    children.len()
                ),
                "wrap the content in one element such as <a>",
            ));
            return;
        };
        let Node::Element {
            tag: child_tag,
            attrs,
            poly: nested,
            ..
        } = only
        else {
            let (rule, what) = match only {
                Node::Component { .. } => ("slot-child-component", "a component"),
                _ => ("slot-child-shape", "text or an expression"),
            };
            self.diagnostics.push(refuse(
                rule,
                format!(
                    "`{}` on <{name}> has {what} as its child; only one host element is supported",
                    poly.flag
                ),
                "pass a host element such as <a href=\"…\">",
            ));
            return;
        };
        // A raw-text body (`<style>`, `<script>`) is printed as text, not as markup.
        if matches!(child_tag.as_str(), "style" | "script") {
            self.diagnostics.push(refuse(
                "slot-child-shape",
                format!(
                    "the child of <{name}> with `{}` is a <{child_tag}> element",
                    poly.flag
                ),
                "pass an element such as <a>, or keep the page on React",
            ));
            return;
        }
        // The component spreads keys known only at render and the child brings a class or style: the
        // merge needs both sides at compile time (valid React never becomes a build error).
        let brings_merge_key = attrs.iter().any(|a| match a {
            Attr::Static { name, .. } | Attr::Dynamic { name, .. } => {
                matches!(
                    name.to_ascii_lowercase().as_str(),
                    "class" | "classname" | "style"
                )
            }
            _ => false,
        });
        if child.poly_runtime_spread && brings_merge_key {
            self.diagnostics.push(refuse(
                "slot-merge",
                format!(
                    "<{name}> spreads an object of keys known only at render, and the child under `{}` has a class or style that would merge with it",
                    poly.flag
                ),
                "move the class or style to the component call, or keep the page on React",
            ));
            return;
        }
        let bad = attrs.iter().find_map(|a| match a {
            Attr::Static { .. } => None,
            Attr::Dynamic { value, .. } => self
                .reads_state(value)
                .then_some(("slot-child-attr", "an attribute that changes on the client")),
            Attr::Event { .. } => Some(("slot-handler", "an event handler")),
            Attr::Ref { .. } => Some(("slot-ref", "a ref")),
            Attr::Spread(_) | Attr::InnerHtml { .. } => {
                Some(("slot-child-shape", "a spread or dangerouslySetInnerHTML"))
            }
        });
        if let Some((rule, what)) =
            bad.or((*nested).then_some(("slot-child-shape", "a polymorphic element")))
        {
            self.diagnostics.push(refuse(
                rule,
                format!("the child of <{name}> with `{}` has {what}", poly.flag),
                "give the child plain attributes, or keep the page on React",
            ));
        }
    }

    /// `r` folded to JSON with this module's consts (`crate::ir::FoldEnv`, which runs no user code).
    fn fold_json(&self, r: &RawExpr) -> Option<serde_json::Value> {
        let consts = self.module_consts.clone();
        let lookup = move |n: &str| consts.get(n).cloned();
        crate::ir::FoldEnv::new(&lookup).fold(r).ok()?.to_json()
    }

    /// F149 (R34.88-R34.90): a static instance whose job inputs are all constant, of a child whose
    /// job the build may run, is a build-evaluation candidate; in the recompile, with every output
    /// evaluated, it is folded (`true`: its record is dropped and its slots print as literals).
    fn fold_instance(
        &mut self,
        name: &str,
        loc: u32,
        child: &Child,
        record: &InstanceRecord,
    ) -> bool {
        let Some(verdict) = &child.job_eval else {
            return false;
        };
        let constant = record.loops.is_empty()
            && record.rows_literal.is_none()
            && record.props.is_empty()
            && record
                .exprs
                .values()
                .all(|e| e == crate::lower::server_expr::UNDEFINED);
        if !constant {
            return false;
        }
        let stubs = match verdict {
            Ok(stubs) => stubs.clone(),
            Err(why) => {
                self.diagnostics.push(Diagnostic::info(
                    "build-eval-instance",
                    format!("<{name}> keeps its per-request job: {why}"),
                    loc,
                    "only constants and the packages cn, clsx, tailwind-merge and class-variance-authority run at build",
                ));
                return false;
            }
        };
        let key = format!("{}@{}", self.ctx.path, loc);
        let values: Option<std::collections::BTreeMap<String, serde_json::Value>> = child
            .job_outputs
            .iter()
            .map(|o| {
                let v = self.ctx.opts.slot_values.get(&format!("{key}#{o}"))?;
                Some((o.clone(), v.clone()))
            })
            .collect();
        if let Some(values) = values.filter(|v| !v.is_empty()) {
            self.folded_instances.push(crate::ir::FoldedInstance {
                child_id: record.child_id.clone(),
                k: record.k,
                values,
            });
            return true;
        }
        let (line, col) = crate::ir::line_col(self.ctx.text, loc);
        self.eval_instances.push(crate::ir::BuildEvalInstance {
            key,
            child_id: record.child_id.clone(),
            k: record.k,
            inputs: serde_json::Value::Object(
                record
                    .literals
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect(),
            ),
            outputs: child.job_outputs.clone(),
            stubs,
            line,
            col,
        });
        false
    }

    /// Shadcn S1 (R34.21): the JSX children of a React island as a JSON tree, so they travel in its
    /// props (the island and its SSR job revive them with React). Only a constant tree lowers; the
    /// `Err` names what stopped it (R34.23). Also returns the ids of the components inside the tree.
    /// Lists, constant conditions and element-valued props lower too (R34.50-R34.52): the constants
    /// are folded by [`crate::ir::FoldEnv`], which never runs user code.
    fn lower_children(
        &mut self,
        nodes: &[Node],
    ) -> Result<(serde_json::Value, Vec<String>), String> {
        let consts = self.module_consts.clone();
        let lookup = move |n: &str| consts.get(n).cloned();
        let mut env = crate::ir::FoldEnv::new(&lookup);
        let mut nested = Vec::new();
        let mut bytes = 0usize;
        let mut items = self.lower_nodes(nodes, &mut nested, &mut env, &mut bytes, 0)?;
        let tree = if items.len() == 1 {
            items.remove(0)
        } else {
            serde_json::Value::Array(items)
        };
        let size = tree.to_string().len();
        if size > MAX_CHILDREN_JSON {
            return Err(format!(
                "the lowered tree is {size} bytes, over the {MAX_CHILDREN_JSON} byte cap"
            ));
        }
        nested.sort();
        nested.dedup();
        Ok((tree, nested))
    }

    /// The ids inside a lowered tree the island `name` revives (`ChildRef.nested`).
    fn note_nested(&mut self, name: &str, nested: Vec<String>) {
        if let Some(r) = self.refs.iter_mut().find(|r| r.name == name) {
            let all = r.nested.get_or_insert_with(Vec::new);
            for id in nested {
                if !all.contains(&id) {
                    all.push(id);
                }
            }
        }
    }

    /// The expression as the folder reads it: a slot reads back as the expression it came from.
    fn raw_of(&self, e: &Expr) -> Option<RawExpr> {
        match e {
            Expr::Raw(r) | Expr::Server(ServerExpr(r)) => Some(r.clone()),
            Expr::Precomputed { slot, .. } => self.st.slots.get(slot).map(|s| s.raw.clone()),
            _ => None,
        }
    }

    fn fold_expr(
        &self,
        e: &Expr,
        env: &mut crate::ir::FoldEnv<'_>,
    ) -> Result<crate::ir::V, String> {
        match self.raw_of(e) {
            Some(r) => env.fold(&r),
            None if matches!(e, Expr::ClientOnly { .. }) => Err("a function".into()),
            None => Err("a value computed at request time".into()),
        }
    }

    fn lower_nodes(
        &mut self,
        nodes: &[Node],
        nested: &mut Vec<String>,
        env: &mut crate::ir::FoldEnv<'_>,
        bytes: &mut usize,
        lists: u32,
    ) -> Result<Vec<serde_json::Value>, String> {
        use crate::ir::V;
        use serde_json::{Map, Value, json};
        let mut out = Vec::new();
        for n in nodes {
            match n {
                Node::Text(t) => out.push(Value::String(t.clone())),
                Node::Slot(e) => match self.fold_expr(e, env) {
                    Ok(v @ (V::Str(_) | V::Num(_))) => match v.to_json() {
                        Some(j) => out.push(j),
                        None => return Err("a number that is not finite".into()),
                    },
                    Ok(V::Undef | V::Null | V::Bool(_)) => {}
                    Ok(_) => return Err("an array or object rendered as a child".into()),
                    Err(why) => {
                        return Err(format!("an expression that is not a constant ({why})"));
                    }
                },
                Node::Fragment(c) => out.push(
                    json!({ MARK: "fr", "c": self.lower_nodes(c, nested, env, bytes, lists)? }),
                ),
                Node::Element {
                    tag,
                    attrs,
                    children,
                    ..
                } => {
                    if !tag.starts_with(|c: char| c.is_ascii_alphabetic())
                        || !tag.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                    {
                        return Err(format!("`<{tag}>` is not a plain element name"));
                    }
                    let mut p = Map::new();
                    for a in attrs {
                        match a {
                            Attr::Static { name, value } if value.is_empty() => {
                                if !BOOLEAN_ATTRS.contains(&name.as_str()) {
                                    return Err(format!(
                                        "`{name}` is a bare or empty attribute (React reads it as `true` or \"\" by name)"
                                    ));
                                }
                                p.insert(name.clone(), Value::Bool(true));
                            }
                            Attr::Static { name, value } => {
                                p.insert(name.clone(), Value::String(value.clone()));
                            }
                            Attr::Dynamic { name, value } => match self.fold_expr(value, env) {
                                Ok(V::Null | V::Undef) => {}
                                Ok(v) => match v.to_json() {
                                    Some(j) => {
                                        p.insert(name.clone(), j);
                                    }
                                    None => {
                                        return Err(format!(
                                            "attribute `{name}` is not a constant (a value JSON cannot hold)"
                                        ));
                                    }
                                },
                                Err(why) => {
                                    return Err(format!(
                                        "attribute `{name}` is not a constant ({why})"
                                    ));
                                }
                            },
                            Attr::Event { event, .. } => {
                                return Err(format!("an event handler (`{event}`)"));
                            }
                            Attr::Ref { .. } => return Err("a ref".into()),
                            Attr::Spread(_) => return Err("a spread".into()),
                            Attr::InnerHtml { .. } => {
                                return Err("dangerouslySetInnerHTML".into());
                            }
                        }
                    }
                    out.push(
                        json!({ MARK: "el", "t": tag, "p": p, "c": self.lower_nodes(children, nested, env, bytes, lists)? }),
                    );
                }
                Node::Component {
                    loc,
                    name,
                    source,
                    imported,
                    member,
                    props,
                    children,
                    ..
                } => {
                    if name == "<member>" {
                        return Err("a member tag such as <A.B>".into());
                    }
                    let mut p = Map::new();
                    let mut slots: Vec<String> = Vec::new();
                    for (k, v) in props {
                        if k == crate::ir::SPREAD_KEY {
                            return Err(format!("a spread into <{name}>"));
                        }
                        if k.starts_with('$') {
                            return Err(format!(
                                "the prop `{k}` of <{name}> starts with `$`, which brust reserves"
                            ));
                        }
                        // An element as a prop (R34.52): lowered to a marker tree and named in `x`,
                        // the only list of props the revive turns back into elements.
                        if let Expr::Raw(RawExpr {
                            kind: RawKind::Jsx(el),
                            ..
                        }) = v
                        {
                            if !slot_prop_ok(k) {
                                return Err(format!(
                                    "an element passed as the prop `{k}` of <{name}>"
                                ));
                            }
                            let mut items = self.lower_nodes(
                                std::slice::from_ref(&**el),
                                nested,
                                env,
                                bytes,
                                lists,
                            )?;
                            let tree = if items.len() == 1 {
                                items.remove(0)
                            } else {
                                json!({ MARK: "fr", "c": items })
                            };
                            p.insert(k.clone(), tree);
                            slots.push(k.clone());
                            continue;
                        }
                        match self.fold_expr(v, env) {
                            Ok(V::Null | V::Undef) => {}
                            Ok(v) => match v.to_json() {
                                Some(j) => {
                                    p.insert(k.clone(), j);
                                }
                                None => {
                                    return Err(format!(
                                        "prop `{k}` of <{name}> is not a constant (a value JSON cannot hold)"
                                    ));
                                }
                            },
                            Err(why) => {
                                return Err(format!(
                                    "prop `{k}` of <{name}> is not a constant ({why})"
                                ));
                            }
                        }
                    }
                    let child = self.resolve_child(
                        name,
                        source.as_deref(),
                        imported.as_deref(),
                        member,
                        *loc,
                    );
                    let Some(id) = child.id.clone() else {
                        return Err(format!("<{name}> could not be resolved"));
                    };
                    if !self.refs.iter().any(|r| r.name == *name) {
                        self.refs.push(ChildRef {
                            name: name.clone(),
                            id: child.id.clone(),
                            path: child.path.clone(),
                            tier: child.tier.clone(),
                            nested: None,
                            x: Vec::new(),
                        });
                    }
                    nested.push(id.clone());
                    let mut node = json!({ MARK: "cmp", "id": id, "p": p, "c": self.lower_nodes(children, nested, env, bytes, lists)? });
                    if !slots.is_empty() {
                        node["x"] = json!(slots);
                    }
                    out.push(node);
                }
                Node::If { cond, then, else_ } => {
                    let c = self
                        .fold_expr(cond, env)
                        .map_err(|why| format!("a condition that is not a constant ({why})"))?;
                    let branch = if c.truthy() { then } else { else_ };
                    out.extend(self.lower_nodes(branch, nested, env, bytes, lists)?);
                }
                Node::For {
                    source,
                    item,
                    index,
                    key,
                    body,
                } => {
                    let src = self.fold_expr(source, env).map_err(|why| {
                        format!("a list over data that is not a constant ({why})")
                    })?;
                    let V::Arr(rows) = src else {
                        return Err("a list over a value that is not an array".into());
                    };
                    let count = rows.len();
                    for (i, row) in rows.into_iter().enumerate() {
                        env.bind(item, row);
                        let mut bound = 1;
                        if let Some(ix) = index {
                            env.bind(ix, V::Num(i as f64));
                            bound += 1;
                        }
                        let step = self
                            .fold_expr(key, env)
                            .map_err(|why| {
                                format!("the key of a list item is not a constant ({why})")
                            })
                            .and_then(|_| self.lower_nodes(body, nested, env, bytes, lists + 1));
                        env.unbind(bound);
                        let rows_out = step?;
                        if lists == 0 {
                            *bytes += rows_out.iter().map(|v| v.to_string().len()).sum::<usize>();
                            if *bytes > MAX_CHILDREN_JSON {
                                return Err(format!(
                                    "the list has {count} items and its lowered tree is over the {MAX_CHILDREN_JSON} byte cap"
                                ));
                            }
                        }
                        out.extend(rows_out);
                    }
                }
                Node::Outlet => return Err("<Outlet/>".into()),
            }
        }
        Ok(out)
    }

    /// A fed instance inside lists whose job inputs are the same in every row (F142, R34.42): no
    /// prop reads a loop binding, the child has no `useId` values (ids differ per row) and its
    /// jobs do not read `children`, and every list that is not a props path cannot change on the
    /// client (rows the client re-creates would get no job output). A precompute job is a function
    /// of its inputs (the job cache's contract: its key is the inputs), so one call feeds every row.
    fn row_invariant(&self, props: &[(String, Expr)], child: &Child) -> bool {
        if self.loop_sources.is_empty() || child.use_id || child.job_roots.contains("children") {
            return false;
        }
        let row_free = props.iter().all(|(_, v)| {
            !matches!(v, Expr::ClientOnly { .. }) && self.deps_of(v).loop_bindings.is_empty()
        });
        let lists_fixed =
            self.loop_sources
                .iter()
                .zip(&self.lists)
                .all(|(path, (paths, reactive))| {
                    path.is_some() || !(*reactive || (!paths.is_empty() && self.props_reactive))
                });
        row_free && lists_fixed
    }

    /// Event handlers the parent binds itself (shadcn S1.3, R34.18): an `on*` prop that lands in
    /// the spread of a static child, which spreads it onto elements only and reads it nowhere else,
    /// becomes a handler of the parent (`_hN`, [`crate::ir::Forwarded`]); the inline print binds it
    /// on the child's element, as if written there. The child stays static and unlinked.
    /// Returns the hoisted keys (plus the dropped invalid names: neither are props of the instance),
    /// and the handler keys that land in the spread but cannot be bound, with why (R34.19:
    /// `check_spread` refuses them).
    fn forward_handlers(
        &mut self,
        name: &str,
        loc: u32,
        props: &[(String, Expr)],
        child: &Child,
    ) -> (Vec<String>, Vec<(String, String)>) {
        // A spread of unknown keys replaces a handler only when it comes after the handler's last
        // occurrence (React: later wins); `{...props} onMouseDown={…}` keeps the handler (F153c, Label).
        let spread_after = |key: &str| {
            let last = props.iter().rposition(|(k, _)| k == key).unwrap_or(0);
            props[last..]
                .iter()
                .any(|(k, _)| k == crate::ir::SPREAD_KEY)
        };
        let mut want: Vec<String> = Vec::new();
        let mut unbound: Vec<(String, String)> = Vec::new();
        // Keys that are not attribute names (a quoted key of a literal spread, which Bun inlines
        // into the props): never an `x-on-*` attribute. Dropped with a warning, as React drops an
        // invalid attribute name and as the reader drops a hand-written one (review F1, R34.17).
        let mut dropped: Vec<String> = Vec::new();
        for (k, v) in props {
            if !is_handler_prop(k, v) || !child.spread.lands(k) {
                continue;
            }
            if !handler_key_ok(k) {
                if !dropped.contains(k) {
                    self.diagnostics.push(Diagnostic::warning(
                        "unsafe-attr",
                        format!("`{k}` reaches an element through the spread of <{name}> but is not a valid event attribute name; it is not bound"),
                        loc,
                        "pass attribute names only",
                    ));
                    dropped.push(k.clone());
                }
                continue;
            }
            let why = if k.ends_with("Capture") {
                Some("listens in the capture phase, which directives do not support".to_string())
            } else if !matches!(child.tier, Tier::Static) {
                Some(format!(
                    "<{name}> is not static (a handler can be bound only on a static child's element)"
                ))
            } else if spread_after(k) {
                Some(format!(
                    "props of unknown keys are also spread into <{name}> here, and may replace it"
                ))
            } else if child.onward.components.lands(k) {
                Some(format!("<{name}> passes it on to another component"))
            } else if child
                .onward
                .reads
                .as_ref()
                .is_none_or(|r| r.contains(k.as_str()))
            {
                Some(format!("<{name}> also reads it by name"))
            } else if !self.st.prop_raws.contains_key(&(loc, k.clone())) {
                Some("its value was not read".to_string())
            } else {
                None
            };
            match why {
                Some(w) => unbound.push((k.clone(), w)),
                // A key given twice is one handler: the last value (`prop_raws` keeps it).
                None if !want.contains(k) => want.push(k.clone()),
                None => {}
            }
        }
        if want.is_empty() {
            return (dropped, unbound);
        }
        // Bound on the child's element, so the instance must paint once: no link for the rest.
        let need = instance_needs_link(
            &child.tier,
            props
                .iter()
                .filter(|(k, _)| !want.contains(k) && !dropped.contains(k))
                .map(|(_, v)| (matches!(v, Expr::ClientOnly { .. }), self.deps_of(v))),
        );
        if need != LinkNeed::None {
            let why = match need {
                LinkNeed::RowOnly => format!(
                    "another prop of <{name}> reads the row, and the handler makes the client render the row"
                ),
                _ => format!("<{name}> is linked (another prop of it changes on the client)"),
            };
            unbound.extend(want.drain(..).map(|k| (k, why.clone())));
            return (dropped, unbound);
        }
        for k in &want {
            let body = self.st.prop_raws[&(loc, k.clone())].clone();
            let mut n = self.st.handler_names.len() + 1;
            while self.st.handler_names.contains(&format!("_h{n}")) {
                n += 1;
            }
            let hname = format!("_h{n}");
            self.st.handler_names.insert(hname.clone());
            self.handlers.push(crate::ir::HandlerDecl {
                name: hname,
                body,
                item_scoped: self.loop_scope.clone(),
                forwarded: Some(crate::ir::Forwarded {
                    loc,
                    key: k.clone(),
                }),
            });
        }
        want.extend(dropped);
        (want, unbound)
    }

    /// Fail closed (shadcn S1.2, R34.15): a spread is expanded into HTML only. A function or a
    /// value that changes on the client reaching an element through the child's spread would
    /// need a binding the child's chunk does not have, so the parent renders with React instead;
    /// likewise a spread passed to a React island or to a child the server feeds per instance.
    /// An event handler the parent binds itself (`hoisted`) is not refused; one that lands in the
    /// spread but cannot be bound (`unbound`, R34.19) is, with its own code.
    /// R34.78: a static or native child that tests `children` as a value cannot be inlined with children given.
    fn check_children_read(&mut self, name: &str, given: &[Node], child: &Child, loc: u32) {
        if child.reads_children_value && !given.is_empty() {
            self.diagnostics.push(Diagnostic::fallback(
                "children-read",
                format!("<{name}> reads `children` as a value, which an inlined instance with children cannot answer"),
                loc,
                "render `{children}` only, or keep the component interactive with React",
            ));
        }
    }

    fn check_spread(
        &mut self,
        name: &str,
        props: &[(String, Expr)],
        child: &Child,
        loc: u32,
        hoisted: &[String],
        unbound: &[(String, String)],
    ) {
        let spreads_in = props.iter().any(|(k, _)| k == crate::ir::SPREAD_KEY);
        let refuse = |why: String| {
            Diagnostic::fallback(
                "spread-props",
                why,
                loc,
                "pass these props explicitly, or keep the component that receives them interactive with React",
            )
        };
        if spreads_in && matches!(child.tier, Tier::React { .. }) {
            self.diagnostics.push(refuse(format!(
                "props are spread into the React island <{name}>"
            )));
            return;
        }
        if spreads_in && child.fed {
            self.diagnostics.push(refuse(format!(
                "props are spread into <{name}>, which the server feeds per instance (a job or useId)"
            )));
            return;
        }
        if child.icon_spread {
            // R34.77: the icon inside reads these keys itself (`size` sets width and height, `className`
            // merges with its own class): a runtime spread would print them as plain attributes instead.
            if spreads_in {
                self.diagnostics.push(refuse(format!(
                    "props of unknown keys are spread into <{name}>, which spreads them onto an icon that reads some of them itself"
                )));
                return;
            }
            if let Some((k, _)) = props
                .iter()
                .find(|(k, _)| icon_reads_itself(k) && child.spread.lands(k))
            {
                self.diagnostics.push(refuse(format!(
                    "the prop `{k}` of <{name}> reaches an icon through a spread, and the icon reads `{k}` itself"
                )));
                return;
            }
        }
        if let Some((k, why)) = unbound.first() {
            let rule = if k.ends_with("Capture") {
                "event-capture"
            } else {
                "spread-handler"
            };
            self.diagnostics.push(Diagnostic::fallback(
                rule,
                format!("the handler `{k}` reaches an element through the spread of <{name}>, but {why}"),
                loc,
                "pass the handler to an element the parent writes, or keep the component interactive with React",
            ));
            return;
        }
        for (k, v) in props {
            if hoisted.contains(k) {
                continue;
            }
            let live = matches!(v, Expr::ClientOnly { .. }) || self.reads_state(v);
            if !live {
                continue;
            }
            // Props spread in carry keys known only at render: a linked instance next to them could
            // repaint an attribute the spread set.
            if k == crate::ir::SPREAD_KEY || spreads_in || child.spread.lands(k) {
                let function = matches!(v, Expr::ClientOnly { .. });
                if function && crate::analyze::jsx::event_name(k).is_none() {
                    // R34.19: not an event, so no element binding can stand for it (a render prop).
                    self.diagnostics.push(Diagnostic::fallback(
                        "spread-function",
                        format!("prop `{k}` of <{name}> is a function that is not an event handler, and props reach <{name}> through a spread"),
                        loc,
                        "pass it as a named prop the child reads, or keep the component interactive with React",
                    ));
                    return;
                }
                let what = if function {
                    "a function"
                } else {
                    "a value that changes on the client"
                };
                self.diagnostics.push(refuse(format!(
                    "prop `{k}` of <{name}> is {what} and reaches an element through a spread, which brust expands into HTML only"
                )));
                return;
            }
        }
    }

    /// A plain props path of `e` (`item.price`), `[idx]` standing for the current row of
    /// the innermost list; `None` for anything else.
    fn prop_path(&self, e: &Expr) -> Option<String> {
        let r = match e {
            Expr::Raw(r) | Expr::Server(ServerExpr(r)) => r,
            _ => return None,
        };
        match plain_path(r, self.items.last().map(String::as_str))? {
            PlainPath::Props(p) => Some(p),
            PlainPath::Row(rest) => Some(format!(
                "{}[idx]{rest}",
                self.loop_sources.last()?.as_ref()?
            )),
        }
    }

    /// `e` as a jinja expression the server evaluates per instance (F105): a §6.2 value over
    /// the props (`__props`) and the innermost row (`__row`, `__idx`). `None` for anything
    /// else, and always for a value that reads state or a store (R3.2: the parent's job).
    fn instance_expr(&self, e: &Expr) -> Option<String> {
        let Expr::Server(se) = e else { return None };
        if self.deps_of(e).reactive() {
            return None;
        }
        let item = self.items.last().map(String::as_str);
        let index = self.indexes.last().cloned().flatten();
        if !server_subset(&se.0, item, index.as_deref()) {
            return None;
        }
        let names = |name: &str, kind: &IdentKind| match kind {
            IdentKind::LoopBinding if Some(name) == item => Some("__row".to_string()),
            IdentKind::LoopBinding if Some(name) == index.as_deref() => Some("__idx".to_string()),
            _ => None,
        };
        Some(crate::lower::server_expr::to_jinja(
            se,
            &crate::lower::server_expr::JinjaCtx {
                in_loop: None,
                props_prefix: Some("__props."),
                names: &names,
            },
        ))
    }

    /// The path of a `For` source relative to props, when it is a plain path of the
    /// props or of the enclosing row.
    fn list_path(&self, source: &Expr) -> Option<String> {
        let r = match source {
            Expr::Raw(r) | Expr::Server(ServerExpr(r)) => r,
            _ => return None,
        };
        let outer = self.items.last().map(String::as_str);
        match plain_path(r, outer)? {
            PlainPath::Props(p) => Some(p),
            PlainPath::Row(rest) => Some(format!(
                "{}[idx]{rest}",
                self.loop_sources.last()?.as_ref()?
            )),
        }
    }

    /// The parent chunk's expression for one linked prop.
    fn link_prop(&self, v: &Expr) -> Expr {
        match v {
            Expr::Server(ServerExpr(r)) => Expr::Server(ServerExpr(r.clone())),
            Expr::Precomputed { slot, js, .. } => Expr::ClientOnly {
                js: self
                    .st
                    .slots
                    .get(slot)
                    .map(|i| i.raw.to_js_in(JsCtx::Client))
                    .unwrap_or_else(|| js.clone()),
            },
            Expr::ClientOnly { js } => Expr::ClientOnly { js: js.clone() },
            Expr::Raw(r) => Expr::ClientOnly {
                js: r.to_js_in(JsCtx::Client),
            },
        }
    }
}

/// A forwarded handler's key prints as `x-on-<event>`: it must be an attribute name whose event is
/// plain `[a-z0-9]+` (no quote, space, `=` or `>` can reach the tag).
pub(crate) fn handler_key_ok(k: &str) -> bool {
    brust_jinja::spread::attr_name_ok(k)
        && crate::analyze::jsx::event_name(k).is_some_and(|e| {
            !e.is_empty()
                && e.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

/// An `on*` prop whose value can be a function (anything but a literal): bound as an event
/// handler where it lands on an element. A literal is dropped from the HTML, as React does.
fn is_handler_prop(k: &str, v: &Expr) -> bool {
    if crate::analyze::jsx::event_name(k).is_none() {
        return false;
    }
    match v {
        Expr::Raw(r) | Expr::Server(ServerExpr(r)) => r.json_literal().is_none(),
        Expr::Precomputed { .. } | Expr::ClientOnly { .. } => true,
    }
}

/// Why a native/static child instance gets a runtime link (`x-props-bind`, spec §7.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkNeed {
    /// Every prop is a constant or a plain prop path: the instance paints once, no link.
    None,
    /// A prop is a function or reads state, or the child has a behaviour of its own and
    /// reads the row: linked wherever it sits.
    Always,
    /// A static child reads only the row's loop bindings: linked only inside a row the
    /// client can re-create, plain HTML everywhere else (ledger F70).
    RowOnly,
}

/// The link decision for one `<Child …/>` from the child's tier and what each prop reads
/// (`function` = the prop is `Expr::ClientOnly`).
pub fn instance_needs_link(tier: &Tier, props: impl IntoIterator<Item = (bool, Deps)>) -> LinkNeed {
    let mut loop_only = false;
    for (function, d) in props {
        if function || d.reactive() {
            return LinkNeed::Always;
        }
        loop_only |= !d.loop_bindings.is_empty();
    }
    match (loop_only, tier) {
        (false, _) => LinkNeed::None,
        (true, Tier::Static) => LinkNeed::RowOnly,
        (true, _) => LinkNeed::Always,
    }
}

/// Whether the server can evaluate `r` for a child instance: literals, props, the innermost
/// row's item and index, and the operators and calls the jinja printer maps one to one.
fn server_subset(r: &RawExpr, item: Option<&str>, index: Option<&str>) -> bool {
    let sub = |e: &RawExpr| server_subset(e, item, index);
    match &r.kind {
        RawKind::Lit(_) => true,
        RawKind::Ident { name, kind } => match kind {
            // The whole props object (`*`) would hand the child the server's own context keys.
            IdentKind::Prop => name != "*",
            IdentKind::LoopBinding => Some(name.as_str()) == item || Some(name.as_str()) == index,
            _ => false,
        },
        RawKind::Member { target, .. } => {
            let whole_props = matches!(&target.kind, RawKind::Ident { name, kind: IdentKind::Prop } if name == "*");
            whole_props || sub(target)
        }
        RawKind::Index { target, index: i } => sub(target) && sub(i),
        RawKind::Unary { op, value } => *op != UnOp::Typeof && sub(value),
        RawKind::Binary { left, right, .. } => sub(left) && sub(right),
        RawKind::Cond { test, yes, no } => sub(test) && sub(yes) && sub(no),
        RawKind::Template { parts, .. } => parts.iter().all(|(p, _)| sub(p)),
        RawKind::Array(items) => items.iter().all(sub),
        RawKind::Object(props) => props.iter().all(|(_, v)| sub(v)),
        RawKind::Call { callee, args } => {
            let RawKind::Member { target, name, .. } = &callee.kind else {
                return false;
            };
            let global = match &target.kind {
                RawKind::Ident {
                    name: obj,
                    kind: IdentKind::Global,
                } => Some(obj.as_str()),
                _ => None,
            };
            let known = match global {
                Some(obj) => {
                    matches!((obj, name.as_str()), ("Object", "keys" | "entries"))
                        && args.len() == 1
                }
                None => {
                    sub(target)
                        && matches!(
                            name.as_str(),
                            "toUpperCase"
                                | "toLowerCase"
                                | "trim"
                                | "slice"
                                | "startsWith"
                                | "endsWith"
                                | "includes"
                                | "join"
                        )
                }
            };
            known && args.iter().all(sub)
        }
        RawKind::Arrow { .. } | RawKind::Jsx(_) | RawKind::Opaque { .. } => false,
    }
}

/// A value read as a path: from the props, or from the innermost row's item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum PlainPath {
    Props(String),
    /// `""` for the item itself, `.title` for a member of it.
    Row(String),
}

pub(super) fn plain_path(r: &RawExpr, item: Option<&str>) -> Option<PlainPath> {
    match &r.kind {
        RawKind::Ident {
            name,
            kind: IdentKind::Prop,
        } if name != "*" => Some(PlainPath::Props(name.clone())),
        RawKind::Ident {
            name,
            kind: IdentKind::LoopBinding,
        } if Some(name.as_str()) == item => Some(PlainPath::Row(String::new())),
        RawKind::Member {
            target,
            name,
            optional: false,
        } => match plain_path(target, item)? {
            PlainPath::Props(p) => Some(PlainPath::Props(format!("{p}.{name}"))),
            PlainPath::Row(rest) => Some(PlainPath::Row(format!("{rest}.{name}"))),
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(state: &[&str], loops: &[&str]) -> Deps {
        let mut d = Deps::default();
        d.state.extend(state.iter().map(|s| s.to_string()));
        d.loop_bindings.extend(loops.iter().map(|s| s.to_string()));
        d
    }

    #[test]
    fn link_decisions() {
        let s = Tier::Static;
        let n = Tier::Native;
        for (tier, props, want) in [
            (&s, vec![], LinkNeed::None),
            (&s, vec![(false, d(&[], &[]))], LinkNeed::None),
            (&s, vec![(false, d(&[], &["b"]))], LinkNeed::RowOnly),
            (
                &s,
                vec![(false, d(&[], &["b"])), (false, d(&["q"], &[]))],
                LinkNeed::Always,
            ),
            (&s, vec![(true, d(&[], &[]))], LinkNeed::Always),
            (
                &s,
                vec![(false, d(&["selected"], &["t"]))],
                LinkNeed::Always,
            ),
            (&n, vec![(false, d(&[], &["it"]))], LinkNeed::Always),
            (&n, vec![(false, d(&[], &[]))], LinkNeed::None),
            (
                &Tier::Pending,
                vec![(false, d(&[], &["x"]))],
                LinkNeed::Always,
            ),
        ] {
            assert_eq!(
                instance_needs_link(tier, props.clone()),
                want,
                "{tier:?} {props:?}"
            );
        }
    }
}
