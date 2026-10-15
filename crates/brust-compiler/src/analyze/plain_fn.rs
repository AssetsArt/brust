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

/// An expression whose value is a primitive whatever it reads: a literal, an untagged template, a unary operator, or
/// a binary operator other than `&&`, `||`, `??`, the comma and an assignment.
fn primitive_value(e: &js_ast::Expr) -> bool {
    match &e.data {
        E::EString(_) | E::ENumber(_) | E::EBoolean(_) | E::ENull(_) | E::EUndefined(_) => true,
        E::ETemplate(t) => t.tag.is_none(),
        E::EUnary(_) => true,
        E::EBinary(b) => {
            // `&&`, `||`, `??` and the comma operator give an operand (Mellow F1c).
            !matches!(
                b.op,
                OpCode::BinLogicalAnd
                    | OpCode::BinLogicalOr
                    | OpCode::BinNullishCoalescing
                    | OpCode::BinComma
            ) && matches!(b.op.binary_assign_target(), js_ast::AssignTarget::None)
        }
        _ => false,
    }
}

/// A new array or object no binding holds yet: a literal, or the result of a method that returns a copy.
fn fresh(e: &js_ast::Expr) -> bool {
    const COPYING: &[&str] = &[
        "slice",
        "concat",
        "map",
        "filter",
        "flat",
        "flatMap",
        "toSorted",
        "toReversed",
        "toSpliced",
        "with",
    ];
    match &e.data {
        E::EArray(_) | E::EObject(_) => true,
        E::ECall(c) => matches!(&c.target.data, E::EDot(d)
            if COPYING.contains(&String::from_utf8_lossy(d.name.slice()).as_ref())),
        _ => false,
    }
}

