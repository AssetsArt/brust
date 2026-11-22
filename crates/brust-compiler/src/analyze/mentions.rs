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
//!
//! F610 follows a value further instead of ending its track (each is accepted because the scan now FOLLOWS the value to
//! where it is used, never because a shape "looks harmless"):
//! - D2: `const x = <handle or fresh container of handles>` (one identifier, `const`, any scope, not an exported binding)
//!   binds `x` to that value: every mention of `x` is judged by the same list (`x.path` is a safe read, `x.path = …` an
//!   escape). A function declared before the `const` it reads is seen because the module is scanned again with the
//!   bindings of the previous pass until they no longer change.
//! - D3: `a ?? b`, `a || b`, `a && b`, `c ? a : b` give the union of their branch values; the test of `?:` / `if` /
//!   `while`, `!x`, `typeof x`, `x === y`, `x !== y`, `x == null`, `x != null` are safe reads.
//! - D4: a call of a top-level app function (`Callees`) uses a SUMMARY of it (`summarize`): per parameter, the mentions of
//!   it that are not safe, and the parameter-rooted value it returns. At the call each recorded mention becomes a mention
//!   of the argument, and the call's value is the returned value with the arguments put in.
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
    /// F614 ruling (F610 D5 amended): the receiver of a method not on the list. Judged like `Free`: an escape only when
    /// the path reaches a container (a method there may change it in place); on a primitive it is a method of the
    /// built-in prototype (the trust base), and a primitive cannot be written into.
    Method,
}

/// A tracked binding a mention is rooted at: a local binding by key, or a member of a namespace import.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Root {
    Binding(u32),
    Member(u32, String),
    /// F610 D4: the `n`th parameter of a function being summarised.
    Param(u32),
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

/// A value an expression may stand for, as far as the scan follows it: one of the handles `hs`, or a fresh container
/// made here whose members are among `items` (F610: both at once after `a ?? b`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Val {
    hs: Vec<Handle>,
    items: Vec<Handle>,
}

#[derive(Debug, Clone, PartialEq)]
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
            items: Vec::new(),
        }
    }
    fn fresh(items: Vec<Handle>) -> Val {
        Val {
            hs: Vec::new(),
            items,
        }
    }
    fn is_none(&self) -> bool {
        self.hs.is_empty() && self.items.is_empty()
    }
    /// The union of two values (D3, and a binding seen in two passes).
    fn add(&mut self, o: Val) {
        for h in o.hs {
            if !self.hs.contains(&h) {
                self.hs.push(h);
            }
        }
        for h in o.items {
            if !self.items.contains(&h) {
                self.items.push(h);
            }
        }
    }
    fn all(&self) -> impl Iterator<Item = &Handle> {
        self.hs.iter().chain(self.items.iter())
    }
}

/// F610 D4: what a call of a top-level app function does with its arguments.
#[derive(Debug, Clone, Default)]
pub struct Summary {
    /// How many parameters it names (all plain identifiers).
    pub params: usize,
    /// The mentions of its parameters that are not safe: (parameter, read path, position).
    pub uses: Vec<(u32, Vec<Seg>, Pos)>,
    /// What it returns, as far as it is made of parameter-rooted handles (or a fresh container of them).
    ret: Val,
}

impl Summary {
    /// F614: the read paths of parameter `i` that the function returns (itself, or as a member of a fresh container).
    pub fn returned(&self, i: u32) -> Vec<Vec<Seg>> {
        self.ret
            .all()
            .filter(|h| h.root == Root::Param(i))
            .map(|h| h.path.clone())
            .collect()
    }
}

/// F610 D4: the summary of the function a call of the binding `callee` (a key of the module being scanned) reaches, made
/// `depth` summaries deep; `None` ends the track (today's refusal).
pub trait Callees {
    fn summary(&self, callee: u32, depth: u32) -> Option<std::rc::Rc<Summary>>;
}

/// No function is followed (a scan without the build's modules).
pub struct NoCallees;
impl Callees for NoCallees {
    fn summary(&self, _: u32, _: u32) -> Option<std::rc::Rc<Summary>> {
        None
    }
}

