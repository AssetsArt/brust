//! Multi-module analysis: resolve a child component's import, compile it once
//! per run, and break import cycles (plan Task 5, Review Focus 4).
use crate::analyze::component::{
    AnalyzeOptions, analyze_component_in, analyze_named_component_in, finish_diagnostics,
};
use crate::analyze::passes::{PassCtx, run_passes};
use crate::ir::{ComponentIR, Diagnostic};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;

/// A compiled (or compiling) component, keyed by `path` or `path#export`.
#[derive(Debug, Clone)]
pub enum Entry {
    /// Being compiled further up the stack: requesting it again is a cycle.
    InProgress,
    Done(Rc<ComponentIR>),
    Failed(Diagnostic),
}

#[derive(Debug, Default)]
pub struct ModuleCache {
    map: HashMap<String, Entry>,
    /// Cache key of the component the run was started for.
    root: Option<String>,
    /// Store exports read so far (M3-F D7), by (module path, export).
    pub store_exports: HashMap<(String, String), Result<crate::ir::StoreRef, String>>,
    /// Store name → the module that defines it, for `store-name-duplicate`.
    pub store_names: BTreeMap<String, String>,
}

impl ModuleCache {
    pub fn get(&self, key: &str) -> Option<&Entry> {
        self.map.get(key)
    }

