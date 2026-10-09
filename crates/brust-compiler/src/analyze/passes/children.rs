//! Child components (spec §3.2 rule 4, §3.4, §7.4): resolve and compile each
//! `<Child/>`, record its tier, link reactive props into native children
//! (`ChildLink`, `_pN`), and turn `react` children into islands rendered by an
//! `Ssr` job — refusing props an island cannot hydrate from.
use super::deps::{Deps, minimal_paths};
use super::{PassCtx, PassState, run_passes};
use crate::analyze::component::finish_diagnostics;
use crate::analyze::modules::{Entry, Export, Lookup, cache_key, compile, resolve};
use crate::ir::{
    ChildLink, ChildRef, ComponentIR, Diagnostic, Expr, JobDecl, JobKind, JsCtx, Node, ServerExpr,
    Tier, component_id, named_component_id,
};
use std::collections::HashMap;
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
        ssr_outputs: HashMap::new(),
    };
    let mut template = std::mem::replace(&mut ir.template, Node::Fragment(vec![]));
    w.node(&mut template);
    ir.template = template;
    ir.child_links.extend(w.links);
    ir.children.extend(w.refs);
    ir.jobs.extend(w.jobs);
    ir.diagnostics.extend(w.diagnostics);
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
    ssr_outputs: HashMap<String, u32>,
}

/// A resolved child.
struct Child {
    id: Option<String>,
    path: Option<String>,
    tier: Tier,
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
                let src = (
                    self.paths_of(source),
                    !self.deps_of(source).state.is_empty(),
                );
                let n = self.loop_scope.len();
                self.loop_scope.push(item.clone());
                self.loop_scope.extend(index.iter().cloned());
                self.lists.push(src);
                self.items.push(item.clone());
                body.iter_mut().for_each(|c| self.node(c));
                self.items.pop();
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

    fn resolve_child(
        &mut self,
        name: &str,
        source: Option<&str>,
        imported: Option<&str>,
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
                };
            }
            self.diagnostics.push(Diagnostic::fallback(
                "external-component",
                format!("<{name}> comes from the package {source}; it renders as a React island"),
                loc,
                "use a component from this project to keep it native",
            ));
            return Child {
                id: None,
                path: None,
                tier: react("external component"),
            };
        };
        let export = match imported {
            None | Some("default") => Export::Default,
            Some(n) => Export::Named(n.to_string()),
        };
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
                    };
                };
                ctx.modules
                    .borrow_mut()
                    .insert(key.clone(), Entry::InProgress);
                run_passes(&mut child, ctx);
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
        let tier = match lookup {
            Lookup::Compiled(ir) => ir.tier.clone(),
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
        Child { id, path, tier }
    }

    fn component(&mut self, n: &mut Node) {
        let Node::Component {
            loc,
            name,
            source,
            imported,
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
        let child = self.resolve_child(name, source.as_deref(), imported.as_deref(), *loc);
        *tier = child.tier.clone();
        if !self.refs.iter().any(|r| r.name == *name) {
            self.refs.push(ChildRef {
                name: name.clone(),
                id: child.id.clone(),
                path: child.path.clone(),
                tier: child.tier.clone(),
            });
        }
        let child_id = child.id.clone().unwrap_or_else(|| name.clone());
        match &child.tier {
            Tier::React { client_only, .. } => {
                let mut inputs = Vec::new();
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
                    } else {
                        None
                    };
                    if let Some(why) = why {
                        ok = false;
                        self.diagnostics.push(Diagnostic::error(
                            "island-prop",
                            format!("prop `{k}` passed to the React island <{name}> is {why}"),
                            *loc,
                            "pass JSON values; a React island hydrates from JSON",
                        ));
                        continue;
                    }
                    inputs.extend(self.paths_of(v));
                }
                if !children.is_empty() {
                    self.diagnostics.push(Diagnostic::fallback(
                        "island-children",
                        format!("JSX children passed to the React island <{name}>"),
                        *loc,
                        "render the children inside the island component",
                    ));
                }
                if ok && self.lists.iter().any(|(_, stateful)| *stateful) {
                    ok = false;
                    self.diagnostics.push(Diagnostic::error(
                        "island-prop",
                        format!("the React island <{name}> sits in a list that changes with state"),
                        *loc,
                        "render the list inside a React component, or key it on props only",
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
                    });
                }
            }
            _ => {
                // Native / static child: link when any prop changes after first
                // paint or is a function (§7.4).
                let needs_link = props.iter().any(|(_, v)| {
                    let d = self.deps_of(v);
                    matches!(v, Expr::ClientOnly { .. })
                        || !d.state.is_empty()
                        || !d.loop_bindings.is_empty()
                });
                if needs_link {
                    let id = self.links.len() as u32 + 1;
                    for (_, v) in props.iter() {
                        // The parent chunk computes `_pN`: every prop is a client read.
                        let deps = self.deps_of(v);
                        let raw = match v {
                            Expr::Server(ServerExpr(r)) => Some(r.clone()),
                            Expr::Precomputed { slot, .. } => {
                                self.st.slots.get(slot).map(|i| i.raw.clone())
                            }
                            _ => None,
                        };
                        self.st.client_uses.push(super::ClientUse {
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
                }
            }
        }
        // After this node's own link id: `_pN` follow document order.
        children.iter_mut().for_each(|c| self.node(c));
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
