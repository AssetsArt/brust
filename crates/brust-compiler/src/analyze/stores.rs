//! Store modules (M3-F D7): the `defineStore('<name>', factory)` a `useStore` handle names,
//! read from the handle's module through re-exports. Bun-AST side of the stores pass
//! (`passes/stores.rs`). Everything that cannot be proven is an `Err(reason)`: never a guess.
use crate::analyze::component::AnalyzeOptions;
use crate::analyze::expr::{estring, template_text};
use crate::analyze::modules::{ModuleCache, normalize, resolve};
use crate::analyze::names::module_imports;
use crate::ir::StoreRef;
use bun_ast as js_ast;
use js_ast::b::B;
use js_ast::expr::Data as E;
use js_ast::stmt::Data as S;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

/// Specifiers `defineStore`/`signal`/`computed` are recognised from (C6 + the runtime-dom re-exports).
pub const STORE_API_SOURCES: &[&str] = &[
    "@brust/core/store",
    "@brust/runtime-dom/store",
    "@brust/runtime-dom",
    "brust/store",
];

/// The built-in navigation store's module (`packages/brust/src/navigation.ts`, design §11). A package module, so the
/// reader above (relative imports only) never sees it: [`builtin_store`] answers for it by name.
pub const NAVIGATION_SOURCE: &str = "@brust/core/navigation";

/// `navigation` exported by [`NAVIGATION_SOURCE`], as the store reader would describe it. `StoreRef.module` is the
/// package specifier: the manifest, `jobs.js` and the loader name the module that way (packages/brust/src/store/builtin.ts).
pub fn builtin_store(source: &str, export: &str) -> Option<StoreRef> {
    (source == NAVIGATION_SOURCE && export == "navigation").then(|| StoreRef {
        name: "navigation".into(),
        module: NAVIGATION_SOURCE.into(),
        // The keys of the factory in navigation.ts, sorted.
        signals: ["error", "id", "state", "status", "to", "trigger", "url"]
            .map(String::from)
            .into(),
        computeds: vec![],
        factory_read: true,
    })
}

/// How many modules a re-export chain may cross before the reader gives up.
const MAX_DEPTH: usize = 8;

/// `export` of the module at root-relative `path` as a store; follows `export {…} from`,
/// `export * from` and import-then-export clauses (depth ≤ 8, `(path, export)` visited set).
/// `StoreRef.module` is the module that calls `defineStore`. Cached per `(path, export)` in
/// `modules`.
pub fn read_store_export(
    path: &str,
    export: &str,
    opts: &AnalyzeOptions,
    modules: &RefCell<ModuleCache>,
) -> Result<StoreRef, String> {
    let key = (normalize(path), export.to_string());
    if let Some(r) = modules.borrow().store_exports.get(&key) {
        return r.clone();
    }
    let r = read_export(&key.0, export, opts, &mut HashSet::new(), 0);
    modules.borrow_mut().store_exports.insert(key, r.clone());
    r
}

/// `true` when some export of the module at `path` is a store (`import * as ns` of it reaches
/// a handle). Export names are listed through `export * from` (depth ≤ 8), then each is read
/// with [`read_store_export`].
pub fn exports_a_store(path: &str, opts: &AnalyzeOptions, modules: &RefCell<ModuleCache>) -> bool {
    let mut names = HashSet::new();
    export_names(&normalize(path), opts, &mut HashSet::new(), 0, &mut names);
    names
        .iter()
        .any(|n| read_store_export(path, n, opts, modules).is_ok())
}

