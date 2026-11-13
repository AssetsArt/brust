//! `compileTree`: `pipeline::compile_tree` (analysis + lowering of the whole
//! tree) on the compiler thread, IR returned as JSON.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::Diagnostic;
use napi_derive::napi;

#[napi(object)]
#[derive(Clone, Debug)]
pub struct NapiDiagnostic {
    pub class: String,
    pub rule: String,
    pub message: String,
    pub line: u32,
    pub col: u32,
    pub remediation: String,
    /// F395: the module `line`/`col` point into, when it is not the component's own (an inlined component's file).
    pub file: Option<String>,
}

/// A module a chunk imports by name, shared with other chunks (`<name>.js` beside it, R34.124).
#[napi(object)]
pub struct ClientModule {
    pub name: String,
    pub code: String,
}

#[napi(object)]
pub struct CompiledComponent {
    pub id: String,
    pub source: String,
    /// `ComponentIR` as JSON (snake_case keys, as the compiler serialises it).
    pub ir: String,
    pub jinja: String,
    pub server_ts: Option<String>,
    /// Build-time evaluation module (L2): one thunk per `ir.build_eval` slot.
    pub eval_ts: Option<String>,
    pub client_js: Option<String>,
    /// F362 PR2: `client_js` importing every imported list as written (the build's fallback).
    pub client_js_whole: Option<String>,
    /// F362 PR2: data modules (paths from the root) `client_js` no longer imports, their list declared projected.
    pub projected_modules: Vec<String>,
    /// Modules the chunk imports that other chunks share (specialised clones with an equal factory, R34.124).
    pub client_modules: Vec<ClientModule>,
    pub diagnostics: Vec<NapiDiagnostic>,
}

#[napi(object)]
pub struct CompiledTree {
    pub components: Vec<CompiledComponent>,
    pub error: Option<NapiDiagnostic>,
    /// F520: what the root FILE refers to (`facts::Facts` as JSON), set by `compileSource` when the text parses, whether or
    /// not the compile succeeded; `compileTree` leaves it absent.
    pub facts: Option<String>,
}

fn diag(d: &Diagnostic) -> NapiDiagnostic {
    NapiDiagnostic {
        class: d.class.as_str().into(),
        rule: d.rule.clone(),
        message: d.message.clone(),
        line: d.line,
        col: d.col,
        remediation: d.remediation.clone(),
        file: d.file.clone(),
    }
}

/// What the build hands `compile_tree` besides the file: everything optional, JSON where it is structured.
#[derive(Default)]
pub(crate) struct CompileInputs {
    pub server_only: Vec<String>,
    pub slot_values: Option<String>,
    pub css_modules: std::collections::HashMap<String, std::collections::HashMap<String, String>>,
    pub icon_svgs: Option<String>,
    pub route_roots: Vec<String>,
    pub path_aliases: Option<String>,
    pub packages: Option<String>,
    /// F256: `[build] source_roots`, normalised app-root-relative paths.
    pub source_roots: Vec<String>,
    /// F230: `scanLoadWrites`'s result (`[[module, export, why], …]`).
    pub load_writes: Option<String>,
    /// F518: the text of the root file, when the caller has it and the file does not exist on disk (`compileSource`).
    /// `path` still names the file: it decides the id and how relative imports resolve.
    pub source: Option<String>,
    /// F548: `path#Export` of the components compiled as client-only islands.
    pub client_only: Vec<String>,
}

/// An optional JSON argument; one that does not parse is an error, not an empty value: `path_aliases` and `packages`
/// are both `Option<String>` positions on the JS call, so a swapped pair must not silently drop either.
fn json_input<T: Default>(
    name: &str,
    text: Option<String>,
    parse: impl Fn(&str) -> serde_json::Result<T>,
) -> Result<T, Box<CompiledTree>> {
    let Some(text) = text else {
        return Ok(T::default());
    };
    parse(&text).map_err(|e| {
        Box::new(CompiledTree {
            components: vec![],
            facts: None,
            error: Some(NapiDiagnostic {
                class: "error".into(),
                rule: "compile-input".into(),
                message: format!("compileTree argument `{name}` is not the JSON it takes: {e}"),
                line: 0,
                col: 0,
                remediation:
                    "pass `pathAliases` (an array), `packages` (an object) and `loadWrites` (an array) in that order"
                        .into(),
                file: None,
            }),
        })
    })
}

