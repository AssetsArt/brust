//! F230 (closes F219, ruled option C): one scan per build over every app module the server bundle loads. It finds the
//! exports of an app module that ANOTHER app module writes: a member write or a mutating call through an import
//! (`LABELS.a = 'patched'`, `list.push('y')`, through an alias `const l = list; l.push(…)`), or the import handed to app
//! code or to a global that writes its argument (`register(LABELS)`, `Object.assign(LABELS, …)`; F480: a function
//! handed to app code is not, `probe(addrsOf)`, but a write into it as an object is). A value the
//! compiler reads from such an export (a folded constant, a job or chunk import) would be the module as declared, not
//! as the app sees it after the writer ran, so a component that reads one falls back (`module-written`) and renders
//! with React, which runs every module of the app.
//!
//! The scan is deliberately coarse: a write anywhere in a module counts (also inside a function nothing calls at load,
//! or a handler that runs later, which a folded constant would miss as well), and an export whose own code reads a
//! written export is written too (`export const label = LABELS.a`, `export function getLabel()`), transitively. Package
//! code is not scanned (trusted, ledger N1); a write by a package is not seen.
use crate::analyze::component::AnalyzeOptions;
use crate::analyze::expr::{Walk, chain_root};
use crate::analyze::module_effects::app_specifier;
use crate::analyze::modules::resolve;
use crate::analyze::names::NameTable;
use bun_ast as js_ast;
use js_ast::expr::Data as E;
use js_ast::stmt::Data as S;
use std::collections::{BTreeSet, HashMap, HashSet};

/// Methods that change their receiver (as `module_effects`).
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

/// Globals that write an argument (`Object.assign(target, …)`).
const WRITING_GLOBALS: &[(&str, &str)] = &[
    ("Object", "assign"),
    ("Object", "defineProperty"),
    ("Object", "defineProperties"),
    ("Object", "setPrototypeOf"),
    ("Reflect", "set"),
    ("Reflect", "defineProperty"),
    ("Reflect", "deleteProperty"),
    ("Reflect", "setPrototypeOf"),
];

/// An export of an app module: (path relative to the root, export name). `*` stands for every export (a write through
/// a namespace import).
pub type ExportKey = (String, String);

/// The exports some other app module writes, and why (the first writer found), for the fallback message.
#[derive(Debug, Default, Clone)]
pub struct LoadWrites {
    pub written: HashMap<ExportKey, String>,
    /// The modules that write when they load, each with the modules it writes into (sorted): the build imports a writer
    /// first where a React island renders (the SSR jobs bundle; the browser chunk of an island whose import graph
    /// reaches a module it writes), so the island sees what React's app sees.
    pub writers: Vec<(String, Vec<String>)>,
}

impl LoadWrites {
    /// Why `(module, export)` is written, when it is: the export itself, or every export of the module.
    pub fn why(&self, module: &str, export: &str) -> Option<&str> {
        self.written
            .get(&(module.to_string(), export.to_string()))
            .or_else(|| self.written.get(&(module.to_string(), "*".to_string())))
            .map(String::as_str)
    }

    pub fn is_empty(&self) -> bool {
        self.written.is_empty()
    }

    /// The build hands the scan to every compile as JSON: `{ "written": [[module, export, why], …], "writers":
    /// [module, …] }`, sorted.
    pub fn to_json(&self) -> String {
        let mut rows: Vec<(&String, &String, &String)> =
            self.written.iter().map(|((m, e), w)| (m, e, w)).collect();
        rows.sort();
        serde_json::json!({ "written": rows, "writers": self.writers }).to_string()
    }

    pub fn from_json(text: &str) -> serde_json::Result<Self> {
        #[derive(serde::Deserialize)]
        struct J {
            written: Vec<(String, String, String)>,
            #[serde(default)]
            writers: Vec<(String, Vec<String>)>,
        }
        let j: J = serde_json::from_str(text)?;
        Ok(LoadWrites {
            written: j.written.into_iter().map(|(m, e, w)| ((m, e), w)).collect(),
            writers: j.writers,
        })
    }
}