fn export_names(
    path: &str,
    opts: &AnalyzeOptions,
    visited: &mut HashSet<String>,
    depth: usize,
    out: &mut HashSet<String>,
) {
    if depth > MAX_DEPTH || !visited.insert(path.to_string()) {
        return;
    }
    let Ok(bytes) = std::fs::read(opts.root.join(path)) else {
        return;
    };
    let Ok(parsed) = crate::parse::parse_tsx(path, bytes) else {
        return;
    };
    let stars = parsed.with_ast(|ast| {
        let m = Module::new(ast);
        let records = ast.import_records.as_slice();
        let mut stars = Vec::new();
        for part in ast.parts.iter() {
            for stmt in part.stmts.slice() {
                match &stmt.data {
                    S::SLocal(l) if l.is_export => {
                        for d in l.decls.iter() {
                            if let B::BIdentifier(id) = d.binding.data {
                                out.insert(m.name(id.r#ref));
                            }
                        }
                    }
                    S::SExportDefault(_) => {
                        out.insert("default".into());
                    }
                    S::SExportClause(c) => out.extend(
                        c.items
                            .slice()
                            .iter()
                            .map(|i| String::from_utf8_lossy(i.alias.slice()).into_owned()),
                    ),
                    S::SExportFrom(f) => out.extend(
                        f.items
                            .slice()
                            .iter()
                            .map(|i| String::from_utf8_lossy(i.alias.slice()).into_owned()),
                    ),
                    S::SExportStar(st) if st.alias.is_none() => stars.extend(
                        records
                            .get(st.import_record_index as usize)
                            .map(|r| String::from_utf8_lossy(r.path.text).into_owned()),
                    ),
                    _ => {}
                }
            }
        }
        stars
    });
    for spec in stars {
        if super::modules::is_relative_spec(&spec)
            && let Some(p) = resolve(path, &spec, opts)
        {
            export_names(&p, opts, visited, depth + 1, out);
        }
    }
}

/// What one module says about an export.
enum Found {
    Store(StoreRef),
    /// Re-exported from another module: (specifier, export there).
    Follow(String, String),
    /// Not named here; maybe behind one of these `export * from` specifiers.
    Stars(Vec<String>),
}

fn read_export(
    path: &str,
    export: &str,
    opts: &AnalyzeOptions,
    visited: &mut HashSet<(String, String)>,
    depth: usize,
) -> Result<StoreRef, String> {
    if depth > MAX_DEPTH {
        return Err(format!(
            "the re-exports of `{export}` cross more than {MAX_DEPTH} modules"
        ));
    }
    if !visited.insert((path.to_string(), export.to_string())) {
        return Err(format!(
            "`{export}` is re-exported in a cycle through {path}"
        ));
    }
    let bytes =
        std::fs::read(opts.root.join(path)).map_err(|e| format!("cannot read {path}: {e}"))?;
    let parsed = crate::parse::parse_tsx(path, bytes)
        .map_err(|e| format!("cannot parse {path}: {}", e.message))?;
    let found = parsed.with_ast(|ast| find_export(ast, path, export))?;
    let follow = |spec: &str| -> Result<String, String> {
        if !super::modules::is_relative_spec(spec) {
            return Err(format!(
                "`{export}` is re-exported by {path} from the package {spec}"
            ));
        }
        resolve(path, spec, opts).ok_or_else(|| format!("cannot resolve {spec} from {path}"))
    };
    match found {
        Found::Store(r) => Ok(r),
        Found::Follow(spec, name) => read_export(&follow(&spec)?, &name, opts, visited, depth + 1),
        Found::Stars(specs) => {
            // The first star that has it; a star that cannot be followed may still be the
            // one, so its reason wins over a plain "no export".
            let mut reason = None;
            for spec in specs {
                let r =
                    follow(&spec).and_then(|p| read_export(&p, export, opts, visited, depth + 1));
                match r {
                    Ok(r) => return Ok(r),
                    Err(e) if e.contains("has no export") => {}
                    Err(e) => reason = reason.or(Some(e)),
                }
            }
            Err(reason.unwrap_or_else(|| format!("{path} has no export `{export}`")))
        }
    }
}

/// What a module-level binding is.
enum Target {
    Expr(js_ast::Expr),
    Ref(js_ast::Ref),
}

fn find_export(ast: &js_ast::Ast<'_>, path: &str, export: &str) -> Result<Found, String> {
    let m = Module::new(ast);
    let records = ast.import_records.as_slice();
    let spec_of = |i: u32| {
        records
            .get(i as usize)
            .map(|r| String::from_utf8_lossy(r.path.text).into_owned())
    };
    let mut target = None;
    let mut stars = Vec::new();
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            match &stmt.data {
                S::SLocal(l) if l.is_export => {
                    for d in l.decls.iter() {
                        if let B::BIdentifier(id) = d.binding.data
                            && m.name(id.r#ref) == export
                        {
                            target = d.value.map(Target::Expr);
                        }
                    }
                }
                S::SExportDefault(ed) if export == "default" => match &ed.value {
                    js_ast::StmtOrExpr::Expr(e) => target = Some(Target::Expr(*e)),
                    js_ast::StmtOrExpr::Stmt(_) => {
                        return Err(format!(
                            "the default export of {path} is not a defineStore(…) call"
                        ));
                    }
                },
                S::SExportClause(c) => {
                    for item in c.items.slice() {
                        if item.alias.slice() == export.as_bytes() {
                            target = Some(Target::Ref(item.name.ref_));
                        }
                    }
                }
                S::SExportFrom(f) => {
                    for item in f.items.slice() {
                        if item.alias.slice() == export.as_bytes()
                            && let Some(spec) = spec_of(f.import_record_index)
                        {
                            let original = String::from_utf8_lossy(item.original_name.slice());
                            return Ok(Found::Follow(spec, original.into_owned()));
                        }
                    }
                }
                S::SExportStar(st) => match &st.alias {
                    None => stars.extend(spec_of(st.import_record_index)),
                    Some(a) if a.original_name.slice() == export.as_bytes() => {
                        return Err(format!(
                            "`{export}` of {path} is a namespace re-export, not a store"
                        ));
                    }
                    Some(_) => {}
                },
                _ => {}
            }
        }
    }
    let not_store =
        || format!("`{export}` of {path} is not a defineStore(…) call from @brust/core/store");
    // A binding exported by name may be an import (follow it) or a module-level const.
    let mut target = match target {
        Some(t) => t,
        None if !stars.is_empty() => return Ok(Found::Stars(stars)),
        None => return Err(format!("{path} has no export `{export}`")),
    };
    for _ in 0..4 {
        let r = match target {
            Target::Expr(e) => match &e.data {
                E::EIdentifier(id) => id.ref_,
                E::EImportIdentifier(id) => id.ref_,
                _ => {
                    return m
                        .define_store(&e, path)
                        .map(Found::Store)
                        .map_err(|e| e.unwrap_or_else(not_store));
                }
            },
            Target::Ref(r) => r,
        };
        if let Some((spec, imported)) = m.import_of(r) {
            if imported == "*" {
                return Err(format!(
                    "`{export}` of {path} is a namespace import, not a store"
                ));
            }
            return Ok(Found::Follow(spec.to_string(), imported.to_string()));
        }
        target = Target::Expr(*m.consts.get(&m.key(r)).ok_or_else(not_store)?);
    }
    Err(not_store())
}

/// Module-level facts the reader needs: imports and top-level `const` initialisers.
pub(crate) struct Module<'a> {
    symbols: &'a [js_ast::Symbol],
    imports: HashMap<u32, (String, String)>,
    consts: HashMap<u32, js_ast::Expr>,
}

