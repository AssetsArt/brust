//! F215: a module-level statement that runs for its effect (`xs.push('b')`, `B.put('y')`, `if (…) { … }`) is not in
//! the code the compiler copies out of the module: a precompute job, the client chunk and the build evaluation print
//! the declarations a value reads (`lower::common::module_code`), never the statements that change them. A component
//! whose printed values read a module binding of such a module falls back (`module-side-effect`) until module effects
//! are replayed (a later design).
//!
//! A module is effect-free when every top-level statement is an import, an export clause, a function or class
//! declaration, a type, a directive, or a variable declaration (or `export default`) whose value is inert: it builds a
//! value without running anything that could change a module binding. Fail closed: any other statement is an effect,
//! except `Comp.displayName = '…'` in a module that never reads `displayName`.
use crate::analyze::expr::{Walk, chain_root};
use crate::analyze::names::NameTable;
use bun_ast as js_ast;
use js_ast::OpCode;
use js_ast::expr::Data as E;
use js_ast::stmt::Data as S;
use std::collections::HashSet;

/// Methods that change their receiver.
const MUTATING: &[&str] = &[
    "push",
    "pop",
    "shift",
    "unshift",
    "splice",
    "fill",
    "copyWithin",
    "sort",
    "reverse",
    "set",
    "add",
    "delete",
    "clear",
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
    ("Object", "freeze"),
    ("Object", "fromEntries"),
    ("Array", "isArray"),
    ("Array", "from"),
    ("Array", "of"),
    ("JSON", "stringify"),
    ("JSON", "parse"),
];

