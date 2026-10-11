//! Row projection (ledger F71, spec §3.2 rule 3): for a prop the client reads only as the
//! source of keyed lists, the fields of each row the client can read — the host's `x-props`
//! then carries `rows | project("id", "title")` instead of every field of every row. Any read
//! the pass cannot see through keeps the full value: a field that might be read is never dropped.
use super::children::{PlainPath, plain_path};
use super::deps::{minimal_paths, prop_path};
use super::{ClientUse, PassState};
use crate::ir::{
    ArrowBody, Attr, ComponentIR, Expr, IdentKind, Node, RawExpr, RawKind, ServerExpr,
};
use std::collections::{BTreeMap, BTreeSet};

/// What client code reads of one loop item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ItemRead {
    Fields(BTreeSet<String>),
    Whole,
}

/// Fills `ir.client_prop_projections` (ledger F71).
pub fn projection(ir: &mut ComponentIR, st: &PassState) {
    let mut out = BTreeMap::new();
    for root in &ir.client_props {
        if root == "*" {
            continue;
        }
        if let Some(fields) = project_root(root, ir, st) {
            out.insert(root.clone(), fields);
        }
    }
    ir.client_prop_projections = out;
}

fn project_root(root: &str, ir: &ComponentIR, st: &PassState) -> Option<Vec<String>> {
    let reads_root = |u: &ClientUse| {
        u.deps
            .props
            .iter()
            .any(|p| p == root || p.strip_prefix(root).is_some_and(|r| r.starts_with('.')))
    };
    let is_plain_source = |u: &ClientUse| {
        u.what == "a list the client updates"
            && u.raw
                .as_ref()
                .is_some_and(|(r, _)| prop_path(r).as_deref() == Some(root))
    };
    if st
        .all_uses
        .iter()
        .any(|u| reads_root(u) && !is_plain_source(u))
    {
        return None;
    }
    let mut read = ItemRead::Fields(BTreeSet::new());
    let mut lists = Vec::new();
    list_items(&ir.template, root, st, &mut lists);
    if lists.is_empty() {
        return None;
    }
    for (item, node) in &lists {
        let Node::For { key, body, .. } = node else {
            unreachable!()
        };
        raw_reads(key, st, item, &mut read);
        body.iter().for_each(|n| body_reads(n, st, item, &mut read));
        for u in &st.all_uses {
            match &u.raw {
                Some((r, scope)) if scope.iter().any(|s| s == item) => {
                    item_reads(r, item, &mut read)
                }
                None if u.deps.loop_bindings.contains(item) => read = ItemRead::Whole,
                _ => {}
            }
        }
    }
    match read {
        ItemRead::Whole => None,
        ItemRead::Fields(f) if f.is_empty() => None,
        ItemRead::Fields(f) => Some(minimal_paths(f)),
    }
}

/// The raw expression behind a placed value, when there is one to read.
fn raw_of<'a>(e: &'a Expr, st: &'a PassState) -> Option<&'a RawExpr> {
    match e {
        Expr::Raw(r) | Expr::Server(ServerExpr(r)) => Some(r),
        Expr::Precomputed { slot, .. } => st.slots.get(slot).map(|i| &i.raw),
        Expr::ClientOnly { .. } => None,
    }
}

fn raw_reads(e: &Expr, st: &PassState, item: &str, out: &mut ItemRead) {
    match e {
        // Its placement use carries the raw (scanned from `all_uses`).
        Expr::ClientOnly { .. } => {}
        other => {
            if let Some(r) = raw_of(other, st) {
                item_reads(r, item, out);
            }
        }
    }
}

fn body_reads(n: &Node, st: &PassState, item: &str, out: &mut ItemRead) {
    match n {
        Node::Element {
            attrs, children, ..
        } => {
            for a in attrs {
                match a {
                    Attr::Dynamic { value, .. } | Attr::Spread(value) => {
                        raw_reads(value, st, item, out)
                    }
                    Attr::Static { .. } | Attr::Event { .. } | Attr::Ref { .. } => {}
                }
            }
            children.iter().for_each(|c| body_reads(c, st, item, out));
        }
        Node::Slot(e) => raw_reads(e, st, item, out),
        Node::If { cond, then, else_ } => {
            raw_reads(cond, st, item, out);
            then.iter()
                .chain(else_)
                .for_each(|c| body_reads(c, st, item, out));
        }
        Node::For {
            source, key, body, ..
        } => {
            match raw_of(source, st).and_then(|r| plain_path(r, Some(item))) {
                // An inner list over a field of the row: that field whole.
                Some(PlainPath::Row(rest)) => {
                    let field = rest.trim_start_matches('.');
                    if field.is_empty() {
                        *out = ItemRead::Whole;
                    } else if let ItemRead::Fields(f) = out {
                        f.insert(field.to_string());
                    }
                }
                _ => raw_reads(source, st, item, out),
            }
            raw_reads(key, st, item, out);
            body.iter().for_each(|c| body_reads(c, st, item, out));
        }
        Node::Component {
            props, children, ..
        } => {
            for (_, v) in props {
                raw_reads(v, st, item, out);
            }
            children.iter().for_each(|c| body_reads(c, st, item, out));
        }
        Node::Fragment(cs) => cs.iter().for_each(|c| body_reads(c, st, item, out)),
        Node::Text(_) | Node::Outlet => {}
    }
}

