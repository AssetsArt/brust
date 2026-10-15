//! Stores pass (M3-F D7): resolves each `useStore` handle to the `defineStore('<name>', …)` it
//! names, through the handle's import (`analyze/stores.rs`). An unresolved handle is a
//! `store-name-unresolved` fallback (the tier pass then makes the component React); the same
//! name defined by two modules in one compile is a `store-name-duplicate` warning; a read whose
//! job-input path falls back to the coarse `__store` (R3) is a `store-name-dotted` warning.
//! [`check_render`] then refuses store writes, handle reads and non-signal keys in render (R1).
use super::PassCtx;
use super::deps::{STORE_INPUT, store_input};
use crate::analyze::modules::resolve as resolve_module;
use crate::analyze::stores::{exports_a_store, read_store_export};
use crate::ir::{
    ArrowBody, Attr, ComponentIR, Diagnostic, Expr, IdentKind, Node, RawExpr, RawKind, ServerExpr,
    StoreRef, StoreUse, Tier,
};
use crate::lower::common::{is_function_raw, visit_verbatim_captures};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

/// Fills `StoreUse.resolved` for every `useStore` of `ir`.
pub fn resolve(ir: &mut ComponentIR, ctx: &PassCtx<'_>) {
    let mut diags = Vec::new();
    for u in &mut ir.stores {
        let (_, source, imported) = &u.import;
        // A namespace handle `stores.cart` reads the export after the dot.
        let export = match imported.as_str() {
            "*" => u.handle.rsplit('.').next().unwrap_or_default(),
            name => name,
        };
        match store_of(source, export, ctx) {
            Ok(r) => {
                let mut modules = ctx.modules.borrow_mut();
                match modules.store_names.get(&r.name) {
                    Some(other) if *other != r.module => diags.push(Diagnostic::warning(
                        "store-name-duplicate",
                        format!(
                            "useStore({}): the store name '{}' is defined by both {other} and {}; their state shares one snapshot entry",
                            u.handle, r.name, r.module
                        ),
                        u.loc,
                        "give every defineStore a distinct name",
                    )),
                    Some(_) => {}
                    None => {
                        modules.store_names.insert(r.name.clone(), r.module.clone());
                    }
                }
                u.resolved = Some(r);
            }
            Err(Unresolved { reason, own_module }) => {
                diags.push(Diagnostic::fallback(
                    "store-name-unresolved",
                    format!(
                        "useStore({}): {reason}; the component renders as a React island",
                        u.handle
                    ),
                    u.loc,
                    if own_module {
                        "define the store in its own module"
                    } else {
                        "import the handle from the module that calls defineStore('<name>', …) with a string-literal name"
                    },
                ));
            }
        }
    }
    dotted(ir, &mut diags);
    ir.diagnostics.extend(diags);
}

/// R3: a first-paint read of a resolved store whose name or key cannot be a job-input path
/// segment declares the coarse `__store` input. One warning per store name.
fn dotted(ir: &ComponentIR, diags: &mut Vec<Diagnostic>) {
    let mut reads = BTreeSet::new();
    Render::new(ir, &mut |u| {
        if let Use::Read { handle, key, .. } = u {
            reads.insert((handle.to_string(), key.map(str::to_string)));
        }
        false
    })
    .roots();
    let mut warned = BTreeSet::new();
    for u in &ir.stores {
        let Some(r) = &u.resolved else { continue };
        let coarse = reads.iter().any(|(h, k)| {
            *h == u.handle && store_input(Some(&r.name), k.as_deref()) == STORE_INPUT
        });
        if coarse && warned.insert(r.name.clone()) {
            diags.push(Diagnostic::warning(
                "store-name-dotted",
                format!(
                    "useStore({}): the store name '{}' or a key read from it contains '.', '[' or ']'; its job inputs fall back to `{STORE_INPUT}`, so the job key hashes the whole snapshot",
                    u.handle, r.name
                ),
                u.loc,
                "prefer dot-free store names and keys",
            ));
        }
    }
}