/// The first top-level statement of `ast` that runs for its effect: its start and a short description.
pub fn module_effect(
    ast: &js_ast::Ast<'_>,
    names: &NameTable<'_>,
    text: &[u8],
) -> Option<(u32, String)> {
    let key = |r: js_ast::Ref| names.key_of(r);
    // Every module binding, and which of them are functions (a function handed to a call is not filled).
    let mut module: HashSet<u32> = HashSet::new();
    // Round 1 (Mellow F1, Afrojack F1), one writer rule over every callable body: each module binding is walked with
    // all the code its value holds (a function declaration's body; a variable's whole initializer, so arrows, function
    // values, object methods, getters and setters at any depth; a class's constructor, methods, fields and static
    // blocks). A binding is a WRITER when that walk writes a module binding, calls a mutating method on one, calls a
    // writer or a module binding with no walked value, or names a writer (it may hand it on). A fixpoint, as before.
    let mut walks: Vec<(Vec<u32>, Walk)> = Vec::new();
    let mut functions: HashSet<u32> = HashSet::new();
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            match &stmt.data {
                S::SFunction(f) => {
                    if let Some(n) = &f.func.name {
                        module.insert(key(n.ref_));
                        functions.insert(key(n.ref_));
                        let mut w = Walk::default();
                        w.stmt(stmt);
                        walks.push((vec![key(n.ref_)], w));
                    }
                }
                S::SClass(c) => {
                    if let Some(n) = &c.class.class_name {
                        module.insert(key(n.ref_));
                        let mut w = Walk::default();
                        w.stmt(stmt);
                        walks.push((vec![key(n.ref_)], w));
                    }
                }
                S::SLocal(l) => {
                    for d in l.decls.iter() {
                        let mut w = Walk::default();
                        w.declare_binding(&d.binding);
                        module.extend(w.declared.iter().map(|r| key(*r)));
                        let Some(v) = &d.value else { continue };
                        if let js_ast::b::B::BIdentifier(id) = d.binding.data
                            && matches!(v.data, E::EArrow(_) | E::EFunction(_))
                        {
                            functions.insert(key(id.r#ref));
                        }
                        let mut vw = Walk::default();
                        vw.expr(v);
                        // A destructured binding holds a part of the value: each is judged by the whole value.
                        walks.push((w.declared.iter().map(|r| key(*r)).collect(), vw));
                    }
                }
                _ => {}
            }
        }
    }
    let code: HashSet<u32> = walks
        .iter()
        .flat_map(|(ks, _)| ks.iter().copied())
        .collect();
    let function_keys = functions;
    // A `const` holding a primitive (`const NAME = 'Dialog'`): nothing can change it, so handing it to a call is safe.
    let mut primitive_consts: HashSet<u32> = HashSet::new();
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            if let S::SLocal(l) = &stmt.data
                && matches!(l.kind, js_ast::S::Kind::KConst)
            {
                for d in l.decls.iter() {
                    if let (js_ast::b::B::BIdentifier(id), Some(v)) = (d.binding.data, &d.value)
                        && matches!(
                            v.data,
                            E::EString(_)
                                | E::ENumber(_)
                                | E::EBoolean(_)
                                | E::ENull(_)
                                | E::EUndefined(_)
                        )
                    {
                        primitive_consts.insert(key(id.r#ref));
                    }
                }
            }
        }
    }
    // `Comp.displayName = 'Comp'` names a component for devtools; it changes no value the module prints unless the
    // module reads `displayName` somewhere, which a count of the spelling rules out.
    let display_name = |e: &js_ast::Expr| {
        let E::EBinary(b) = &e.data else { return false };
        matches!(b.op, OpCode::BinAssign)
            && matches!(&b.left.data, E::EDot(d) if d.name.slice() == b"displayName"
                && chain_root(&d.target).is_some_and(|r| module.contains(&key(r))))
            && matches!(b.right.data, E::EString(_) | E::EIdentifier(_))
    };
    let display_writes = ast
        .parts
        .iter()
        .flat_map(|p| p.stmts.slice())
        .filter(|s| matches!(&s.data, S::SExpr(x) if display_name(&x.value)))
        .count();
    let display_spelled = text
        .windows(b"displayName".len())
        .filter(|w| *w == b"displayName")
        .count();
    let display_ok = display_writes == display_spelled;
    // Module functions that, when called, write a module binding (directly or through another such function).
    // A module binding a call may run: one with a walked value by its writer verdict; one with none (`let f;`) is
    // not provable. A name that is not a module binding (an import, a global, a local) is not module code.
    let runs_writer = |k: u32, writers: &HashSet<u32>| {
        if code.contains(&k) {
            writers.contains(&k)
        } else {
            module.contains(&k)
        }
    };
    let writes = |w: &Walk, writers: &HashSet<u32>| {
        let roots = w
            .assigned
            .iter()
            .chain(w.member_written.iter())
            .chain(w.member_writes.iter().map(|(r, _)| r));
        // Code that names a writer may hand it to something that calls it (`xs.forEach(add)`): fail closed.
        w.opaque_write
            || roots.into_iter().any(|r| module.contains(&key(*r)))
            || w.used.iter().any(|r| writers.contains(&key(*r)))
            || w.calls.iter().any(|c| {
                let target = match &c.data {
                    E::ECall(call) => &call.target,
                    E::ENew(n) => &n.target,
                    _ => return false,
                };
                match &target.data {
                    E::EDot(d) => {
                        // A fresh copy (`[…].slice().sort()`) is nobody's binding.
                        (MUTATING.contains(&String::from_utf8_lossy(d.name.slice()).as_ref())
                            && !crate::analyze::plain_fn::fresh(&d.target)
                            && chain_root(&d.target).is_none_or(|r| module.contains(&key(r))))
                            || chain_root(&d.target).is_some_and(|r| {
                                code.contains(&key(r)) && writers.contains(&key(r))
                            })
                    }
                    E::EIdentifier(id) => runs_writer(key(id.ref_), writers),
                    _ => false,
                }
            })
    };
    let mut writers: HashSet<u32> = HashSet::new();
    loop {
        let before = writers.len();
        for (ks, w) in &walks {
            if !ks.iter().all(|k| writers.contains(k)) && writes(w, &writers) {
                writers.extend(ks.iter().copied());
            }
        }
        if writers.len() == before {
            break;
        }
    }
    let walk_writes = |n: &dyn Fn(&mut Walk)| {
        let mut w = Walk::default();
        n(&mut w);
        writes(&w, &writers)
    };
    let call_writes = |e: &js_ast::Expr| walk_writes(&|w| w.expr(e));
    let inert = |e: &js_ast::Expr| {
        Inert {
            names,
            module: &module,
            function_keys: &function_keys,
            primitive_consts: &primitive_consts,
            writers: &writers,
            code: &code,
            call_writes: &call_writes,
        }
        .expr(e, 0)
    };
    let at = |s: &js_ast::Stmt| s.loc.start.max(0) as u32;
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            let what = match &stmt.data {
                S::SImport(_)
                | S::SExportFrom(_)
                | S::SExportStar(_)
                | S::SExportClause(_)
                | S::SFunction(_)
                | S::STypeScript(_)
                | S::SDirective(_)
                | S::SComment(_)
                | S::SEmpty(_) => continue,
                // A class runs its `extends`, computed keys, static fields and static blocks when it is declared: judged by
                // the writer rule over the whole class (a method that writes counts too: fail closed).
                S::SClass(_) => {
                    if !walk_writes(&|w| w.stmt(stmt)) {
                        continue;
                    }
                    "a class whose code may change a module binding"
                }
                S::SLocal(l) => {
                    if l.decls.iter().all(|d| d.value.as_ref().is_none_or(&inert)) {
                        continue;
                    }
                    "a declaration whose value runs code that may change a module binding"
                }
                S::SExportDefault(ed) => match &ed.value {
                    js_ast::StmtOrExpr::Stmt(st) if matches!(st.data, S::SClass(_)) => {
                        if !walk_writes(&|w| w.stmt(st)) {
                            continue;
                        }
                        "a class whose code may change a module binding"
                    }
                    js_ast::StmtOrExpr::Stmt(_) => continue,
                    js_ast::StmtOrExpr::Expr(e) if inert(e) => continue,
                    js_ast::StmtOrExpr::Expr(_) => {
                        "an `export default` value that runs code that may change a module binding"
                    }
                },
                S::SExpr(x) if display_ok && display_name(&x.value) => continue,
                S::SExpr(_) => "a module-level expression statement",
                _ => "a module-level statement that runs code",
            };
            return Some((at(stmt), what.to_string()));
        }
    }
    None
}

