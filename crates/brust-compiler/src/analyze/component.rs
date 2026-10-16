//! Ties the readers together into a `ComponentIR`.
use crate::analyze::expr::{Js, Reader, print_js_with};
use crate::analyze::hooks::{Module, mark_state_bindings, read_body};
use crate::analyze::names::Aliases;
use crate::analyze::names::NameTable;
use crate::ir::{
    ArrowBody, Attr, BinOp, ComponentIR, Diagnostic, EffectDecl, Expr, IdentKind, Literal, Node,
    RawExpr, RawKind, RefDecl, component_id, line_col, named_component_id,
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
    analyze_component_in(parsed, None)
}

/// [`analyze_component`] with the options custom hooks imported from other modules
/// resolve through (G3); `None` keeps every imported hook a `hook-unsupported` fallback.
pub fn analyze_component_in(
    parsed: &Parsed,
    opts: Option<&AnalyzeOptions>,
) -> Result<ComponentIR, Diagnostic> {
    let path = parsed.path();
    let mut ir = ComponentIR::new(component_id(&path), path);
    parsed.with_ast(|ast| {
        let Some(func) = default_export_fn(ast) else {
            if let Some(done) = read_cache_export(parsed, ast, opts, &mut ir) {
                return done;
            }
            if let Some(done) = read_memo_export(parsed, ast, opts, &mut ir) {
                return done;
            }
            if let Some(done) = read_forward_ref_export(parsed, ast, opts, &mut ir) {
                return done;
            }
            if has_default_export(ast) {
                ir.diagnostics.push(Diagnostic::fallback(
                    "default-export-shape",
                    if default_export_is_memo(ast) {
                        "memo() wraps something that is not a module function declaration"
                    } else {
                        "the default export is not a function declaration"
                    },
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
        read_function(parsed, ast, opts, func, &mut ir);
        Ok(())
    })?;
    let text = parsed.text();
    for d in &mut ir.diagnostics {
        (d.line, d.col) = line_col(text, d.loc);
    }
    Ok(ir)
}

/// What the build rendered for one lucide icon (L23).
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize)]
pub struct IconMarkup {
    /// The icon with every dynamic prop rendered as a sentinel.
    pub svg: String,
    /// The same icon with the dynamic props absent: what React renders for `undefined` (its defaults
    /// and the enclosing provider's values).
    pub base: String,
}

/// Options for the full analysis (structural read + M1b-2 passes).
#[derive(Debug, Clone, Default)]
pub struct AnalyzeOptions {
    /// Import path prefixes that are server-only (app config `serverOnly`).
    pub server_only: Vec<String>,
    /// Directory module paths are relative to.
    pub root: std::path::PathBuf,
    /// SVG markup the build rendered for `IconRequest.key`s (L23): those icons become inline elements.
    pub icon_svgs: std::collections::HashMap<String, IconMarkup>,
    /// The last compile (icons were rendered): a lucide icon that is still a component is judged
    /// as an island, so a prop it cannot hydrate from is an error again (L23).
    pub icons_final: bool,
    /// Values the build computed for precompute slots, by `BuildEvalSlot.key` (L2): the slot is
    /// replaced by the literal, so its job (and the worker) is not needed for it.
    pub slot_values: std::collections::HashMap<String, serde_json::Value>,
    /// L20: the class map of every `*.module.css` file, keyed by its path relative to `root` (`/`-separated).
    /// `styles.x` from such an import folds to the literal class; empty = nothing folds.
    pub css_modules: std::collections::HashMap<String, std::collections::HashMap<String, String>>,
    /// `tsconfig` `paths` aliases (R34.76): an import that matches one is rewritten to the relative import of the file it
    /// names; empty = every non-relative specifier is a package.
    pub path_aliases: Vec<crate::analyze::aliases::PathAlias>,
    /// F158 (R34.69): the source files (relative to `root`, `/`-separated) whose default export is a route component,
    /// a page or layout, whose props are request data. A component from one of them never receives lowered JSX: its caller
    /// falls back to React (`revive-host-route-root`).
    pub route_roots: std::collections::HashSet<String>,
    /// F153c (R34.61): the package sources the build wrote (`packages/brust/src/build/pkg-src.ts`); empty = a
    /// package import is the React island of its export, as before.
    pub packages: PackageSources,
}

/// Where a bare import resolves to package SOURCE (F153c, R34.61): per importing scope (`""` = the app, else
/// the root-relative directory of a written package), the specifier → the root-relative path of its entry
/// source, or why the build refused it (no source map, integrity, …).
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize)]
pub struct PackageSources {
    #[serde(default)]
    pub scopes: std::collections::HashMap<String, std::collections::HashMap<String, String>>,
    #[serde(default)]
    pub refused: std::collections::HashMap<String, std::collections::HashMap<String, String>>,
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
    use crate::analyze::modules::{Export, Lookup, cache_key, compile, normalize};
    let _aliases = crate::analyze::aliases::Scope::enter(&opts.root, &opts.path_aliases);
    modules
        .borrow_mut()
        .set_root(cache_key(&normalize(path), &Export::Default));
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
    opts: Option<&AnalyzeOptions>,
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
    let is_cache = |names: &NameTable<'_>| {
        matches!(
            names.import_of(callee),
            Some(("brust" | "@brust/core", "cache"))
        )
    };
    match (func, probe) {
        (Some(func), _) => {
            let mut names = NameTable::new(ast, func);
            if !is_cache(&names) {
                return None;
            }
            mark_state_bindings(func, &mut names);
            read_function(parsed, ast, opts, func, ir);
            let print = |js: Js<'_>, a: &Aliases| print_js_with(parsed, ast, a, js);
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
            check_printer_panic(ir);
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

/// F37 (spec §3): `export default memo(Inner)` / `memo(Inner, cmp)` with `memo`
/// imported from `react` and `Inner` a function declared in this module is
/// analysed as `Inner` (the comparator is ignored natively). `None` for any
/// other shape, which keeps the `default-export-shape` fallback.
fn read_memo_export(
    parsed: &Parsed,
    ast: &js_ast::Ast<'_>,
    opts: Option<&AnalyzeOptions>,
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
    let E::EIdentifier(inner) = &call.args.first()?.data else {
        return None;
    };
    let name = ast
        .symbols
        .as_slice()
        .get(inner.ref_.inner_index() as usize)
        .map(|s| String::from_utf8_lossy(s.original_name.slice()).into_owned())?;
    let func = module_fn(ast, &name)?;
    let names = NameTable::new(ast, func);
    if names.import_of(callee) != Some(("react", "memo")) {
        return None;
    }
    read_function(parsed, ast, opts, func, ir);
    Some(Ok(()))
}

/// `export default forwardRef(function (props, ref) {…})` and `export default X` with `X` a module-level
/// `const X = forwardRef(…)` (R34.63); `None` for any other default export.
fn read_forward_ref_export(
    parsed: &Parsed,
    ast: &js_ast::Ast<'_>,
    opts: Option<&AnalyzeOptions>,
    ir: &mut ComponentIR,
) -> Option<Result<(), Diagnostic>> {
    let e = default_export_expr(ast)?;
    let m = crate::analyze::stores::Module::new(ast);
    let func = match &e.data {
        E::EIdentifier(id) => forward_ref_fn(ast, &m.name(id.ref_)),
        E::EImportIdentifier(id) => forward_ref_fn(ast, &m.name(id.ref_)),
        _ => forward_ref_callback(&m, e),
    }?;
    read_function_as(parsed, ast, opts, &func, true, ir);
    Some(Ok(()))
}

/// `export default memo(…)` (by the callee's name, for the diagnostic wording only).
fn default_export_is_memo(ast: &js_ast::Ast<'_>) -> bool {
    let Some(e) = default_export_expr(ast) else {
        return false;
    };
    let E::ECall(call) = &e.data else {
        return false;
    };
    let (E::EImportIdentifier(js_ast::E::ImportIdentifier { ref_ })
    | E::EIdentifier(js_ast::E::Identifier { ref_ })) = &call.target.data
    else {
        return false;
    };
    ast.symbols
        .as_slice()
        .get(ref_.inner_index() as usize)
        .is_some_and(|s| s.original_name.slice() == b"memo")
}

/// Reads one component function into `ir` (structural).
fn read_function(
    parsed: &Parsed,
    ast: &js_ast::Ast<'_>,
    opts: Option<&AnalyzeOptions>,
    func: &js_ast::G::Fn,
    ir: &mut ComponentIR,
) {
    read_function_as(parsed, ast, opts, func, false, ir)
}

/// [`read_function`]; `forwards_ref`: the function is the argument of `forwardRef(…)`, so its second parameter is
/// the forwarded ref (R34.63).
fn read_function_as(
    parsed: &Parsed,
    ast: &js_ast::Ast<'_>,
    opts: Option<&AnalyzeOptions>,
    func: &js_ast::G::Fn,
    forwards_ref: bool,
    ir: &mut ComponentIR,
) {
    crate::analyze::expr::take_printer_panic(); // a flag left by an earlier component is not ours
    let mut names = NameTable::new(ast, func);
    names.tag_contexts(&ir.source);
    if forwards_ref {
        ir.forwards_ref = true;
        if let Some(a) = func.args.slice().get(1) {
            match a.binding.data {
                js_ast::b::B::BIdentifier(id) => names.set_forwarded_ref(id.r#ref),
                _ => ir.diagnostics.push(Diagnostic::fallback(
                    "forwardref-ref",
                    "the forwarded ref is destructured; brust reads it only as a plain `ref` parameter",
                    func.open_parens_loc.start.max(0) as u32,
                    "name the second parameter `ref`",
                )),
            }
        }
    }
    mark_state_bindings(func, &mut names);
    let print = |js: Js<'_>, a: &Aliases| print_js_with(parsed, ast, a, js);
    let mut reader = Reader::new(&mut names, &print);
    // F41 (§8.1): a leftover `'use client'` directive means nothing in brust.
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            if let S::SDirective(d) = &stmt.data
                && d.value.slice() == b"use client"
            {
                ir.diagnostics.push(Diagnostic::warning(
                    "use-client-leftover",
                    "'use client' has no effect: brust decides what runs on the client",
                    stmt.loc.start.max(0) as u32,
                    "remove the directive",
                ));
            }
        }
    }
    // F38: any dynamic `import()` in the module (`lazy(() => import(…))`) makes
    // the component a React island.
    let mut w = crate::analyze::expr::Walk::default();
    for part in ast.parts.iter() {
        w.stmts(part.stmts.slice());
    }
    w.stmts(func.body.stmts.slice());
    if let Some(loc) = w.dynamic_import {
        ir.diagnostics.push(Diagnostic::fallback(
            "dynamic-import",
            "dynamic import() is not supported natively; the component renders as a React island",
            loc,
            "import the module statically or keep the lazy component in a React-tier parent",
        ));
    }
    // R34.67 (G2): a hand-written call to the JSX runtime builds an element the reader cannot see
    // through; read as an expression it would print an element object. Fail closed.
    if let Some(loc) = crate::analyze::jsx::jsx_runtime_call(&w.calls, &w.used_at, reader.names) {
        ir.diagnostics.push(Diagnostic::fallback(
            "jsx-runtime-call",
            "a hand-written call to React's JSX runtime (`jsx(…)`) is not read as an element; the component renders as a React island",
            loc,
            "write JSX, or keep the module in a React-tier component",
        ));
    }
    reader.names.add_cond_consts(func.body.stmts.slice());
    let body = read_body(
        func,
        &mut reader,
        Module {
            parsed,
            ast,
            opts,
            foreign: false,
        },
    );
    // R34.64: the forwarded ref is only ever `ref={ref}` on a host element (dropped: HTML has no ref); any other
    // read (`ref.current`, passed on, `useImperativeHandle`) needs React.
    let mut body_walk = crate::analyze::expr::Walk::default();
    body_walk.stmts(func.body.stmts.slice());
    if reader.names.forwarded_ref_escapes(&body_walk.used_at) > 0 {
        ir.diagnostics.push(Diagnostic::fallback(
            "forwardref-ref",
            "the forwarded ref is read other than as `ref={ref}` on an element; the component renders as a React island",
            func.open_parens_loc.start.max(0) as u32,
            "pass the ref to an element, or keep the component in React",
        ));
    }
    (ir.module_scope, ir.module_decls) = reader.module_scope(ast);
    ir.bound_names = reader
        .names
        .spellings()
        .chain(reader.names.print_aliases().values().cloned())
        .collect();
    ir.plain_fns = crate::analyze::plain_fn::plain_fns(ast, &*reader.names);
    // F215 allowlist: a module `const` is accepted when the folder folds it or `plain_fn` proves it plain.
    let folded = {
        let path = parsed.path();
        let nested = |src: &str, imp: &str| {
            opts.and_then(|o| crate::analyze::const_fold::imported_const(&path, src, imp, o, 0))
        };
        let none = |_: &str| false;
        crate::analyze::const_fold::Folder::new(&ir.module_decls, &none, &nested).all()
    };
    let evaluated = crate::analyze::module_effects::fold_env_accepts(&ir.module_decls);
    ir.module_effect =
        crate::analyze::module_effects::module_effect(ast, &*reader.names, parsed.text(), &|n| {
            folded.contains_key(n) || evaluated.contains(n) || ir.plain_fns.iter().any(|p| p == n)
        });
    let from = parsed.path();
    // React's element builders (and the namespace or default import that carries them), or an app module that may
    // hold an element; `cache`, the hooks and other React exports return no element.
    const BUILDERS: &[&str] = &[
        "createElement",
        "cloneElement",
        "jsx",
        "jsxs",
        "jsxDEV",
        "Children",
        "createPortal",
        "h",
        "*",
        "default",
    ];
    let element_import = |source: &str, imported: &str| {
        ((source == "react"
            || source.starts_with("react/")
            || source.starts_with("react-dom")
            || source.starts_with("preact"))
            && BUILDERS.contains(&imported))
            || opts.is_none_or(|o| {
                crate::analyze::plain_fn::module_may_hold_element(&from, source, o, 0)
            })
    };
    ir.element_free_fns =
        crate::analyze::plain_fn::element_free_fns(ast, &*reader.names, &element_import);
    check_printer_panic(ir);
    ir.props = body.props;
    ir.props_rest = body.props_rest;
    ir.props_whole = body.props_whole;
    ir.poly = body.poly;
    // S2: the context fields this component reads are hidden props the call site fills from the Provider frame.
    ir.ctx_uses = reader.names.ctx_uses();
    ir.ctx_pkg =
        !ir.ctx_uses.is_empty() && ir.source.starts_with(crate::analyze::modules::PKG_SRC_DIR);
    ir.provides = std::mem::take(&mut reader.provides);
    for u in &ir.ctx_uses {
        for f in &u.fields {
            let name = crate::ir::ctx_prop(&u.context, f);
            if !ir.props.iter().any(|p| p.name == name) {
                ir.props.push(crate::ir::PropDecl {
                    name: name.clone(),
                    local: name,
                    ts_type: None,
                    default: None,
                });
            }
        }
    }
    if let Some(loc) = reader.names.ctx_escape.get() {
        ir.diagnostics.push(Diagnostic::fallback(
            "context-escape",
            "a context value is used as a whole, or inside code brust prints as written (an effect, a handler), not as `context.field` in the render; brust reads the fields one by one",
            loc,
            "read context.field into a const in the render, or keep this component in React",
        ));
    }
    if let Some((loc, name, code, what)) = reader.names.prop_read_problem.borrow().clone() {
        ir.diagnostics.push(Diagnostic::fallback(
            code,
            format!("the props key `{name}` {what}"),
            loc,
            "rename the prop at the call sites, or keep this component in React",
        ));
    }
    if let Some(loc) = reader.names.use_before_pattern.get() {
        ir.diagnostics.push(Diagnostic::fallback(
            "prop-pattern-tdz",
            "a name of a `const { … } = props` pattern is used before the pattern statement (React throws: the binding is not initialised yet)",
            loc,
            "move the pattern above its first use",
        ));
    }
    if let Some(loc) = reader.names.snapshot_escape.get() {
        // B4: a never-written ref read in the render is a state cell; code printed as written would read `.current`
        // off its value, so it keeps the fallback it had.
        ir.diagnostics.push(Diagnostic::fallback(
            "ref-in-render",
            "a ref read during render is also read by code printed as written",
            loc,
            "read the ref in an effect or an event handler",
        ));
    }
    if let Some(loc) = reader.names.rest_escape.get() {
        // R34.14 fail closed: brust reads `rest.k` and spreads `{...rest}`; any other read of the
        // rest object (a value, or code printed as written) would see the named keys too.
        ir.diagnostics.push(Diagnostic::fallback(
            "prop-pattern",
            "the props `...rest` object is read as a value; brust reads `rest.key` and `{...rest}` in JSX",
            loc,
            "read rest.key, or spread {...rest} onto an element",
        ));
    }
    ir.state = body.state;
    ir.derived = body.derived;
    ir.effects = body.effects;
    ir.handlers = body.handlers;
    ir.refs = body.refs;
    ir.use_id_slots = body.id_bindings.len();
    ir.id_bindings = body.id_bindings;
    ir.stores = body.stores;
    ir.diagnostics.extend(body.diagnostics);
    // S2: a Provider whose values cannot be expressed at the call site (state, a handler, a loop value) is a React
    // island of its own. A call site that can specialise it (R34.122) builds a clone of its pre-pass IR with this
    // diagnostic removed and never reaches the island; every other call site keeps the island, as before.
    if let Some((loc, why)) = crate::analyze::context::provider_problem(ir) {
        ir.diagnostics.push(Diagnostic::fallback(
            "context-state",
            format!("a context Provider hands out {why}, which needs a native provider; the component renders with React"),
            loc,
            "provide props-derived values, or keep this component in React",
        ));
    }
    let root_loc = match &body.return_expr {
        Some(Expr::Raw(r)) => r.loc,
        _ => 0,
    };
    let root = body
        .return_expr
        .map(root_node)
        .unwrap_or(Node::Fragment(vec![]));
    ir.template = host_root(root, root_loc);
    callback_refs(ir);
    ir.uses_outlet = has_outlet(&ir.template);
    check_printer_panic(ir);
}

/// B1: `ref={x}` where `x` is a function value or a ref object the component computes (a `useCallback`, a derived
/// value, a state setter) and not a `useRef` binding (a ref handed in as a prop cannot cross from a native caller, so
/// it stays a `ref-shape` fallback). React calls a function ref with the node at mount (and
/// its returned cleanup, or `null`, at unmount) and sets `.current` on an object ref. Each such attribute is
/// desugared to a synthetic `useRef` bound on the element plus a mount effect that does `setRef(x, node)`, which is
/// what `composeRefs` itself does. A ref on an element inside a list, a conditional branch or a component's children (which
/// may mount later or never) stays a `ref-shape` fallback. The mount effects go FIRST in `ir.effects`: React attaches
/// refs before it runs any effect of the owner.
fn callback_refs(ir: &mut ComponentIR) {
    let callable: Vec<(String, IdentKind)> = ir
        .derived
        .iter()
        .map(|d| (d.name.clone(), IdentKind::Local))
        .chain(
            ir.handlers
                .iter()
                .map(|h| (h.name.clone(), IdentKind::Local)),
        )
        .chain(
            ir.state
                .iter()
                .filter_map(|s| s.setter.clone().map(|n| (n, IdentKind::Setter))),
        )
        .collect();
    let mut taken: std::collections::HashSet<String> =
        ir.refs.iter().map(|r| r.name.clone()).collect();
    taken.extend(callable.iter().map(|(n, _)| n.clone()));
    let mut made: Vec<(String, String, IdentKind, u32)> = Vec::new();
    fn walk(
        n: &mut Node,
        refs: &std::collections::HashSet<String>,
        callable: &[(String, IdentKind)],
        taken: &mut std::collections::HashSet<String>,
        made: &mut Vec<(String, String, IdentKind, u32)>,
        in_list: bool,
    ) {
        match n {
            Node::Element {
                loc,
                attrs,
                children,
                ..
            } => {
                for a in attrs.iter_mut() {
                    let Attr::Ref { name } = a else { continue };
                    if in_list || refs.contains(name) {
                        continue;
                    }
                    let Some((_, kind)) = callable.iter().find(|(c, _)| c == name) else {
                        continue;
                    };
                    let mut k = made.len() + 1;
                    let rf = loop {
                        let rf = format!("_rf{k}");
                        if taken.insert(rf.clone()) {
                            break rf;
                        }
                        k += 1;
                    };
                    made.push((rf.clone(), name.clone(), kind.clone(), *loc));
                    *name = rf;
                }
                children
                    .iter_mut()
                    .for_each(|c| walk(c, refs, callable, taken, made, in_list));
            }
            // A branch or a component's children may mount later or not at all; the mount effect cannot follow that.
            Node::If { then, else_, .. } => then
                .iter_mut()
                .chain(else_.iter_mut())
                .for_each(|c| walk(c, refs, callable, taken, made, true)),
            Node::For { body, .. } => body
                .iter_mut()
                .for_each(|c| walk(c, refs, callable, taken, made, true)),
            Node::Component { children, .. } => children
                .iter_mut()
                .for_each(|c| walk(c, refs, callable, taken, made, true)),
            Node::Fragment(children) => children
                .iter_mut()
                .for_each(|c| walk(c, refs, callable, taken, made, in_list)),
            Node::Text(_) | Node::Slot(_) | Node::Outlet => {}
        }
    }
    let refs: std::collections::HashSet<String> = ir.refs.iter().map(|r| r.name.clone()).collect();
    let mut template = std::mem::replace(&mut ir.template, Node::Fragment(vec![]));
    walk(
        &mut template,
        &refs,
        &callable,
        &mut taken,
        &mut made,
        false,
    );
    ir.template = template;
    for (at, (rf, x, kind, loc)) in made.into_iter().enumerate() {
        // Locals of the effect that neither shadow `x` nor the ref.
        let local = |base: &str| {
            let mut n = base.to_string();
            while n == x || n == rf {
                n.push('_');
            }
            n
        };
        let (node, r, c, cleanup) = (
            local("__node"),
            local("__r"),
            local("__c"),
            local("__cleanup"),
        );
        let source = format!(
            "() => {{ const {node} = {rf}.current; const {r} = {x}; let {cleanup}; if (typeof {r} === \"function\") {{ const {c} = {r}({node}); {cleanup} = typeof {c} === \"function\" ? {c} : () => {r}(null) }} else if ({r} !== null && {r} !== undefined) {{ {r}.current = {node}; {cleanup} = () => {{ {r}.current = null }} }} return {cleanup} }}"
        );
        ir.refs.push(RefDecl {
            name: rf.clone(),
            init: Expr::Raw(RawExpr {
                loc,
                kind: RawKind::Lit(Literal::Null),
            }),
        });
        ir.effects.insert(
            at,
            EffectDecl {
                body: RawExpr {
                    loc,
                    kind: RawKind::Arrow {
                        params: Vec::new(),
                        body: ArrowBody::Block {
                            source,
                            captures_only: false,
                        },
                        captures: vec![(x.clone(), kind.clone()), (rf.clone(), IdentKind::Local)],
                    },
                },
                deps: Some(vec![RawExpr {
                    loc,
                    kind: RawKind::Ident { name: x, kind },
                }]),
                layout: true,
            },
        );
    }
}

/// F42 backstop: raise `printer-panic` when `print_js` caught a printer panic since the last check.
fn check_printer_panic(ir: &mut ComponentIR) {
    if crate::analyze::expr::take_printer_panic() {
        ir.diagnostics.push(Diagnostic::fallback(
            "printer-panic",
            format!(
                "the JavaScript printer failed on code in component {}; it renders as a React island",
                ir.id
            ),
            0,
            "report this compiler bug; simplify the component meanwhile",
        ));
    }
}

fn has_outlet(n: &Node) -> bool {
    match n {
        Node::Outlet => true,
        Node::Element { children, .. }
        | Node::Component { children, .. }
        | Node::Fragment(children) => children.iter().any(has_outlet),
        Node::If { then, else_, .. } => then.iter().chain(else_).any(has_outlet),
        Node::For { body, .. } => body.iter().any(has_outlet),
        Node::Text(_) | Node::Slot(_) => false,
    }
}

/// The module-level `function <name>` (exported or not).
pub(crate) fn module_fn<'x>(ast: &'x js_ast::Ast<'_>, name: &str) -> Option<&'x js_ast::G::Fn> {
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

/// A component function of a module: a function declaration (borrowed) or the callback of a module-level
/// `const X = forwardRef(…)` (an owned view of it: same params and body).
pub(crate) enum FoundFn<'x> {
    Decl(&'x js_ast::G::Fn),
    ForwardRef(js_ast::G::Fn),
}

impl FoundFn<'_> {
    pub(crate) fn func(&self) -> &js_ast::G::Fn {
        match self {
            FoundFn::Decl(f) => f,
            FoundFn::ForwardRef(f) => f,
        }
    }
    pub(crate) fn forwards_ref(&self) -> bool {
        matches!(self, FoundFn::ForwardRef(_))
    }
}

/// `module_fn`, or the callback of a module-level `const name = forwardRef(function (props, ref) {…})` /
/// `React.forwardRef(…)` with `forwardRef` imported from `react`; the callback may be an arrow function.
pub(crate) fn module_component<'x>(ast: &'x js_ast::Ast<'_>, name: &str) -> Option<FoundFn<'x>> {
    module_fn(ast, name)
        .map(FoundFn::Decl)
        .or_else(|| forward_ref_fn(ast, name).map(FoundFn::ForwardRef))
}

/// The function a call `forwardRef(fn)` wraps, when `e` is such a call (`forwardRef` / `React.forwardRef` from react).
pub(crate) fn forward_ref_callback(
    m: &crate::analyze::stores::Module<'_>,
    e: &js_ast::Expr,
) -> Option<js_ast::G::Fn> {
    let E::ECall(call) = &e.data else { return None };
    let ident = |x: &js_ast::Expr| match &x.data {
        E::EIdentifier(id) => Some(id.ref_),
        E::EImportIdentifier(id) => Some(id.ref_),
        _ => None,
    };
    let is_fwd = match &call.target.data {
        E::EDot(d) => {
            d.optional_chain.is_none()
                && d.name.slice() == b"forwardRef"
                && ident(&d.target)
                    .and_then(|r| m.import_of(r))
                    .is_some_and(|(s, i)| s == "react" && (i == "*" || i == "default"))
        }
        _ => ident(&call.target).and_then(|r| m.import_of(r)) == Some(("react", "forwardRef")),
    };
    if !is_fwd || call.args.len() != 1 {
        return None;
    }
    match &call.args[0].data {
        E::EFunction(f) => Some(js_ast::G::Fn {
            args: f.func.args,
            body: js_ast::G::FnBody {
                loc: f.func.body.loc,
                stmts: f.func.body.stmts,
            },
            open_parens_loc: f.func.open_parens_loc,
            ..Default::default()
        }),
        E::EArrow(a) if !a.is_async => Some(js_ast::G::Fn {
            args: a.args,
            body: js_ast::G::FnBody {
                loc: a.body.loc,
                stmts: a.body.stmts,
            },
            ..Default::default()
        }),
        _ => None,
    }
}

fn forward_ref_fn(ast: &js_ast::Ast<'_>, name: &str) -> Option<js_ast::G::Fn> {
    let m = crate::analyze::stores::Module::new(ast);
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            let S::SLocal(l) = &stmt.data else { continue };
            if !matches!(l.kind, js_ast::S::Kind::KConst) {
                continue;
            }
            for d in l.decls.iter() {
                if let (js_ast::b::B::BIdentifier(id), Some(v)) = (d.binding.data, d.value)
                    && m.name(id.r#ref) == name
                {
                    return forward_ref_callback(&m, &v);
                }
            }
        }
    }
    None
}