/// R1: code React runs during render must not write a store (`store-write-in-render`), call a
/// store handle (`store-handle-in-render`: the job would run it outside a store scope, D8), or
/// read what the snapshot does not carry (`store-key-unsupported`: C1 serialises signals only).
/// Each is a fallback (the tier pass makes the component React), one per rule, at the first
/// offending expression. Runs right after [`resolve`]; the tier pass then makes the component
/// React, so lowering takes the React path and never prints a refused read (`__store.cart.dbl`).
/// Handlers and effects are client code and stay native.
pub fn check_render(ir: &mut ComponentIR, ctx: &PassCtx<'_>) {
    let stores: HashMap<&str, &StoreUse> =
        ir.stores.iter().map(|u| (u.handle.as_str(), u)).collect();
    let resolved = |h: &str| stores.get(h).and_then(|u| u.resolved.as_ref());
    // Locals spelled for messages: the view `s` or the destructured binding.
    let shown = |h: &str| {
        stores
            .get(h)
            .and_then(|u| u.view.as_deref())
            .unwrap_or(h)
            .to_string()
    };
    let mut hits: BTreeMap<&'static str, (u32, String)> = BTreeMap::new();
    let mut hit = |rule: &'static str, loc: u32, message: String| {
        let e = hits.entry(rule).or_insert((loc, message.clone()));
        if loc < e.0 {
            *e = (loc, message);
        }
    };
    Render::new(ir, &mut |u| match u {
        Use::Write { loc, target } => {
            let what = match &target.kind {
                RawKind::Ident {
                    kind: IdentKind::Store { key: Some(_), .. },
                    name,
                } => Some(name.clone()),
                RawKind::Member {
                    target: h, name, ..
                } => handle_import(h)
                    .filter(|(source, export)| is_store_handle(source, export, ctx))
                    .map(|_| format!("{}.{name}", print_handle(h))),
                _ => None,
            };
            let Some(what) = what else { return false };
            hit(
                "store-write-in-render",
                loc,
                format!("render writes the store signal `{what}`"),
            );
            true
        }
        Use::Import {
            loc,
            source,
            export,
            local,
        } => {
            if is_store_handle(source, export, ctx) {
                hit(
                    "store-handle-in-render",
                    loc,
                    format!("render reads the store handle `{local}` directly"),
                );
            }
            false
        }
        Use::Read { loc, handle, key } => {
            let Some(r) = resolved(handle) else {
                return false;
            };
            let v = shown(handle);
            match key {
                None => hit(
                    "store-key-unsupported",
                    loc,
                    format!("render uses the whole store view `{v}`"),
                ),
                Some(k) if !r.factory_read || !r.signals.iter().any(|s| s == k) => hit(
                    "store-key-unsupported",
                    loc,
                    format!(
                        "render reads `{}`, which is not a signal of store '{}'",
                        if stores.get(handle).is_some_and(|u| u.view.is_some()) {
                            format!("{v}.{k}")
                        } else {
                            k.to_string()
                        },
                        r.name
                    ),
                ),
                Some(_) => {}
            }
            false
        }
    })
    .roots();
    // (e) Verbatim client code (block bodies, opaque expressions) reads the view `s` as written:
    // the chunk declares it over the factory's keys, unknown when the factory was not read.
    let client = ir
        .handlers
        .iter()
        .map(|h| &h.body)
        .chain(
            ir.effects
                .iter()
                .flat_map(|e| std::iter::once(&e.body).chain(e.deps.iter().flatten())),
        )
        .chain(ir.derived.iter().filter_map(|d| raw(&d.expr)));
    for r in client {
        visit_verbatim_captures(r, &mut |name, kind| {
            if let IdentKind::Store { handle, key: None } = kind
                && resolved(handle).is_some_and(|s| !s.factory_read)
            {
                hit(
                    "store-key-unsupported",
                    r.loc,
                    format!(
                        "client code reads the whole store view `{name}`, whose factory could not be read"
                    ),
                );
            }
        });
    }
    for (rule, (loc, message)) in hits {
        let remediation = match rule {
            "store-write-in-render" => "write stores in event handlers or effects",
            "store-handle-in-render" => "read store values through const s = useStore(handle)",
            _ => "read signals as s.<key> in render; derive other values from them",
        };
        ir.diagnostics.push(Diagnostic::fallback(
            rule,
            format!(
                "{message} (line {}); the component renders as a React island",
                ctx.line(loc)
            ),
            loc,
            remediation,
        ));
    }
}

