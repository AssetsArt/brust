//! Which module bindings have a use that is not a proven read (R1.1a, lead ruling after review
//! round 1). The check is an allowlist: a use counts as a mutation unless it is one of
//!
//! - a member or index read;
//! - the target of a non-mutating array method (`map`, `filter`, `find`, `some`, `every`,
//!   `includes`, `indexOf`, `join`, `slice`, `concat`, `at`) whose callbacks write nothing
//!   reachable from their parameters;
//! - the argument of `Object.keys` / `entries` / `values`;
//! - a spread into a new literal;
//! - a `useState` argument;
//! - a JSX prop or child, or a template-literal part.
//!
//! The scan tracks where a value *flows*: `esc` is true when it lands somewhere the scan cannot
//! follow (a declaration, an assignment, a return, a literal that escapes, any other call). An
//! identifier reached with `esc` set is unsafe to fold, and so is every binding it was
//! derived from, because a callback parameter stands for the elements of what it iterates.
use crate::analyze::expr::Walk;
use crate::analyze::names::NameTable;
use bun_ast as js_ast;
use js_ast::OpCode;
use js_ast::b::B;
use js_ast::expr::Data as E;
use js_ast::stmt::Data as S;
use std::collections::{HashMap, HashSet};

/// Array methods that return the elements (or a new array of them) without changing the array.
const PASS_THROUGH: &[&str] = &["map", "filter", "find", "slice", "concat", "at"];
/// Array methods that return a primitive.
const PRIMITIVE_RESULT: &[&str] = &["some", "every", "includes", "indexOf", "join"];

/// Inner indexes of the bindings with a use that is not proven read-only.
pub fn unsafe_to_fold(ast: &js_ast::Ast<'_>, names: &NameTable<'_>) -> HashSet<u32> {
    let mut s = Scan {
        names,
        bad: HashSet::new(),
        aliases: Vec::new(),
        ret_esc: true,
        writing: false,
        lit_objects: HashMap::new(),
        lit_prims: HashSet::new(),
    };
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            if let S::SLocal(l) = &stmt.data
                && matches!(l.kind, js_ast::S::Kind::KConst)
            {
                for d in l.decls.iter() {
                    if let (B::BIdentifier(id), Some(v)) = (d.binding.data, &d.value)
                        && matches!(v.data, E::EObject(_))
                    {
                        s.lit_objects.insert(id.r#ref.inner_index(), *v);
                    }
                }
            }
        }
    }
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            if let S::SLocal(l) = &stmt.data
                && matches!(l.kind, js_ast::S::Kind::KConst)
            {
                for d in l.decls.iter() {
                    if let (B::BIdentifier(id), Some(v)) = (d.binding.data, &d.value)
                        && (is_primitive(v) || s.reads_literal(v))
                    {
                        s.lit_prims.insert(id.r#ref.inner_index());
                    }
                }
            }
        }
    }
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            s.stmt(stmt);
        }
    }
    loop {
        let before = s.bad.len();
        for (param, roots) in &s.aliases {
            if s.bad.contains(param) {
                s.bad.extend(roots.iter().copied());
            }
        }
        if s.bad.len() == before {
            return s.bad;
        }
    }
}

struct Scan<'x, 'a> {
    names: &'x NameTable<'a>,
    bad: HashSet<u32>,
    /// `(callback parameter, bindings its elements come from)`.
    aliases: Vec<(u32, Vec<u32>)>,
    /// Whether a `return` value (or an expression body) flows somewhere unknown.
    ret_esc: bool,
    /// The expression being visited is the target of a write: even `.length` is a mutation.
    writing: bool,
    /// Module-level `const X = { … }` object literals, by binding: a member chain read from one that ends in a
    /// literal is a primitive, which aliases nothing (`const D = X.a` does not make `X` escape).
    lit_objects: HashMap<u32, js_ast::Expr>,
    /// Module-level `const`s holding a primitive literal (or reading one from a literal object): a use of one that
    /// lands anywhere carries no object, so it is never an escape.
    lit_prims: HashSet<u32>,
}

fn is_primitive(e: &js_ast::Expr) -> bool {
    matches!(
        e.data,
        E::ENumber(_) | E::EString(_) | E::EBoolean(_) | E::ENull(_)
    )
}