/// D4: at most this many summaries nested in one another WHILE a summary is made; a memoised summary is reused at any
/// depth (lead AMENDMENT 2: no depth limit on what a reader reaches; recursion is the condition).
pub const MAX_SUMMARY_DEPTH: u32 = 3;
/// D2: passes over a module (or a summarised body) before the bindings settle; past it, nothing is followed.
const MAX_PASSES: usize = 4;

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
    callees: &dyn Callees,
) -> Mentions {
    let env: HashMap<u32, Val> = tracked
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
        .collect();
    let mut seed: HashMap<u32, Val> = HashMap::new();
    for _ in 0..MAX_PASSES {
        let mut m = Scan::new(names, env.clone(), namespaces, tracked, callees, 0, &seed);
        for part in ast.parts.iter() {
            for stmt in part.stmts.slice() {
                m.stmt(stmt);
            }
        }
        if m.bound == seed {
            return m.out;
        }
        seed = m.bound;
    }
    // D2: the bindings never settled: every tracked binding escapes (nothing is followed)
    let mut out = Mentions::default();
    for k in tracked {
        out.facts.push(Fact {
            root: Root::Binding(*k),
            path: Vec::new(),
            pos: Pos::Escape,
        });
    }
    out.namespace_escapes.extend(namespaces.iter().copied());
    out
}

/// F610 D4: the summary of the top-level function bound to `fn_key` in `ast` (`function f`, or `const f = function /
/// arrow`), or `None` when it has none: a parameter that is not a plain identifier (destructured, a default, a rest
/// parameter), a body that uses `this` or `arguments`, or any shape the scan does not model.
pub fn summarize(
    ast: &js_ast::Ast<'_>,
    names: &NameTable<'_>,
    fn_key: u32,
    callees: &dyn Callees,
    depth: u32,
) -> Option<Summary> {
    let (args, stmts, rest) = top_level_fn(ast, names, fn_key)?;
    if rest {
        return None;
    }
    let mut params: Vec<u32> = Vec::new();
    for a in args {
        if a.default.is_some() {
            return None;
        }
        match a.binding.data {
            B::BIdentifier(id) => params.push(names.key_of(id.r#ref)),
            _ => return None,
        }
    }
    let env: HashMap<u32, Val> = params
        .iter()
        .enumerate()
        .map(|(i, k)| {
            (
                *k,
                Val::of(Handle {
                    root: Root::Param(i as u32),
                    path: Vec::new(),
                }),
            )
        })
        .collect();
    let empty = HashSet::new();
    let mut seed: HashMap<u32, Val> = HashMap::new();
    for _ in 0..MAX_PASSES {
        let mut m = Scan::new(names, env.clone(), &empty, &empty, callees, depth, &seed);
        m.summary_mode = true;
        m.returns.push(Some(Vec::new()));
        for s in stmts {
            m.stmt(s);
        }
        let returned = m.returns.pop().flatten().unwrap_or_default();
        if m.unmodelled {
            return None;
        }
        if m.bound == seed {
            let mut ret = Val::none();
            for v in returned {
                ret.add(v);
            }
            ret.hs.retain(|h| matches!(h.root, Root::Param(_)));
            ret.items.retain(|h| matches!(h.root, Root::Param(_)));
            let uses = m
                .out
                .facts
                .into_iter()
                .filter_map(|f| match f.root {
                    Root::Param(i) => Some((i, f.path, f.pos)),
                    _ => None,
                })
                .collect();
            return Some(Summary {
                params: params.len(),
                uses,
                ret,
            });
        }
        seed = m.bound;
    }
    None
}

/// The parameters, body and rest flag of the top-level function bound to `fn_key`.
fn top_level_fn<'s>(
    ast: &'s js_ast::Ast<'_>,
    names: &NameTable<'_>,
    fn_key: u32,
) -> Option<(&'s [js_ast::G::Arg], &'s [js_ast::Stmt], bool)> {
    use js_ast::flags::Function as F;
    let of_fn = |f: &'s js_ast::G::Fn| {
        (
            f.args.slice(),
            f.body.stmts.slice(),
            f.flags.contains(F::HasRestArg),
        )
    };
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            let s = match &stmt.data {
                S::SExportDefault(d) => match &d.value {
                    js_ast::StmtOrExpr::Stmt(s) => s,
                    js_ast::StmtOrExpr::Expr(_) => continue,
                },
                _ => stmt,
            };
            match &s.data {
                S::SFunction(f) => {
                    if f.func
                        .name
                        .as_ref()
                        .is_some_and(|n| names.key_of(n.ref_) == fn_key)
                    {
                        return Some(of_fn(&f.func));
                    }
                }
                S::SLocal(l) if matches!(l.kind, js_ast::S::Kind::KConst) => {
                    for d in l.decls.iter() {
                        let B::BIdentifier(id) = d.binding.data else {
                            continue;
                        };
                        if names.key_of(id.r#ref) != fn_key {
                            continue;
                        }
                        return match d.value.as_ref().map(|v| &v.data) {
                            Some(E::EArrow(a)) => {
                                Some((a.args.slice(), a.body.stmts.slice(), a.has_rest_arg))
                            }
                            Some(E::EFunction(f)) => Some(of_fn(&f.func)),
                            _ => None,
                        };
                    }
                }
                _ => {}
            }
        }
    }
    None
}

