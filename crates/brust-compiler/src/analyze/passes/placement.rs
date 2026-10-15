//! Placement (spec §4.2(b), §5.1, §6.4): every first-paint value becomes
//! `Server` (template subset), `Precomputed` (a slot of the precompute job) or
//! stays `Raw` when render reads a browser global (the tier pass makes it a
//! client-only island); values used only after first paint become `ClientOnly`.
//!
//! Slots are numbered `_s1…` in template document order, then state inits,
//! then derived values in declaration order. A derived value read by a painted
//! value is placed itself (`Server` or a slot) and the reader stays `Server`
//! when it is otherwise in the subset: the template binds the derived name.
use super::PassState;
use super::deps::{Deps, minimal_paths};
use super::server_expr::try_server;
use crate::analyze::const_fold::{Folder, imported_const, map_idents, map_pre};
use crate::ir::{
    Attr, ComponentIR, Diagnostic, Expr, IdentKind, JobDecl, JobKind, Node, RawExpr, RawKind,
};
use std::collections::{BTreeSet, HashMap};

/// How a derived local is placed once something painted reads it.
#[derive(Debug, Clone, PartialEq)]
enum Place {
    Server,
    Slot,
    /// Not a first-paint value: a function, or reads a browser global.
    Code,
}

/// One painted value's facts, kept for the captures and tier passes.
#[derive(Debug, Clone)]
pub struct Painted {
    pub loc: u32,
    pub deps: Deps,
}

/// A precomputed slot's source and deps.
#[derive(Debug, Clone)]
pub struct SlotInfo {
    pub raw: RawExpr,
    /// Loop bindings in scope where the slot sits.
    pub scope: Vec<String>,
    pub deps: Deps,
    pub state_dependent: bool,
}

/// One enclosing `For`.
struct List {
    item: String,
    /// Prop and store paths the source reads.
    paths: Vec<String>,
    /// The source reads state or a store, so the list changes on the client.
    stateful: bool,
    /// F173 (Mellow F2): the source as written and the index binding: an item is an accepted method receiver only when
    /// its list is (`Placer::receiver_problem`), an index always is (a number).
    source: Option<RawExpr>,
    index: Option<String>,
}

/// `why` of an `Opaque` the reader made from a function.
const FUNCTION_WHYS: &[&str] = &[
    "async arrow",
    "arrow parameter pattern",
    "function parameter pattern",
    "EFunction",
    "contains-jsx",
];

/// L20: a CSS Module import's source and class map.
type CssImport = (String, HashMap<String, String>);

struct Placer<'s> {
    st: &'s mut PassState,
    derived_raw: HashMap<String, RawExpr>,
    /// Module `const`s whose value folds into the template (G5/G9/G10), fully substituted.
    consts: HashMap<String, RawExpr>,
    /// Relatively imported consts the template or a state initializer reads, folded (by local name).
    imported_vals: HashMap<String, RawExpr>,
    /// L20: `*.module.css` default imports the template reads, by local name: the import source and its class map.
    css: HashMap<String, CssImport>,
    /// L20: classes a template names that the module does not define (build errors, deduplicated on append).
    css_errors: std::cell::RefCell<Vec<Diagnostic>>,
    places: HashMap<String, Place>,
    visiting: Vec<String>,
    next_slot: u32,
    /// The enclosing `For`s, outermost first.
    lists: Vec<List>,
    /// Bumped by anything in the template the client re-evaluates (a value
    /// that reads state, an event, a function prop): a `For` whose body bumps
    /// it is rebuilt by the client, so its source is client-read.
    reactive: u32,
    /// Body locals that are not values the template can bind: refs (`name`, rule).
    unplaceable: HashMap<String, &'static str>,
    /// `useId()` bindings: server-seeded values (`_idN`, S7 step 6). Template-only:
    /// a job cannot read them, so a non-template expression reading one falls back.
    ids: BTreeSet<String>,
    /// Prop and store paths read by the conditions of the enclosing `If`s (F33): a slot under
    /// a guard varies with the guard's value, so the job key must include it.
    guards: Vec<BTreeSet<String>>,
    flagged: BTreeSet<&'static str>,
    loop_scope: Vec<String>,
    diagnostics: Vec<Diagnostic>,
    jsx_flagged: bool,
    /// > 0 while walking the children passed to a component: a child read there is judged by `child_read_problem`.
    component_children: u32,
    /// > 0 under a lowered Provider frame (or in a Provider component's own template): judged by the allowlist.
    provider_children: u32,
    /// F173: set while placing a `{child}` slot (content the template prints as text or markup). Under a plain wrapper
    /// only those are judged: an element read there prints nothing, while an attribute or a component prop prints it the
    /// way React does (`String(value)`) or hands it to the child, as on main.
    slot_content: bool,
    /// F199: set while placing the value of a prop passed to a component: the child may print it as content.
    component_prop: bool,
    /// F198 + F199: the component already falls back to React (a rule before placement made it so): its template is never
    /// printed by the server, so `element_problem` is not asked (it would only repeat the fallback).
    react_already: bool,
    /// Set while placing a frame value the compiler itself injected (`__ctx_*` hidden props): its expression comes from
    /// the Provider's own value fields, already judged by `provider_problem`.
    frame_value: bool,
    /// Locations of `list-shape` fallbacks: the reader already named the construct there.
    list_shape_locs: BTreeSet<u32>,
    /// L2: module path, source text, module declarations and build-computed slot values.
    path: String,
    text: &'s [u8],
    module_decls: Vec<crate::ir::ModuleDecl>,
    /// F174: module functions proven to return a primitive (`ir.plain_fns`).
    plain_fns: Vec<String>,
    /// F199: module functions and consts proven unable to hand out an element (`ir.element_free_fns`).
    element_free_fns: Vec<String>,
    /// F199: each handler's body (`ir.handlers`), judged by `element_problem` when a value reads the handler.
    handler_bodies: HashMap<String, RawExpr>,
    /// F173 (Mellow F3): each state's initial value as written; a state is a method receiver only when it starts primitive.
    state_inits: HashMap<String, RawExpr>,
    /// F174: the verdict on each derived value / module const already judged (a chain of derived values is deep and shared).
    read_memo: std::cell::RefCell<std::collections::HashMap<String, Option<String>>>,
    slot_values: &'s std::collections::HashMap<String, serde_json::Value>,
    opts: &'s crate::analyze::component::AnalyzeOptions,
}