/// `For` nodes whose source is the plain path `root` (not nested in another such list).
fn list_items<'a>(n: &'a Node, root: &str, st: &PassState, out: &mut Vec<(String, &'a Node)>) {
    match n {
        Node::For {
            source, item, body, ..
        } => {
            let plain = raw_of(source, st).and_then(|r| plain_path(r, None));
            if plain == Some(PlainPath::Props(root.to_string())) {
                out.push((item.clone(), n));
            } else {
                body.iter().for_each(|c| list_items(c, root, st, out));
            }
        }
        Node::Element { children, .. }
        | Node::Component { children, .. }
        | Node::Fragment(children) => children.iter().for_each(|c| list_items(c, root, st, out)),
        Node::If { then, else_, .. } => then
            .iter()
            .chain(else_)
            .for_each(|c| list_items(c, root, st, out)),
        Node::Text(_) | Node::Slot(_) | Node::Outlet => {}
    }
}

/// `item.a.b` → `"a.b"`; `None` unless `r` is a member chain rooted at `item` (optional chaining included).
fn item_path(r: &RawExpr, item: &str) -> Option<String> {
    match &r.kind {
        RawKind::Member { target, name, .. } => {
            if is_item(target, item) {
                Some(name.clone())
            } else {
                item_path(target, item).map(|p| format!("{p}.{name}"))
            }
        }
        _ => None,
    }
}

/// A bare `Ident { name == item, LoopBinding }`.
fn is_item(r: &RawExpr, item: &str) -> bool {
    matches!(&r.kind, RawKind::Ident { name, kind: IdentKind::LoopBinding } if name == item)
}

/// Adds the member paths of `item` that `r` reads; `Whole` as soon as the item escapes
/// (bare use, call argument, dynamic index, spread, opaque body, JSX, shadowing).
pub fn item_reads(r: &RawExpr, item: &str, out: &mut ItemRead) {
    if matches!(out, ItemRead::Whole) {
        return;
    }
    match &r.kind {
        RawKind::Lit(_) => {}
        RawKind::Ident { .. } => {
            if is_item(r, item) {
                *out = ItemRead::Whole;
            }
        }
        RawKind::Member { target, .. } => match item_path(r, item) {
            Some(p) => {
                if let ItemRead::Fields(f) = out {
                    f.insert(p);
                }
            }
            None => item_reads(target, item, out),
        },
        // `row[key]`, `row["k"]`, `row.xs[i]`: the shape of the read is not a path.
        RawKind::Index { target, index } => {
            if item_path(target, item).is_some() || is_item(target, item) {
                *out = ItemRead::Whole;
            } else {
                item_reads(target, item, out);
                item_reads(index, item, out);
            }
        }
        // A method on a field reads the field (`row.name.trim()`); a call taking the row
        // reads all of it (`fmt(row)`): the argument walk yields Whole.
        RawKind::Call { callee, args } => {
            match &callee.kind {
                RawKind::Member { target, .. } => item_reads(target, item, out),
                _ => item_reads(callee, item, out),
            }
            for a in args {
                item_reads(a, item, out);
            }
        }
        RawKind::Binary { left, right, .. } => {
            item_reads(left, item, out);
            item_reads(right, item, out);
        }
        RawKind::Unary { value, .. } => item_reads(value, item, out),
        RawKind::Cond { test, yes, no } => {
            item_reads(test, item, out);
            item_reads(yes, item, out);
            item_reads(no, item, out);
        }
        RawKind::Template { parts, .. } => {
            for (p, _) in parts {
                item_reads(p, item, out);
            }
        }
        RawKind::Array(xs) => {
            for x in xs {
                item_reads(x, item, out);
            }
        }
        RawKind::Object(ps) => {
            for (_, v) in ps {
                item_reads(v, item, out);
            }
        }
        RawKind::Arrow {
            params,
            body,
            captures,
        } => {
            // Shadowed: the arrow reads its own parameter.
            if params.iter().any(|p| p == item) {
                return;
            }
            match body {
                ArrowBody::Expr(e) => item_reads(e, item, out),
                ArrowBody::Block { .. } => {
                    if captures.iter().any(|(n, _)| n == item) {
                        *out = ItemRead::Whole;
                    }
                }
            }
        }
        RawKind::Jsx(_) => *out = ItemRead::Whole,
        RawKind::Opaque { captures, .. } => {
            if captures.iter().any(|(n, _)| n == item) {
                *out = ItemRead::Whole;
            }
        }
    }
}
