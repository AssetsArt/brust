//! F599 (D1', lead ruling AMENDMENT 1): the closed list of SAFE READ mentions of an app `export const`.
//!
//! The load-time judge reads an imported literal as plain DATA only when EVERY mention of that binding, in every module
//! of the build, is a safe read. This is not a graph of who can reach what: it is one syntactic scan per module.
//!
//! A HANDLE is a tracked binding (an import, or an exported literal of this module) or a value read from a handle by a
//! safe read: `h.name`, `h[k]`, an item an inline callback or a `for…of` hands over, the element a read method returns.
//! A mention of a handle is one of
//!
//! - SAFE (nothing recorded): the object of `h.name` / `h[k]` / `h?.name` / `h.length`; the operand of a spread inside an
//!   array or object literal; the right side of `in`; the receiver of a method of [`READ_METHODS`] (a callback only as a
//!   function written inline there); the iterated expression of `for…of`;
//! - FREE (a value used where it stands: an operand, a template part, an argument, a returned or stored value, a
//!   literal member): recorded with its read path, and an escape only if what the path reaches in the literal is a
//!   container (an object or an array), because a primitive cannot be written into and may go anywhere;
//! - ESCAPE: an assignment, update or `delete` through it, a call of it, `sort` / `reverse` / any other method of a
//!   handle, a namespace object used other than as `ns.name`, a dynamic `import()` of its module.
//!
//! Anything the scan does not model is an escape of every handle it mentions (`give_up`). Built-in prototypes are assumed
//! unpatched (the trust base, as for F597).
use crate::analyze::expr::Walk;
use crate::analyze::names::NameTable;
use bun_ast as js_ast;
use js_ast::b::B;
use js_ast::expr::Data as E;
use js_ast::stmt::Data as S;
use std::collections::{HashMap, HashSet};

/// One step of a read path.
#[derive(Debug, Clone, PartialEq)]
pub enum Seg {
    Key(String),
    Index(usize),
    /// Any member (a computed key that is not a literal, an item of a list).
    Any,
}

/// Where a mention of a handle stands, when it is not one of the safe reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pos {
    /// A value used where it stands: an escape only when what it reaches is a container.
    Free,
    /// Always an escape.
    Escape,
}

/// A tracked binding a mention is rooted at: a local binding by key, or a member of a namespace import.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Root {
    Binding(u32),
    Member(u32, String),
}

#[derive(Debug, Clone)]
pub struct Fact {
    pub root: Root,
    pub path: Vec<Seg>,
    pub pos: Pos,
}

/// What a module's mentions come to.
#[derive(Debug, Default)]
pub struct Mentions {
    pub facts: Vec<Fact>,
    /// Namespace import bindings used other than as `ns.name`: every export of their module escapes.
    pub namespace_escapes: Vec<u32>,
    /// The specifiers of dynamic `import()` calls; `None` for one that is not a string literal (any module may be meant).
    pub dynamic: Vec<Option<String>>,
}

/// A value an expression may stand for, as far as the scan follows it.
#[derive(Debug, Clone, Default)]
struct Val {
    /// The handles the value is, or (when `items`) the handles of the members of a fresh container made here.
    hs: Vec<Handle>,
    items: bool,
}

#[derive(Debug, Clone)]
struct Handle {
    root: Root,
    path: Vec<Seg>,
}

impl Val {
    fn none() -> Val {
        Val::default()
    }
    fn of(h: Handle) -> Val {
        Val {
            hs: vec![h],
            items: false,
        }
    }
    fn is_none(&self) -> bool {
        self.hs.is_empty()
    }
}

