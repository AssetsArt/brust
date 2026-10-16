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
    /// Modules the chunk imports that other chunks share (specialised clones with an equal factory, R34.124).
    pub client_modules: Vec<ClientModule>,
    pub diagnostics: Vec<NapiDiagnostic>,
}

#[napi(object)]
pub struct CompiledTree {
    pub components: Vec<CompiledComponent>,
    pub error: Option<NapiDiagnostic>,
}

fn diag(d: &Diagnostic) -> NapiDiagnostic {
    NapiDiagnostic {
        class: d.class.as_str().into(),
        rule: d.rule.clone(),
        message: d.message.clone(),
        line: d.line,
        col: d.col,
        remediation: d.remediation.clone(),
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
    /// F230: `scanLoadWrites`'s result (`[[module, export, why], …]`).
    pub load_writes: Option<String>,
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
            error: Some(NapiDiagnostic {
                class: "error".into(),
                rule: "compile-input".into(),
                message: format!("compileTree argument `{name}` is not the JSON it takes: {e}"),
                line: 0,
                col: 0,
                remediation:
                    "pass `pathAliases` (an array), `packages` (an object) and `loadWrites` (an array) in that order"
                        .into(),
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
        load_writes,
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
        load_writes,
    };
    // `Lowered` holds `Rc`s (not `Send`): convert on the compiler thread.
    brust_compiler::parse::run_on_compiler_thread(|| {
        match brust_compiler::pipeline::compile_tree(path, None, &opts, runtime_import) {
            Err(d) => CompiledTree {
                components: vec![],
                error: Some(diag(&d)),
            },
            Ok(tree) => CompiledTree {
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
            load_writes,
        },
    )
}

/// F230: scans the app modules the build loads (`modules`, relative to `root`) for writes into another app module's
/// exports; the JSON result goes to every `compile_tree` of the build as `loadWrites`. `path_aliases` as for
/// `compile_tree`; a bad one is ignored (the compile reports it).
#[napi]
pub fn scan_load_writes(
    root: String,
    modules: Vec<String>,
    path_aliases: Option<String>,
) -> String {
    crate::init_tracing();
    let opts = AnalyzeOptions {
        root: std::path::PathBuf::from(root),
        path_aliases: path_aliases
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default(),
        ..Default::default()
    };
    brust_compiler::parse::run_on_compiler_thread(|| {
        brust_compiler::analyze::load_writes::scan(&modules, &opts).to_json()
    })
}

#[cfg(test)]
mod tests {
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
