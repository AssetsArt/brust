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
use crate::analyze::mentions::{Pos, Seg};
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
    /// F591 rule (e): the scanned modules that run nothing at load beyond what the F215 allowlist accepts
    /// (`const_fold::load_clean`), sorted. A module not listed (unclean, or not scanned) keeps the native chunk that
    /// bundles it on every page its route can print it.
    pub load_clean: Vec<String>,
    /// F599 (D1'): the exports of app modules that have a mention outside the closed list of safe reads somewhere in the
    /// build (`analyze::mentions`): the load-time judge never reads such an export as plain data. `(module, "*")` stands
    /// for every export of the module (a namespace object handed on, a dynamic `import()` of it). Only the scan fills it:
    /// it is not part of the JSON the build hands to a compile.
    pub escaped: HashSet<ExportKey>,
    /// A module of the build could not be read or parsed, or a dynamic `import()` names no literal: nothing is data.
    pub escaped_all: bool,
    /// F615 (AMENDMENT 2): every written key resolved to the export(s) that DECLARE it (`declaring`, through
    /// `export { x } from`, `import { x }; export { x }` and `export *`; an ambiguous `export *` gives every candidate).
    /// A written `(m, "*")` also marks `*` of every module `m` re-exports from. A key nothing declares stays as itself.
    pub declared_written: HashSet<ExportKey>,
}

impl LoadWrites {
    /// Why `(module, export)` is written, when it is: the export itself, or every export of the module.
    pub fn why(&self, module: &str, export: &str) -> Option<&str> {
        self.written
            .get(&(module.to_string(), export.to_string()))
            .or_else(|| self.written.get(&(module.to_string(), "*".to_string())))
            .map(String::as_str)
    }

    /// F615 (AMENDMENT 2): some module writes the export `(module, export)` declares, under any name or through any
    /// re-export (or every export of the module).
    pub fn declaration_written(&self, module: &str, export: &str) -> bool {
        self.why(module, export).is_some()
            || self
                .declared_written
                .contains(&(module.to_string(), export.to_string()))
            || self
                .declared_written
                .contains(&(module.to_string(), "*".to_string()))
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
        let mut declared: Vec<&ExportKey> = self.declared_written.iter().collect();
        declared.sort();
        serde_json::json!({ "written": rows, "writers": self.writers, "load_clean": self.load_clean, "declared_written": declared }).to_string()
    }