/// `compile_tree` on the compiler thread; `path` is relative to `root` so ids are stable.
pub(crate) fn compile_tree_impl(
    path: &str,
    root: &str,
    runtime_import: &str,
    inputs: CompileInputs,
) -> CompiledTree {
    let CompileInputs {
        server_only,
        slot_values,
        css_modules,
        icon_svgs,
        route_roots,
        path_aliases,
        packages,
        source_roots,
        load_writes,
        source,
        client_only,
    } = inputs;
    // F230: the exports another app module writes, scanned once per build (`scan_load_writes`).
    let load_writes = match json_input("loadWrites", load_writes, |s| {
        brust_compiler::analyze::load_writes::LoadWrites::from_json(s).map(Some)
    }) {
        Ok(v) => v.map(std::sync::Arc::new),
        Err(e) => return *e,
    };
    // F153c: `{ "scopes": …, "refused": … }`, the package sources the build wrote (`pkg-src.ts`).
    let packages = match json_input("packages", packages, |s| serde_json::from_str(s)) {
        Ok(v) => v,
        Err(e) => return *e,
    };
    // `[{ "pattern": "@/*", "targets": ["./*"] }]`: `tsconfig` `paths` (R34.76).
    let path_aliases: Vec<brust_compiler::analyze::aliases::PathAlias> =
        match json_input("pathAliases", path_aliases, |s| serde_json::from_str(s)) {
            Ok(v) => v,
            Err(e) => return *e,
        };
    // `{ "final": bool, "svgs": { "<key>": "<svg markup>" } }`: lucide icons the build rendered (L23).
    let (icon_svgs, icons_final): (
        std::collections::HashMap<String, brust_compiler::analyze::component::IconMarkup>,
        bool,
    ) = icon_svgs
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .map(|v| {
            let svgs = v
                .get("svgs")
                .and_then(|s| serde_json::from_value(s.clone()).ok())
                .unwrap_or_default();
            (
                svgs,
                v.get("final").and_then(|f| f.as_bool()).unwrap_or(false),
            )
        })
        .unwrap_or_default();
    // `{ "<key>": <json> }`, the values the build computed for precompute slots (L2).
    let slot_values: std::collections::HashMap<String, serde_json::Value> = slot_values
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let opts = AnalyzeOptions {
        server_only,
        root: std::path::PathBuf::from(root),
        slot_values,
        css_modules,
        icon_svgs,
        icons_final,
        path_aliases,
        route_roots: route_roots.into_iter().collect(),
        packages,
        source_roots,
        load_writes,
        client_only: client_only.into_iter().collect(),
    };
    // `Lowered` holds `Rc`s (not `Send`): convert on the compiler thread.
    brust_compiler::parse::run_on_compiler_thread(|| {
        // F520: the facts come first and on their own parse: a source that parses has them even when it does not compile.
        let facts = source.as_ref().and_then(|text| {
            brust_compiler::analyze::facts::read_source(path, text.clone().into_bytes())
                .map(|f| serde_json::to_string(&f).expect("Facts serialises"))
        });
        match brust_compiler::pipeline::compile_tree(
            path,
            source.map(String::into_bytes),
            &opts,
            runtime_import,
        ) {
            Err(d) => CompiledTree {
                components: vec![],
                facts,
                error: Some(diag(&d)),
            },
            Ok(tree) => CompiledTree {
                facts,
                error: None,
                components: tree
                    .iter()
                    .map(|l| CompiledComponent {
                        id: l.ir.id.clone(),
                        source: l.ir.source.clone(),
                        ir: serde_json::to_string(&*l.ir).expect("ComponentIR serialises"),
                        jinja: l.artifacts.jinja.clone(),
                        server_ts: l.artifacts.server_ts.clone(),
                        eval_ts: l.artifacts.eval_ts.clone(),
                        client_js: l.artifacts.client_js.clone(),
                        client_js_whole: l.artifacts.client_js_whole.clone(),
                        projected_modules: l.artifacts.projected_modules.clone(),
                        client_modules: l
                            .artifacts
                            .client_modules
                            .iter()
                            .map(|(name, code)| ClientModule {
                                name: name.clone(),
                                code: code.clone(),
                            })
                            .collect(),
                        diagnostics: l
                            .ir
                            .diagnostics
                            .iter()
                            .chain(&l.artifacts.diagnostics)
                            .map(diag)
                            .collect(),
                    })
                    .collect(),
            },
        }
    })
}

