//! Multi-module analysis: resolve a child component's import, compile it once
//! per run, and break import cycles (plan Task 5, Review Focus 4).
use crate::analyze::component::{
    AnalyzeOptions, analyze_component, analyze_named_component, finish_diagnostics,
};
use crate::analyze::passes::{PassCtx, run_passes};
use crate::ir::{ComponentIR, Diagnostic};
use std::cell::RefCell;
use std::collections::HashMap;
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

    pub fn insert(&mut self, key: String, e: Entry) {
        self.map.insert(key, e);
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
        Export::Default => analyze_component(&parsed)?,
        Export::Named(name) => analyze_named_component(&parsed, name).ok_or_else(|| {
            Diagnostic::fallback(
                "export-shape",
                format!("{path} has no function declaration `{name}`"),
                0,
                "export the component as `export function Name(props) { … }`",
            )
        })?,
    };
    let local = |name: &str| analyze_named_component(&parsed, name);
    let ctx = PassCtx {
        text: parsed.text(),
        opts,
        path,
        modules,
        local: &local,
    };
    run_passes(&mut ir, &ctx);
    finish_diagnostics(&mut ir, parsed.text());
    Ok(ir)
}

/// The module a relative import names, as a path relative to the root:
/// `<rel>`, `<rel>.tsx`, `<rel>.ts`, `<rel>/index.tsx`, first that exists.
/// `None` for a package import or when nothing exists.
pub fn resolve(parent: &str, rel: &str, opts: &AnalyzeOptions) -> Option<String> {
    if !(rel.starts_with("./") || rel.starts_with("../")) {
        return None;
    }
    let dir = match parent.rfind('/') {
        Some(i) => &parent[..i],
        None => "",
    };
    let joined = normalize(&if dir.is_empty() && !parent.starts_with('/') {
        rel.to_string()
    } else {
        format!("{dir}/{rel}")
    });
    let mut candidates = Vec::new();
    if joined.ends_with(".tsx") || joined.ends_with(".ts") {
        candidates.push(joined.clone());
    }
    candidates.push(format!("{joined}.tsx"));
    candidates.push(format!("{joined}.ts"));
    candidates.push(format!("{joined}/index.tsx"));
    candidates.into_iter().find(|c| opts.root.join(c).is_file())
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

#[cfg(test)]
mod tests {
    use super::normalize;

    #[test]
    fn normalizes_relative_segments() {
        assert_eq!(normalize("a/b/./c"), "a/b/c");
        assert_eq!(normalize("a/b/../c"), "a/c");
        assert_eq!(normalize("./C"), "C");
        assert_eq!(normalize("/abs/dir/./C"), "/abs/dir/C");
        assert_eq!(normalize("../x"), "../x");
    }
}
