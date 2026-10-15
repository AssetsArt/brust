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
    let mut functions: Vec<(u32, &js_ast::Stmt)> = Vec::new();
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            match &stmt.data {
                S::SFunction(f) => {
                    if let Some(n) = &f.func.name {
                        module.insert(key(n.ref_));
                        functions.push((key(n.ref_), stmt));
                    }
                }
                S::SClass(c) => {
                    if let Some(n) = &c.class.class_name {
                        module.insert(key(n.ref_));
                    }
                }
                S::SLocal(l) => {
                    for d in l.decls.iter() {
                        let mut w = Walk::default();
                        w.declare_binding(&d.binding);
                        module.extend(w.declared.iter().map(|r| key(*r)));
                    }
                }
                _ => {}
            }
        }
    }
    let function_keys: HashSet<u32> = functions.iter().map(|(k, _)| *k).collect();
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
    let writes = |w: &Walk, writers: &HashSet<u32>| {
        let roots = w
            .assigned
            .iter()
            .chain(w.member_written.iter())
            .chain(w.member_writes.iter().map(|(r, _)| r));
        roots.into_iter().any(|r| module.contains(&key(*r)))
            || w.calls.iter().any(|c| {
                let E::ECall(call) = &c.data else {
                    return false;
                };
                match &call.target.data {
                    E::EDot(d) => {
                        MUTATING.contains(&String::from_utf8_lossy(d.name.slice()).as_ref())
                            && chain_root(&d.target).is_none_or(|r| module.contains(&key(r)))
                    }
                    E::EIdentifier(id) => writers.contains(&key(id.ref_)),
                    _ => false,
                }
            })
    };
    let walks: Vec<(u32, Walk)> = functions
        .iter()
        .map(|(k, stmt)| {
            let mut w = Walk::default();
            w.stmt(stmt);
            (*k, w)
        })
        .collect();
    let mut writers: HashSet<u32> = HashSet::new();
    loop {
        let before = writers.len();
        for (k, w) in &walks {
            if !writers.contains(k) && writes(w, &writers) {
                writers.insert(*k);
            }
        }
        if writers.len() == before {
            break;
        }
    }
    let inert = |e: &js_ast::Expr| {
        Inert {
            names,
            module: &module,
            function_keys: &function_keys,
            primitive_consts: &primitive_consts,
            writers: &writers,
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
                | S::SClass(_)
                | S::STypeScript(_)
                | S::SDirective(_)
                | S::SComment(_)
                | S::SEmpty(_) => continue,
                S::SLocal(l) => {
                    if l.decls.iter().all(|d| d.value.as_ref().is_none_or(&inert)) {
                        continue;
                    }
                    "a declaration whose value runs code that may change a module binding"
                }
                S::SExportDefault(ed) => match &ed.value {
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
        let callee_ok = match &target.data {
            E::EIdentifier(id) => !self.writers.contains(&self.names.key_of(id.ref_)),
            E::EImportIdentifier(_) => true,
            // A mutating method changes its receiver, unless that is a fresh copy (`[…].slice().sort()`).
            E::EDot(d) => {
                (!MUTATING.contains(&String::from_utf8_lossy(d.name.slice()).as_ref())
                    || crate::analyze::plain_fn::fresh(&d.target))
                    && self.expr(&d.target, depth + 1)
            }
            _ => self.expr(target, depth + 1),
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