impl<'a> Module<'a> {
    pub(crate) fn new(ast: &'a js_ast::Ast<'_>) -> Self {
        let mut m = Module {
            symbols: ast.symbols.as_slice(),
            imports: module_imports(ast),
            consts: HashMap::new(),
        };
        for part in ast.parts.iter() {
            for stmt in part.stmts.slice() {
                if let S::SLocal(l) = &stmt.data {
                    m.read_consts(l);
                }
            }
        }
        m
    }

    /// Records the `const x = <value>` bindings of `l` (a `let`/`var` may be reassigned).
    fn read_consts(&mut self, l: &js_ast::S::Local) {
        if !matches!(l.kind, js_ast::S::Kind::KConst) {
            return;
        }
        for d in l.decls.iter() {
            if let (B::BIdentifier(id), Some(v)) = (d.binding.data, d.value) {
                let k = self.key(id.r#ref);
                self.consts.insert(k, v);
            }
        }
    }

    /// The symbol after following same-module links (as `NameTable::key`).
    fn key(&self, r: js_ast::Ref) -> u32 {
        let mut idx = r.inner_index();
        for _ in 0..64 {
            let Some(sym) = self.symbols.get(idx as usize) else {
                break;
            };
            if !sym.has_link() {
                break;
            }
            let next = sym.link.get();
            if next.source_index() != r.source_index() {
                break;
            }
            idx = next.inner_index();
        }
        idx
    }

    /// The initialiser of the module-level `const` `r`.
    pub(crate) fn const_value(&self, r: js_ast::Ref) -> Option<js_ast::Expr> {
        self.consts.get(&self.key(r)).copied()
    }

    pub(crate) fn name(&self, r: js_ast::Ref) -> String {
        self.symbols
            .get(self.key(r) as usize)
            .map(|s| String::from_utf8_lossy(s.original_name.slice()).into_owned())
            .unwrap_or_default()
    }

    pub(crate) fn import_of(&self, r: js_ast::Ref) -> Option<(&str, &str)> {
        let (s, i) = self
            .imports
            .get(&self.key(r))
            .or_else(|| self.imports.get(&r.inner_index()))?;
        Some((s.as_str(), i.as_str()))
    }

    /// The store-API function (`defineStore`, `signal`, `computed`) a call names, by import
    /// identity (an alias included).
    fn api_call<'e>(&self, e: &'e js_ast::Expr) -> Option<(&str, &'e js_ast::E::Call)> {
        let E::ECall(call) = &e.data else {
            return None;
        };
        let r = match &call.target.data {
            E::EIdentifier(id) => id.ref_,
            E::EImportIdentifier(id) => id.ref_,
            _ => return None,
        };
        match self.import_of(r) {
            Some((source, imported)) if STORE_API_SOURCES.contains(&source) => {
                Some((imported, call))
            }
            _ => None,
        }
    }

