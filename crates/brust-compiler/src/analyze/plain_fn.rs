//! F174 (PR 1c): module functions proven to return a PRIMITIVE (a string, number, boolean, null or undefined) whatever
//! plain values they are called with. Under a lowered context Provider the server prints what a child reads, so a call
//! to a helper is only provable when the helper cannot return an element, an object or a function (those print as
//! nothing, or throw, where React renders them). The proof reads the function's own AST:
//!
//! * the body is `return`, `if`, blocks and `const`/`let` bindings of plain values, nothing else (no loop, `try`,
//!   closure, class, `await`, `yield`, assignment or `new`);
//! * a plain value is a literal, a parameter or local of the function, a plain module const, the globals `NaN`,
//!   `Infinity` and `undefined`, an operator (other than an assignment, `++`, `--`, `delete`) or a conditional over
//!   plain values, a template literal over plain values, or a call to a global conversion (`String`, `Number`,
//!   `Boolean`, `parseInt`, `parseFloat`, `isNaN`, `isFinite`), to a `Math` function, or to another proven helper;
//! * no member read, no index, no import: those can yield an object.
//!
//! A parameter returned as is carries what the caller passed; the call site judges every argument.
use crate::analyze::names::NameTable;
use bun_ast as js_ast;
use js_ast::OpCode;
use js_ast::b::B;
use js_ast::expr::Data as E;
use js_ast::stmt::Data as S;
use std::collections::HashSet;

const GLOBAL_VALUES: &[&str] = &["NaN", "Infinity", "undefined"];
const GLOBAL_CALLS: &[&str] = &[
    "String",
    "Number",
    "Boolean",
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
];
const MATH_CALLS: &[&str] = &[
    "abs", "ceil", "floor", "round", "trunc", "sign", "min", "max", "pow", "sqrt", "cbrt", "log",
    "log2", "log10", "exp", "sin", "cos", "tan", "atan", "atan2", "hypot",
];

struct Ctx<'a, 'n> {
    names: &'a NameTable<'n>,
    /// The module functions still believed plain.
    fns: &'a HashSet<String>,
    /// Plain module consts.
    consts: &'a HashSet<String>,
    /// Parameters and locals of the function being read.
    locals: HashSet<String>,
}

impl Ctx<'_, '_> {
    /// The name is the language's own (`String`, `Math`, `NaN`): no declaration, parameter or import of the module binds it.
    fn is_global(&self, r: js_ast::Ref) -> bool {
        matches!(self.names.kind_of(r).1, crate::ir::IdentKind::Global)
    }

    fn expr(&self, e: &js_ast::Expr) -> bool {
        match &e.data {
            E::EString(_)
            | E::ENumber(_)
            | E::EBoolean(_)
            | E::EBranchBoolean(_)
            | E::ENull(_)
            | E::EUndefined(_) => true,
            E::EIdentifier(id) => {
                let n = self.names.name(id.ref_);
                self.locals.contains(&n)
                    || self.consts.contains(&n)
                    || (GLOBAL_VALUES.contains(&n.as_str()) && self.is_global(id.ref_))
            }
            E::EUnary(u) => {
                !matches!(
                    u.op,
                    OpCode::UnPreInc
                        | OpCode::UnPreDec
                        | OpCode::UnPostInc
                        | OpCode::UnPostDec
                        | OpCode::UnDelete
                ) && self.expr(&u.value)
            }
            E::EBinary(b) => {
                matches!(b.op.binary_assign_target(), js_ast::AssignTarget::None)
                    && self.expr(&b.left)
                    && self.expr(&b.right)
            }
            E::EIf(i) => self.expr(&i.test) && self.expr(&i.yes) && self.expr(&i.no),
            E::ETemplate(t) => {
                t.tag.is_none() && t.parts.slice().iter().all(|p| self.expr(&p.value))
            }
            E::ECall(c) => {
                c.optional_chain.is_none()
                    && self.callee(&c.target)
                    && c.args.iter().all(|a| self.expr(a))
            }
            _ => false,
        }
    }

    fn callee(&self, t: &js_ast::Expr) -> bool {
        match &t.data {
            E::EIdentifier(id) => {
                let n = self.names.name(id.ref_);
                !self.locals.contains(&n)
                    && ((GLOBAL_CALLS.contains(&n.as_str()) && self.is_global(id.ref_))
                        || self.fns.contains(&n))
            }
            E::EDot(d) => {
                matches!(&d.target.data, E::EIdentifier(id)
                    if self.names.name(id.ref_) == "Math"
                        && !self.locals.contains("Math")
                        && self.is_global(id.ref_))
                    && MATH_CALLS.contains(&String::from_utf8_lossy(d.name.slice()).as_ref())
            }
            _ => false,
        }
    }

