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
/// F173 (lead ruling on @57714ece): built-in methods that return a string, number or boolean when called on the
/// string, number, array or `Date` they are built into. The receiver rule (never a user-defined object) is the caller's.
pub const PRIMITIVE_METHODS: &[&str] = &[
    "toString",
    "toLocaleString",
    "toLocaleDateString",
    "toLocaleTimeString",
    "toISOString",
    "toDateString",
    "toTimeString",
    "toFixed",
    "toPrecision",
    "padStart",
    "padEnd",
    "toUpperCase",
    "toLowerCase",
    "trim",
    "trimStart",
    "trimEnd",
    "replace",
    "replaceAll",
    "startsWith",
    "endsWith",
    "includes",
    "join",
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
                // F173: a comparison is a boolean whatever its operands are, so a member read of a parameter may be one.
                let operand = |x: &js_ast::Expr| {
                    self.expr(x)
                        || (matches!(
                            b.op,
                            OpCode::BinStrictEq
                                | OpCode::BinStrictNe
                                | OpCode::BinLooseEq
                                | OpCode::BinLooseNe
                                | OpCode::BinLt
                                | OpCode::BinLe
                                | OpCode::BinGt
                                | OpCode::BinGe
                        ) && self.receiver(x))
                };
                matches!(b.op.binary_assign_target(), js_ast::AssignTarget::None)
                    && operand(&b.left)
                    && operand(&b.right)
            }
            E::EIf(i) => self.expr(&i.test) && self.expr(&i.yes) && self.expr(&i.no),
            // An untagged template is a string whatever its parts are: a member read of a parameter may be one (F173).
            E::ETemplate(t) => {
                t.tag.is_none()
                    && t.parts
                        .slice()
                        .iter()
                        .all(|p| self.expr(&p.value) || self.receiver(&p.value))
            }
            E::ECall(c) => {
                // A regular expression is an object, so it is plain only as the argument of a method (`s.replace(/x/, '')`): a
                // helper could return it.
                c.optional_chain.is_none()
                    && self.callee(&c.target)
                    && c.args.iter().all(|a| {
                        (matches!(a.data, E::ERegExp(_)) && matches!(c.target.data, E::EDot(_)))
                            || self.expr(a)
                    })
            }
            _ => false,
        }
    }

    /// F173: the value a primitive-returning method is called on: a plain value, or a member read (`e.note`) of a
    /// parameter or local of the function. The method's result is what the function returns, never the member itself.
    fn receiver(&self, t: &js_ast::Expr) -> bool {
        match &t.data {
            E::EDot(d) => d.optional_chain.is_none() && self.receiver(&d.target),
            _ => self.expr(t),
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
                let method = String::from_utf8_lossy(d.name.slice());
                (matches!(&d.target.data, E::EIdentifier(id)
                    if self.names.name(id.ref_) == "Math"
                        && !self.locals.contains("Math")
                        && self.is_global(id.ref_))
                    && MATH_CALLS.contains(&method.as_ref()))
                    // F173: a primitive-returning method of a plain value (`n.toFixed(2)`, `s.trim()`, `xs.join(', ')`).
                    || (d.optional_chain.is_none()
                        && PRIMITIVE_METHODS.contains(&method.as_ref())
                        && self.receiver(&d.target))
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
    // (name, parameters, body, has a rest parameter): `function f(…) {…}` and, since F173, `const f = (…) => …`.
    let mut funcs: Vec<(String, &[js_ast::G::Arg], &[js_ast::Stmt], bool)> = Vec::new();
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
                            funcs.push((
                                name,
                                f.func.args.slice(),
                                f.func.body.stmts.slice(),
                                f.func.flags.contains(js_ast::flags::Function::HasRestArg),
                            ));
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
                                // F173: a const arrow is a function the module cannot rebind (`const pretty = (k) => …`).
                                if let E::EArrow(a) = &v.data
                                    && !a.is_async
                                {
                                    funcs.push((
                                        name.clone(),
                                        a.args.slice(),
                                        a.body.stmts.slice(),
                                        a.has_rest_arg,
                                    ));
                                }
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
    let mut alive: HashSet<String> = funcs.iter().map(|(n, ..)| n.clone()).collect();
    loop {
        let mut dropped = false;
        for (name, args, body, rest) in &funcs {
            if !alive.contains(name) {
                continue;
            }
            let ok = (|| {
                let mut locals = HashSet::new();
                for a in args.iter() {
                    match a.binding.data {
                        B::BIdentifier(id) if a.default.is_none() && !*rest => {
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
                c.stmts(body) && !c.locals.iter().any(|l| module_names.contains(l))
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

/// F173 (plain wrappers) + F197: the export `imported` of the module `source` (seen from `from`: a relative module or a
/// package source the build wrote) is a function its declaring module proves plain by the same rules (`plain_fns`, read
/// in its own module: its consts, its helpers). An import is a
/// read-only binding, so the importer cannot rebind it; the exporting module's own reassignments are refused there.
/// Anything that does not resolve, read or parse is not proven.
pub fn imported_plain_fn(
    from: &str,
    source: &str,
    imported: &str,
    opts: &crate::analyze::component::AnalyzeOptions,
) -> bool {
    // F197: a relative module, or a package source the build wrote under `.brust/pkg-src` (F153c; `resolve_package`
    // refuses anything else), followed through barrels (`export { f } from`, `export *`) to the module that declares
    // the export, where the same rules prove it. A package that was not written, or a chain that cannot be followed,
    // proves nothing.
    let Some(entry) = crate::analyze::modules::resolve_module(from, source, opts) else {
        return false;
    };
    let (path, export) = crate::analyze::exports::declared_in(
        &entry,
        &crate::analyze::modules::Export::Named(imported.to_string()),
        opts,
    );
    let crate::analyze::modules::Export::Named(imported) = export else {
        return false;
    };
    let imported = imported.as_str();
    let Ok(bytes) = std::fs::read(opts.root.join(&path)) else {
        return false;
    };
    let Ok(parsed) = crate::parse::parse_tsx(&path, bytes) else {
        return false;
    };
    parsed.with_ast(|ast| {
        let dummy = js_ast::G::Fn::default();
        let names = NameTable::new(ast, &dummy);
        // `export function f` (the declaration itself), or `export { f }` / `export { f as g }` naming a module function.
        let mut local = None;
        for part in ast.parts.iter() {
            for stmt in part.stmts.slice() {
                if let S::SFunction(f) = &stmt.data
                    && f.func.flags.contains(js_ast::flags::Function::IsExport)
                    && let Some(n) = &f.func.name
                    && names.name(n.ref_) == imported
                {
                    local = Some(imported.to_string());
                }
            }
        }
        let Some(local) =
            local.or_else(|| crate::analyze::const_fold::exported_const_name(ast, imported))
        else {
            return false;
        };
        plain_fns(ast, &names).contains(&local)
    })
}
