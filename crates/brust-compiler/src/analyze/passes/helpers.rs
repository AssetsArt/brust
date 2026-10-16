//! F279: a call of a single-return module function with plain-read arguments becomes the function's expression with the
//! arguments put in (`ComponentIR::inline_fns`, proven primitive-valued by `plain_fn`), before placement: the server
//! prints the value where a precompute job would have had to run the function, so a child whose only job was such a
//! call (Radix's `data-state={getState(checked)}`) has none.
use super::children::pure_read;
use crate::ir::{Attr, ComponentIR, Expr, IdentKind, InlineFn, Node, RawExpr, RawKind, ServerExpr};
use std::collections::{HashMap, HashSet};

pub fn inline(ir: &mut ComponentIR) {
    if ir.inline_fns.is_empty() {
        return;
    }
    let fns: Vec<InlineFn> = ir.inline_fns.clone();
    // A function name that a local of the component hides is not the module function.
    let mut hidden: HashSet<String> = HashSet::new();
    hidden.extend(ir.derived.iter().map(|d| d.name.clone()));
    hidden.extend(ir.handlers.iter().map(|h| h.name.clone()));
    hidden.extend(ir.refs.iter().map(|r| r.name.clone()));
    hidden.extend(ir.id_bindings.iter().cloned());
    for s in &ir.state {
        hidden.insert(s.name.clone());
        hidden.extend(s.setter.iter().cloned());
    }
    hidden.extend(ir.props.iter().map(|p| p.local.clone()));
    let cx = Cx {
        fns: &fns,
        hidden: &hidden,
    };
    let mut template = std::mem::replace(&mut ir.template, Node::Fragment(Vec::new()));
    cx.node(&mut template);
    ir.template = template;
    for d in &mut ir.derived {
        cx.expr(&mut d.expr);
    }
    for s in &mut ir.state {
        cx.expr(&mut s.init);
    }
}

struct Cx<'a> {
    fns: &'a [InlineFn],
    hidden: &'a HashSet<String>,
}

impl Cx<'_> {
    fn expr(&self, e: &mut Expr) {
        if let Expr::Raw(r) | Expr::Server(ServerExpr(r)) = e {
            self.raw(r, 0);
        }
    }

    fn node(&self, n: &mut Node) {
        match n {
            Node::Element {
                attrs, children, ..
            } => {
                for a in attrs.iter_mut() {
                    match a {
                        Attr::Dynamic { value, .. }
                        | Attr::Spread(value)
                        | Attr::InnerHtml { value } => self.expr(value),
                        Attr::Static { .. }
                        | Attr::Event { .. }
                        | Attr::Ref { .. }
                        | Attr::ForwardRef => {}
                    }
                }
                children.iter_mut().for_each(|c| self.node(c));
            }
            Node::Fragment(cs) => cs.iter_mut().for_each(|c| self.node(c)),
            Node::Slot(e) => self.expr(e),
            Node::If {
                cond, then, else_, ..
            } => {
                self.expr(cond);
                then.iter_mut()
                    .chain(else_.iter_mut())
                    .for_each(|c| self.node(c));
            }
            Node::For {
                source, key, body, ..
            } => {
                self.expr(source);
                self.expr(key);
                body.iter_mut().for_each(|c| self.node(c));
            }
            Node::Component {
                props, children, ..
            } => {
                for (_, v) in props.iter_mut() {
                    self.expr(v);
                }
                children.iter_mut().for_each(|c| self.node(c));
            }
            Node::Text(_) | Node::Outlet => {}
        }
    }

    fn raw(&self, r: &mut RawExpr, depth: u8) {
        match &mut r.kind {
            RawKind::Member { target, .. } => self.raw(target, depth),
            RawKind::Index { target, index } => {
                self.raw(target, depth);
                self.raw(index, depth);
            }
            RawKind::Call { args, .. } => args.iter_mut().for_each(|a| self.raw(a, depth)),
            RawKind::Binary { left, right, .. } => {
                self.raw(left, depth);
                self.raw(right, depth);
            }
            RawKind::Unary { value, .. } => self.raw(value, depth),
            RawKind::Cond { test, yes, no } => {
                self.raw(test, depth);
                self.raw(yes, depth);
                self.raw(no, depth);
            }
            RawKind::Template { parts, .. } => {
                parts.iter_mut().for_each(|(p, _)| self.raw(p, depth))
            }
            RawKind::Array(xs) => xs.iter_mut().for_each(|x| self.raw(x, depth)),
            RawKind::Object(ps) => ps.iter_mut().for_each(|(_, v)| self.raw(v, depth)),
            RawKind::Lit(_)
            | RawKind::Ident { .. }
            | RawKind::Arrow { .. }
            | RawKind::Jsx(_)
            | RawKind::Opaque { .. } => {}
        }
        if depth >= 4 {
            return;
        }
        let RawKind::Call { callee, args } = &r.kind else {
            return;
        };
        let RawKind::Ident {
            name,
            kind: IdentKind::Local,
        } = &callee.kind
        else {
            return;
        };
        if self.hidden.contains(name) {
            return;
        }
        let Some(f) = self.fns.iter().find(|f| &f.name == name) else {
            return;
        };
        if f.params.len() != args.len() || !args.iter().all(pure_read) {
            return;
        }
        let map: HashMap<&str, &RawExpr> = f
            .params
            .iter()
            .map(String::as_str)
            .zip(args.iter())
            .collect();
        let mut body = f.body.clone();
        put(&mut body, &map);
        body.loc = r.loc;
        *r = body;
        // the body may call other inlinable helpers
        self.raw(r, depth + 1);
    }
}

/// `e` with every parameter replaced by its argument.
fn put(e: &mut RawExpr, map: &HashMap<&str, &RawExpr>) {
    match &mut e.kind {
        RawKind::Ident { name, kind } if !matches!(kind, IdentKind::Global) => {
            if let Some(a) = map.get(name.as_str()) {
                *e = (*a).clone();
            }
        }
        RawKind::Unary { value, .. } => put(value, map),
        RawKind::Binary { left, right, .. } => {
            put(left, map);
            put(right, map);
        }
        RawKind::Cond { test, yes, no } => {
            put(test, map);
            put(yes, map);
            put(no, map);
        }
        RawKind::Call { args, .. } => args.iter_mut().for_each(|a| put(a, map)),
        RawKind::Template { parts, .. } => parts.iter_mut().for_each(|(p, _)| put(p, map)),
        _ => {}
    }
}