/// Whether evaluating an expression can change a module binding.
struct Inert<'a, 'n> {
    names: &'a NameTable<'n>,
    module: &'a HashSet<u32>,
    function_keys: &'a HashSet<u32>,
    primitive_consts: &'a HashSet<u32>,
    writers: &'a HashSet<u32>,
    code: &'a HashSet<u32>,
    /// The writer rule over all the code of one expression (`writers` is its fixpoint over module bindings).
    call_writes: &'a dyn Fn(&js_ast::Expr) -> bool,
}

impl Inert<'_, '_> {
    fn expr(&self, e: &js_ast::Expr, depth: u8) -> bool {
        if depth > 32 {
            return false;
        }
        let go = |x: &js_ast::Expr| self.expr(x, depth + 1);
        match &e.data {
            E::EString(_)
            | E::ENumber(_)
            | E::EBoolean(_)
            | E::ENull(_)
            | E::EUndefined(_)
            | E::ERegExp(_)
            | E::EBigInt(_)
            | E::EIdentifier(_)
            | E::EImportIdentifier(_)
            // A function value runs nothing until it is called.
            | E::EArrow(_)
            | E::EFunction(_) => true,
            E::ETemplate(t) => t.tag.is_none() && t.parts.slice().iter().all(|p| go(&p.value)),
            // Reading a member of a writer may run its getter (`o.v`).
            E::EDot(_) | E::EIndex(_) if chain_root(e).is_some_and(|r| {
                let k = self.names.key_of(r);
                self.code.contains(&k) && self.writers.contains(&k)
            }) => false,
            E::EDot(d) => go(&d.target),
            E::EIndex(ix) => go(&ix.target) && go(&ix.index),
            E::EArray(a) => a.items.iter().all(|x| match &x.data {
                E::ESpread(sp) => go(&sp.value),
                _ => go(x),
            }),
            E::EObject(o) => o.properties.iter().all(|p| {
                p.key.as_ref().is_none_or(&go) && p.value.as_ref().is_none_or(&go)
            }),
            E::EUnary(u) => {
                matches!(OpCode::unary_assign_target(u.op), js_ast::AssignTarget::None)
                    && !matches!(u.op, OpCode::UnDelete)
                    && go(&u.value)
            }
            E::EBinary(b) => {
                matches!(b.op.binary_assign_target(), js_ast::AssignTarget::None)
                    && go(&b.left)
                    && go(&b.right)
            }
            E::EIf(i) => go(&i.test) && go(&i.yes) && go(&i.no),
            // Round 1 (Mellow F1, Afrojack F1): whatever a call is handed or called on may run (an IIFE, a callback, a
            // function in an array, a writer named in it): no code in the call and no binding it names may be a writer.
            E::ECall(_) | E::ENew(_) if (self.call_writes)(e) => false,
            E::ECall(c) => self.call(&c.target, c.args.iter(), depth),
            E::ENew(n) => self.call(&n.target, n.args.iter(), depth),
            _ => false,
        }
    }