struct Scan<'x, 'a> {
    names: &'x NameTable<'a>,
    /// Binding key → the handle it is (tracked bindings, callback parameters, `for…of` variables, D2 constants).
    env: HashMap<u32, Val>,
    namespaces: &'x HashSet<u32>,
    /// The tracked bindings: an exported `const` is never a D2 alias (other modules see it by its own name).
    tracked: &'x HashSet<u32>,
    out: Mentions,
    /// One entry per inline callback being read: the values it returns. `None` for an ordinary function.
    returns: Vec<Option<Vec<Val>>>,
    callees: &'x dyn Callees,
    /// How many summaries deep this scan is (0: a module).
    depth: u32,
    /// D2: the constants bound in the previous pass (seen before their declaration: a function declared above them).
    seed: &'x HashMap<u32, Val>,
    /// D2: the constants bound in this pass.
    bound: HashMap<u32, Val>,
    /// D4: scanning a function for its summary: `this`, `arguments` or an unmodelled shape means no summary.
    summary_mode: bool,
    unmodelled: bool,
}

impl<'x, 'a> Scan<'x, 'a> {
    fn new(
        names: &'x NameTable<'a>,
        mut env: HashMap<u32, Val>,
        namespaces: &'x HashSet<u32>,
        tracked: &'x HashSet<u32>,
        callees: &'x dyn Callees,
        depth: u32,
        seed: &'x HashMap<u32, Val>,
    ) -> Self {
        for (k, v) in seed {
            env.entry(*k).or_default().add(v.clone());
        }
        Scan {
            names,
            env,
            namespaces,
            tracked,
            out: Mentions::default(),
            returns: Vec::new(),
            callees,
            depth,
            seed,
            bound: HashMap::new(),
            summary_mode: false,
            unmodelled: false,
        }
    }

    /// D2: `const k = v`: `k` stands for `v` (with what the previous pass saw).
    fn bind(&mut self, k: u32, v: Val) {
        let mut u = self.seed.get(&k).cloned().unwrap_or_default();
        u.add(v);
        if let Some(b) = self.bound.get(&k) {
            u.add(b.clone());
        }
        if u.is_none() {
            return;
        }
        self.env.insert(k, u.clone());
        self.bound.insert(k, u);
    }

    // ---- recording ----

