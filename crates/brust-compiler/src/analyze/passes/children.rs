//! Child components (spec §3.2 rule 4, §3.4, §7.4): resolve and compile each
//! `<Child/>`, record its tier, link reactive props into native children
//! (`ChildLink`, `_pN`), and turn `react` children into islands rendered by an
//! `Ssr` job — refusing props an island cannot hydrate from.
use super::deps::{Deps, minimal_paths};
use super::{PassCtx, PassState, run_passes};
use crate::analyze::component::finish_diagnostics;
use crate::analyze::modules::{Entry, Export, Lookup, cache_key, compile, resolve};
use crate::ir::{
    Attr, ChildLink, ChildRef, ComponentIR, Diagnostic, Expr, IdentKind, InstanceRecord, JobDecl,
    JobKind, JsCtx, Node, RawExpr, RawKind, ServerExpr, Tier, component_id, named_component_id,
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
        list_uses: Vec::new(),
        loop_sources: Vec::new(),
        instance_counts: HashMap::new(),
        instances: Vec::new(),
        ssr_outputs: HashMap::new(),
        row_only: HashMap::new(),
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
    /// The enclosing `For` sources as client reads, used when a linked child sits in the row.
    list_uses: Vec<super::ClientUse>,
    /// The enclosing `For` sources as props paths (`None` = not a plain path).
    loop_sources: Vec<Option<String>>,
    instance_counts: HashMap<String, u32>,
    instances: Vec<InstanceRecord>,
    ssr_outputs: HashMap<String, u32>,
    /// `RowOnly` links by id with the client reads they imply, resolved after the walk.
    row_only: HashMap<u32, Vec<super::ClientUse>>,
}

/// A resolved child.
struct Child {
    id: Option<String>,
    path: Option<String>,
    tier: Tier,
    /// The compiled child has a precompute job or `useId` values the server must feed per instance.
    fed: bool,
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
                body.iter_mut().for_each(|c| self.node(c));
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
                    fed: false,
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
                fed: false,
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
                        fed: false,
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
        let mut fed = false;
        let tier = match lookup {
            Lookup::Compiled(ir) => {
                fed = ir.use_id_slots > 0
                    || ir
                        .jobs
                        .iter()
                        .any(|j| matches!(j.kind, JobKind::Precompute));
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
        }
    }

    /// Mirrors `lower::template::expr_reactive`.
    fn reads_state(&self, e: &Expr) -> bool {
        match e {
            Expr::Precomputed {
                state_dependent, ..
            } => *state_dependent,
            other => !self.deps_of(other).state.is_empty(),
        }
    }

    /// Whether the client can re-create the rows of this list: an enclosing list can, its
    /// source changes with state, or its body carries a directive of its own.
    fn row_reactive(&self, source: &Expr, body: &[Node], enclosing: bool) -> bool {
        enclosing || self.reads_state(source) || body.iter().any(|n| self.body_directive(n))
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
                    Attr::Dynamic { value, .. } => self.reads_state(value),
                    _ => false,
                }) || children.iter().any(|c| self.body_directive(c))
            }
            Node::Slot(e) => self.reads_state(e),
            Node::If { cond, then, else_ } => {
                self.reads_state(cond) || then.iter().chain(else_).any(|c| self.body_directive(c))
            }
            Node::For { source, body, .. } => {
                self.reads_state(source) || body.iter().any(|c| self.body_directive(c))
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
                        && let Some(uses) = self.row_only.remove(&id)
                    {
                        if reactive {
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
                if child.fed {
                    let record = InstanceRecord {
                        child_id: child_id.clone(),
                        k,
                        loops: self.loop_sources.clone(),
                        props: props
                            .iter()
                            .filter(|(_, v)| !matches!(v, Expr::ClientOnly { .. }))
                            .map(|(name, v)| (name.clone(), self.prop_path(v)))
                            .collect(),
                    };
                    self.instances.push(record);
                }
                // Native / static child (§7.4, F70): see `instance_needs_link`.
                let need = instance_needs_link(
                    &child.tier,
                    props
                        .iter()
                        .map(|(_, v)| (matches!(v, Expr::ClientOnly { .. }), self.deps_of(v))),
                );
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
                            self.row_only.insert(id, uses);
                        }
                        LinkNeed::None => unreachable!(),
                    }
                }
            }
        }
        // After this node's own link id: `_pN` follow document order.
        children.iter_mut().for_each(|c| self.node(c));
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
        if function || !d.state.is_empty() {
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

/// A value read as a path: from the props, or from the innermost row's item.
enum PlainPath {
    Props(String),
    /// `""` for the item itself, `.title` for a member of it.
    Row(String),
}

fn plain_path(r: &RawExpr, item: Option<&str>) -> Option<PlainPath> {
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
