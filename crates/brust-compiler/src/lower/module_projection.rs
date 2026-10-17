//! F362: a module-level list the client rows run over ships only the fields the chunk reads.
//!
//! A row list over module data (`const ITEMS = [{ id, name, secret }]`, rows `ITEMS.map(it => …)`) that runs as a client
//! `x-for` prints its source into the chunk. React ships it whole too (F361, parity); here the chunk keeps only the keys
//! its code reads from a row. One choke point over the code the chunk prints (every member, handler, effect, state
//! init and derived value), never shape by shape: any use it does not recognise ships the list whole, as before.
//!
//! F71 (`analyze/passes/projection.rs`) does the same for a list PROP, over the template and the placement uses, and
//! projects the `x-props` value; this reads the printed chunk instead, because a module list is printed into it whole.
//!
//! Recognised, per list `B` (a module `const` whose value is an array of object literals of literal values):
//! - `B` as a list source (a `_lN` member that is exactly `B`) or `B.length`;
//! - in every printed expression, the row binding of a list over `B` only as the root of a member chain `it.f…`
//!   (keeps the key `f`, whole). A call on such a chain (`it.f()`, `it.f.g()`) is not a read (Mellow F2).
//!
//! Anything else ships `B` whole: `B` or the row binding bare (passed, spread, compared, returned), indexed, captured
//! by code printed as written (an `Opaque` value, a block-bodied arrow) or by another printed module declaration
//! (Mellow F1), JSX in client code, a destructured row binding, a write (an `Opaque` value or a method call on `B`).
//!
//! PR2: an imported `B` (`import { B } from './data'`, a relative module) is the `export const B = [...]` its module
//! declares on its own and never writes, read from the source as written (`analyze::const_fold::imported_literal`, Mellow
//! F3: nothing runs, so the value is the same on every build). Projected, the chunk declares `const B = [...]` instead of
//! importing it. `brust dev` rebuilds the whole app on every change (`dev/bun.ts`), so an edit of the data module is
//! read again (C4).
use super::common::ImportUse;
use crate::ir::{ArrowBody, ComponentIR, Expr, JsCtx, Node, RawExpr, RawKind};
use std::collections::{BTreeMap, BTreeSet};

/// What the chunk prints projected: module lists by name, and imported lists by their import (PR2), each with the
/// statement printed in place of the source's declaration / of the import.
#[derive(Default)]
pub struct Projected {
    pub module: BTreeMap<String, String>,
    /// The statement and the data module's path from the root (the build checks the module left the client graph).
    pub imports: BTreeMap<ImportUse, (String, String)>,
}

pub fn projections(
    ir: &ComponentIR,
    template: &Node,
    need: &BTreeSet<String>,
    imports: &BTreeSet<ImportUse>,
    code: &[&RawExpr],
    lists: &[&RawExpr],
) -> Projected {
    let mut out = Projected::default();
    for name in need {
        if let Some(rows) = literal_rows(ir, name)
            && let Some(stmt) = project(ir, name, &rows, template, need, code, lists)
        {
            out.module.insert(name.clone(), stmt);
        }
    }
    // PR2 (Mellow F3): an imported `export const` read from its module as written (`ir.client_import_lists`).
    for u in imports {
        let (local, source, imported) = u;
        if need.contains(local) {
            continue;
        }
        if let Some((path, value)) = ir
            .client_import_lists
            .get(&(source.clone(), imported.clone()))
            && let Some(rows) = rows_of(value)
            && let Some(stmt) = project(ir, local, &rows, template, need, code, lists)
        {
            out.imports.insert(u.clone(), (stmt, path.clone()));
        }
    }
    out
}