    pub fn from_json(text: &str) -> serde_json::Result<Self> {
        #[derive(serde::Deserialize)]
        struct J {
            written: Vec<(String, String, String)>,
            #[serde(default)]
            writers: Vec<(String, Vec<String>)>,
            #[serde(default)]
            load_clean: Vec<String>,
            #[serde(default)]
            declared_written: Vec<ExportKey>,
        }
        let j: J = serde_json::from_str(text)?;
        Ok(LoadWrites {
            written: j.written.into_iter().map(|(m, e, w)| ((m, e), w)).collect(),
            writers: j.writers,
            load_clean: j.load_clean,
            escaped: HashSet::new(),
            escaped_all: false,
            declared_written: j.declared_written.into_iter().collect(),
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
    /// F599 (D1'): the mentions of exports by this module (own exported literals and imports), by export key.
    mentions: Vec<(ExportKey, Vec<Seg>, Pos)>,
    /// Modules whose every export escapes here: a namespace object used other than as `ns.name`.
    ns_escapes: Vec<String>,
    /// Modules named by a dynamic `import()` (`None`: a specifier that is not a string literal).
    dynamic: Vec<Option<String>>,
    /// F610 D4: the top-level functions a call can be followed into (`function f`, `const f = function / arrow`), never
    /// reassigned: their binding keys.
    fns: HashSet<u32>,
}

/// Scans `paths` (app modules, relative to `opts.root`). Runs on the compiler thread. A module that does not read or
/// parse is skipped.
pub fn scan(paths: &[String], opts: &AnalyzeOptions) -> LoadWrites {
    scan_for(paths, opts, None)
}

/// F610 D1: `scan`, where only the modules of `browser` (paths as in `paths`: every app module some bundle the build
/// writes for the browser contains) can spoil a table: mentions, namespace escapes, dynamic imports and unreadable modules
/// are taken from those only. A module no browser bundle contains never runs there, so nothing it does can change what a
/// load-time read does in the browser. The F230 writes (`written`, `writers`) still come from every module. `None`: every
/// module (the first scan of a build, and a build whose browser modules are not known).
pub fn scan_for(
    paths: &[String],
    opts: &AnalyzeOptions,
    browser: Option<&HashSet<String>>,
) -> LoadWrites {
    let _aliases = crate::analyze::aliases::Scope::enter(&opts.root, &opts.path_aliases);
    // F619: every module the scan reads (its own loop, the folder, the effect and export questions) is read and parsed
    // once. Declared after the alias scope, so it closes first (as in `analyze_with`).
    let _parses = crate::parse::ParseCache::enter();
    let mut scanned = Vec::new();
    let mut parsed_all: HashMap<String, std::rc::Rc<crate::parse::Parsed>> = HashMap::new();
    let mut readable = Vec::new();
    let mut unreadable: Vec<String> = Vec::new();
    for path in paths {
        let Ok(parsed) = crate::parse::parse_file(&opts.root, path) else {
            unreadable.push(path.clone());
            continue;
        };
        scanned.push(parsed.with_ast(|ast| scan_module(path, ast, opts)));
        parsed_all.insert(path.clone(), parsed);
        readable.push(path.clone());
    }
    // F599 (D1') + F610 D4: the mentions of every export in every module, with calls of top-level app functions followed
    // through their summaries (which need every module's imports and exports first).
    let (found, read_only): (Vec<Mentioned>, HashSet<(String, Hand)>) = {
        let fns = Fns {
            mods: &scanned,
            by_path: scanned
                .iter()
                .enumerate()
                .map(|(i, m)| (m.path.clone(), i))
                .collect(),
            parsed: &parsed_all,
            memo: Default::default(),
            busy: Default::default(),
        };
        let found = scanned
            .iter()
            .map(|m| {
                let parsed = &parsed_all[&m.path];
                parsed.with_ast(|ast| module_mentions(m, ast, &fns, opts))
            })
            .collect();
        (found, read_only_hands(&scanned, &fns, opts))
    };
    for (m, f) in scanned.iter_mut().zip(found) {
        m.mentions = f.mentions;
        m.ns_escapes = f.ns_escapes;
        m.dynamic = f.dynamic;
    }
    let in_browser = |p: &str| browser.is_none_or(|b| b.contains(p));
    let mut out = propagate(&scanned, &read_only);
    out.declared_written = declared_written(&scanned, &out.written);
    // F599 (D1'): the mentions of every export in every module of the build, before any module is judged.
    out.escaped_all = unreadable.iter().any(|p| in_browser(p));
    escaped_exports(&scanned, opts, &mut out, &in_browser);
    let mut with = opts.clone();
    with.load_writes = Some(std::sync::Arc::new(out.clone()));
    let mut clean: Vec<String> = readable
        .iter()
        .filter(|p| crate::analyze::const_fold::load_clean(p, &with))
        .cloned()
        .collect();
    clean.sort();
    clean.dedup();
    out.load_clean = clean;
    out
}

/// Fills `out.escaped` from the mentions every scanned module made (see `analyze::mentions`): an escape of an export, or
/// a use of it where it stands (an operand, an argument, a returned or stored value) when what the read path reaches in
/// its literal is a container. A mention through a re-export counts for the export it names at its declaration.
fn escaped_exports(
    mods: &[Scanned],
    opts: &AnalyzeOptions,
    out: &mut LoadWrites,
    in_browser: &dyn Fn(&str) -> bool,
) {
    let mut by_decl: HashMap<ExportKey, Vec<(Vec<Seg>, Pos)>> = HashMap::new();
    for m in mods.iter().filter(|m| in_browser(&m.path)) {
        for (k, path, pos) in &m.mentions {
            for d in declaring(mods, k, &mut HashSet::new()) {
                by_decl.entry(d).or_default().push((path.clone(), *pos));
            }
        }
        for k in &m.ns_escapes {
            out.escaped.insert((k.clone(), "*".to_string()));
        }
        for spec in &m.dynamic {
            match spec {
                Some(t) => {
                    out.escaped.insert((t.clone(), "*".to_string()));
                }
                None => out.escaped_all = true,
            }
        }
    }
    for ((module, export), uses) in by_decl {
        let key = (module.clone(), export.clone());
        if uses.iter().any(|(_, pos)| *pos == Pos::Escape) {
            out.escaped.insert(key);
            continue;
        }
        let free: Vec<&Vec<Seg>> = uses.iter().map(|(p, _)| p).collect();
        let Ok(parsed) = crate::parse::parse_file(&opts.root, &module) else {
            out.escaped.insert(key);
            continue;
        };
        let container = parsed.with_ast(|ast| {
            let Some((value, _)) = crate::analyze::module_effects::export_value(ast, &export)
            else {
                // not a literal `export const`: it is never data, whatever its mentions
                return false;
            };
            free.iter().any(|p| container_at(value, p))
        });
        if container {
            out.escaped.insert(key);
        }
    }
}

/// Whether reading `path` from the literal `e` may give a container (an object or an array), or something the scan cannot
/// follow. A path that leaves the literal (a missing member, a step into a primitive) gives a primitive: `undefined`
/// or a character, which cannot be written into.
fn container_at(e: &js_ast::Expr, path: &[Seg]) -> bool {
    let Some((first, rest)) = path.split_first() else {
        return !matches!(
            e.data,
            E::EString(_)
                | E::ENumber(_)
                | E::EBoolean(_)
                | E::ENull(_)
                | E::EUndefined(_)
                | E::EBigInt(_)
        );
    };
    match &e.data {
        E::EObject(o) => {
            let mut hit = false;
            for p in o.properties.iter() {
                let (Some(E::EString(key)), Some(v)) =
                    (p.key.as_ref().map(|k| &k.data), p.value.as_ref())
                else {
                    // a computed key, a spread, an accessor: not a literal the scan can follow
                    return true;
                };
                let key = crate::analyze::expr::estring(key);
                let named = match first {
                    Seg::Key(k) => *k == key,
                    Seg::Index(i) => i.to_string() == key,
                    Seg::Any => true,
                };
                if named && container_at(v, rest) {
                    hit = true;
                }
            }
            hit
        }
        E::EArray(a) => {
            if a.items
                .iter()
                .any(|x| matches!(x.data, E::ESpread(_) | E::EMissing(_)))
            {
                return true;
            }
            match first {
                Seg::Index(i) => a.items.get(*i).is_some_and(|v| container_at(v, rest)),
                Seg::Any => a.items.iter().any(|v| container_at(v, rest)),
                // `length` and anything else read from a list value
                Seg::Key(k) => match k.parse::<usize>() {
                    Ok(i) => a.items.get(i).is_some_and(|v| container_at(v, rest)),
                    Err(_) => k != "length",
                },
            }
        }
        E::EString(_)
        | E::ENumber(_)
        | E::EBoolean(_)
        | E::ENull(_)
        | E::EUndefined(_)
        | E::EBigInt(_) => false,
        _ => true,
    }
}

/// F615 (AMENDMENT 2): see `LoadWrites::declared_written`.
fn declared_written(mods: &[Scanned], written: &HashMap<ExportKey, String>) -> HashSet<ExportKey> {
    let mut out = HashSet::new();
    for k in written.keys() {
        if k.1 == "*" {
            // every export of a module that re-exports others: every export of those (fail closed)
            let mut todo = vec![k.0.clone()];
            let mut seen = HashSet::new();
            while let Some(p) = todo.pop() {
                if !seen.insert(p.clone()) {
                    continue;
                }
                out.insert((p.clone(), "*".to_string()));
                if let Some(m) = mods.iter().find(|m| m.path == p) {
                    todo.extend(m.follows.iter().map(|(_, t, _)| t.clone()));
                    todo.extend(m.stars.iter().cloned());
                    todo.extend(
                        m.imports
                            .values()
                            .filter(|i| {
                                m.exports
                                    .iter()
                                    .any(|(_, l)| l.is_some_and(|l| m.imports.get(&l) == Some(i)))
                            })
                            .map(|i| i.0.clone()),
                    );
                }
            }
            continue;
        }
        out.extend(declaring(mods, k, &mut HashSet::new()));
    }
    out
}

/// The exports a read of `k` reaches at their declaration, followed through re-exports (`export { x } from`,
/// `import { x }; export { x }`, `export *`). A key nothing declares stays as it is (fails closed in the caller).
fn declaring(mods: &[Scanned], k: &ExportKey, seen: &mut HashSet<ExportKey>) -> Vec<ExportKey> {
    if k.1 == "*" || !seen.insert(k.clone()) {
        return vec![k.clone()];
    }
    let Some(m) = mods.iter().find(|m| m.path == k.0) else {
        return vec![k.clone()];
    };
    if let Some((_, t, name)) = m.follows.iter().find(|(alias, _, _)| *alias == k.1) {
        return declaring(mods, &(t.clone(), name.clone()), seen);
    }
    if let Some((_, local)) = m.exports.iter().find(|(name, _)| *name == k.1) {
        if let Some(i) = local.and_then(|l| m.imports.get(&l)) {
            return declaring(mods, i, seen);
        }
        return vec![k.clone()];
    }
    let mut out = Vec::new();
    for t in &m.stars {
        out.extend(declaring(mods, &(t.clone(), k.1.clone()), seen));
    }
    if out.is_empty() {
        out.push(k.clone());
    }
    out
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
    // `export default function () {}` / `export default () => …`: a function no binding can reassign.
    let mut default_function = false;
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
                    default_function |= match &d.value {
                        js_ast::StmtOrExpr::Stmt(s) => {
                            matches!(&s.data, S::SFunction(f) if f.func.name.is_none())
                        }
                        js_ast::StmtOrExpr::Expr(e) => {
                            matches!(e.data, E::EArrow(_) | E::EFunction(_))
                        }
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
    let mut function: HashSet<String> = exports
        .iter()
        .filter(|(_, k)| k.is_some_and(|k| function_keys.contains(&k) && !reassigned.contains(&k)))
        .map(|(n, _)| n.clone())
        .collect();
    if default_function {
        function.insert("default".into());
    }
    let fns: HashSet<u32> = function_keys
        .iter()
        .filter(|k| !reassigned.contains(k))
        .copied()
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
        mentions: Vec::new(),
        ns_escapes: Vec::new(),
        dynamic: Vec::new(),
        fns,
    }
}

/// F614 D2: the hand-offs (by the module that makes them) that are not writes: the callee is a top-level app function
/// called by name, without a spread, and its summary for that parameter has no `Escape` and no `Free` mention whose path
/// reaches a container of the handed export's literal (no `Free` mention at all when that literal cannot be read). The
/// summary follows the parameter into further app calls (F610 D4), so a reader that hands it on to a writer is a writer;
/// what it returns of the parameter counts as a use where it stands (the caller may write it).
fn read_only_hands(
    mods: &[Scanned],
    fns: &Fns<'_>,
    opts: &AnalyzeOptions,
) -> HashSet<(String, Hand)> {
    let mut out = HashSet::new();
    for m in mods {
        for h in m.writes.handed.iter().chain(m.load.handed.iter()) {
            if h.spread {
                continue;
            }
            let Some(callee) = h.named else { continue };
            let Some((module, k)) = fns.resolve(&m.path, callee) else {
                continue;
            };
            let Some(s) = fns.summary(&module, k, 1) else {
                continue;
            };
            if h.pos as usize >= s.params {
                continue;
            }
            let uses: Vec<&(u32, Vec<Seg>, Pos)> =
                s.uses.iter().filter(|(i, _, _)| *i == h.pos).collect();
            if uses.iter().any(|(_, _, pos)| *pos == Pos::Escape) {
                continue;
            }
            // what it returns of the parameter reaches the caller, who may write it: a use where it stands
            let returned = s.returned(h.pos);
            let free: Vec<&Vec<Seg>> = uses
                .iter()
                .map(|(_, p, _)| p)
                .chain(returned.iter())
                .collect();
            if !free.is_empty() && !free_reaches_no_container(mods, &h.arg, &free, opts) {
                continue;
            }
            out.insert((m.path.clone(), h.clone()));
        }
    }
    out
}

/// F614 D2: every path of `free` read from the literal of `k` (at its declaration) gives a primitive.
fn free_reaches_no_container(
    mods: &[Scanned],
    k: &ExportKey,
    free: &[&Vec<Seg>],
    opts: &AnalyzeOptions,
) -> bool {
    let decl = declaring(mods, k, &mut HashSet::new());
    let [(module, export)] = decl.as_slice() else {
        return false;
    };
    let Ok(parsed) = crate::parse::parse_file(&opts.root, module) else {
        return false;
    };
    parsed.with_ast(|ast| {
        let Some((value, _)) = crate::analyze::module_effects::export_value(ast, export) else {
            return false;
        };
        free.iter().all(|p| !container_at(value, p))
    })
}

/// What `module_mentions` found in one module.
struct Mentioned {
    mentions: Vec<(ExportKey, Vec<Seg>, Pos)>,
    ns_escapes: Vec<String>,
    dynamic: Vec<Option<String>>,
}

/// F599 (D1'): every mention of an import, and of this module's own exported bindings, in the closed list's terms (F610
/// D4: a call of a top-level app function followed through its summary).
fn module_mentions(
    m: &Scanned,
    ast: &js_ast::Ast<'_>,
    fns: &Fns<'_>,
    opts: &AnalyzeOptions,
) -> Mentioned {
    use crate::analyze::mentions::Root;
    let names = NameTable::for_hook(ast);
    let mut tracked: HashSet<u32> = m.imports.keys().copied().collect();
    tracked.extend(m.exports.iter().filter_map(|(_, k)| *k));
    let namespaces: HashSet<u32> = m
        .imports
        .iter()
        .filter(|(_, (_, n))| n == "*")
        .map(|(k, _)| *k)
        .collect();
    let callees = ModCallees {
        fns,
        module: &m.path,
    };
    let found = crate::analyze::mentions::mentions(ast, &names, &tracked, &namespaces, &callees);
    let keys_of = |root: &Root| -> Vec<ExportKey> {
        match root {
            Root::Binding(k) => match m.imports.get(k) {
                Some(i) => vec![i.clone()],
                None => m
                    .exports
                    .iter()
                    .filter(|(_, l)| *l == Some(*k))
                    .map(|(n, _)| (m.path.clone(), n.clone()))
                    .collect(),
            },
            Root::Member(ns, member) => m
                .imports
                .get(ns)
                .map(|(module, _)| vec![(module.clone(), member.clone())])
                .unwrap_or_default(),
            Root::Param(_) => Vec::new(),
        }
    };
    let mut mentions = Vec::new();
    for f in &found.facts {
        for k in keys_of(&f.root) {
            mentions.push((k, f.path.clone(), f.pos));
        }
    }
    let ns_escapes: Vec<String> = found
        .namespace_escapes
        .iter()
        .filter_map(|k| m.imports.get(k).map(|(p, _)| p.clone()))
        .collect();
    // a package specifier names no app module; an app specifier that does not resolve, or no literal, may be any
    let target = |spec: &str| {
        if app_specifier(spec) {
            resolve(&m.path, spec, opts)
        } else {
            None
        }
    };
    let dynamic: Vec<Option<String>> = found
        .dynamic
        .iter()
        .filter(|spec| spec.as_deref().is_none_or(app_specifier))
        .map(|spec| spec.as_deref().and_then(target))
        .collect();
    Mentioned {
        mentions,
        ns_escapes,
        dynamic,
    }
}

type SummaryRc = std::rc::Rc<crate::analyze::mentions::Summary>;

/// F610 D4: the top-level functions of the build's modules and their summaries (memoised; a function whose summary is
/// being made is not followed again: a recursive call ends the track).
struct Fns<'m> {
    mods: &'m [Scanned],
    by_path: HashMap<String, usize>,
    parsed: &'m HashMap<String, std::rc::Rc<crate::parse::Parsed>>,
    memo: std::cell::RefCell<HashMap<(String, u32), Option<SummaryRc>>>,
    busy: std::cell::RefCell<HashSet<(String, u32)>>,
}

impl Fns<'_> {
    /// The top-level function the binding `k` of `module` is: one of its own, or one imported by name from an app module
    /// (re-exports followed); `None` for anything else.
    fn resolve(&self, module: &str, k: u32) -> Option<(String, u32)> {
        let m = &self.mods[*self.by_path.get(module)?];
        if m.fns.contains(&k) {
            return Some((module.to_string(), k));
        }
        let imported = m.imports.get(&k)?;
        if imported.1 == "*" {
            return None;
        }
        let decl = declaring(self.mods, imported, &mut HashSet::new());
        let [(dm, name)] = decl.as_slice() else {
            return None;
        };
        let d = &self.mods[*self.by_path.get(dm)?];
        let (_, local) = d.exports.iter().find(|(n, _)| n == name)?;
        let local = (*local)?;
        d.fns.contains(&local).then(|| (dm.clone(), local))
    }

    fn summary(
        &self,
        module: &str,
        k: u32,
        depth: u32,
    ) -> Option<std::rc::Rc<crate::analyze::mentions::Summary>> {
        let key = (module.to_string(), k);
        if let Some(s) = self.memo.borrow().get(&key) {
            return s.clone();
        }
        if !self.busy.borrow_mut().insert(key.clone()) {
            // recursive (directly or through other summarised functions)
            return None;
        }
        let parsed = self.parsed.get(module)?;
        let callees = ModCallees { fns: self, module };
        let s = parsed.with_ast(|ast| {
            let names = NameTable::for_hook(ast);
            crate::analyze::mentions::summarize(ast, &names, k, &callees, depth)
        });
        let s = s.map(std::rc::Rc::new);
        self.busy.borrow_mut().remove(&key);
        self.memo.borrow_mut().insert(key, s.clone());
        s
    }
}

struct ModCallees<'f, 'm> {
    fns: &'f Fns<'m>,
    module: &'f str,
}

impl crate::analyze::mentions::Callees for ModCallees<'_, '_> {
    fn summary(
        &self,
        callee: u32,
        depth: u32,
    ) -> Option<std::rc::Rc<crate::analyze::mentions::Summary>> {
        if depth > crate::analyze::mentions::MAX_SUMMARY_DEPTH {
            return None;
        }
        let (module, k) = self.fns.resolve(self.module, callee)?;
        self.fns.summary(&module, k, depth)
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
    // F614: with the callee's own binding key when it is called by name, the argument's position and whether it is spread.
    let mut handed_refs: Vec<HandedRef> = Vec::new();
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
            let named = match &call.target.data {
                E::EIdentifier(id) => Some(key(id.ref_)),
                E::EImportIdentifier(id) => Some(key(id.ref_)),
                _ => None,
            };
            let spread = call.args.iter().any(|a| matches!(a.data, E::ESpread(_)));
            for (i, a) in call.args.iter().enumerate() {
                let a = match &a.data {
                    E::ESpread(sp) => &sp.value,
                    _ => a,
                };
                match &a.data {
                    E::EIdentifier(id) => {
                        handed_refs.push((id.ref_, callee, named, i as u32, spread))
                    }
                    E::EImportIdentifier(id) => {
                        handed_refs.push((id.ref_, callee, named, i as u32, spread))
                    }
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
        .filter_map(|(r, callee, named, pos, spread)| {
            let arg = imports.get(&key(*r))?.clone();
            Some(Hand {
                arg,
                callee: callee.and_then(|c| imports.get(&key(c)).cloned()),
                named: *named,
                pos: *pos,
                spread: *spread,
            })
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

/// (argument, callee chain root, callee binding key when called by name, position, spread in the call).
type HandedRef = (js_ast::Ref, Option<js_ast::Ref>, Option<u32>, u32, bool);

/// An import handed to app code as a bare argument.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct Hand {
    /// The import handed.
    arg: ExportKey,
    /// The callee's import, when the callee chain starts at one (a method of a package-made value is package code).
    callee: Option<ExportKey>,
    /// F614: the binding key of the callee when it is called by its name (`f(x)`).
    named: Option<u32>,
    /// F614: the argument's position.
    pos: u32,
    /// F614: some argument of the call is spread.
    spread: bool,
}

/// The exports a piece of code writes: through a mutating method call (`list.push(…)`, `team.members.set(…)`), and
/// otherwise (an assignment, a hand-off).
#[derive(Default)]
struct Writes {
    method: BTreeSet<ExportKey>,
    other: BTreeSet<ExportKey>,
    /// An import handed to code that may write it.
    handed: BTreeSet<Hand>,
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
fn propagate(mods: &[Scanned], read_only: &HashSet<(String, Hand)>) -> LoadWrites {
    let mut out = LoadWrites::default();
    let package_made = |k: &ExportKey| {
        mods.iter()
            .any(|m| m.path == k.0 && m.package_made.contains(&k.1))
    };
    let primitive = |k: &ExportKey| {
        mods.iter()
            .any(|m| m.path == k.0 && m.primitive.contains(&k.1))
    };
    let function = |k: &ExportKey| is_function(mods, k, &mut HashSet::new());
    // The writes that count: a method call into a package-made value, or a hand-off to its methods, is its API; a
    // function handed on is code to call (F480); a primitive cannot be written.
    // F614 D2: a hand-off the callee's summary proves read-only is not a write.
    let counted = |path: &str, w: &Writes| -> BTreeSet<ExportKey> {
        let method = w.method.iter().filter(|k| !package_made(k));
        let handed = w
            .handed
            .iter()
            .filter(|h| {
                !h.callee.as_ref().is_some_and(package_made)
                    && !function(&h.arg)
                    && !read_only.contains(&(path.to_string(), (*h).clone()))
            })
            .map(|h| &h.arg);
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
        let modules: BTreeSet<String> = counted(&m.path, &m.load)
            .into_iter()
            .map(|(p, _)| p)
            .collect();
        if !modules.is_empty() {
            out.writers
                .push((m.path.clone(), modules.into_iter().collect()));
        }
    }
    out.writers.sort();
    out.writers.dedup();
    for m in mods {
        for w in &counted(&m.path, &m.writes) {
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

/// F480: `k` is a function export, followed through re-exports (`export { f } from './a'`, `import { f } from './a';
/// export { f }`) to its declaration. Fails closed at `export *`, a namespace, package code (not scanned) or a module
/// that did not resolve or parse.
fn is_function(mods: &[Scanned], k: &ExportKey, seen: &mut HashSet<ExportKey>) -> bool {
    if k.1 == "*" || !seen.insert(k.clone()) {
        return false;
    }
    let Some(m) = mods.iter().find(|m| m.path == k.0) else {
        return false;
    };
    if m.function.contains(&k.1) {
        return true;
    }
    if let Some((_, t, name)) = m.follows.iter().find(|(alias, _, _)| *alias == k.1) {
        return is_function(mods, &(t.clone(), name.clone()), seen);
    }
    m.exports
        .iter()
        .find(|(name, _)| *name == k.1)
        .and_then(|(_, local)| m.imports.get(&(*local)?))
        .is_some_and(|i| is_function(mods, i, seen))
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