/// Methods a handle may be the receiver of: they read, or build a new value; `sort` / `reverse` change a handle in place
/// (an escape) and are safe only on a fresh container built here.
const READ_METHODS: &[&str] = &[
    "includes",
    "indexOf",
    "lastIndexOf",
    "join",
    "some",
    "every",
    "findIndex",
    "findLastIndex",
    "startsWith",
    "endsWith",
    "trim",
    "trimStart",
    "trimEnd",
    "toLowerCase",
    "toUpperCase",
    "padStart",
    "padEnd",
    "substring",
    "charAt",
    "toFixed",
    "toString",
    "replace",
    "replaceAll",
    "split",
    "find",
    "findLast",
    "at",
    "filter",
    "slice",
    "concat",
    "toSorted",
    "toReversed",
    "map",
    "flatMap",
    "sort",
    "reverse",
];
/// Those whose first argument is a callback (an inline function there; its parameters are handles of the items).
const CALLBACK_METHODS: &[&str] = &[
    "some",
    "every",
    "findIndex",
    "findLastIndex",
    "find",
    "findLast",
    "filter",
    "toSorted",
    "map",
    "flatMap",
    "sort",
];
/// Primitive results: nothing of the receiver comes out.
const PRIMITIVE_RESULT: &[&str] = &[
    "includes",
    "indexOf",
    "lastIndexOf",
    "join",
    "some",
    "every",
    "findIndex",
    "findLastIndex",
    "startsWith",
    "endsWith",
    "trim",
    "trimStart",
    "trimEnd",
    "toLowerCase",
    "toUpperCase",
    "padStart",
    "padEnd",
    "substring",
    "charAt",
    "toFixed",
    "toString",
    "replace",
    "replaceAll",
    "split",
];

/// The mentions of the tracked bindings in `ast`. `tracked` are the keys (`names.key_of`) of the import bindings and of
/// the exported literals of this module; `namespaces` the keys of the `import * as ns` bindings.
pub fn mentions(
    ast: &js_ast::Ast<'_>,
    names: &NameTable<'_>,
    tracked: &HashSet<u32>,
    namespaces: &HashSet<u32>,
) -> Mentions {
    let mut m = Scan {
        names,
        env: tracked
            .iter()
            .map(|k| {
                (
                    *k,
                    Val::of(Handle {
                        root: Root::Binding(*k),
                        path: Vec::new(),
                    }),
                )
            })
            .collect(),
        namespaces,
        out: Mentions::default(),
        returns: Vec::new(),
    };
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            m.stmt(stmt);
        }
    }
    m.out
}

struct Scan<'x, 'a> {
    names: &'x NameTable<'a>,
    /// Binding key → the handle it is (tracked bindings, callback parameters, `for…of` variables).
    env: HashMap<u32, Val>,
    namespaces: &'x HashSet<u32>,
    out: Mentions,
    /// One entry per inline callback being read: the values it returns. `None` for an ordinary function.
    returns: Vec<Option<Vec<Val>>>,
}

impl Scan<'_, '_> {
    // ---- recording ----

    fn consume(&mut self, v: &Val, pos: Pos) {
        for h in &v.hs {
            self.out.facts.push(Fact {
                root: h.root.clone(),
                path: h.path.clone(),
                pos,
            });
        }
    }

    fn free(&mut self, e: &js_ast::Expr) {
        let v = self.value(e);
        self.consume(&v, Pos::Free);
    }

    /// Everything `e` mentions is an escape: for a shape this scan does not model.
    fn give_up(&mut self, e: &js_ast::Expr) {
        let mut w = Walk::default();
        w.expr(e);
        self.give_up_refs(&w);
    }

    fn give_up_stmt(&mut self, s: &js_ast::Stmt) {
        let mut w = Walk::default();
        w.stmt(s);
        self.give_up_refs(&w);
    }

    fn give_up_refs(&mut self, w: &Walk) {
        for r in &w.used {
            let k = self.names.key_of(*r);
            if let Some(v) = self.env.get(&k).cloned() {
                self.consume(&v, Pos::Escape);
            }
            if self.namespaces.contains(&k) {
                self.out.namespace_escapes.push(k);
            }
        }
        // a dynamic import inside an unmodelled shape: the specifier is not read here
        if w.dynamic_import.is_some() {
            self.out.dynamic.push(None);
        }
    }

    // ---- values ----

    fn ident_val(&mut self, r: js_ast::Ref) -> Val {
        let k = self.names.key_of(r);
        if self.namespaces.contains(&k) {
            // a bare use of a namespace object (`ns.name` is read in `member`)
            self.out.namespace_escapes.push(k);
            return Val::none();
        }
        self.env.get(&k).cloned().unwrap_or_default()
    }