/// Compiles `path` (relative to `root`) and every child it reaches through lowering. `css_modules` (L20): the class
/// map of each `*.module.css`, keyed by its path relative to `root`; `styles.x` folds to the literal class.
/// `packages` (F153c): the JSON resolution map of the package sources the build wrote (`pkg-src.ts`).
/// `source_roots` (F256): the directories besides the app that a relative import may reach.
// One positional argument per option: that is the JS call (`packages/brust/native/index.d.ts`).
#[allow(clippy::too_many_arguments)]
#[napi]
pub fn compile_tree(
    path: String,
    root: String,
    runtime_import: String,
    server_only: Vec<String>,
    slot_values: Option<String>,
    css_modules: Option<
        std::collections::HashMap<String, std::collections::HashMap<String, String>>,
    >,
    icon_svgs: Option<String>,
    route_roots: Option<Vec<String>>,
    path_aliases: Option<String>,
    packages: Option<String>,
    source_roots: Option<Vec<String>>,
    load_writes: Option<String>,
) -> CompiledTree {
    crate::init_tracing();
    compile_tree_impl(
        &path,
        &root,
        &runtime_import,
        CompileInputs {
            server_only,
            slot_values,
            css_modules: css_modules.unwrap_or_default(),
            icon_svgs,
            route_roots: route_roots.unwrap_or_default(),
            path_aliases,
            packages,
            source_roots: source_roots.unwrap_or_default(),
            load_writes,
            source: None,
            client_only: Vec::new(),
        },
    )
}

/// F518 `compileSource`'s options: the root file as TEXT (a runtime component is stored outside the app, so no file
/// exists), `path` the virtual app-root-relative name it is compiled under. One object, so `compile_tree`'s positional
/// list does not grow.
#[napi(object)]
pub struct CompileSourceOptions {
    /// Virtual path relative to `root` (`el/Promo-<hash>.tsx`): it decides the component id and how relative imports
    /// resolve; nothing is read from or written to it.
    pub path: String,
    /// The text of the root file.
    pub source: String,
    pub root: String,
    pub runtime_import: String,
    pub server_only: Option<Vec<String>>,
    /// `tsconfig` `paths`, JSON (an array), as for `compileTree`.
    pub path_aliases: Option<String>,
    pub source_roots: Option<Vec<String>>,
    /// L23 icons the caller rendered, JSON, as for `compileTree`; `{"final":true,"svgs":{}}` judges every icon an island.
    pub icon_svgs: Option<String>,
    /// F548 (R3): `path#Export` of the build's `[build] islands`: a React-tier one compiles as a client-only island (its
    /// caller prints an empty host, the browser mounts it).
    pub client_only: Option<Vec<String>>,
}

/// `compile_tree` for a root file given as text. Everything else is as `compile_tree`: the same analysis and lowering,
/// imports read from disk under `root` and `source_roots`.
#[napi]
pub fn compile_source(opts: CompileSourceOptions) -> CompiledTree {
    crate::init_tracing();
    compile_tree_impl(
        &opts.path,
        &opts.root,
        &opts.runtime_import,
        CompileInputs {
            server_only: opts.server_only.unwrap_or_default(),
            icon_svgs: opts.icon_svgs,
            path_aliases: opts.path_aliases,
            source_roots: opts.source_roots.unwrap_or_default(),
            source: Some(opts.source),
            client_only: opts.client_only.unwrap_or_default(),
            ..Default::default()
        },
    )
}

/// F230: scans the app modules the build loads (`modules`, relative to `root`) for writes into another app module's
/// exports; the JSON result goes to every `compile_tree` of the build as `loadWrites`. `path_aliases` as for
/// `compile_tree`; a bad one is ignored (the compile reports it). `source_roots` (F256, F276): the directories besides
/// the app that a relative import may reach, so a module there can be scanned and an import into it resolves.
#[napi]
pub fn scan_load_writes(
    root: String,
    modules: Vec<String>,
    path_aliases: Option<String>,
    source_roots: Option<Vec<String>>,
) -> String {
    crate::init_tracing();
    let opts = AnalyzeOptions {
        root: std::path::PathBuf::from(root),
        path_aliases: path_aliases
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default(),
        source_roots: source_roots.unwrap_or_default(),
        ..Default::default()
    };
    brust_compiler::parse::run_on_compiler_thread(|| {
        brust_compiler::analyze::load_writes::scan(&modules, &opts).to_json()
    })
}

/// F496: the first route pattern the server's router refuses (a conflict such as `/{*rest}` next to `/{slug}`, or an
/// invalid pattern), or `None`. `brust build` runs it over the flattened patterns (catch-all `*` routes left out, as
/// the server does) so the failure shows at build, with the router's own message. Needs no running server.
#[napi(object)]
pub struct RoutePatternConflict {
    /// Index into the `patterns` given of the pattern the router refused.
    pub index: u32,
    /// Index of the earlier pattern it conflicts with, when there is one.
    pub with_index: Option<u32>,
    /// The router's refusal, as `brust start` would print it.
    pub message: String,
}

