//! Ties the readers together into a `ComponentIR`.
use crate::analyze::expr::{Js, Reader, print_js};
use crate::analyze::hooks::{mark_state_bindings, read_body};
use crate::analyze::names::NameTable;
use crate::ir::{
    Attr, BinOp, ComponentIR, Diagnostic, Expr, Literal, Node, RawExpr, RawKind, component_id,
    line_col, named_component_id,
};
use crate::parse::Parsed;
use bun_ast as js_ast;
use js_ast::expr::Data as E;
use js_ast::stmt::Data as S;

/// The `export default function` of the module.
pub(crate) fn default_export_fn<'x>(ast: &'x js_ast::Ast<'_>) -> Option<&'x js_ast::G::Fn> {
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            if let S::SExportDefault(ed) = &stmt.data
                && let js_ast::StmtOrExpr::Stmt(inner) = &ed.value
                && let S::SFunction(sf) = &inner.data
            {
                return Some(&sf.func);
            }
        }
    }
    None
}

/// Reads the module's default-export component into a structural `ComponentIR`
/// (spec §5): declarations from the body, the template from the returned JSX,
/// every value as `Expr::Raw`, `tier: Pending`. Placement, jobs and the tier
/// decision are M1b-2. Call it inside [`crate::parse::run_on_compiler_thread`].
///
/// `Err` only when the module has no default export at all; every other problem
/// is a diagnostic on the returned IR.
pub fn analyze_component(parsed: &Parsed) -> Result<ComponentIR, Diagnostic> {
    let path = parsed.path();
    let mut ir = ComponentIR::new(component_id(&path), path);
    parsed.with_ast(|ast| {
        let Some(func) = default_export_fn(ast) else {
            if let Some(done) = read_cache_export(parsed, ast, &mut ir) {
                return done;
            }
            if has_default_export(ast) {
                ir.diagnostics.push(Diagnostic::fallback(
                    "default-export-shape",
                    "the default export is not a function declaration",
                    0,
                    "write `export default function Name(props) { … }`",
                ));
                return Ok(());
            }
            return Err(Diagnostic::error(
                "no-default-export",
                "no default export in this module",
                0,
                "export the component with `export default function`",
            ));
        };
        read_function(parsed, ast, func, &mut ir);
        Ok(())
    })?;
    let text = parsed.text();
    for d in &mut ir.diagnostics {
        (d.line, d.col) = line_col(text, d.loc);
    }
    Ok(ir)
}

/// Options for the full analysis (structural read + M1b-2 passes).
#[derive(Debug, Clone, Default)]
pub struct AnalyzeOptions {
    /// Import path prefixes that are server-only (app config `serverOnly`).
    pub server_only: Vec<String>,
    /// Directory module paths are relative to.
    pub root: std::path::PathBuf,
}

/// Parses `source` as the module at `path` and runs the full analysis,
/// compiling child components it imports (read from `opts.root`). Call it
/// inside [`crate::parse::run_on_compiler_thread`].
pub fn analyze_source(
    path: &str,
    source: Vec<u8>,
    opts: &AnalyzeOptions,
) -> Result<ComponentIR, Diagnostic> {
    let modules = std::cell::RefCell::new(crate::analyze::modules::ModuleCache::default());
    analyze_with(path, Some(source), opts, &modules)
}

/// [`analyze_source`] for the file `opts.root / path`.
pub fn analyze_file(path: &str, opts: &AnalyzeOptions) -> Result<ComponentIR, Diagnostic> {
    let modules = std::cell::RefCell::new(crate::analyze::modules::ModuleCache::default());
    analyze_with(path, None, opts, &modules)
}

/// The full analysis through a caller-owned module cache, so the caller can
/// read every child component compiled on the way (M1c lowers them all).
pub fn analyze_with(
    path: &str,
    source: Option<Vec<u8>>,
    opts: &AnalyzeOptions,
    modules: &std::cell::RefCell<crate::analyze::modules::ModuleCache>,
) -> Result<ComponentIR, Diagnostic> {
    use crate::analyze::modules::{Export, Lookup, compile};
    match compile(path, &Export::Default, source, opts, modules) {
        Lookup::Compiled(ir) => Ok((*ir).clone()),
        Lookup::Failed(d) => Err(d),
        Lookup::Cycle => Err(Diagnostic::error(
            "import-cycle",
            format!("{path} is already being compiled"),
            0,
            "break the import cycle",
        )),
    }
}

