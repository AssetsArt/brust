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
/// `import_read(source, imported, path)`: reading `path` from the app import `imported` of `source` reads only data
/// properties of a literal (F564 D1, `plain_import_read`).
pub fn module_effect(
    ast: &js_ast::Ast<'_>,
    names: &NameTable<'_>,
    text: &[u8],
    accepted: &dyn Fn(&str) -> bool,
    import_read: &dyn Fn(&str, &str, &[ReadSeg]) -> bool,
) -> Option<(u32, String)> {
    let key = |r: js_ast::Ref| names.key_of(r);
    // Every module binding, and the code of each function the module declares (a declaration or a function value).
    let mut module: HashSet<u32> = HashSet::new();
    let mut walks: Vec<(u32, Walk)> = Vec::new();
    // F564 D2 (lead ruling 17fbc5e3, addition 2): the return values of each module function whose body the rule can
    // read (`None`: a loop, a `try`, a `switch` or a label in it).
    let mut returns: std::collections::HashMap<u32, Option<Vec<js_ast::Expr>>> =
        std::collections::HashMap::new();
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            match &stmt.data {
                S::SFunction(f) => {
                    if let Some(n) = &f.func.name {
                        module.insert(key(n.ref_));
                        let mut w = Walk::default();
                        w.stmt(stmt);
                        walks.push((key(n.ref_), w));
                        returns.insert(key(n.ref_), returns_of(f.func.body.stmts.slice()));
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
                            let body = match &v.data {
                                E::EArrow(a) => returns_of(a.body.stmts.slice()),
                                E::EFunction(f) => returns_of(f.func.body.stmts.slice()),
                                _ => None,
                            };
                            returns.insert(key(id.r#ref), body);
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
    // F564 D2: a binding taken from package code (`const useXContext = createXContext(…)[0]`) is package code: what
    // calling it returns is the package's object, as for an import.
    // … and a `const` holding a primitive literal (`const NAME = 'Slider'`) is no object anything could change.
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
                                | E::EBigInt(_)
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
    let own_module = |r: js_ast::Ref| {
        let k = key(r);
        module.contains(&k) && !foreign.contains(&k) && !primitive_consts.contains(&k)
    };
    // F564 D2 (lead ruling 17fbc5e3): the receiver rule of a function's code. A local the code declares or assigns from
    // a value that reads this module's binding (`const l = LIST`, `l = getList()`), through aliases, counts as one
    // (addition 1); a module function whose every return is rooted only at imports, globals or fresh values is followed
    // one level (addition 2).
    let followable = |r: js_ast::Ref| -> bool {
        returns
            .get(&key(r))
            .and_then(|b| b.as_ref())
            .is_some_and(|rets| {
                rets.iter()
                    .all(|e| !receiver_writes(e, &own_module, &|_| false))
            })
    };
    let tainted_of = |w: &Walk| -> HashSet<u32> {
        // Locals rooted at this module (addition 1): a `const` declared, or a local assigned, from a value the receiver
        // rule roots at this module or a literal that holds one (`const l = LIST`, `const l = getList()`, `l = a ?? LIST`,
        // `const o = { l: LIST }`). A value stored INTO a local's member (`s.src = URL`, `r[i] ^= gfMul(…)`) does not make
        // the local the module's object.
        let mut tainted: HashSet<u32> = HashSet::new();
        loop {
            let before = tainted.len();
            let own_so_far = |r: js_ast::Ref| own_module(r) || tainted.contains(&key(r));
            let mut add: Vec<u32> = Vec::new();
            for (b, v) in w.const_values.iter().chain(w.reassigned.iter()) {
                if !tainted.contains(&key(*b))
                    && !module.contains(&key(*b))
                    && (receiver_writes(v, &own_so_far, &followable)
                        || holds_own(v, &own_so_far, 0))
                {
                    add.push(key(*b));
                }
            }
            tainted.extend(add);
            if tainted.len() == before {
                break;
            }
        }
        tainted
    };
    let mutating_write = |w: &Walk| -> Option<js_ast::Expr> {
        let tainted = tainted_of(w);
        let own = |r: js_ast::Ref| own_module(r) || tainted.contains(&key(r));
        w.calls.iter().find_map(|c| {
            let E::ECall(call) = &c.data else {
                return None;
            };
            match &call.target.data {
                E::EDot(d)
                    if MUTATING.contains(&String::from_utf8_lossy(d.name.slice()).as_ref())
                        && receiver_writes(&d.target, &own, &followable) =>
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
        // a write through a local holding this module's object counts (addition 1); assigning the local itself does not
        let tainted = tainted_of(w);
        let through = w
            .member_written
            .iter()
            .chain(w.member_writes.iter().map(|(r, _)| r));
        w.opaque_write
            || w.assigned.iter().any(|r| module.contains(&key(*r)))
            || through
                .into_iter()
                .any(|r| module.contains(&key(*r)) || tainted.contains(&key(*r)))
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
    let function_ok = |k: u32| !writers.contains(&k);
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
        let tainted = tainted_of(w);
        let named = w
            .assigned
            .iter()
            .find(|r| module.contains(&key(**r)))
            .or_else(|| {
                w.member_written
                    .iter()
                    .chain(w.member_writes.iter().map(|(r, _)| r))
                    .find(|r| module.contains(&key(**r)) || tainted.contains(&key(**r)))
            });
        if let Some(r) = named {
            return if module.contains(&key(*r)) {
                format!("writes the module binding `{}`", names.name(*r))
            } else {
                format!(
                    "writes through `{}`, a local that holds a module object",
                    names.name(*r)
                )
            };
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
                    if !matches!(l.kind, js_ast::S::Kind::KConst) {
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
                                None => writes(&w, &writers),
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
                            if !writes(&w, &writers) {
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

/// F564 D2 (as narrowed by the challenge on it): whether a mutating method called on `recv` may change a binding of this
/// module. The receiver is rooted through members, indexes, call targets and both arms of a conditional or a logical
/// operator; a literal (`[...X]` included), a copying method or `new` of a global constructor is a fresh value. It is a
/// write when any root is a binding of this module (its own code can hand out its objects: `getList().push(x)`,
/// `(c ? A : B).push(x)`) or cannot be named (`this`, an opaque expression). Roots that are imports, globals or locals of
/// the function are not this module's objects, unless an argument of a call on the chain hands one in.
fn receiver_writes(
    recv: &js_ast::Expr,
    module: &dyn Fn(js_ast::Ref) -> bool,
    follow: &dyn Fn(js_ast::Ref) -> bool,
) -> bool {
    fn walk(
        e: &js_ast::Expr,
        module: &dyn Fn(js_ast::Ref) -> bool,
        follow: &dyn Fn(js_ast::Ref) -> bool,
        depth: u8,
    ) -> bool {
        if depth > 16 {
            return true;
        }
        let go = |x: &js_ast::Expr| walk(x, module, follow, depth + 1);
        // An argument handed to a call on the chain: does it name a binding of this module?
        // An argument that may hand this module's object to the callee (which may return it): the object itself, a literal
        // holding it, or a function whose code reads one. A primitive computed from module values hands nothing.
        let hands = |a: &js_ast::Expr| match &a.data {
            E::EArrow(_) | E::EFunction(_) => {
                let mut w = Walk::default();
                w.expr(a);
                w.used.iter().any(|r| module(*r))
            }
            _ => {
                crate::analyze::expr::alias_roots(a).into_iter().any(module)
                    || holds_own(a, module, 0)
            }
        };
        // a literal or a copying method's result (`slice`, `map`, `concat`): a fresh object, whatever it was built from
        if crate::analyze::plain_fn::fresh(e) {
            return false;
        }
        match &e.data {
            E::EDot(d) => go(&d.target),
            E::EIndex(i) => go(&i.target),
            // a module function whose returns are proven not to be this module's objects (`follow`, one level)
            E::ECall(c) => {
                c.args.iter().any(hands)
                    || match &c.target.data {
                        E::EIdentifier(id) if module(id.ref_) && follow(id.ref_) => false,
                        _ => go(&c.target),
                    }
            }
            E::EIf(i) => go(&i.yes) || go(&i.no),
            E::EBinary(b)
                if matches!(
                    b.op,
                    js_ast::OpCode::BinLogicalOr
                        | js_ast::OpCode::BinLogicalAnd
                        | js_ast::OpCode::BinNullishCoalescing
                ) =>
            {
                go(&b.left) || go(&b.right)
            }
            // `new` of a global or an imported class is a fresh object, unless it is handed this module's object
            E::ENew(n) => {
                // `new Map()`, `new window.Image()`, `new Poller(…)`: the constructor's root is a global or an import
                chain_root(&n.target).is_none_or(&module) || n.args.iter().any(hands)
            }
            E::EIdentifier(id) => module(id.ref_),
            E::EImportIdentifier(_) => false,
            // a primitive or a fresh closure is no module object (`const n = 'none'`, `() => …`)
            E::EString(_)
            | E::ENumber(_)
            | E::EBigInt(_)
            | E::EBoolean(_)
            | E::ENull(_)
            | E::EUndefined(_)
            | E::EArrow(_)
            | E::EFunction(_) => false,
            E::ETemplate(t) => t.tag.is_some(),
            E::EUnary(u) => !matches!(
                u.op,
                js_ast::OpCode::UnNot
                    | js_ast::OpCode::UnNeg
                    | js_ast::OpCode::UnPos
                    | js_ast::OpCode::UnTypeof
                    | js_ast::OpCode::UnVoid
                    | js_ast::OpCode::UnCpl
            ),
            E::EBinary(b) => !matches!(
                b.op,
                js_ast::OpCode::BinAdd
                    | js_ast::OpCode::BinSub
                    | js_ast::OpCode::BinMul
                    | js_ast::OpCode::BinDiv
                    | js_ast::OpCode::BinRem
                    | js_ast::OpCode::BinLt
                    | js_ast::OpCode::BinLe
                    | js_ast::OpCode::BinGt
                    | js_ast::OpCode::BinGe
                    | js_ast::OpCode::BinStrictEq
                    | js_ast::OpCode::BinStrictNe
                    | js_ast::OpCode::BinLooseEq
                    | js_ast::OpCode::BinLooseNe
            ),
            _ => true,
        }
    }
    walk(recv, module, follow, 0)
}

/// F564 D2 addition 1: an object or array literal that holds an object of this module (`{ l: LIST }`, `[A, B]`): a
/// receiver reached through it (`o.l.push(x)`) is that object.
fn holds_own(e: &js_ast::Expr, own: &dyn Fn(js_ast::Ref) -> bool, depth: u8) -> bool {
    if depth > 16 {
        return true;
    }
    let held = |x: &js_ast::Expr| {
        crate::analyze::expr::alias_roots(x).into_iter().any(own) || holds_own(x, own, depth + 1)
    };
    match &e.data {
        E::EObject(o) => o
            .properties
            .iter()
            .any(|p| p.value.as_ref().is_some_and(held)),
        E::EArray(a) => a.items.iter().any(|x| match &x.data {
            E::ESpread(sp) => held(&sp.value),
            _ => held(x),
        }),
        _ => false,
    }
}

/// F564 D2 addition 2: the values a function body returns (every `return` in it, through blocks, branches, loops,
/// `try` and `switch`, not in a nested function); `None` for a statement the rule does not read (`with`, a class).
fn returns_of(stmts: &[js_ast::Stmt]) -> Option<Vec<js_ast::Expr>> {
    fn go(s: &js_ast::Stmt, out: &mut Vec<js_ast::Expr>) -> bool {
        match &s.data {
            S::SReturn(r) => {
                out.extend(r.value);
                true
            }
            S::SBlock(b) => b.stmts.slice().iter().all(|x| go(x, out)),
            S::SIf(i) => go(&i.yes, out) && i.no.as_ref().is_none_or(|n| go(n, out)),
            S::SFor(f) => go(&f.body, out),
            S::SForIn(f) => go(&f.body, out),
            S::SForOf(f) => go(&f.body, out),
            S::SWhile(w) => go(&w.body, out),
            S::SDoWhile(w) => go(&w.body, out),
            S::SLabel(l) => go(&l.stmt, out),
            S::STry(t) => {
                t.body.slice().iter().all(|x| go(x, out))
                    && t.catch
                        .as_ref()
                        .is_none_or(|c| c.body.slice().iter().all(|x| go(x, out)))
                    && t.finally
                        .as_ref()
                        .is_none_or(|f| f.stmts.slice().iter().all(|x| go(x, out)))
            }
            S::SSwitch(sw) => sw
                .cases
                .slice()
                .iter()
                .all(|c| c.body.slice().iter().all(|x| go(x, out))),
            S::SBreak(_) | S::SContinue(_) => true,
            S::SLocal(_)
            | S::SExpr(_)
            | S::SThrow(_)
            | S::SEmpty(_)
            | S::SComment(_)
            | S::SDirective(_)
            | S::SFunction(_)
            | S::STypeScript(_) => true,
            _ => false,
        }
    }
    let mut out = Vec::new();
    stmts.iter().all(|s| go(s, &mut out)).then_some(out)
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
}

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
        match &e.data {
            E::EString(_) | E::ENumber(_) | E::EBoolean(_) | E::ENull(_) | E::EUndefined(_) => None,
            E::EImportIdentifier(_) => None,
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
                let allowed = c.was_jsx_element
                    || package_rooted(&c.target)
                    || read_only_global(&c.target, names);
                if !allowed {
                    return Some(format!("it calls `{}(…)`", spell(&c.target)));
                }
                if !c.was_jsx_element
                    && let Some(w) = go(&c.target)
                {
                    return Some(w);
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
