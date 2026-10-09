//! Facts every backend reads off one component: the structural expressions
//! behind placed values, dependency classification, which derived values a
//! piece of code reaches, and JS printing with the chunk's / job's names.
use crate::analyze::passes::deps::{Deps, DepsCx};
use crate::ir::{
    ArrowBody, ComponentIR, DerivedDecl, Expr, IdentKind, JsCtx, RawExpr, RawKind, ServerExpr,
    Structural,
};
use std::collections::{BTreeSet, HashMap};

/// The raw expression of a placed value: `Server` carries it; others are
/// looked up in the structural snapshot by the caller.
pub fn raw_of<'a>(placed: &'a Expr, structural: Option<&'a Expr>) -> Option<&'a RawExpr> {
    match (placed, structural) {
        (Expr::Server(ServerExpr(r)) | Expr::Raw(r), _) => Some(r),
        (_, Some(Expr::Raw(r))) => Some(r),
        _ => None,
    }
}

/// How a derived local exists in the chunk / job.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DerivedShape {
    /// A value: a `computed` in the chunk, a `const` in the job.
    Value,
    /// A function (arrow, function declaration, opaque function).
    Function,
}

/// One component's lowering facts.
pub struct Facts<'a> {
    pub ir: &'a ComponentIR,
    pub structural: &'a Structural,
    pub deps: DepsCx,
    pub derived: HashMap<String, (&'a DerivedDecl, DerivedShape)>,
    /// Setter name → its state.
    pub setters: HashMap<String, String>,
    /// Prop name → local binding (`title` → `heading`; `*` → the parameter).
    pub prop_locals: HashMap<String, String>,
    pub states: BTreeSet<String>,
    /// Destructuring defaults by prop name (`size = 3`).
    pub prop_defaults: HashMap<String, RawExpr>,
}

const FUNCTION_WHYS: &[&str] = &[
    "async arrow",
    "arrow parameter pattern",
    "function parameter pattern",
    "EFunction",
    "contains-jsx",
];

pub fn is_function_raw(r: &RawExpr) -> bool {
    match &r.kind {
        RawKind::Arrow { .. } => true,
        RawKind::Opaque { why, .. } => FUNCTION_WHYS.contains(&why.as_str()),
        _ => false,
    }
}

impl<'a> Facts<'a> {
    pub fn new(ir: &'a ComponentIR, structural: &'a Structural) -> Self {
        // Dependency facts over the structural decls (state-dependent slots
        // keep their state there).
        let mut raw_ir = ir.clone();
        raw_ir.derived = structural.derived.clone();
        raw_ir.state = structural.state.clone();
        raw_ir.refs = structural.refs.clone();
        let deps = DepsCx::new(&raw_ir);
        let derived = structural
            .derived
            .iter()
            .map(|d| {
                let shape = match &d.expr {
                    Expr::Raw(r) if is_function_raw(r) => DerivedShape::Function,
                    _ => DerivedShape::Value,
                };
                (d.name.clone(), (d, shape))
            })
            .collect();
        let setters = ir
            .state
            .iter()
            .filter_map(|s| s.setter.clone().map(|set| (set, s.name.clone())))
            .collect();
        let mut prop_locals: HashMap<String, String> = ir
            .props
            .iter()
            .map(|p| (p.name.clone(), p.local.clone()))
            .collect();
        // A non-destructured parameter is read as the root `*`.
        if let [only] = ir.props.as_slice()
            && only.name == only.local
            && !prop_locals.contains_key("*")
        {
            prop_locals.insert("*".into(), only.local.clone());
        }
        Facts {
            ir,
            structural,
            deps,
            derived,
            setters,
            prop_locals,
            states: ir.state.iter().map(|s| s.name.clone()).collect(),
            prop_defaults: ir
                .props
                .iter()
                .filter_map(|p| p.default.clone().map(|d| (p.name.clone(), d)))
                .collect(),
        }
    }

    pub fn deps(&self, r: &RawExpr, scope: &[String]) -> Deps {
        self.deps.deps(r, scope)
    }

    pub fn derived_raw(&self, name: &str) -> Option<&'a RawExpr> {
        match self.derived.get(name).map(|(d, _)| &d.expr) {
            Some(Expr::Raw(r)) => Some(r),
            _ => None,
        }
    }

    /// Body-local names (derived values and functions) `roots` reach,
    /// transitively through derived definitions.
    pub fn reach(&self, roots: &[&RawExpr]) -> BTreeSet<String> {
        let mut seen = BTreeSet::new();
        let mut stack: Vec<String> = Vec::new();
        for r in roots {
            locals_in(r, &mut stack);
        }
        while let Some(n) = stack.pop() {
            if !self.derived.contains_key(&n) || !seen.insert(n.clone()) {
                continue;
            }
            if let Some(r) = self.derived_raw(&n) {
                locals_in(r, &mut stack);
            }
        }
        seen
    }

    /// Lazy `useState` initializer (React calls it): its value.
    pub fn state_init(&self, i: usize) -> Option<RawExpr> {
        let Expr::Raw(r) = &self.structural.state.get(i)?.init else {
            return None;
        };
        Some(match &r.kind {
            RawKind::Arrow {
                params,
                body: ArrowBody::Expr(b),
                ..
            } if params.is_empty() => (**b).clone(),
            _ if is_function_raw(r) => RawExpr {
                loc: r.loc,
                kind: RawKind::Call {
                    callee: Box::new(r.clone()),
                    args: vec![],
                },
            },
            _ => r.clone(),
        })
    }
}