pub fn place(ir: &mut ComponentIR, st: &mut PassState, ctx: &super::PassCtx<'_>) {
    let derived_raw: HashMap<String, RawExpr> = ir
        .derived
        .iter()
        .filter_map(|d| match &d.expr {
            Expr::Raw(r) => Some((d.name.clone(), r.clone())),
            _ => None,
        })
        .collect();
    let handler_names = st.handler_names.clone();
    let imports: std::cell::RefCell<HashMap<(String, String), Option<RawExpr>>> =
        Default::default();
    let imported = |source: &str, name: &str| {
        imports
            .borrow_mut()
            .entry((source.to_string(), name.to_string()))
            .or_insert_with(|| imported_const(ctx.path, source, name, ctx.opts, 0))
            .clone()
    };
    let shadowed = |n: &str| {
        derived_raw.contains_key(n)
            || ir.id_bindings.iter().any(|i| i == n)
            || ir.refs.iter().any(|r| r.name == n)
            || handler_names.contains(n)
    };
    let consts = Folder::new(&ir.module_decls, &shadowed, &imported).all();
    // Import bindings read straight from the template or a state initializer fold too.
    let imported_vals: std::cell::RefCell<HashMap<String, RawExpr>> = Default::default();
    let note = |e: &RawExpr| {
        let _ = map_idents(e, &|id| {
            if let RawKind::Ident {
                name,
                kind:
                    IdentKind::Import {
                        source,
                        imported: imp,
                    },
            } = &id.kind
                && !shadowed(name)
                && let Some(v) = imported(source, imp)
                && crate::analyze::const_fold::FOLD_MAX_JINJA
                    >= crate::lower::server_expr::to_jinja(
                        &crate::ir::ServerExpr(v.clone()),
                        &crate::lower::server_expr::JinjaCtx::plain(),
                    )
                    .len()
            {
                imported_vals.borrow_mut().insert(name.clone(), v);
            }
            None
        });
    };
    collect_raw(&ir.template, &mut |e| note(e));
    ir.state.iter().for_each(|s| {
        if let Expr::Raw(r) = &s.init {
            note(r)
        }
    });
    derived_raw.values().for_each(note);
    let imported_vals = imported_vals.into_inner();
    // L20: CSS Module imports whose class map the build handed over; `styles.x` folds to the literal class.
    let css: std::cell::RefCell<HashMap<String, CssImport>> = Default::default();
    if !ctx.opts.css_modules.is_empty() {
        let find = |e: &RawExpr| {
            let _ = map_idents(e, &|id| {
                if let RawKind::Ident {
                    name,
                    kind:
                        IdentKind::Import {
                            source,
                            imported: imp,
                        },
                } = &id.kind
                    && imp == "default"
                    && source.ends_with(".module.css")
                    && !shadowed(name)
                    && let Some(key) = crate::analyze::modules::css_module_key(ctx.path, source)
                    && let Some(map) = ctx.opts.css_modules.get(&key)
                {
                    css.borrow_mut()
                        .insert(name.clone(), (source.clone(), map.clone()));
                }
                None
            });
        };
        collect_raw(&ir.template, &mut |e| find(e));
        ir.state.iter().for_each(|s| {
            if let Expr::Raw(r) = &s.init {
                find(r)
            }
        });
        derived_raw.values().for_each(find);
    }
    let css = css.into_inner();
    let mut p = Placer {
        st,
        derived_raw,
        consts,
        imported_vals,
        css,
        css_errors: Default::default(),
        places: HashMap::new(),
        visiting: Vec::new(),
        next_slot: 0,
        lists: Vec::new(),
        reactive: 0,
        unplaceable: ir
            .refs
            .iter()
            .map(|r| (r.name.clone(), "ref-in-render"))
            .collect(),
        ids: ir.id_bindings.iter().cloned().collect(),
        guards: Vec::new(),
        flagged: BTreeSet::new(),
        loop_scope: Vec::new(),
        diagnostics: Vec::new(),
        jsx_flagged: false,
        // A Provider component's OWN template is printed as its children's content too (the Provider tag lowers to a
        // Fragment), so every Slot of it is judged like a child passed to a component.
        component_children: 0,
        // A Provider component's OWN template is printed under its own Provider element (the tag lowers to a Fragment),
        // so every Slot of it is judged by the allowlist too.
        provider_children: u32::from(!ir.provides.is_empty()),
        frame_value: false,
        slot_content: false,
        component_prop: false,
        react_already: ir.diagnostics.iter().any(|d| {
            d.class == crate::ir::DiagClass::Fallback
                && !super::tier::CHILD_ONLY.contains(&d.rule.as_str())
        }),
        list_shape_locs: ir
            .diagnostics
            .iter()
            .filter(|d| d.rule == "list-shape")
            .map(|d| d.loc)
            .collect(),
        path: ctx.path.to_string(),
        text: ctx.text,
        module_decls: ir.module_decls.clone(),
        plain_fns: ir.plain_fns.clone(),
        element_free_fns: ir.element_free_fns.clone(),
        handler_bodies: ir
            .handlers
            .iter()
            .map(|h| (h.name.clone(), h.body.clone()))
            .collect(),
        state_inits: ir
            .state
            .iter()
            .filter_map(|s| match &s.init {
                Expr::Raw(r) => Some((s.name.clone(), r.clone())),
                _ => None,
            })
            .collect(),
        read_memo: Default::default(),
        slot_values: &ctx.opts.slot_values,
        opts: ctx.opts,
    };
    let mut template = std::mem::replace(&mut ir.template, Node::Fragment(vec![]));
    p.node(&mut template);
    ir.template = template;

    for s in &mut ir.state {
        if let Expr::Raw(r) = &s.init {
            let r = lazy_init(&p, r, &ir.module_decls);
            s.init = p.painted(&r);
        }
    }
    for d in &mut ir.derived {
        let Expr::Raw(r) = &d.expr else { continue };
        let r = r.clone();
        d.expr = match p.places.get(&d.name) {
            Some(Place::Server) => Expr::Server(crate::ir::ServerExpr(p.fold(&r))),
            Some(Place::Slot) => p.slot(&r),
            Some(Place::Code) if p.st.cx.deps(&r, &[]).browser => Expr::Raw(r),
            _ => Expr::ClientOnly {
                js: r.to_js_in(crate::ir::JsCtx::Client),
            },
        };
    }
    for r in &mut ir.refs {
        if let Expr::Raw(raw) = &r.init {
            r.init = Expr::ClientOnly {
                js: raw.to_js_in(crate::ir::JsCtx::Client),
            };
        }
    }
    ir.diagnostics.append(&mut p.diagnostics);
    ir.build_eval = std::mem::take(&mut p.st.build_eval);
    for d in p.css_errors.take() {
        if !ir
            .diagnostics
            .iter()
            .any(|x| x.rule == d.rule && x.loc == d.loc && x.message == d.message)
        {
            ir.diagnostics.push(d);
        }
    }

    // One precompute job over every slot.
    let mut outputs = Vec::new();
    let mut inputs = Vec::new();
    let mut seeds_needed = false;
    collect_slots(ir, &mut |slot, ins, state_dependent| {
        outputs.push(slot.to_string());
        inputs.extend(ins.iter().cloned());
        seeds_needed |= state_dependent;
    });
    if seeds_needed {
        // The job evaluates state-dependent slots with the seeds: it reads
        // whatever the state initializers read.
        for s in &ir.state {
            let d = p.st.cx.deps_expr(&s.init, &[]);
            inputs.extend(d.props);
            inputs.extend(d.stores);
            if let Expr::Precomputed { inputs: i, .. } = &s.init {
                inputs.extend(i.iter().cloned());
            }
        }
    }
    if !outputs.is_empty() {
        outputs.sort_by_key(|s| s[2..].parse::<u32>().unwrap_or(0));
        ir.jobs.push(JobDecl {
            kind: JobKind::Precompute,
            inputs: minimal_paths(inputs),
            outputs,
            per_item: None,
            props: None,
            literals: Default::default(),
        });
    }
}

/// `useState(init)` seeds with `init()` when `init` is a function (React's
/// lazy initializer): a param-less expression arrow is its body; any other
/// function (including a module-level `function` declaration) is called (`(…)()`), so the job and the chunk compute the value.
fn lazy_init(p: &Placer<'_>, r: &RawExpr, module_decls: &[crate::ir::ModuleDecl]) -> RawExpr {
    if let RawKind::Arrow {
        params,
        body: crate::ir::ArrowBody::Expr(body),
        ..
    } = &r.kind
        && params.is_empty()
    {
        return (**body).clone();
    }
    // F26: a module-level `function load() {…}` named as the initializer.
    let module_fn = matches!(&r.kind, RawKind::Ident { name, kind: IdentKind::Local }
    if module_decls.iter().any(|d| {
        d.names == [name.as_str()]
            && (d.source.starts_with("function ") || d.source.starts_with("async function "))
    }));
    if module_fn || p.is_function(r, 0) {
        return RawExpr {
            loc: r.loc,
            kind: RawKind::Call {
                callee: Box::new(r.clone()),
                args: vec![],
            },
        };
    }
    r.clone()
}