    /// Every compiled component, by key, sorted.
    pub fn done(&self) -> Vec<(String, Rc<ComponentIR>)> {
        let mut out: Vec<_> = self
            .map
            .iter()
            .filter_map(|(k, e)| match e {
                Entry::Done(ir) => Some((k.clone(), ir.clone())),
                _ => None,
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// F188: records the package export that `key`'s component is written as in app code. The first spelling wins; the
    /// component's other readers keep their `Rc` (the field is read by the build, from `done()`). Not `Done` (an import
    /// cycle reaching the component while it compiles) is a no-op on purpose: the build then keeps the source import.
    pub fn set_dist(&mut self, key: &str, dist: crate::ir::ExternalRef) {
        if let Some(Entry::Done(ir)) = self.map.get_mut(key)
            && ir.dist.is_none()
        {
            let mut next = (**ir).clone();
            next.dist = Some(dist);
            *ir = Rc::new(next);
        }
    }

    /// Marks `key` as the component the run was asked for.
    pub fn set_root(&mut self, key: String) {
        self.root = Some(key);
    }

    pub fn is_root(&self, key: &str) -> bool {
        self.root.as_deref() == Some(key)
    }

    pub fn insert(&mut self, key: String, e: Entry) {
        self.map.insert(key, e);
    }

    /// Forgets `key` (a specialised clone that turned out to need React).
    pub fn remove(&mut self, key: &str) {
        self.map.remove(key);
    }
}

/// Which component of a module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Export {
    Default,
    /// A named export or a function local to the module.
    Named(String),
}

pub fn cache_key(path: &str, export: &Export) -> String {
    match export {
        Export::Default => path.to_string(),
        Export::Named(n) => format!("{path}#{n}"),
    }
}

/// What a lookup found.
pub enum Lookup {
    Compiled(Rc<ComponentIR>),
    Cycle,
    Failed(Diagnostic),
}

/// Compiles `export` of the module at `path` (relative to `opts.root`; `source`
/// when the caller already has the text) through `modules`.
pub fn compile(
    path: &str,
    export: &Export,
    source: Option<Vec<u8>>,
    opts: &AnalyzeOptions,
    modules: &RefCell<ModuleCache>,
) -> Lookup {
    // One spelling per module, so a cycle back to the root is seen at once.
    let path = &normalize(path);
    let key = cache_key(path, export);
    match modules.borrow().get(&key) {
        Some(Entry::InProgress) => return Lookup::Cycle,
        Some(Entry::Done(ir)) => return Lookup::Compiled(ir.clone()),
        Some(Entry::Failed(d)) => return Lookup::Failed(d.clone()),
        None => {}
    }
    modules.borrow_mut().insert(key.clone(), Entry::InProgress);
    let result = compile_uncached(path, export, source, opts, modules);
    let entry = match &result {
        Ok(ir) => Entry::Done(Rc::new(ir.clone())),
        Err(d) => Entry::Failed(d.clone()),
    };
    modules.borrow_mut().insert(key, entry.clone());
    match entry {
        Entry::Done(ir) => Lookup::Compiled(ir),
        Entry::Failed(d) => Lookup::Failed(d),
        Entry::InProgress => unreachable!(),
    }
}

/// R34.123: compiles `export` of the module at `path` as a specialisation of it: the component's own pre-pass IR is
/// handed to `splice`, which puts the call site's content into it, and the result goes through the whole pass pipeline
/// as a component of its own under `key` (a synthetic cache key, not a path). The component is the same function of the
/// same module, so everything it resolves (imports, local components, module scope) resolves as it does for the
/// original.
pub fn compile_specialised(
    path: &str,
    export: &Export,
    key: String,
    opts: &AnalyzeOptions,
    modules: &RefCell<ModuleCache>,
    splice: &mut dyn FnMut(&mut ComponentIR) -> Result<(), String>,
) -> Result<Rc<ComponentIR>, String> {
    if let Some(Entry::Done(ir)) = modules.borrow().get(&key) {
        return Ok(ir.clone());
    }
    let path = &normalize(path);
    let source =
        std::fs::read(opts.root.join(path)).map_err(|e| format!("cannot read {path}: {e}"))?;
    let parsed =
        crate::parse::parse_tsx(path, source).map_err(|e| format!("{path}: {}", e.message))?;
    let mut ir = match export {
        Export::Default => analyze_component_in(&parsed, Some(opts)).map_err(|d| d.message)?,
        Export::Named(name) => {
            use crate::analyze::exports::{Binding, find};
            let local = match parsed.with_ast(|ast| find(ast, name)) {
                Binding::Fn(l) | Binding::Local(l) => l,
                _ => return Err(format!("{path} has no function declaration `{name}`")),
            };
            let mut ir = analyze_named_component_in(&parsed, &local, Some(opts))
                .ok_or_else(|| format!("{path} has no function declaration `{local}`"))?;
            ir.id = crate::ir::named_component_id(path, name);
            ir.export = Some(name.clone());
            ir
        }
    };
    splice(&mut ir)?;
    let local = |name: &str| analyze_named_component_in(&parsed, name, Some(opts));
    let ctx = PassCtx {
        text: parsed.text(),
        opts,
        path,
        modules,
        local: &local,
        is_root: false,
        specialised: true,
    };
    run_passes(&mut ir, &ctx);
    finish_diagnostics(&mut ir, parsed.text());
    ir.alias_imports = parsed.alias_imports();
    let ir = Rc::new(ir);
    modules.borrow_mut().insert(key, Entry::Done(ir.clone()));
    Ok(ir)
}

fn compile_uncached(
    path: &str,
    export: &Export,
    source: Option<Vec<u8>>,
    opts: &AnalyzeOptions,
    modules: &RefCell<ModuleCache>,
) -> Result<ComponentIR, Diagnostic> {
    let source = match source {
        Some(s) => s,
        None => std::fs::read(opts.root.join(path)).map_err(|e| {
            Diagnostic::error(
                "unresolved-import",
                format!("cannot read {path}: {e}"),
                0,
                "check the import path",
            )
        })?,
    };
    let parsed = crate::parse::parse_tsx(path, source).map_err(|e| {
        Diagnostic::error(
            "parse",
            format!("{path}: {} at {}:{}", e.message, e.line, e.column),
            0,
            "fix the syntax error",
        )
    })?;
    let mut ir = match export {
        Export::Default => analyze_component_in(&parsed, Some(opts))?,
        Export::Named(name) => {
            use crate::analyze::exports::{Binding, find};
            let binding = parsed.with_ast(|ast| find(ast, name));
            let unexported = matches!(binding, Binding::Local(_));
            let local = match binding {
                Binding::Fn(l) | Binding::Local(l) => l,
                // Declared, but not as a function the compiler reads: an island that imports the binding.
                Binding::Opaque | Binding::Member(_) | Binding::Namespace(_) => {
                    return Ok(opaque_island(path, name));
                }
                _ => name.clone(),
            };
            let mut ir =
                analyze_named_component_in(&parsed, &local, Some(opts)).ok_or_else(|| {
                    Diagnostic::fallback(
                        "export-shape",
                        format!("{path} has no function declaration `{local}`"),
                        0,
                        "export the component as `export function Name(props) { … }`",
                    )
                })?;
            // The component is known by the binding the importer used, whatever it is called here.
            ir.id = crate::ir::named_component_id(path, name);
            ir.export = Some(name.clone());
            ir.unexported = unexported;
            ir
        }
    };
    let local = |name: &str| analyze_named_component_in(&parsed, name, Some(opts));
    let ctx = PassCtx {
        text: parsed.text(),
        opts,
        path,
        modules,
        local: &local,
        is_root: modules.borrow().is_root(&cache_key(path, export)),
        specialised: false,
    };
    run_passes(&mut ir, &ctx);
    finish_diagnostics(&mut ir, parsed.text());
    ir.alias_imports = parsed.alias_imports();
    Ok(ir)
}

/// Whether `spec` names a file relative to its importer: `./x`, `../x`, and the bare `.` and `..` (a directory's index).
/// The one place the compiler tells a relative import from a package (F218): a bare `.`/`..` was read as a package name
/// by some passes and as nothing by others.
pub fn is_relative_spec(spec: &str) -> bool {
    spec == "." || spec == ".." || spec.starts_with("./") || spec.starts_with("../")
}

/// `rel` joined onto the directory of `parent` and normalised (`..` that climb past the start stay as leading `..`).
fn join_relative(parent: &str, rel: &str) -> String {
    let dir = match parent.rfind('/') {
        Some(i) => &parent[..i],
        None => "",
    };
    normalize(&if dir.is_empty() && !parent.starts_with('/') {
        rel.to_string()
    } else {
        format!("{dir}/{rel}")
    })
}

/// Whether a normalised module path lies outside the app root and every source root (F243, F256): a leading `..` that no
/// source root covers, or an absolute path that is not under `opts.root` when its importer is. (An absolute importer
/// outside the root, as the tests analyse, has no root to stay in.) The package sources the build writes live under the
/// root (`.brust/pkg-src`), so they are inside. Lexical on purpose: a source root is a path prefix of the NORMALISED
/// module path, so `../shared/../secret` (= `../secret`) is outside `../shared`.
fn leaves_root(parent: &str, joined: &str, opts: &AnalyzeOptions) -> bool {
    let under = |p: &str| std::path::Path::new(p).starts_with(&opts.root);
    if joined == ".." || joined.starts_with("../") {
        return !in_source_root(joined, opts);
    }
    joined.starts_with('/') && under(parent) && !under(joined)
}

/// Whether the normalised root-relative `joined` is a source root or lies inside one.
fn in_source_root(joined: &str, opts: &AnalyzeOptions) -> bool {
    opts.source_roots.iter().any(|r| {
        let r = normalize(r);
        joined == r
            || joined
                .strip_prefix(&r)
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

/// Whether the relative import `rel` of `parent` names a place outside the app root: such an import is refused, never
/// read (F243). Callers that report an unresolved import say so by name.
pub fn import_leaves_root(parent: &str, rel: &str, opts: &AnalyzeOptions) -> bool {
    is_relative_spec(rel) && leaves_root(parent, &join_relative(parent, rel), opts)
}

/// The module a relative import names, as a path relative to the root:
/// `<rel>`, `<rel>.tsx`, `<rel>.ts`, `<rel>/index.tsx`, `<rel>/index.ts`, first that exists.
/// `None` for a package import or when nothing exists.
pub fn resolve(parent: &str, rel: &str, opts: &AnalyzeOptions) -> Option<String> {
    if !is_relative_spec(rel) {
        return None;
    }
    let joined = join_relative(parent, rel);
    if leaves_root(parent, &joined, opts) {
        return None;
    }
    let mut candidates = Vec::new();
    // `.` and `..` name a directory: only its index can answer (`../a.tsx` for `..` from `a/b.tsx` would be a file).
    let dir_only = rel == "." || rel == "..";
    if !dir_only {
        if joined.ends_with(".tsx") || joined.ends_with(".ts") {
            candidates.push(joined.clone());
        }
        candidates.push(format!("{joined}.tsx"));
        candidates.push(format!("{joined}.ts"));
    }
    let base = if joined.is_empty() || joined == "." {
        String::new()
    } else {
        format!("{joined}/")
    };
    candidates.push(format!("{base}index.tsx"));
    candidates.push(format!("{base}index.ts"));
    candidates.into_iter().find(|c| opts.root.join(c).is_file())
}

/// Where the build writes package sources (F153c), relative to the root.
pub const PKG_SRC_DIR: &str = ".brust/pkg-src/";

/// The scope a module's bare imports resolve in: the written package it lies in (`.brust/pkg-src/<dir>`),
/// or `""` for the app.
pub fn package_scope(path: &str) -> &str {
    let Some(rest) = path.strip_prefix(PKG_SRC_DIR) else {
        return "";
    };
    match rest.find('/') {
        Some(i) => &path[..PKG_SRC_DIR.len() + i],
        None => "",
    }
}

/// Whether the module at `path` is a package source the build wrote (F153c).
pub fn is_package_source(path: &str) -> bool {
    !package_scope(path).is_empty()
}

/// The package source a bare import of the module at `parent` names (F153c, R34.61): `Ok(entry)` when the build
/// wrote it, `Err(Some(reason))` when it refused the package, `Err(None)` when it was never asked.
pub fn resolve_package(
    parent: &str,
    spec: &str,
    opts: &AnalyzeOptions,
) -> Result<String, Option<String>> {
    let scope = package_scope(parent);
    let p = &opts.packages;
    if let Some(entry) = p.scopes.get(scope).and_then(|m| m.get(spec)) {
        // Review F1: only a file the build wrote under its own directory is package source; anything else (a path
        // that leaves it) is refused, never read as app code.
        if !is_package_source(entry)
            || entry
                .split('/')
                .any(|s| s == ".." || s == "." || s.is_empty())
        {
            return Err(Some(format!(
                "the package source path {entry} is not inside {PKG_SRC_DIR}"
            )));
        }
        return Ok(entry.clone());
    }
    Err(p.refused.get(scope).and_then(|m| m.get(spec)).cloned())
}

/// [`resolve`], then [`resolve_package`]: the module a relative or a bare import names, if the compiler may read it.
pub fn resolve_module(parent: &str, spec: &str, opts: &AnalyzeOptions) -> Option<String> {
    resolve(parent, spec, opts).or_else(|| resolve_package(parent, spec, opts).ok())
}

/// L20: the key of the CSS module `rel` names, relative to the module at `parent`: a path relative to the
/// root, `/`-separated, as `AnalyzeOptions::css_modules` is keyed. `None` for a package import.
pub fn css_module_key(parent: &str, rel: &str) -> Option<String> {
    if !is_relative_spec(rel) {
        return None;
    }
    let dir = parent.rfind('/').map_or("", |i| &parent[..i]);
    Some(normalize(&if dir.is_empty() {
        rel.to_string()
    } else {
        format!("{dir}/{rel}")
    }))
}

/// Resolves `.` and `..` segments of a `/`-separated path; an absolute path
/// stays absolute.
pub fn normalize(p: &str) -> String {
    let absolute = p.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|s| *s != "..") {
                    out.pop();
                } else {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    let joined = out.join("/");
    if absolute {
        format!("/{joined}")
    } else {
        joined
    }
}

/// Why an export the compiler cannot read is a React island.
pub const OPAQUE_EXPORT: &str = "export is not a function declaration";

/// The React island of an export the compiler cannot read (`export const X = () => …`,
/// `export const X = forwardRef(…)`): the build imports the binding itself (R34.10, fail closed).
fn opaque_island(path: &str, name: &str) -> ComponentIR {
    let mut ir = ComponentIR::new(crate::ir::named_component_id(path, name), path.to_string());
    ir.export = Some(name.to_string());
    ir.tier = crate::ir::Tier::React {
        reason: OPAQUE_EXPORT.into(),
        client_only: false,
    };
    crate::analyze::passes::tier::react_jobs(&mut ir);
    ir
}

#[cfg(test)]
mod tests {
    use super::{import_leaves_root, is_relative_spec, normalize, resolve};
    use crate::analyze::component::AnalyzeOptions;

    // F218: one predicate for "relative", and `.` / `..` resolve to the directory index on the same path as `./x`.
    #[test]
    fn dot_specifiers_are_relative_and_name_a_directory_index() {
        for s in [".", "..", "./a", "../a"] {
            assert!(is_relative_spec(s), "{s}");
        }
        for s in ["", "a", ".a", "..a", ".hidden/x", "react", "@s/p", "/abs"] {
            assert!(!is_relative_spec(s), "{s}");
        }
        let root = std::env::temp_dir().join(format!("brust-f218-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        for f in ["index.tsx", "a/index.tsx", "a/b/c.tsx", "a.tsx"] {
            std::fs::write(root.join(f), "").unwrap();
        }
        let opts = AnalyzeOptions {
            root: root.clone(),
            ..Default::default()
        };
        // `.` from a/b/c.tsx is a/b: no index there, and never the sibling FILE a/b.tsx or a.tsx.
        assert_eq!(resolve("a/b/c.tsx", ".", &opts), None);
        // `..` from a/b/c.tsx is a/: its index, not a.tsx.
        assert_eq!(
            resolve("a/b/c.tsx", "..", &opts).as_deref(),
            Some("a/index.tsx")
        );
        // `.` from the root file is the root index.
        assert_eq!(resolve("x.tsx", ".", &opts).as_deref(), Some("index.tsx"));
        assert_eq!(
            resolve("a/b/c.tsx", "../../a", &opts).as_deref(),
            Some("a.tsx")
        );
        // a bare package name is still not relative
        assert_eq!(resolve("a/b/c.tsx", "react", &opts), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn normalizes_relative_segments() {
        assert_eq!(normalize("a/b/./c"), "a/b/c");
        assert_eq!(normalize("a/b/../c"), "a/c");
        assert_eq!(normalize("./C"), "C");
        assert_eq!(normalize("/abs/dir/./C"), "/abs/dir/C");
        assert_eq!(normalize("../x"), "../x");
    }

    // F243: a relative import never leaves the app root, even when the file it names exists.
    #[test]
    fn resolve_is_confined_to_the_app_root() {
        let base = std::env::temp_dir().join(format!("brust-f243-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("app");
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::create_dir_all(root.join(".brust/pkg-src/p/src")).unwrap();
        std::fs::write(base.join("outside.tsx"), "").unwrap();
        std::fs::write(root.join("a/in.tsx"), "").unwrap();
        std::fs::write(root.join(".brust/pkg-src/p/src/x.tsx"), "").unwrap();
        let opts = AnalyzeOptions {
            root: root.clone(),
            ..Default::default()
        };
        // `outside.tsx` exists one level above the root: refused, by name for the diagnostic.
        assert_eq!(resolve("a/b.tsx", "../../outside", &opts), None);
        assert!(import_leaves_root("a/b.tsx", "../../outside", &opts));
        assert_eq!(resolve("a/b.tsx", "../../../../../..", &opts), None);
        assert!(import_leaves_root("a/b.tsx", "../../../..", &opts));
        assert!(import_leaves_root("x.tsx", "..", &opts));
        // inside: the app itself and the written package sources
        assert_eq!(
            resolve("a/b.tsx", "./in", &opts).as_deref(),
            Some("a/in.tsx")
        );
        assert!(!import_leaves_root("a/b.tsx", "../a/in", &opts));
        assert_eq!(
            resolve(".brust/pkg-src/p/src/y.tsx", "./x", &opts).as_deref(),
            Some(".brust/pkg-src/p/src/x.tsx")
        );
        // an absolute importer inside the root is held to it too; one outside has no root to stay in
        let abs = root.join("a/b.tsx").to_string_lossy().into_owned();
        assert!(import_leaves_root(&abs, "../../outside", &opts));
        assert!(!import_leaves_root("/elsewhere/a.tsx", "./b", &opts));
        let _ = std::fs::remove_dir_all(&base);
    }

    // F256: a source root lets an import reach beside the app, confined lexically like the app root.
    #[test]
    fn source_roots_extend_the_root_and_confine_themselves() {
        let base = std::env::temp_dir().join(format!("brust-f256-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("app");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(base.join("shared/ui")).unwrap();
        std::fs::create_dir_all(base.join("secret")).unwrap();
        for f in ["shared/Button.tsx", "shared/ui/Card.tsx", "secret/S.tsx"] {
            std::fs::write(base.join(f), "").unwrap();
        }
        let with = AnalyzeOptions {
            root: root.clone(),
            source_roots: vec!["../shared".into()],
            ..Default::default()
        };
        let without = AnalyzeOptions {
            root: root.clone(),
            ..Default::default()
        };
        // reachable only with the root
        assert_eq!(
            resolve("Page.tsx", "../shared/Button", &with).as_deref(),
            Some("../shared/Button.tsx")
        );
        assert_eq!(resolve("Page.tsx", "../shared/Button", &without), None);
        assert!(import_leaves_root("Page.tsx", "../shared/Button", &without));
        assert!(!import_leaves_root("Page.tsx", "../shared/Button", &with));
        // a file inside the root goes up and down inside it
        assert_eq!(
            resolve("../shared/ui/Card.tsx", "../Button", &with).as_deref(),
            Some("../shared/Button.tsx")
        );
        // the root's own index, and a root written un-normalised
        let odd = AnalyzeOptions {
            root: root.clone(),
            source_roots: vec!["../app/../shared/.".into()],
            ..Default::default()
        };
        assert_eq!(
            resolve("Page.tsx", "../shared/ui/Card", &odd).as_deref(),
            Some("../shared/ui/Card.tsx")
        );
        // escapes: a sibling, the root's parent, a `..` out of the root, and a prefix that only looks like it
        assert_eq!(resolve("Page.tsx", "../secret/S", &with), None);
        assert!(import_leaves_root(
            "../shared/ui/Card.tsx",
            "../../secret/S",
            &with
        ));
        assert!(import_leaves_root(
            "../shared/Button.tsx",
            "../shared/../secret/S",
            &with
        ));
        assert!(import_leaves_root("Page.tsx", "../shared-evil/x", &with));
        assert!(import_leaves_root("Page.tsx", "..", &with));
        assert!(import_leaves_root("Page.tsx", "../../..", &with));
        let _ = std::fs::remove_dir_all(&base);
    }
}