/// One scanned module.
struct Scanned {
    path: String,
    /// Imports of app modules this module names: binding key → (module path, imported name).
    imports: HashMap<u32, ExportKey>,
    /// The writes this module makes through an app import: (module path, export).
    writes: Writes,
    /// The writes a statement makes where it stands when the module loads (not in a nested function).
    load: Writes,
    /// Exports declared as a primitive (`export const MAX = 6`): nothing can write into one.
    primitive: HashSet<String>,
    /// F480: exports declared as a function (`export function f`, `export const f = () => …`, never reassigned): handing
    /// one to app code passes code to call, not an object to change; a write into it as an object still counts.
    function: HashSet<String>,
    /// Exports made by a package call (`export const team = defineStore(…)`): the package owns the object and its
    /// methods change it (`team.members.set(…)`), which is what it is for; such a method call is not counted (an
    /// assignment into it is).
    package_made: HashSet<String>,
    /// Top-level bindings: key → the import keys and local keys its code reads.
    decls: HashMap<u32, (Vec<ExportKey>, Vec<u32>)>,
    /// Exports: name → local binding key (`None`: an expression default export, read through `default_reads`).
    exports: Vec<(String, Option<u32>)>,
    default_reads: Option<(Vec<ExportKey>, Vec<u32>)>,
    /// `export { x } from './m'` (alias, module, name) and `export * from './m'`.
    follows: Vec<(String, String, String)>,
    stars: Vec<String>,
}

/// Scans `paths` (app modules, relative to `opts.root`). Runs on the compiler thread. A module that does not read or
/// parse is skipped.
pub fn scan(paths: &[String], opts: &AnalyzeOptions) -> LoadWrites {
    let _aliases = crate::analyze::aliases::Scope::enter(&opts.root, &opts.path_aliases);
    let mut scanned = Vec::new();
    for path in paths {
        let Ok(source) = std::fs::read(opts.root.join(path)) else {
            continue;
        };
        let Ok(parsed) = crate::parse::parse_tsx(path, source) else {
            continue;
        };
        scanned.push(parsed.with_ast(|ast| scan_module(path, ast, opts)));
    }
    propagate(&scanned)
}