/// Every `Precomputed` in the IR: (slot, inputs, state_dependent).
pub(super) fn collect_slots(ir: &ComponentIR, f: &mut impl FnMut(&str, &[String], bool)) {
    fn expr(e: &Expr, f: &mut impl FnMut(&str, &[String], bool)) {
        if let Expr::Precomputed {
            slot,
            inputs,
            state_dependent,
            ..
        } = e
        {
            f(slot, inputs, *state_dependent);
        }
    }
    fn node(n: &Node, f: &mut impl FnMut(&str, &[String], bool)) {
        match n {
            Node::Element {
                attrs, children, ..
            } => {
                for a in attrs {
                    if let Attr::Dynamic { value, .. }
                    | Attr::Spread(value)
                    | Attr::InnerHtml { value } = a
                    {
                        expr(value, f);
                    }
                }
                children.iter().for_each(|c| node(c, f));
            }
            Node::Slot(e) => expr(e, f),
            Node::If {
                cond, then, else_, ..
            } => {
                expr(cond, f);
                then.iter().chain(else_).for_each(|c| node(c, f));
            }
            Node::For {
                source, key, body, ..
            } => {
                expr(source, f);
                expr(key, f);
                body.iter().for_each(|c| node(c, f));
            }
            Node::Component {
                props, children, ..
            } => {
                props.iter().for_each(|(_, v)| expr(v, f));
                children.iter().for_each(|c| node(c, f));
            }
            Node::Fragment(cs) => cs.iter().for_each(|c| node(c, f)),
            Node::Text(_) | Node::Outlet => {}
        }
    }
    node(&ir.template, f);
    ir.state.iter().for_each(|s| expr(&s.init, f));
    ir.derived.iter().for_each(|d| expr(&d.expr, f));
}

/// Every expression the server template prints (`Expr::Server`): the template's own and the derived locals'.
pub(super) fn template_server_raws(ir: &ComponentIR, f: &mut dyn FnMut(&RawExpr)) {
    fn expr(e: &Expr, f: &mut dyn FnMut(&RawExpr)) {
        if let Expr::Server(crate::ir::ServerExpr(r)) = e {
            f(r)
        }
    }
    fn node(n: &Node, f: &mut dyn FnMut(&RawExpr)) {
        match n {
            Node::Element {
                attrs, children, ..
            } => {
                for a in attrs {
                    if let Attr::Dynamic { value, .. }
                    | Attr::Spread(value)
                    | Attr::InnerHtml { value } = a
                    {
                        expr(value, f);
                    }
                }
                children.iter().for_each(|c| node(c, f));
            }
            Node::Slot(e) => expr(e, f),
            Node::If {
                cond, then, else_, ..
            } => {
                expr(cond, f);
                then.iter().chain(else_).for_each(|c| node(c, f));
            }
            Node::For {
                source, key, body, ..
            } => {
                expr(source, f);
                expr(key, f);
                body.iter().for_each(|c| node(c, f));
            }
            Node::Component {
                props, children, ..
            } => {
                props.iter().for_each(|(_, v)| expr(v, f));
                children.iter().for_each(|c| node(c, f));
            }
            Node::Fragment(cs) => cs.iter().for_each(|c| node(c, f)),
            Node::Text(_) | Node::Outlet => {}
        }
    }
    node(&ir.template, f);
    ir.derived.iter().for_each(|d| expr(&d.expr, f));
}

/// Identifiers of kind `Local` read directly (not inside a function or JSX).
fn direct_locals(e: &RawExpr, out: &mut BTreeSet<String>) {
    match &e.kind {
        RawKind::Ident {
            name,
            kind: IdentKind::Local,
        } => {
            out.insert(name.clone());
        }
        RawKind::Member { target, .. } => direct_locals(target, out),
        RawKind::Index { target, index } => {
            direct_locals(target, out);
            direct_locals(index, out);
        }
        RawKind::Call { callee, args } => {
            direct_locals(callee, out);
            args.iter().for_each(|a| direct_locals(a, out));
        }
        RawKind::Binary { left, right, .. } => {
            direct_locals(left, out);
            direct_locals(right, out);
        }
        RawKind::Unary { value, .. } => direct_locals(value, out),
        RawKind::Cond { test, yes, no } => {
            direct_locals(test, out);
            direct_locals(yes, out);
            direct_locals(no, out);
        }
        RawKind::Template { parts, .. } => parts.iter().for_each(|(p, _)| direct_locals(p, out)),
        RawKind::Array(items) => items.iter().for_each(|i| direct_locals(i, out)),
        RawKind::Object(props) => props.iter().for_each(|(_, v)| direct_locals(v, out)),
        RawKind::Lit(_)
        | RawKind::Ident { .. }
        | RawKind::Arrow { .. }
        | RawKind::Jsx(_)
        | RawKind::Opaque { .. } => {}
    }
}

/// Text that would end or confuse a raw-text element (`</script`, `</style`, `<!--`); anything else is printed verbatim.
fn needs_raw_escape(t: &str) -> bool {
    let t = t.to_ascii_lowercase();
    t.contains("</script") || t.contains("</style") || t.contains("<!--")
}

/// A child that is not literal text (`F35`): an expression, a condition, a list or a component.
fn dynamic_child(n: &Node) -> bool {
    match n {
        Node::Text(t) => needs_raw_escape(t),
        Node::Slot(Expr::Raw(r)) => match &r.kind {
            RawKind::Lit(crate::ir::Literal::Str(s)) => needs_raw_escape(s),
            RawKind::Lit(_) => false,
            RawKind::Template { head, parts } => !parts.is_empty() || needs_raw_escape(head),
            _ => true,
        },
        _ => true,
    }
}

/// JSX inside a value that is printed as code (not a template node).
pub fn contains_jsx(e: &RawExpr) -> bool {
    match &e.kind {
        RawKind::Jsx(_) => true,
        RawKind::Opaque { why, .. } => why == "contains-jsx",
        RawKind::Member { target, .. } => contains_jsx(target),
        RawKind::Index { target, index } => contains_jsx(target) || contains_jsx(index),
        RawKind::Call { callee, args } => contains_jsx(callee) || args.iter().any(contains_jsx),
        RawKind::Binary { left, right, .. } => contains_jsx(left) || contains_jsx(right),
        RawKind::Unary { value, .. } => contains_jsx(value),
        RawKind::Cond { test, yes, no } => {
            contains_jsx(test) || contains_jsx(yes) || contains_jsx(no)
        }
        RawKind::Template { parts, .. } => parts.iter().any(|(p, _)| contains_jsx(p)),
        RawKind::Array(items) => items.iter().any(contains_jsx),
        RawKind::Object(props) => props.iter().any(|(_, v)| contains_jsx(v)),
        RawKind::Arrow { body, .. } => match body {
            crate::ir::ArrowBody::Expr(b) => contains_jsx(b),
            crate::ir::ArrowBody::Block { .. } => false,
        },
        RawKind::Lit(_) | RawKind::Ident { .. } => false,
    }
}