/// Every `Local` identifier read in `r`, including arrow / opaque captures.
pub fn locals_in(r: &RawExpr, out: &mut Vec<String>) {
    let mut f = |name: &str, kind: &IdentKind| {
        if *kind == IdentKind::Local {
            out.push(name.to_string());
        }
    };
    visit_idents(r, &mut f);
}

/// Calls `f` for every identifier `r` reads (captures of functions included).
pub fn visit_idents(r: &RawExpr, f: &mut dyn FnMut(&str, &IdentKind)) {
    match &r.kind {
        RawKind::Lit(_) => {}
        RawKind::Ident { name, kind } => f(name, kind),
        RawKind::Member { target, .. } => visit_idents(target, f),
        RawKind::Index { target, index } => {
            visit_idents(target, f);
            visit_idents(index, f);
        }
        RawKind::Call { callee, args } => {
            visit_idents(callee, f);
            args.iter().for_each(|a| visit_idents(a, f));
        }
        RawKind::Binary { left, right, .. } => {
            visit_idents(left, f);
            visit_idents(right, f);
        }
        RawKind::Unary { value, .. } => visit_idents(value, f),
        RawKind::Cond { test, yes, no } => {
            visit_idents(test, f);
            visit_idents(yes, f);
            visit_idents(no, f);
        }
        RawKind::Template { parts, .. } => parts.iter().for_each(|(p, _)| visit_idents(p, f)),
        RawKind::Array(items) => items.iter().for_each(|i| visit_idents(i, f)),
        RawKind::Object(props) => props.iter().for_each(|(_, v)| visit_idents(v, f)),
        RawKind::Arrow { captures, .. } | RawKind::Opaque { captures, .. } => {
            captures.iter().for_each(|(n, k)| f(n, k))
        }
        // JSX in code is refused before lowering (tier React).
        RawKind::Jsx(_) => {}
    }
}

/// Imports printed code reads: `(local, source, imported)`.
pub type ImportUse = (String, String, String);

/// Collects the imports `r` reads.
pub fn imports_in(r: &RawExpr, out: &mut BTreeSet<ImportUse>) {
    visit_idents(r, &mut |name, kind| {
        if let IdentKind::Import { source, imported } = kind {
            out.insert((name.to_string(), source.clone(), imported.clone()));
        }
    });
}

/// `import` lines for `uses`, grouped by source, sorted.
pub fn import_lines(uses: &BTreeSet<ImportUse>) -> String {
    let mut by_source: std::collections::BTreeMap<&str, Vec<&ImportUse>> = Default::default();
    for u in uses {
        by_source.entry(u.1.as_str()).or_default().push(u);
    }
    let mut out = String::new();
    for (source, items) in by_source {
        let src = crate::ir::expr::js_string(source);
        let mut named = Vec::new();
        for (local, _, imported) in items {
            match imported.as_str() {
                "default" => out.push_str(&format!("import {local} from {src}\n")),
                "*" => out.push_str(&format!("import * as {local} from {src}\n")),
                i if i == local => named.push(local.clone()),
                i => named.push(format!("{i} as {local}")),
            }
        }
        if !named.is_empty() {
            out.push_str(&format!("import {{ {} }} from {src}\n", named.join(", ")));
        }
    }
    out
}

/// Module declarations among `names`' transitive module reach, in source
/// order, with the imports they read.
pub fn module_code(
    ir: &ComponentIR,
    names: &BTreeSet<String>,
    imports: &mut BTreeSet<ImportUse>,
) -> String {
    let scope: HashMap<&str, &Vec<(String, IdentKind)>> = ir
        .module_scope
        .iter()
        .map(|(n, c)| (n.as_str(), c))
        .collect();
    let mut need = BTreeSet::new();
    let mut stack: Vec<String> = names.iter().cloned().collect();
    while let Some(n) = stack.pop() {
        let Some(captures) = scope.get(n.as_str()) else {
            continue;
        };
        if !need.insert(n) {
            continue;
        }
        for (c, k) in captures.iter() {
            match k {
                IdentKind::Import { source, imported } => {
                    imports.insert((c.clone(), source.clone(), imported.clone()));
                }
                IdentKind::Local => stack.push(c.clone()),
                _ => {}
            }
        }
    }
    let mut out = String::new();
    for d in &ir.module_decls {
        if d.names.iter().any(|n| need.contains(n)) {
            out.push_str(&d.source);
            out.push('\n');
        }
    }
    out
}

