//! F215: the code the compiler copies out of a module (a precompute job, the client chunk, the build evaluation) prints
//! the declarations a value reads (`lower::common::module_code`), never a statement that runs when the module loads. A
//! component whose printed values read a module binding falls back (`module-side-effect`) unless the module provably
//! runs nothing at load time that the copy would miss.
//!
//! Lead ruling (F215, after review rounds 1-2 kept finding implicit calls a deny-list could not close): an ALLOWLIST. A
//! module is clean when every top-level statement is an import, an export clause, a type, a directive, a function
//! declaration that does not write a module binding (a `const` holding a function or arrow value counts as one: creating
//! a closure runs nothing), or a `const` whose initializer the existing proofs accept: the folder folds it
//! (`const_fold::Folder`, or the IR constant folder `ir::FoldEnv`) or `plain_fn` proves it plain.
//!
//! Lead ruling b0dff21e adds ONE invariant-based acceptance: a `const` (or a destructuring of one with no default and no
//! computed key) built only from literals, accepted consts, imports, JSX elements, functions that pass the writer rule,
//! member reads, and calls of package code (a bare import, a member of one, or a binding taken from a package call) or a
//! read-only global without function arguments; a package call handed a module-owned array or object refuses. Plus
//! `X.displayName = <string or accepted const>` when the module spells `displayName` nowhere else. INVARIANT: no
//! accepted value holds code that writes a module binding, so an implicit call (a coercion, a getter) can run only
//! non-writing code or package code (packages are imported and run whole by the job, ledger N1). Anything else (a class,
//! an expression statement, `let` / `var`, a load-time call of this module's own code, a coercion of a module value)
//! makes the module unclean. Only the component's own module is judged: an
//! app module or a package it imports is imported for real by the job and the chunk, so its own statements run (lead
//! ruling e2962f7f; the residual class, a third module mutating an imported one at load, is ledger F219, closed by the
//! build-wide scan of F230, `load_writes`).
use crate::analyze::expr::{Walk, chain_root};
use crate::analyze::names::NameTable;
use bun_ast as js_ast;
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