impl Placer<'_> {
    /// The allowlist predicate over a child expression (already folded): `None` when EVERY identifier read anywhere in
    /// it is (1) a prop, (2) a component-local binding the lowering prints (a derived value, state, a loop binding) or
    /// (3) already folded to a primitive literal, or a global; otherwise `Some(name)` of the first read that is not.
    /// The match is exhaustive over `RawKind` and `IdentKind` with no wildcard: a new expression or identifier kind is a
    /// compile error here, not a silent hole.
    fn child_read_problem(&self, r: &RawExpr, depth: u8) -> Option<String> {
        if depth > 8 {
            return Some("an expression nested deeper than 8".into());
        }
        let go = |x: &RawExpr| self.child_read_problem(x, depth + 1);
        match &r.kind {
            RawKind::Lit(_) => None,
            RawKind::Ident { name, kind } => match kind {
                IdentKind::Prop
                | IdentKind::State
                | IdentKind::Setter
                | IdentKind::LoopBinding
                | IdentKind::Global
                | IdentKind::Store { .. } => None,
                // A body local the lowering prints: a derived value is judged by what it reads. Any other local (a module
                // const that did not fold to a primitive, a module function) is not provable.
                IdentKind::Local => match self.derived_raw.get(name) {
                    Some(d) => {
                        if let Some(v) = self.read_memo.borrow().get(name) {
                            return v.clone();
                        }
                        // A derived value is judged from its own root: the depth bounds one expression, not a chain.
                        // Fail closed while it is being judged: a name that reads itself is not provable.
                        self.read_memo
                            .borrow_mut()
                            .insert(name.clone(), Some(name.clone()));
                        let v = self.child_read_problem(d, 0);
                        self.read_memo.borrow_mut().insert(name.clone(), v.clone());
                        v
                    }
                    // F174: a module const that never changes, holds no element and reads only what a child may read
                    // (a number, a string, an operator over them): its value is a plain value.
                    None => match self
                        .module_decls
                        .iter()
                        .flat_map(|d| &d.consts)
                        .find(|c| &c.name == name)
                    {
                        Some(c)
                            if !c.mutated
                                && !contains_jsx(&c.value)
                                && matches!(
                                    c.value.kind,
                                    RawKind::Lit(_)
                                        | RawKind::Template { .. }
                                        | RawKind::Binary { .. }
                                        | RawKind::Unary { .. }
                                        | RawKind::Cond { .. }
                                ) =>
                        {
                            self.child_read_problem(&c.value, depth + 1)
                                .map(|_| name.clone())
                        }
                        _ => Some(name.clone()),
                    },
                },
                IdentKind::Import { .. } | IdentKind::Unknown => Some(name.clone()),
            },
            RawKind::Member { target, name, .. } => match &target.kind {
                // `ns.name` of a namespace import: the member is the value; it must resolve to a primitive.
                RawKind::Ident {
                    name: ns,
                    kind: IdentKind::Import { source, imported },
                } if imported == "*" => crate::analyze::const_fold::imported_const(
                    &self.path, source, name, self.opts, 0,
                )
                .is_none()
                .then(|| format!("{ns}.{name}")),
                _ => go(target),
            },
            RawKind::Index { target, index } => go(target).or_else(|| go(index)),
            RawKind::Call { callee, args } => {
                // A call is plain only when its callee is a global (`Math.round`, `String`) or a string / array method
                // on a plain value; a helper's result is not provable (it may return an element).
                let callee_ok = match &callee.kind {
                    RawKind::Ident {
                        kind: IdentKind::Global,
                        ..
                    } => true,
                    // F174: a module function proven to return a primitive; its arguments are judged below.
                    RawKind::Ident {
                        name,
                        kind: IdentKind::Local,
                    } => self.plain_fns.contains(name) && !self.derived_raw.contains_key(name),
                    // F173: a function a relative module exports and proves plain by the same rules (`formatPrice(x)`).
                    RawKind::Ident {
                        kind: IdentKind::Import { source, imported },
                        ..
                    } if imported != "*" && imported != "default" => {
                        // Memoised beside the derived values (a key no identifier can spell): one module read per import.
                        let key = format!("import {source} {imported}");
                        let known = self.read_memo.borrow().get(&key).map(Option::is_none);
                        known.unwrap_or_else(|| {
                            let ok = crate::analyze::plain_fn::imported_plain_fn(
                                &self.path, source, imported, self.opts,
                            );
                            self.read_memo
                                .borrow_mut()
                                .insert(key, (!ok).then(|| imported.clone()));
                            ok
                        })
                    }
                    RawKind::Member {
                        target,
                        name,
                        optional,
                    } => {
                        matches!(
                            &target.kind,
                            RawKind::Ident {
                                kind: IdentKind::Global,
                                ..
                            }
                        ) || (!*optional
                            && plain_method(name)
                            && self.receiver_problem(target, depth + 1).is_none())
                    }
                    RawKind::Lit(_)
                    | RawKind::Ident { .. }
                    | RawKind::Index { .. }
                    | RawKind::Call { .. }
                    | RawKind::Binary { .. }
                    | RawKind::Unary { .. }
                    | RawKind::Cond { .. }
                    | RawKind::Template { .. }
                    | RawKind::Array(_)
                    | RawKind::Object(_)
                    | RawKind::Arrow { .. }
                    | RawKind::Jsx(_)
                    | RawKind::Opaque { .. } => false,
                };
                if !callee_ok {
                    return Some(match &callee.kind {
                        RawKind::Ident { name, .. } => name.clone(),
                        _ => "a call".to_string(),
                    });
                }
                // F173: a regular expression literal is an object, so it is allowed only as the argument of a method
                // (`s.replace(/x/, '')`); a helper could return it.
                let method = matches!(callee.kind, RawKind::Member { .. });
                let helper = matches!(
                    callee.kind,
                    RawKind::Ident {
                        kind: IdentKind::Local | IdentKind::Import { .. },
                        ..
                    }
                );
                args.iter().find_map(|a| match &a.kind {
                    RawKind::Opaque { why, .. } if method && why == "ERegExp" => None,
                    // A helper may call a method of its argument and return the result: the argument must be a receiver
                    // the allowlist accepts (Mellow F1). A global's argument is coerced (`String(x)`, `Math.round(x)`).
                    _ if helper => self.receiver_problem(a, depth + 1),
                    _ => go(a),
                })
            }
            RawKind::Binary { left, right, .. } => go(left).or_else(|| go(right)),
            RawKind::Unary { value, .. } => go(value),
            RawKind::Cond { test, yes, no } => go(test).or_else(|| go(yes)).or_else(|| go(no)),
            RawKind::Template { parts, .. } => parts.iter().find_map(|(p, _)| go(p)),
            RawKind::Array(xs) => xs.iter().find_map(go),
            RawKind::Object(ps) => ps.iter().find_map(|(_, v)| go(v)),
            RawKind::Arrow { .. } => Some("a function".into()),
            RawKind::Jsx(_) => Some("an element".into()),
            RawKind::Opaque { source, .. } => Some(source.clone()),
        }
    }

    /// F173 (lead ruling on @57714ece, Mellow F1): why the value an allowlisted method is called on may not be a
    /// built-in string, number, array or `Date`. A POSITIVE allowlist, so no object literal can sit anywhere in the chain
    /// and bring its own method of that name: a literal or untagged template; a prop, state, store or loop binding; a
    /// derived local judged by this same rule; a primitive module const; member / index chains on those roots; a call of
    /// an allowlisted method on such a receiver (`n.toFixed(2).padStart(6)`), of `String` / `Number` / `Math.*`; and
    /// `new Date(…)` of the unbound global `Date` whose every read is accepted. Anything else refuses.
    fn receiver_problem(&self, r: &RawExpr, depth: u8) -> Option<String> {
        if depth > 8 {
            return Some("an expression nested deeper than 8".into());
        }
        let go = |x: &RawExpr| self.receiver_problem(x, depth + 1);
        let judged = |x: &RawExpr| self.child_read_problem(x, depth + 1);
        let not = || Some("a value that may carry its own methods".to_string());
        match &r.kind {
            RawKind::Lit(_) => None,
            RawKind::Template { .. } | RawKind::Unary { .. } => judged(r),
            RawKind::Binary { op, left, right } => match op {
                // These return one of their operands.
                crate::ir::BinOp::And | crate::ir::BinOp::Or | crate::ir::BinOp::Nullish => {
                    go(left).or_else(|| go(right))
                }
                // The rest return a number, a string or a boolean.
                _ => judged(r),
            },
            RawKind::Cond { test, yes, no } => judged(test).or_else(|| go(yes)).or_else(|| go(no)),
            RawKind::Ident { name, kind } => match kind {
                IdentKind::Prop | IdentKind::Store { .. } => None,
                // Mellow F3: a state value is a receiver only when its `useState` initial value is primitive (a literal, a
                // template, an operator over judged reads). An object, a prop, a lazy initializer, refuse; what a setter
                // writes later is out of model (ledger N2).
                IdentKind::State => match self.state_inits.get(name).map(|i| &i.kind) {
                    Some(RawKind::Lit(_)) => None,
                    Some(RawKind::Template { .. } | RawKind::Unary { .. }) => {
                        judged(&self.state_inits[name]).map(|_| name.clone())
                    }
                    // `&&` / `||` / `??` return an operand; the other operators return a primitive.
                    Some(RawKind::Binary { op, .. })
                        if !matches!(
                            op,
                            crate::ir::BinOp::And
                                | crate::ir::BinOp::Or
                                | crate::ir::BinOp::Nullish
                        ) =>
                    {
                        judged(&self.state_inits[name]).map(|_| name.clone())
                    }
                    _ => Some(name.clone()),
                },
                // Mellow F2: a list item carries what its list holds (`[{ toString: fmt }].map((r) => r.toString())`).
                IdentKind::LoopBinding => match self
                    .lists
                    .iter()
                    .rev()
                    .find(|l| &l.item == name || l.index.as_ref() == Some(name))
                {
                    Some(l) if l.index.as_ref() == Some(name) => None,
                    Some(List {
                        source: Some(src), ..
                    }) => go(src).map(|_| name.clone()),
                    _ => Some(name.clone()),
                },
                IdentKind::Local => match self.derived_raw.get(name) {
                    Some(d) => {
                        let key = format!("receiver {name}");
                        if let Some(v) = self.read_memo.borrow().get(&key) {
                            return v.clone();
                        }
                        // Fail closed while it is being judged (a name that reads itself).
                        self.read_memo
                            .borrow_mut()
                            .insert(key.clone(), Some(name.clone()));
                        let v = self.receiver_problem(d, 0).map(|_| name.clone());
                        self.read_memo.borrow_mut().insert(key, v.clone());
                        v
                    }
                    None => match self
                        .module_decls
                        .iter()
                        .flat_map(|d| &d.consts)
                        .find(|c| &c.name == name)
                    {
                        Some(c)
                            if !c.mutated
                                && !contains_jsx(&c.value)
                                && matches!(
                                    c.value.kind,
                                    RawKind::Lit(_)
                                        | RawKind::Template { .. }
                                        | RawKind::Binary { .. }
                                        | RawKind::Unary { .. }
                                        | RawKind::Cond { .. }
                                ) =>
                        {
                            self.receiver_problem(&c.value, depth + 1)
                                .map(|_| name.clone())
                        }
                        _ => Some(name.clone()),
                    },
                },
                IdentKind::Setter
                | IdentKind::Global
                | IdentKind::Import { .. }
                | IdentKind::Unknown => Some(name.clone()),
            },
            RawKind::Member {
                target, optional, ..
            } => {
                if *optional {
                    return not();
                }
                go(target)
            }
            RawKind::Index { target, index } => go(target).or_else(|| judged(index)),
            RawKind::Call { callee, args } => {
                let ok = match &callee.kind {
                    // `String(x)` / `Number(x)`: the unbound globals.
                    RawKind::Ident {
                        name,
                        kind: IdentKind::Global,
                    } => matches!(name.as_str(), "String" | "Number"),
                    RawKind::Member {
                        target,
                        name,
                        optional: false,
                    } => match &target.kind {
                        // `Math.*` only: never `Object.*`, `Array.*` or another global's member.
                        RawKind::Ident {
                            name: g,
                            kind: IdentKind::Global,
                        } => g == "Math",
                        _ => plain_method(name) && go(target).is_none(),
                    },
                    _ => false,
                };
                if !ok {
                    return not();
                }
                args.iter().find_map(|a| match &a.kind {
                    RawKind::Opaque { why, .. } if why == "ERegExp" => None,
                    _ => judged(a),
                })
            }
            RawKind::Opaque {
                source,
                why,
                captures,
            } if why == "ENew" && source.starts_with("new Date(") => {
                captures.iter().find_map(|(name, kind)| {
                    if name == "Date" {
                        (*kind != IdentKind::Global).then(|| name.clone())
                    } else {
                        judged(&RawExpr {
                            loc: r.loc,
                            kind: RawKind::Ident {
                                name: name.clone(),
                                kind: kind.clone(),
                            },
                        })
                    }
                })
            }
            RawKind::Object(_)
            | RawKind::Array(_)
            | RawKind::Arrow { .. }
            | RawKind::Jsx(_)
            | RawKind::Opaque { .. } => not(),
        }
    }

    /// F198 + F199: why a value (already folded) printed as a `{child}` with no wrapper or Provider above it, or passed as
    /// a prop to a component (which may print it as content), may be a React element: the server would print its
    /// internals (`{'key': None, 'props': …}`). It asks only "can this be an element", so values React prints as text
    /// keep lowering (`{cached(id)}`, `className={cn(…)}`, `onClick={composeEventHandlers(…)}`). Every app-side element
    /// source refuses: JSX, a module const that holds or reads one, a module function or const not proven element-free
    /// (`plain_fn::element_free_fns`), an app module that may hold one (`plain_fn::module_may_hold_element`), a derived
    /// local judged by this same rule, any other local and an unknown name; an arrow or verbatim code is judged by the
    /// JSX in it and every name it captures. A package export is not judged (accepted limit). The match is exhaustive,
    /// with no wildcard.
    fn element_problem(&self, r: &RawExpr, depth: u8) -> Option<String> {
        if depth > 8 {
            return Some("an expression nested deeper than 8".into());
        }
        let go = |x: &RawExpr| self.element_problem(x, depth + 1);
        match &r.kind {
            RawKind::Lit(_) => None,
            RawKind::Ident { name, kind } => match kind {
                IdentKind::Prop
                | IdentKind::State
                | IdentKind::Setter
                | IdentKind::LoopBinding
                | IdentKind::Global
                | IdentKind::Store { .. } => None,
                IdentKind::Local => {
                    // A `useId` value is a string.
                    if self.ids.contains(name) {
                        return None;
                    }
                    let key = format!("element {name}");
                    if let Some(v) = self.read_memo.borrow().get(&key) {
                        return v.clone();
                    }
                    // Fail closed while it is being judged: a name that reads itself is not provable.
                    self.read_memo
                        .borrow_mut()
                        .insert(key.clone(), Some(name.clone()));
                    let v = match self.derived_raw.get(name).or(self.handler_bodies.get(name)) {
                        // A derived value, or a handler (an arrow): judged by what it is built from.
                        Some(d) => self.element_problem(d, 0),
                        // A module function or const: element-free by its own module walk (JSX, reads, filled objects).
                        None if self.plain_fns.contains(name)
                            || self.element_free_fns.contains(name) =>
                        {
                            None
                        }
                        None => Some(name.clone()),
                    };
                    self.read_memo.borrow_mut().insert(key, v.clone());
                    v
                }
                IdentKind::Import { source, .. } => {
                    let key = format!("element-module {source}");
                    let known = self.read_memo.borrow().get(&key).cloned();
                    known
                        .unwrap_or_else(|| {
                            let v = crate::analyze::plain_fn::module_may_hold_element(
                                &self.path, source, self.opts, 0,
                            )
                            .then(|| name.clone());
                            self.read_memo.borrow_mut().insert(key, v.clone());
                            v
                        })
                        .map(|_| name.clone())
                }
                IdentKind::Unknown => Some(name.clone()),
            },
            RawKind::Member { target, .. } => go(target),
            RawKind::Index { target, index } => go(target).or_else(|| go(index)),
            RawKind::Call { callee, args } => {
                // A function handed to a package export (`composeEventHandlers(…, () => …)`) is the package's to call:
                // package exports are not judged, so neither is what they call. An app function's argument is.
                let package = matches!(
                    &chain_root_raw(callee).kind,
                    RawKind::Ident { kind: IdentKind::Import { source, .. }, .. }
                        if !source.starts_with("./") && !source.starts_with("../")
                );
                go(callee).or_else(|| {
                    args.iter()
                        .filter(|a| !(package && self.is_function(a, 0)))
                        .find_map(go)
                })
            }
            // `&&`, `||` and `??` give one of their operands; every other operator, and an untagged template, gives a
            // primitive. A condition's test is never the value.
            RawKind::Binary {
                op: crate::ir::BinOp::And | crate::ir::BinOp::Or | crate::ir::BinOp::Nullish,
                left,
                right,
            } => go(left).or_else(|| go(right)),
            RawKind::Binary { .. } | RawKind::Unary { .. } | RawKind::Template { .. } => None,
            RawKind::Cond { yes, no, .. } => go(yes).or_else(|| go(no)),
            RawKind::Array(xs) => xs.iter().find_map(go),
            RawKind::Object(ps) => ps.iter().find_map(|(_, v)| go(v)),
            // A function, or code the reader keeps verbatim, builds an element only from JSX in it (an arrow's expression
            // body, or an Opaque marked `contains-jsx`) or from a name it reads: it is judged by every name it captures.
            RawKind::Arrow { captures, .. } | RawKind::Opaque { captures, .. } => {
                if contains_jsx(r)
                    || matches!(&r.kind, RawKind::Opaque { why, .. } if why == "contains-jsx")
                {
                    return Some("an element".into());
                }
                captures.iter().find_map(|(name, kind)| {
                    go(&RawExpr {
                        loc: r.loc,
                        kind: RawKind::Ident {
                            name: name.clone(),
                            kind: kind.clone(),
                        },
                    })
                })
            }
            RawKind::Jsx(_) => Some("an element".into()),
        }
    }

    /// The first module const `r` reads (through other module consts) whose value is, or builds, JSX.
    fn jsx_const_read(&self, r: &RawExpr, depth: u8) -> Option<String> {
        if depth > 4 {
            return None;
        }
        let mut hit = None;
        crate::lower::common::visit_idents(r, &mut |name, kind| {
            if hit.is_some() || *kind != crate::ir::IdentKind::Local {
                return;
            }
            if let Some(c) = self
                .module_decls
                .iter()
                .flat_map(|d| &d.consts)
                .find(|c| c.name == name)
            {
                if contains_jsx(&c.value) {
                    hit = Some(name.to_string());
                } else if let Some(n) = self.jsx_const_read(&c.value, depth + 1) {
                    hit = Some(n);
                }
            }
        });
        hit
    }

    /// `e` with the folding module consts it reads replaced by their values.
    /// L20: `styles.x` / `styles['x']` of a CSS Module import is the literal class. An unknown class is a
    /// build error at its source location. This is an explicit exception to R1.1b: the map is frozen.
    fn css_member(&self, n: &RawExpr) -> Option<RawExpr> {
        let (target, key) = match &n.kind {
            RawKind::Member {
                target,
                name,
                optional: false,
            } => (target, name.clone()),
            RawKind::Index { target, index } => match &index.kind {
                RawKind::Lit(crate::ir::Literal::Str(s)) => (target, s.clone()),
                _ => return None,
            },
            _ => return None,
        };
        let RawKind::Ident {
            name,
            kind: IdentKind::Import { .. },
        } = &target.kind
        else {
            return None;
        };
        let (source, map) = self.css.get(name)?;
        match map.get(&key) {
            Some(class) => Some(RawExpr {
                loc: n.loc,
                kind: RawKind::Lit(crate::ir::Literal::Str(class.clone())),
            }),
            None => {
                self.css_errors.borrow_mut().push(Diagnostic::error(
                    "css-module-class",
                    format!("class `{key}` is not defined in {source}"),
                    n.loc,
                    "add the class to the CSS Module, or fix the name",
                ));
                Some(n.clone())
            }
        }
    }

    fn fold(&self, e: &RawExpr) -> RawExpr {
        if self.consts.is_empty() && self.imported_vals.is_empty() && self.css.is_empty() {
            return e.clone();
        }
        let e = &if self.css.is_empty() {
            e.clone()
        } else {
            map_pre(e, &|n| self.css_member(n))
        };
        map_idents(e, &|id| match &id.kind {
            RawKind::Ident {
                name,
                kind: IdentKind::Local,
            } => self.consts.get(name).cloned(),
            RawKind::Ident {
                name,
                kind: IdentKind::Import { .. },
            } => self.imported_vals.get(name).cloned(),
            _ => None,
        })
    }

    fn place_of(&mut self, name: &str) -> Option<Place> {
        if let Some(p) = self.places.get(name) {
            return Some(p.clone());
        }
        if self.ids.contains(name) {
            return Some(Place::Server);
        }
        let raw = self.derived_raw.get(name)?.clone();
        if self.visiting.iter().any(|v| v == name) {
            return Some(Place::Code);
        }
        self.visiting.push(name.into());
        if contains_jsx(&raw) {
            self.st.jsx_code.push((raw.loc, "a local function"));
        }
        let code = matches!(raw.kind, RawKind::Arrow { .. })
            || self.st.cx.deps(&raw, &[]).browser
            || contains_jsx(&raw);
        let folded = self.fold(&raw);
        // Placing the locals it reads is a side effect: only a first-paint value does it.
        let server_ok = !code && try_server(&folded).is_ok() && self.locals_placed(&folded);
        let place = if code {
            Place::Code
        } else if server_ok {
            Place::Server
        } else if self.reads_id(&raw) {
            // A job cannot read a `useId` value.
            self.flag_use_id(raw.loc);
            Place::Code
        } else {
            // Placing it reaches its locals too, so they are slots or template
            // variables the job and the template can bind.
            self.locals_placed(&raw);
            Place::Slot
        };
        self.visiting.pop();
        self.places.insert(name.into(), place.clone());
        Some(place)
    }

    /// Every body local `e` reads directly is itself a first-paint value.
    fn locals_placed(&mut self, e: &RawExpr) -> bool {
        let mut names = BTreeSet::new();
        direct_locals(e, &mut names);
        let mut all = true;
        for n in names {
            all &= matches!(self.place_of(&n), Some(Place::Server | Place::Slot));
        }
        all
    }

    fn slot(&mut self, r: &RawExpr) -> Expr {
        // L2: the build computed this slot once; it is a literal now (no job, no worker).
        let key = format!("{}@{}", self.path, r.loc);
        if let Some(v) = self.slot_values.get(&key)
            && let Some(lit) = crate::analyze::const_fold::json_to_raw(v, r.loc)
        {
            return Expr::Server(crate::ir::ServerExpr(lit));
        }
        // A module-level JSX const read as a value (`const el = <b/>; {el}`) has no printed form on the server: the job
        // would print nothing. Fail closed with a named code, for plain wrappers and Providers alike.
        if let Some(name) = self.jsx_const_read(r, 0) {
            self.diagnostics.push(Diagnostic::fallback(
                "jsx-const-child",
                format!("`{name}` is a module-level JSX element used as a value; the server template cannot print it"),
                r.loc,
                "render the element inline, or return it from a component",
            ));
        }
        let deps = self.st.cx.deps(r, &self.loop_scope);
        self.next_slot += 1;
        let slot = format!("_s{}", self.next_slot);
        // `per_item` is the innermost enclosing loop binding: the job returns
        // one value per item of every enclosing list (nested arrays).
        let per_item = if deps.loop_bindings.is_empty() {
            None
        } else {
            self.lists.last().map(|l| l.item.clone())
        };
        let mut inputs: Vec<String> = deps.props.iter().cloned().collect();
        // A store read is a job input (`__store.<name>.<key>`, D7); never a prop (C1).
        inputs.extend(deps.stores.iter().cloned());
        inputs.extend(self.guards.iter().flatten().cloned());
        // R5: a store-dependent slot is recomputed by the client like a state-dependent one.
        let mut state_dependent = deps.reactive();
        if per_item.is_some() {
            for l in &self.lists {
                inputs.extend(l.paths.iter().cloned());
                state_dependent |= l.stateful;
            }
        }
        self.classify_for_build(
            r,
            &deps,
            &slot,
            &key,
            &inputs,
            state_dependent,
            per_item.is_some(),
        );
        self.st.slots.insert(
            slot.clone(),
            SlotInfo {
                raw: r.clone(),
                scope: self.loop_scope.clone(),
                deps,
                state_dependent,
            },
        );
        Expr::Precomputed {
            slot,
            js: r.to_js(),
            client_js: state_dependent.then(|| r.to_js_in(crate::ir::JsCtx::Client)),
            inputs: minimal_paths(inputs),
            state_dependent,
            per_item,
        }
    }

    /// L2: records the slot as a build-evaluation candidate, or says why a `buildTime(…)` is not one.
    #[allow(clippy::too_many_arguments)]
    fn classify_for_build(
        &mut self,
        r: &RawExpr,
        deps: &Deps,
        slot: &str,
        key: &str,
        inputs: &[String],
        state_dependent: bool,
        per_item: bool,
    ) {
        use super::build_eval::{Verdict, classify};
        // F153c review N1: a component compiled from a package's source never has a slot evaluated at build, so the
        // authored source (as opposed to the published JS the app already imports) never runs there.
        if crate::analyze::modules::is_package_source(&self.path) {
            return;
        }
        let placed = inputs.is_empty() && !state_dependent && !per_item && self.guards.is_empty();
        let (line, col) = crate::ir::line_col(self.text, r.loc);
        let candidate = |build_time: bool| crate::ir::BuildEvalSlot {
            key: key.to_string(),
            slot: slot.to_string(),
            build_time,
            line,
            col,
        };
        let (opts, path) = (self.opts, self.path.clone());
        match classify(r, deps, placed, &self.module_decls, &|src| {
            super::build_eval::module_is_pure(&path, src, opts, &[])
        }) {
            Verdict::Not => {}
            Verdict::Pure => self.st.build_eval.push(candidate(false)),
            Verdict::BuildTime => self.st.build_eval.push(candidate(true)),
            Verdict::BuildTimeInput(what) => self.diagnostics.push(Diagnostic::warning(
                "build-time-input",
                format!(
                    "buildTime(…) reads {}; it cannot run at build and stays a per-request job",
                    what.join(", ")
                ),
                r.loc,
                "read only constants inside buildTime, or compute it from props in a loader",
            )),
            Verdict::BuildTimeImpure(g) => self.diagnostics.push(Diagnostic::error(
                "build-time-impure",
                format!("buildTime(…) reads `{g}`, which differs between runs"),
                r.loc,
                "buildTime is evaluated once at build: remove time and randomness from the closure",
            )),
        }
    }

    /// Places one first-paint value.
    fn painted(&mut self, r: &RawExpr) -> Expr {
        // Lead ruling (c), the single print point: EVERY expression printed under a lowered Provider frame or in a
        // Provider component's own template (a child, an own slot, a component prop, an attribute, a condition or a
        // loop body) goes through the total allowlist, so no print path can skip it. F173: under a plain wrapper, every
        // `{child}` slot printed in the children passed to it (at any depth) goes through the same predicate. F198 + F199:
        // with no wrapper, every `{child}` slot and every prop passed to a component goes through `element_problem`.
        let problem = if self.frame_value {
            None
        } else if self.provider_children > 0 || (self.component_children > 0 && self.slot_content) {
            self.child_read_problem(&self.fold(r), 0)
        } else if (self.slot_content || self.component_prop) && !self.react_already {
            self.element_problem(&self.fold(r), 0)
        } else {
            None
        };
        if let Some(name) = problem {
            let under = if self.provider_children > 0 {
                "under a context Provider"
            } else if self.component_prop {
                "as a prop of a component"
            } else if self.component_children > 0 {
                "as a child of a component"
            } else {
                "as a child"
            };
            let message = if self.provider_children == 0
                && (self.component_prop || self.component_children == 0)
            {
                format!(
                    "`{name}` is read {under} and brust cannot prove it is not a React element; the server template could print the element's internals"
                )
            } else {
                format!(
                    "`{name}` is read {under} and brust cannot prove it is a plain value (a prop, a printed local, a primitive constant or a helper proven to return one); the server template could print nothing for it"
                )
            };
            self.diagnostics.push(Diagnostic::fallback(
                "jsx-const-child",
                message,
                r.loc,
                "render the element inline, pass a prop, or keep this component in React",
            ));
        }
        let deps = self.st.cx.deps(r, &self.loop_scope);
        self.st.painted.push(Painted {
            loc: r.loc,
            deps: deps.clone(),
        });
        if deps.reactive() {
            // The client re-evaluates it (§3.2 rule 3: its props are seeds).
            self.reactive += 1;
            self.st.client_uses.push(super::ClientUse {
                loc: r.loc,
                deps: deps.clone(),
                what: if deps.state.is_empty() {
                    "a store-dependent value"
                } else {
                    "a state-dependent value"
                },
                raw: Some((r.clone(), self.loop_scope.clone())),
            });
        }
        let mut locals = BTreeSet::new();
        direct_locals(r, &mut locals);
        if let Some(rule) = locals.iter().find_map(|l| self.unplaceable.get(l).copied()) {
            if self.flagged.insert(rule) {
                self.diagnostics.push(Diagnostic::fallback(
                    rule,
                    "a ref is read during render",
                    r.loc,
                    "read refs in effects and handlers",
                ));
            }
            return Expr::Raw(r.clone());
        }
        if deps.browser {
            let global = deps
                .globals
                .iter()
                .find(|g| super::deps::BROWSER_GLOBALS.contains(&g.as_str()))
                .cloned()
                .unwrap_or_default();
            self.st.browser_locs.push((r.loc, global));
            return Expr::Raw(r.clone());
        }
        if contains_jsx(r) {
            if self.list_shape_locs.contains(&r.loc) {
                return Expr::Raw(r.clone());
            }
            if !self.jsx_flagged {
                self.jsx_flagged = true;
                self.diagnostics.push(Diagnostic::fallback(
                    "jsx-expression",
                    "JSX inside an expression that is not a list, a condition or a child",
                    r.loc,
                    "use a ternary, && or .map directly in the JSX children",
                ));
            }
            return Expr::Raw(r.clone());
        }
        let folded = self.fold(r);
        if try_server(&folded).is_ok() && self.locals_placed(&folded) {
            return Expr::Server(crate::ir::ServerExpr(folded));
        }
        if self.reads_id(r) {
            self.flag_use_id(r.loc);
            return Expr::Raw(r.clone());
        }
        self.locals_placed(r);
        self.slot(r)
    }

    /// `e` reads a `useId` binding directly.
    fn reads_id(&self, e: &RawExpr) -> bool {
        let mut names = BTreeSet::new();
        direct_locals(e, &mut names);
        names.iter().any(|n| self.ids.contains(n))
    }

    fn flag_use_id(&mut self, loc: u32) {
        if self.flagged.insert("use-id-in-render") {
            self.diagnostics.push(Diagnostic::fallback(
                "use-id-in-render",
                "a useId value is read by an expression the template cannot evaluate on its own",
                loc,
                "use the id only as an attribute value or text, or pass it as a prop",
            ));
        }
    }

    /// A prop passed to a child: functions are client-only, values are painted.
    fn child_prop(&mut self, r: &RawExpr) -> Expr {
        // An element as a prop (`content={<Badge/>}`): kept as written. `children` lowers it for a
        // React island and flags `jsx-expression` for any other child (shadcn S1, R34.52).
        if matches!(r.kind, RawKind::Jsx(_)) {
            return Expr::Raw(r.clone());
        }
        if self.is_function(r, 0) {
            self.reactive += 1;
            if contains_jsx(r) {
                self.st
                    .jsx_code
                    .push((r.loc, "a function passed to a child"));
            }
            self.st.client_uses.push(super::ClientUse {
                loc: r.loc,
                deps: self.st.cx.deps(r, &self.loop_scope),
                what: "a function passed to a child",
                raw: Some((r.clone(), self.loop_scope.clone())),
            });
            Expr::ClientOnly {
                js: r.to_js_in(crate::ir::JsCtx::Client),
            }
        } else {
            self.painted(r)
        }
    }

    /// `r` evaluates to a function: an arrow, a function the reader kept
    /// opaque, a setter, or a local bound to one of those.
    fn is_function(&self, r: &RawExpr, depth: u8) -> bool {
        match &r.kind {
            RawKind::Arrow { .. } => true,
            RawKind::Opaque { why, .. } => FUNCTION_WHYS.contains(&why.as_str()),
            RawKind::Ident {
                kind: IdentKind::Setter,
                ..
            } => true,
            RawKind::Ident {
                name,
                kind: IdentKind::Local,
            } => {
                self.st.handler_names.contains(name)
                    || (depth < 8
                        && self
                            .derived_raw
                            .get(name)
                            .is_some_and(|d| self.is_function(d, depth + 1)))
            }
            _ => false,
        }
    }

    fn expr(&mut self, e: &mut Expr) {
        if let Expr::Raw(r) = e {
            let r = r.clone();
            *e = self.painted(&r);
        }
    }

    fn node(&mut self, n: &mut Node) {
        match n {
            Node::Element {
                tag,
                loc,
                attrs,
                children,
                ..
            } => {
                // F35: raw-text elements are not HTML-escaped by browsers, but the template
                // escapes every value, so a dynamic child would change silently.
                if (tag.eq_ignore_ascii_case("script") || tag.eq_ignore_ascii_case("style"))
                    && children.iter().any(dynamic_child)
                {
                    self.diagnostics.push(Diagnostic::fallback(
                        "raw-text-child",
                        format!("a dynamic child of <{tag}> would be HTML-escaped inside raw text"),
                        *loc,
                        "move the value into a data attribute or a JSON `<script type=\"application/json\">` rendered by a job",
                    ));
                }
                for a in attrs.iter_mut() {
                    match a {
                        Attr::Dynamic { value, .. }
                        | Attr::Spread(value)
                        | Attr::InnerHtml { value } => self.expr(value),
                        Attr::Event { .. } => self.reactive += 1,
                        Attr::Static { .. } | Attr::Ref { .. } => {}
                    }
                }
                children.iter_mut().for_each(|c| self.node(c));
            }
            Node::Outlet => {
                if !self.guards.is_empty() || !self.lists.is_empty() {
                    self.diagnostics.push(Diagnostic::fallback(
                        "outlet-in-branch",
                        "<Outlet/> inside a condition or a list would be duplicated in the hidden copy",
                        0,
                        "render <Outlet/> unconditionally in the layout",
                    ));
                }
            }
            Node::Text(_) => {}
            Node::Slot(e) => {
                self.slot_content = true;
                self.expr(e);
                self.slot_content = false;
            }
            Node::If {
                cond, then, else_, ..
            } => {
                let guard = match &*cond {
                    Expr::Raw(r) => {
                        let d = self.st.cx.deps(r, &self.loop_scope);
                        d.props.into_iter().chain(d.stores).collect()
                    }
                    _ => BTreeSet::new(),
                };
                self.expr(cond);
                self.guards.push(guard);
                then.iter_mut().for_each(|c| self.node(c));
                else_.iter_mut().for_each(|c| self.node(c));
                self.guards.pop();
            }
            Node::For {
                source,
                item,
                index,
                key,
                body,
            } => {
                let src_raw = match source {
                    Expr::Raw(r) => Some(r.clone()),
                    _ => None,
                };
                let reactive_before = self.reactive;
                self.expr(source);
                let src_deps = match (&src_raw, &*source) {
                    (_, Expr::Precomputed { slot, .. }) => self
                        .st
                        .slots
                        .get(slot)
                        .map(|i| i.deps.clone())
                        .unwrap_or_default(),
                    (Some(r), _) => self.st.cx.deps(r, &self.loop_scope),
                    (None, other) => self.st.cx.deps_expr(other, &self.loop_scope),
                };
                let n = self.loop_scope.len();
                self.loop_scope.push(item.clone());
                self.loop_scope.extend(index.iter().cloned());
                self.lists.push(List {
                    item: item.clone(),
                    paths: minimal_paths(src_deps.props.iter().chain(&src_deps.stores).cloned()),
                    stateful: src_deps.reactive() || self.lists.last().is_some_and(|l| l.stateful),
                    source: src_raw.clone(),
                    index: index.clone(),
                });
                self.expr(key);
                body.iter_mut().for_each(|c| self.node(c));
                self.lists.pop();
                self.loop_scope.truncate(n);
                if self.reactive > reactive_before {
                    // The client rebuilds this list: it reads the source.
                    self.st.client_uses.push(super::ClientUse {
                        loc: src_raw.as_ref().map_or(0, |r| r.loc),
                        deps: src_deps,
                        what: "a list the client updates",
                        raw: src_raw.map(|r| (r, self.loop_scope.clone())),
                    });
                }
            }
            Node::Component {
                loc,
                props,
                children,
                ..
            } => {
                for (k, v) in props.iter_mut() {
                    if let Expr::Raw(r) = v {
                        let r = r.clone();
                        self.st.prop_raws.insert((*loc, k.clone()), r.clone());
                        self.frame_value = k.starts_with("__ctx_");
                        // `ref` and `key` are React's own: never a value the child prints.
                        self.component_prop = k != "ref" && k != "key";
                        *v = self.child_prop(&r);
                        self.component_prop = false;
                        self.frame_value = false;
                    }
                }
                let is_provider = self.st.provider_locs.contains(loc);
                self.component_children += 1;
                self.provider_children += u32::from(is_provider);
                children.iter_mut().for_each(|c| self.node(c));
                self.provider_children -= u32::from(is_provider);
                self.component_children -= 1;
            }
            Node::Fragment(cs) => cs.iter_mut().for_each(|c| self.node(c)),
        }
    }
}