    fn ns_member(&self, target: &js_ast::Expr, member: &str) -> Option<Val> {
        let r = match &target.data {
            E::EIdentifier(id) => id.ref_,
            E::EImportIdentifier(id) => id.ref_,
            _ => return None,
        };
        let k = self.names.key_of(r);
        self.namespaces.contains(&k).then(|| {
            Val::of(Handle {
                root: Root::Member(k, member.to_string()),
                path: Vec::new(),
            })
        })
    }

    /// The handles reached by reading `seg` from each handle of `v` (a fresh container's members are its handles).
    fn read(v: &Val, seg: Seg) -> Val {
        if v.items {
            return Val {
                hs: v.hs.clone(),
                items: false,
            };
        }
        Val {
            hs: v
                .hs
                .iter()
                .map(|h| {
                    let mut path = h.path.clone();
                    path.push(seg.clone());
                    Handle {
                        root: h.root.clone(),
                        path,
                    }
                })
                .collect(),
            items: false,
        }
    }

    /// The items of a list handle: what `for…of`, a callback parameter or an element read gets.
    fn items_of(v: &Val) -> Val {
        Self::read(v, Seg::Any)
    }

    fn value(&mut self, e: &js_ast::Expr) -> Val {
        match &e.data {
            E::EIdentifier(id) => self.ident_val(id.ref_),
            E::EImportIdentifier(id) => self.ident_val(id.ref_),
            E::EString(_)
            | E::ENumber(_)
            | E::EBoolean(_)
            | E::ENull(_)
            | E::EUndefined(_)
            | E::EBigInt(_)
            | E::ERegExp(_)
            | E::EThis(_)
            | E::EMissing(_) => Val::none(),
            E::EDot(d) => {
                let name = String::from_utf8_lossy(d.name.slice()).into_owned();
                if let Some(v) = self.ns_member(&d.target, &name) {
                    return v;
                }
                let tv = self.value(&d.target);
                if name == "length" {
                    return Val::none();
                }
                Self::read(&tv, Seg::Key(name))
            }
            E::EIndex(i) => {
                let seg = match &i.index.data {
                    E::EString(s) => Some(Seg::Key(crate::analyze::expr::estring(s))),
                    E::ENumber(n)
                        if n.value() >= 0.0 && n.value().fract() == 0.0 && n.value() < 1e9 =>
                    {
                        Some(Seg::Index(n.value() as usize))
                    }
                    _ => None,
                };
                if let (Some(Seg::Key(k)), Some(v)) =
                    (&seg, self.ns_member_index(&i.target, &i.index))
                {
                    let _ = k;
                    return v;
                }
                self.free(&i.index);
                let tv = self.value(&i.target);
                Self::read(&tv, seg.unwrap_or(Seg::Any))
            }
            E::ECall(c) => self.call(c),
            E::EBinary(b) => self.binary(b),
            E::EUnary(u) => {
                use js_ast::OpCode as O;
                match u.op {
                    O::UnPreInc | O::UnPreDec | O::UnPostInc | O::UnPostDec | O::UnDelete => {
                        self.write(&u.value)
                    }
                    _ => self.free(&u.value),
                }
                Val::none()
            }
            E::EIf(i) => {
                self.free(&i.test);
                self.free(&i.yes);
                self.free(&i.no);
                Val::none()
            }
            E::EArray(a) => {
                let mut items = Val::none();
                for item in a.items.iter() {
                    match &item.data {
                        E::ESpread(sp) => {
                            let sv = self.value(&sp.value);
                            items.hs.extend(Self::items_of(&sv).hs);
                        }
                        E::EMissing(_) => {}
                        _ => self.free(item),
                    }
                }
                items.items = !items.hs.is_empty();
                items
            }
            E::EObject(o) => {
                let mut items = Val::none();
                for p in o.properties.iter() {
                    if let Some(k) = &p.key {
                        self.free(k);
                    }
                    if let Some(v) = &p.value {
                        if matches!(p.kind, js_ast::G::PropertyKind::Spread) {
                            let sv = self.value(v);
                            items.hs.extend(Self::items_of(&sv).hs);
                        } else {
                            self.free(v);
                        }
                    }
                    if let Some(i) = &p.initializer {
                        self.free(i);
                    }
                }
                items.items = !items.hs.is_empty();
                items
            }
            E::ETemplate(t) => {
                if let Some(tag) = &t.tag {
                    let tv = self.value(tag);
                    self.consume(&tv, Pos::Escape);
                }
                for p in t.parts().iter() {
                    self.free(&p.value);
                }
                Val::none()
            }
            E::ENew(n) => {
                let tv = self.value(&n.target);
                self.consume(&tv, Pos::Escape);
                for a in n.args.iter() {
                    self.arg(a);
                }
                Val::none()
            }
            E::EAwait(a) => {
                self.free(&a.value);
                Val::none()
            }
            E::EYield(y) => {
                if let Some(v) = &y.value {
                    self.free(v);
                }
                Val::none()
            }
            E::ESpread(sp) => {
                // outside a literal or a call: the members are handed on
                let sv = self.value(&sp.value);
                let items = Self::items_of(&sv);
                self.consume(&items, Pos::Free);
                Val::none()
            }
            E::EArrow(a) => {
                self.function(a.args.slice(), a.body.stmts.slice(), None);
                Val::none()
            }
            E::EFunction(f) => {
                self.function(f.func.args.slice(), f.func.body.stmts.slice(), None);
                Val::none()
            }
            E::EImport(i) => {
                match &i.expr.data {
                    E::EString(s) => self
                        .out
                        .dynamic
                        .push(Some(crate::analyze::expr::estring(s))),
                    _ => self.out.dynamic.push(None),
                }
                self.free(&i.expr);
                Val::none()
            }
            _ => {
                self.give_up(e);
                Val::none()
            }
        }
    }