    /// `defineStore('<name>', factory)` → its `StoreRef` (`module` = `path`). `Err(None)` when
    /// `e` is not such a call at all; `Err(Some(reason))` when it is one the reader refuses.
    fn define_store(&self, e: &js_ast::Expr, path: &str) -> Result<StoreRef, Option<String>> {
        let Some(("defineStore", call)) = self.api_call(e) else {
            return Err(None);
        };
        let args = &call.args[..];
        let name = match args.first().map(|a| &a.data) {
            Some(E::EString(s)) => estring(s),
            Some(E::ETemplate(t)) if t.tag.is_none() && t.parts.slice().is_empty() => {
                template_text(&t.head)
            }
            _ => {
                return Err(Some(format!(
                    "the store name passed to defineStore in {path} is not a string literal"
                )));
            }
        };
        if name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
        {
            return Err(Some(format!(
                "the store name '{name}' in {path} is not [A-Za-z0-9_.:-]+"
            )));
        }
        let (signals, computeds, factory_read) = match args.get(1) {
            Some(f) => self.factory_keys(f),
            None => (vec![], vec![], false),
        };
        Ok(StoreRef {
            name,
            module: path.to_string(),
            signals,
            computeds,
            factory_read,
        })
    }

    /// The factory's top-level keys: (signals, computeds, read). `read` is false when the
    /// returned object is not literally visible (`() => makeStore()`, a spread, a computed key)
    /// or when the factory may return something else (any return besides its one top-level
    /// return: `if (x) return { … }`).
    fn factory_keys(&self, f: &js_ast::Expr) -> (Vec<String>, Vec<String>, bool) {
        let stmts = match &f.data {
            E::EArrow(a) => a.body.stmts.slice(),
            E::EFunction(func) => func.func.body.stmts.slice(),
            _ => return (vec![], vec![], false),
        };
        // `const count = signal(0)` locals of the factory body → their API function.
        let mut locals: HashMap<u32, &str> = HashMap::new();
        let mut returned = None;
        let mut other_return = false;
        for stmt in stmts {
            match &stmt.data {
                S::SLocal(l) if matches!(l.kind, js_ast::S::Kind::KConst) => {
                    for d in l.decls.iter() {
                        if let (B::BIdentifier(id), Some(v)) = (d.binding.data, &d.value)
                            && let Some((api, _)) = self.api_call(v)
                        {
                            locals.insert(self.key(id.r#ref), api);
                        }
                    }
                }
                S::SReturn(r) => {
                    other_return |= returned.is_some();
                    returned = Some(r.value);
                }
                _ => other_return |= has_return(stmt),
            }
        }
        if other_return {
            return (vec![], vec![], false);
        }
        let Some(E::EObject(obj)) = returned.flatten().map(|e| e.data) else {
            return (vec![], vec![], false);
        };
        let (mut signals, mut computeds, mut read) = (vec![], vec![], true);
        for p in obj.properties.iter() {
            let key = match &p.key.map(|k| k.data) {
                Some(E::EString(s))
                    if matches!(p.kind, js_ast::G::PropertyKind::Normal)
                        && !p.flags.contains(js_ast::flags::Property::IsComputed) =>
                {
                    estring(s)
                }
                _ => {
                    read = false;
                    continue;
                }
            };
            let api = p.value.as_ref().and_then(|v| match &v.data {
                E::EIdentifier(id) => locals.get(&self.key(id.ref_)).copied(),
                _ => self.api_call(v).map(|(api, _)| api),
            });
            match api {
                Some("signal") => signals.push(key),
                Some("computed") => computeds.push(key),
                _ => {}
            }
        }
        signals.sort();
        signals.dedup();
        computeds.sort();
        computeds.dedup();
        (signals, computeds, read)
    }
}

/// `true` when `stmt` holds a `return` of the enclosing function (nested functions and classes
/// are not walked: their returns are their own).
fn has_return(stmt: &js_ast::Stmt) -> bool {
    let any = |stmts: &[js_ast::Stmt]| stmts.iter().any(has_return);
    match &stmt.data {
        S::SReturn(_) => true,
        S::SBlock(b) => any(b.stmts.slice()),
        S::SIf(i) => has_return(&i.yes) || i.no.as_ref().is_some_and(has_return),
        S::SFor(f) => has_return(&f.body),
        S::SForIn(f) => has_return(&f.body),
        S::SForOf(f) => has_return(&f.body),
        S::SWhile(w) => has_return(&w.body),
        S::SDoWhile(w) => has_return(&w.body),
        S::SWith(w) => has_return(&w.body),
        S::SLabel(l) => has_return(&l.stmt),
        S::STry(t) => {
            any(t.body.slice())
                || t.catch.as_ref().is_some_and(|c| any(c.body.slice()))
                || t.finally.as_ref().is_some_and(|f| any(f.stmts.slice()))
        }
        S::SSwitch(sw) => sw.cases.slice().iter().any(|c| any(c.body.slice())),
        _ => false,
    }
}