fn project(
    ir: &ComponentIR,
    name: &str,
    rows: &[&Vec<(String, RawExpr)>],
    template: &Node,
    need: &BTreeSet<String>,
    code: &[&RawExpr],
    lists: &[&RawExpr],
) -> Option<String> {
    // F1: another declaration the chunk prints reads it as written.
    let captured = ir.module_scope.iter().any(|(m, captures)| {
        m != name && need.contains(m) && captures.iter().any(|(c, _)| c == name)
    });
    if captured {
        return None;
    }
    // The rows run in this chunk: one of its list members is exactly `B`.
    let runs = lists
        .iter()
        .any(|l| matches!(&l.kind, RawKind::Ident { name: n, .. } if n == name));
    if !runs {
        return None;
    }
    let mut items = BTreeSet::new();
    if !row_bindings(template, name, &mut items) || items.is_empty() {
        return None;
    }
    let mut s = Scan {
        list: name,
        items: &items,
        keys: BTreeSet::new(),
    };
    for r in code {
        let source = lists.iter().any(|l| std::ptr::eq(*l, *r));
        s.root(r, source).ok()?;
    }
    print(name, rows, &s.keys)
}

/// The elements of a module `const` declared on its own whose value is an array of object literals of literal values.
fn literal_rows<'a>(ir: &'a ComponentIR, name: &str) -> Option<Vec<&'a Vec<(String, RawExpr)>>> {
    let decl = ir
        .module_decls
        .iter()
        .find(|d| d.names.iter().any(|n| n == name))?;
    if decl.names.len() != 1 {
        return None;
    }
    // `ConstVal::mutated` is not asked: it is a folding rule (any call a row value reaches counts). What this chunk does
    // to the list is in the code it prints, scanned below (a write is an `Opaque` value or a method call on `B` or on a
    // row); what the server does to it never reaches the keys the chunk keeps.
    let c = decl.consts.iter().find(|c| c.name == name)?;
    rows_of(&c.value)
}

/// The elements of an array of object literals of literal values.
fn rows_of(value: &RawExpr) -> Option<Vec<&Vec<(String, RawExpr)>>> {
    let RawKind::Array(elements) = &value.kind else {
        return None;
    };
    elements
        .iter()
        .map(|e| match &e.kind {
            RawKind::Object(pairs) if pairs.iter().all(|(_, v)| literal(v)) => Some(pairs),
            _ => None,
        })
        .collect()
}

/// A value with no names in it.
fn literal(r: &RawExpr) -> bool {
    match &r.kind {
        RawKind::Lit(_) => true,
        RawKind::Unary { value, .. } => literal(value),
        RawKind::Array(xs) => xs.iter().all(literal),
        RawKind::Object(pairs) => pairs.iter().all(|(_, v)| literal(v)),
        RawKind::Template { parts, .. } => parts.is_empty(),
        _ => false,
    }
}

/// The row bindings of every list over exactly `name`; false when one is not a plain name (a destructured row).
fn row_bindings(n: &Node, name: &str, out: &mut BTreeSet<String>) -> bool {
    let all =
        |ns: &[Node], out: &mut BTreeSet<String>| ns.iter().all(|c| row_bindings(c, name, out));
    match n {
        Node::For {
            source, item, body, ..
        } => {
            if let Expr::Raw(RawExpr {
                kind: RawKind::Ident { name: s, .. },
                ..
            }) = source
                && s == name
            {
                if !is_ident(item) {
                    return false;
                }
                out.insert(item.clone());
            }
            all(body, out)
        }
        Node::Element { children, .. }
        | Node::Component { children, .. }
        | Node::Fragment(children) => all(children, out),
        Node::If { then, else_, .. } => all(then, out) && all(else_, out),
        Node::Text(_) | Node::Slot(_) | Node::Outlet => true,
    }
}

fn is_ident(s: &str) -> bool {
    let mut cs = s.chars();
    cs.next()
        .is_some_and(|c| c.is_alphabetic() || c == '_' || c == '$')
        && cs.all(|c| c.is_alphanumeric() || c == '_' || c == '$')
}