    fn ns_member_index(&self, target: &js_ast::Expr, index: &js_ast::Expr) -> Option<Val> {
        match &index.data {
            E::EString(s) => self.ns_member(target, &crate::analyze::expr::estring(s)),
            _ => None,
        }
    }

    /// A call argument: a value handed on (a spread hands each member on).
    fn arg(&mut self, a: &js_ast::Expr) {
        match &a.data {
            E::ESpread(sp) => {
                let sv = self.value(&sp.value);
                let items = Self::items_of(&sv);
                self.consume(&items, Pos::Free);
            }
            _ => self.free(a),
        }
    }

    fn binary(&mut self, b: &js_ast::E::Binary) -> Val {
        use js_ast::OpCode as O;
        if !matches!(b.op.binary_assign_target(), js_ast::AssignTarget::None) {
            self.write(&b.left);
            self.free(&b.right);
            return Val::none();
        }
        match b.op {
            // `key in value`: the value is only asked
            O::BinIn => {
                self.free(&b.left);
                let _ = self.value(&b.right);
            }
            O::BinComma => {
                self.free(&b.left);
                return self.value(&b.right);
            }
            _ => {
                self.free(&b.left);
                self.free(&b.right);
            }
        }
        Val::none()
    }

    /// `target` is assigned to, updated or deleted: what it is reached through is written.
    fn write(&mut self, target: &js_ast::Expr) {
        match &target.data {
            E::EDot(d) => {
                if let Some(v) = self.ns_member(&d.target, &String::from_utf8_lossy(d.name.slice()))
                {
                    self.consume(&v, Pos::Escape);
                    return;
                }
                let tv = self.value(&d.target);
                self.consume(&tv, Pos::Escape);
            }
            E::EIndex(i) => {
                self.free(&i.index);
                let tv = self.value(&i.target);
                self.consume(&tv, Pos::Escape);
            }
            E::EIdentifier(_) | E::EImportIdentifier(_) => {
                let v = self.value(target);
                self.consume(&v, Pos::Escape);
            }
            _ => self.give_up(target),
        }
    }