/// The expression a member / index chain starts from (`a` of `a.b[c].d`).
fn chain_root_raw(e: &RawExpr) -> &RawExpr {
    match &e.kind {
        RawKind::Member { target, .. } | RawKind::Index { target, .. } => chain_root_raw(target),
        _ => e,
    }
}

/// Calls `f` on every raw expression of a template (attributes, text slots, conditions, lists,
/// component props).
fn collect_raw(n: &Node, f: &mut dyn FnMut(&RawExpr)) {
    let expr = |e: &Expr, f: &mut dyn FnMut(&RawExpr)| {
        if let Expr::Raw(r) = e {
            f(r)
        }
    };
    match n {
        Node::Element {
            attrs, children, ..
        } => {
            for a in attrs {
                if let Attr::Dynamic { value, .. }
                | Attr::Spread(value)
                | Attr::InnerHtml { value } = a
                {
                    expr(value, f);
                }
            }
            children.iter().for_each(|c| collect_raw(c, f));
        }
        Node::Slot(e) => expr(e, f),
        Node::If {
            cond, then, else_, ..
        } => {
            expr(cond, f);
            then.iter().chain(else_).for_each(|c| collect_raw(c, f));
        }
        Node::For {
            source, key, body, ..
        } => {
            expr(source, f);
            expr(key, f);
            body.iter().for_each(|c| collect_raw(c, f));
        }
        Node::Component {
            props, children, ..
        } => {
            props.iter().for_each(|(_, v)| expr(v, f));
            children.iter().for_each(|c| collect_raw(c, f));
        }
        Node::Fragment(cs) => cs.iter().for_each(|c| collect_raw(c, f)),
        Node::Text(_) | Node::Outlet => {}
    }
}

/// The built-in methods whose result is a plain value on a built-in receiver (`Placer::receiver_problem`): main's string
/// / array set (`slice` included) and the F173 allowlist (`plain_fn::PRIMITIVE_METHODS`).
fn plain_method(name: &str) -> bool {
    name == "slice" || crate::analyze::plain_fn::PRIMITIVE_METHODS.contains(&name)
}
