//! Dependency classification (spec §4.2(b)): what a value reads — prop paths,
//! state, setters, imports, globals, loop bindings — following derived locals
//! through the component body.
use crate::ir::{
    ArrowBody, Attr, ComponentIR, Expr, IdentKind, Node, RawExpr, RawKind, ServerExpr,
};
use std::collections::{BTreeSet, HashMap};

/// Browser globals that make render client-only when read (plan Global Constraints).
pub const BROWSER_GLOBALS: &[&str] = &[
    "window",
    "document",
    "navigator",
    "location",
    "history",
    "localStorage",
    "sessionStorage",
    "screen",
    "matchMedia",
    "requestAnimationFrame",
];

#[derive(Default, Debug, Clone, PartialEq)]
pub struct Deps {
    /// Dotted prop paths (`item.price`); `*` is the whole props object.
    pub props: BTreeSet<String>,
    pub state: BTreeSet<String>,
    pub setters: BTreeSet<String>,
    /// `(source, imported)`.
    pub imports: BTreeSet<(String, String)>,
    pub globals: BTreeSet<String>,
    /// A browser global is read.
    pub browser: bool,
    pub loop_bindings: BTreeSet<String>,
    /// Some part could only be seen through an `Opaque`'s captures.
    pub opaque: bool,
    /// Locals that are not declared in the component body (module scope).
    pub module_locals: BTreeSet<String>,
}

impl Deps {
    pub fn union(&mut self, o: &Deps) {
        self.props.extend(o.props.iter().cloned());
        self.state.extend(o.state.iter().cloned());
        self.setters.extend(o.setters.iter().cloned());
        self.imports.extend(o.imports.iter().cloned());
        self.globals.extend(o.globals.iter().cloned());
        self.browser |= o.browser;
        self.loop_bindings.extend(o.loop_bindings.iter().cloned());
        self.opaque |= o.opaque;
        self.module_locals.extend(o.module_locals.iter().cloned());
    }

    /// Prop paths with every path dropped whose prefix is also present
    /// (`item` covers `item.price`); `*` covers everything.
    pub fn prop_paths(&self) -> Vec<String> {
        minimal_paths(self.props.iter().cloned())
    }

    /// Root names of the props read (`item.price` → `item`).
    pub fn prop_roots(&self) -> BTreeSet<String> {
        self.props
            .iter()
            .map(|p| p.split('.').next().unwrap_or(p).to_string())
            .collect()
    }
}

/// Sorted, deduplicated paths with covered paths removed.
pub fn minimal_paths(paths: impl IntoIterator<Item = String>) -> Vec<String> {
    let all: BTreeSet<String> = paths.into_iter().collect();
    if all.contains("*") {
        return vec!["*".into()];
    }
    all.iter()
        .filter(|p| {
            !all.iter()
                .any(|q| q != *p && p.starts_with(q.as_str()) && p[q.len()..].starts_with('.'))
        })
        .cloned()
        .collect()
}

/// What a local name in the component body stands for.
#[derive(Debug, Clone)]
enum LocalDef {
    Value(RawExpr),
    /// Placed derived values seen after the placement pass.
    Placed(Deps),
    Opaque,
}

/// The component's local definitions, snapshotted from the structural IR so
/// later passes can follow locals after placement has rewritten them.
#[derive(Debug, Clone, Default)]
pub struct DepsCx {
    locals: HashMap<String, LocalDef>,
    /// Module-level declarations → what they read.
    module: HashMap<String, Vec<(String, IdentKind)>>,
}

impl DepsCx {
    pub fn new(ir: &ComponentIR) -> Self {
        let mut locals = HashMap::new();
        for d in &ir.derived {
            let def = match &d.expr {
                Expr::Raw(r) | Expr::Server(ServerExpr(r)) => LocalDef::Value(r.clone()),
                Expr::Precomputed { inputs, .. } => LocalDef::Placed(Deps {
                    props: inputs.iter().cloned().collect(),
                    ..Default::default()
                }),
                Expr::ClientOnly { .. } => LocalDef::Opaque,
            };
            locals.insert(d.name.clone(), def);
        }
        for h in &ir.handlers {
            locals.insert(h.name.clone(), LocalDef::Value(h.body.clone()));
        }
        for r in &ir.refs {
            locals.insert(r.name.clone(), LocalDef::Placed(Deps::default()));
        }
        for id in &ir.id_bindings {
            locals.insert(id.clone(), LocalDef::Placed(Deps::default()));
        }
        DepsCx {
            locals,
            module: ir.module_scope.iter().cloned().collect(),
        }
    }