#[napi]
pub fn check_route_patterns(patterns: Vec<String>) -> Option<RoutePatternConflict> {
    brust_core::routing::routes::find_pattern_conflict(&patterns).map(|c| RoutePatternConflict {
        index: c.index as u32,
        with_index: c.with_index.map(|j| j as u32),
        message: c.message,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn check_route_patterns_reports_a_catch_all_next_to_a_param() {
        let c = super::check_route_patterns(vec!["/{*rest}".into(), "/{slug}".into()]).unwrap();
        assert_eq!((c.index, c.with_index), (1, Some(0)));
        assert!(c.message.contains("invalid route pattern \"/{slug}\""));
        assert!(super::check_route_patterns(vec!["/{*rest}".into()]).is_none());
    }

    #[test]
    fn compiles_outlet_layout_fixture_through_lowering() {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
        let t = super::compile_tree_impl(
            "tests/fixtures/outlet-layout/input.tsx",
            root,
            "brust/runtime-dom",
            Default::default(),
        );
        assert!(t.error.is_none(), "{:?}", t.error);
        let c = &t.components[0];
        assert_eq!(c.id, "input_a0366a49"); // relative path ⇒ the fixture's id
        assert!(c.ir.contains("\"uses_outlet\":true"));
        assert!(c.jinja.contains("{{ __outlet | safe }}"));
        assert!(c.client_js.is_none() && c.server_ts.is_none());
    }

    #[test]
    fn swapped_path_aliases_and_packages_are_an_error_not_silently_empty() {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
        let t = super::compile_tree_impl(
            "tests/fixtures/outlet-layout/input.tsx",
            root,
            "brust/runtime-dom",
            super::CompileInputs {
                path_aliases: Some(r#"{"scopes":{},"refused":{}}"#.into()),
                ..Default::default()
            },
        );
        assert_eq!(
            t.error.as_ref().map(|d| d.rule.as_str()),
            Some("compile-input")
        );
        let t = super::compile_tree_impl(
            "tests/fixtures/outlet-layout/input.tsx",
            root,
            "brust/runtime-dom",
            super::CompileInputs {
                packages: Some(r#"[{"pattern":"@/*","targets":["*"]}]"#.into()),
                ..Default::default()
            },
        );
        assert_eq!(
            t.error.as_ref().map(|d| d.rule.as_str()),
            Some("compile-input")
        );
    }

    #[test]
    fn compile_source_compiles_text_that_is_not_on_disk() {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
        let src = "import { useState } from 'react'\nexport default function Promo() {\n  const [n, setN] = useState(0)\n  return <button onClick={() => setN(n + 1)}>{n}</button>\n}\n";
        let compile = |path: &str, source: &str| {
            super::compile_source(super::CompileSourceOptions {
                path: path.into(),
                source: source.into(),
                root: root.into(),
                runtime_import: "/_brust/client/runtime-x.js".into(),
                server_only: None,
                path_aliases: None,
                source_roots: None,
                icon_svgs: None,
            })
        };
        let t = compile("el/Promo-0123456789abcdef.tsx", src);
        assert!(t.error.is_none(), "{:?}", t.error);
        let c = &t.components[0];
        // The path decides the id: a stem word carrying the content hash, then the path hash.
        assert!(c.id.starts_with("promo0123456789abcdef_"), "{}", c.id);
        assert!(c.client_js.as_deref().is_some_and(|j| j.contains(&c.id)));
        assert!(c.jinja.contains(&c.id));
        assert!(
            !std::path::Path::new(root)
                .join("el/Promo-0123456789abcdef.tsx")
                .exists()
        );
        // Same path and text: the same artifact; another text hash in the name: another id.
        assert_eq!(
            compile("el/Promo-0123456789abcdef.tsx", src).components[0].id,
            c.id
        );
        assert_ne!(
            compile("el/Promo-fedcba9876543210.tsx", src).components[0].id,
            c.id
        );
    }

    #[test]
    fn lowering_error_is_returned_not_panicked() {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
        let t = super::compile_tree_impl(
            "tests/fixtures/server-leak/input.tsx",
            root,
            "brust/runtime-dom",
            Default::default(),
        );
        assert_eq!(t.error.as_ref().map(|d| d.class.as_str()), Some("error"));
    }
}
