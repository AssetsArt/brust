//! Child components (spec §3.2 rule 4, §3.4, §7.4): resolve and compile each
//! `<Child/>`, record its tier, link reactive props into native children
//! (`ChildLink`, `_pN`), and turn `react` children into islands rendered by an
//! `Ssr` job — refusing props an island cannot hydrate from.
use super::deps::{Deps, minimal_paths};
use super::{PassCtx, PassState, run_passes};
use crate::analyze::component::finish_diagnostics;
use crate::analyze::exports::{declared_in, package_member};
use crate::analyze::modules::{Entry, Export, Lookup, cache_key, compile, resolve};
use crate::ir::{
    Attr, ChildLink, ChildRef, ComponentIR, Diagnostic, Expr, ExternalRef, IdentKind,
    InstanceRecord, JobDecl, JobKind, JsCtx, Node, PolyTag, RawExpr, RawKind, ServerExpr, Tier,
    UnOp, component_id, named_component_id,
};
use std::collections::{BTreeSet, HashMap};
use std::rc::Rc;

pub fn children(ir: &mut ComponentIR, st: &mut PassState, ctx: &PassCtx<'_>) {
    let mut w = Walker {
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
        instance_counts: HashMap::new(),
        instances: Vec::new(),
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
    };
    let mut template = std::mem::replace(&mut ir.template, Node::Fragment(vec![]));
    w.node(&mut template);
    w.resolve_row_only(std::slice::from_mut(&mut template), false);
    debug_assert!(
        w.row_only.is_empty(),
        "every RowOnly link is visited by resolve_row_only"
    );
    ir.template = template;
    ir.child_links.extend(w.links);
    ir.instances.extend(w.instances);
    ir.children.extend(w.refs);
    ir.jobs.extend(w.jobs);
    ir.diagnostics.extend(w.diagnostics);
    ir.handlers.extend(w.handlers);
}

struct Walker<'s, 'c> {
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
    instance_counts: HashMap<String, u32>,
    instances: Vec<InstanceRecord>,
    ssr_outputs: HashMap<String, u32>,
    /// `RowOnly` links by id with the client reads they imply, resolved after the walk.
    /// With the child's name and location when it derives values from its props on the server (F96d).
    row_only: HashMap<u32, RowOnlyLink>,
    /// Whether this component's own props can change after first paint (see `children`).
    props_reactive: bool,
    /// Handlers hoisted from props a static child spreads onto an element (shadcn S1.3).
    handlers: Vec<crate::ir::HandlerDecl>,
}

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
    /// The compiled child has `useId` values (the server seeds them per instance, per row).
    use_id: bool,
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