    /// This table with every props-only precomputed derived value replaced by
    /// its inputs (after placement): the client receives it, never runs it.
    pub fn client_view(&self, ir: &ComponentIR) -> DepsCx {
        let mut locals = self.locals.clone();
        for d in &ir.derived {
            if let Expr::Precomputed {
                inputs,
                state_dependent: false,
                ..
            } = &d.expr
            {
                locals.insert(
                    d.name.clone(),
                    LocalDef::Placed(Deps {
                        props: inputs.iter().cloned().collect(),
                        ..Default::default()
                    }),
                );
            }
        }
        DepsCx {
            locals,
            module: self.module.clone(),
        }
    }

    /// `name` is declared in the component body.
    pub fn is_body_local(&self, name: &str) -> bool {
        self.locals.contains_key(name)
    }

    pub fn deps(&self, e: &RawExpr, loop_scope: &[String]) -> Deps {
        let mut w = Walker {
            cx: self,
            loop_scope: loop_scope.to_vec(),
            visiting: Vec::new(),
            memo: HashMap::new(),
        };
        let mut out = Deps::default();
        w.raw(e, &mut out);
        out
    }

    pub fn deps_expr(&self, e: &Expr, loop_scope: &[String]) -> Deps {
        match e {
            Expr::Raw(r) | Expr::Server(ServerExpr(r)) => self.deps(r, loop_scope),
            Expr::Precomputed { inputs, .. } => Deps {
                props: inputs.iter().cloned().collect(),
                ..Default::default()
            },
            Expr::ClientOnly { .. } => Deps {
                opaque: true,
                ..Default::default()
            },
        }
    }

    /// Deps of a local name as the body defines it.
    pub fn deps_of_local(&self, name: &str) -> Deps {
        let mut w = Walker {
            cx: self,
            loop_scope: Vec::new(),
            visiting: Vec::new(),
            memo: HashMap::new(),
        };
        let mut out = Deps::default();
        w.local(name, &mut out);
        out
    }

    /// Deps of every expression in a template subtree.
    pub fn deps_node(&self, n: &Node, loop_scope: &[String]) -> Deps {
        let mut w = Walker {
            cx: self,
            loop_scope: loop_scope.to_vec(),
            visiting: Vec::new(),
            memo: HashMap::new(),
        };
        let mut out = Deps::default();
        w.node(n, &mut out);
        out
    }
}

/// Plan Task 1 entry: deps of `e` in the component `ir`, with `loop_scope`
/// naming the loop bindings in scope.
pub fn deps_of(e: &RawExpr, ir: &ComponentIR, loop_scope: &[String]) -> Deps {
    DepsCx::new(ir).deps(e, loop_scope)
}

struct Walker<'c> {
    cx: &'c DepsCx,
    loop_scope: Vec<String>,
    visiting: Vec<String>,
    memo: HashMap<String, Deps>,
}

/// The dotted prop path of a member chain rooted at a prop.
pub fn prop_path(e: &RawExpr) -> Option<String> {
    match &e.kind {
        RawKind::Ident {
            name,
            kind: IdentKind::Prop,
        } => Some(name.clone()),
        RawKind::Member { target, name, .. } => {
            let base = prop_path(target)?;
            Some(if base == "*" {
                name.clone()
            } else {
                format!("{base}.{name}")
            })
        }
        _ => None,
    }
}