/// F199: names of the module's functions, const arrows and consts that cannot hand out a React element. A greatest
/// "filled" / least "free" fixpoint over symbols (`key_of`; a cycle is never proven free):
///
/// * free: the whole declaration (a function's parameters and defaults included) writes no JSX, is never reassigned and
///   never filled, and every name it reads is declared inside it, a free module binding, an import that is not
///   `element_import`, or a global other than `React`; a module binding the walk does not model (a pattern, `let`, a
///   class) is never free; a const whose value is a primitive whatever it reads (`const A = B + 1`) is free outright;
/// * filled (an object that may come to hold an element): written through a member with a value that may carry one
///   (`slots.icon = el`; `items.length = 1` does not), changed by a
///   mutating method given an argument that may carry an element, handed to a call that is not a read-only global
///   unless the callee is a free module function or a React export that builds no element and no other argument may
///   carry an element, or what a filled binding was made from (`const s = slots`); a write through a root that is not a
///   name (`get().icon = …`, `get().push(…)`) leaves no non-primitive const free.
///
/// Weaker than `plain_fns` (it may return an object or a function); only a value printed with no wrapper is judged by it.
pub fn element_free_fns(
    ast: &js_ast::Ast<'_>,
    names: &NameTable<'_>,
    element_import: &dyn Fn(&str, &str) -> bool,
) -> Vec<String> {
    use crate::analyze::expr::{Walk, chain_root};
    const MUTATING: &[&str] = &[
        "push",
        "unshift",
        "splice",
        "fill",
        "copyWithin",
        "sort",
        "reverse",
        "set",
        "add",
    ];
    const READ_ONLY_FNS: &[&str] = &[
        "String",
        "Number",
        "Boolean",
        "parseInt",
        "parseFloat",
        "isNaN",
        "isFinite",
    ];
    const READ_ONLY_STATICS: &[(&str, &str)] = &[
        ("Object", "keys"),
        ("Object", "values"),
        ("Object", "entries"),
        ("Array", "isArray"),
        ("JSON", "stringify"),
    ];
    let mut module = Walk::default();
    for part in ast.parts.iter() {
        module.stmts(part.stmts.slice());
    }
    let key = |r: js_ast::Ref| names.key_of(r);
    let assigned: HashSet<u32> = module.assigned.iter().map(|r| key(*r)).collect();
    // Written through a member or changed by a method: filled whatever else holds.
    let base: HashSet<u32> = module.member_written.iter().map(|r| key(*r)).collect();
    let mut opaque_write = module.opaque_write;
    for c in &module.calls {
        let E::ECall(call) = &c.data else { continue };
        // A mutating method on a root that is not a name; sorting a fresh copy (`[…].slice().sort()`) changes nothing.
        if let E::EDot(d) = &call.target.data
            && MUTATING.contains(&String::from_utf8_lossy(d.name.slice()).as_ref())
            && chain_root(&d.target).is_none()
            && !fresh(&d.target)
        {
            opaque_write = true;
        }
    }
    // (name, symbol, the walk of its declaration); `None` = never provable (`let`, a class, a pattern).
    let mut decls: Vec<(String, u32, Option<Walk>)> = Vec::new();
    let mut always: HashSet<u32> = HashSet::new();
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            match &stmt.data {
                S::SFunction(f) => {
                    if let Some(n) = &f.func.name {
                        // The whole function: parameters and their defaults as well as the body (Mellow F1a).
                        let mut w = Walk::default();
                        w.stmt(stmt);
                        decls.push((names.name(n.ref_), key(n.ref_), Some(w)));
                    }
                }
                S::SLocal(l) => {
                    for d in l.decls.iter() {
                        if let B::BIdentifier(id) = d.binding.data {
                            let is_const = matches!(l.kind, js_ast::S::Kind::KConst);
                            let primitive = d.value.as_ref().is_some_and(primitive_value);
                            if primitive && is_const {
                                // Its value is a primitive whatever it reads: free outright.
                                always.insert(key(id.r#ref));
                            }
                            // A write through an unknown root may fill any const that is not a primitive.
                            let w = (is_const && (primitive || !opaque_write))
                                .then_some(d.value.as_ref())
                                .flatten()
                                .map(|v| {
                                    let mut w = Walk::default();
                                    w.expr(v);
                                    w
                                });
                            decls.push((names.name(id.r#ref), key(id.r#ref), w));
                        } else {
                            // A pattern (`const { home } = icons`) is a module binding that is never free (Mellow F1b).
                            let mut w = Walk::default();
                            w.declare_binding(&d.binding);
                            for r in w.declared {
                                decls.push((names.name(r), key(r), None));
                            }
                        }
                    }
                }
                S::SClass(c) => {
                    if let Some(n) = &c.class.class_name {
                        decls.push((names.name(n.ref_), key(n.ref_), None));
                    }
                }
                _ => {}
            }
        }
    }
    let module_keys: HashSet<u32> = decls.iter().map(|(_, k, _)| *k).collect();
    let jsx_in = |w: &Walk| {
        w.calls
            .iter()
            .any(|c| matches!(&c.data, E::ECall(call) if call.was_jsx_element))
    };
    let free_given = |filled: &HashSet<u32>| {
        let mut free: HashSet<u32> = always
            .iter()
            .copied()
            .filter(|k| !assigned.contains(k))
            .collect();
        loop {
            let before = free.len();
            for (_, k, w) in &decls {
                let Some(w) = w else { continue };
                if free.contains(k) || assigned.contains(k) || filled.contains(k) {
                    continue;
                }
                // Every name it reads is declared inside it, a free module binding, an import that holds no element, or
                // a global other than `React`; anything else (a binding the walk does not model) is not free.
                let reads_ok = w.used.iter().all(|r| {
                    if let Some((source, imported)) = names.import_of(*r) {
                        return !element_import(source, imported);
                    }
                    let rk = key(*r);
                    if module_keys.contains(&rk) {
                        return free.contains(&rk);
                    }
                    if w.declared.iter().any(|d| key(*d) == rk) {
                        return true;
                    }
                    matches!(names.kind_of(*r).1, crate::ir::IdentKind::Global)
                        && names.name(*r) != "React"
                });
                if !jsx_in(w) && reads_ok {
                    free.insert(*k);
                }
            }
            if free.len() == before {
                return free;
            }
        }
    };
    let global = |r: js_ast::Ref, n: &str| {
        names.name(r) == n && matches!(names.kind_of(r).1, crate::ir::IdentKind::Global)
    };
    let mut filled = base.clone();
    let free = loop {
        let free = free_given(&filled);
        let mut next = base.clone();
        for c in &module.calls {
            let E::ECall(call) = &c.data else { continue };
            // A global that only reads its arguments (`Object.values(map)`, `String(x)`) fills none of them.
            let read_only = match &call.target.data {
                E::EIdentifier(id) => READ_ONLY_FNS.iter().any(|n| global(id.ref_, n)),
                E::EDot(d) => match &d.target.data {
                    E::EIdentifier(id) => {
                        let m = String::from_utf8_lossy(d.name.slice());
                        READ_ONLY_STATICS
                            .iter()
                            .any(|(o, f)| global(id.ref_, o) && *f == m.as_ref())
                    }
                    _ => false,
                },
                _ => false,
            };
            if read_only {
                continue;
            }
            // A free module function, or a React export that builds no element (`useState`, `useMemo`), writes no
            // element into an argument unless another argument carries one in: one that writes JSX or reads anything
            // but a free module name.
            let react_reader = |r: js_ast::Ref| {
                names.import_of(r).is_some_and(|(source, imported)| {
                    (source == "react"
                        || source.starts_with("react/")
                        || source.starts_with("preact"))
                        && !element_import(source, imported)
                })
            };
            let free_callee = match &call.target.data {
                E::EIdentifier(id) => {
                    (module_keys.contains(&key(id.ref_)) && free.contains(&key(id.ref_)))
                        || react_reader(id.ref_)
                }
                E::EImportIdentifier(id) => react_reader(id.ref_),
                _ => false,
            };
            let args: Vec<&js_ast::Expr> = call
                .args
                .iter()
                .map(|a| match &a.data {
                    E::ESpread(sp) => &sp.value,
                    _ => a,
                })
                .collect();
            let carries = |a: &js_ast::Expr| {
                let mut w = Walk::default();
                w.expr(a);
                jsx_in(&w)
                    || w.used.iter().any(|r| {
                        let rk = key(*r);
                        !(module_keys.contains(&rk) && free.contains(&rk))
                    })
            };
            // A method that changes its receiver (`items.push(x)`) fills it when an argument may carry an element in.
            if let E::EDot(d) = &call.target.data
                && MUTATING.contains(&String::from_utf8_lossy(d.name.slice()).as_ref())
                && let Some(r) = chain_root(&d.target)
                && args.iter().any(|a| carries(a))
            {
                next.insert(key(r));
            }
            for (i, a) in args.iter().enumerate() {
                let Some(r) = chain_root(a) else { continue };
                let others_carry = args.iter().enumerate().any(|(j, b)| j != i && carries(b));
                if !free_callee || others_carry {
                    next.insert(key(r));
                }
            }
        }
        // Written through a member: filled when the value written may carry an element in (`ITEMS.length = 1` does not).
        for (r, v) in &module.member_writes {
            let mut w = Walk::default();
            w.expr(v);
            let carries = jsx_in(&w)
                || w.used.iter().any(|u| {
                    let uk = key(*u);
                    !(module_keys.contains(&uk) && free.contains(&uk))
                });
            if carries {
                next.insert(key(*r));
            }
        }
        // What a binding was made from is filled with it (`const s = slots; s.icon = …`).
        loop {
            let before = next.len();
            for (t, u) in &module.flows {
                if next.contains(&key(*t)) {
                    next.insert(key(*u));
                }
            }
            if next.len() == before {
                break;
            }
        }
        if next == filled {
            break free;
        }
        filled = next;
    };
    decls
        .into_iter()
        .filter(|(_, k, _)| free.contains(k))
        .map(|(n, ..)| n)
        .collect()
}

/// F199: the app module `source` names (relative to `from`, after `tsconfig` aliases) may hand out a React element: it
/// writes JSX (a call the parser marks `was_jsx_element`), imports React or a renderer, names `createElement` /
/// `cloneElement`, or imports another app module that may (to depth 4). Fail closed: a JavaScript module the compiler
/// does not read, or one that does not read or parse, may; a specifier that names no file at all does not (the build
/// cannot bundle it). `false` for a package specifier (not an app module).
pub fn module_may_hold_element(
    from: &str,
    source: &str,
    opts: &crate::analyze::component::AnalyzeOptions,
    depth: u8,
) -> bool {
    if !super::modules::is_relative_spec(source) {
        return false;
    }
    if depth > 4 {
        return true;
    }
    let Some(path) = crate::analyze::modules::resolve(from, source, opts) else {
        // Not a `.ts` / `.tsx` module: a JavaScript one the compiler does not read may build an element (fail closed);
        // nothing at all is a module the build cannot bundle, and an asset (`.json`, `.css`) holds no element.
        let dir = from.rfind('/').map_or("", |i| &from[..i]);
        let joined = crate::analyze::modules::normalize(&if dir.is_empty() {
            source.to_string()
        } else {
            format!("{dir}/{source}")
        });
        const JS: &[&str] = &[".js", ".jsx", ".mjs", ".cjs"];
        let exact = JS.iter().any(|e| joined.ends_with(e)) && opts.root.join(&joined).is_file();
        return exact
            || JS.iter().any(|e| {
                opts.root.join(format!("{joined}{e}")).is_file()
                    || opts.root.join(format!("{joined}/index{e}")).is_file()
            });
    };
    let Ok(bytes) = std::fs::read(opts.root.join(&path)) else {
        return true;
    };
    let text = String::from_utf8_lossy(&bytes);
    if text.contains("createElement") || text.contains("cloneElement") {
        return true;
    }
    let Ok(parsed) = crate::parse::parse_tsx(&path, bytes.clone()) else {
        return true;
    };
    // JSX lowers to `jsx(…)` calls marked as elements; a hand-written runtime call imports `react/jsx-runtime`.
    let writes_jsx = parsed.with_ast(|ast| {
        let mut w = crate::analyze::expr::Walk::default();
        for part in ast.parts.iter() {
            w.stmts(part.stmts.slice());
        }
        w.calls
            .iter()
            .any(|c| matches!(&c.data, E::ECall(call) if call.was_jsx_element))
    });
    writes_jsx
        || parsed.import_paths().iter().any(|p| {
            p == "react"
                || p.starts_with("react/")
                || p.starts_with("react-dom")
                || p.starts_with("preact")
                || module_may_hold_element(&path, p, opts, depth + 1)
        })
}

/// F197 (lead ruling): the package module and name that declare the export `name` of the package module `path`. A local
/// export ends the chain; otherwise only a named re-export (`export { x as name } from './y'`) is followed, at most 4
/// hops, and every hop must be a package source the build wrote (it passed the integrity check). `export *`, a namespace
/// re-export and a re-exported `default` fail closed.
fn follow_reexports(
    path: &str,
    name: &str,
    opts: &crate::analyze::component::AnalyzeOptions,
    depth: u8,
) -> Option<(String, String)> {
    let bytes = std::fs::read(opts.root.join(path)).ok()?;
    let parsed = crate::parse::parse_tsx(path, bytes).ok()?;
    // Ok(None): declared here; Ok(Some(spec, original)): a named re-export; Err: anything else.
    let step = parsed.with_ast(|ast| {
        let dummy = js_ast::G::Fn::default();
        let names = NameTable::new(ast, &dummy);
        if local_export(ast, &names, name).is_some() {
            return Ok(None);
        }
        let records = ast.import_records.as_slice();
        for part in ast.parts.iter() {
            for stmt in part.stmts.slice() {
                if let S::SExportFrom(f) = &stmt.data {
                    for item in f.items.slice() {
                        if item.alias.slice() == name.as_bytes() {
                            let original =
                                String::from_utf8_lossy(item.original_name.slice()).into_owned();
                            let spec = records
                                .get(f.import_record_index as usize)
                                .map(|r| String::from_utf8_lossy(r.path.text).into_owned());
                            return match spec {
                                Some(spec) if original != "default" => Ok(Some((spec, original))),
                                _ => Err(()),
                            };
                        }
                    }
                }
            }
        }
        Err(())
    });
    match step.ok()? {
        None => Some((path.to_string(), name.to_string())),
        Some((spec, original)) => {
            if depth >= 4 {
                return None;
            }
            let next = crate::analyze::modules::resolve_module(path, &spec, opts)?;
            if !crate::analyze::modules::is_package_source(&next) {
                return None;
            }
            follow_reexports(&next, &original, opts, depth + 1)
        }
    }
}

/// The local name of the module's own export `name`: `export function name`, or `export { f as name }` /
/// `export const name` naming a module binding.
fn local_export(ast: &js_ast::Ast<'_>, names: &NameTable<'_>, name: &str) -> Option<String> {
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            if let S::SFunction(f) = &stmt.data
                && f.func.flags.contains(js_ast::flags::Function::IsExport)
                && let Some(n) = &f.func.name
                && names.name(n.ref_) == name
            {
                return Some(name.to_string());
            }
        }
    }
    crate::analyze::const_fold::exported_const_name(ast, name)
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
    // refuses anything else). In a package the export is followed through named re-exports to the module that declares
    // it (`follow_reexports`), where the same rules prove it. A package that was not written, or a chain that cannot
    // be followed, proves nothing.
    let Some(entry) = crate::analyze::modules::resolve_module(from, source, opts) else {
        return false;
    };
    let (path, imported) = if crate::analyze::modules::is_package_source(&entry) {
        match follow_reexports(&entry, imported, opts, 0) {
            Some(found) => found,
            None => return false,
        }
    } else {
        (entry, imported.to_string())
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
        let Some(local) = local_export(ast, &names, imported) else {
            return false;
        };
        plain_fns(ast, &names).contains(&local)
    })
}