impl Scan<'_, '_> {
    /// `e` (`X.a.b`) reads a primitive literal out of a module-level object literal.
    fn reads_literal(&self, e: &js_ast::Expr) -> bool {
        fn leaf(s: &Scan<'_, '_>, e: &js_ast::Expr, depth: u32) -> Option<js_ast::Expr> {
            if depth > 8 {
                return None;
            }
            let E::EDot(d) = &e.data else {
                return match &e.data {
                    E::EIdentifier(id) => s.lit_objects.get(&id.ref_.inner_index()).copied(),
                    _ => None,
                };
            };
            let E::EObject(o) = &leaf(s, &d.target, depth + 1)?.data else {
                return None;
            };
            o.properties
                .iter()
                .rev()
                .find(|p| {
                    p.key.as_ref().is_some_and(
                        |k| matches!(&k.data, E::EString(k) if k.slice8() == d.name.slice()),
                    )
                })
                .and_then(|p| p.value)
        }
        matches!(&e.data, E::EDot(_)) && leaf(self, e, 0).is_some_and(|v| is_primitive(&v))
    }

    /// `Object.values(X)` / `keys` / `entries` of a module-level object literal whose values are all primitive
    /// literals: an array of primitives, which aliases nothing.
    fn reads_literal_entries(&self, e: &js_ast::Expr) -> bool {
        let E::ECall(c) = &e.data else {
            return false;
        };
        let E::EDot(d) = &c.target.data else {
            return false;
        };
        if !self.is_named(&d.target, "Object")
            || !matches!(d.name.slice(), b"keys" | b"entries" | b"values")
        {
            return false;
        }
        let [a] = c.args.as_slice() else {
            return false;
        };
        let E::EIdentifier(id) = &a.data else {
            return false;
        };
        let Some(E::EObject(o)) = self
            .lit_objects
            .get(&id.ref_.inner_index())
            .map(|x| &x.data)
        else {
            return false;
        };
        o.properties
            .iter()
            .all(|p| p.value.as_ref().is_some_and(is_primitive))
    }

    fn mark(&mut self, r: js_ast::Ref) {
        self.bad.insert(r.inner_index());
    }

    /// Everything `e` mentions is unsafe: for shapes this scan does not model.
    fn give_up_expr(&mut self, e: &js_ast::Expr) {
        let mut w = Walk::default();
        w.expr(e);
        w.used.iter().for_each(|r| self.mark(*r));
    }

    fn give_up_stmt(&mut self, s: &js_ast::Stmt) {
        let mut w = Walk::default();
        w.stmt(s);
        w.used.iter().for_each(|r| self.mark(*r));
    }

    /// Bindings a value read from `e` can alias.
    fn roots(&self, e: &js_ast::Expr, out: &mut Vec<u32>) {
        match &e.data {
            E::EIdentifier(id) => out.push(id.ref_.inner_index()),
            E::EImportIdentifier(id) => out.push(id.ref_.inner_index()),
            E::EDot(d) => self.roots(&d.target, out),
            E::EIndex(i) => self.roots(&i.target, out),
            E::ECall(c) => {
                if let E::EDot(d) = &c.target.data {
                    self.roots(&d.target, out)
                }
            }
            E::EIf(i) => {
                self.roots(&i.yes, out);
                self.roots(&i.no, out);
            }
            E::EBinary(b) => {
                self.roots(&b.left, out);
                self.roots(&b.right, out);
            }
            _ => {}
        }
    }

    fn is_named(&self, e: &js_ast::Expr, name: &str) -> bool {
        match &e.data {
            E::EIdentifier(id) => self.names.name(id.ref_) == name,
            E::EImportIdentifier(id) => self.names.name(id.ref_) == name,
            _ => false,
        }
    }

    /// `e` is assigned to, incremented or deleted: its root is mutated, `.length` included.
    fn write(&mut self, e: &js_ast::Expr) {
        let saved = std::mem::replace(&mut self.writing, true);
        self.expr(e, true);
        self.writing = saved;
    }

