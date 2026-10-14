//! `tsconfig` `paths` aliases (shadcn S1, R34.76): `import { Button } from "@/components/ui/button"` names a file of
//! the app, not a package. The build reads `compilerOptions.paths` (+ `baseUrl`) and hands the compiler the patterns as
//! root-relative templates (`@/*` -> `./*`); [`rewrite`] turns an alias specifier into the relative specifier of the
//! file it names, at parse time, so every later stage sees an ordinary relative import. Only exact and single-`*`
//! patterns resolve, and only to a file that exists under the root; anything else stays what it was (a package).
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use crate::analyze::modules::normalize;

/// One `paths` entry: `pattern` (`@/*`, `@app`) and its targets, `/`-separated, relative to the root, with at most one `*`.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize)]
pub struct PathAlias {
    pub pattern: String,
    pub targets: Vec<String>,
}

/// An alias import rewritten at parse time.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AliasImport {
    /// The module that wrote it (root-relative).
    pub from: String,
    /// The specifier as written.
    pub spec: String,
    /// The file it names (root-relative).
    pub target: String,
}

#[derive(Default)]
struct Active {
    root: PathBuf,
    aliases: Vec<PathAlias>,
}

thread_local! {
    static ACTIVE: RefCell<Option<Rc<Active>>> = const { RefCell::new(None) };
}

/// Aliases in force for the parses on this thread until dropped (the outermost analysis entry sets it).
pub struct Scope(Option<Rc<Active>>);

impl Scope {
    pub fn enter(root: &Path, aliases: &[PathAlias]) -> Scope {
        let next = (!aliases.is_empty()).then(|| {
            Rc::new(Active {
                root: root.to_path_buf(),
                aliases: aliases.to_vec(),
            })
        });
        Scope(ACTIVE.with(|a| a.replace(next)))
    }
}

impl Drop for Scope {
    fn drop(&mut self) {
        ACTIVE.with(|a| *a.borrow_mut() = self.0.take());
    }
}

const EXTS: &[&str] = &["", ".tsx", ".ts", "/index.tsx", "/index.ts"];

fn captured<'a>(pattern: &str, spec: &'a str) -> Option<Option<&'a str>> {
    match pattern.split_once('*') {
        None => (pattern == spec).then_some(None),
        Some((prefix, suffix)) if !suffix.contains('*') => {
            let mid = spec.strip_prefix(prefix)?.strip_suffix(suffix)?;
            Some(Some(mid))
        }
        _ => None,
    }
}

/// The rewrite of `spec` written in `parent` (a root-relative module path): `(relative specifier, target)`.
/// `None` for a relative import, a package, or an alias that names no file of the app.
pub fn rewrite(parent: &str, spec: &str) -> Option<(String, String)> {
    if spec.starts_with('.') || spec.starts_with('/') {
        return None;
    }
    let active = ACTIVE.with(|a| a.borrow().clone())?;
    let parent = if parent.starts_with('/') {
        Path::new(parent)
            .strip_prefix(&active.root)
            .ok()?
            .to_string_lossy()
            .into_owned()
    } else {
        parent.to_string()
    };
    for alias in &active.aliases {
        let Some(cap) = captured(&alias.pattern, spec) else {
            continue;
        };
        for t in &alias.targets {
            let t = match cap {
                Some(c) => t.replacen('*', c, 1),
                None => t.clone(),
            };
            let target = normalize(&t);
            if target.starts_with("..")
                || target.starts_with('/')
                || target.contains("node_modules/")
            {
                continue;
            }
            let found = EXTS.iter().find_map(|e| {
                let c = if e.is_empty() && !(target.ends_with(".tsx") || target.ends_with(".ts")) {
                    return None;
                } else {
                    format!("{target}{e}")
                };
                active.root.join(&c).is_file().then_some(c)
            });
            if let Some(found) = found {
                return Some((relative(&parent, &found), found));
            }
        }
        // The first pattern that matches decides, as TypeScript does.
        return None;
    }
    None
}

/// The specifier from the module `parent` to `target` (both root-relative).
fn relative(parent: &str, target: &str) -> String {
    let dir: Vec<&str> = parent
        .rsplit_once('/')
        .map_or(vec![], |(d, _)| d.split('/').collect());
    let to: Vec<&str> = target.split('/').collect();
    let common = dir.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let ups = dir.len() - common;
    let mut out = if ups == 0 {
        "./".to_string()
    } else {
        "../".repeat(ups)
    };
    out.push_str(&to[common..].join("/"));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_specifiers() {
        assert_eq!(
            relative("pages/a.tsx", "components/ui/b.tsx"),
            "../components/ui/b.tsx"
        );
        assert_eq!(relative("a.tsx", "components/b.tsx"), "./components/b.tsx");
        assert_eq!(
            relative("components/ui/a.tsx", "components/ui/b.tsx"),
            "./b.tsx"
        );
        assert_eq!(
            relative("components/ui/a.tsx", "lib/utils.ts"),
            "../../lib/utils.ts"
        );
    }

    #[test]
    fn patterns() {
        assert_eq!(
            captured("@/*", "@/components/x"),
            Some(Some("components/x"))
        );
        assert_eq!(captured("@app", "@app"), Some(None));
        assert_eq!(captured("@app", "@app/x"), None);
        assert_eq!(captured("a/*/b/*", "a/x/b/y"), None);
        assert_eq!(captured("~/*.ts", "~/x.ts"), Some(Some("x")));
    }
}