/// Fills line/col and sorts by (class severity, line, col).
pub(crate) fn finish_diagnostics(ir: &mut ComponentIR, text: &[u8]) {
    for d in &mut ir.diagnostics {
        (d.line, d.col) = line_col(text, d.loc);
    }
    ir.diagnostics
        .sort_by_key(|d| (d.class.severity_rank(), d.line, d.col));
}

/// The expression of `export default <expr>`.
fn default_export_expr<'x>(ast: &'x js_ast::Ast<'_>) -> Option<&'x js_ast::Expr> {
    ast.parts.iter().find_map(|part| {
        part.stmts.slice().iter().find_map(|s| match &s.data {
            S::SExportDefault(ed) => match &ed.value {
                js_ast::StmtOrExpr::Expr(e) => Some(e),
                js_ast::StmtOrExpr::Stmt(_) => None,
            },
            _ => None,
        })
    })
}

/// Spec §3.4: `export default cache(Comp, { key, tags, revalidate })` with
/// `cache` imported from `brust`. Reads `Comp` (a function declared in this
/// module) as the component and the options into `ir.cache`. `None` when the
/// default export is not such a call.
fn read_cache_export(
    parsed: &Parsed,
    ast: &js_ast::Ast<'_>,
    ir: &mut ComponentIR,
) -> Option<Result<(), Diagnostic>> {
    let e = default_export_expr(ast)?;
    let E::ECall(call) = &e.data else {
        return None;
    };
    let callee = match &call.target.data {
        E::EImportIdentifier(id) => id.ref_,
        E::EIdentifier(id) => id.ref_,
        _ => return None,
    };
    let loc = e.loc.start.max(0) as u32;
    let shape = |message: &str| {
        Diagnostic::error(
            "cache-shape",
            message.to_string(),
            loc,
            "write `export default cache(Component, { key: (p) => …, tags: (p) => […], revalidate: 60 })`",
        )
    };
    // The callee must be `cache` from `brust`; the table is built for the
    // wrapped component, so first find it.
    let comp = call.args.first()?;
    let comp_name = match &comp.data {
        E::EIdentifier(id) => ast
            .symbols
            .as_slice()
            .get(id.ref_.inner_index() as usize)
            .map(|s| String::from_utf8_lossy(s.original_name.slice()).into_owned())?,
        E::EImportIdentifier(_) => {
            // Only checked once we know the callee is brust's cache().
            String::new()
        }
        _ => return None,
    };
    let func = module_fn(ast, &comp_name);
    let probe = func.or_else(|| default_export_fn(ast));
    let is_cache = |names: &NameTable<'_>| names.import_of(callee) == Some(("brust", "cache"));
    match (func, probe) {
        (Some(func), _) => {
            let mut names = NameTable::new(ast, func);
            if !is_cache(&names) {
                return None;
            }
            mark_state_bindings(func, &mut names);
            read_function(parsed, ast, func, ir);
            let print = |js: Js<'_>| print_js(parsed, ast, js);
            let mut reader = Reader::new(&mut names, &print);
            let mut decl = crate::ir::CacheDecl {
                key: None,
                tags: None,
                revalidate: None,
            };
            match call.args.get(1).map(|a| &a.data) {
                None => {}
                Some(E::EObject(obj)) => {
                    for p in obj.properties.iter() {
                        let (Some(k), Some(v)) = (&p.key, &p.value) else {
                            ir.diagnostics
                                .push(shape("cache() options must be plain properties"));
                            continue;
                        };
                        let key = match &k.data {
                            E::EString(s) => crate::analyze::expr::estring(s),
                            _ => String::new(),
                        };
                        match (key.as_str(), &v.data) {
                            ("key", _) => decl.key = Some(reader.expr(v)),
                            ("tags", _) => decl.tags = Some(reader.expr(v)),
                            ("revalidate", E::ENumber(n)) => decl.revalidate = Some(n.value()),
                            ("revalidate", _) => ir
                                .diagnostics
                                .push(shape("cache() revalidate must be a number literal")),
                            _ => ir.diagnostics.push(shape(&format!(
                                "unknown cache() option `{key}` (key, tags, revalidate)"
                            ))),
                        }
                    }
                }
                Some(_) => ir.diagnostics.push(shape(
                    "the second argument of cache() must be an object literal",
                )),
            }
            ir.cache = Some(decl);
            Some(Ok(()))
        }
        (None, Some(other)) => {
            let names = NameTable::new(ast, other);
            if !is_cache(&names) {
                return None;
            }
            ir.diagnostics.push(Diagnostic::fallback(
                "default-export-shape",
                "cache() wraps a component that is not a function declared in this module",
                loc,
                "declare the component in this module: `function Card(props) { … }`",
            ));
            Some(Ok(()))
        }
        (None, None) => None,
    }
}

