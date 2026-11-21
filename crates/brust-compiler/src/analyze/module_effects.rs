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

/// F591: the members a conversion of an object calls.
const CONVERSION_HOOKS: &[&str] = &["toString", "valueOf", "toJSON"];

/// F591: brust's store primitives (`@brust/core/store`, `@brust/runtime-dom` and their `/store` entries).
fn store_primitive(target: &js_ast::Expr, names: &NameTable<'_>) -> bool {
    const SOURCES: &[&str] = &[
        "@brust/core/store",
        "@brust/runtime-dom",
        "@brust/runtime-dom/store",
        "@brust/core",
    ];
    const FNS: &[&str] = &["defineStore", "signal", "computed"];
    match &target.data {
        E::EImportIdentifier(id) => names
            .import_of(id.ref_)
            .is_some_and(|(src, imp)| SOURCES.contains(&src) && FNS.contains(&imp)),
        E::EIdentifier(id) => names
            .import_of(id.ref_)
            .is_some_and(|(src, imp)| SOURCES.contains(&src) && FNS.contains(&imp)),
        _ => false,
    }
}

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
/// `load_only` (F591 rule e): judge only what runs WHEN THE MODULE LOADS, not what a copy of its declarations would
/// miss later: a function the module declares (a declaration, or a `const` / `let` / `var` holding a function value)
/// runs nothing at load whatever it writes, and a `let` / `var` is judged by its initializer as a `const` is. Every
/// value computed at load is judged exactly as without it (a load-time call of this module's own code, a function
/// handed to a call that writes a module binding, a class, an expression statement stay refused).
/// `accepted(name)`: the module `const` named `name` is folded by the folder or proven plain by `plain_fn`.
/// `import_read(source, imported, path)`: reading `path` from the app import `imported` of `source` reads only data
/// properties of a literal (F564 D1, `plain_import_read`).
pub fn module_effect(
    ast: &js_ast::Ast<'_>,
    names: &NameTable<'_>,
    text: &[u8],
    accepted: &dyn Fn(&str) -> bool,
    import_read: &dyn Fn(&str, &str, &[ReadSeg]) -> bool,
    load_only: bool,
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
    // F564 D2: a binding taken from package code (`const useXContext = createXContext(…)[0]`) is package code: what
    // calling it returns is the package's object, as for an import.
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
    let hands = |a: &js_ast::Expr| hands_module_object(a, &gives_object, 0);
    // The writer rule is base's (F215; F564 D2 is its own ledger row): a mutating-name method writes a module binding
    // unless its receiver is fresh (a literal, a copying method's result) or rooted, through members, indexes and
    // calls, at a name that is not a binding of this module.
    let mutating_write = |w: &Walk| -> Option<js_ast::Expr> {
        w.calls.iter().find_map(|c| {
            let E::ECall(call) = &c.data else {
                return None;
            };
            match &call.target.data {
                E::EDot(d)
                    if MUTATING.contains(&String::from_utf8_lossy(d.name.slice()).as_ref())
                        && !crate::analyze::plain_fn::fresh(&d.target)
                        && root_through_calls(&d.target)
                            .is_none_or(|r| module.contains(&key(r))) =>
                {
                    Some(call.target)
                }
                _ => None,
            }
        })
    };
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
            || mutating_write(w).is_some()
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
    let function_ok = |k: u32| load_only || !writers.contains(&k);
    let package_rooted = |e: &js_ast::Expr| {
        package_rooted(e)
            || matches!(&e.data, E::EIdentifier(id) if foreign.contains(&key(id.ref_)))
    };
    let code_writes = |w: &Walk| writes(w, &writers);
    // F564: where each lexical module binding is declared; reading one at load before that throws (TDZ).
    let mut declared_at: std::collections::HashMap<u32, i32> = std::collections::HashMap::new();
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            match &stmt.data {
                S::SLocal(l) => {
                    for d in l.decls.iter() {
                        let mut w = Walk::default();
                        w.declare_binding(&d.binding);
                        for r in &w.declared {
                            declared_at.insert(key(*r), d.binding.loc.start);
                        }
                    }
                }
                S::SClass(c) => {
                    if let Some(n) = &c.class.class_name {
                        declared_at.insert(key(n.ref_), stmt.loc.start);
                    }
                }
                _ => {}
            }
        }
    }
    let functions: HashSet<u32> = walks.iter().map(|(k, _)| *k).collect();
    // F597: module consts by binding, and the functions a load-time call may follow.
    let mut inits: std::collections::HashMap<u32, js_ast::Expr> = std::collections::HashMap::new();
    let mut bodies: std::collections::HashMap<u32, FnBody<'_>> = std::collections::HashMap::new();
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            match &stmt.data {
                S::SFunction(f) => {
                    if let Some(n) = &f.func.name {
                        let fl = f.func.flags;
                        bodies.insert(
                            key(n.ref_),
                            FnBody {
                                args: f.func.args.slice(),
                                stmts: f.func.body.stmts.slice(),
                                plain: !fl.contains(js_ast::flags::Function::IsAsync)
                                    && !fl.contains(js_ast::flags::Function::IsGenerator)
                                    && !fl.contains(js_ast::flags::Function::HasRestArg),
                            },
                        );
                    }
                }
                S::SLocal(l) if matches!(l.kind, js_ast::S::Kind::KConst) => {
                    for d in l.decls.iter() {
                        let (js_ast::b::B::BIdentifier(id), Some(v)) = (d.binding.data, &d.value)
                        else {
                            continue;
                        };
                        match &v.data {
                            E::EArrow(a) => {
                                bodies.insert(
                                    key(id.r#ref),
                                    FnBody {
                                        args: a.args.slice(),
                                        stmts: a.body.stmts.slice(),
                                        plain: !a.is_async && !a.has_rest_arg,
                                    },
                                );
                            }
                            E::EFunction(f) => {
                                let fl = f.func.flags;
                                bodies.insert(
                                    key(id.r#ref),
                                    FnBody {
                                        args: f.func.args.slice(),
                                        stmts: f.func.body.stmts.slice(),
                                        plain: !fl.contains(js_ast::flags::Function::IsAsync)
                                            && !fl.contains(js_ast::flags::Function::IsGenerator)
                                            && !fl.contains(js_ast::flags::Function::HasRestArg),
                                    },
                                );
                            }
                            _ => {
                                inits.insert(key(id.r#ref), *v);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    let values = Values {
        names,
        import_read,
        declared_at: &declared_at,
        current: std::cell::Cell::new(i32::MAX),
        module: &module,
        writers: &writers,
        package_rooted: &package_rooted,
        hands: &hands,
        code_writes: &code_writes,
        functions: &functions,
        load_only,
        inits: &inits,
        bodies: &bodies,
        accepted,
        locals: std::cell::RefCell::new(HashSet::new()),
        data_locals: std::cell::RefCell::new(HashSet::new()),
        frames: std::cell::RefCell::new(Vec::new()),
        own_locals: std::cell::RefCell::new(HashSet::new()),
        visiting: std::cell::RefCell::new(Vec::new()),
        strict: std::cell::Cell::new(0),
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
    // F564 D3: what a writing function writes, said for the diagnostic.
    let written = |w: &Walk| -> String {
        let named = w
            .assigned
            .iter()
            .chain(w.member_written.iter())
            .chain(w.member_writes.iter().map(|(r, _)| r))
            .find(|r| module.contains(&key(**r)));
        if let Some(r) = named {
            return format!("writes the module binding `{}`", names.name(*r));
        }
        if let Some(t) = mutating_write(w)
            && let E::EDot(d) = &t.data
        {
            return format!(
                "may change a module binding: `{}.{}(…)`",
                spell(&d.target, names),
                String::from_utf8_lossy(d.name.slice())
            );
        }
        if let Some(r) = w.used.iter().find(|r| writers.contains(&key(**r))) {
            return format!(
                "calls `{}`, a function that writes a module binding",
                names.name(*r)
            );
        }
        "writes through `this` or a value it cannot name".into()
    };
    let line = |s: &js_ast::Stmt| line_of(text, at(s));
    let fn_writes = |name: String, st: &js_ast::Stmt, w: &Walk| {
        format!(
            "this module's function `{name}` (line {}) {}",
            line(st),
            written(w)
        )
    };
    let walk_of = |k: u32| walks.iter().find(|(k2, _)| *k2 == k).map(|(_, w)| w);
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            let what: String = match &stmt.data {
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
                    Some(n) => match walk_of(key(n.ref_)) {
                        Some(w) => fn_writes(names.name(n.ref_), stmt, w),
                        None => continue,
                    },
                    None => continue,
                },
                S::SLocal(l) => {
                    if !load_only && !matches!(l.kind, js_ast::S::Kind::KConst) {
                        let first = l.decls.first().map(|d| {
                            let mut w = Walk::default();
                            w.declare_binding(&d.binding);
                            w.declared
                                .first()
                                .map(|r| names.name(*r))
                                .unwrap_or_default()
                        });
                        format!(
                            "this module's `let` / `var` `{}` (line {}): its value can change after the module loads",
                            first.unwrap_or_default(),
                            line(stmt)
                        )
                    } else {
                        // The first declaration it does not prove, and why.
                        let refused = l.decls.iter().find_map(|d| {
                            // Lead ruling b0dff21e: a destructuring pattern with no default and no computed key, of an accepted value.
                            let js_ast::b::B::BIdentifier(id) = d.binding.data else {
                                if !plain_pattern(&d.binding) {
                                    return Some((
                                        "{…}".to_string(),
                                        "the pattern has a default value or a computed key"
                                            .to_string(),
                                    ));
                                }
                                values.current.set(d.binding.loc.start);
                                let why = match &d.value {
                                    Some(v) => values.why(v, 0).map(|w| ("{…}".to_string(), w)),
                                    None => Some(("{…}".into(), "it has no value".into())),
                                };
                                values.current.set(i32::MAX);
                                return why;
                            };
                            let n = names.name(id.r#ref);
                            match &d.value {
                                Some(v) if matches!(v.data, E::EArrow(_) | E::EFunction(_)) => {
                                    (!function_ok(key(id.r#ref))).then(|| {
                                        let w = walk_of(key(id.r#ref));
                                        (n.clone(), w.map(&written).unwrap_or_default())
                                    })
                                }
                                Some(_) if accepted(&n) => None,
                                Some(v) => {
                                    values.current.set(d.binding.loc.start);
                                    let why = values.why(v, 0).map(|w| (n, w));
                                    values.current.set(i32::MAX);
                                    why
                                }
                                None => Some((n, "it has no value".into())),
                            }
                        });
                        let Some((n, why)) = refused else { continue };
                        let fun = l.decls.iter().any(|d| {
                            matches!(d.binding.data, js_ast::b::B::BIdentifier(id) if names.name(id.r#ref) == n)
                                && d.value.as_ref().is_some_and(|v| matches!(v.data, E::EArrow(_) | E::EFunction(_)))
                        });
                        if fun {
                            format!("this module's function `{n}` (line {}) {why}", line(stmt))
                        } else {
                            format!(
                                "this module's `const {n} = …` (line {}) may run code when the module loads: {why}",
                                line(stmt)
                            )
                        }
                    }
                }
                S::SExportDefault(ed) => match &ed.value {
                    js_ast::StmtOrExpr::Stmt(st) => match &st.data {
                        S::SFunction(f) => {
                            let mut w = Walk::default();
                            w.stmt(st);
                            let name = f.func.name.as_ref().map(|n| names.name(n.ref_));
                            let bad = match &f.func.name {
                                Some(n) => !function_ok(key(n.ref_)),
                                None => !load_only && writes(&w, &writers),
                            };
                            if !bad {
                                continue;
                            }
                            fn_writes(name.unwrap_or_else(|| "default".into()), stmt, &w)
                        }
                        _ => format!(
                            "this module's `export default` (line {}) may run code when the module loads",
                            line(stmt)
                        ),
                    },
                    js_ast::StmtOrExpr::Expr(e) => match &e.data {
                        _ if values.ok(e, 0) => continue,
                        // `export default Page`: names a binding, runs nothing.
                        E::EIdentifier(_) => continue,
                        E::EArrow(_) | E::EFunction(_) => {
                            let mut w = Walk::default();
                            w.expr(e);
                            if load_only || !writes(&w, &writers) {
                                continue;
                            }
                            fn_writes("default".into(), stmt, &w)
                        }
                        _ => format!(
                            "this module's `export default` value (line {}) may run code when the module loads: {}",
                            line(stmt),
                            values.why(e, 0).unwrap_or_default()
                        ),
                    },
                },
                S::SClass(c) => format!(
                    "this module's `class {}` (line {}) runs code when the module loads",
                    c.class
                        .class_name
                        .as_ref()
                        .map(|n| names.name(n.ref_))
                        .unwrap_or_default(),
                    line(stmt)
                ),
                // Lead ruling b0dff21e: `Comp.displayName = '…'` in a module that never otherwise spells `displayName` (devtools only).
                S::SExpr(x) if display_ok(&x.value) => continue,
                _ => format!(
                    "this module's statement at line {} runs code when the module loads",
                    line(stmt)
                ),
            };
            return Some((at(stmt), what));
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

/// Base's receiver root: the name a chain starts from, through members, indexes and calls; `None` for `this`, a
/// literal or anything else.
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
    /// F564: where each lexical module binding is declared, and the binding being judged (`i32::MAX`: none).
    declared_at: &'a std::collections::HashMap<u32, i32>,
    current: std::cell::Cell<i32>,
    import_read: &'a dyn Fn(&str, &str, &[ReadSeg]) -> bool,
    module: &'a HashSet<u32>,
    writers: &'a HashSet<u32>,
    package_rooted: &'a dyn Fn(&js_ast::Expr) -> bool,
    hands: &'a dyn Fn(&js_ast::Expr) -> bool,
    code_writes: &'a dyn Fn(&Walk) -> bool,
    /// F591 (`load_only`): this module's functions (declarations and function-valued consts), and whether the judge is
    /// the load-time one: there a package call handed app code, and a value a conversion runs app code of, are refused.
    functions: &'a HashSet<u32>,
    load_only: bool,
    /// F597 (load-time judge only): each module `const` bound to a name, by binding, with its initializer.
    inits: &'a std::collections::HashMap<u32, js_ast::Expr>,
    /// F597 D4: the module's functions a load-time call may follow: parameters, body, and whether the function is a
    /// plain one to follow (not async, not a generator, no rest parameter).
    bodies: &'a std::collections::HashMap<u32, FnBody<'a>>,
    /// F597: whether the module `const` named so is folded or proven plain (`accepted` of `module_effect`).
    accepted: &'a dyn Fn(&str) -> bool,
    /// F597: parameters and locals of the function bodies being judged (symbols are unique, so one set serves all).
    locals: std::cell::RefCell<HashSet<u32>>,
    /// F597: the locals that hold plain data: parameters (handed data), loop bindings over fresh values, and locals
    /// whose every value is data.
    data_locals: std::cell::RefCell<HashSet<u32>>,
    /// F597 (review F3): the locals each body being judged declares, innermost last: a body assigns only its own.
    frames: std::cell::RefCell<Vec<HashSet<u32>>>,
    /// F597 (review F2): the locals holding a value their body built (a fresh array or collection): only those, and a
    /// module `const` built the same way, may be sorted or reversed in place.
    own_locals: std::cell::RefCell<HashSet<u32>>,
    /// F597 D4: the module functions being followed (a call back into one is recursion, refused).
    visiting: std::cell::RefCell<Vec<u32>>,
    /// F597: inside a followed body or callback: a call is only one of D1-D4 or a read-only global, never package code.
    strict: std::cell::Cell<u32>,
}

/// F597 D4: a module function a load-time call may follow.
#[derive(Clone, Copy)]
struct FnBody<'a> {
    args: &'a [js_ast::G::Arg],
    stmts: &'a [js_ast::Stmt],
    plain: bool,
}

/// F597: the shape a load-time value is proven to have (fresh: built by this module at load, holding data only).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Array,
    Set,
    Map,
    /// `new WeakSet()` / `new WeakMap()`: never iterated or spread.
    Weak,
    /// `keys()` / `values()` / `entries()` of a fresh Set or Map.
    Iter,
}

/// F597 D3: array methods that build a new value or read one (`sort` / `reverse` sort the fresh receiver in place).
const ARRAY_METHODS: &[&str] = &[
    "filter",
    "map",
    "flatMap",
    "reduce",
    "reduceRight",
    "slice",
    "concat",
    "flat",
    "sort",
    "toSorted",
    "reverse",
    "toReversed",
    "join",
    "includes",
    "indexOf",
    "find",
    "findLast",
    "findIndex",
    "some",
    "every",
    "at",
];
/// Those whose result is a fresh array.
const ARRAY_RETURNING: &[&str] = &[
    "filter",
    "map",
    "flatMap",
    "slice",
    "concat",
    "flat",
    "sort",
    "toSorted",
    "reverse",
    "toReversed",
];
/// Those that take a callback (its first argument).
const CALLBACK_METHODS: &[&str] = &[
    "filter",
    "map",
    "flatMap",
    "reduce",
    "reduceRight",
    "sort",
    "toSorted",
    "find",
    "findLast",
    "findIndex",
    "some",
    "every",
];
/// F597 D3: Set / Map methods that read.
const COLLECTION_METHODS: &[&str] = &["has", "get", "keys", "values", "entries"];

impl Values<'_, '_> {
    fn ok(&self, e: &js_ast::Expr, depth: u8) -> bool {
        self.why(e, depth).is_none()
    }

    /// F564 D3: the first part of `e` the acceptance does not prove runs nothing, said for the diagnostic.
    fn why(&self, e: &js_ast::Expr, depth: u8) -> Option<String> {
        let (names, module, writers) = (self.names, self.module, self.writers);
        let (package_rooted, hands, code_writes) =
            (self.package_rooted, self.hands, self.code_writes);
        if depth > 16 {
            return Some("it nests deeper than the compiler follows".into());
        }
        let go = |x: &js_ast::Expr| self.why(x, depth + 1);
        let spell = |x: &js_ast::Expr| spell(x, names);
        // F597 D3 / D4: a method of a proven fresh value, or a call of a function of this module.
        if self.load_only
            && let E::ECall(c) = &e.data
            && let Some(v) = self.load_call(c, depth)
        {
            return v;
        }
        match &e.data {
            E::EString(_) | E::ENumber(_) | E::EBoolean(_) | E::ENull(_) | E::EUndefined(_) => None,
            E::EImportIdentifier(_) => None,
            // F597: `arguments` of a followed body is not a value of the module.
            E::EIdentifier(id)
                if self.strict.get() > 0
                    && names.name(id.ref_) == "arguments"
                    && !module.contains(&names.key_of(id.ref_))
                    && !self.locals.borrow().contains(&names.key_of(id.ref_)) =>
            {
                Some("it reads `arguments`".into())
            }
            E::EIdentifier(id) => {
                let k = names.key_of(id.ref_);
                // F564: read at load before (or while) it is declared: a TDZ error (`const A = B + 1; const B = …`).
                if self.declared_at.get(&k).is_some_and(|at| *at >= self.current.get()) {
                    return Some(format!(
                        "it reads `{}` before it is declared",
                        names.name(id.ref_)
                    ));
                }
                (module.contains(&k) && writers.contains(&k)).then(|| {
                    format!(
                        "it reads `{}`, a function that writes a module binding",
                        names.name(id.ref_)
                    )
                })
            }
            // The same writer rule as a declared function.
            E::EArrow(_) | E::EFunction(_) => {
                let mut w = Walk::default();
                w.expr(e);
                code_writes(&w).then(|| "it holds a function that writes a module binding".into())
            }
            // Mellow V2: a member read rooted at an app import may run an app getter at load time; naming the import runs
            // nothing. F564 D1 (lead ruling 5e9842ab): unless every step of the read is a data property of a literal the
            // app module exports and nothing writes (`plain_import_read`).
            E::EDot(_) | E::EIndex(_) => {
                if package_rooted(e) {
                    return None;
                }
                let app_root = chain_root(e).and_then(|r| {
                    names
                        .import_of(r)
                        .filter(|(src, _)| app_specifier(src))
                        .map(|(src, imp)| (src.to_string(), imp.to_string()))
                });
                if let Some((src, imp)) = app_root {
                    let proven =
                        read_path(e).is_some_and(|path| (self.import_read)(&src, &imp, &path));
                    return (!proven).then(|| {
                        format!(
                            "it reads `{}`, an imported value brust cannot prove is a plain object",
                            spell(e)
                        )
                    });
                }
                match &e.data {
                    E::EDot(d) => go(&d.target),
                    E::EIndex(i) if matches!(i.index.data, E::EString(_) | E::ENumber(_)) => {
                        go(&i.target)
                    }
                    _ => Some(format!("it reads `{}` with a computed key", spell(e))),
                }
            }
            E::EArray(a) => a.items.iter().find_map(|x| match &x.data {
                // F597 D2: a spread of a value proven to be a fresh array, Set or Map runs only the built-in iterator.
                E::ESpread(sp)
                    if self.load_only
                        && self
                            .kind(&sp.value, depth + 1)
                            .is_some_and(|k| k != Kind::Weak) =>
                {
                    go(&sp.value)
                }
                E::ESpread(sp) => Some(format!(
                    "it spreads `...{}` into an array",
                    spell(&sp.value)
                )),
                _ => go(x),
            }),
            E::EObject(o) => o.properties.iter().find_map(|p| {
                if !matches!(
                    p.kind,
                    js_ast::G::PropertyKind::Normal | js_ast::G::PropertyKind::Spread
                ) {
                    return Some("it has a getter, a setter or a method".into());
                }
                if p.flags.contains(js_ast::flags::Property::IsComputed) {
                    return Some("it has a computed key".into());
                }
                // F591 (Mellow F2): a conversion of this object at load (a template, `+`, `String(o)`, `JSON.stringify`)
                // runs these as app code.
                if self.load_only
                    && let Some(E::EString(k)) = p.key.as_ref().map(|k| &k.data)
                    && CONVERSION_HOOKS.contains(&crate::analyze::expr::estring(k).as_str())
                {
                    return Some(format!(
                        "it declares `{}`, which a conversion may run",
                        crate::analyze::expr::estring(k)
                    ));
                }
                // F597 D2: in the load-time judge an object spread copies only a value proven to be plain data (an
                // imported object or a call result could run a getter of app code).
                if self.load_only
                    && matches!(p.kind, js_ast::G::PropertyKind::Spread)
                    && p.value.as_ref().is_some_and(|v| !self.data(v, depth + 1))
                {
                    return Some(format!(
                        "it spreads `...{}`, which brust cannot prove is plain data, into an object",
                        p.value.as_ref().map(&spell).unwrap_or_default()
                    ));
                }
                p.value.as_ref().and_then(&go)
            }),
            // F564 D1: `Array.from({ length: <number> }, (_, i) => <primitive code>)`.
            E::ECall(c) if array_from_target(&c.target, names) => array_from_table(c, names)
                .then_some(())
                .map_or_else(
                    || Some("it calls `Array.from(…)` with more than a length and a primitive callback".into()),
                    |_| None,
                ),
            E::ECall(c) => {
                // F597: inside a followed body or callback no package code is called.
                let allowed = c.was_jsx_element
                    || (package_rooted(&c.target) && self.strict.get() == 0)
                    || read_only_global(&c.target, names);
                if !allowed {
                    return Some(format!("it calls `{}(…)`", spell(&c.target)));
                }
                if !c.was_jsx_element
                    && let Some(w) = go(&c.target)
                {
                    return Some(w);
                }
                // F591 (Mellow F1): in the load-time judge, package code handed app code may run it at load (`onReady(() =>
                // …)`); brust's own store primitives run their setup only as the allowlist judges it (the function's
                // returned value), and React's `forwardRef` / `memo` / `cache` keep the function without calling it.
                if self.load_only && !c.was_jsx_element && package_rooted(&c.target) {
                    if store_primitive(&c.target, names) {
                        if let Some(w) = c.args.iter().find_map(|a| self.setup_why(a, depth)) {
                            return Some(w);
                        }
                    } else if !react_stores_fn(&c.target, names) && c.args.iter().any(|a| self.hands_code(a, 0)) {
                        return Some(format!("it hands app code to `{}(…)`", spell(&c.target)));
                    }
                }
                // Package code handed a module array or object could change it.
                if package_rooted(&c.target)
                    && !react_stores_fn(&c.target, names)
                    && c.args.iter().any(hands)
                {
                    return Some(format!(
                        "it hands a module object to `{}(…)`",
                        spell(&c.target)
                    ));
                }
                if read_only_global(&c.target, names)
                    && c.args
                        .iter()
                        .any(|a| matches!(a.data, E::EArrow(_) | E::EFunction(_)))
                {
                    return Some(format!("it hands a function to `{}(…)`", spell(&c.target)));
                }
                c.args.iter().find_map(|a| match &a.data {
                    E::ESpread(_) => Some(format!(
                        "it spreads arguments into `{}(…)`",
                        spell(&c.target)
                    )),
                    _ => go(a),
                })
            }
            E::ENew(n) if self.load_only => self.new_why(n, depth),
            E::ENew(n) => Some(format!("it constructs `new {}(…)`", spell(&n.target))),
            // F564 D1: a regex literal runs nothing; one with `g` or `y` keeps `lastIndex` between uses.
            E::ERegExp(r) => r
                .flags()
                .iter()
                .any(|f| matches!(f, b'g' | b'y'))
                .then(|| "it holds a global or sticky regex literal, which keeps state between uses".into()),
            // F564 D1: template strings and operators over accepted values. A coercion (a template part, `+`, `<`, `==`,
            // `-x`) may call the value's `toString` / `valueOf`: an accepted value of this module holds no writing code
            // (the invariant), but a value rooted at an app import is not proven, so it is not coerced. ToBoolean (`!`,
            // `?:`, `&&`, `||`, `??`) and `===` / `typeof` call nothing.
            E::ETemplate(t) => {
                if t.tag.is_some() {
                    return Some("it calls a tagged template".into());
                }
                t.parts().iter().find_map(|p| self.coerced(&p.value).or_else(|| go(&p.value)))
            }
            E::EIf(i) => go(&i.test).or_else(|| go(&i.yes)).or_else(|| go(&i.no)),
            E::EUnary(u) => match u.op {
                js_ast::OpCode::UnNot | js_ast::OpCode::UnTypeof | js_ast::OpCode::UnVoid => go(&u.value),
                js_ast::OpCode::UnPos | js_ast::OpCode::UnNeg | js_ast::OpCode::UnCpl => {
                    self.coerced(&u.value).or_else(|| go(&u.value))
                }
                _ => Some("it changes a value (`delete`, `++`, `--`)".into()),
            },
            E::EBinary(b) => {
                use js_ast::OpCode as O;
                match b.op {
                    O::BinLogicalOr
                    | O::BinLogicalAnd
                    | O::BinNullishCoalescing
                    | O::BinStrictEq
                    | O::BinStrictNe
                    | O::BinComma => go(&b.left).or_else(|| go(&b.right)),
                    O::BinIn | O::BinInstanceof => {
                        Some("it uses `in` or `instanceof`, which may run a trap".into())
                    }
                    O::BinAdd
                    | O::BinSub
                    | O::BinMul
                    | O::BinDiv
                    | O::BinRem
                    | O::BinPow
                    | O::BinLt
                    | O::BinLe
                    | O::BinGt
                    | O::BinGe
                    | O::BinLooseEq
                    | O::BinLooseNe
                    | O::BinShl
                    | O::BinShr
                    | O::BinUShr
                    | O::BinBitwiseOr
                    | O::BinBitwiseAnd
                    | O::BinBitwiseXor => self
                        .coerced(&b.left)
                        .or_else(|| self.coerced(&b.right))
                        .or_else(|| go(&b.left))
                        .or_else(|| go(&b.right)),
                    _ => Some("it assigns".into()),
                }
            }
            E::EAwait(_) => Some("it awaits".into()),
            _ => Some(format!("it holds `{}`", spell(e))),
        }
    }
}

impl Values<'_, '_> {
    /// F591 (AMENDMENT 3, fail-closed): whether `a` may hand app code to the package call it is an argument of. "No code"
    /// only for shapes known to be data: a literal, an untagged template of data, an identifier that is neither a
    /// function of this module nor an app import, and arrays / objects / spreads of those (plain properties, no
    /// computed key). Everything else (a function, a logical / comma / conditional expression, a call, a member, …)
    /// hands code.
    fn hands_code(&self, a: &js_ast::Expr, depth: u8) -> bool {
        if depth > 16 {
            return true;
        }
        let app_import = |r: js_ast::Ref| {
            self.names
                .import_of(r)
                .is_some_and(|(src, _)| app_specifier(src))
        };
        match &a.data {
            E::EString(_)
            | E::ENumber(_)
            | E::EBoolean(_)
            | E::ENull(_)
            | E::EUndefined(_)
            | E::EBigInt(_) => false,
            E::EUnary(u) if matches!(u.op, js_ast::OpCode::UnNeg | js_ast::OpCode::UnPos) => {
                !matches!(u.value.data, E::ENumber(_) | E::EBigInt(_))
            }
            E::ETemplate(t) => {
                t.tag.is_some()
                    || t.parts()
                        .iter()
                        .any(|p| self.hands_code(&p.value, depth + 1))
            }
            E::EIdentifier(id) => {
                self.functions.contains(&self.names.key_of(id.ref_)) || app_import(id.ref_)
            }
            E::EImportIdentifier(id) => app_import(id.ref_),
            E::EArray(arr) => arr.items.iter().any(|x| self.hands_code(x, depth + 1)),
            E::EObject(o) => o.properties.iter().any(|p| {
                !matches!(
                    p.kind,
                    js_ast::G::PropertyKind::Normal | js_ast::G::PropertyKind::Spread
                ) || p.flags.contains(js_ast::flags::Property::IsComputed)
                    || p.value
                        .as_ref()
                        .is_some_and(|v| self.hands_code(v, depth + 1))
            }),
            E::ESpread(sp) => self.hands_code(&sp.value, depth + 1),
            _ => true,
        }
    }

    /// F591: an argument of a brust store primitive: data is judged as any value; a setup function only as the value it
    /// returns (a single returned expression), which the same judge must accept.
    fn setup_why(&self, a: &js_ast::Expr, depth: u8) -> Option<String> {
        let E::EArrow(f) = &a.data else {
            return if self.hands_code(a, 0) {
                Some("it hands a store primitive code that is not one returned value".into())
            } else {
                self.why(a, depth + 1)
            };
        };
        let [body] = f.body.stmts.slice() else {
            return Some("it hands a store primitive a setup function with statements".into());
        };
        match &body.data {
            S::SReturn(r) => r.value.as_ref().and_then(|v| self.why(v, depth + 1)),
            _ => Some("it hands a store primitive a setup function with statements".into()),
        }
    }

    /// F564 D1: a value that a coercion would run code of an app import for (`${ICON.overview}`, `ICON + 1`).
    fn coerced(&self, e: &js_ast::Expr) -> Option<String> {
        match &e.data {
            E::EIf(i) => self.coerced(&i.yes).or_else(|| self.coerced(&i.no)),
            E::EBinary(b)
                if matches!(
                    b.op,
                    js_ast::OpCode::BinLogicalOr
                        | js_ast::OpCode::BinLogicalAnd
                        | js_ast::OpCode::BinNullishCoalescing
                ) =>
            {
                self.coerced(&b.left).or_else(|| self.coerced(&b.right))
            }
            _ => chain_root(e)
                .filter(|r| {
                    self.names
                        .import_of(*r)
                        .is_some_and(|(src, _)| app_specifier(src))
                })
                .map(|_| {
                    format!(
                        "it converts `{}`, an imported value, to a string or a number (that may run its code)",
                        spell(e, self.names)
                    )
                }),
        }
    }
}

/// F597: the load-time judge's own forms (D1-D4). Each proves a value is fresh data or a call runs only code it judged.
impl Values<'_, '_> {
    fn global_named(&self, e: &js_ast::Expr, set: &[&str]) -> Option<String> {
        match &e.data {
            E::EIdentifier(id)
                if matches!(self.names.kind_of(id.ref_).1, crate::ir::IdentKind::Global) =>
            {
                let n = self.names.name(id.ref_);
                set.contains(&n.as_str()).then_some(n)
            }
            _ => None,
        }
    }

    /// The shape `e` is proven to have. Only fresh values qualify: an array literal of data, a D1 collection, a module
    /// `const` holding one, a D3 method result, an app import of a literal array (F564's literal-export proof).
    fn kind(&self, e: &js_ast::Expr, depth: u8) -> Option<Kind> {
        if depth > 16 {
            return None;
        }
        match &e.data {
            E::EArray(a) => a
                .items
                .iter()
                .all(|x| match &x.data {
                    E::ESpread(sp) => self
                        .kind(&sp.value, depth + 1)
                        .is_some_and(|k| k != Kind::Weak),
                    _ => self.data(x, depth + 1),
                })
                .then_some(Kind::Array),
            E::ENew(n) => match self
                .global_named(&n.target, &["Set", "Map", "WeakSet", "WeakMap"])?
                .as_str()
            {
                "Set" => Some(Kind::Set),
                "Map" => Some(Kind::Map),
                _ => Some(Kind::Weak),
            },
            // A value read from proven data (a data local, a member of one or of a module data const) holds no code: a
            // method of the list is the built-in one, or the call throws; it never runs app code.
            E::EDot(_) | E::EIndex(_) => self.data(e, depth + 1).then_some(Kind::Array),
            E::EIdentifier(id) => {
                let k = self.names.key_of(id.ref_);
                if self.locals.borrow().contains(&k) {
                    return self
                        .data_locals
                        .borrow()
                        .contains(&k)
                        .then_some(Kind::Array);
                }
                if let Some(init) = self.inits.get(&k) {
                    return self.kind(init, depth + 1);
                }
                self.import_kind(id.ref_)
            }
            E::EImportIdentifier(id) => self.import_kind(id.ref_),
            // `.add(v)` / `.set(k, v)` chained on the `new` itself returns the same fresh collection.
            E::ECall(c) => self.kind_call(c, depth),
            _ => None,
        }
    }

    fn chained_on_new(e: &js_ast::Expr) -> bool {
        match &e.data {
            E::ENew(_) => true,
            E::ECall(c) => matches!(&c.target.data, E::EDot(d) if Self::chained_on_new(&d.target)),
            _ => false,
        }
    }

    fn import_kind(&self, r: js_ast::Ref) -> Option<Kind> {
        let (src, imp) = self.names.import_of(r)?;
        (app_specifier(src) && (self.import_read)(src, imp, &[])).then_some(Kind::Array)
    }

    /// Data that holds no code and no app-imported value, so a callback, a conversion or a copy of it runs only built-in
    /// code: literals, untagged templates and operators over data, array / object literals of data (plain properties,
    /// no conversion hook), a local of a judged body, a module `const` holding data or folded, and fresh values.
    fn data(&self, e: &js_ast::Expr, depth: u8) -> bool {
        if depth > 16 {
            return false;
        }
        let go = |x: &js_ast::Expr| self.data(x, depth + 1);
        match &e.data {
            E::EString(_)
            | E::ENumber(_)
            | E::EBoolean(_)
            | E::ENull(_)
            | E::EUndefined(_)
            | E::EBigInt(_) => true,
            E::ETemplate(t) => t.tag.is_none() && t.parts().iter().all(|p| go(&p.value)),
            E::EArray(_) => self.kind(e, depth + 1).is_some(),
            // Review F1: a collection or a method result is data only when its elements are.
            E::ENew(n) => match self.global_named(&n.target, &["Set", "Map", "WeakSet", "WeakMap"]) {
                Some(_) => n.args.iter().all(&go),
                None => false,
            },
            E::ECall(c) => self.data_call(c, depth + 1),
            E::EObject(o) => o.properties.iter().all(|p| {
                matches!(p.kind, js_ast::G::PropertyKind::Normal)
                    && !p.flags.contains(js_ast::flags::Property::IsComputed)
                    && !matches!(p.key.as_ref().map(|k| &k.data),
                        Some(E::EString(k)) if CONVERSION_HOOKS.contains(&crate::analyze::expr::estring(k).as_str()))
                    && p.value.as_ref().is_some_and(&go)
            }),
            E::EIdentifier(id) => {
                let k = self.names.key_of(id.ref_);
                let n = self.names.name(id.ref_);
                self.data_locals.borrow().contains(&k)
                    || (!self.locals.borrow().contains(&k) && self.inits.get(&k).is_some_and(&go))
                    || (self.module.contains(&k) && (self.accepted)(&n) && !self.functions.contains(&k))
                    || (matches!(n.as_str(), "undefined" | "NaN" | "Infinity")
                        && matches!(self.names.kind_of(id.ref_).1, crate::ir::IdentKind::Global))
            }
            E::EUnary(u) => {
                !matches!(
                    u.op,
                    js_ast::OpCode::UnPreInc
                        | js_ast::OpCode::UnPreDec
                        | js_ast::OpCode::UnPostInc
                        | js_ast::OpCode::UnPostDec
                        | js_ast::OpCode::UnDelete
                ) && go(&u.value)
            }
            E::EBinary(b) => {
                matches!(b.op.binary_assign_target(), js_ast::AssignTarget::None)
                    && !matches!(b.op, js_ast::OpCode::BinIn | js_ast::OpCode::BinInstanceof)
                    && go(&b.left)
                    && go(&b.right)
            }
            E::EIf(i) => go(&i.test) && go(&i.yes) && go(&i.no),
            // A member of data is data (`row.scopes`, `pairs[0]`); an optional step or a key that is not data is not.
            E::EDot(d) => d.optional_chain.is_none() && go(&d.target),
            E::EIndex(i) => i.optional_chain.is_none() && go(&i.target) && go(&i.index),
            _ => false,
        }
    }

    /// Review F1: a D3 call whose result holds data only: a method that keeps the receiver's elements on a data receiver
    /// (with data arguments), `map` / `flatMap` whose inline callback returns only data, `add` / `set` chained on a
    /// data collection with data arguments.
    fn data_call(&self, c: &js_ast::E::Call, depth: u8) -> bool {
        if depth > 16 || c.optional_chain.is_some() || self.kind_call(c, depth).is_none() {
            return false;
        }
        let E::EDot(d) = &c.target.data else {
            return false;
        };
        let m = String::from_utf8_lossy(d.name.slice());
        let args_data = || {
            c.args.iter().all(|a| {
                matches!(a.data, E::EArrow(_) | E::EFunction(_)) || self.data(a, depth + 1)
            })
        };
        match m.as_ref() {
            "filter" | "slice" | "sort" | "toSorted" | "reverse" | "toReversed" | "flat"
            | "concat" | "add" | "set" | "keys" | "values" | "entries" => {
                self.data(&d.target, depth + 1) && args_data()
            }
            "map" | "flatMap" => {
                self.data(&d.target, depth + 1)
                    && c.args
                        .first()
                        .is_some_and(|f| self.returns_data(f, depth + 1))
            }
            _ => false,
        }
    }

    fn kind_call(&self, c: &js_ast::E::Call, depth: u8) -> Option<Kind> {
        let E::EDot(d) = &c.target.data else {
            return None;
        };
        let m = String::from_utf8_lossy(d.name.slice());
        let m = m.as_ref();
        match self.kind(&d.target, depth + 1)? {
            Kind::Array if ARRAY_RETURNING.contains(&m) => Some(Kind::Array),
            Kind::Set | Kind::Map if matches!(m, "keys" | "values" | "entries") => Some(Kind::Iter),
            Kind::Set if m == "add" && Self::chained_on_new(&d.target) => Some(Kind::Set),
            Kind::Map if m == "set" && Self::chained_on_new(&d.target) => Some(Kind::Map),
            _ => None,
        }
    }

    /// Review F1: every value the inline callback `f` returns (each `return`, or the arrow's expression) is data, with
    /// its parameters as data (elements of a data receiver) and its locals data only when their values are.
    fn returns_data(&self, f: &js_ast::Expr, depth: u8) -> bool {
        let (args, stmts) = match &f.data {
            E::EArrow(a) => (a.args.slice(), a.body.stmts.slice()),
            E::EFunction(f) => (f.func.args.slice(), f.func.body.stmts.slice()),
            _ => return false,
        };
        for a in args {
            self.declare_quiet(&a.binding, true);
        }
        self.returns_in(stmts, depth)
    }

    fn returns_in(&self, stmts: &[js_ast::Stmt], depth: u8) -> bool {
        if depth > 16 {
            return false;
        }
        stmts.iter().all(|st| match &st.data {
            S::SReturn(r) => r.value.as_ref().is_none_or(|v| self.data(v, depth + 1)),
            S::SBlock(b) => self.returns_in(b.stmts.slice(), depth + 1),
            S::SIf(i) => {
                self.returns_in(std::slice::from_ref(&i.yes), depth + 1)
                    && i.no
                        .as_ref()
                        .is_none_or(|n| self.returns_in(std::slice::from_ref(n), depth + 1))
            }
            S::SForOf(f) => self.returns_in(std::slice::from_ref(&f.body), depth + 1),
            S::SLocal(l) => {
                for d in l.decls.iter() {
                    let data = d.value.as_ref().is_none_or(|v| self.data(v, depth + 1));
                    self.declare_quiet(&d.binding, data);
                }
                true
            }
            _ => true,
        })
    }

    /// Review F2: `e` is a value this module or the judged body built, so sorting it in place changes nothing another
    /// module can see: a fresh expression, an own local, a module `const` whose initializer is fresh, or a member of one.
    fn own_value(&self, e: &js_ast::Expr, depth: u8) -> bool {
        if depth > 16 {
            return false;
        }
        match &e.data {
            E::EArray(_) | E::ENew(_) => true,
            E::ECall(c) => matches!(&c.target.data, E::EDot(d)
                if matches!(String::from_utf8_lossy(d.name.slice()).as_ref(),
                    "filter" | "map" | "flatMap" | "slice" | "concat" | "flat" | "toSorted" | "toReversed")),
            E::EIdentifier(id) => {
                let k = self.names.key_of(id.ref_);
                if self.locals.borrow().contains(&k) {
                    return self.own_locals.borrow().contains(&k);
                }
                self.inits
                    .get(&k)
                    .is_some_and(|v| self.own_value(v, depth + 1))
            }
            // A member is the module's own only inside data it built (data holds no imported reference).
            E::EDot(d) => self.own_value(&d.target, depth + 1) && self.data(&d.target, depth + 1),
            E::EIndex(i) => self.own_value(&i.target, depth + 1) && self.data(&i.target, depth + 1),
            _ => false,
        }
    }

    /// F597 D1: `new Set(x?)` / `new Map(x?)` of the GLOBAL with `x` absent or a fresh iterable; `new WeakSet()` /
    /// `new WeakMap()` empty.
    fn new_why(&self, n: &js_ast::E::New, depth: u8) -> Option<String> {
        let refused = || {
            Some(format!(
                "it constructs `new {}(…)`",
                spell(&n.target, self.names)
            ))
        };
        let Some(name) = self.global_named(&n.target, &["Set", "Map", "WeakSet", "WeakMap"]) else {
            return refused();
        };
        match n.args.as_slice() {
            [] => None,
            [x] if matches!(name.as_str(), "Set" | "Map") => {
                if self.kind(x, depth + 1).is_some_and(|k| k != Kind::Weak) {
                    self.why(x, depth + 1)
                } else {
                    Some(format!(
                        "it constructs `new {name}(…)` of a value brust cannot prove is a fresh array, Set or Map"
                    ))
                }
            }
            _ => refused(),
        }
    }

    /// F597 D3 / D4: `Some(verdict)` for a call this judge's forms cover, `None` to leave it to the general rules.
    fn load_call(&self, c: &js_ast::E::Call, depth: u8) -> Option<Option<String>> {
        if c.optional_chain.is_some() || c.was_jsx_element {
            return None;
        }
        match &c.target.data {
            E::EDot(d) => {
                let m = String::from_utf8_lossy(d.name.slice()).into_owned();
                let k = self.kind(&d.target, depth + 1)?;
                let ok = match k {
                    Kind::Array => ARRAY_METHODS.contains(&m.as_str()),
                    Kind::Set => {
                        COLLECTION_METHODS.contains(&m.as_str())
                            || (m == "add" && Self::chained_on_new(&d.target))
                    }
                    Kind::Map => {
                        COLLECTION_METHODS.contains(&m.as_str())
                            || (m == "set" && Self::chained_on_new(&d.target))
                    }
                    Kind::Weak | Kind::Iter => false,
                };
                if !ok {
                    return None;
                }
                Some(self.method_why(c, &d.target, &m, depth))
            }
            E::EIdentifier(id) => {
                let k = self.names.key_of(id.ref_);
                let body = *self.bodies.get(&k)?;
                Some(self.follow_why(c, k, &self.names.name(id.ref_), body, depth))
            }
            _ => None,
        }
    }

    fn method_why(
        &self,
        c: &js_ast::E::Call,
        recv: &js_ast::Expr,
        m: &str,
        depth: u8,
    ) -> Option<String> {
        let spelled = || spell(&c.target, self.names);
        if let Some(w) = self.why(recv, depth + 1) {
            return Some(w);
        }
        // Review F2: sorting in place may only change a value this module or the judged body built, at every level.
        if matches!(m, "sort" | "reverse") && !self.own_value(recv, depth + 1) {
            return Some(format!(
                "it sorts `{}` in place, a value this module did not build",
                spell(recv, self.names)
            ));
        }
        // Review F1: a callback's parameters are data only when the receiver (and every other argument) is data.
        let elems_data = self.data(recv, depth + 1)
            && c.args.iter().all(|a| {
                matches!(a.data, E::EArrow(_) | E::EFunction(_)) || self.data(a, depth + 1)
            });
        for (i, a) in c.args.iter().enumerate() {
            match &a.data {
                E::ESpread(_) => {
                    return Some(format!("it spreads arguments into `{}(…)`", spelled()));
                }
                E::EArrow(_) | E::EFunction(_) => {
                    if i != 0 || !CALLBACK_METHODS.contains(&m) {
                        return Some(format!("it hands a function to `{}(…)`", spelled()));
                    }
                    if let Some(w) = self.callback_why(a, elems_data, depth) {
                        return Some(w);
                    }
                }
                _ => {
                    if let Some(w) = self.why(a, depth + 1) {
                        return Some(w);
                    }
                    if !self.data(a, depth + 1) {
                        return Some(format!(
                            "it hands `{}(…)` a value brust cannot prove is plain data",
                            spelled()
                        ));
                    }
                }
            }
        }
        if CALLBACK_METHODS.contains(&m) && !matches!(m, "sort" | "toSorted") && c.args.is_empty() {
            return Some(format!("it calls `{}(…)` without a callback", spelled()));
        }
        None
    }

    /// F597 D3: an inline callback, judged with its parameters as locals.
    fn callback_why(&self, f: &js_ast::Expr, params_data: bool, depth: u8) -> Option<String> {
        let (args, stmts, plain) = match &f.data {
            E::EArrow(a) => (
                a.args.slice(),
                a.body.stmts.slice(),
                !a.is_async && !a.has_rest_arg,
            ),
            E::EFunction(f) => {
                let fl = f.func.flags;
                (
                    f.func.args.slice(),
                    f.func.body.stmts.slice(),
                    !fl.contains(js_ast::flags::Function::IsAsync)
                        && !fl.contains(js_ast::flags::Function::IsGenerator)
                        && !fl.contains(js_ast::flags::Function::HasRestArg),
                )
            }
            _ => return Some("it hands a value that is not an inline function".into()),
        };
        if !plain {
            return Some("its callback is async, a generator or takes a rest parameter".into());
        }
        self.params_and_body(args, stmts, params_data, depth)
    }

    /// F597 D4: a call at load of a function of this module, with data arguments and a body this judge follows.
    fn follow_why(
        &self,
        c: &js_ast::E::Call,
        k: u32,
        name: &str,
        body: FnBody<'_>,
        depth: u8,
    ) -> Option<String> {
        if self.visiting.borrow().contains(&k) {
            return Some(format!("it calls `{name}` from itself"));
        }
        if !body.plain {
            return Some(format!(
                "it calls `{name}`, an async or generator function or one with a rest parameter"
            ));
        }
        for a in c.args.iter() {
            if matches!(a.data, E::ESpread(_) | E::EArrow(_) | E::EFunction(_))
                || matches!(&a.data, E::EIdentifier(id) if self.functions.contains(&self.names.key_of(id.ref_)))
            {
                return Some(format!("it hands `{name}(…)` a function or a spread"));
            }
            if let Some(w) = self.why(a, depth + 1) {
                return Some(w);
            }
            if !self.data(a, depth + 1) {
                return Some(format!(
                    "it hands `{name}(…)` a value brust cannot prove is plain data"
                ));
            }
        }
        self.visiting.borrow_mut().push(k);
        let r = self.params_and_body(body.args, body.stmts, true, depth);
        self.visiting.borrow_mut().pop();
        r.map(|w| format!("it calls `{name}`, whose body {w}"))
    }

    fn params_and_body(
        &self,
        args: &[js_ast::G::Arg],
        stmts: &[js_ast::Stmt],
        params_data: bool,
        depth: u8,
    ) -> Option<String> {
        self.frames.borrow_mut().push(HashSet::new());
        let r = self.params_and_body_in(args, stmts, params_data, depth);
        self.frames.borrow_mut().pop();
        r
    }

    fn params_and_body_in(
        &self,
        args: &[js_ast::G::Arg],
        stmts: &[js_ast::Stmt],
        params_data: bool,
        depth: u8,
    ) -> Option<String> {
        for a in args {
            if !plain_pattern(&a.binding) {
                return Some("a parameter pattern has a default value or a computed key".into());
            }
            if let Some(d) = &a.default {
                if let Some(w) = self.why(d, depth + 1) {
                    return Some(w);
                }
                if !self.data(d, depth + 1) {
                    return Some("a parameter default is not plain data".into());
                }
            }
            // A parameter holds what the call site handed: data for D4 arguments and for D3 elements of a data receiver.
            self.declare(&a.binding, params_data);
        }
        self.strict.set(self.strict.get() + 1);
        let r = self.body_why(stmts, depth + 1);
        self.strict.set(self.strict.get() - 1);
        r
    }

    fn declare(&self, b: &js_ast::Binding, data: bool) {
        let keys = self.declare_quiet(b, data);
        if let Some(f) = self.frames.borrow_mut().last_mut() {
            f.extend(keys);
        }
    }

    /// Declares the binding's names as locals (data or not) without adding them to the current frame.
    fn declare_quiet(&self, b: &js_ast::Binding, data: bool) -> Vec<u32> {
        let mut w = Walk::default();
        w.declare_binding(b);
        let keys: Vec<u32> = w.declared.iter().map(|r| self.names.key_of(*r)).collect();
        self.locals.borrow_mut().extend(keys.iter().copied());
        let mut dl = self.data_locals.borrow_mut();
        for k in &keys {
            if data {
                dl.insert(*k);
            } else {
                dl.remove(k);
            }
        }
        keys
    }

    /// F597 D3 / D4: a body of `const` / `let` of judged values, `if`, `return`, blocks, `for…of` over a fresh iterable,
    /// and assignments to its own locals; nothing else.
    fn body_why(&self, stmts: &[js_ast::Stmt], depth: u8) -> Option<String> {
        if depth > 16 {
            return Some("it nests deeper than the compiler follows".into());
        }
        // Review F3: a body assigns only a local it declares itself (not one of an enclosing body).
        let local = |e: &js_ast::Expr| {
            matches!(&e.data, E::EIdentifier(id) if self
                .frames
                .borrow()
                .last()
                .is_some_and(|f| f.contains(&self.names.key_of(id.ref_))))
        };
        for st in stmts {
            let why = match &st.data {
                S::SEmpty(_) | S::SComment(_) | S::SDirective(_) | S::STypeScript(_) => None,
                S::SReturn(r) => r.value.as_ref().and_then(|v| self.why(v, depth + 1)),
                S::SBlock(b) => self.body_why(b.stmts.slice(), depth + 1),
                S::SIf(i) => self
                    .why(&i.test, depth + 1)
                    .or_else(|| self.body_why(std::slice::from_ref(&i.yes), depth + 1))
                    .or_else(|| {
                        i.no.as_ref()
                            .and_then(|n| self.body_why(std::slice::from_ref(n), depth + 1))
                    }),
                S::SLocal(l) => l.decls.iter().find_map(|d| {
                    if !plain_pattern(&d.binding) {
                        return Some(
                            "a local pattern has a default value or a computed key".into(),
                        );
                    }
                    let w = d.value.as_ref().and_then(|v| self.why(v, depth + 1));
                    let data = d.value.as_ref().is_none_or(|v| self.data(v, depth + 1));
                    self.declare(&d.binding, data);
                    // Review F2: a local is its body's own value only when it holds what the body built.
                    if let (js_ast::b::B::BIdentifier(id), Some(v)) = (d.binding.data, &d.value)
                        && !matches!(
                            v.data,
                            E::EIdentifier(_) | E::EImportIdentifier(_) | E::EDot(_) | E::EIndex(_)
                        )
                        && self.own_value(v, depth + 1)
                    {
                        self.own_locals
                            .borrow_mut()
                            .insert(self.names.key_of(id.r#ref));
                    }
                    w
                }),
                S::SForOf(f) => {
                    if f.is_await {
                        Some("it awaits".into())
                    } else if !self
                        .kind(&f.value, depth + 1)
                        .is_some_and(|k| k != Kind::Weak)
                    {
                        Some(format!(
                            "it loops over `{}`, which brust cannot prove is a fresh array, Set or Map",
                            spell(&f.value, self.names)
                        ))
                    } else if let Some(w) = self.why(&f.value, depth + 1) {
                        Some(w)
                    } else {
                        match &f.init.data {
                            S::SLocal(l)
                                if l.decls
                                    .iter()
                                    .all(|d| d.value.is_none() && plain_pattern(&d.binding)) =>
                            {
                                // Elements of a data iterable are data; of another fresh one (functions inside) they are not.
                                let elems = self.data(&f.value, depth + 1);
                                for d in l.decls.iter() {
                                    self.declare(&d.binding, elems);
                                }
                                // Review F3: the body runs again with what its previous run left: judge it until the data
                                // locals stop shrinking.
                                let mut r = None;
                                for _ in 0..16 {
                                    let before = self.data_locals.borrow().len();
                                    r = self.body_why(std::slice::from_ref(&f.body), depth + 1);
                                    if r.is_some() || self.data_locals.borrow().len() == before {
                                        break;
                                    }
                                }
                                r
                            }
                            _ => Some("its loop does not declare its own binding".into()),
                        }
                    }
                }
                S::SExpr(x) => match &x.value.data {
                    E::EBinary(b)
                        if !matches!(b.op.binary_assign_target(), js_ast::AssignTarget::None) =>
                    {
                        if local(&b.left) {
                            // A local stays data only while every value it is given is data, and its body's own only while
                            // nothing else is assigned to it.
                            if let E::EIdentifier(id) = &b.left.data {
                                let k = self.names.key_of(id.ref_);
                                if !self.data(&b.right, depth + 1) {
                                    self.data_locals.borrow_mut().remove(&k);
                                }
                                self.own_locals.borrow_mut().remove(&k);
                            }
                            self.why(&b.right, depth + 1)
                                .or_else(|| self.coerced(&b.right))
                        } else {
                            Some(format!(
                                "it assigns `{}`, which its function does not declare",
                                spell(&b.left, self.names)
                            ))
                        }
                    }
                    E::EUnary(u)
                        if matches!(
                            u.op,
                            js_ast::OpCode::UnPreInc
                                | js_ast::OpCode::UnPreDec
                                | js_ast::OpCode::UnPostInc
                                | js_ast::OpCode::UnPostDec
                        ) =>
                    {
                        (!local(&u.value)).then(|| {
                            format!(
                                "it changes `{}`, which its function does not declare",
                                spell(&u.value, self.names)
                            )
                        })
                    }
                    _ => self.why(&x.value, depth + 1),
                },
                _ => Some("its function body has a statement brust does not follow".into()),
            };
            if why.is_some() {
                return why;
            }
        }
        None
    }
}

/// `Array.from` (the global).
fn array_from_target(t: &js_ast::Expr, names: &NameTable<'_>) -> bool {
    matches!(&t.data, E::EDot(d) if d.name.slice() == b"from"
        && matches!(&d.target.data, E::EIdentifier(id)
            if names.name(id.ref_) == "Array" && matches!(names.kind_of(id.ref_).1, crate::ir::IdentKind::Global)))
}

/// F564 D1 (kept narrow): `Array.from({ length: <number literal> }, <arrow>)` whose arrow (no defaults, not async) returns
/// an expression built from literals, its own parameters, operators, templates, the read-only globals and the methods of
/// the primitives it makes (`String(i).padStart(2, '0')`). Every value in it is a primitive, so the methods are the
/// built-in ones.
fn array_from_table(c: &js_ast::E::Call, names: &NameTable<'_>) -> bool {
    const PRIMITIVE_METHODS: &[&str] = &[
        "padStart",
        "padEnd",
        "toString",
        "toFixed",
        "slice",
        "toUpperCase",
        "toLowerCase",
        "repeat",
        "trim",
    ];
    let args = c.args.as_slice();
    let [len, cb] = args else { return false };
    let E::EObject(o) = &len.data else {
        return false;
    };
    let [p] = o.properties.as_slice() else {
        return false;
    };
    let key_is_length = match p.key.as_ref().map(|k| &k.data) {
        Some(E::EString(k)) => crate::analyze::expr::estring(k) == "length",
        _ => false,
    };
    let length_ok = matches!(p.kind, js_ast::G::PropertyKind::Normal)
        && !p.flags.contains(js_ast::flags::Property::IsComputed)
        && key_is_length
        && matches!(p.value.as_ref().map(|v| &v.data), Some(E::ENumber(_)));
    let E::EArrow(a) = &cb.data else { return false };
    if !length_ok || a.is_async || a.has_rest_arg {
        return false;
    }
    let mut params: HashSet<u32> = HashSet::new();
    for arg in a.args.slice() {
        if arg.default.is_some() {
            return false;
        }
        match arg.binding.data {
            js_ast::b::B::BIdentifier(id) => {
                params.insert(names.key_of(id.r#ref));
            }
            _ => return false,
        }
    }
    let [body] = a.body.stmts.slice() else {
        return false;
    };
    let S::SReturn(r) = &body.data else {
        return false;
    };
    let Some(v) = &r.value else { return false };
    fn ok(e: &js_ast::Expr, params: &HashSet<u32>, names: &NameTable<'_>, depth: u8) -> bool {
        if depth > 16 {
            return false;
        }
        let go = |x: &js_ast::Expr| ok(x, params, names, depth + 1);
        match &e.data {
            E::EString(_) | E::ENumber(_) | E::EBoolean(_) | E::ENull(_) | E::EUndefined(_) => true,
            E::EIdentifier(id) => params.contains(&names.key_of(id.ref_)),
            E::ETemplate(t) => t.tag.is_none() && t.parts().iter().all(|p| go(&p.value)),
            E::EIf(i) => go(&i.test) && go(&i.yes) && go(&i.no),
            E::EUnary(u) => {
                matches!(
                    u.op,
                    js_ast::OpCode::UnNot
                        | js_ast::OpCode::UnNeg
                        | js_ast::OpCode::UnPos
                        | js_ast::OpCode::UnTypeof
                ) && go(&u.value)
            }
            E::EBinary(b) => {
                use js_ast::OpCode as O;
                matches!(
                    b.op,
                    O::BinAdd
                        | O::BinSub
                        | O::BinMul
                        | O::BinDiv
                        | O::BinRem
                        | O::BinPow
                        | O::BinLt
                        | O::BinLe
                        | O::BinGt
                        | O::BinGe
                        | O::BinStrictEq
                        | O::BinStrictNe
                        | O::BinLooseEq
                        | O::BinLooseNe
                        | O::BinLogicalOr
                        | O::BinLogicalAnd
                        | O::BinNullishCoalescing
                        | O::BinBitwiseAnd
                        | O::BinBitwiseOr
                        | O::BinBitwiseXor
                        | O::BinShl
                        | O::BinShr
                        | O::BinUShr
                ) && go(&b.left)
                    && go(&b.right)
            }
            E::ECall(c) => {
                let args_ok = c
                    .args
                    .as_slice()
                    .iter()
                    .all(|a| !matches!(a.data, E::ESpread(_)) && go(a));
                args_ok
                    && (read_only_global(&c.target, names)
                        || matches!(&c.target.data, E::EDot(d)
                            if PRIMITIVE_METHODS.contains(&String::from_utf8_lossy(d.name.slice()).as_ref())
                                && go(&d.target)))
            }
            _ => false,
        }
    }
    ok(v, &params, names, 0)
}

/// F564 D1: one step of a read rooted at an import: a property name or an array index.
#[derive(Debug, Clone, PartialEq)]
pub enum ReadSeg {
    Key(String),
    Index(usize),
}

/// The steps of a member / literal-index chain from its root (`TABLE[0].label` -> `[Index(0), Key("label")]`); `None` for a
/// computed or optional step.
fn read_path(e: &js_ast::Expr) -> Option<Vec<ReadSeg>> {
    let mut out = Vec::new();
    let mut e = e;
    loop {
        match &e.data {
            E::EDot(d) if d.optional_chain.is_none() => {
                out.push(ReadSeg::Key(
                    String::from_utf8_lossy(d.name.slice()).into_owned(),
                ));
                e = &d.target;
            }
            E::EIndex(i) if i.optional_chain.is_none() => {
                out.push(match &i.index.data {
                    E::EString(s) => ReadSeg::Key(crate::analyze::expr::estring(s)),
                    E::ENumber(n)
                        if n.value() >= 0.0 && n.value().fract() == 0.0 && n.value() < 1e9 =>
                    {
                        ReadSeg::Index(n.value() as usize)
                    }
                    _ => return None,
                });
                e = &i.target;
            }
            E::EIdentifier(_) | E::EImportIdentifier(_) => break,
            _ => return None,
        }
    }
    out.reverse();
    Some(out)
}

/// F564 D1 (lead ruling 5e9842ab): reading `path` from the import `imported` of the app module `source` (seen from `from`)
/// runs no code: the import (named or default, not `* as`, followed through re-exports) names an `export const X =` object
/// or array literal (or an `export default` one) whose every step on `path` is a data property (no accessor, no computed
/// key, no spread, no `__proto__` key; nested literals checked down the path only; the VALUES are not constrained: the
/// exporting module evaluates them, and reading a data property of a literal runs nothing), `X` has no use in its module
/// that is not proven read-only (`use_scan::unsafe_to_fold`), and the build-wide scan (F230) shows no module writing it
/// when it loads. Without that scan (a single-file compile) nothing is refused for it, as F230 does.
pub fn plain_import_read(
    from: &str,
    source: &str,
    imported: &str,
    path: &[ReadSeg],
    opts: &crate::analyze::component::AnalyzeOptions,
) -> bool {
    if imported == "*" || !app_specifier(source) || path.is_empty() {
        return false;
    }
    let Some(start) = crate::analyze::modules::resolve_module(from, source, opts) else {
        return false;
    };
    let declared = |ast: &js_ast::Ast<'_>, n: &str| export_literal(ast, n).is_some();
    let Some((module, export)) =
        crate::analyze::hooks::follow_export(opts, start, imported.to_string(), &declared)
    else {
        return false;
    };
    if opts
        .load_writes
        .as_deref()
        .is_some_and(|lw| lw.why(&module, &export).is_some())
    {
        return false;
    }
    let Ok(bytes) = std::fs::read(opts.root.join(&module)) else {
        return false;
    };
    let Ok(parsed) = crate::parse::parse_cached(&module, bytes) else {
        return false;
    };
    parsed.with_ast(|ast| {
        let Some((value, binding)) = export_literal(ast, &export) else {
            return false;
        };
        if let Some(r) = binding {
            let dummy = js_ast::G::Fn::default();
            let names = NameTable::new(ast, &dummy);
            if crate::analyze::use_scan::unsafe_to_fold(ast, &names).contains(&r.inner_index()) {
                return false;
            }
        }
        plain_path(value, path)
    })
}

/// F597 D2: the app import `imported` of `source` is an array literal of literal data (no identifier, no code) that
/// its module exports as a `const` and nothing writes: F564's literal-export proof (`plain_import_read`) for the whole
/// value, so a spread, a copy or a callback over it runs only built-in code.
pub fn literal_array_import(
    from: &str,
    source: &str,
    imported: &str,
    opts: &crate::analyze::component::AnalyzeOptions,
) -> bool {
    if imported == "*" || !app_specifier(source) {
        return false;
    }
    let Some(start) = crate::analyze::modules::resolve_module(from, source, opts) else {
        return false;
    };
    let declared = |ast: &js_ast::Ast<'_>, n: &str| export_literal(ast, n).is_some();
    let Some((module, export)) =
        crate::analyze::hooks::follow_export(opts, start, imported.to_string(), &declared)
    else {
        return false;
    };
    if opts
        .load_writes
        .as_deref()
        .is_some_and(|lw| lw.why(&module, &export).is_some())
    {
        return false;
    }
    let Ok(bytes) = std::fs::read(opts.root.join(&module)) else {
        return false;
    };
    let Ok(parsed) = crate::parse::parse_cached(&module, bytes) else {
        return false;
    };
    parsed.with_ast(|ast| {
        let Some((value, Some(r))) = export_literal(ast, &export) else {
            return false;
        };
        let dummy = js_ast::G::Fn::default();
        let names = NameTable::new(ast, &dummy);
        if crate::analyze::use_scan::unsafe_to_fold(ast, &names).contains(&r.inner_index()) {
            return false;
        }
        matches!(value.data, E::EArray(_)) && literal_data(value, 0)
    })
}

/// Literal data only: primitives, templates without parts, arrays and objects of those (plain non-computed properties,
/// no conversion hook, no `__proto__`).
fn literal_data(e: &js_ast::Expr, depth: u8) -> bool {
    if depth > 16 {
        return false;
    }
    match &e.data {
        E::EString(_) | E::ENumber(_) | E::EBoolean(_) | E::ENull(_) | E::EUndefined(_) | E::EBigInt(_) => true,
        E::ETemplate(t) => t.tag.is_none() && t.parts().is_empty(),
        E::EUnary(u) if matches!(u.op, js_ast::OpCode::UnNeg) => matches!(u.value.data, E::ENumber(_)),
        E::EArray(a) => a.items.iter().all(|x| literal_data(x, depth + 1)),
        E::EObject(o) => o.properties.iter().all(|p| {
            matches!(p.kind, js_ast::G::PropertyKind::Normal)
                && !p.flags.contains(js_ast::flags::Property::IsComputed)
                && matches!(p.key.as_ref().map(|k| &k.data), Some(E::EString(k))
                    if { let k = crate::analyze::expr::estring(k); !CONVERSION_HOOKS.contains(&k.as_str()) && k != "__proto__" })
                && p.value.as_ref().is_some_and(|v| literal_data(v, depth + 1))
        }),
        _ => false,
    }
}

/// The object or array literal the export `export` of `ast` declares, and its binding (`None` for `export default {…}`,
/// which no code of its module can name).
fn export_literal<'x>(
    ast: &'x js_ast::Ast<'_>,
    export: &str,
) -> Option<(&'x js_ast::Expr, Option<js_ast::Ref>)> {
    let literal = |v: &js_ast::Expr| matches!(v.data, E::EObject(_) | E::EArray(_));
    let sym = |r: js_ast::Ref| {
        ast.symbols
            .as_slice()
            .get(r.inner_index() as usize)
            .map(|s| String::from_utf8_lossy(s.original_name.slice()).into_owned())
    };
    let local = if export == "default" {
        let mut out = None;
        for part in ast.parts.iter() {
            for stmt in part.stmts.slice() {
                if let S::SExportDefault(ed) = &stmt.data
                    && let js_ast::StmtOrExpr::Expr(v) = &ed.value
                {
                    match &v.data {
                        _ if literal(v) => return Some((v, None)),
                        E::EIdentifier(id) => out = sym(id.ref_),
                        _ => return None,
                    }
                }
            }
        }
        out.or_else(|| crate::analyze::const_fold::exported_const_name(ast, export))?
    } else {
        crate::analyze::const_fold::exported_const_name(ast, export)?
    };
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            if let S::SLocal(l) = &stmt.data
                && matches!(l.kind, js_ast::S::Kind::KConst)
            {
                for d in l.decls.iter() {
                    if let (js_ast::b::B::BIdentifier(id), Some(v)) = (d.binding.data, &d.value)
                        && sym(id.r#ref).as_deref() == Some(local.as_str())
                    {
                        return literal(v).then_some((v, Some(id.r#ref)));
                    }
                }
            }
        }
    }
    None
}

/// Every step of `path` into the literal `e` is a data property (F564 D1).
fn plain_path(e: &js_ast::Expr, path: &[ReadSeg]) -> bool {
    let Some((first, rest)) = path.split_first() else {
        return true;
    };
    match (&e.data, first) {
        (E::EObject(o), ReadSeg::Key(k)) => {
            if k == "__proto__" {
                return false;
            }
            let mut found = None;
            for p in o.properties.iter() {
                if !matches!(p.kind, js_ast::G::PropertyKind::Normal)
                    || p.flags.contains(js_ast::flags::Property::IsComputed)
                {
                    return false;
                }
                let Some(E::EString(key)) = p.key.as_ref().map(|k| &k.data) else {
                    return false;
                };
                let key = crate::analyze::expr::estring(key);
                if key == "__proto__" {
                    return false;
                }
                if key == *k {
                    // the last one wins, as in JS
                    found = p.value.as_ref();
                }
            }
            found.is_some_and(|v| plain_path(v, rest))
        }
        (E::EArray(a), ReadSeg::Index(i)) => {
            if a.items
                .iter()
                .any(|x| matches!(x.data, E::ESpread(_) | E::EMissing(_)))
            {
                return false;
            }
            a.items.get(*i).is_some_and(|v| plain_path(v, rest))
        }
        _ => false,
    }
}

/// F564 D3: a short spelling of an expression for a diagnostic (`ICON.overview`, `aopApi`).
fn spell(e: &js_ast::Expr, names: &NameTable<'_>) -> String {
    match &e.data {
        E::EIdentifier(id) => names.name(id.ref_),
        E::EImportIdentifier(id) => names.name(id.ref_),
        E::EDot(d) => format!(
            "{}.{}",
            spell(&d.target, names),
            String::from_utf8_lossy(d.name.slice())
        ),
        E::EIndex(i) => format!("{}[…]", spell(&i.target, names)),
        E::ECall(c) => format!("{}(…)", spell(&c.target, names)),
        E::EThis(_) => "this".into(),
        _ => "…".into(),
    }
}

/// F564 D3: the 1-based line of byte offset `at` in `text`.
fn line_of(text: &[u8], at: u32) -> usize {
    text[..(at as usize).min(text.len())]
        .iter()
        .filter(|b| **b == b'\n')
        .count()
        + 1
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