    fn call(&mut self, c: &js_ast::E::Call) -> Val {
        if let E::EDot(d) = &c.target.data {
            let m = String::from_utf8_lossy(d.name.slice()).into_owned();
            if self.ns_member(&d.target, &m).is_none() {
                let rv = self.value(&d.target);
                if rv.is_none() {
                    // a method of something that is no handle: its arguments are read as any value, a function written
                    // there is read where it stands
                    for a in c.args.iter() {
                        self.arg(a);
                    }
                    return Val::none();
                }
                return self.method(c, &m, rv);
            }
        }
        // a call of a handle, or of anything else: the callee is called, the arguments handed on
        let tv = self.value(&c.target);
        self.consume(&tv, Pos::Escape);
        for a in c.args.iter() {
            self.arg(a);
        }
        Val::none()
    }

    /// `recv.m(args)` where `recv` is a handle (or a fresh container of handles).
    fn method(&mut self, c: &js_ast::E::Call, m: &str, rv: Val) -> Val {
        let escape = |s: &mut Self, rv: &Val| {
            s.consume(rv, Pos::Escape);
            for a in c.args.iter() {
                s.arg(a);
            }
            Val::none()
        };
        if !READ_METHODS.contains(&m) {
            return escape(self, &rv);
        }
        // sorting or reversing a handle changes it in place; on a fresh container made here it changes nothing shared
        if matches!(m, "sort" | "reverse") && !rv.items {
            return escape(self, &rv);
        }
        let callback = CALLBACK_METHODS.contains(&m);
        let item = Self::items_of(&rv);
        // (item, index, the list) for most callbacks; a comparator gets two items
        let cb_params = if matches!(m, "sort" | "toSorted") {
            vec![item.clone(), item.clone()]
        } else {
            vec![item.clone(), Val::none(), rv.clone()]
        };
        let mut returned: Vec<Val> = Vec::new();
        for (i, a) in c.args.iter().enumerate() {
            match &a.data {
                E::EArrow(f) if i == 0 && callback => {
                    returned = self.function(
                        f.args.slice(),
                        f.body.stmts.slice(),
                        Some(cb_params.clone()),
                    );
                }
                E::EFunction(f) if i == 0 && callback => {
                    returned = self.function(
                        f.func.args.slice(),
                        f.func.body.stmts.slice(),
                        Some(cb_params.clone()),
                    );
                }
                _ if i == 0 && callback => {
                    // a callback that is not a function written here: it may keep the items
                    self.consume(&item, Pos::Escape);
                    self.arg(a);
                }
                _ => self.arg(a),
            }
        }
        if PRIMITIVE_RESULT.contains(&m) {
            return Val::none();
        }
        match m {
            // an element of the list
            "find" | "findLast" | "at" => Val {
                hs: item.hs,
                items: false,
            },
            // a new list of the same members
            "filter" | "slice" | "concat" | "toSorted" | "toReversed" | "sort" | "reverse" => Val {
                hs: item.hs,
                items: true,
            },
            // a new list of what the callback returns: handles when it returns members of the list
            "map" | "flatMap" => {
                let mut hs = Vec::new();
                for r in returned {
                    if r.items {
                        // a list returned (flatMap, or a nested list): its members come out
                        hs.extend(r.hs);
                    } else {
                        hs.extend(r.hs);
                    }
                }
                Val {
                    items: !hs.is_empty(),
                    hs,
                }
            }
            _ => Val::none(),
        }
    }