/// The first top-level statement of `ast` the allowlist does not accept: its start and a short description.
/// `accepted(name)`: the module `const` named `name` is folded by the folder or proven plain by `plain_fn`.
pub fn module_effect(
    ast: &js_ast::Ast<'_>,
    names: &NameTable<'_>,
    text: &[u8],
    accepted: &dyn Fn(&str) -> bool,
) -> Option<(u32, String)> {
    let key = |r: js_ast::Ref| names.key_of(r);
    // Every module binding, and the code of each function the module declares (a declaration or a function value).
    let mut module: HashSet<u32> = HashSet::new();
    let mut walks: Vec<(u32, Walk)> = Vec::new();
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            match &stmt.data {
                S::SFunction(f) => {
                    if let Some(n) = &f.func.name {
                        module.insert(key(n.ref_));
                        let mut w = Walk::default();
                        w.stmt(stmt);
                        walks.push((key(n.ref_), w));
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
                        if let (js_ast::b::B::BIdentifier(id), Some(v)) = (d.binding.data, &d.value)
                            && matches!(v.data, E::EArrow(_) | E::EFunction(_))
                        {
                            let mut fw = Walk::default();
                            fw.expr(v);
                            walks.push((key(id.r#ref), fw));
                        }
                    }
                }
                _ => {}
            }
        }
    }
    // A function WRITES a module binding when its code assigns or writes through one, calls a mutating method on one (a
    // fresh copy excepted), writes through a root it cannot name (`get().a = …`, `this.a = …`), or calls or names a
    // function that writes. A least fixpoint.
    let writes = |w: &Walk, writers: &HashSet<u32>| {
        let roots = w
            .assigned
            .iter()
            .chain(w.member_written.iter())
            .chain(w.member_writes.iter().map(|(r, _)| r));
        w.opaque_write
            || roots.into_iter().any(|r| module.contains(&key(*r)))
            || w.used.iter().any(|r| writers.contains(&key(*r)))
            || w.calls.iter().any(|c| {
                let E::ECall(call) = &c.data else {
                    return false;
                };
                matches!(&call.target.data, E::EDot(d)
                    if MUTATING.contains(&String::from_utf8_lossy(d.name.slice()).as_ref())
                        && !crate::analyze::plain_fn::fresh(&d.target)
                        && root_through_calls(&d.target).is_none_or(|r| module.contains(&key(r))))
            })
    };
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
    let function_ok = |k: u32| !writers.contains(&k);
    // Lead ruling b0dff21e: a package call or an element built from accepted values runs only package code
    // (trusted, ledger N1) and hands it nothing that could run app code that writes.
    let package_rooted = |e: &js_ast::Expr| {
        let mut e = e;
        loop {
            match &e.data {
                E::EDot(d) => e = &d.target,
                // A namespace import (`React.forwardRef`) reads as a plain identifier.
                E::EImportIdentifier(id) => {
                    return names
                        .import_of(id.ref_)
                        .is_some_and(|(src, _)| !app_specifier(src));
                }
                E::EIdentifier(id) => {
                    return names
                        .import_of(id.ref_)
                        .is_some_and(|(src, _)| !app_specifier(src));
                }
                _ => return false,
            }
        }
    };
    let _ = accepted;
    // Lead ruling b0dff21e: bindings a `const` takes from package code (`const [createXContext, createXScope] = createContextScope(…)`):
    // calling one runs package code.
    let mut foreign: HashSet<u32> = HashSet::new();
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            if let S::SLocal(l) = &stmt.data
                && matches!(l.kind, js_ast::S::Kind::KConst)
            {
                for d in l.decls.iter() {
                    let from_package = d.value.as_ref().is_some_and(|v| match &v.data {
                        E::ECall(c) => package_rooted(&c.target),
                        E::EDot(_) => package_rooted(v),
                        _ => false,
                    });
                    if from_package {
                        let mut w = Walk::default();
                        w.declare_binding(&d.binding);
                        foreign.extend(w.declared.iter().map(|r| key(*r)));
                    }
                }
            }
        }
    }
    // Iterate: a binding taken from a call of a foreign binding is foreign too (`createDialogContext(…)` results).
    loop {
        let before = foreign.len();
        for part in ast.parts.iter() {
            for stmt in part.stmts.slice() {
                if let S::SLocal(l) = &stmt.data
                    && matches!(l.kind, js_ast::S::Kind::KConst)
                {
                    for d in l.decls.iter() {
                        let from_foreign = d.value.as_ref().is_some_and(|v| {
                            matches!(&v.data, E::ECall(c) if matches!(&c.target.data,
                                E::EIdentifier(id) if foreign.contains(&key(id.ref_))))
                        });
                        if from_foreign {
                            let mut w = Walk::default();
                            w.declare_binding(&d.binding);
                            foreign.extend(w.declared.iter().map(|r| key(*r)));
                        }
                    }
                }
            }
        }
        if foreign.len() == before {
            break;
        }
    }
    let package_rooted = |e: &js_ast::Expr| {
        package_rooted(e)
            || matches!(&e.data, E::EIdentifier(id) if foreign.contains(&key(id.ref_)))
    };
    // A module binding package code may be handed: a function, a value taken from package code, or a primitive const.
    // Any other (an array or object the module owns) could be changed by the package (`register(xs)`).
    let mut handable: HashSet<u32> = walks.iter().map(|(k, _)| *k).collect();
    handable.extend(foreign.iter().copied());
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
                        handable.insert(key(id.r#ref));
                    }
                }
            }
        }
    }
    // Mellow V1 (delta b3932298): a module-owned array or object (a module binding that is not a function, a value taken
    // from package code or a primitive), and every function whose code reads one or names such a function: handed to
    // package code, the package could call it and change the object it returns (`later(() => cfg)`).
    // Mellow V3 (delta 7f6ce3e0): an app import is another app module's value; package code handed it (or code reading
    // it) could change that module's object, which the job imports without running this call.
    let app_import = |r: js_ast::Ref| {
        names
            .import_of(r)
            .is_some_and(|(src, _)| app_specifier(src))
    };
    let objects: HashSet<u32> = module
        .iter()
        .copied()
        .filter(|k| !handable.contains(k))
        .collect();
    let mut object_readers: HashSet<u32> = HashSet::new();
    loop {
        let before = object_readers.len();
        for (k, w) in &walks {
            if !object_readers.contains(k)
                && w.used.iter().any(|r| {
                    let k2 = key(*r);
                    objects.contains(&k2) || object_readers.contains(&k2) || app_import(*r)
                })
            {
                object_readers.insert(*k);
            }
        }
        if object_readers.len() == before {
            break;
        }
    }
    let gives_object = |r: js_ast::Ref| {
        let k = key(r);
        objects.contains(&k) || object_readers.contains(&k) || app_import(r)
    };
    fn hands_module_object(
        a: &js_ast::Expr,
        gives_object: &dyn Fn(js_ast::Ref) -> bool,
        depth: u8,
    ) -> bool {
        if depth > 16 {
            return true;
        }
        let go = |x: &js_ast::Expr| hands_module_object(x, gives_object, depth + 1);
        match &a.data {
            E::EArray(arr) => arr.items.iter().any(|x| match &x.data {
                E::ESpread(sp) => go(&sp.value),
                _ => go(x),
            }),
            E::EObject(o) => o
                .properties
                .iter()
                .any(|p| p.value.as_ref().is_some_and(&go)),
            E::ESpread(sp) => go(&sp.value),
            // A function handed on hands whatever module object its code reads.
            E::EArrow(_) | E::EFunction(_) => {
                let mut w = Walk::default();
                w.expr(a);
                w.used.iter().any(|r| gives_object(*r))
            }
            _ => chain_root(a).is_some_and(gives_object),
        }
    }
    let hands = |a: &js_ast::Expr| hands_module_object(a, &gives_object, 0);
    let code_writes = |w: &Walk| writes(w, &writers);
    let values = Values {
        names,
        module: &module,
        writers: &writers,
        package_rooted: &package_rooted,
        hands: &hands,
        code_writes: &code_writes,
    };
    let display_name = |e: &js_ast::Expr| {
        let E::EBinary(b) = &e.data else { return false };
        matches!(b.op, js_ast::OpCode::BinAssign)
            && matches!(&b.left.data, E::EDot(d) if d.name.slice() == b"displayName"
                && matches!(&d.target.data, E::EIdentifier(id) if module.contains(&key(id.ref_))))
            && (matches!(b.right.data, E::EString(_))
                || matches!(&b.right.data, E::EIdentifier(id) if accepted(&names.name(id.ref_))))
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
    let display_ok = |e: &js_ast::Expr| display_writes == display_spelled && display_name(e);
    let at = |s: &js_ast::Stmt| s.loc.start.max(0) as u32;
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            let what = match &stmt.data {
                S::SImport(_)
                | S::SExportFrom(_)
                | S::SExportStar(_)
                | S::SExportClause(_)
                | S::STypeScript(_)
                | S::SDirective(_)
                | S::SComment(_)
                | S::SEmpty(_) => continue,
                S::SFunction(f) => match &f.func.name {
                    Some(n) if function_ok(key(n.ref_)) => continue,
                    Some(_) => "a function that writes a module binding",
                    None => continue,
                },
                S::SLocal(l) => {
                    let ok = matches!(l.kind, js_ast::S::Kind::KConst)
                        && l.decls.iter().all(|d| {
                            // Lead ruling b0dff21e: a destructuring pattern with no default and no computed key, of an accepted value.
                            let js_ast::b::B::BIdentifier(id) = d.binding.data else {
                                return plain_pattern(&d.binding)
                                    && d.value.as_ref().is_some_and(|v| values.ok(v, 0));
                            };
                            match &d.value {
                                Some(v) if matches!(v.data, E::EArrow(_) | E::EFunction(_)) => {
                                    function_ok(key(id.r#ref))
                                }
                                Some(v) => accepted(&names.name(id.r#ref)) || values.ok(v, 0),
                                None => false,
                            }
                        });
                    if ok {
                        continue;
                    }
                    "a declaration the compiler cannot prove runs nothing (only `const`s it folds or proves plain, and functions)"
                }
                S::SExportDefault(ed) => match &ed.value {
                    js_ast::StmtOrExpr::Stmt(st) => match &st.data {
                        S::SFunction(f) => match &f.func.name {
                            Some(n) if !function_ok(key(n.ref_)) => {
                                "a function that writes a module binding"
                            }
                            _ => {
                                let mut w = Walk::default();
                                w.stmt(st);
                                if writes(&w, &writers) {
                                    "a function that writes a module binding"
                                } else {
                                    continue;
                                }
                            }
                        },
                        _ => "an `export default` the compiler cannot prove runs nothing",
                    },
                    js_ast::StmtOrExpr::Expr(e) => match &e.data {
                        _ if values.ok(e, 0) => {
                            continue;
                        }
                        // `export default Page`: names a binding, runs nothing.
                        E::EIdentifier(_) => continue,
                        E::EArrow(_) | E::EFunction(_) => {
                            let mut w = Walk::default();
                            w.expr(e);
                            if writes(&w, &writers) {
                                "a function that writes a module binding"
                            } else {
                                continue;
                            }
                        }
                        _ => "an `export default` value the compiler cannot prove runs nothing",
                    },
                },
                S::SClass(_) => "a class (its declaration runs code)",
                // Lead ruling b0dff21e: `Comp.displayName = '…'` in a module that never otherwise spells `displayName` (devtools only).
                S::SExpr(x) if display_ok(&x.value) => continue,
                S::SExpr(_) => "a module-level expression statement",
                _ => "a module-level statement that runs code",
            };
            return Some((at(stmt), what.to_string()));
        }
    }
    None
}

/// Lead ruling b0dff21e: a global that only reads its arguments (`Object.values(map)`, `String(x)`).
fn read_only_global(target: &js_ast::Expr, names: &NameTable<'_>) -> bool {
    const FNS: &[&str] = &["String", "Number", "Boolean", "parseInt", "parseFloat"];
    const STATICS: &[(&str, &str)] = &[
        ("Object", "keys"),
        ("Object", "values"),
        ("Object", "entries"),
        ("Object", "freeze"),
        ("Object", "fromEntries"),
        ("Array", "isArray"),
        ("Array", "of"),
        ("JSON", "stringify"),
        ("JSON", "parse"),
        ("Math", "max"),
        ("Math", "min"),
        ("Math", "round"),
        ("Math", "floor"),
        ("Math", "ceil"),
        ("Math", "abs"),
    ];
    let global = |r: js_ast::Ref, n: &str| {
        names.name(r) == n && matches!(names.kind_of(r).1, crate::ir::IdentKind::Global)
    };
    match &target.data {
        E::EIdentifier(id) => FNS.iter().any(|n| global(id.ref_, n)),
        E::EDot(d) => match &d.target.data {
            E::EIdentifier(id) => {
                let m = String::from_utf8_lossy(d.name.slice());
                STATICS
                    .iter()
                    .any(|(o, f)| global(id.ref_, o) && *f == m.as_ref())
            }
            _ => false,
        },
        _ => false,
    }
}

/// A specifier that names app code: relative, absolute, or a path alias (`@/`, `~/`, `#`).
pub fn app_specifier(src: &str) -> bool {
    src.starts_with('.')
        || src.starts_with('/')
        || src.starts_with("@/")
        || src.starts_with("~/")
        || src.starts_with('#')
}

/// The module `const`s the IR constant folder (`crate::ir::FoldEnv`, shadcn S1: an interpreter for a closed subset that
/// never runs user code) folds to a value: `Array.from({ length: N }).map(cb)`, literals, templates over folded values.
pub fn fold_env_accepts(decls: &[crate::ir::ModuleDecl]) -> HashSet<String> {
    let consts: Vec<&crate::ir::ConstVal> = decls.iter().flat_map(|d| &d.consts).collect();
    let lookup = |n: &str| {
        consts
            .iter()
            .find(|c| c.name == n && !c.mutated)
            .map(|c| c.value.clone())
    };
    consts
        .iter()
        .filter(|c| !c.mutated && crate::ir::FoldEnv::new(&lookup).fold(&c.value).is_ok())
        .map(|c| c.name.clone())
        .collect()
}

/// The name a receiver chain starts from, through members, indexes and calls (`document.getElementById(x)?.classList`
/// starts from `document`); `None` for `this`, a literal or anything else (fail closed: a write through it counts).
fn root_through_calls(e: &js_ast::Expr) -> Option<js_ast::Ref> {
    let mut e = e;
    loop {
        match &e.data {
            E::EDot(d) => e = &d.target,
            E::EIndex(i) => e = &i.target,
            E::ECall(c) => e = &c.target,
            E::EIdentifier(id) => return Some(id.ref_),
            E::EImportIdentifier(id) => return Some(id.ref_),
            _ => return None,
        }
    }
}

/// The invariant-based acceptance (lead ruling b0dff21e): a value that holds no code writing a module binding.
struct Values<'a, 'n> {
    names: &'a NameTable<'n>,
    module: &'a HashSet<u32>,
    writers: &'a HashSet<u32>,
    package_rooted: &'a dyn Fn(&js_ast::Expr) -> bool,
    hands: &'a dyn Fn(&js_ast::Expr) -> bool,
    code_writes: &'a dyn Fn(&Walk) -> bool,
}

impl Values<'_, '_> {
    fn ok(&self, e: &js_ast::Expr, depth: u8) -> bool {
        let (names, module, writers) = (self.names, self.module, self.writers);
        let (package_rooted, hands, code_writes) =
            (self.package_rooted, self.hands, self.code_writes);
        if depth > 16 {
            return false;
        }
        let go = |x: &js_ast::Expr| self.ok(x, depth + 1);
        match &e.data {
            E::EString(_) | E::ENumber(_) | E::EBoolean(_) | E::ENull(_) | E::EUndefined(_) => true,
            E::EImportIdentifier(_) => true,
            E::EIdentifier(id) => {
                let k = names.key_of(id.ref_);
                !module.contains(&k) || !writers.contains(&k)
            }
            // The same writer rule as a declared function.
            E::EArrow(_) | E::EFunction(_) => {
                let mut w = Walk::default();
                w.expr(e);
                !code_writes(&w)
            }
            // Mellow V2: a member read rooted at an app import may run an app getter at load time; naming the import runs
            // nothing.
            E::EDot(d) => {
                package_rooted(e)
                    || (!chain_root(e).is_some_and(|r| {
                        names
                            .import_of(r)
                            .is_some_and(|(src, _)| app_specifier(src))
                    }) && go(&d.target))
            }
            E::EArray(a) => a
                .items
                .iter()
                .all(|x| !matches!(x.data, E::ESpread(_)) && go(x)),
            E::EObject(o) => o.properties.iter().all(|p| {
                matches!(
                    p.kind,
                    js_ast::G::PropertyKind::Normal | js_ast::G::PropertyKind::Spread
                ) && !p.flags.contains(js_ast::flags::Property::IsComputed)
                    && p.value.as_ref().is_none_or(&go)
            }),
            E::ECall(c) => {
                (c.was_jsx_element || package_rooted(&c.target) || read_only_global(&c.target, names))
                    && (c.was_jsx_element || go(&c.target))
                    // Package code handed a module array or object could change it.
                    && (!package_rooted(&c.target) || react_stores_fn(&c.target, names) || !c.args.iter().any(hands))
                    && (!read_only_global(&c.target, names)
                        || !c.args.iter().any(|a| matches!(a.data, E::EArrow(_) | E::EFunction(_))))
                    && c.args.iter().all(|a| !matches!(a.data, E::ESpread(_)) && go(a))
            }
            _ => false,
        }
    }
}

/// Lead ruling b0dff21e: a binding pattern that evaluates nothing itself: no default value and no computed key, at any depth.
fn plain_pattern(b: &js_ast::Binding) -> bool {
    match b.data {
        js_ast::b::B::BArray(arr) => arr
            .items()
            .iter()
            .all(|i| i.default_value.is_none() && plain_pattern(&i.binding)),
        js_ast::b::B::BObject(obj) => obj.properties().iter().all(|p| {
            p.default_value.is_none()
                && matches!(p.key.data, E::EString(_))
                && plain_pattern(&p.value)
        }),
        js_ast::b::B::BIdentifier(_) | js_ast::b::B::BMissing(_) => true,
    }
}

/// Lead rulings c2f61a77, b76d738c and d6ea7012: APIs that store the function they are handed and call it only at render, never at
/// module load, resolved BY SYMBOL (a named import, or a member of a namespace or default import of the package): React's
/// `forwardRef`, `memo` and `cache`, and brust's own `cache` (`cacheComponent` only tags the component). Handing them a function
/// that reads a module or app-imported object hands it to nobody at load time. Nothing else is exempt (not
/// `cache.invalidate`, not `createContext`, not an app re-export or a local alias).
fn react_stores_fn(target: &js_ast::Expr, names: &NameTable<'_>) -> bool {
    const STORES: &[(&str, &[&str])] = &[
        ("react", &["forwardRef", "memo", "cache"]),
        ("brust", &["cache"]),
        ("@brust/core", &["cache"]),
    ];
    let names_for = |src: &str| STORES.iter().find(|(p, _)| *p == src).map(|(_, n)| *n);
    match &target.data {
        // `React.forwardRef`, `brust.cache`: a member of a namespace or default import.
        E::EDot(d) => {
            let member = String::from_utf8_lossy(d.name.slice());
            let root = match &d.target.data {
                E::EIdentifier(id) => Some(id.ref_),
                E::EImportIdentifier(id) => Some(id.ref_),
                _ => None,
            };
            root.and_then(|r| names.import_of(r))
                .is_some_and(|(src, imp)| {
                    (imp == "*" || imp == "default")
                        && names_for(src).is_some_and(|n| n.contains(&member.as_ref()))
                })
        }
        // `import { forwardRef } from 'react'`, `import { cache } from 'brust'`.
        E::EImportIdentifier(id) => names
            .import_of(id.ref_)
            .is_some_and(|(src, imp)| names_for(src).is_some_and(|n| n.contains(&imp))),
        _ => false,
    }
}