/// Module-level names among identifiers `r` reads (not body locals).
pub fn module_names_in(r: &RawExpr, facts: &Facts<'_>, out: &mut BTreeSet<String>) {
    let module: BTreeSet<&str> = facts
        .ir
        .module_scope
        .iter()
        .map(|(n, _)| n.as_str())
        .collect();
    visit_idents(r, &mut |name, kind| {
        if *kind == IdentKind::Local && !facts.derived.contains_key(name) && module.contains(name) {
            out.insert(name.to_string());
        }
    });
}

/// Prints `r` as a client **value** expression, evaluated where it is used
/// (inside a `computed` thunk or an effect run): structured code through the
/// printer with the chunk's names; verbatim `Block` / `Opaque` sources wrapped
/// so their captured names are bound to current values (state `q()`, setter
/// `q.set`, prop locals `props().title`, derived values `total()`) — F23.
pub fn client_js(r: &RawExpr, f: &Facts<'_>) -> String {
    let names = |name: &str, kind: &IdentKind| client_ident(name, kind, f);
    match &r.kind {
        RawKind::Arrow {
            body: ArrowBody::Block { source, .. },
            captures,
            ..
        }
        | RawKind::Opaque {
            source, captures, ..
        } => wrap_source(source, captures, f, JsCtx::Client),
        _ => r.to_js_with(JsCtx::Client, &names),
    }
}

/// Prints `r` as a client **function** that binds its captures at each call
/// (React's per-render closure semantics; a handler sees current state).
pub fn client_fn(r: &RawExpr, f: &Facts<'_>) -> String {
    match &r.kind {
        RawKind::Arrow {
            body: ArrowBody::Expr(_),
            ..
        } => client_js(r, f),
        _ => format!("(...a) => ({})(...a)", client_js(r, f)),
    }
}

fn client_ident(name: &str, kind: &IdentKind, f: &Facts<'_>) -> Option<String> {
    match kind {
        IdentKind::Prop => f
            .prop_defaults
            .get(name)
            .map(|d| prop_with_default(name, d, f)),
        IdentKind::Local => match f.derived.get(name) {
            Some((_, DerivedShape::Value)) => Some(format!("{name}()")),
            _ => None,
        },
        IdentKind::Setter => f.setters.get(name).map(|s| format!("{s}.set")),
        _ => None,
    }
}

/// `props().n`, or its destructuring default when it is undefined.
fn prop_with_default(name: &str, d: &RawExpr, f: &Facts<'_>) -> String {
    let read = format!("props()[{}]", crate::ir::expr::js_string(name));
    format!("({read} === undefined ? {} : {read})", client_js(d, f))
}

/// Prints `r` for the precompute job: props destructured by local name,
/// seeds and derived values as plain consts.
pub fn server_js(r: &RawExpr, f: &Facts<'_>) -> String {
    match &r.kind {
        RawKind::Arrow {
            body: ArrowBody::Block { source, .. },
            ..
        }
        | RawKind::Opaque { source, .. } => format!("({source})"),
        _ => r.to_js_with(JsCtx::Server, &|name, kind| match kind {
            // The job destructures every prop under its local name.
            IdentKind::Prop if name != "*" => f.prop_locals.get(name).cloned(),
            IdentKind::Prop => Some(f.prop_locals.get("*").cloned().unwrap_or("props".into())),
            _ => None,
        }),
    }
}

/// `((a, b) => (<source>))(a(), b.set)` binding each capture that the chunk
/// holds under a different shape than the source expects.
fn wrap_source(
    source: &str,
    captures: &[(String, IdentKind)],
    f: &Facts<'_>,
    _ctx: JsCtx,
) -> String {
    let mut params = Vec::new();
    let mut args = Vec::new();
    for (name, kind) in captures {
        let (param, arg) = match kind {
            IdentKind::Prop => {
                let local = f.prop_locals.get(name).cloned().unwrap_or(name.clone());
                let arg = if name == "*" {
                    "props()".to_string()
                } else if let Some(d) = f.prop_defaults.get(name) {
                    prop_with_default(name, d, f)
                } else {
                    format!("props()[{}]", crate::ir::expr::js_string(name))
                };
                (local, arg)
            }
            IdentKind::State => (name.clone(), format!("{name}()")),
            IdentKind::Setter => match f.setters.get(name) {
                Some(s) => (name.clone(), format!("{s}.set")),
                None => continue,
            },
            IdentKind::Local => match f.derived.get(name) {
                Some((_, DerivedShape::Value)) => (name.clone(), format!("{name}()")),
                _ => continue,
            },
            _ => continue,
        };
        if !params.contains(&param) {
            params.push(param);
            args.push(arg);
        }
    }
    if params.is_empty() {
        format!("({source})")
    } else {
        format!(
            "(({}) => ({source}))({})",
            params.join(", "),
            args.join(", ")
        )
    }
}