fn scan_module(path: &str, ast: &js_ast::Ast<'_>, opts: &AnalyzeOptions) -> Scanned {
    let names = NameTable::for_hook(ast);
    let key = |r: js_ast::Ref| names.key_of(r);
    let records = ast.import_records.as_slice();
    let spec_of = |i: u32| {
        records
            .get(i as usize)
            .map(|r| String::from_utf8_lossy(r.path.text).into_owned())
    };
    let target = |spec: &str| {
        if app_specifier(spec) {
            resolve(path, spec, opts)
        } else {
            None
        }
    };
    let mut imports: HashMap<u32, ExportKey> = HashMap::new();
    let mut all = Walk::default();
    let mut decls = HashMap::new();
    let mut exports = Vec::new();
    let mut default_reads = None;
    let mut follows = Vec::new();
    let mut stars = Vec::new();
    let mut module_keys: HashSet<u32> = HashSet::new();
    let mut package_made_keys: HashSet<u32> = HashSet::new();
    let mut primitive_keys: HashSet<u32> = HashSet::new();
    let mut function_keys: HashSet<u32> = HashSet::new();
    // F274: the code a call of a top-level function runs (its body, shallow: a function nested in it does not run),
    // by the function's binding key: a declaration, or a `const f = () => …` / `function` expression.
    let mut fn_bodies: HashMap<u32, Walk> = HashMap::new();
    let shallow_body = |stmts: &[js_ast::Stmt]| {
        let mut w = Walk {
            shallow: true,
            ..Default::default()
        };
        w.stmts(stmts);
        w
    };
    let package_import = |r: js_ast::Ref| {
        names
            .import_of(r)
            .is_some_and(|(src, _)| !app_specifier(src))
    };
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            all.stmt(stmt);
            match &stmt.data {
                S::SImport(imp) => {
                    let Some(t) = spec_of(imp.import_record_index).and_then(|s| target(&s)) else {
                        continue;
                    };
                    if let Some(d) = &imp.default_name {
                        imports.insert(key(d.ref_), (t.clone(), "default".into()));
                    }
                    for item in imp.items.slice() {
                        let imported = String::from_utf8_lossy(item.alias.slice()).into_owned();
                        imports.insert(key(item.name.ref_), (t.clone(), imported));
                    }
                    if imp.star_name_loc.start >= 0 {
                        imports.insert(key(imp.namespace_ref), (t, "*".into()));
                    }
                }
                S::SFunction(f) => {
                    if let Some(n) = &f.func.name {
                        let mut w = Walk::default();
                        w.stmt(stmt);
                        module_keys.insert(key(n.ref_));
                        function_keys.insert(key(n.ref_));
                        decls.insert(key(n.ref_), w);
                        fn_bodies.insert(key(n.ref_), shallow_body(f.func.body.stmts.slice()));
                        if f.func.flags.contains(js_ast::flags::Function::IsExport) {
                            exports.push((names.name(n.ref_), Some(key(n.ref_))));
                        }
                    }
                }
                S::SClass(c) => {
                    if let Some(n) = &c.class.class_name {
                        let mut w = Walk::default();
                        w.stmt(stmt);
                        module_keys.insert(key(n.ref_));
                        decls.insert(key(n.ref_), w);
                        if c.is_export {
                            exports.push((names.name(n.ref_), Some(key(n.ref_))));
                        }
                    }
                }
                S::SLocal(l) => {
                    for d in l.decls.iter() {
                        let mut bound = Walk::default();
                        bound.declare_binding(&d.binding);
                        let mut w = Walk::default();
                        if let Some(v) = &d.value {
                            w.expr(v);
                        }
                        // A destructuring default reads too.
                        w.declare_binding(&d.binding);
                        if let (js_ast::b::B::BIdentifier(id), Some(v)) = (d.binding.data, &d.value)
                        {
                            match &v.data {
                                E::ECall(c)
                                    if chain_root(&c.target).is_some_and(package_import) =>
                                {
                                    package_made_keys.insert(key(id.r#ref));
                                }
                                E::EString(_)
                                | E::ENumber(_)
                                | E::EBoolean(_)
                                | E::ENull(_)
                                | E::EUndefined(_)
                                | E::EBigInt(_)
                                    if matches!(l.kind, js_ast::S::Kind::KConst) =>
                                {
                                    primitive_keys.insert(key(id.r#ref));
                                }
                                _ => {}
                            }
                        }
                        if let (js_ast::b::B::BIdentifier(id), Some(v)) = (d.binding.data, &d.value)
                        {
                            if matches!(l.kind, js_ast::S::Kind::KConst)
                                && matches!(v.data, E::EArrow(_) | E::EFunction(_))
                            {
                                function_keys.insert(key(id.r#ref));
                            }
                            match &v.data {
                                E::EArrow(a) => {
                                    fn_bodies
                                        .insert(key(id.r#ref), shallow_body(a.body.stmts.slice()));
                                }
                                E::EFunction(f) => {
                                    fn_bodies.insert(
                                        key(id.r#ref),
                                        shallow_body(f.func.body.stmts.slice()),
                                    );
                                }
                                _ => {}
                            }
                        }
                        let reads = w;
                        for r in &bound.declared {
                            module_keys.insert(key(*r));
                            if l.is_export {
                                exports.push((names.name(*r), Some(key(*r))));
                            }
                        }
                        // Every binding of the declaration reads what the initializer reads.
                        for r in &bound.declared {
                            decls.insert(key(*r), clone_reads(&reads));
                        }
                    }
                }
                S::SExportClause(c) => {
                    for item in c.items.slice() {
                        exports.push((
                            String::from_utf8_lossy(item.alias.slice()).into_owned(),
                            Some(key(item.name.ref_)),
                        ));
                    }
                }
                S::SExportDefault(d) => {
                    let mut w = Walk::default();
                    w.stmt(stmt);
                    let named = match &d.value {
                        js_ast::StmtOrExpr::Stmt(s) => match &s.data {
                            S::SFunction(f) => f.func.name.as_ref().map(|n| {
                                function_keys.insert(key(n.ref_));
                                key(n.ref_)
                            }),
                            S::SClass(c) => c.class.class_name.as_ref().map(|n| key(n.ref_)),
                            _ => None,
                        },
                        js_ast::StmtOrExpr::Expr(e) => match &e.data {
                            E::EIdentifier(id) => Some(key(id.ref_)),
                            _ => None,
                        },
                    };
                    match named {
                        Some(k) => {
                            decls.entry(k).or_insert(w);
                            module_keys.insert(k);
                            exports.push(("default".into(), Some(k)));
                        }
                        None => {
                            default_reads = Some(w);
                            exports.push(("default".into(), None));
                        }
                    }
                }
                S::SExportFrom(f) => {
                    if let Some(t) = spec_of(f.import_record_index).and_then(|s| target(&s)) {
                        for item in f.items.slice() {
                            follows.push((
                                String::from_utf8_lossy(item.alias.slice()).into_owned(),
                                t.clone(),
                                String::from_utf8_lossy(item.original_name.slice()).into_owned(),
                            ));
                        }
                    }
                }
                S::SExportStar(st) => {
                    if let Some(t) = spec_of(st.import_record_index).and_then(|s| target(&s)) {
                        match &st.alias {
                            // `export * as X from './m'`: X is every export of m.
                            Some(a) => follows.push((
                                String::from_utf8_lossy(a.original_name.slice()).into_owned(),
                                t,
                                "*".into(),
                            )),
                            None => stars.push(t),
                        }
                    }
                }
                _ => {}
            }
        }
    }

    // Writes through an app import, anywhere in the module; and the same made by a statement that runs at load (not
    // in a function nothing calls then): the build imports those writer modules where it renders islands.
    let writes = writes_of(&all, &imports, &module_keys, &names);
    let mut load = Walk {
        shallow: true,
        ..Default::default()
    };
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            if runs_code_at_load(stmt) {
                load.stmt(stmt);
            }
        }
    }
    let mut load_writes = writes_of(&load, &imports, &module_keys, &names);
    // F274: a statement that calls a function of this module at load (`function init() { B.x = 1 }; init()`) runs its
    // body then, and so does every function that body calls: follow top-level calls to a fixpoint.
    let mut pending: Vec<u32> = Vec::new();
    let callee_keys = |w: &Walk, out: &mut Vec<u32>| {
        for c in &w.calls {
            if let E::ECall(call) = &c.data
                && let E::EIdentifier(id) = &comma_target(&call.target).data
            {
                out.push(key(id.ref_));
            }
        }
    };
    callee_keys(&load, &mut pending);
    let mut seen: HashSet<u32> = HashSet::new();
    while let Some(k) = pending.pop() {
        if !seen.insert(k) {
            continue;
        }
        let Some(body) = fn_bodies.get(&k) else {
            continue;
        };
        let w = writes_of(body, &imports, &module_keys, &names);
        load_writes.method.extend(w.method);
        load_writes.other.extend(w.other);
        load_writes.handed.extend(w.handed);
        load_writes.global.extend(w.global);
        callee_keys(body, &mut pending);
    }
    let load = load_writes;

    let reads_of = |w: &Walk| {
        let mut imp = Vec::new();
        let mut local = Vec::new();
        for r in &w.used {
            let k = key(*r);
            if let Some(i) = imports.get(&k) {
                imp.push(i.clone());
            } else if module_keys.contains(&k) {
                local.push(k);
            }
        }
        (imp, local)
    };
    let package_made = exports
        .iter()
        .filter(|(_, k)| k.is_some_and(|k| package_made_keys.contains(&k)))
        .map(|(n, _)| n.clone())
        .collect();
    let primitive = exports
        .iter()
        .filter(|(_, k)| k.is_some_and(|k| primitive_keys.contains(&k)))
        .map(|(n, _)| n.clone())
        .collect();
    // A function binding assigned anywhere in the module (`f = other`) is a value like any other.
    let reassigned: HashSet<u32> = all.assigned.iter().map(|r| key(*r)).collect();
    let function = exports
        .iter()
        .filter(|(_, k)| k.is_some_and(|k| function_keys.contains(&k) && !reassigned.contains(&k)))
        .map(|(n, _)| n.clone())
        .collect();
    Scanned {
        path: path.to_string(),
        writes,
        load,
        package_made,
        primitive,
        function,
        decls: decls.iter().map(|(k, w)| (*k, reads_of(w))).collect(),
        default_reads: default_reads.as_ref().map(reads_of),
        imports,
        exports,
        follows,
        stars,
    }
}

/// The exports `w`'s code writes through an import of `imports`: a member write or a mutating call rooted at the
/// import (through an alias the walk recorded), the import itself handed to app code (a local function, an app import,
/// unknown code; `propagate` drops a function export, F480), or any chain of it handed to a global that writes its
/// argument (`Object.assign(LABELS.a, …)`). A member of an import handed to app code is not counted (`fmt(LABELS.a)` is
/// the usual read).
fn writes_of(
    w: &Walk,
    imports: &HashMap<u32, ExportKey>,
    module_keys: &HashSet<u32>,
    names: &NameTable<'_>,
) -> Writes {
    let key = |r: js_ast::Ref| names.key_of(r);
    let mut written_refs: Vec<js_ast::Ref> = Vec::new();
    let mut method_refs: Vec<js_ast::Ref> = Vec::new();
    // Handed on as is (an alias is not followed: `apply(r)` after `const r = await api.post()` hands a call's result),
    // with the callee's import when it is one (a method of a package-made value is package code).
    let mut handed_refs: Vec<(js_ast::Ref, Option<js_ast::Ref>)> = Vec::new();
    // Handed to a global that writes its argument: a write whatever the import is (a function too).
    let mut global_refs: Vec<js_ast::Ref> = Vec::new();
    written_refs.extend(w.member_written.iter().copied());
    written_refs.extend(w.member_writes.iter().map(|(r, _)| *r));
    for c in &w.calls {
        let E::ECall(call) = &c.data else { continue };
        // `x.push(…)`: the receiver's root (`a.b.push` writes into `a`).
        if let E::EDot(d) = &call.target.data
            && MUTATING.contains(&String::from_utf8_lossy(d.name.slice()).as_ref())
            && let Some(r) = chain_root(&d.target)
        {
            method_refs.push(r);
        }
        if writing_global(&call.target, names) {
            if let Some(r) = call.args.first().and_then(chain_root) {
                global_refs.push(r);
            }
            continue;
        }
        let callee = chain_root(&call.target);
        let app_callee = match callee {
            Some(r) => module_keys.contains(&key(r)) || imports.contains_key(&key(r)),
            // `(cond ? f : g)(x)`, `get()(x)`: unknown code.
            None => true,
        };
        if app_callee {
            for a in call.args.iter() {
                let a = match &a.data {
                    E::ESpread(sp) => &sp.value,
                    _ => a,
                };
                match &a.data {
                    E::EIdentifier(id) => handed_refs.push((id.ref_, callee)),
                    E::EImportIdentifier(id) => handed_refs.push((id.ref_, callee)),
                    _ => {}
                }
            }
        }
    }
    // Writes through an alias: `const l = list; l.push(…)` (a fixpoint over the aliases the walk recorded; a computed
    // value such as a call's result is not one).
    let exports_of = |refs: &[js_ast::Ref]| {
        let mut keys: HashSet<u32> = refs.iter().map(|r| key(*r)).collect();
        loop {
            let before = keys.len();
            for (b, read) in &w.aliases {
                if keys.contains(&key(*b)) {
                    keys.insert(key(*read));
                }
            }
            if keys.len() == before {
                break;
            }
        }
        imports
            .iter()
            .filter(|(k, _)| keys.contains(k))
            .map(|(_, v)| v.clone())
            .collect::<BTreeSet<ExportKey>>()
    };
    let handed = handed_refs
        .iter()
        .filter_map(|(r, callee)| {
            let arg = imports.get(&key(*r))?.clone();
            Some((arg, callee.and_then(|c| imports.get(&key(c)).cloned())))
        })
        .collect();
    let global = global_refs
        .iter()
        .filter_map(|r| imports.get(&key(*r)).cloned())
        .collect();
    Writes {
        other: exports_of(&written_refs),
        method: exports_of(&method_refs),
        handed,
        global,
    }
}

/// The exports a piece of code writes: through a mutating method call (`list.push(…)`, `team.members.set(…)`), and
/// otherwise (an assignment, a hand-off).
#[derive(Default)]
struct Writes {
    method: BTreeSet<ExportKey>,
    other: BTreeSet<ExportKey>,
    /// An import handed to code that may write it: (the import, the callee's import when it is one).
    handed: BTreeSet<(ExportKey, Option<ExportKey>)>,
    /// An import (a chain rooted at one) handed to a global that writes its argument (`Object.assign(f, …)`).
    global: BTreeSet<ExportKey>,
}

/// A top-level statement whose code runs when the module loads: not an import or export clause, a function or class
/// declaration, or a declaration whose every initializer is a function value.
fn runs_code_at_load(stmt: &js_ast::Stmt) -> bool {
    let function = |e: &js_ast::Expr| matches!(e.data, E::EArrow(_) | E::EFunction(_));
    match &stmt.data {
        S::SImport(_)
        | S::SExportFrom(_)
        | S::SExportStar(_)
        | S::SExportClause(_)
        | S::SFunction(_)
        | S::STypeScript(_) => false,
        S::SLocal(l) => !l
            .decls
            .iter()
            .all(|d| d.value.as_ref().is_none_or(function)),
        S::SExportDefault(d) => match &d.value {
            js_ast::StmtOrExpr::Stmt(s) => runs_code_at_load(s),
            js_ast::StmtOrExpr::Expr(e) => !function(e),
        },
        _ => true,
    }
}

/// The callee of `(0, f)(…)`, the comma call a bundler emits: the right side when the left is a literal.
fn comma_target(target: &js_ast::Expr) -> &js_ast::Expr {
    match &target.data {
        E::EBinary(b)
            if b.op == js_ast::OpCode::BinComma
                && matches!(
                    b.left.data,
                    E::ENumber(_) | E::EString(_) | E::EBoolean(_) | E::ENull(_) | E::EUndefined(_)
                ) =>
        {
            comma_target(&b.right)
        }
        _ => target,
    }
}

fn clone_reads(w: &Walk) -> Walk {
    Walk {
        used: w.used.clone(),
        ..Default::default()
    }
}

fn writing_global(target: &js_ast::Expr, names: &NameTable<'_>) -> bool {
    let E::EDot(d) = &target.data else {
        return false;
    };
    let E::EIdentifier(id) = &d.target.data else {
        return false;
    };
    let (obj, method) = (names.name(id.ref_), String::from_utf8_lossy(d.name.slice()));
    WRITING_GLOBALS
        .iter()
        .any(|(o, m)| *o == obj && *m == method)
}

/// The written exports: each module's writes, then every export whose code reads a written export (its own module's
/// tainted locals included), and re-exports of a written one, to a fixpoint.
fn propagate(mods: &[Scanned]) -> LoadWrites {
    let mut out = LoadWrites::default();
    let package_made = |k: &ExportKey| {
        mods.iter()
            .any(|m| m.path == k.0 && m.package_made.contains(&k.1))
    };
    let primitive = |k: &ExportKey| {
        mods.iter()
            .any(|m| m.path == k.0 && m.primitive.contains(&k.1))
    };
    let function = |k: &ExportKey| {
        mods.iter()
            .any(|m| m.path == k.0 && m.function.contains(&k.1))
    };
    // The writes that count: a method call into a package-made value, or a hand-off to its methods, is its API; a
    // function handed on is code to call (F480); a primitive cannot be written.
    let counted = |w: &Writes| -> BTreeSet<ExportKey> {
        let method = w.method.iter().filter(|k| !package_made(k));
        let handed = w
            .handed
            .iter()
            .filter(|(k, callee)| !callee.as_ref().is_some_and(package_made) && !function(k))
            .map(|(k, _)| k);
        w.other
            .iter()
            .chain(method)
            .chain(handed)
            .chain(&w.global)
            .filter(|k| !primitive(k))
            .cloned()
            .collect()
    };
    for m in mods {
        let modules: BTreeSet<String> = counted(&m.load).into_iter().map(|(p, _)| p).collect();
        if !modules.is_empty() {
            out.writers
                .push((m.path.clone(), modules.into_iter().collect()));
        }
    }
    out.writers.sort();
    out.writers.dedup();
    for m in mods {
        for w in &counted(&m.writes) {
            out.written
                .entry(w.clone())
                .or_insert_with(|| format!("{} writes it", m.path));
        }
    }
    let is_written = |out: &LoadWrites, k: &ExportKey| out.why(&k.0, &k.1).is_some();
    loop {
        let before = out.written.len();
        for m in mods {
            // Locals whose code reads a written export or a tainted local.
            let mut tainted: HashSet<u32> = HashSet::new();
            loop {
                let n = tainted.len();
                for (k, (imp, local)) in &m.decls {
                    if !tainted.contains(k)
                        && (imp.iter().any(|i| is_written(&out, i))
                            || local.iter().any(|l| tainted.contains(l)))
                    {
                        tainted.insert(*k);
                    }
                }
                if tainted.len() == n {
                    break;
                }
            }
            let mut add = Vec::new();
            for (name, local) in &m.exports {
                let hit = match local {
                    Some(k) => {
                        tainted.contains(k)
                            // `export { x }` of an import: a re-export of it.
                            || m.imports.get(k).is_some_and(|i| is_written(&out, i))
                    }
                    None => m.default_reads.as_ref().is_some_and(|(imp, local)| {
                        imp.iter().any(|i| is_written(&out, i))
                            || local.iter().any(|l| tainted.contains(l))
                    }),
                };
                if hit {
                    add.push(name.clone());
                }
            }
            for (alias, t, name) in &m.follows {
                let hit = if name == "*" {
                    out.written.keys().any(|(p, _)| p == t)
                } else {
                    is_written(&out, &(t.clone(), name.clone()))
                };
                if hit {
                    add.push(alias.clone());
                }
            }
            for t in &m.stars {
                let names: Vec<String> = out
                    .written
                    .keys()
                    .filter(|(p, n)| p == t && n != "default")
                    .map(|(_, n)| n.clone())
                    .collect();
                add.extend(names);
            }
            for name in add {
                let k = (m.path.clone(), name);
                out.written
                    .entry(k)
                    .or_insert_with(|| format!("{} reads a written export", m.path));
            }
        }
        if out.written.len() == before {
            break;
        }
    }
    out
}

/// The fallback (F230): a component whose compiled code would read a written export (a painted value, a client
/// read, or a module helper of its own that reads one) renders with React.
pub fn check(
    ir: &mut crate::ir::ComponentIR,
    st: &crate::analyze::passes::PassState,
    ctx: &crate::analyze::passes::PassCtx<'_>,
) {
    let Some(lw) = ctx.opts.load_writes.as_deref() else {
        return;
    };
    if lw.is_empty() || matches!(ir.tier, crate::ir::Tier::React { .. }) {
        return;
    }
    // The module helpers a read reaches, and the imports they read (transitively through the module scope).
    let scope: HashMap<&str, &Vec<(String, crate::ir::IdentKind)>> = ir
        .module_scope
        .iter()
        .map(|(n, c)| (n.as_str(), c))
        .collect();
    let reached_imports = |locals: &mut dyn Iterator<Item = &String>| {
        let mut out: Vec<(String, String)> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut stack: Vec<String> = locals.cloned().collect();
        while let Some(n) = stack.pop() {
            if !seen.insert(n.clone()) {
                continue;
            }
            for (c, k) in scope.get(n.as_str()).into_iter().flat_map(|v| v.iter()) {
                match k {
                    crate::ir::IdentKind::Import { source, imported } => {
                        out.push((source.clone(), imported.clone()))
                    }
                    crate::ir::IdentKind::Local => stack.push(c.clone()),
                    _ => {}
                }
            }
        }
        out
    };
    let mut reads: Vec<(u32, (String, String))> = Vec::new();
    for p in &st.painted {
        reads.extend(p.deps.imports.iter().map(|i| (p.loc, i.clone())));
        reads.extend(
            reached_imports(&mut p.deps.module_locals.iter())
                .into_iter()
                .map(|i| (p.loc, i)),
        );
    }
    let at = st.painted.first().map_or(0, |p| p.loc);
    reads.extend(ir.client_imports.iter().map(|i| (at, i.clone())));
    reads.extend(
        reached_imports(&mut ir.client_module_locals.iter())
            .into_iter()
            .map(|i| (at, i)),
    );
    // A resolved store handle is read live (its signals in the chunk, its snapshot as a job input, M3-F D7), never as
    // the module declared it: writing it through its API (`team.members.set(…)`) is what a store is for.
    let stores: HashSet<(&str, &str)> = ir
        .stores
        .iter()
        .filter(|u| u.resolved.is_some())
        .map(|u| (u.import.1.as_str(), u.import.2.as_str()))
        .collect();
    reads.retain(|(_, (s, i))| !stores.contains(&(s.as_str(), i.as_str())));
    for (loc, (source, imported)) in reads {
        let Some(module) = resolve(ctx.path, &source, ctx.opts) else {
            continue;
        };
        if let Some(why) = lw.why(&module, &imported) {
            ir.diagnostics.push(crate::ir::Diagnostic::fallback(
                "module-written",
                format!(
                    "`{imported}` of {module} is changed by another module of the app ({why}); brust would read it as declared, so the component renders with React"
                ),
                loc,
                "keep module values constant after they are declared (write them in the module that declares them, or pass the value as a prop), or keep this component in React",
            ));
            return;
        }
    }
}