/// Reads one component function into `ir` (structural).
fn read_function(
    parsed: &Parsed,
    ast: &js_ast::Ast<'_>,
    func: &js_ast::G::Fn,
    ir: &mut ComponentIR,
) {
    let mut names = NameTable::new(ast, func);
    mark_state_bindings(func, &mut names);
    let print = |js: Js<'_>| print_js(parsed, ast, js);
    let mut reader = Reader::new(&mut names, &print);
    let body = read_body(func, &mut reader);
    (ir.module_scope, ir.module_decls) = reader.module_scope(ast);
    ir.props = body.props;
    ir.state = body.state;
    ir.derived = body.derived;
    ir.effects = body.effects;
    ir.handlers = body.handlers;
    ir.refs = body.refs;
    ir.id_bindings = body.id_bindings;
    ir.diagnostics.extend(body.diagnostics);
    let root_loc = match &body.return_expr {
        Some(Expr::Raw(r)) => r.loc,
        _ => 0,
    };
    let root = body
        .return_expr
        .map(root_node)
        .unwrap_or(Node::Fragment(vec![]));
    ir.template = host_root(root, root_loc, &mut ir.diagnostics);
}

/// The module-level `function <name>` (exported or not).
fn module_fn<'x>(ast: &'x js_ast::Ast<'_>, name: &str) -> Option<&'x js_ast::G::Fn> {
    let symbols = ast.symbols.as_slice();
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            if let S::SFunction(sf) = &stmt.data
                && let Some(n) = &sf.func.name
                && symbols
                    .get(n.ref_.inner_index() as usize)
                    .is_some_and(|s| s.original_name.slice() == name.as_bytes())
            {
                return Some(&sf.func);
            }
        }
    }
    None
}

/// Reads the module-level function `name` (a named export or a component local
/// to the module) into a structural `ComponentIR`; `None` when there is no
/// function declaration of that name.
pub fn analyze_named_component(parsed: &Parsed, name: &str) -> Option<ComponentIR> {
    let path = parsed.path();
    let mut ir = ComponentIR::new(named_component_id(&path, name), path);
    let found = parsed.with_ast(|ast| {
        let func = module_fn(ast, name)?;
        read_function(parsed, ast, func, &mut ir);
        Some(())
    });
    found.map(|_| ir)
}

fn has_default_export(ast: &js_ast::Ast<'_>) -> bool {
    ast.parts.iter().any(|part| {
        part.stmts
            .slice()
            .iter()
            .any(|s| matches!(s.data, S::SExportDefault(_)))
    })
}

/// The template root from the returned value.
fn root_node(e: Expr) -> Node {
    let Expr::Raw(raw) = e else {
        return Node::Slot(e);
    };
    let mut nodes = arm(raw);
    if nodes.len() == 1 {
        nodes.remove(0)
    } else {
        Node::Fragment(nodes)
    }
}