impl Walker<'_> {
    fn raw(&mut self, e: &RawExpr, out: &mut Deps) {
        match &e.kind {
            RawKind::Lit(_) => {}
            RawKind::Ident { name, kind } => self.ident(name, kind, out),
            RawKind::Member { target, .. } => match prop_path(e) {
                Some(p) => {
                    // `list.length` is not a field of the JSON the client is seeded with (nor of
                    // the job inputs): it reads the whole value.
                    let p = p.strip_suffix(".length").map_or(p.clone(), str::to_string);
                    out.props.insert(p);
                }
                None => self.raw(target, out),
            },
            RawKind::Index { target, index } => {
                self.raw(target, out);
                self.raw(index, out);
            }
            RawKind::Call { callee, args } => {
                // A method call reads its receiver, not a member named like the method.
                match &callee.kind {
                    RawKind::Member { target, .. } => self.raw(target, out),
                    _ => self.raw(callee, out),
                }
                for a in args {
                    self.raw(a, out);
                }
            }
            RawKind::Binary { left, right, .. } => {
                self.raw(left, out);
                self.raw(right, out);
            }
            RawKind::Unary { value, .. } => self.raw(value, out),
            RawKind::Cond { test, yes, no } => {
                self.raw(test, out);
                self.raw(yes, out);
                self.raw(no, out);
            }
            RawKind::Template { parts, .. } => {
                for (p, _) in parts {
                    self.raw(p, out);
                }
            }
            RawKind::Array(items) => {
                for i in items {
                    self.raw(i, out);
                }
            }
            RawKind::Object(props) => {
                for (_, v) in props {
                    self.raw(v, out);
                }
            }
            RawKind::Arrow { captures, body, .. } => {
                let exact = matches!(body, ArrowBody::Expr(_));
                for (name, kind) in captures {
                    // An expression body gives exact prop paths below.
                    if !(exact && *kind == IdentKind::Prop) {
                        self.ident(name, kind, out);
                    }
                }
                if let ArrowBody::Expr(b) = body {
                    // Params read as unknown locals here; only the prop paths
                    // of the body are kept.
                    let mut inner = Deps::default();
                    self.raw(b, &mut inner);
                    out.props.extend(inner.props);
                }
            }
            RawKind::Jsx(node) => self.node(node, out),
            RawKind::Opaque { captures, .. } => {
                out.opaque = true;
                for (name, kind) in captures {
                    self.ident(name, kind, out);
                }
            }
        }
    }

    fn ident(&mut self, name: &str, kind: &IdentKind, out: &mut Deps) {
        if self.loop_scope.iter().any(|l| l == name) && !matches!(kind, IdentKind::Prop) {
            out.loop_bindings.insert(name.into());
            return;
        }
        match kind {
            IdentKind::Prop => {
                out.props.insert(name.into());
            }
            IdentKind::State => {
                out.state.insert(name.into());
            }
            IdentKind::Setter => {
                out.setters.insert(name.into());
            }
            IdentKind::Import { source, imported } => {
                out.imports.insert((source.clone(), imported.clone()));
            }
            IdentKind::Global => {
                out.globals.insert(name.into());
                if BROWSER_GLOBALS.contains(&name) {
                    out.browser = true;
                }
            }
            IdentKind::LoopBinding => {
                out.loop_bindings.insert(name.into());
            }
            IdentKind::Local => self.local(name, out),
            IdentKind::Unknown => out.opaque = true,
        }
    }

    fn local(&mut self, name: &str, out: &mut Deps) {
        if let Some(d) = self.memo.get(name) {
            out.union(&d.clone());
            return;
        }
        if self.visiting.iter().any(|v| v == name) {
            return;
        }
        let Some(def) = self.cx.locals.get(name) else {
            out.module_locals.insert(name.into());
            // A module helper reads what its body reads (transitively).
            if let Some(captures) = self.cx.module.get(name) {
                self.visiting.push(name.into());
                let saved = std::mem::take(&mut self.loop_scope);
                let mut d = Deps::default();
                for (n, k) in captures.clone() {
                    self.ident(&n, &k, &mut d);
                }
                self.loop_scope = saved;
                self.visiting.pop();
                self.memo.insert(name.into(), d.clone());
                out.union(&d);
            }
            return;
        };
        let mut d = Deps::default();
        self.visiting.push(name.into());
        // A body local is evaluated outside any loop.
        let saved = std::mem::take(&mut self.loop_scope);
        match def {
            LocalDef::Value(e) => self.raw(&e.clone(), &mut d),
            LocalDef::Placed(p) => d.union(p),
            LocalDef::Opaque => d.opaque = true,
        }
        self.loop_scope = saved;
        self.visiting.pop();
        self.memo.insert(name.into(), d.clone());
        out.union(&d);
    }

    fn expr(&mut self, e: &Expr, out: &mut Deps) {
        match e {
            Expr::Raw(r) | Expr::Server(ServerExpr(r)) => self.raw(r, out),
            Expr::Precomputed { inputs, .. } => out.props.extend(inputs.iter().cloned()),
            Expr::ClientOnly { .. } => out.opaque = true,
        }
    }

    fn node(&mut self, n: &Node, out: &mut Deps) {
        match n {
            Node::Element {
                attrs, children, ..
            } => {
                for a in attrs {
                    match a {
                        Attr::Dynamic { value, .. } | Attr::Spread(value) => self.expr(value, out),
                        Attr::Static { .. } | Attr::Event { .. } | Attr::Ref { .. } => {}
                    }
                }
                self.nodes(children, out);
            }
            Node::Text(_) | Node::Outlet => {}
            Node::Slot(e) => self.expr(e, out),
            Node::If { cond, then, else_ } => {
                self.expr(cond, out);
                self.nodes(then, out);
                self.nodes(else_, out);
            }
            Node::For {
                source,
                item,
                index,
                key,
                body,
            } => {
                self.expr(source, out);
                let n = self.loop_scope.len();
                self.loop_scope.push(item.clone());
                self.loop_scope.extend(index.iter().cloned());
                self.expr(key, out);
                self.nodes(body, out);
                self.loop_scope.truncate(n);
            }
            Node::Component {
                props, children, ..
            } => {
                for (_, v) in props {
                    self.expr(v, out);
                }
                self.nodes(children, out);
            }
            Node::Fragment(children) => self.nodes(children, out),
        }
    }

    fn nodes(&mut self, ns: &[Node], out: &mut Deps) {
        for n in ns {
            self.node(n, out);
        }
    }
}
