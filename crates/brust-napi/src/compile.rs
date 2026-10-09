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

#[napi(object)]
pub struct CompiledComponent {
    pub id: String,
    pub source: String,
    /// `ComponentIR` as JSON (snake_case keys, as the compiler serialises it).
    pub ir: String,
    pub jinja: String,
    pub server_ts: Option<String>,
    pub client_js: Option<String>,
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

/// `compile_tree` on the compiler thread; `path` is relative to `root` so ids are stable.
pub(crate) fn compile_tree_impl(
    path: &str,
    root: &str,
    runtime_import: &str,
    server_only: Vec<String>,
) -> CompiledTree {
    let opts = AnalyzeOptions {
        server_only,
        root: std::path::PathBuf::from(root),
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
                        client_js: l.artifacts.client_js.clone(),
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

/// Compiles `path` (relative to `root`) and every child it reaches through lowering.
#[napi]
pub fn compile_tree(
    path: String,
    root: String,
    runtime_import: String,
    server_only: Vec<String>,
) -> CompiledTree {
    crate::init_tracing();
    compile_tree_impl(&path, &root, &runtime_import, server_only)
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
            vec![],
        );
        assert!(t.error.is_none(), "{:?}", t.error);
        let c = &t.components[0];
        assert_eq!(c.id, "input_a0366a49"); // relative path ⇒ the fixture's id
        assert!(c.ir.contains("\"uses_outlet\":true"));
        assert!(c.jinja.contains("{{ __outlet | safe }}"));
        assert!(c.client_js.is_none() && c.server_ts.is_none());
    }

    #[test]
    fn lowering_error_is_returned_not_panicked() {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
        let t = super::compile_tree_impl(
            "tests/fixtures/server-leak/input.tsx",
            root,
            "brust/runtime-dom",
            vec![],
        );
        assert_eq!(t.error.as_ref().map(|d| d.class.as_str()), Some("error"));
    }
}