/// Shadcn S1 (R34.23): the most JSON one island instance's lowered children may take.
const MAX_CHILDREN_JSON: usize = 64 * 1024;

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
                self.loop_sources.push(list_path);
                self.lists.push(src);
                self.list_uses.push(use_);
                self.items.push(item.clone());
                self.indexes.push(index.clone());
                body.iter_mut().for_each(|c| self.node(c));
                self.indexes.pop();
                self.items.pop();
                self.loop_sources.pop();
                self.list_uses.pop();
                self.lists.pop();
                self.loop_scope.truncate(n);
            }
            Node::Component { .. } => self.component(n),
            Node::Text(_) | Node::Slot(_) | Node::Outlet => {}
        }
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
            format!("<{name}> comes from the package {source}{at}; it renders as a React island"),
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
            use_id: false,
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
                    use_id: false,
                };
            }
            // A package export (a member of one included): the island is the export itself.
            return self.external_child(name, source, imported.unwrap_or("default"), member, loc);
        };
        let export = match imported {
            None | Some("default") => Export::Default,
            Some(n) => Export::Named(n.to_string()),
        };
        // The component is the one the export is declared by, however many barrels it crosses (R34.11).
        let (path, export) = declared_in(&path, &export, ctx.opts);
        // `export { Root }` after `const Root = DialogPrimitive.Root`: the component is the package member.
        if let Some(m) = package_member(&path, &export, ctx.opts) {
            return self.external_child(name, &m.source, &m.imported, &m.member, loc);
        }
        let id = match &export {
            Export::Default => component_id(&path),
            Export::Named(n) => named_component_id(&path, n),
        };
        let lookup = compile(&path, &export, None, ctx.opts, ctx.modules);
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
                        use_id: false,
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
        let tier = match lookup {
            Lookup::Compiled(ir) => {
                forwards_ref = ir.forwards_ref;
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
            use_id,
        }
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
        // R34.64: a `ref` at the call site of a `forwardRef` component reaches an element React attaches it to; a
        // static or native render has none to give it.
        if child.forwards_ref && props.iter().any(|(k, _)| k == "ref") {
            self.diagnostics.push(Diagnostic::fallback(
                "forwardref-ref",
                format!("`ref` is passed to the forwardRef component <{name}>; brust renders it without a ref"),
                *loc,
                "drop the ref, or keep this component in React",
            ));
        }
        let (hoisted, unbound) = self.forward_handlers(name, *loc, props, &child);
        self.check_spread(name, props, &child, *loc, &hoisted, &unbound);
        // A hoisted handler is the parent's own member: not a prop of the instance.
        let kept: Vec<(String, Expr)> = props
            .iter()
            .filter(|(k, _)| !hoisted.contains(k))
            .cloned()
            .collect();
        self.check_poly(name, props, children, &child, *loc);
        if !self.refs.iter().any(|r| r.name == *name) {
            self.refs.push(ChildRef {
                name: name.clone(),
                id: child.id.clone(),
                path: child.path.clone(),
                tier: child.tier.clone(),
                nested: None,
            });
        }
        let child_id = child.id.clone().unwrap_or_else(|| name.clone());
        match &child.tier {
            Tier::React { client_only, .. } => {
                let mut inputs = Vec::new();
                let mut prop_map = std::collections::BTreeMap::new();
                let mut literals = std::collections::BTreeMap::new();
                let mut ok = true;
                for (k, v) in props.iter() {
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
                if !children.is_empty() {
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
                // The template backend numbers every inlined instance of a child id.
                let k = self.instance_counts.entry(child_id.clone()).or_insert(0);
                *k += 1;
                let k = *k;
                let row_invariant = child.fed && self.row_invariant(&kept, &child);
                if child.fed && !row_invariant && self.loop_sources.iter().any(Option::is_none) {
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
                    };
                    for (name, v) in kept.iter() {
                        if matches!(v, Expr::ClientOnly { .. }) {
                            continue;
                        }
                        let lit = match v {
                            Expr::Raw(r) | Expr::Server(ServerExpr(r)) => r.json_literal(),
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
                    self.instances.push(record);
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

    /// Shadcn S1 (R34.21): the JSX children of a React island as a JSON tree, so they travel in its
    /// props (the island and its SSR job revive them with React). Only a constant tree lowers; the
    /// `Err` names what stopped it (R34.23). Also returns the ids of the components inside the tree.
    fn lower_children(
        &mut self,
        nodes: &[Node],
    ) -> Result<(serde_json::Value, Vec<String>), String> {
        let mut nested = Vec::new();
        let mut items = self.lower_nodes(nodes, &mut nested)?;
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

    fn lower_nodes(
        &mut self,
        nodes: &[Node],
        nested: &mut Vec<String>,
    ) -> Result<Vec<serde_json::Value>, String> {
        use serde_json::{Map, Value, json};
        let constant = |e: &Expr| match e {
            Expr::Raw(r) | Expr::Server(ServerExpr(r)) => r.json_literal(),
            _ => None,
        };
        let mut out = Vec::new();
        for n in nodes {
            match n {
                Node::Text(t) => out.push(Value::String(t.clone())),
                Node::Slot(e) => match constant(e) {
                    Some(v @ (Value::String(_) | Value::Number(_))) => out.push(v),
                    Some(Value::Null | Value::Bool(_)) => {}
                    _ => return Err("an expression that is not a constant".into()),
                },
                Node::Fragment(c) => {
                    out.push(json!({ MARK: "fr", "c": self.lower_nodes(c, nested)? }))
                }
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
                            Attr::Dynamic { name, value } => match constant(value) {
                                Some(Value::Null) => {}
                                Some(v) => {
                                    p.insert(name.clone(), v);
                                }
                                None => {
                                    return Err(format!("attribute `{name}` is not a constant"));
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
                        json!({ MARK: "el", "t": tag, "p": p, "c": self.lower_nodes(children, nested)? }),
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
                    for (k, v) in props {
                        if k == crate::ir::SPREAD_KEY {
                            return Err(format!("a spread into <{name}>"));
                        }
                        match constant(v) {
                            Some(Value::Null) => {}
                            Some(v) => {
                                p.insert(k.clone(), v);
                            }
                            None => {
                                return Err(format!("prop `{k}` of <{name}> is not a constant"));
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
                        });
                    }
                    nested.push(id.clone());
                    out.push(
                        json!({ MARK: "cmp", "id": id, "p": p, "c": self.lower_nodes(children, nested)? }),
                    );
                }
                Node::If { .. } => return Err("a condition".into()),
                Node::For { .. } => return Err("a list".into()),
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
        let spreads_in = props.iter().any(|(k, _)| k == crate::ir::SPREAD_KEY);
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
            } else if spreads_in {
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
