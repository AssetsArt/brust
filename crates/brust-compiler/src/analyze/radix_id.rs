//! Radix `useId` (F442 W3b, ruling on challenge 9cfa9df3): `@radix-ui/react-id` implements its hook with a state, a layout
//! effect and a module counter so that it also works before React 18:
//!
//! ```js
//! const useReactId = React[' useId '.trim().toString()] || (() => undefined);
//! let count = 0;
//! function useId(deterministicId) {
//!   const [id, setId] = React.useState(useReactId());
//!   useLayoutEffect(() => { if (!deterministicId) setId((reactId) => reactId ?? String(count++)); }, [deterministicId]);
//!   return deterministicId || (id ? `radix-${id}` : '');
//! }
//! ```
//!
//! With React 19 `useReactId()` is React's own `useId()`, which is a string on every render, so the hook is
//! `deterministicId || 'radix-' + useId()`: an ordinary id slot with a prefix. As for the `Primitive` factory
//! (`primitive.rs`), the module is recognised by its STRUCTURE: its statements, printed as JavaScript (types gone), must
//! equal the known shape token for token, local names aside, and its two imports must be React and the layout-effect
//! package. No version pin, no name check beyond the export; any other shape keeps being read as an ordinary custom hook.
use crate::analyze::component::AnalyzeOptions;
use crate::analyze::expr::{Js, print_js};
use crate::analyze::primitive::{exported_local, matches_shape};
use bun_ast::stmt::Data as S;

const SHAPE: &str = include_str!("radix_id.shape.js");

/// Whether `export` of the module at `path` (relative to the root) is Radix's `useId`.
pub fn is_radix_use_id(path: &str, export: &str, opts: &AnalyzeOptions) -> bool {
    match std::fs::read(opts.root.join(path)) {
        Ok(bytes) => is_radix_use_id_source(path, bytes, export),
        Err(_) => false,
    }
}

/// [`is_radix_use_id`] over the module's source.
pub fn is_radix_use_id_source(path: &str, bytes: Vec<u8>, export: &str) -> bool {
    let Ok(parsed) = crate::parse::parse_tsx(path, bytes) else {
        return false;
    };
    parsed.with_ast(|ast| {
        if exported_local(ast, export).as_deref() != Some("useId") {
            return false;
        }
        // The two imports the shape spells: React (the namespace) and the layout-effect package's hook.
        let imports = crate::analyze::names::module_imports(ast);
        let imported = |local: &str, source: &str, name: &str| {
            imports.iter().any(|(idx, (s, i))| {
                s == source
                    && i == name
                    && ast
                        .symbols
                        .get(*idx as usize)
                        .is_some_and(|sym| sym.original_name.slice() == local.as_bytes())
            })
        };
        if !imported("React", "react", "*")
            || !imported(
                "useLayoutEffect",
                "@radix-ui/react-use-layout-effect",
                "useLayoutEffect",
            )
        {
            return false;
        }
        let mut printed = String::new();
        for part in ast.parts.iter() {
            for stmt in part.stmts.slice() {
                if matches!(stmt.data, S::SImport(_) | S::SExportClause(_)) {
                    continue;
                }
                printed.push_str(&print_js(&parsed, ast, Js::Stmt(stmt)));
                printed.push('\n');
            }
        }
        let ok = matches_shape(&printed, SHAPE);
        if !ok && std::env::var_os("BRUST_DEBUG_RADIX_ID").is_some() {
            eprintln!("[radix-id] {path}#{export} not recognised:\n{printed}");
        }
        ok
    })
}

#[cfg(test)]
mod tests {
    use super::is_radix_use_id_source;

    /// `@radix-ui/react-id`'s source as published (its source map), from the installed package.
    fn published() -> String {
        let store =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../node_modules/.bun");
        let dir = std::fs::read_dir(&store)
            .unwrap()
            .filter_map(Result::ok)
            .find(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("@radix-ui+react-id@")
            })
            .expect("@radix-ui/react-id is installed")
            .path();
        let map = dir.join("node_modules/@radix-ui/react-id/dist/index.mjs.map");
        let map: serde_json::Value = serde_json::from_slice(&std::fs::read(map).unwrap()).unwrap();
        map["sourcesContent"][0].as_str().unwrap().to_string()
    }

    fn recognised(src: &str) -> bool {
        is_radix_use_id_source("id.tsx", src.as_bytes().to_vec(), "useId")
    }

    #[test]
    fn the_published_module_is_recognised() {
        assert!(recognised(&published()));
        // another export name is not the hook
        assert!(!is_radix_use_id_source(
            "id.tsx",
            published().into_bytes(),
            "useOther"
        ));
    }

    #[test]
    fn any_other_shape_is_not() {
        let src = published();
        for (what, changed) in [
            ("another prefix", src.replace("radix-${id}", "rdx-${id}")),
            (
                "a counter that starts elsewhere",
                src.replace("let count = 0", "let count = 1"),
            ),
            (
                "no deterministic override",
                src.replace("deterministicId || (id", "(id"),
            ),
            ("an extra statement", format!("{src}\nwindow.__x = 1\n")),
            (
                "another layout-effect package",
                src.replace("@radix-ui/react-use-layout-effect", "./layout"),
            ),
            (
                "an effect that sets another value",
                src.replace("String(count++)", "'x'"),
            ),
            (
                "a second id",
                src.replace("const [id, setId]", "const [id, setId, more]"),
            ),
        ] {
            assert!(!recognised(&changed), "{what} must not be recognised");
        }
    }

    #[test]
    fn local_names_do_not_matter() {
        let src = published()
            .replace("deterministicId", "given")
            .replace("reactId", "prev")
            .replace("useReactId", "reactIdHook");
        assert!(recognised(&src));
    }
}