    fn consume(&mut self, v: &Val, pos: Pos) {
        for h in v.all() {
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
        self.unmodelled = true;
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
        if self.summary_mode && self.names.name(r) == "arguments" && !self.env.contains_key(&k) {
            self.unmodelled = true;
        }
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
        let mut hs: Vec<Handle> =
            v.hs.iter()
                .map(|h| {
                    let mut path = h.path.clone();
                    path.push(seg.clone());
                    Handle {
                        root: h.root.clone(),
                        path,
                    }
                })
                .collect();
        for h in &v.items {
            if !hs.contains(h) {
                hs.push(h.clone());
            }
        }
        Val {
            hs,
            items: Vec::new(),
        }
    }

    /// D4: what reading `path` from `v` gives.
    fn read_path(v: &Val, path: &[Seg]) -> Val {
        path.iter()
            .fold(v.clone(), |acc, s| Self::read(&acc, s.clone()))
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
            | E::EMissing(_) => Val::none(),
            E::EThis(_) => {
                self.unmodelled |= self.summary_mode;
                Val::none()
            }
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
                    // D3: neither coerces through user code nor keeps the value
                    O::UnNot | O::UnTypeof => {
                        let _ = self.value(&u.value);
                    }
                    _ => self.free(&u.value),
                }
                Val::none()
            }
            E::EIf(i) => {
                // D3: the test is only asked; the value is one of the branches
                let _ = self.value(&i.test);
                let mut v = self.value(&i.yes);
                v.add(self.value(&i.no));
                v
            }
            E::EArray(a) => {
                let mut items = Vec::new();
                for item in a.items.iter() {
                    match &item.data {
                        E::ESpread(sp) => {
                            let sv = self.value(&sp.value);
                            items.extend(Self::items_of(&sv).hs);
                        }
                        E::EMissing(_) => {}
                        _ => self.free(item),
                    }
                }
                Val::fresh(items)
            }
            E::EObject(o) => {
                let mut items = Vec::new();
                for p in o.properties.iter() {
                    if let Some(k) = &p.key {
                        self.free(k);
                    }
                    if let Some(v) = &p.value {
                        if matches!(p.kind, js_ast::G::PropertyKind::Spread) {
                            let sv = self.value(v);
                            items.extend(Self::items_of(&sv).hs);
                        } else {
                            self.free(v);
                        }
                    }
                    if let Some(i) = &p.initializer {
                        self.free(i);
                    }
                }
                Val::fresh(items)
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
            // D3: the value is one of the operands, where it flows on; the left is only tested
            O::BinNullishCoalescing | O::BinLogicalOr | O::BinLogicalAnd => {
                let mut v = self.value(&b.left);
                v.add(self.value(&b.right));
                return v;
            }
            // D3: identity and a comparison with `null` run no code of the operands
            O::BinStrictEq | O::BinStrictNe => {
                let _ = self.value(&b.left);
                let _ = self.value(&b.right);
            }
            O::BinLooseEq | O::BinLooseNe
                if matches!(b.left.data, E::ENull(_)) || matches!(b.right.data, E::ENull(_)) =>
            {
                let _ = self.value(&b.left);
                let _ = self.value(&b.right);
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

    /// F614 D1: `Object.keys` / `values` / `entries` / `hasOwn` and `Array.isArray`, called on the global itself.
    fn read_only_global(&self, d: &js_ast::E::Dot) -> Option<&'static str> {
        let E::EIdentifier(id) = &d.target.data else {
            return None;
        };
        if !self.names.is_unbound(id.ref_) {
            return None;
        }
        let m = String::from_utf8_lossy(d.name.slice());
        match (self.names.name(id.ref_).as_str(), m.as_ref()) {
            ("Object", "keys") => Some("keys"),
            ("Object", "values") => Some("values"),
            ("Object", "entries") => Some("entries"),
            ("Object", "hasOwn") => Some("hasOwn"),
            ("Array", "isArray") => Some("isArray"),
            _ => None,
        }
    }

    fn call(&mut self, c: &js_ast::E::Call) -> Val {
        // F614 D1: a read-only global reads its first argument (a safe read); nothing of it is kept
        if let E::EDot(d) = &c.target.data
            && let Some(g) = self.read_only_global(d)
            && !c.args.iter().any(|a| matches!(a.data, E::ESpread(_)))
        {
            let mut first = Val::none();
            for (i, a) in c.args.iter().enumerate() {
                if i == 0 {
                    first = self.value(a);
                } else {
                    self.arg(a);
                }
            }
            return match g {
                // a fresh list of the handle's members
                "values" => Val::fresh(Self::items_of(&first).hs),
                // a fresh list of fresh [key, member] pairs: the pair level is not followed, so the members are used
                // where they stand
                "entries" => {
                    let items = Self::items_of(&first);
                    self.consume(&items, Pos::Free);
                    Val::none()
                }
                // keys (a list of strings), hasOwn and isArray (booleans): primitives
                _ => Val::none(),
            };
        }
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
        let callee = match &c.target.data {
            E::EIdentifier(id) => Some(self.names.key_of(id.ref_)),
            E::EImportIdentifier(id) => Some(self.names.key_of(id.ref_)),
            _ => None,
        };
        let tv = self.value(&c.target);
        self.consume(&tv, Pos::Escape);
        // D4: a top-level app function, called without a spread: its summary says what it does with each argument
        let spread = c.args.iter().any(|a| matches!(a.data, E::ESpread(_)));
        let summary = match callee {
            Some(k) if !spread && self.depth < MAX_SUMMARY_DEPTH => {
                self.callees.summary(k, self.depth + 1)
            }
            _ => None,
        };
        let Some(s) = summary else {
            for a in c.args.iter() {
                self.arg(a);
            }
            return Val::none();
        };
        let args: Vec<Val> = c.args.iter().map(|a| self.value(a)).collect();
        for a in args.iter().skip(s.params) {
            // more arguments than parameters: without `arguments` the function cannot read them; kept as today
            self.consume(a, Pos::Free);
        }
        for (i, path, pos) in &s.uses {
            if let Some(a) = args.get(*i as usize) {
                let v = Self::read_path(a, path);
                self.consume(&v, *pos);
            }
        }
        self.returned(&s.ret, &args)
    }

    /// D4: a summary's returned value with the arguments put in for its parameters.
    fn returned(&mut self, ret: &Val, args: &[Val]) -> Val {
        let arg = |h: &Handle| match h.root {
            Root::Param(i) => args.get(i as usize).map(|a| Self::read_path(a, &h.path)),
            _ => None,
        };
        let mut out = Val::none();
        for h in &ret.hs {
            if let Some(v) = arg(h) {
                out.add(v);
            }
        }
        for h in &ret.items {
            if let Some(v) = arg(h) {
                // a member of the fresh container returned
                out.add(Val::fresh(v.hs));
                if !v.items.is_empty() {
                    // a fresh container as a member is not followed: its members are used where they stand
                    self.consume(&Val::fresh(v.items), Pos::Free);
                }
            }
        }
        out
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
            self.consume(&rv, Pos::Method);
            for a in c.args.iter() {
                self.arg(a);
            }
            return Val::none();
        }
        // sorting or reversing a handle changes it in place; on a fresh container made here it changes nothing shared
        if matches!(m, "sort" | "reverse") && !rv.hs.is_empty() {
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
                items: Vec::new(),
            },
            // a new list of the same members
            "filter" | "slice" | "concat" | "toSorted" | "toReversed" | "sort" | "reverse" => {
                Val::fresh(item.hs)
            }
            // a new list of what the callback returns: handles when it returns members of the list
            "map" | "flatMap" => {
                let mut hs = Vec::new();
                for r in returned {
                    hs.extend(r.hs);
                    if m == "flatMap" {
                        // a list returned is flattened: its members come out
                        hs.extend(r.items);
                    } else if !r.items.is_empty() {
                        // F610: a fresh list as a member of the new list is not followed (one level only): its members
                        // are used where they stand
                        self.consume(&Val::fresh(r.items), Pos::Free);
                    }
                }
                Val::fresh(hs)
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
                    match (&d.binding.data, &d.value) {
                        // D2: a constant of a handle is the handle (an exported one is seen by its own name)
                        (B::BIdentifier(id), Some(v))
                            if matches!(l.kind, js_ast::S::Kind::KConst)
                                && !self.tracked.contains(&self.names.key_of(id.r#ref)) =>
                        {
                            let k = self.names.key_of(id.r#ref);
                            let val = self.value(v);
                            self.bind(k, val);
                        }
                        (_, Some(v)) => self.free(v),
                        (_, None) => {}
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
                // D3: the test is only asked
                let _ = self.value(&i.test);
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
                let _ = self.value(&w.test);
                self.stmt(&w.body);
            }
            S::SDoWhile(w) => {
                self.stmt(&w.body);
                let _ = self.value(&w.test);
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
