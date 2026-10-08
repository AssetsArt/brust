//! Bridge to Bun's React Compiler: implements its `Host` over a `Parsed` module and
//! runs the vendored `analyze_fn`. Returns plain-Rust `HirSummary` (spec §4.2(a)).
use crate::parse::Parsed;
use crate::summary::{DepInfo, HirSummary, ScopeInfo};
use bun_ast as js_ast;
use bun_react_compiler::{Host, JsxImportKind};

#[derive(Debug, thiserror::Error)]
pub enum HirError {
    #[error("no `export default function` in this module")]
    NoDefaultExportFunction,
    #[error("react compiler could not lower this component: {0}")]
    Unsupported(String),
}

/// Read-only view of a parsed module. Analysis never creates symbols or imports;
/// the mutating `Host` methods panic so a pass that starts needing them is loud.
struct AstHost<'a> {
    ast: &'a js_ast::Ast<'static>,
    source: &'a js_ast::Source,
    arena: &'a bun_alloc::Arena,
}

impl Host for AstHost<'_> {
    fn symbols(&self) -> &[js_ast::Symbol] {
        self.ast.symbols.as_slice()
    }
    fn module_scope(&self) -> &js_ast::Scope {
        &self.ast.module_scope
    }
    fn import_records(&self) -> &[js_ast::ImportRecord] {
        self.ast.import_records.as_slice()
    }
    fn source(&self) -> &[u8] {
        self.source.contents()
    }
    fn arena(&self) -> &bun_alloc::Arena {
        self.arena
    }
    fn ref_name(&self, r: js_ast::Ref) -> &[u8] {
        if r.is_source_contents_slice() {
            let start = r.source_index() as usize;
            &self.source.contents()[start..start + r.inner_index() as usize]
        } else {
            self.ast.symbols.as_slice()[r.inner_index() as usize].original_name.slice()
        }
    }
    fn scope_for_loc(&self, _loc: js_ast::Loc) -> Option<&js_ast::Scope> {
        None
    }
    fn jsx_import(&mut self, _kind: JsxImportKind) -> js_ast::Ref {
        js_ast::Ref::NONE
    }
    fn jsx_import_kind(&self, r: js_ast::Ref) -> Option<JsxImportKind> {
        if r.is_source_contents_slice() {
            return None;
        }
        let name = self.ref_name(r);
        Some(if name.starts_with(b"jsxDEV") {
            JsxImportKind::JsxDEV
        } else if name.starts_with(b"jsxs") {
            JsxImportKind::Jsxs
        } else if name.starts_with(b"jsx") {
            JsxImportKind::Jsx
        } else if name.starts_with(b"Fragment") {
            JsxImportKind::Fragment
        } else if name.starts_with(b"createElement") {
            JsxImportKind::CreateElement
        } else {
            return None;
        })
    }
    fn is_jsx_classic(&self) -> bool {
        false
    }
    fn jsx_classic_factory(&mut self, _loc: js_ast::Loc) -> js_ast::Expr {
        unreachable!("classic jsx runtime is never configured")
    }
    fn new_generated(&mut self, name: &[u8]) -> js_ast::Ref {
        panic!("Host::new_generated({}) during analysis", String::from_utf8_lossy(name))
    }
    fn new_local(&mut self, name: &[u8]) -> js_ast::Ref {
        panic!("Host::new_local({}) during analysis", String::from_utf8_lossy(name))
    }
    fn record_usage(&mut self, _r: js_ast::Ref) {}
    fn add_import_record(&mut self, path: &[u8], _kind: js_ast::ImportKind) -> (u32, js_ast::Ref) {
        panic!("Host::add_import_record({}) during analysis", String::from_utf8_lossy(path))
    }
}

pub fn analyze_hir(parsed: &Parsed) -> Result<HirSummary, HirError> {
    let ast = parsed.ast();
    let mut stmts: Vec<js_ast::Stmt> = Vec::new();
    let mut func: Option<&js_ast::G::Fn> = None;
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            stmts.push(stmt.clone());
            if let js_ast::stmt::Data::SExportDefault(ed) = &stmt.data
                && let js_ast::StmtOrExpr::Stmt(inner) = &ed.value
                && let js_ast::stmt::Data::SFunction(sf) = &inner.data
            {
                func = Some(&sf.func);
            }
        }
    }
    let func = func.ok_or(HirError::NoDefaultExportFunction)?;
    let fn_name = parsed.default_export_function_name().unwrap_or_default();

    // Lowering allocates AST-side vectors; route them into a scope of our own over
    // the module's arena. Declared before every analysis value so it drops last.
    let mut ast_alloc = js_ast::ASTMemoryAllocator::borrowing(parsed.arena());
    let _scope = ast_alloc.enter();

    let mut host = AstHost { ast, source: parsed.source(), arena: parsed.arena() };
    let bindings =
        bun_react_compiler::collect_import_bindings(&stmts, host.import_records(), host.symbols());
    let opts = bun_react_compiler::ReactCompilerOptions::default();
    let mut ctx = bun_react_compiler::imports::ProgramContext::new(opts, None, None, false);
    ctx.init_from_scope(host.symbols());
    let env_config = bun_react_compiler::EnvironmentConfig::default();

    let (reactive_fn, env) = bun_react_compiler::pipeline::analyze_fn(
        &bun_react_compiler::lowering::FunctionNode::Function(func),
        Some(&fn_name),
        &mut host,
        bun_react_compiler::hir::ReactFunctionType::Component,
        &env_config,
        &mut ctx,
        &bindings,
    )
    .map_err(|e| HirError::Unsupported(format!("{e:?}")))?;

    let name_of = |id: &bun_react_compiler::hir::IdentifierId| -> String {
        env.identifiers
            .iter()
            .find(|i| &i.id == id)
            .and_then(|i| i.name.as_ref())
            .map(|n| match n {
                bun_react_compiler::hir::IdentifierName::Named(s)
                | bun_react_compiler::hir::IdentifierName::Promoted(s) => {
                    String::from_utf8_lossy(s.slice()).into_owned()
                }
            })
            .unwrap_or_else(|| format!("#{}", id.0))
    };
    let mut scopes: Vec<ScopeInfo> = env
        .scopes
        .iter()
        .map(|s| ScopeInfo {
            id: s.id.0,
            deps: s
                .dependencies
                .iter()
                .map(|d| DepInfo { name: name_of(&d.identifier), reactive: d.reactive })
                .collect(),
            decls: s.declarations.iter().map(|(id, _)| name_of(id)).collect(),
        })
        .collect();
    scopes.sort_by_key(|s| s.id);

    Ok(HirSummary {
        function: fn_name,
        params: reactive_fn.params.len(),
        scopes,
        identifiers: env.identifiers.len(),
    })
}