/// The backstop behind [`check_render`] (review F1): whatever path led there, a precompute job
/// whose module imports a store handle (or a namespace of a module that exports one) would run
/// it in the worker outside a store scope (D8). Runs after the tier pass, over the job imports
/// lowering will print; a hit is a `store-handle-in-render` fallback and the component becomes
/// React (the tier pass's React tail runs again). Ssr jobs print no user imports.
pub fn check_jobs(ir: &mut ComponentIR, ctx: &PassCtx<'_>) {
    if matches!(ir.tier, Tier::React { .. }) {
        return;
    }
    let Some(imports) = crate::lower::server::job_imports(ir) else {
        return;
    };
    let Some((local, source)) = imports.iter().find_map(|(local, source, imported)| {
        let hit = match imported.as_str() {
            "*" => {
                is_relative(source)
                    && resolve_module(ctx.path, source, ctx.opts)
                        .is_some_and(|p| exports_a_store(&p, ctx.opts, ctx.modules))
            }
            export => is_relative(source) && is_store_handle(source, export, ctx),
        };
        hit.then_some((local, source))
    }) else {
        return;
    };
    let message = format!(
        "the precompute job reads the store handle `{local}` imported from {source}; the component renders as a React island"
    );
    ir.diagnostics.push(Diagnostic::fallback(
        "store-handle-in-render",
        message.clone(),
        0,
        "read store values through const s = useStore(handle)",
    ));
    ir.tier = Tier::React {
        reason: message,
        client_only: false,
    };
    super::tier::react_jobs(ir);
}

fn is_relative(source: &str) -> bool {
    crate::analyze::modules::is_relative_spec(source)
}

/// `true` when `(source, export)` names a `defineStore` handle (relative imports only; a
/// package or alias handle is a known gap).
fn is_store_handle(source: &str, export: &str, ctx: &PassCtx<'_>) -> bool {
    resolve_module(ctx.path, source, ctx.opts)
        .is_some_and(|p| read_store_export(&p, export, ctx.opts, ctx.modules).is_ok())
}

/// `cart` → `(source, "cart")`; `stores.cart` of a namespace import → `(source, "cart")`.
fn handle_import(e: &RawExpr) -> Option<(&str, &str)> {
    match &e.kind {
        RawKind::Ident {
            kind: IdentKind::Import { source, imported },
            ..
        } if imported != "*" => Some((source, imported)),
        RawKind::Member { target, name, .. } => match &target.kind {
            RawKind::Ident {
                kind: IdentKind::Import { source, imported },
                ..
            } if imported == "*" => Some((source, name)),
            _ => None,
        },
        _ => None,
    }
}

fn print_handle(e: &RawExpr) -> String {
    match &e.kind {
        RawKind::Ident { name, .. } => name.clone(),
        RawKind::Member { target, name, .. } => format!("{}.{name}", print_handle(target)),
        _ => String::new(),
    }
}

fn raw(e: &Expr) -> Option<&RawExpr> {
    match e {
        Expr::Raw(r) | Expr::Server(ServerExpr(r)) => Some(r),
        _ => None,
    }
}

/// What render code does with a store, as [`Render`] meets it.
enum Use<'a> {
    /// `<target>.set(…)`; the visitor answers whether `target` is a store signal (then the
    /// walker does not read it as a handle).
    Write { loc: u32, target: &'a RawExpr },
    /// An imported binding (`source`, `export`), spelled `local`; a namespace member `ns.x` is
    /// `(source, "x")`.
    Import {
        loc: u32,
        source: &'a str,
        export: &'a str,
        local: String,
    },
    /// A store-view read.
    Read {
        loc: u32,
        handle: &'a str,
        key: Option<&'a str>,
    },
}