/// Reads the module-level function `name` (a named export or a component local
/// to the module) into a structural `ComponentIR`; `None` when there is no
/// function declaration of that name.
pub fn analyze_named_component(parsed: &Parsed, name: &str) -> Option<ComponentIR> {
    analyze_named_component_in(parsed, name, None)
}

/// [`analyze_named_component`] with the options imported custom hooks resolve through (G3).
pub fn analyze_named_component_in(
    parsed: &Parsed,
    name: &str,
    opts: Option<&AnalyzeOptions>,
) -> Option<ComponentIR> {
    let path = parsed.path();
    let mut ir = ComponentIR::new(named_component_id(&path, name), path);
    let found = parsed.with_ast(|ast| {
        let found = module_component(ast, name)?;
        read_function_as(
            parsed,
            ast,
            opts,
            found.func(),
            found.forwards_ref(),
            &mut ir,
        );
        ir.unexported = matches!(
            crate::analyze::exports::find(ast, name),
            crate::analyze::exports::Binding::Local(_)
        );
        Some(())
    });
    ir.export = Some(name.to_string());
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
                and: false,
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
            and: true,
        }],
        kind => vec![Node::Slot(Expr::Raw(RawExpr { loc: raw.loc, kind }))],
    }
}

/// Spec §5.2: a single returned element is the mount host; anything else is
/// wrapped in a synthetic `<brust-host style="display:contents">`; lowering keeps it only for an
/// interactive component (and warns there).
fn host_root(node: Node, loc: u32) -> Node {
    if let Node::Element { .. } = node {
        return mark_host(node);
    }
    let children = match node {
        Node::Fragment(children) => children,
        other => vec![other],
    };
    // The wrapper is synthetic: lowering drops it for a static component and warns when an interactive
    // one keeps it (the tier is not known here).
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
        synthetic: true,
        poly: false,
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
        let print = |js: Js<'_>, a: &Aliases| print_js_with(parsed, ast, a, js);
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
        let print = |js: Js<'_>, a: &Aliases| print_js_with(parsed, ast, a, js);
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
            synthetic,
            poly,
            ..
        } => Node::Element {
            loc,
            tag,
            attrs,
            children,
            host: true,
            ref_name,
            synthetic,
            poly,
        },
        other => other,
    }
}