struct Scan<'a> {
    list: &'a str,
    items: &'a BTreeSet<String>,
    /// The first key of every chain read from a row.
    keys: BTreeSet<String>,
}

impl Scan<'_> {
    /// A printed expression; `source`: it is a list member, where `B` itself is the recognised source.
    fn root(&mut self, r: &RawExpr, source: bool) -> Result<(), ()> {
        if source && matches!(&r.kind, RawKind::Ident { name, .. } if name == self.list) {
            return Ok(());
        }
        self.expr(r)
    }

    fn named(&self, n: &str) -> bool {
        n == self.list || self.items.contains(n)
    }

    /// The key a member chain rooted at a row binding reads first (`it.a.b` -> `a`).
    fn row_key<'r>(&self, r: &'r RawExpr) -> Option<&'r str> {
        let RawKind::Member { target, name, .. } = &r.kind else {
            return None;
        };
        match &target.kind {
            RawKind::Ident { name: root, .. } if self.items.contains(root) => Some(name),
            _ => self.row_key(target),
        }
    }

    fn expr(&mut self, r: &RawExpr) -> Result<(), ()> {
        match &r.kind {
            RawKind::Lit(_) => Ok(()),
            RawKind::Ident { name, .. } => {
                if self.named(name) {
                    Err(())
                } else {
                    Ok(())
                }
            }
            RawKind::Member { target, name, .. } => {
                if let Some(k) = self.row_key(r) {
                    self.keys.insert(k.to_string());
                    return Ok(());
                }
                if let RawKind::Ident { name: t, .. } = &target.kind
                    && t == self.list
                {
                    return if name == "length" { Ok(()) } else { Err(()) };
                }
                self.expr(target)
            }
            RawKind::Index { target, index } => {
                self.expr(target)?;
                self.expr(index)
            }
            RawKind::Call { callee, args } => {
                // F2: a method called on a row's chain may write it or read it as `this`.
                if self.row_key(callee).is_some() {
                    return Err(());
                }
                self.expr(callee)?;
                args.iter().try_for_each(|a| self.expr(a))
            }
            RawKind::Binary { left, right, .. } => {
                self.expr(left)?;
                self.expr(right)
            }
            RawKind::Unary { value, .. } => self.expr(value),
            RawKind::Cond { test, yes, no } => {
                self.expr(test)?;
                self.expr(yes)?;
                self.expr(no)
            }
            RawKind::Template { parts, .. } => parts.iter().try_for_each(|(p, _)| self.expr(p)),
            RawKind::Array(xs) => xs.iter().try_for_each(|x| self.expr(x)),
            RawKind::Object(pairs) => pairs.iter().try_for_each(|(_, v)| self.expr(v)),
            RawKind::Arrow {
                body: ArrowBody::Expr(body),
                ..
            } => self.expr(body),
            RawKind::Arrow { captures, .. } | RawKind::Opaque { captures, .. } => {
                if captures.iter().any(|(c, _)| self.named(c)) {
                    Err(())
                } else {
                    Ok(())
                }
            }
            RawKind::Jsx(_) => Err(()),
        }
    }
}

/// `const B = [...]` with each element keeping only `keys`; `None` when nothing would be dropped.
fn print(name: &str, rows: &[&Vec<(String, RawExpr)>], keys: &BTreeSet<String>) -> Option<String> {
    if rows
        .iter()
        .all(|pairs| pairs.iter().all(|(k, _)| keys.contains(k)))
    {
        return None;
    }
    let value = RawExpr {
        loc: 0,
        kind: RawKind::Array(
            rows.iter()
                .map(|pairs| RawExpr {
                    loc: 0,
                    kind: RawKind::Object(
                        pairs
                            .iter()
                            .filter(|(k, _)| keys.contains(k))
                            .cloned()
                            .collect(),
                    ),
                })
                .collect(),
        ),
    };
    Some(format!(
        "const {name} = {};",
        value.to_js_with(JsCtx::Client, &|_, _| None)
    ))
}