    /// A call is inert when its callee is not a module function that writes module bindings, nor a mutating method,
    /// and no argument hands it a module object it could change (a module function is not one: `memo(Button)`).
    fn call<'e>(
        &self,
        target: &js_ast::Expr,
        args: impl Iterator<Item = &'e js_ast::Expr>,
        depth: u8,
    ) -> bool {
        let global = |r: js_ast::Ref, n: &str| {
            self.names.name(r) == n
                && matches!(self.names.kind_of(r).1, crate::ir::IdentKind::Global)
        };
        // A global that only reads its arguments (`Object.values(map)`, `String(x)`) changes none of them.
        let read_only = match &target.data {
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
        // Afrojack F1 (round 1), one rule: a call that may run code written in this module is inert only when that code is
        // proven not to write a module binding; a callee that cannot be resolved to such a verdict is not inert.
        let module_code_ok = |k: u32| {
            if self.code.contains(&k) {
                !self.writers.contains(&k)
            } else {
                !self.module.contains(&k)
            }
        };
        let callee_ok = match &target.data {
            E::EIdentifier(id) => module_code_ok(self.names.key_of(id.ref_)),
            E::EImportIdentifier(_) => true,
            // A mutating method changes its receiver, unless that is a fresh copy (`[…].slice().sort()`); a method of a
            // module object or class runs its code.
            E::EDot(d) => {
                (!MUTATING.contains(&String::from_utf8_lossy(d.name.slice()).as_ref())
                    || crate::analyze::plain_fn::fresh(&d.target))
                    && chain_root(&d.target).is_none_or(|r| {
                        let k = self.names.key_of(r);
                        !self.code.contains(&k) || !self.writers.contains(&k)
                    })
                    && self.expr(&d.target, depth + 1)
            }
            // An IIFE, a call of a call, an indexed callee: not resolved.
            _ => false,
        };
        callee_ok
            && args.into_iter().all(|a| {
                let a = match &a.data {
                    E::ESpread(sp) => &sp.value,
                    _ => a,
                };
                let hands_object = !read_only
                    && chain_root(a).is_some_and(|r| {
                        let k = self.names.key_of(r);
                        self.module.contains(&k)
                            && !self.function_keys.contains(&k)
                            && !self.primitive_consts.contains(&k)
                    });
                !hands_object && self.expr(a, depth + 1)
            })
    }
}