    fn expr(&mut self, e: &js_ast::Expr, esc: bool) {
        match &e.data {
            E::EIdentifier(id) => {
                if esc && !self.lit_prims.contains(&id.ref_.inner_index()) {
                    self.mark(id.ref_)
                }
            }
            E::EImportIdentifier(id) => {
                if esc {
                    self.mark(id.ref_)
                }
            }
            E::EDot(d) => self.expr(
                &d.target,
                esc && (self.writing || d.name.slice() != b"length"),
            ),
            E::EIndex(i) => {
                self.expr(&i.target, esc);
                let writing = std::mem::take(&mut self.writing);
                self.expr(&i.index, false);
                self.writing = writing;
            }
            E::ECall(c) => self.call(e, c, esc),
            E::EBinary(b) => match b.op {
                op if !matches!(op.binary_assign_target(), js_ast::AssignTarget::None) => {
                    self.write(&b.left);
                    self.expr(&b.right, true);
                }
                OpCode::BinLogicalAnd | OpCode::BinLogicalOr | OpCode::BinNullishCoalescing => {
                    self.expr(&b.left, esc);
                    self.expr(&b.right, esc);
                }
                OpCode::BinComma => {
                    self.expr(&b.left, false);
                    self.expr(&b.right, esc);
                }
                _ => {
                    self.expr(&b.left, false);
                    self.expr(&b.right, false);
                }
            },
            E::EUnary(u) => {
                let writes = matches!(
                    u.op,
                    OpCode::UnPreInc
                        | OpCode::UnPreDec
                        | OpCode::UnPostInc
                        | OpCode::UnPostDec
                        | OpCode::UnDelete
                );
                if writes {
                    self.write(&u.value);
                } else {
                    self.expr(&u.value, false);
                }
            }
            E::EIf(i) => {
                self.expr(&i.test, false);
                self.expr(&i.yes, esc);
                self.expr(&i.no, esc);
            }
            E::EArray(a) => {
                for item in a.items.iter() {
                    match &item.data {
                        E::ESpread(s) => self.expr(&s.value, false),
                        _ => self.expr(item, esc),
                    }
                }
            }
            E::EObject(o) => {
                for p in o.properties.iter() {
                    if let Some(k) = &p.key {
                        self.expr(k, false);
                    }
                    if let Some(v) = &p.value {
                        let spread = matches!(p.kind, js_ast::g::PropertyKind::Spread);
                        self.expr(v, esc && !spread);
                    }
                    if let Some(i) = &p.initializer {
                        self.expr(i, true);
                    }
                }
            }
            E::ETemplate(t) => {
                if let Some(tag) = &t.tag {
                    self.expr(tag, true);
                }
                for p in t.parts.slice() {
                    self.expr(&p.value, false);
                }
            }
            E::EArrow(a) => {
                self.params(a.args.slice(), &[]);
                self.body(a.body.stmts.slice(), true);
            }
            E::EFunction(f) => {
                self.params(f.func.args.slice(), &[]);
                self.body(f.func.body.stmts.slice(), true);
            }
            E::ENew(n) => {
                self.expr(&n.target, true);
                n.args.iter().for_each(|x| self.expr(x, true));
            }
            E::EAwait(a) => self.expr(&a.value, true),
            E::EYield(y) => {
                if let Some(v) = &y.value {
                    self.expr(v, true);
                }
            }
            E::ESpread(s) => self.expr(&s.value, true),
            // Leaves have no identifiers; anything else (classes, imports, ...) is not modelled.
            E::EString(_)
            | E::ENumber(_)
            | E::EBoolean(_)
            | E::EBranchBoolean(_)
            | E::ENull(_)
            | E::EUndefined(_) => {}
            _ => self.give_up_expr(e),
        }
    }

