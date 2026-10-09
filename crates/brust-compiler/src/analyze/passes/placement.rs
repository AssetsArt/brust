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
    pub deps: Deps,
    pub state_dependent: bool,
}

struct Placer<'s> {
    st: &'s mut PassState,
    derived_raw: HashMap<String, RawExpr>,
    places: HashMap<String, Place>,
    visiting: Vec<String>,
    next_slot: u32,
    /// (loop binding, list source paths) of the enclosing `For`s.
    lists: Vec<(String, Vec<String>)>,
    loop_scope: Vec<String>,
    diagnostics: Vec<Diagnostic>,
    jsx_flagged: bool,
}

pub fn place(ir: &mut ComponentIR, st: &mut PassState) {
    let derived_raw = ir
        .derived
        .iter()
        .filter_map(|d| match &d.expr {
            Expr::Raw(r) => Some((d.name.clone(), r.clone())),
            _ => None,
        })
        .collect();
    let mut p = Placer {
        st,
        derived_raw,
        places: HashMap::new(),
        visiting: Vec::new(),
        next_slot: 0,
        lists: Vec::new(),
        loop_scope: Vec::new(),
        diagnostics: Vec::new(),
        jsx_flagged: false,
    };
    let mut template = std::mem::replace(&mut ir.template, Node::Fragment(vec![]));
    p.node(&mut template);
    ir.template = template;

    for s in &mut ir.state {
        if let Expr::Raw(r) = &s.init {
            let r = r.clone();
            s.init = p.painted(&r);
        }
    }
    for d in &mut ir.derived {
        let Expr::Raw(r) = &d.expr else { continue };
        let r = r.clone();
        d.expr = match p.places.get(&d.name) {
            Some(Place::Server) => Expr::Server(crate::ir::ServerExpr(r)),
            Some(Place::Slot) => p.slot(&r),
            Some(Place::Code) if p.st.cx.deps(&r, &[]).browser => Expr::Raw(r),
            _ => Expr::ClientOnly { js: r.to_js() },
        };
    }
    for r in &mut ir.refs {
        if let Expr::Raw(raw) = &r.init {
            r.init = Expr::ClientOnly { js: raw.to_js() };
        }
    }
    ir.diagnostics.append(&mut p.diagnostics);

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
            inputs.extend(p.st.cx.deps_expr(&s.init, &[]).props);
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
        });
    }
}

/// Every `Precomputed` in the IR: (slot, inputs, state_dependent).
fn collect_slots(ir: &ComponentIR, f: &mut impl FnMut(&str, &[String], bool)) {
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
                    if let Attr::Dynamic { value, .. } | Attr::Spread(value) = a {
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
            Node::Text(_) => {}
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
    fn place_of(&mut self, name: &str) -> Option<Place> {
        if let Some(p) = self.places.get(name) {
            return Some(p.clone());
        }
        let raw = self.derived_raw.get(name)?.clone();
        if self.visiting.iter().any(|v| v == name) {
            return Some(Place::Code);
        }
        self.visiting.push(name.into());
        let place = if matches!(raw.kind, RawKind::Arrow { .. })
            || self.st.cx.deps(&raw, &[]).browser
            || contains_jsx(&raw)
        {
            Place::Code
        } else if try_server(&raw).is_ok() && self.locals_placed(&raw) {
            Place::Server
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
        let deps = self.st.cx.deps(r, &self.loop_scope);
        self.next_slot += 1;
        let slot = format!("_s{}", self.next_slot);
        let per_item = if deps.loop_bindings.is_empty() {
            None
        } else {
            self.lists.last().map(|(item, _)| item.clone())
        };
        let mut inputs: Vec<String> = deps.props.iter().cloned().collect();
        if per_item.is_some() {
            for (_, src) in &self.lists {
                inputs.extend(src.iter().cloned());
            }
        }
        let state_dependent = !deps.state.is_empty();
        self.st.slots.insert(
            slot.clone(),
            SlotInfo {
                raw: r.clone(),
                deps,
                state_dependent,
            },
        );
        Expr::Precomputed {
            slot,
            js: r.to_js(),
            inputs: minimal_paths(inputs),
            state_dependent,
            per_item,
        }
    }

    /// Places one first-paint value.
    fn painted(&mut self, r: &RawExpr) -> Expr {
        let deps = self.st.cx.deps(r, &self.loop_scope);
        self.st.painted.push(Painted {
            loc: r.loc,
            deps: deps.clone(),
        });
        if deps.browser {
            self.st.browser_locs.push(r.loc);
            return Expr::Raw(r.clone());
        }
        if contains_jsx(r) {
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
        if try_server(r).is_ok() && self.locals_placed(r) {
            return Expr::Server(crate::ir::ServerExpr(r.clone()));
        }
        self.locals_placed(r);
        self.slot(r)
    }

    /// A prop passed to a child: functions are client-only, values are painted.
    fn child_prop(&mut self, r: &RawExpr) -> Expr {
        let is_fn = match &r.kind {
            RawKind::Arrow { .. } => true,
            RawKind::Opaque { why, .. } => why == "contains-jsx",
            RawKind::Ident {
                name,
                kind: IdentKind::Local,
            } => {
                self.st.handler_names.contains(name)
                    || matches!(
                        self.derived_raw.get(name).map(|d| &d.kind),
                        Some(RawKind::Arrow { .. })
                    )
            }
            _ => false,
        };
        if is_fn {
            self.st.client_uses.push(super::ClientUse {
                loc: r.loc,
                deps: self.st.cx.deps(r, &self.loop_scope),
                what: "a function passed to a child",
            });
            Expr::ClientOnly { js: r.to_js() }
        } else {
            self.painted(r)
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
                attrs, children, ..
            } => {
                for a in attrs.iter_mut() {
                    if let Attr::Dynamic { value, .. } | Attr::Spread(value) = a {
                        self.expr(value);
                    }
                }
                children.iter_mut().for_each(|c| self.node(c));
            }
            Node::Text(_) => {}
            Node::Slot(e) => self.expr(e),
            Node::If { cond, then, else_ } => {
                self.expr(cond);
                then.iter_mut().for_each(|c| self.node(c));
                else_.iter_mut().for_each(|c| self.node(c));
            }
            Node::For {
                source,
                item,
                index,
                key,
                body,
            } => {
                self.expr(source);
                let src_paths = match source {
                    Expr::Precomputed { inputs, .. } => inputs.clone(),
                    other => self.st.cx.deps_expr(other, &self.loop_scope).prop_paths(),
                };
                let n = self.loop_scope.len();
                self.loop_scope.push(item.clone());
                self.loop_scope.extend(index.iter().cloned());
                self.lists.push((item.clone(), src_paths));
                self.expr(key);
                body.iter_mut().for_each(|c| self.node(c));
                self.lists.pop();
                self.loop_scope.truncate(n);
            }
            Node::Component {
                props, children, ..
            } => {
                for (_, v) in props.iter_mut() {
                    if let Expr::Raw(r) = v {
                        let r = r.clone();
                        *v = self.child_prop(&r);
                    }
                }
                children.iter_mut().for_each(|c| self.node(c));
            }
            Node::Fragment(cs) => cs.iter_mut().for_each(|c| self.node(c)),
        }
    }
}