    fn stmts(&mut self, stmts: &[js_ast::Stmt]) -> bool {
        stmts.iter().all(|s| self.stmt(s))
    }

    fn stmt(&mut self, s: &js_ast::Stmt) -> bool {
        match &s.data {
            S::SReturn(r) => r.value.as_ref().is_none_or(|v| self.expr(v)),
            S::SBlock(b) => self.stmts(b.stmts.slice()),
            S::SIf(i) => {
                self.expr(&i.test)
                    && self.stmt(&i.yes)
                    && i.no.as_ref().is_none_or(|n| self.stmt(n))
            }
            S::SLocal(l) => l.decls.iter().all(|d| match (d.binding.data, &d.value) {
                (B::BIdentifier(id), Some(v)) => {
                    let ok = self.expr(v);
                    self.locals.insert(self.names.name(id.r#ref));
                    ok
                }
                _ => false,
            }),
            _ => false,
        }
    }
}

/// Names of the module's functions proven to return a primitive (see the module docs).
pub fn plain_fns(ast: &js_ast::Ast<'_>, names: &NameTable<'_>) -> Vec<String> {
    // A function name that is assigned anywhere (`f = …`) is not the declaration the proof read.
    let mut walk = crate::analyze::expr::Walk::default();
    for part in ast.parts.iter() {
        walk.stmts(part.stmts.slice());
    }
    let assigned: HashSet<String> = walk.assigned.iter().map(|r| names.name(*r)).collect();
    let mut funcs: Vec<(String, &js_ast::G::Fn)> = Vec::new();
    let mut const_inits: Vec<(String, js_ast::Expr)> = Vec::new();
    let mut module_names: HashSet<String> = HashSet::new();
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            match &stmt.data {
                S::SFunction(f) => {
                    if let Some(n) = &f.func.name {
                        let name = names.name(n.ref_);
                        module_names.insert(name.clone());
                        let simple = !assigned.contains(&name)
                            && !f.func.flags.contains(js_ast::flags::Function::IsAsync)
                            && !f.func.flags.contains(js_ast::flags::Function::IsGenerator);
                        if simple {
                            funcs.push((name, &f.func));
                        }
                    }
                }
                S::SLocal(l) => {
                    for d in l.decls.iter() {
                        if let B::BIdentifier(id) = d.binding.data {
                            let name = names.name(id.r#ref);
                            module_names.insert(name.clone());
                            if matches!(l.kind, js_ast::S::Kind::KConst)
                                && let Some(v) = &d.value
                            {
                                const_inits.push((name, *v));
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    // Plain module consts: literals and operators over other plain consts (a fixpoint, so declaration order is free).
    let mut consts: HashSet<String> = HashSet::new();
    let empty: HashSet<String> = HashSet::new();
    loop {
        let before = consts.len();
        for (name, init) in &const_inits {
            if !consts.contains(name) {
                let c = Ctx {
                    names,
                    fns: &empty,
                    consts: &consts,
                    locals: HashSet::new(),
                };
                if c.expr(init) {
                    consts.insert(name.clone());
                }
            }
        }
        if consts.len() == before {
            break;
        }
    }
    // The functions: start from all of them and drop any whose body is not plain given the survivors.
    let mut alive: HashSet<String> = funcs.iter().map(|(n, _)| n.clone()).collect();
    loop {
        let mut dropped = false;
        for (name, f) in &funcs {
            if !alive.contains(name) {
                continue;
            }
            let ok = (|| {
                let mut locals = HashSet::new();
                for a in f.args.slice() {
                    match a.binding.data {
                        B::BIdentifier(id) if a.default.is_none() => {
                            let p = names.name(id.r#ref);
                            // A parameter named like a module binding would hide it from the proof.
                            if module_names.contains(&p)
                                || GLOBAL_CALLS.contains(&p.as_str())
                                || p == "Math"
                            {
                                return false;
                            }
                            locals.insert(p);
                        }
                        _ => return false,
                    }
                }
                let mut c = Ctx {
                    names,
                    fns: &alive,
                    consts: &consts,
                    locals,
                };
                c.stmts(f.body.stmts.slice()) && !c.locals.iter().any(|l| module_names.contains(l))
            })();
            if !ok {
                alive.remove(name);
                dropped = true;
            }
        }
        if !dropped {
            break;
        }
    }
    let mut out: Vec<String> = alive.into_iter().collect();
    out.sort();
    out
}