    /// Callback / function parameters: `from` are the bindings the first parameter iterates.
    fn params(&mut self, params: &[js_ast::G::Arg], from: &[u32]) {
        for p in params {
            match p.binding.data {
                B::BIdentifier(id) => self.aliases.push((id.r#ref.inner_index(), from.to_vec())),
                _ => self.bad.extend(from.iter().copied()),
            }
            if let Some(d) = &p.default {
                self.expr(d, true);
            }
        }
    }

    fn body(&mut self, stmts: &[js_ast::Stmt], esc: bool) {
        let saved = std::mem::replace(&mut self.ret_esc, esc);
        stmts.iter().for_each(|s| self.stmt(s));
        self.ret_esc = saved;
    }

    fn call(&mut self, e: &js_ast::Expr, c: &js_ast::E::Call, esc: bool) {
        if c.was_jsx_element {
            // Props and children are reads; a child component can only receive them.
            for a in c.args.iter() {
                match &a.data {
                    E::EObject(o) => {
                        for p in o.properties.iter() {
                            if let Some(k) = &p.key {
                                self.expr(k, false);
                            }
                            if let Some(v) = &p.value {
                                self.expr(v, false);
                            }
                        }
                    }
                    _ => self.expr(a, false),
                }
            }
            return;
        }
        if let E::EDot(d) = &c.target.data {
            let name = String::from_utf8_lossy(d.name.slice()).into_owned();
            let passes = PASS_THROUGH.contains(&name.as_str());
            if passes || PRIMITIVE_RESULT.contains(&name.as_str()) {
                let mut roots = Vec::new();
                self.roots(&d.target, &mut roots);
                self.expr(&d.target, esc && passes);
                for a in c.args.iter() {
                    match &a.data {
                        E::EArrow(f) => {
                            self.params(f.args.slice(), &roots);
                            self.body(f.body.stmts.slice(), esc && passes);
                        }
                        E::EFunction(f) => {
                            self.params(f.func.args.slice(), &roots);
                            self.body(f.func.body.stmts.slice(), esc && passes);
                        }
                        // A callback the scan cannot see into may write to the elements.
                        E::EIdentifier(_) | E::EImportIdentifier(_) => {
                            self.bad.extend(roots.iter().copied());
                            self.expr(a, true);
                        }
                        _ => self.expr(a, esc && name == "concat"),
                    }
                }
                return;
            }
            if self.is_named(&d.target, "Object")
                && matches!(d.name.slice(), b"keys" | b"entries" | b"values")
            {
                let into = esc && d.name.slice() != b"keys";
                c.args.iter().for_each(|a| self.expr(a, into));
                return;
            }
        }
        if self.is_named(&c.target, "useState") {
            c.args.iter().for_each(|a| self.expr(a, false));
            return;
        }
        let _ = e;
        self.expr(&c.target, true);
        c.args.iter().for_each(|a| self.expr(a, true));
    }

    fn stmt(&mut self, s: &js_ast::Stmt) {
        match &s.data {
            S::SBlock(b) => b.stmts.slice().iter().for_each(|x| self.stmt(x)),
            S::SExpr(x) => self.expr(&x.value, true),
            S::SLocal(l) => {
                for d in l.decls.iter() {
                    if let Some(v) = &d.value {
                        let primitive = matches!(l.kind, js_ast::S::Kind::KConst)
                            && (self.reads_literal(v) || self.reads_literal_entries(v));
                        self.expr(v, !primitive);
                    }
                }
            }
            S::SReturn(r) => {
                if let Some(v) = &r.value {
                    self.expr(v, self.ret_esc);
                }
            }
            S::SThrow(t) => self.expr(&t.value, true),
            S::SIf(i) => {
                self.expr(&i.test, false);
                self.stmt(&i.yes);
                if let Some(no) = &i.no {
                    self.stmt(no);
                }
            }
            S::SFunction(f) => {
                self.params(f.func.args.slice(), &[]);
                self.body(f.func.body.stmts.slice(), true);
            }
            S::SFor(f) => {
                if let Some(init) = &f.init {
                    self.stmt(init);
                }
                if let Some(t) = &f.test {
                    self.expr(t, false);
                }
                if let Some(u) = &f.update {
                    self.expr(u, true);
                }
                self.stmt(&f.body);
            }
            // The loop variable is an alias of the elements: the source escapes.
            S::SForIn(f) => {
                self.expr(&f.value, true);
                self.stmt(&f.body);
            }
            S::SForOf(f) => {
                self.expr(&f.value, true);
                self.stmt(&f.body);
            }
            S::SWhile(w) => {
                self.expr(&w.test, false);
                self.stmt(&w.body);
            }
            S::SDoWhile(w) => {
                self.stmt(&w.body);
                self.expr(&w.test, false);
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
                self.expr(&sw.test, false);
                for c in sw.cases.slice() {
                    if let Some(v) = &c.value {
                        self.expr(v, false);
                    }
                    c.body.slice().iter().for_each(|x| self.stmt(x));
                }
            }
            S::SLabel(l) => self.stmt(&l.stmt),
            S::SExportDefault(ed) => match &ed.value {
                js_ast::StmtOrExpr::Expr(e) => self.expr(e, true),
                js_ast::StmtOrExpr::Stmt(s) => self.stmt(s),
            },
            // Imports, exports lists, directives, empties: nothing to read.
            S::SImport(_)
            | S::SExportClause(_)
            | S::SExportFrom(_)
            | S::SExportStar(_)
            | S::SDirective(_)
            | S::SEmpty(_)
            | S::SBreak(_)
            | S::SContinue(_)
            | S::STypeScript(_) => {}
            _ => self.give_up_stmt(s),
        }
    }
}