/// Walks the code React runs during render, the whole subtree (the reject-guard rule).
/// Roots: template expressions except event handlers and function-valued component props,
/// structural derived values that are not functions, state and ref inits. From there every
/// function value it meets may run (`o.f()`, `f.call(null)`, `fs[0]()`): it descends into JSX,
/// arrow and opaque function bodies wherever they sit, and into every local (derived or
/// module-level) the walked code names, called or not.
struct Render<'a, 'f> {
    ir: &'a ComponentIR,
    derived: HashMap<&'a str, &'a RawExpr>,
    module: HashMap<&'a str, &'a [(String, IdentKind)]>,
    seen: HashSet<&'a str>,
    visit: &'f mut dyn FnMut(Use<'a>) -> bool,
}

impl<'a, 'f> Render<'a, 'f> {
    fn new(ir: &'a ComponentIR, visit: &'f mut dyn FnMut(Use<'a>) -> bool) -> Self {
        Render {
            ir,
            derived: ir
                .derived
                .iter()
                .filter_map(|d| Some((d.name.as_str(), raw(&d.expr)?)))
                .collect(),
            module: ir
                .module_scope
                .iter()
                .map(|(n, c)| (n.as_str(), c.as_slice()))
                .collect(),
            seen: HashSet::new(),
            visit,
        }
    }

    fn roots(&mut self) {
        let ir = self.ir;
        self.node(&ir.template);
        for s in &ir.state {
            // A lazy initializer runs during the first render.
            match raw(&s.init) {
                Some(r) if is_function_raw(r) => self.arg(r),
                _ => self.expr(&s.init),
            }
        }
        for r in &ir.refs {
            self.expr(&r.init);
        }
        for d in &ir.derived {
            if let Some(r) = raw(&d.expr)
                && !is_function_raw(r)
            {
                self.local(r.loc, &d.name);
            }
        }
    }

    fn node(&mut self, n: &'a Node) {
        match n {
            Node::Element {
                attrs, children, ..
            } => {
                for a in attrs {
                    if let Attr::Dynamic { value, .. }
                    | Attr::Spread(value)
                    | Attr::InnerHtml { value } = a
                    {
                        self.expr(value);
                    }
                }
                children.iter().for_each(|c| self.node(c));
            }
            Node::Slot(e) => self.expr(e),
            Node::If {
                cond, then, else_, ..
            } => {
                self.expr(cond);
                then.iter().chain(else_).for_each(|c| self.node(c));
            }
            Node::For {
                source, key, body, ..
            } => {
                self.expr(source);
                self.expr(key);
                body.iter().for_each(|c| self.node(c));
            }
            Node::Component {
                props, children, ..
            } => {
                for (_, v) in props {
                    // A function prop runs when the child calls it: client code.
                    if !raw(v).is_some_and(|r| self.is_function(r)) {
                        self.expr(v);
                    }
                }
                children.iter().for_each(|c| self.node(c));
            }
            Node::Fragment(cs) => cs.iter().for_each(|c| self.node(c)),
            Node::Text(_) | Node::Outlet => {}
        }
    }

    fn expr(&mut self, e: &'a Expr) {
        if let Some(r) = raw(e) {
            self.raw(r);
        }
    }

    fn raw(&mut self, r: &'a RawExpr) {
        match &r.kind {
            RawKind::Lit(_) => {}
            RawKind::Ident { name, kind } => self.ident(r.loc, name, kind),
            RawKind::Member { target, .. } => {
                if let Some((source, export)) = handle_import(r) {
                    let local = print_handle(r);
                    (self.visit)(Use::Import {
                        loc: r.loc,
                        source,
                        export,
                        local,
                    });
                } else {
                    self.raw(target);
                }
            }
            RawKind::Index { target, index } => {
                self.raw(target);
                self.raw(index);
            }
            RawKind::Call { callee, args } => {
                let write = match &callee.kind {
                    RawKind::Member { target, name, .. } if name == "set" => {
                        (self.visit)(Use::Write { loc: r.loc, target })
                    }
                    _ => false,
                };
                if !write {
                    self.raw(callee);
                }
                args.iter().for_each(|a| self.arg(a));
            }
            RawKind::Binary { left, right, .. } => {
                self.raw(left);
                self.raw(right);
            }
            RawKind::Unary { value, .. } => self.raw(value),
            RawKind::Cond { test, yes, no } => {
                self.raw(test);
                self.raw(yes);
                self.raw(no);
            }
            RawKind::Template { parts, .. } => parts.iter().for_each(|(p, _)| self.raw(p)),
            RawKind::Array(items) => items.iter().for_each(|i| self.raw(i)),
            RawKind::Object(props) => props.iter().for_each(|(_, v)| self.raw(v)),
            // A function value reached from render may run there (`o.f()`, `fs[0]()`).
            RawKind::Arrow { .. } => self.arg(r),
            RawKind::Opaque { captures, .. } => self.captures(r.loc, captures),
            RawKind::Jsx(n) => self.node(n),
        }
    }

    /// A call argument: a function passed here may run during render (`.map(() => …)`).
    fn arg(&mut self, a: &'a RawExpr) {
        match &a.kind {
            RawKind::Arrow { body, captures, .. } => match body {
                ArrowBody::Expr(b) => self.raw(b),
                ArrowBody::Block { .. } => self.captures(a.loc, captures),
            },
            RawKind::Opaque { captures, .. } => self.captures(a.loc, captures),
            _ => self.raw(a),
        }
    }

    /// A function literal, or a local naming a derived function (`onAdd={inc}`).
    fn is_function(&self, r: &RawExpr) -> bool {
        match &r.kind {
            RawKind::Ident {
                name,
                kind: IdentKind::Local,
            } => self
                .derived
                .get(name.as_str())
                .is_some_and(|d| is_function_raw(d)),
            _ => is_function_raw(r),
        }
    }

    fn captures(&mut self, loc: u32, captures: &'a [(String, IdentKind)]) {
        for (name, kind) in captures {
            self.ident(loc, name, kind);
        }
    }

    fn ident(&mut self, loc: u32, name: &'a str, kind: &'a IdentKind) {
        match kind {
            IdentKind::Store { handle, key } => {
                (self.visit)(Use::Read {
                    loc,
                    handle,
                    key: key.as_deref(),
                });
            }
            IdentKind::Import { source, imported } if imported != "*" => {
                (self.visit)(Use::Import {
                    loc,
                    source,
                    export: imported,
                    local: name.to_string(),
                });
            }
            IdentKind::Local => self.local(loc, name),
            _ => {}
        }
    }

    /// A local render code names, once: a derived value is read as computed; a derived
    /// function, wherever it is named (called, passed, a member read like `f.call`), may run;
    /// a module-level binding (a helper, an object of helpers) runs with whatever it captures.
    fn local(&mut self, loc: u32, name: &'a str) {
        if !self.seen.insert(name) {
            return;
        }
        if let Some(r) = self.derived.get(name).copied() {
            self.arg(r);
        } else if let Some(captures) = self.module.get(name).copied() {
            for (n, k) in captures {
                self.ident(loc, n, k);
            }
        }
    }
}

struct Unresolved {
    reason: String,
    /// The store lives in the component's own module (R4).
    own_module: bool,
}

fn store_of(source: &str, export: &str, ctx: &PassCtx<'_>) -> Result<StoreRef, Unresolved> {
    let err = |reason: String| Unresolved {
        reason,
        own_module: false,
    };
    let own = || Unresolved {
        reason: "the store is defined in the component's own module".into(),
        own_module: true,
    };
    if !crate::analyze::modules::is_relative_spec(source) {
        return Err(err(format!(
            "the handle is imported from the package {source}"
        )));
    }
    let path = resolve_module(ctx.path, source, ctx.opts)
        .ok_or_else(|| err(format!("cannot resolve {source} from {}", ctx.path)))?;
    if path == ctx.path {
        return Err(own());
    }
    let r = read_store_export(&path, export, ctx.opts, ctx.modules).map_err(err)?;
    if r.module == ctx.path {
        return Err(own());
    }
    Ok(r)
}
