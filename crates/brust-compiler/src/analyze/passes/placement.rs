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
    /// Locations of `list-shape` fallbacks: the reader already named the construct there.
    list_shape_locs: BTreeSet<u32>,
    /// L2: module path, source text, module declarations and build-computed slot values.
    path: String,
    text: &'s [u8],
    module_decls: Vec<crate::ir::ModuleDecl>,
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
        list_shape_locs: ir
            .diagnostics
            .iter()
            .filter(|d| d.rule == "list-shape")
            .map(|d| d.loc)
            .collect(),
        path: ctx.path.to_string(),
        text: ctx.text,
        module_decls: ir.module_decls.clone(),
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
            Node::If { cond, then, else_ } => {
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
            super::build_eval::module_is_pure(&path, src, opts)
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
            Node::Slot(e) => self.expr(e),
            Node::If { cond, then, else_ } => {
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
                        *v = self.child_prop(&r);
                    }
                }
                children.iter_mut().for_each(|c| self.node(c));
            }
            Node::Fragment(cs) => cs.iter_mut().for_each(|c| self.node(c)),
        }
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
        Node::If { cond, then, else_ } => {
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