/// One returned / conditional arm as template nodes.
fn arm(raw: RawExpr) -> Vec<Node> {
    match raw.kind {
        RawKind::Jsx(node) => vec![*node],
        RawKind::Lit(Literal::Null | Literal::Undefined | Literal::Bool(_)) => vec![],
        RawKind::Lit(Literal::Str(s)) => vec![Node::Text(s)],
        RawKind::Cond { test, yes, no }
            if matches!(yes.kind, RawKind::Jsx(_)) || matches!(no.kind, RawKind::Jsx(_)) =>
        {
            vec![Node::If {
                cond: Expr::Raw(*test),
                then: arm(*yes),
                else_: arm(*no),
            }]
        }
        RawKind::Binary {
            op: BinOp::And,
            left,
            right,
        } if matches!(right.kind, RawKind::Jsx(_)) => vec![Node::If {
            cond: Expr::Raw(*left),
            then: arm(*right),
            else_: vec![],
        }],
        kind => vec![Node::Slot(Expr::Raw(RawExpr { loc: raw.loc, kind }))],
    }
}

/// Spec §5.2: a single returned element is the mount host; anything else is
/// wrapped in `<brust-host style="display:contents">` with a warning.
fn host_root(node: Node, loc: u32, diagnostics: &mut Vec<Diagnostic>) -> Node {
    if let Node::Element { .. } = node {
        return mark_host(node);
    }
    let children = match node {
        Node::Fragment(children) => children,
        other => vec![other],
    };
    diagnostics.push(Diagnostic::warning(
        "fragment-root",
        "the component does not return a single element; it is wrapped in <brust-host>",
        loc,
        "return one element",
    ));
    Node::Element {
        loc,
        tag: "brust-host".into(),
        attrs: vec![Attr::Static {
            name: "style".into(),
            value: "display:contents".into(),
        }],
        children,
        host: true,
        ref_name: None,
    }
}

/// The value of the first top-level `return` in `func`.
fn first_return(func: &js_ast::G::Fn) -> Option<js_ast::Expr> {
    func.body.stmts.slice().iter().find_map(|s| match &s.data {
        S::SReturn(r) => r.value,
        _ => None,
    })
}

/// Test hook: the first `{expr}` child of the returned JSX element, read as a
/// `RawExpr` with the component's names (state marked).
#[doc(hidden)]
pub fn debug_first_slot(parsed: &Parsed) -> Option<RawExpr> {
    parsed.with_ast(|ast| {
        let func = default_export_fn(ast)?;
        let ret = first_return(func)?;
        let E::ECall(call) = &ret.data else {
            return None;
        };
        let props = call.args.get(1)?;
        let E::EObject(obj) = &props.data else {
            return None;
        };
        let children = obj
            .properties
            .iter()
            .find_map(|p| match p.key.map(|k| k.data) {
                Some(E::EString(s)) if s.slice8() == b"children" => p.value,
                _ => None,
            })?;
        let slot = match &children.data {
            E::EArray(a) => *a.items.iter().find(|x| !matches!(x.data, E::EString(_)))?,
            _ => children,
        };
        let mut names = NameTable::new(ast, func);
        mark_state_bindings(func, &mut names);
        let print = |js: Js<'_>| print_js(parsed, ast, js);
        let mut reader = Reader::new(&mut names, &print);
        Some(reader.expr(&slot))
    })
}

/// Test hook: the template of the returned JSX with the root host rule applied
/// (no fragment wrapping), plus the reader's diagnostics.
#[doc(hidden)]
pub fn debug_template(parsed: &Parsed) -> (Node, Vec<Diagnostic>) {
    parsed.with_ast(|ast| {
        let Some(func) = default_export_fn(ast) else {
            return (Node::Fragment(vec![]), vec![]);
        };
        let mut names = NameTable::new(ast, func);
        mark_state_bindings(func, &mut names);
        let print = |js: Js<'_>| print_js(parsed, ast, js);
        let mut reader = Reader::new(&mut names, &print);
        let node = match first_return(func) {
            Some(ret) => crate::analyze::jsx::read_jsx(&mut reader, &ret),
            None => Node::Fragment(vec![]),
        };
        let node = mark_host(node);
        (node, reader.diagnostics)
    })
}

/// Spec §5.2: a single returned element is the mount host.
fn mark_host(node: Node) -> Node {
    match node {
        Node::Element {
            loc,
            tag,
            attrs,
            children,
            ref_name,
            ..
        } => Node::Element {
            loc,
            tag,
            attrs,
            children,
            host: true,
            ref_name,
        },
        other => other,
    }
}