    /// A function written here. As an inline callback (`items` is the handle of what it is called with) its parameters
    /// are handles and its returned values come back; as any other function its returned values are handed on.
    fn function(
        &mut self,
        args: &[js_ast::G::Arg],
        stmts: &[js_ast::Stmt],
        params: Option<Vec<Val>>,
    ) -> Vec<Val> {
        for (i, a) in args.iter().enumerate() {
            if let Some(d) = &a.default {
                self.free(d);
            }
            let given = params
                .as_ref()
                .and_then(|p| p.get(i))
                .cloned()
                .unwrap_or_default();
            match a.binding.data {
                B::BIdentifier(id) => {
                    let k = self.names.key_of(id.r#ref);
                    self.env.insert(k, given);
                }
                B::BMissing(_) => {}
                // a pattern: what it takes out of what it is given is read as any value
                _ => self.consume(&given, Pos::Escape),
            }
        }
        self.returns.push(if params.is_some() {
            Some(Vec::new())
        } else {
            None
        });
        for s in stmts {
            self.stmt(s);
        }
        self.returns.pop().flatten().unwrap_or_default()
    }

    // ---- statements ----

    fn stmt(&mut self, s: &js_ast::Stmt) {
        match &s.data {
            S::SBlock(b) => b.stmts.slice().iter().for_each(|x| self.stmt(x)),
            S::SExpr(x) => self.free(&x.value),
            S::SLocal(l) => {
                for d in l.decls.iter() {
                    if let Some(v) = &d.value {
                        self.free(v);
                    }
                }
            }
            S::SReturn(r) => {
                let v = match &r.value {
                    Some(v) => self.value(v),
                    None => Val::none(),
                };
                match self.returns.last_mut() {
                    Some(Some(rs)) => rs.push(v),
                    _ => self.consume(&v, Pos::Free),
                }
            }
            S::SThrow(t) => self.free(&t.value),
            S::SIf(i) => {
                self.free(&i.test);
                self.stmt(&i.yes);
                if let Some(no) = &i.no {
                    self.stmt(no);
                }
            }
            S::SFor(f) => {
                if let Some(init) = &f.init {
                    self.stmt(init);
                }
                if let Some(t) = &f.test {
                    self.free(t);
                }
                if let Some(u) = &f.update {
                    self.free(u);
                }
                self.stmt(&f.body);
            }
            S::SForOf(f) => {
                let iterated = self.value(&f.value);
                let item = Self::items_of(&iterated);
                self.bind_loop(&f.init, &item);
                self.stmt(&f.body);
            }
            S::SForIn(f) => {
                // the keys of a handle: its members are not handed over, but the loop may read them back
                let v = self.value(&f.value);
                self.consume(&v, Pos::Escape);
                self.stmt(&f.body);
            }
            S::SWhile(w) => {
                self.free(&w.test);
                self.stmt(&w.body);
            }
            S::SDoWhile(w) => {
                self.stmt(&w.body);
                self.free(&w.test);
            }
            S::STry(t) => {
                t.body.slice().iter().for_each(|x| self.stmt(x));
                if let Some(c) = &t.catch {
                    c.body.slice().iter().for_each(|x| self.stmt(x));
                }
                if let Some(f) = &t.finally {
                    f.stmts.slice().iter().for_each(|x| self.stmt(x));
                }
            }
            S::SSwitch(sw) => {
                self.free(&sw.test);
                for c in sw.cases.slice() {
                    if let Some(v) = &c.value {
                        self.free(v);
                    }
                    c.body.slice().iter().for_each(|x| self.stmt(x));
                }
            }
            S::SLabel(l) => self.stmt(&l.stmt),
            S::SFunction(f) => {
                self.function(f.func.args.slice(), f.func.body.stmts.slice(), None);
            }
            S::SExportDefault(ed) => match &ed.value {
                js_ast::StmtOrExpr::Expr(e) => self.free(e),
                js_ast::StmtOrExpr::Stmt(s) => self.stmt(s),
            },
            // an export list names a binding, it does not use its value; imports, directives, empties: nothing
            S::SImport(_)
            | S::SExportClause(_)
            | S::SExportFrom(_)
            | S::SExportStar(_)
            | S::SDirective(_)
            | S::SEmpty(_)
            | S::SBreak(_)
            | S::SContinue(_)
            | S::SComment(_)
            | S::STypeScript(_) => {}
            _ => self.give_up_stmt(s),
        }
    }

    /// The variable of a `for…of`: a handle of the items when it is a plain identifier; a pattern is read as any value.
    fn bind_loop(&mut self, init: &js_ast::Stmt, item: &Val) {
        match &init.data {
            S::SLocal(l) => {
                for d in l.decls.iter() {
                    match d.binding.data {
                        B::BIdentifier(id) => {
                            let k = self.names.key_of(id.r#ref);
                            self.env.insert(k, item.clone());
                        }
                        _ => self.consume(item, Pos::Escape),
                    }
                }
            }
            // `for (x of …)` assigns an existing variable
            _ => {
                self.consume(item, Pos::Escape);
                self.give_up_stmt(init);
            }
        }
    }
}
