use std::cell::RefCell;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::rc::Rc;

use swc_core::common::{Span, Spanned};
use swc_core::ecma::ast::{
    ArrayLit, ArrowExpr, AssignPatProp, BinaryOp, BindingIdent, BlockStmt, BlockStmtOrExpr,
    CallExpr, Callee, DefaultDecl, ExportDefaultDecl, Expr as SwcExpr, ExprOrSpread, FnExpr,
    Function, JSXAttrName, JSXAttrOrSpread, JSXAttrValue, JSXElement, JSXElementChild,
    JSXElementName, JSXExpr, JSXFragment, Lit, MemberExpr, MemberProp, Module, ModuleDecl,
    ModuleItem, ObjectLit, ObjectPatProp, ParenExpr, Pat, Prop, PropName, PropOrSpread, ReturnStmt,
    Stmt, UnaryOp,
};

use crate::ErrorKind;
use crate::ir::*;
use crate::parser::ParsedSource;

/// Context carried when lowering a component in inline mode (T5 opt-in).
/// `subst` maps destructured prop names to the call-site `Expr` that replaces
/// them. Whether `{children}` emits `ChildrenSlot` is determined by checking
/// if `"children"` is in the component's destructured params — not stored here.
#[derive(Debug)]
struct InlineCtx {
    subst: HashMap<String, crate::ir::Expr>,
}

/// Shared environment threaded through the entire native-inline recursion.
/// Lives for the duration of one `lower_with_sources` call. SEPARATE from
/// `InlineCtx.subst` (which is per-component); this env is global across the
/// whole recursive inlining pass.
#[derive(Debug)]
pub(crate) struct InlineEnv {
    /// Map from component ident → source text, used to resolve `<Comp native/>`.
    sources: HashMap<String, String>,
    /// Accumulated non-fatal diagnostic messages.
    warnings: RefCell<Vec<String>>,
    /// Stack of component idents currently being inlined; used for cycle detection.
    cycle: RefCell<Vec<String>>,
}

/// Compile-time lucide-icon registry (native static-SVG feature). Built from the
/// `lucide_icons` map passed to `lower_with_sources` and stored on the route
/// `Scope`. `build_lucide_svg` reads `icons` to inline `<Search/>`-style lucide
/// tags as static SVG (static-prop cases; dynamic/spread defer to the SSR path).
#[derive(Debug)]
pub(crate) struct LucideEnv {
    /// Local tag name (e.g. `"Search"`) → parsed icon.
    icons: HashMap<String, LucideIcon>,
    /// Non-fatal diagnostics from icon-JSON parsing (merged into compile warnings).
    warnings: RefCell<Vec<String>>,
}

/// One parsed lucide icon: its class string plus its SVG child nodes.
#[derive(Debug, Clone)]
pub(crate) struct LucideIcon {
    /// e.g. `"lucide lucide-search"`.
    cls: String,
    /// `[(tag, [(attr, val)…])…]` — the inner SVG element children.
    node: Vec<(String, Vec<(String, String)>)>,
}

impl LucideIcon {
    /// Parse one lucide icon JSON value:
    /// `{"cls":"lucide lucide-search","node":[["path",[["d","m21…"]]],…]}`.
    /// `serde_json::from_str` into the nested tuple `Vec<(String, Vec<(String,
    /// String)>)>` works directly (JSON arrays → tuples positionally), so no
    /// manual `Value` walk is needed.
    fn parse(json: &str) -> Result<LucideIcon, serde_json::Error> {
        let v: serde_json::Value = serde_json::from_str(json)?;
        let cls: String = serde_json::from_value(v.get("cls").cloned().unwrap_or_default())?;
        let node: Vec<(String, Vec<(String, String)>)> =
            serde_json::from_value(v.get("node").cloned().unwrap_or_default())?;
        Ok(LucideIcon { cls, node })
    }
}

#[derive(Debug)]
pub struct LowerError {
    pub span: Span,
    pub kind: ErrorKind,
}

impl LowerError {
    fn at(span: Span, kind: ErrorKind) -> Self {
        Self { span, kind }
    }
}

/// Names in scope while lowering a JSX subtree.
///
/// `destructured` holds top-level prop names from `function X({ a, b })`.
/// `named_param` holds the single binding from `function X(props)` (bare-ident
/// reference of `props` itself is rejected; `props.x` is accepted in T5+).
/// `map_bindings` is a stack — pushed before lowering a `.map((item) => …)`
/// body and popped after. T5 uses clone-and-extend (clone the scope, push the
/// new iter binding, recurse) rather than `&mut Scope` to keep all the
/// existing `&Scope` signatures additive.
/// `inline` carries the optional inline-mode context (T5 opt-in). When `None`,
/// all inline behaviors are disabled and the code paths are byte-identical to
/// pre-T5 behavior.
/// `inline_env` is the shared native-inline environment (T6 opt-in). SEPARATE
/// from `inline` — the env is shared across the whole recursion while `inline`
/// changes per component.
#[derive(Debug, Default, Clone)]
struct Scope {
    destructured: Vec<String>,
    named_param: Option<String>,
    map_bindings: Vec<String>,
    /// Inline mode context. `None` = normal (default) lowering.
    inline: Option<Rc<InlineCtx>>,
    /// Shared native-inline environment. `None` = no native inlining (default).
    inline_env: Option<Rc<InlineEnv>>,
    /// Compile-time lucide-icon registry (native static-SVG). `None` = no lucide
    /// icons supplied (default). Constructed in `lower_with_sources`; read by
    /// `build_lucide_svg` (threaded through the inline recursion).
    lucide_env: Option<Rc<LucideEnv>>,
}

/// Lowered param shape: which names are in scope inside JSX.
#[derive(Debug, Default)]
struct ParamShape {
    /// Destructured top-level bindings, if any.
    destructured: Vec<String>,
    /// Single named binding (`function X(props)`), if any.
    named: Option<String>,
}

#[allow(dead_code)] // used in crate tests; live code now goes through lower_with_sources
pub fn lower(parsed: &ParsedSource) -> Result<Component, LowerError> {
    let (name, function) = find_default_export(&parsed.module)?;
    let body =
        function.function.body.as_ref().ok_or_else(|| {
            LowerError::at(function.function.span, ErrorKind::BodyMustBeSingleReturn)
        })?;
    let param_shape = lower_params(&function.function)?;
    let scope = Scope {
        destructured: param_shape.destructured.clone(),
        named_param: param_shape.named.clone(),
        map_bindings: Vec::new(),
        inline: None,
        inline_env: None,
        lucide_env: None,
    };

    let return_expr = single_return_expr(body)?;
    let jsx = strip_paren(return_expr);
    // `SwcExpr::JSXElement` wraps `Box<JSXElement>` in swc_ecma_ast 25; the `&Box<JSXElement>`
    // binding here coerces to `&JSXElement` at the call site below.
    // `<BrustPage>` is the built-in document shell — recognized ONLY at the
    // route root, here, before `lower_element`. `lower_element` itself rejects a
    // nested `<BrustPage>` with `BrustPageMustBeRoot`, so the shell can never be
    // emitted inside the body. Top-level JSX is not under any `.map(...)` —
    // `in_map` starts false and is only forced true when `lower_call_as_map`
    // recurses into a Map body.
    let root = match jsx {
        SwcExpr::JSXElement(element) => {
            if let JSXElementName::Ident(ident) = &element.opening.name
                && ident.sym.as_ref() == "BrustPage"
            {
                lower_brust_page(element, &scope)?
            } else {
                lower_element(element, &scope, false)?
            }
        }
        SwcExpr::JSXFragment(f) => lower_fragment(f, &scope, false)?,
        _ => {
            return Err(LowerError::at(
                jsx.span(),
                ErrorKind::BodyMustBeSingleReturn,
            ));
        }
    };

    let mut props = PropsShape {
        bindings: param_shape.destructured.clone(),
        types: BTreeMap::new(),
    };
    infer_props_types(&root, &mut props)?;

    Ok(Component { name, props, root })
}

/// Route-level entry point for native-inline lowering (T6).
///
/// Like `lower` but builds an `InlineEnv` from `sources` (a map from component
/// ident → source text). Warnings accumulated during inlining are returned
/// alongside the component. Existing `lower(parsed)` is unchanged.
// Called by `compile_full` (T7).
pub(crate) fn lower_with_sources(
    parsed: &ParsedSource,
    sources: HashMap<String, String>,
    lucide_icons: HashMap<String, String>,
) -> Result<(Component, Vec<String>), LowerError> {
    let (name, function) = find_default_export(&parsed.module)?;
    let body =
        function.function.body.as_ref().ok_or_else(|| {
            LowerError::at(function.function.span, ErrorKind::BodyMustBeSingleReturn)
        })?;
    let param_shape = lower_params(&function.function)?;

    let env = Rc::new(InlineEnv {
        sources,
        warnings: RefCell::new(Vec::new()),
        cycle: RefCell::new(Vec::new()),
    });

    // Build the lucide-icon registry. Each value is the icon JSON; a parse
    // failure for one entry SKIPS it and records a warning (never fails the
    // compile). The `None`/empty path stays byte-identical to before.
    let lucide_env = {
        let mut icons = HashMap::new();
        let warnings = RefCell::new(Vec::new());
        for (local, json) in &lucide_icons {
            match LucideIcon::parse(json) {
                Ok(icon) => {
                    icons.insert(local.clone(), icon);
                }
                Err(e) => {
                    warnings
                        .borrow_mut()
                        .push(format!("lucide icon `{local}`: invalid icon JSON ({e})"));
                }
            }
        }
        Rc::new(LucideEnv { icons, warnings })
    };

    let scope = Scope {
        destructured: param_shape.destructured.clone(),
        named_param: param_shape.named.clone(),
        map_bindings: Vec::new(),
        inline: None,
        inline_env: Some(env.clone()),
        lucide_env: Some(lucide_env.clone()),
    };

    let return_expr = single_return_expr(body)?;
    let jsx = strip_paren(return_expr);
    let root = match jsx {
        SwcExpr::JSXElement(element) => {
            if let JSXElementName::Ident(ident) = &element.opening.name {
                let s = ident.sym.as_ref();
                if s == "BrustPage" {
                    lower_brust_page(element, &scope)?
                } else if s == "Island" {
                    lower_element(element, &scope, false)?
                } else if s.starts_with(|c: char| c.is_ascii_uppercase())
                    && has_native_attr(element)
                {
                    // Document-root inline: a custom `native` component at the
                    // route root may itself return `<BrustPage>`. Pass
                    // `doc_root = true` so a nested `<BrustPage>` in its body is
                    // promoted to the document shell instead of being rejected.
                    lower_ssr_component(element, s, &scope, false, true)?
                } else {
                    lower_element(element, &scope, false)?
                }
            } else {
                lower_element(element, &scope, false)?
            }
        }
        SwcExpr::JSXFragment(f) => lower_fragment(f, &scope, false)?,
        _ => {
            return Err(LowerError::at(
                jsx.span(),
                ErrorKind::BodyMustBeSingleReturn,
            ));
        }
    };

    let mut props = PropsShape {
        bindings: param_shape.destructured.clone(),
        types: BTreeMap::new(),
    };
    infer_props_types(&root, &mut props)?;

    let mut warnings = env.warnings.borrow().clone();
    warnings.extend(lucide_env.warnings.borrow().iter().cloned());
    Ok((Component { name, props, root }, warnings))
}

/// Does this element carry a (bare or valued) `native` attribute? Shared by the
/// route-root dispatch in `lower_with_sources` (to route a custom `native`
/// component through `lower_ssr_component` with `doc_root = true`) and by
/// `lower_ssr_component`'s own native-branch detection.
fn has_native_attr(el: &JSXElement) -> bool {
    el.opening.attrs.iter().any(|a| {
        if let JSXAttrOrSpread::JSXAttr(jsx_attr) = a
            && let JSXAttrName::Ident(id) = &jsx_attr.name
        {
            return id.sym.as_ref() == "native";
        }
        false
    })
}

/// Crate-internal entry point for inline lowering (T5 opt-in).
///
/// Lowers a component's JSX body with `subst` substituted for its prop names.
/// Whether `{children}` emits `ChildrenSlot` is determined by checking if
/// `"children"` is in the component's destructured params (not via the
/// `_has_children` argument, which is kept for API stability).
/// The normal `lower` entry point is unaffected — this is purely additive.
/// `env` is the shared native-inline environment threaded through T6 recursion;
/// pass `None` for pure T5 usage.
///
/// Accepted body shapes:
/// - Single `return <JSX>;` (or expr-bodied) → `vec![node]`.
/// - `if (cond) return <A>; … return <B>;` → `vec![Cond{…}]`.
/// - `const x = …; return <JSX>` or other local bindings → `Err(InlineUntranslatable)`.
pub(crate) fn lower_component_inline(
    parsed: &ParsedSource,
    subst: HashMap<String, crate::ir::Expr>,
    _has_children: bool,
    env: Option<Rc<InlineEnv>>,
    lucide: Option<Rc<LucideEnv>>,
    doc_root: bool,
) -> Result<Vec<JsxNode>, LowerError> {
    let (_, fn_expr) = find_default_export(&parsed.module)?;
    let body =
        fn_expr.function.body.as_ref().ok_or_else(|| {
            LowerError::at(fn_expr.function.span, ErrorKind::BodyMustBeSingleReturn)
        })?;

    let param_shape = lower_params(&fn_expr.function)?;

    let inline_ctx = Rc::new(InlineCtx { subst });
    let scope = Scope {
        destructured: param_shape.destructured.clone(),
        named_param: param_shape.named.clone(),
        map_bindings: Vec::new(),
        inline: Some(inline_ctx),
        inline_env: env,
        // Threaded from the parent (route or enclosing inline) scope so lucide
        // static-SVG inlining fires for `<Search/>` nested inside a native-inlined
        // component body (the real pokedex usage). `None` when no registry.
        lucide_env: lucide,
    };

    // Try single-return first.
    if let Ok(return_expr) = single_return_expr(body) {
        let jsx = strip_paren(return_expr);
        match jsx {
            SwcExpr::JSXElement(el) => {
                // Document-root promotion: when this inlined component is the
                // route root AND its single-return root is `<BrustPage>`, emit the
                // document shell here instead of rejecting it as nested.
                if doc_root
                    && let JSXElementName::Ident(ident) = &el.opening.name
                    && ident.sym.as_ref() == "BrustPage"
                {
                    return Ok(vec![lower_brust_page(el, &scope)?]);
                }
                let node = lower_element(el, &scope, false)?;
                return Ok(vec![node]);
            }
            SwcExpr::JSXFragment(f) => return Ok(vec![lower_fragment(f, &scope, false)?]),
            _ => {
                return Err(LowerError::at(
                    jsx.span(),
                    ErrorKind::BodyMustBeSingleReturn,
                ));
            }
        }
    }

    // Try `if (cond) return <A>; … return <B>;` — two-statement body.
    if body.stmts.len() == 2
        && let Some(cond_node) = try_lower_if_return_body(body, &scope)?
    {
        return Ok(vec![cond_node]);
    }

    // Multi-statement body or unrecognized shape.
    Err(LowerError::at(
        body.span,
        ErrorKind::InlineUntranslatable("local binding".to_string()),
    ))
}

/// Try to lower a two-statement body of the form:
///   `if (cond) return <A>;`
///   `return <B>;`
/// (with or without an explicit `else`). Returns `None` if the shape doesn't
/// match, so the caller can fall back to an error.
fn try_lower_if_return_body(
    body: &BlockStmt,
    scope: &Scope,
) -> Result<Option<JsxNode>, LowerError> {
    use swc_core::ecma::ast::{IfStmt, Stmt};

    if body.stmts.len() != 2 {
        return Ok(None);
    }

    // First stmt: `if (cond) return <A>;` (no else branch here).
    let Stmt::If(IfStmt {
        test: cond_expr,
        cons,
        alt,
        ..
    }) = &body.stmts[0]
    else {
        return Ok(None);
    };
    // No else allowed in the two-stmt form (else handled separately below).
    if alt.is_some() {
        return Ok(None);
    }
    // cons must be `return <A>;` (possibly wrapped in a block).
    let jsx_a = extract_return_jsx_from_stmt(cons)?;
    let Some(jsx_a) = jsx_a else {
        return Ok(None);
    };

    // Second stmt: `return <B>;`
    let Stmt::Return(ReturnStmt {
        arg: Some(ret_b), ..
    }) = &body.stmts[1]
    else {
        return Ok(None);
    };
    let jsx_b = strip_paren(ret_b.as_ref());
    let SwcExpr::JSXElement(el_b) = jsx_b else {
        return Ok(None);
    };

    let test_expr = lower_expr(cond_expr, scope)?;
    let node_a = lower_element(jsx_a, scope, false)?;
    let node_b = lower_element(el_b, scope, false)?;

    Ok(Some(JsxNode::Cond {
        test: test_expr,
        consequent: Box::new(node_a),
        alternate: Some(Box::new(node_b)),
    }))
}

/// Extract the JSX element from a `return <JSX>;` statement or
/// `{ return <JSX>; }` block statement. Returns `None` if the shape doesn't
/// match (so the caller can decide what to do).
fn extract_return_jsx_from_stmt(stmt: &Stmt) -> Result<Option<&JSXElement>, LowerError> {
    match stmt {
        Stmt::Return(ReturnStmt {
            arg: Some(expr), ..
        }) => {
            let jsx = strip_paren(expr.as_ref());
            match jsx {
                SwcExpr::JSXElement(el) => Ok(Some(el)),
                _ => Ok(None),
            }
        }
        Stmt::Block(block) => {
            if block.stmts.len() != 1 {
                return Ok(None);
            }
            match &block.stmts[0] {
                Stmt::Return(ReturnStmt {
                    arg: Some(expr), ..
                }) => {
                    let jsx = strip_paren(expr.as_ref());
                    match jsx {
                        SwcExpr::JSXElement(el) => Ok(Some(el)),
                        _ => Ok(None),
                    }
                }
                _ => Ok(None),
            }
        }
        _ => Ok(None),
    }
}

fn find_default_export(module: &Module) -> Result<(String, &FnExpr), LowerError> {
    let mut found: Option<(String, &FnExpr)> = None;
    for item in &module.body {
        match item {
            ModuleItem::ModuleDecl(ModuleDecl::Import(_)) => continue,
            ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(ExportDefaultDecl {
                decl: DefaultDecl::Fn(fn_expr),
                ..
            })) => {
                let name = fn_expr
                    .ident
                    .as_ref()
                    .map(|i| i.sym.to_string())
                    .unwrap_or_else(|| "Anonymous".to_string());
                if found.is_some() {
                    return Err(LowerError::at(
                        fn_expr.function.span,
                        ErrorKind::UnexpectedStatement,
                    ));
                }
                found = Some((name, fn_expr));
            }
            // Any other top-level item — named `export const`/`export function`,
            // bare `const`/`let`, type aliases, interfaces, a non-Fn
            // `export default`, etc. — is tolerated and ignored. This lets a
            // single-file native component co-locate an `export const behavior`
            // (and similar statements) next to its `export default function`
            // template instead of being rejected with `UnexpectedStatement`.
            // We still only lower the default function below.
            _ => continue,
        }
    }
    found.ok_or_else(|| LowerError::at(Span::default(), ErrorKind::UnexpectedStatement))
}

fn single_return_expr(body: &BlockStmt) -> Result<&SwcExpr, LowerError> {
    if body.stmts.len() != 1 {
        return Err(LowerError::at(body.span, ErrorKind::BodyMustBeSingleReturn));
    }
    match &body.stmts[0] {
        Stmt::Return(ReturnStmt {
            arg: Some(expr), ..
        }) => Ok(expr),
        other => Err(LowerError::at(
            other.span(),
            ErrorKind::BodyMustBeSingleReturn,
        )),
    }
}

fn strip_paren(expr: &SwcExpr) -> &SwcExpr {
    if let SwcExpr::Paren(ParenExpr { expr, .. }) = expr {
        strip_paren(expr)
    } else {
        expr
    }
}

/// Lower the function's first parameter into the names that go into JSX scope.
///
/// Accepted shapes (per spec S4.4):
/// - empty `()` → no props
/// - `({ a, b }: ...)` (`ObjectPat`) with shorthand `BindingIdent` entries
///   → destructured names
/// - `(name: ...)` (`BindingIdent`) → single named binding; `name` as bare
///   ident in JSX is rejected later as `BareIdentNotSupported`, but
///   `name.field` chains are valid.
///
/// Rejected (→ `UnsupportedParam`): defaults (`{ a = "x" }`), nested
/// destructuring, rest patterns, array patterns, key-value rename,
/// multiple params.
fn lower_params(function: &Function) -> Result<ParamShape, LowerError> {
    if function.params.is_empty() {
        return Ok(ParamShape::default());
    }
    if function.params.len() > 1 {
        return Err(LowerError::at(
            function.params[1].span,
            ErrorKind::UnsupportedParam,
        ));
    }
    let pat = &function.params[0].pat;
    match pat {
        Pat::Ident(BindingIdent { id, .. }) => Ok(ParamShape {
            destructured: vec![],
            named: Some(id.sym.to_string()),
        }),
        Pat::Object(obj) => {
            let mut names = Vec::new();
            for prop in &obj.props {
                match prop {
                    // Shorthand `{ a, b }` — `value: None` rules out
                    // defaults `{ a = "x" }`, which we want rejected.
                    ObjectPatProp::Assign(AssignPatProp {
                        key, value: None, ..
                    }) => {
                        names.push(key.id.sym.to_string());
                    }
                    ObjectPatProp::Assign(AssignPatProp { value: Some(_), .. }) => {
                        return Err(LowerError::at(obj.span, ErrorKind::UnsupportedParam));
                    }
                    // KeyValue (`{ a: b }`), Rest (`{ ...r }`), or anything
                    // else → reject.
                    _ => return Err(LowerError::at(obj.span, ErrorKind::UnsupportedParam)),
                }
            }
            Ok(ParamShape {
                destructured: names,
                named: None,
            })
        }
        _ => Err(LowerError::at(pat.span(), ErrorKind::UnsupportedParam)),
    }
}

/// Lower a `<>…</>` fragment by lowering each child through `lower_child`
/// (whitespace-only JSXText and empty `{}` containers are dropped, exactly as for
/// host-element children; nested fragments lower recursively via that same path).
/// `in_map` flows through unchanged.
fn lower_fragment(frag: &JSXFragment, scope: &Scope, in_map: bool) -> Result<JsxNode, LowerError> {
    let mut children = Vec::new();
    for child in &frag.children {
        if let Some(node) = lower_child(child, scope, in_map)? {
            children.push(node);
        }
    }
    Ok(JsxNode::Fragment { children })
}

/// True if `node` is a `Fragment` or contains one anywhere in the subtree that
/// the React factory emitter walks. Used by `lower_ssr_component` to reject
/// fragments inside an SSR component's children (the factory emitter cannot
/// represent a fragment — v1 limitation). Recurses through every child-bearing
/// variant the factory emits, including nested `SsrComponent` children (which
/// `emit_factory::emit_h` renders inline).
fn subtree_contains_fragment(node: &JsxNode) -> bool {
    match node {
        JsxNode::Fragment { .. } => true,
        JsxNode::Element { children, .. }
        | JsxNode::SsrComponent { children, .. }
        | JsxNode::Document { body: children, .. } => {
            children.iter().any(subtree_contains_fragment)
        }
        JsxNode::Map { body, .. } => subtree_contains_fragment(body),
        JsxNode::Cond {
            consequent,
            alternate,
            ..
        } => {
            subtree_contains_fragment(consequent)
                || alternate.as_deref().is_some_and(subtree_contains_fragment)
        }
        JsxNode::Empty
        | JsxNode::Text(_)
        | JsxNode::Expr(_)
        | JsxNode::RawHtml(_)
        | JsxNode::Island { .. }
        | JsxNode::ChildrenSlot => false,
    }
}

fn lower_element(el: &JSXElement, scope: &Scope, in_map: bool) -> Result<JsxNode, LowerError> {
    // Dedicated `<Island>` recognition path: peek the opening name BEFORE
    // `lower_element_name` (which would reject any capitalized custom component
    // as `CustomComponentNotSupported`). An `<Island>` is the one capitalized
    // tag we accept, lowering it to `JsxNode::Island`.
    if let JSXElementName::Ident(ident) = &el.opening.name
        && ident.sym.as_ref() == "Island"
    {
        return lower_island(el, scope, in_map);
    }

    // `<BrustPage>` is only valid as the route root (handled in `lower`). Any
    // occurrence reaching `lower_element` is therefore nested — reject with a
    // dedicated diagnostic rather than the generic `CustomComponentNotSupported`
    // that `lower_element_name` would otherwise produce.
    if let JSXElementName::Ident(ident) = &el.opening.name
        && ident.sym.as_ref() == "BrustPage"
    {
        return Err(LowerError::at(ident.span, ErrorKind::BrustPageMustBeRoot));
    }

    // `<Outlet/>` is a native builtin: it lowers to the same `JsxNode::ChildrenSlot`
    // that an inline `{children}` produces, marking where child routes / nested
    // content splice in. Recognized BEFORE the capitalised-tag → SsrComponent fall
    // so it never becomes a `comp_N` SSR slot (which would React-render on the
    // server). It must be empty: any meaningful children or attributes are a hard
    // `OutletMustBeEmpty` error (whitespace-only text — e.g. a formatter's
    // `<Outlet>\n</Outlet>` — is tolerated, mirroring `<Island>`). It is only valid
    // INSIDE a layout being inlined (`scope.inline` set); a surviving `ChildrenSlot`
    // would otherwise reach emit and `unreachable!`-panic — so an `<Outlet/>` in a
    // standalone (non-inlined) route is a hard `OutletOutsideLayout` error.
    if let JSXElementName::Ident(ident) = &el.opening.name
        && ident.sym.as_ref() == "Outlet"
    {
        let has_meaningful_child = el.children.iter().any(|c| match c {
            JSXElementChild::JSXText(t) => !t.value.trim().is_empty(),
            _ => true,
        });
        if has_meaningful_child || !el.opening.attrs.is_empty() {
            return Err(LowerError::at(ident.span, ErrorKind::OutletMustBeEmpty));
        }
        if scope.inline.is_none() {
            return Err(LowerError::at(ident.span, ErrorKind::OutletOutsideLayout));
        }
        return Ok(JsxNode::ChildrenSlot);
    }

    // Third path: any other capitalised tag → SSR component.
    if let JSXElementName::Ident(ident) = &el.opening.name {
        let s = ident.sym.as_ref();
        if s.starts_with(|c: char| c.is_ascii_uppercase()) {
            return lower_ssr_component(el, s, scope, in_map, false);
        }
    }

    let tag = lower_element_name(&el.opening.name)?;
    // `dangerouslySetInnerHTML={{ __html: <literal | member-path> }}` — React's
    // raw-HTML escape hatch. Detected before the normal attr/children build so it
    // is NOT routed through `lower_attr`; its value becomes a single `RawHtml`
    // child emitted un-escaped (literal verbatim, path via `| safe`).
    let mut raw_html: Option<crate::ir::HeadValue> = None;
    for a in &el.opening.attrs {
        let JSXAttrOrSpread::JSXAttr(jsx_attr) = a else {
            continue;
        };
        let JSXAttrName::Ident(name) = &jsx_attr.name else {
            continue;
        };
        if name.sym.as_ref() != "dangerouslySetInnerHTML" {
            continue;
        }
        raw_html = Some(lower_dangerously_set_inner_html(jsx_attr, scope)?);
    }

    // T6: attr precedence (key drop, ref/on*/uppercase rejection, rename table),
    // void-element children check, whitespace-only JSXText filtering.
    let mut attrs = Vec::new();
    for a in &el.opening.attrs {
        // The `dangerouslySetInnerHTML` attr is consumed above, not emitted.
        if let JSXAttrOrSpread::JSXAttr(jsx_attr) = a
            && let JSXAttrName::Ident(name) = &jsx_attr.name
            && name.sym.as_ref() == "dangerouslySetInnerHTML"
        {
            continue;
        }
        if let Some(attr) = lower_attr(a, scope)? {
            attrs.push(attr);
        }
    }

    let mut children = Vec::new();
    for child in &el.children {
        // `in_map` flows straight through to children — an element nested under
        // a `.map(...)` keeps the flag set so any `<Island>` descendant is caught.
        if let Some(node) = lower_child(child, scope, in_map)? {
            children.push(node);
        }
    }

    // `dangerouslySetInnerHTML` owns the element's inner content — React rejects
    // an element that has both, and the raw child would otherwise be ambiguous.
    if let Some(hv) = raw_html {
        if !children.is_empty() {
            return Err(LowerError::at(
                el.opening.span,
                ErrorKind::DangerouslySetInnerHtmlWithChildren,
            ));
        }
        children = vec![JsxNode::RawHtml(hv)];
    }

    // T6: void element with non-empty (post-filter) children → error.
    if is_void_element(&tag) && !children.is_empty() {
        return Err(LowerError::at(
            el.opening.span,
            ErrorKind::VoidElementHasChildren(tag),
        ));
    }

    let element = JsxNode::Element {
        tag,
        attrs,
        children,
    };
    // Native x-for SSR seed: when this element carries a KEYED `x-for` whose
    // source resolves to a loader array (Field), desugar into a `{% for %}` Map
    // with per-item render + data-x-key + real bound attrs, RETAINING the x-*
    // attrs for client adopt. Any failure (non-keyed, source not a Field, foreign
    // path root, malformed) falls back to the element AS-IS — today's opaque
    // passthrough, NEVER an error.
    if let Some(map_node) = try_xfor_ssr(&element, scope) {
        return Ok(map_node);
    }
    Ok(element)
}

/// Native x-for → SSR `{% for %}` Map seed. Returns None (→ passthrough) unless
/// the element carries a KEYED x-for whose source is a destructured loader prop
/// and every dynamic path roots at the item binding.
fn try_xfor_ssr(el: &JsxNode, scope: &Scope) -> Option<JsxNode> {
    let JsxNode::Element { attrs, .. } = el else {
        return None;
    };
    let xfor_raw = attrs
        .iter()
        .find_map(|a| match (a.name.as_str(), &a.value) {
            ("x-for", AttrValue::Static(s)) => Some(s.clone()),
            _ => None,
        })?;
    let f = crate::xfor::parse_for(&xfor_raw)?;
    // SSR adopt needs keys (data-x-key); a non-keyed x-for stays client-only.
    if f.key_paths.is_empty() {
        return None;
    }
    // Resolve the source the way `lower_expr` resolves an ident — inline
    // substitution first (the call-site expr when this component is inlined into a
    // parent, e.g. `<DexFilter items={items}/>`), then a destructured loader prop.
    // SSR only for a real template-scope path (`Field`/`MemberAccess`); a
    // behavior-only name / map binding → None → client-only passthrough (never an
    // error). (`scope.destructured` never overlaps `scope.map_bindings`, so an
    // x-for nested in a `.map()` can't double-wrap.)
    let source = resolve_xfor_source(&f.source_name, scope)?;
    let body = transform_xfor_body(el, &f)?;
    Some(JsxNode::Map {
        source,
        binding: f.item_name.clone(),
        body: Box::new(body),
    })
}

/// Resolve an x-for source ident to a server-renderable array path, mirroring
/// `lower_expr`'s ident resolution. Inline-substitution wins first: when this
/// component is inlined into a parent (`<DexFilter items={items}/>`), the source
/// name maps to the call-site `Expr`. Only a `Field` / `MemberAccess` (a real
/// template-scope path) is SSR-eligible; a behavior-only name, a map binding, or a
/// literal → None → the x-for stays client-only.
fn resolve_xfor_source(name: &str, scope: &Scope) -> Option<Expr> {
    if let Some(ctx) = &scope.inline
        && let Some(sub) = ctx.subst.get(name)
    {
        return match sub {
            Expr::Field(_) | Expr::MemberAccess { .. } => Some(sub.clone()),
            _ => None,
        };
    }
    if scope.destructured.iter().any(|d| d == name) {
        Some(Expr::Field(name.to_string()))
    } else {
        None
    }
}

/// Build the per-item render: transform the element subtree (x-bind-* → real
/// attr, x-text → interp child), then add data-x-key on the ROOT. Returns None if
/// any path roots at a foreign ident (whole transform bails → passthrough).
fn transform_xfor_body(el: &JsxNode, f: &crate::xfor::ForExpr) -> Option<JsxNode> {
    let mut root = transform_xfor_element(el, &f.item_name)?;
    // data-x-key on the root: single → `data-x-key`, composite → `data-x-key-0..N`.
    // `set_or_push_attr` replaces any author-written `data-x-key*` so the runtime's
    // synthesized key wins (no duplicate attr the HTML parser would pick first).
    if let JsxNode::Element { attrs, .. } = &mut root {
        if f.key_paths.len() == 1 {
            let expr = crate::xfor::path_to_map_expr(&f.key_paths[0], &f.item_name)?;
            set_or_push_attr(attrs, "data-x-key".to_string(), AttrValue::Expr(expr));
        } else {
            for (i, kp) in f.key_paths.iter().enumerate() {
                let expr = crate::xfor::path_to_map_expr(kp, &f.item_name)?;
                set_or_push_attr(attrs, format!("data-x-key-{i}"), AttrValue::Expr(expr));
            }
        }
    }
    Some(root)
}

/// Recursively transform one node. Elements: keep ALL attrs (x-* retained), add a
/// real attr for each `x-bind-<attr>`, append an interp child for `x-text`,
/// recurse children. Non-elements pass through unchanged.
fn transform_xfor_element(node: &JsxNode, item: &str) -> Option<JsxNode> {
    let JsxNode::Element {
        tag,
        attrs,
        children,
    } = node
    else {
        return Some(node.clone());
    };
    let mut new_attrs = attrs.clone(); // retain x-* (client re-binds on adopt)
    for a in attrs {
        if let Some(real) = a.name.strip_prefix("x-bind-")
            && !real.is_empty() // guard `x-bind-=""` → would emit a nameless attr
            && let AttrValue::Static(v) = &a.value
        {
            let expr = crate::xfor::path_to_map_expr(v, item)?;
            // replace any pre-existing literal of the same name so the per-item
            // bound value wins (HTML keeps the first attr → must not duplicate).
            set_or_push_attr(&mut new_attrs, real.to_string(), AttrValue::Expr(expr));
        }
    }
    let mut new_children = Vec::with_capacity(children.len() + 1);
    for c in children {
        new_children.push(transform_xfor_element(c, item)?);
    }
    // x-text → the server value as the interp child. x-text sets `textContent` on
    // the client (replacing any children), so SSR must match: the expr is the SOLE
    // child (drop any authored children, mirroring the runtime's overwrite).
    if let Some(xt) = attrs.iter().find(|a| a.name == "x-text")
        && let AttrValue::Static(v) = &xt.value
    {
        let expr = crate::xfor::path_to_map_expr(v, item)?;
        new_children.clear();
        new_children.push(JsxNode::Expr(expr));
    }
    Some(JsxNode::Element {
        tag: tag.clone(),
        attrs: new_attrs,
        children: new_children,
    })
}

/// Replace the first attr named `name` (keeping position), or push it if absent.
/// Prevents duplicate attributes (the HTML parser keeps the first, which would
/// shadow the synthesized per-item value).
fn set_or_push_attr(attrs: &mut Vec<JsxAttr>, name: String, value: AttrValue) {
    if let Some(existing) = attrs.iter_mut().find(|a| a.name == name) {
        existing.value = value;
    } else {
        attrs.push(JsxAttr { name, value });
    }
}

/// Lower a `dangerouslySetInnerHTML={{ __html: … }}` attribute value. The value
/// must be an object literal with exactly one `__html` key whose value is a
/// string literal (→ `Literal`, emitted verbatim) or a loader member-path (→
/// `Path`, emitted via `{{ (path) | safe }}`). Anything else is rejected.
fn lower_dangerously_set_inner_html(
    jsx_attr: &swc_core::ecma::ast::JSXAttr,
    scope: &Scope,
) -> Result<crate::ir::HeadValue, LowerError> {
    let span = jsx_attr.span;
    let err = || LowerError::at(span, ErrorKind::DangerouslySetInnerHtmlInvalid);

    let Some(JSXAttrValue::JSXExprContainer(c)) = &jsx_attr.value else {
        return Err(err());
    };
    let JSXExpr::Expr(e) = &c.expr else {
        return Err(err());
    };
    let SwcExpr::Object(obj) = strip_paren(e.as_ref()) else {
        return Err(err());
    };
    if obj.props.len() != 1 {
        return Err(err());
    }
    let PropOrSpread::Prop(p) = &obj.props[0] else {
        return Err(err());
    };
    let Prop::KeyValue(kv) = p.as_ref() else {
        return Err(err());
    };
    let key = match &kv.key {
        PropName::Ident(i) => i.sym.to_string(),
        PropName::Str(s) => s.value.to_string_lossy().into_owned(),
        _ => return Err(err()),
    };
    if key != "__html" {
        return Err(err());
    }
    match lower_expr(&kv.value, scope) {
        Ok(crate::ir::Expr::StaticText(s)) => Ok(crate::ir::HeadValue::Literal(s)),
        Ok(ex @ (crate::ir::Expr::Field(_) | crate::ir::Expr::MemberAccess { .. })) => {
            Ok(crate::ir::HeadValue::Path(ex))
        }
        _ => Err(err()),
    }
}

/// Lower the built-in `<BrustPage …>…</BrustPage>` document shell into
/// `JsxNode::Document`.
///
/// Head content is supplied entirely through PROPS (not a `<head>` child) so the
/// framework keeps full ownership of `<head>` and can inject more tags later
/// without colliding with user markup. All props are OPTIONAL and accept either
/// a compile-time string literal OR a member-path expression (`{d.title}`),
/// interpolated into the head as `{{ path }}`:
/// - `lang="…"`         → `<html lang>` (default `"en"` emitted if omitted)
/// - `className="…"`     → `<html class>`
/// - `bodyClassName="…"` → `<body class>`
/// - `title="…"`         → `<title>…</title>`
/// - `description="…"`   → `<meta name="description" content="…">`
///
/// A non-literal/non-path value (`title={fn()}`, `title={a + b}`) →
/// `BrustPageAttrMustBeStringLiteral`.
/// Spread (`{...x}`) / namespaced attrs → the same rejects as host elements.
/// Unknown props are ignored (forward-compatible, mirrors `<Island>`) — adding a
/// new head prop is a single match arm + emit line.
///
/// Every child becomes `<body>` content. A literal `<head>` child is rejected
/// (`BrustPageLiteralHeadNotSupported`) — head is configured via props only.
///
/// `<BrustPage>` is only reached for the route root (see `lower`), so it is
/// never under a `.map(...)` — no `in_map` parameter.
fn lower_brust_page(el: &JSXElement, scope: &Scope) -> Result<JsxNode, LowerError> {
    let mut lang: Option<crate::ir::HeadValue> = None;
    let mut html_class: Option<crate::ir::HeadValue> = None;
    let mut body_class: Option<crate::ir::HeadValue> = None;
    let mut title: Option<crate::ir::HeadValue> = None;
    let mut description: Option<crate::ir::HeadValue> = None;
    let mut head: Vec<crate::ir::HeadEntry> = Vec::new();
    let mut html_attrs: Vec<(String, crate::ir::HeadValue)> = Vec::new();

    for attr in &el.opening.attrs {
        let JSXAttrOrSpread::JSXAttr(jsx_attr) = attr else {
            return Err(LowerError::at(
                el.opening.span,
                ErrorKind::SpreadAttributeNotSupported,
            ));
        };
        let name = match &jsx_attr.name {
            JSXAttrName::Ident(name) => name.sym.to_string(),
            JSXAttrName::JSXNamespacedName(n) => {
                return Err(LowerError::at(
                    n.span,
                    ErrorKind::NamespacedAttrNotSupported,
                ));
            }
        };

        // `head` is an array of head-entry objects, not a HeadValue slot — parse
        // it separately before the scalar-prop slot match.
        if name == "head" {
            parse_head_array(jsx_attr, scope, &mut head)?;
            continue;
        }

        // `data-*` → arbitrary attribute on <html>. Same value grammar as the
        // scalar shell props (string literal or loader member-path).
        if name.starts_with("data-") {
            if !is_valid_data_attr_name(&name) {
                return Err(LowerError::at(
                    jsx_attr.span,
                    ErrorKind::InvalidDataAttrName(name),
                ));
            }
            let value = parse_brust_page_head_value(jsx_attr, &name, scope)?;
            html_attrs.push((name, value));
            continue;
        }

        // Only the curated shell/head props are read; everything else is ignored
        // so future props don't hard-error older compilers.
        let slot = match name.as_str() {
            "lang" => &mut lang,
            "className" => &mut html_class,
            "bodyClassName" => &mut body_class,
            "title" => &mut title,
            "description" => &mut description,
            _ => continue,
        };
        // Value is either a plain string literal (pre-escaped at build) or a
        // member-path expression interpolated into the jinja head as `{{ path }}`.
        // Anything else (call, arithmetic, spread, …) is rejected: the shell is
        // rendered in Rust and its head can only thread literals or loader paths.
        match &jsx_attr.value {
            Some(JSXAttrValue::Str(s)) => {
                *slot = Some(crate::ir::HeadValue::Literal(
                    s.value.to_string_lossy().into_owned(),
                ));
            }
            Some(JSXAttrValue::JSXExprContainer(c)) => {
                if let JSXExpr::Expr(e) = &c.expr {
                    // Do NOT propagate lower_expr's error with `?`: a call
                    // (`title={fn()}`) lowers to `CallExpressionNotSupported`,
                    // but the user-facing contract here is the more specific
                    // "string literal or member-path". So any lower failure OR a
                    // non-path success both collapse to the same reject.
                    match lower_expr(e, scope) {
                        Ok(crate::ir::Expr::StaticText(s)) => {
                            *slot = Some(crate::ir::HeadValue::Literal(s));
                        }
                        Ok(
                            ex @ (crate::ir::Expr::Field(_) | crate::ir::Expr::MemberAccess { .. }),
                        ) => {
                            *slot = Some(crate::ir::HeadValue::Path(ex));
                        }
                        _ => {
                            return Err(LowerError::at(
                                jsx_attr.span,
                                ErrorKind::BrustPageAttrMustBeStringLiteral(name),
                            ));
                        }
                    }
                } else {
                    return Err(LowerError::at(
                        jsx_attr.span,
                        ErrorKind::BrustPageAttrMustBeStringLiteral(name),
                    ));
                }
            }
            _ => {
                return Err(LowerError::at(
                    jsx_attr.span,
                    ErrorKind::BrustPageAttrMustBeStringLiteral(name),
                ));
            }
        }
    }

    // Default lang to "en" so the emitted document always declares a language.
    if lang.is_none() {
        lang = Some(crate::ir::HeadValue::Literal("en".to_string()));
    }

    let mut body: Vec<JsxNode> = Vec::new();
    for child in &el.children {
        // A literal `<head>` child is disallowed — head is props-only so the
        // framework can own/extend it. Point the user at the props.
        if let JSXElementChild::JSXElement(ce) = child
            && let JSXElementName::Ident(id) = &ce.opening.name
            && id.sym.as_ref() == "head"
        {
            return Err(LowerError::at(
                ce.opening.span,
                ErrorKind::BrustPageLiteralHeadNotSupported,
            ));
        }
        if let Some(node) = lower_child(child, scope, false)? {
            body.push(node);
        }
    }

    Ok(JsxNode::Document {
        lang,
        html_class,
        body_class,
        title,
        description,
        head,
        html_attrs,
        body,
    })
}

/// A `data-*` attribute name is valid iff it is `data-` followed by one or more
/// lowercase letters, digits, or hyphens. Uppercase is rejected (DOM lowercases
/// data attrs; a `data-Foo` literal wouldn't round-trip via `dataset`).
fn is_valid_data_attr_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("data-") else {
        return false;
    };
    !rest.is_empty()
        && rest
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Parse a `<BrustPage>` scalar/attr value into a `HeadValue`: a string literal
/// (`x="…"`) or a loader member-path (`x={data.y}`). Calls/arithmetic/spread/
/// non-path exprs are rejected as `BrustPageAttrMustBeStringLiteral`. Mirrors the
/// inline scalar-slot logic; used for `data-*` attrs.
fn parse_brust_page_head_value(
    jsx_attr: &swc_core::ecma::ast::JSXAttr,
    name: &str,
    scope: &Scope,
) -> Result<crate::ir::HeadValue, LowerError> {
    match &jsx_attr.value {
        Some(JSXAttrValue::Str(s)) => Ok(crate::ir::HeadValue::Literal(
            s.value.to_string_lossy().into_owned(),
        )),
        Some(JSXAttrValue::JSXExprContainer(c)) => {
            if let JSXExpr::Expr(e) = &c.expr {
                match lower_expr(e, scope) {
                    Ok(crate::ir::Expr::StaticText(s)) => Ok(crate::ir::HeadValue::Literal(s)),
                    Ok(ex @ (crate::ir::Expr::Field(_) | crate::ir::Expr::MemberAccess { .. })) => {
                        Ok(crate::ir::HeadValue::Path(ex))
                    }
                    _ => Err(LowerError::at(
                        jsx_attr.span,
                        ErrorKind::BrustPageAttrMustBeStringLiteral(name.to_string()),
                    )),
                }
            } else {
                Err(LowerError::at(
                    jsx_attr.span,
                    ErrorKind::BrustPageAttrMustBeStringLiteral(name.to_string()),
                ))
            }
        }
        _ => Err(LowerError::at(
            jsx_attr.span,
            ErrorKind::BrustPageAttrMustBeStringLiteral(name.to_string()),
        )),
    }
}

/// Parse a `<BrustPage head={[…]}>` array literal into `HeadEntry`s. Mirrors the
/// SWC object-parse pattern used by `parse_isr_object`. Each element must be an
/// object literal with a `tag` discriminant; `text` is a static string literal
/// only (dynamic text is an XSS vector — see the design doc security model).
fn parse_head_array(
    jsx_attr: &swc_core::ecma::ast::JSXAttr,
    scope: &Scope,
    out: &mut Vec<crate::ir::HeadEntry>,
) -> Result<(), LowerError> {
    use crate::ir::{HeadEntry, HeadTag, HeadValue};
    let span = jsx_attr.span;
    let arr_err = || LowerError::at(span, ErrorKind::BrustPageHeadMustBeArray);
    let entry_err = || LowerError::at(span, ErrorKind::BrustPageHeadEntryInvalid);

    let Some(JSXAttrValue::JSXExprContainer(c)) = &jsx_attr.value else {
        return Err(arr_err());
    };
    let JSXExpr::Expr(e) = &c.expr else {
        return Err(arr_err());
    };
    let SwcExpr::Array(arr) = strip_paren(e.as_ref()) else {
        return Err(arr_err());
    };

    for el in &arr.elems {
        let Some(item) = el else {
            return Err(entry_err());
        };
        if item.spread.is_some() {
            return Err(entry_err());
        }
        let SwcExpr::Object(obj) = strip_paren(item.expr.as_ref()) else {
            return Err(entry_err());
        };

        let mut tag: Option<HeadTag> = None;
        let mut attrs: Vec<(String, HeadValue)> = Vec::new();
        let mut bool_attrs: Vec<String> = Vec::new();
        let mut text: Option<String> = None;

        for prop in &obj.props {
            let PropOrSpread::Prop(p) = prop else {
                return Err(entry_err());
            };
            let Prop::KeyValue(kv) = p.as_ref() else {
                return Err(entry_err());
            };
            let key = match &kv.key {
                PropName::Ident(i) => i.sym.to_string(),
                PropName::Str(s) => s.value.to_string_lossy().into_owned(),
                _ => return Err(entry_err()),
            };
            if key == "tag" {
                let SwcExpr::Lit(Lit::Str(s)) = strip_paren(&kv.value) else {
                    return Err(entry_err());
                };
                tag = Some(match s.value.to_string_lossy().as_ref() {
                    "link" => HeadTag::Link,
                    "meta" => HeadTag::Meta,
                    "base" => HeadTag::Base,
                    "style" => HeadTag::Style,
                    "script" => HeadTag::Script,
                    "noscript" => HeadTag::Noscript,
                    _ => return Err(entry_err()),
                });
                continue;
            }
            if key == "text" {
                let SwcExpr::Lit(Lit::Str(s)) = strip_paren(&kv.value) else {
                    return Err(LowerError::at(
                        span,
                        ErrorKind::BrustPageHeadTextMustBeLiteral,
                    ));
                };
                text = Some(s.value.to_string_lossy().into_owned());
                continue;
            }
            // boolean presence attr (`defer`, `async`)
            if let SwcExpr::Lit(Lit::Bool(b)) = strip_paren(&kv.value) {
                if b.value {
                    bool_attrs.push(map_head_attr_key(&key));
                }
                continue;
            }
            // string literal attr
            if let SwcExpr::Lit(Lit::Str(s)) = strip_paren(&kv.value) {
                attrs.push((
                    map_head_attr_key(&key),
                    HeadValue::Literal(s.value.to_string_lossy().into_owned()),
                ));
                continue;
            }
            // member-path attr (same contract as title/description)
            match lower_expr(&kv.value, scope) {
                Ok(crate::ir::Expr::StaticText(s)) => {
                    attrs.push((map_head_attr_key(&key), HeadValue::Literal(s)));
                }
                Ok(ex @ (crate::ir::Expr::Field(_) | crate::ir::Expr::MemberAccess { .. })) => {
                    attrs.push((map_head_attr_key(&key), HeadValue::Path(ex)));
                }
                _ => {
                    return Err(LowerError::at(
                        span,
                        ErrorKind::BrustPageAttrMustBeStringLiteral(key),
                    ));
                }
            }
        }

        let Some(tag) = tag else {
            return Err(entry_err());
        };
        if text.is_some() && tag.is_void() {
            return Err(LowerError::at(span, ErrorKind::BrustPageHeadTextOnVoid));
        }
        out.push(HeadEntry {
            tag,
            attrs,
            bool_attrs,
            text,
        });
    }
    Ok(())
}

/// camelCase head-attr key → HTML attribute name. Only the two camelCase cases
/// need mapping; every other field in the HeadEntry union is already a lowercase
/// HTML attribute name.
fn map_head_attr_key(k: &str) -> String {
    match k {
        "crossOrigin" => "crossorigin".to_string(),
        "httpEquiv" => "http-equiv".to_string(),
        other => other.to_string(),
    }
}

/// Static-vs-dynamic classification of one recognized lucide prop value.
enum LucidePropVal {
    /// Static string literal (`"red"`, `{"red"}`). A bare valueless attribute
    /// (`<X foo/>`) also lands here as an empty string.
    Str(String),
    /// Static integer literal (`{16}`).
    Num(i64),
    /// Dynamic — lowers to a non-literal `Expr`. Triggers T3 soft-fallback.
    Dynamic,
}

/// Lower one JSX attribute value into a `LucidePropVal`, distinguishing static
/// literals from dynamic expressions. Mirrors the value branch of `lower_attr`.
fn lucide_prop_value(
    value: &Option<JSXAttrValue>,
    scope: &Scope,
) -> Result<LucidePropVal, LowerError> {
    match value {
        // Bare attribute (`absoluteStrokeWidth`) — treated as present-but-valueless;
        // the caller decides. Represent as an empty static string.
        None => Ok(LucidePropVal::Str(String::new())),
        Some(JSXAttrValue::Str(s)) => {
            Ok(LucidePropVal::Str(s.value.to_string_lossy().into_owned()))
        }
        Some(JSXAttrValue::JSXExprContainer(c)) => match &c.expr {
            JSXExpr::JSXEmptyExpr(_) => Ok(LucidePropVal::Dynamic),
            JSXExpr::Expr(e) => match lower_expr(e, scope)? {
                crate::ir::Expr::StaticText(s) => Ok(LucidePropVal::Str(s)),
                crate::ir::Expr::StaticNum(n) => Ok(LucidePropVal::Num(n)),
                _ => Ok(LucidePropVal::Dynamic),
            },
        },
        _ => Ok(LucidePropVal::Dynamic),
    }
}

/// Emit a static `<svg>` for a registered lucide icon, for the STATIC-prop cases
/// only (T2). Returns `Ok(None)` to defer to the SSR path (T3 will handle these):
/// any spread, any recognized prop with a dynamic value, a dynamic `className`,
/// or an `absoluteStrokeWidth` prop. Otherwise builds the SVG node directly.
fn build_lucide_svg(
    el: &JSXElement,
    icon: &LucideIcon,
    scope: &Scope,
) -> Result<Option<JsxNode>, LowerError> {
    // Recognized prop slots (only set when STATIC; a dynamic value bails out).
    let mut size: Option<i64> = None;
    let mut color: Option<String> = None;
    let mut stroke_width: Option<String> = None;
    let mut class_name: Option<String> = None;
    // Passthrough attrs (aria-*, role, data-*, and any other plain attr), in
    // source order, emitted verbatim.
    let mut passthrough: Vec<JsxAttr> = Vec::new();
    // Whether the call-site supplies any aria-* / role prop (suppresses aria-hidden).
    let mut has_aria_or_role = false;

    for attr in &el.opening.attrs {
        let jsx_attr = match attr {
            // Spread → T3 (soft-fallback + warn). Defer.
            JSXAttrOrSpread::SpreadElement(_) => return Ok(None),
            JSXAttrOrSpread::JSXAttr(a) => a,
        };
        let name = match &jsx_attr.name {
            JSXAttrName::Ident(id) => id.sym.to_string(),
            JSXAttrName::JSXNamespacedName(n) => {
                return Err(LowerError::at(
                    n.span,
                    ErrorKind::NamespacedAttrNotSupported,
                ));
            }
        };
        match name.as_str() {
            // Stripped no-ops. `isr` is allowed and ignored (no error).
            "isr" | "key" | "ref" => continue,
            "size" => match lucide_prop_value(&jsx_attr.value, scope)? {
                LucidePropVal::Num(n) => size = Some(n),
                // A string size (`size="16"`) is still static — accept it numerically
                // when it parses, otherwise treat the string verbatim is not a valid
                // width; defer to T3.
                LucidePropVal::Str(s) => match s.parse::<i64>() {
                    Ok(n) => size = Some(n),
                    Err(_) => return Ok(None),
                },
                LucidePropVal::Dynamic => return Ok(None),
            },
            "color" => match lucide_prop_value(&jsx_attr.value, scope)? {
                LucidePropVal::Str(s) => color = Some(s),
                LucidePropVal::Num(n) => color = Some(n.to_string()),
                LucidePropVal::Dynamic => return Ok(None),
            },
            "strokeWidth" => match lucide_prop_value(&jsx_attr.value, scope)? {
                LucidePropVal::Num(n) => stroke_width = Some(n.to_string()),
                LucidePropVal::Str(s) => stroke_width = Some(s),
                LucidePropVal::Dynamic => return Ok(None),
            },
            "className" => match lucide_prop_value(&jsx_attr.value, scope)? {
                LucidePropVal::Str(s) => {
                    if !s.is_empty() {
                        class_name = Some(s);
                    }
                }
                // A numeric className is nonsensical; defer.
                LucidePropVal::Num(_) | LucidePropVal::Dynamic => return Ok(None),
            },
            // Presence of absoluteStrokeWidth changes stroke-width math → T3.
            "absoluteStrokeWidth" => return Ok(None),
            // Passthrough: aria-*, role, data-*, and any other plain attribute.
            _ => {
                if name == "role" || name.starts_with("aria-") {
                    has_aria_or_role = true;
                }
                let value = match lucide_prop_value(&jsx_attr.value, scope)? {
                    LucidePropVal::Str(s) => {
                        if jsx_attr.value.is_none() {
                            AttrValue::Empty
                        } else {
                            AttrValue::Static(s)
                        }
                    }
                    LucidePropVal::Num(n) => AttrValue::StaticNum(n),
                    LucidePropVal::Dynamic => {
                        // Re-lower to keep the dynamic expr verbatim (static is
                        // enough for T2 but emitting it is harmless and lossless).
                        match &jsx_attr.value {
                            Some(JSXAttrValue::JSXExprContainer(c)) => match &c.expr {
                                JSXExpr::Expr(e) => AttrValue::Expr(lower_expr(e, scope)?),
                                JSXExpr::JSXEmptyExpr(_) => {
                                    return Err(LowerError::at(
                                        c.span,
                                        ErrorKind::JsxInAttrNotSupported,
                                    ));
                                }
                            },
                            _ => {
                                return Err(LowerError::at(
                                    jsx_attr.span,
                                    ErrorKind::JsxInAttrNotSupported,
                                ));
                            }
                        }
                    }
                };
                passthrough.push(JsxAttr { name, value });
            }
        }
    }

    // Build the SVG attrs in the FIXED golden order.
    let width = size.unwrap_or(24);
    let stroke = color.unwrap_or_else(|| "currentColor".to_string());
    let sw = stroke_width.unwrap_or_else(|| "2".to_string());

    let mut attrs: Vec<JsxAttr> = Vec::new();
    let st = |n: &str, v: &str| JsxAttr {
        name: n.to_string(),
        value: AttrValue::Static(v.to_string()),
    };
    attrs.push(st("xmlns", "http://www.w3.org/2000/svg"));
    attrs.push(JsxAttr {
        name: "width".into(),
        value: AttrValue::StaticNum(width),
    });
    attrs.push(JsxAttr {
        name: "height".into(),
        value: AttrValue::StaticNum(width),
    });
    attrs.push(st("viewBox", "0 0 24 24"));
    attrs.push(st("fill", "none"));
    attrs.push(JsxAttr {
        name: "stroke".into(),
        value: AttrValue::Static(stroke),
    });
    attrs.push(JsxAttr {
        name: "stroke-width".into(),
        value: AttrValue::Static(sw),
    });
    attrs.push(st("stroke-linecap", "round"));
    attrs.push(st("stroke-linejoin", "round"));
    // aria-hidden unless the call-site supplies any aria-* / role prop.
    if !has_aria_or_role {
        attrs.push(st("aria-hidden", "true"));
    }
    // Passthrough props in source order.
    attrs.extend(passthrough);
    // class LAST: icon class + optional static className.
    let class = match &class_name {
        Some(c) => format!("{} {}", icon.cls, c),
        None => icon.cls.clone(),
    };
    attrs.push(JsxAttr {
        name: "class".into(),
        value: AttrValue::Static(class),
    });

    // Children: each (tag, attrs) in icon.node → a childless host element.
    let children: Vec<JsxNode> = icon
        .node
        .iter()
        .map(|(tag, child_attrs)| JsxNode::Element {
            tag: tag.clone(),
            attrs: child_attrs
                .iter()
                .map(|(k, v)| JsxAttr {
                    name: k.clone(),
                    value: AttrValue::Static(v.clone()),
                })
                .collect(),
            children: vec![],
        })
        .collect();

    Ok(Some(JsxNode::Element {
        tag: "svg".into(),
        attrs,
        children,
    }))
}

fn lower_ssr_component(
    el: &JSXElement,
    component_name: &str,
    scope: &Scope,
    in_map: bool,
    doc_root: bool,
) -> Result<JsxNode, LowerError> {
    if in_map {
        return Err(LowerError::at(
            el.opening.span,
            ErrorKind::SsrComponentInMapNotSupported(component_name.to_owned()),
        ));
    }
    let component = component_name.to_owned();

    // Lucide native static-SVG: if this capitalised tag is a registered lucide
    // icon, try to emit a static `<svg>` for the static-prop cases. Dynamic
    // props / class-merge-with-dynamic-className / spread soft-fallback (T3)
    // return `Ok(None)` here and fall through to the SSR path below.
    if let Some(lenv) = &scope.lucide_env
        && let Some(icon) = lenv.icons.get(component_name)
    {
        match build_lucide_svg(el, icon, scope)? {
            Some(node) => return Ok(node),
            None => { /* T3: soft-fallback. Fall through to the SSR path below. */ }
        }
    }

    let mut props: Vec<SsrProp> = Vec::new();
    let mut key_path: Option<String> = None;
    let mut key_literal: Option<String> = None;
    let mut tags_path: Option<String> = None;
    let mut tags_literal: Option<Vec<String>> = None;
    let mut revalidate: Option<u32> = None;
    // T6: detect bare `native` attribute before the attr loop.
    let has_native = has_native_attr(el);

    // T6: collect call-site children for possible splicing. The fragment guard is
    // DEFERRED to the SSR-emission points below (see `subtree_contains_fragment`
    // checks). A fragment anywhere in the child subtree is unrepresentable by the
    // React factory emitter (see `emit_factory::emit_child`) — but on the
    // native-INLINE success path the children are spliced into jinja (which CAN
    // represent a fragment) and never reach the factory. So the check must fire
    // only when this component actually emits as a `JsxNode::SsrComponent`, not
    // eagerly during collection (which would reject a perfectly valid native
    // layout wrapping conditional `{cond ? <x/> : <>…</>}` content).
    let mut call_site_children: Vec<JsxNode> = Vec::new();
    for child in &el.children {
        if let Some(node) = lower_child(child, scope, in_map)? {
            call_site_children.push(node);
        }
    }

    // T6: native inline branch — only when `native` present AND env is available.
    if has_native && let Some(env) = &scope.inline_env {
        // Detect isr presence and spreads; build subst map from call-site attrs.
        let mut has_isr = false;
        let mut has_spread = false;
        let mut subst: HashMap<String, crate::ir::Expr> = HashMap::new();
        let mut subst_err = false;

        for attr in &el.opening.attrs {
            match attr {
                JSXAttrOrSpread::SpreadElement(_) => {
                    has_spread = true;
                }
                JSXAttrOrSpread::JSXAttr(jsx_attr) => {
                    let name = match &jsx_attr.name {
                        JSXAttrName::Ident(id) => id.sym.to_string(),
                        JSXAttrName::JSXNamespacedName(n) => {
                            return Err(LowerError::at(
                                n.span,
                                ErrorKind::NamespacedAttrNotSupported,
                            ));
                        }
                    };
                    match name.as_str() {
                        "native" | "key" => continue,
                        "isr" => {
                            // Validate isr syntax (errors out if malformed).
                            let err_fn = || {
                                LowerError::at(
                                    jsx_attr.span,
                                    ErrorKind::ComponentIsrUnsupported(component.clone()),
                                )
                            };
                            // Parse to validate; we only need presence for has_isr.
                            parse_isr_object(jsx_attr, scope, &err_fn)?;
                            has_isr = true;
                            continue;
                        }
                        "ref" => {
                            return Err(LowerError::at(
                                jsx_attr.span,
                                ErrorKind::RefAttributeNotSupported,
                            ));
                        }
                        _ if is_event_handler(&name) => {
                            return Err(LowerError::at(
                                jsx_attr.span,
                                ErrorKind::EventHandlerNotSupported(name),
                            ));
                        }
                        _ => {}
                    }
                    // Lower value to an Expr for subst.
                    let expr_result = match &jsx_attr.value {
                        None => Ok(crate::ir::Expr::StaticText(String::new())), // bare bool attr
                        Some(JSXAttrValue::Str(s)) => Ok(crate::ir::Expr::StaticText(
                            s.value.to_string_lossy().into_owned(),
                        )),
                        Some(JSXAttrValue::JSXExprContainer(c)) => match &c.expr {
                            JSXExpr::JSXEmptyExpr(_) => {
                                Err(LowerError::at(c.span, ErrorKind::JsxInAttrNotSupported))
                            }
                            JSXExpr::Expr(e) => lower_expr(e, scope),
                        },
                        _ => Err(LowerError::at(
                            jsx_attr.span,
                            ErrorKind::JsxInAttrNotSupported,
                        )),
                    };
                    match expr_result {
                        Ok(expr) => {
                            subst.insert(name, expr);
                        }
                        Err(_) => {
                            subst_err = true;
                        }
                    }
                }
            }
        }

        // Try to inline. Returns Ok(Some(node)) on success, Ok(None) on
        // soft fallback (warns pushed to env), Err on hard error (cycle).
        let inline_result = try_native_inline(
            &component,
            env,
            scope.lucide_env.clone(),
            subst,
            has_spread,
            subst_err,
            &call_site_children,
            has_isr,
            el.opening.span,
            doc_root,
        )?;

        if let Some(node) = inline_result {
            return Ok(node);
        }

        // Fall through to SSR component emission, using isr fields if present.
        // Children now flow into the React factory emitter — apply the deferred
        // fragment guard here (the native-inline success path returned above).
        if call_site_children.iter().any(subtree_contains_fragment) {
            return Err(LowerError::at(
                el.opening.span,
                ErrorKind::FragmentInSsrComponentNotSupported,
            ));
        }
        // Rebuild props without native/isr attrs.
        let mut ssr_props: Vec<SsrProp> = Vec::new();
        let mut ssr_key_path: Option<String> = None;
        let mut ssr_key_literal: Option<String> = None;
        let mut ssr_tags_path: Option<String> = None;
        let mut ssr_tags_literal: Option<Vec<String>> = None;
        let mut ssr_revalidate: Option<u32> = None;

        for attr in &el.opening.attrs {
            let jsx_attr = match attr {
                JSXAttrOrSpread::JSXAttr(a) => a,
                JSXAttrOrSpread::SpreadElement(s) => {
                    let expr = lower_expr(&s.expr, scope)?;
                    ssr_props.push(SsrProp::Spread(expr));
                    continue;
                }
            };
            let name = match &jsx_attr.name {
                JSXAttrName::Ident(id) => id.sym.to_string(),
                JSXAttrName::JSXNamespacedName(n) => {
                    return Err(LowerError::at(
                        n.span,
                        ErrorKind::NamespacedAttrNotSupported,
                    ));
                }
            };
            match name.as_str() {
                "key" | "native" => continue,
                "isr" => {
                    let err_fn = || {
                        LowerError::at(
                            jsx_attr.span,
                            ErrorKind::ComponentIsrUnsupported(component.clone()),
                        )
                    };
                    let p = parse_isr_object(jsx_attr, scope, &err_fn)?;
                    ssr_key_path = p.key_path;
                    ssr_key_literal = p.key_literal;
                    ssr_tags_path = p.tags_path;
                    ssr_tags_literal = p.tags_literal;
                    ssr_revalidate = p.revalidate;
                    continue;
                }
                "ref" => {
                    return Err(LowerError::at(
                        jsx_attr.span,
                        ErrorKind::RefAttributeNotSupported,
                    ));
                }
                _ if is_event_handler(&name) => {
                    return Err(LowerError::at(
                        jsx_attr.span,
                        ErrorKind::EventHandlerNotSupported(name),
                    ));
                }
                _ => {}
            }
            let value = match &jsx_attr.value {
                None => AttrValue::Empty,
                Some(JSXAttrValue::Str(s)) => {
                    AttrValue::Static(s.value.to_string_lossy().into_owned())
                }
                Some(JSXAttrValue::JSXExprContainer(c)) => match &c.expr {
                    JSXExpr::JSXEmptyExpr(_) => {
                        return Err(LowerError::at(c.span, ErrorKind::JsxInAttrNotSupported));
                    }
                    JSXExpr::Expr(e) => match lower_expr(e, scope)? {
                        crate::ir::Expr::StaticNum(n) => AttrValue::StaticNum(n),
                        crate::ir::Expr::StaticText(s) => AttrValue::Static(s),
                        expr => AttrValue::Expr(expr),
                    },
                },
                _ => {
                    return Err(LowerError::at(
                        jsx_attr.span,
                        ErrorKind::JsxInAttrNotSupported,
                    ));
                }
            };
            ssr_props.push(SsrProp::Attr(JsxAttr { name, value }));
        }

        return Ok(JsxNode::SsrComponent {
            component,
            instance: 0,
            props: ssr_props,
            children: call_site_children,
            key_path: ssr_key_path,
            key_literal: ssr_key_literal,
            tags_path: ssr_tags_path,
            tags_literal: ssr_tags_literal,
            revalidate: ssr_revalidate,
        });
    }

    // Standard (non-native) SSR component path. Children flow into the React
    // factory emitter — apply the deferred fragment guard.
    if call_site_children.iter().any(subtree_contains_fragment) {
        return Err(LowerError::at(
            el.opening.span,
            ErrorKind::FragmentInSsrComponentNotSupported,
        ));
    }
    for attr in &el.opening.attrs {
        // Spread `{...expr}` is valid on an SSR component (the factory is JS
        // createElement, so it becomes a JS object spread). The spread argument
        // lowers through the same expr rules as a named-prop value.
        let jsx_attr = match attr {
            JSXAttrOrSpread::JSXAttr(a) => a,
            JSXAttrOrSpread::SpreadElement(s) => {
                let expr = lower_expr(&s.expr, scope)?;
                props.push(SsrProp::Spread(expr));
                continue;
            }
        };
        let name = match &jsx_attr.name {
            JSXAttrName::Ident(id) => id.sym.to_string(),
            JSXAttrName::JSXNamespacedName(n) => {
                return Err(LowerError::at(
                    n.span,
                    ErrorKind::NamespacedAttrNotSupported,
                ));
            }
        };
        match name.as_str() {
            "key" => continue,
            "isr" => {
                let err = || {
                    LowerError::at(
                        jsx_attr.span,
                        ErrorKind::ComponentIsrUnsupported(component.clone()),
                    )
                };
                let p = parse_isr_object(jsx_attr, scope, &err)?;
                key_path = p.key_path;
                key_literal = p.key_literal;
                tags_path = p.tags_path;
                tags_literal = p.tags_literal;
                revalidate = p.revalidate;
                continue;
            }
            "ref" => {
                return Err(LowerError::at(
                    jsx_attr.span,
                    ErrorKind::RefAttributeNotSupported,
                ));
            }
            _ if is_event_handler(&name) => {
                return Err(LowerError::at(
                    jsx_attr.span,
                    ErrorKind::EventHandlerNotSupported(name),
                ));
            }
            _ => {}
        }
        let value = match &jsx_attr.value {
            None => AttrValue::Empty,
            Some(JSXAttrValue::Str(s)) => AttrValue::Static(s.value.to_string_lossy().into_owned()),
            Some(JSXAttrValue::JSXExprContainer(c)) => match &c.expr {
                JSXExpr::JSXEmptyExpr(_) => {
                    return Err(LowerError::at(c.span, ErrorKind::JsxInAttrNotSupported));
                }
                JSXExpr::Expr(e) => match lower_expr(e, scope)? {
                    crate::ir::Expr::StaticNum(n) => AttrValue::StaticNum(n),
                    crate::ir::Expr::StaticText(s) => AttrValue::Static(s),
                    expr => AttrValue::Expr(expr),
                },
            },
            _ => {
                return Err(LowerError::at(
                    jsx_attr.span,
                    ErrorKind::JsxInAttrNotSupported,
                ));
            }
        };
        props.push(SsrProp::Attr(JsxAttr { name, value }));
    }

    Ok(JsxNode::SsrComponent {
        component,
        instance: 0,
        props,
        children: call_site_children,
        key_path,
        key_literal,
        tags_path,
        tags_literal,
        revalidate,
    })
}

/// Try to native-inline a component. Returns:
/// - `Ok(Some(node))` — successfully inlined.
/// - `Ok(None)` — soft fallback (warnings pushed to `env`); caller emits SSR component.
/// - `Err(LowerError)` — hard error (only `CircularInline` for now).
#[allow(clippy::too_many_arguments)]
fn try_native_inline(
    component: &str,
    env: &Rc<InlineEnv>,
    lucide: Option<Rc<LucideEnv>>,
    subst: HashMap<String, crate::ir::Expr>,
    has_spread: bool,
    subst_err: bool,
    call_site_children: &[JsxNode],
    has_isr: bool,
    span: Span,
    doc_root: bool,
) -> Result<Option<JsxNode>, LowerError> {
    use crate::analyze::{Inlinability, analyze};

    // 1. Resolve source.
    let source = match env.sources.get(component) {
        Some(s) => s.clone(),
        None => {
            env.warnings.borrow_mut().push(format!(
                "native component \"{}\" not inlined: source unresolved",
                component
            ));
            return Ok(None);
        }
    };

    // 2. Spread or subst error → warn + fallback.
    if has_spread || subst_err {
        env.warnings.borrow_mut().push(format!(
            "native component \"{}\" not inlined: unsupported prop",
            component
        ));
        return Ok(None);
    }

    // 3. Parse.
    let parsed_comp = match crate::parser::parse(&source, "<inline>") {
        Ok(p) => p,
        Err(_) => {
            env.warnings.borrow_mut().push(format!(
                "native component \"{}\" not inlined: parse error",
                component
            ));
            return Ok(None);
        }
    };

    // 4. Analyze.
    let (_, fn_expr) = match find_default_export(&parsed_comp.module) {
        Ok(r) => r,
        Err(_) => {
            env.warnings.borrow_mut().push(format!(
                "native component \"{}\" not inlined: parse error",
                component
            ));
            return Ok(None);
        }
    };
    let body = match fn_expr.function.body.as_ref() {
        Some(b) => b,
        None => {
            env.warnings.borrow_mut().push(format!(
                "native component \"{}\" not inlined: parse error",
                component
            ));
            return Ok(None);
        }
    };
    if let Inlinability::Fallback(reason) = analyze(body) {
        env.warnings.borrow_mut().push(format!(
            "native component \"{}\" not inlined: {}",
            component, reason
        ));
        return Ok(None);
    }

    // 5. Cycle check — hard error.
    if env.cycle.borrow().contains(&component.to_string()) {
        let path = format!("{} → {}", env.cycle.borrow().join(" → "), component);
        return Err(LowerError::at(span, ErrorKind::CircularInline(path)));
    }
    env.cycle.borrow_mut().push(component.to_string());

    // 6. Lower inline. Propagate hard errors (e.g. CircularInline) upward;
    // convert soft lowering errors to a warning + fallback.
    let has_children = !call_site_children.is_empty();
    let nodes = match lower_component_inline(
        &parsed_comp,
        subst,
        has_children,
        Some(env.clone()),
        lucide,
        doc_root,
    ) {
        Ok(n) => n,
        Err(e) => {
            // CircularInline and OutletMustBeEmpty are hard authoring errors —
            // propagate immediately rather than degrading to a fallback warning.
            if matches!(
                e.kind,
                ErrorKind::CircularInline(_) | ErrorKind::OutletMustBeEmpty
            ) {
                env.cycle.borrow_mut().pop();
                return Err(e);
            }
            let msg = if let ErrorKind::InlineUntranslatable(s) = &e.kind {
                format!(
                    "native component \"{}\" not inlined: untranslatable ({})",
                    component, s
                )
            } else {
                format!(
                    "native component \"{}\" not inlined: unsupported prop",
                    component
                )
            };
            env.warnings.borrow_mut().push(msg);
            env.cycle.borrow_mut().pop();
            return Ok(None);
        }
    };

    // 7. Expect exactly 1 root node.
    if nodes.len() != 1 {
        env.warnings.borrow_mut().push(format!(
            "native component \"{}\" unexpected multi-root",
            component
        ));
        env.cycle.borrow_mut().pop();
        return Ok(None);
    }

    let mut root_node = nodes.into_iter().next().unwrap();

    // 8. Splice children slots.
    splice_children_slots(&mut root_node, call_site_children);

    // 9. Pop cycle stack.
    env.cycle.borrow_mut().pop();

    // 10. Warn if isr was present (ignored on inlined component).
    if has_isr {
        env.warnings.borrow_mut().push(format!(
            "isr ignored on inlined native component \"{}\"",
            component
        ));
    }

    Ok(Some(root_node))
}

/// Recursively replace every `JsxNode::ChildrenSlot` in a tree with the given
/// `children` nodes (spliced in-place into the parent's children vec).
fn splice_children_slots(node: &mut JsxNode, children: &[JsxNode]) {
    match node {
        JsxNode::Element {
            children: node_children,
            ..
        } => {
            // Splice any ChildrenSlot entries.
            let mut i = 0;
            while i < node_children.len() {
                if matches!(node_children[i], JsxNode::ChildrenSlot) {
                    // Replace the slot with the call-site children.
                    node_children.remove(i);
                    for (j, c) in children.iter().enumerate() {
                        node_children.insert(i + j, c.clone());
                    }
                    i += children.len();
                } else {
                    splice_children_slots(&mut node_children[i], children);
                    i += 1;
                }
            }
        }
        JsxNode::Cond {
            consequent,
            alternate,
            ..
        } => {
            splice_children_slots(consequent, children);
            if let Some(alt) = alternate {
                splice_children_slots(alt, children);
            }
        }
        JsxNode::Map { body, .. } => {
            splice_children_slots(body, children);
        }
        JsxNode::Document { body, .. } => {
            let mut i = 0;
            while i < body.len() {
                if matches!(body[i], JsxNode::ChildrenSlot) {
                    body.remove(i);
                    for (j, c) in children.iter().enumerate() {
                        body.insert(i + j, c.clone());
                    }
                    i += children.len();
                } else {
                    splice_children_slots(&mut body[i], children);
                    i += 1;
                }
            }
        }
        JsxNode::Fragment {
            children: frag_children,
        } => {
            let mut i = 0;
            while i < frag_children.len() {
                if matches!(frag_children[i], JsxNode::ChildrenSlot) {
                    frag_children.remove(i);
                    for (j, c) in children.iter().enumerate() {
                        frag_children.insert(i + j, c.clone());
                    }
                    i += children.len();
                } else {
                    splice_children_slots(&mut frag_children[i], children);
                    i += 1;
                }
            }
        }
        // Leaf nodes — nothing to splice.
        JsxNode::Empty
        | JsxNode::Text(_)
        | JsxNode::Expr(_)
        | JsxNode::RawHtml(_)
        | JsxNode::Island { .. }
        | JsxNode::SsrComponent { .. }
        | JsxNode::ChildrenSlot => {}
    }
}

/// HTML void elements per spec S4 / WHATWG. T6 rejects children on these.
fn is_void_element(tag: &str) -> bool {
    matches!(
        tag,
        "area"
            | "base"
            | "br"
            | "col"
            | "embed"
            | "hr"
            | "img"
            | "input"
            | "keygen"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    )
}

/// React → HTML attribute rename table. Names not listed here that contain an
/// uppercase letter are rejected as `UnknownAttributeRename`.
fn rename_attr(name: &str) -> Option<&'static str> {
    Some(match name {
        "className" => "class",
        "htmlFor" => "for",
        "charSet" => "charset",
        "tabIndex" => "tabindex",
        "crossOrigin" => "crossorigin",
        "readOnly" => "readonly",
        "maxLength" => "maxlength",
        "colSpan" => "colspan",
        "rowSpan" => "rowspan",
        "srcSet" => "srcset",
        _ => return None,
    })
}

/// Lower a `<Island …/>` element into `JsxNode::Island`.
///
/// Recognized attributes:
/// - `component={Ident}` — REQUIRED. The ident's sym is the DEFAULT island id.
///   Extracted by a dedicated walker (NOT `lower_expr`, which would reject the
///   bare, non-destructured `Counter` as `UnresolvedIdent`). A non-Ident expr,
///   a missing value, or an absent `component` → `IslandMissingComponent`.
/// - `id="literal"` — OPTIONAL string literal; overrides the default id.
/// - `props={path}` — REQUIRED single-segment path (see `island_props_path`).
/// - `hydrate="literal"` — OPTIONAL; default `"load"`; must be one of
///   load/idle/visible/interaction (else `IslandBadHydrate`).
/// - `ssr` — OPTIONAL bare boolean attribute; presence → `ssr: true`.
///
/// Rejected UNDER a `.map(...)` (`in_map == true`) with `IslandInMapNotSupported`
/// — checked FIRST, before any attribute parsing, so the map diagnostic always
/// wins over an attribute error.
fn lower_island(el: &JSXElement, scope: &Scope, in_map: bool) -> Result<JsxNode, LowerError> {
    if in_map {
        return Err(LowerError::at(
            el.opening.span,
            ErrorKind::IslandInMapNotSupported,
        ));
    }

    // `<Island>` must be self-closing — meaningful children would be silently
    // dropped (the island component renders client-side from its chunk, not from
    // JSX here). Whitespace-only text between tags (`<Island>\n</Island>`) is
    // tolerated; anything else (text, elements, exprs) is an error.
    let has_meaningful_child = el.children.iter().any(|c| match c {
        JSXElementChild::JSXText(t) => !t.value.trim().is_empty(),
        _ => true,
    });
    if has_meaningful_child {
        return Err(LowerError::at(
            el.opening.span,
            ErrorKind::IslandHasChildren,
        ));
    }

    let mut component: Option<(String, Span)> = None;
    let mut props_path: Option<String> = None;
    let mut hydrate: Option<String> = None;
    let mut ssr = false;
    let mut key_path: Option<String> = None;
    let mut key_literal: Option<String> = None;
    let mut tags_path: Option<String> = None;
    let mut tags_literal: Option<Vec<String>> = None;
    let mut revalidate: Option<u32> = None;

    for attr in &el.opening.attrs {
        // Spread on an island (`<Island {...x}/>`) is not a recognized attribute.
        let JSXAttrOrSpread::JSXAttr(jsx_attr) = attr else {
            return Err(LowerError::at(
                el.opening.span,
                ErrorKind::SpreadAttributeNotSupported,
            ));
        };
        let name = match &jsx_attr.name {
            JSXAttrName::Ident(name) => name.sym.to_string(),
            JSXAttrName::JSXNamespacedName(n) => {
                return Err(LowerError::at(
                    n.span,
                    ErrorKind::NamespacedAttrNotSupported,
                ));
            }
        };

        match name.as_str() {
            "component" => {
                component = Some((island_component_ident(jsx_attr)?, jsx_attr.span));
            }
            // `id=` is no longer supported — islands are addressed by the
            // `component={…}` ident (chunk key) + a source-order instance index.
            // This explicit reject arm MUST precede the `_ => {}` fall-through;
            // without it, `id=` would be silently dropped.
            "id" => {
                return Err(LowerError::at(
                    jsx_attr.span,
                    ErrorKind::IslandIdAttrRemoved,
                ));
            }
            "props" => {
                props_path = Some(island_props_path(jsx_attr, scope)?);
            }
            "hydrate" => {
                let value = match &jsx_attr.value {
                    Some(JSXAttrValue::Str(s)) => s.value.to_string_lossy().into_owned(),
                    _ => {
                        return Err(LowerError::at(
                            jsx_attr.span,
                            ErrorKind::IslandBadHydrate(String::new()),
                        ));
                    }
                };
                if !matches!(value.as_str(), "load" | "idle" | "visible" | "interaction") {
                    return Err(LowerError::at(
                        jsx_attr.span,
                        ErrorKind::IslandBadHydrate(value),
                    ));
                }
                hydrate = Some(value);
            }
            "ssr" => {
                // Bare boolean attribute — presence is what matters.
                ssr = true;
            }
            // `isr={{ key: <path>, tags?: <path>, revalidate?: <number-literal> }}`.
            // `key`/`tags` accept the SAME path shape as `props={…}` (a
            // destructured ident or one-deep member); `revalidate` is a numeric
            // literal only. ssr-required is enforced after the attr loop.
            "isr" => {
                let err = || LowerError::at(jsx_attr.span, ErrorKind::IslandIsrUnsupported);
                let p = parse_isr_object(jsx_attr, scope, &err)?;
                key_path = p.key_path;
                key_literal = p.key_literal;
                tags_path = p.tags_path;
                tags_literal = p.tags_literal;
                revalidate = p.revalidate;
            }
            // Unknown attributes on an island are ignored (forward-compatible);
            // T3 owns the full attribute vocabulary.
            _ => {}
        }
    }

    let (component, component_span) = component
        .ok_or_else(|| LowerError::at(el.opening.span, ErrorKind::IslandMissingComponent))?;
    // The component ident becomes both the chunk filename and the DOM marker
    // value, so it must match `[A-Za-z0-9_]+`. JS idents permit `$`, which is
    // rejected here.
    if component.is_empty()
        || !component
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err(LowerError::at(
            component_span,
            ErrorKind::IslandBadComponentName(component.clone()),
        ));
    }
    // `props` is OPTIONAL: a propless island (`<Island component={X} hydrate=…/>`)
    // lowers to an empty props_path. The emitters render that as `island_<n>_props`
    // = `{}` (resolveIslandContext) and `props: {}` (factory). A PRESENT-but-invalid
    // `props={…}` still errors inside `island_props_path` above — omit the attr to
    // pass empty props.
    let props_path = props_path.unwrap_or_default();
    let hydrate = hydrate.unwrap_or_else(|| "load".to_string());

    // ISR caching only applies to SSR'd islands — caching a client-only island
    // is meaningless. Reject any isr field without `ssr`.
    if (key_path.is_some()
        || key_literal.is_some()
        || tags_path.is_some()
        || tags_literal.is_some()
        || revalidate.is_some())
        && !ssr
    {
        return Err(LowerError::at(
            el.opening.span,
            ErrorKind::IslandIsrUnsupported,
        ));
    }

    Ok(JsxNode::Island {
        component,
        instance: 0,
        props_path,
        hydrate,
        ssr,
        key_path,
        key_literal,
        tags_path,
        tags_literal,
        revalidate,
    })
}

/// Extract the `component={Ident}` name. The container shape is
/// `JSXExprContainer(JSXExpr::Expr(SwcExpr::Ident))`; anything else (member,
/// call, missing value) → `IslandMissingComponent`.
fn island_component_ident(jsx_attr: &swc_core::ecma::ast::JSXAttr) -> Result<String, LowerError> {
    match &jsx_attr.value {
        Some(JSXAttrValue::JSXExprContainer(c)) => match &c.expr {
            JSXExpr::Expr(e) => match e.as_ref() {
                SwcExpr::Ident(id) => Ok(id.sym.to_string()),
                _ => Err(LowerError::at(c.span, ErrorKind::IslandMissingComponent)),
            },
            JSXExpr::JSXEmptyExpr(_) => {
                Err(LowerError::at(c.span, ErrorKind::IslandMissingComponent))
            }
        },
        _ => Err(LowerError::at(
            jsx_attr.span,
            ErrorKind::IslandMissingComponent,
        )),
    }
}

/// Extract the `props={…}` path string into the jinja context (≤ 1 member deep).
///
/// Accepts only:
/// - `Ident(x)` where `x ∈ scope.destructured` → `"x"`.
/// - `Member` exactly one deep off a destructured root (`data.counter`,
///   `data ∈ scope.destructured`) → `"data.counter"` (FULL dotted path, root
///   included). The jinja context root is the loader return whose top-level keys
///   are the destructured prop names; the runtime resolves
///   `pathInto(loaderReturn, props_path)`, so the root must be kept.
///
/// Rejects (all → `IslandPropsPathUnsupported`): deeper chains (`data.a.b`),
/// props rooted at a map binding, unresolved roots, computed access, non-Ident
/// roots, and any non-`{expr}` value. Deliberately NOT routed through
/// `lower_member` (which accepts map-bound roots and deeper chains).
///
/// INLINE MODE (T6): when `scope.inline` is set, a bare `Ident(x)` that is a
/// key in the inline `subst` map is remapped through the substitution BEFORE
/// computing the path:
/// - `Expr::Field(name)` or `Expr::MapBinding(name)` → use `name` as path.
/// - `Expr::MemberAccess { root, path }` → join as `root.path[0]…` (full
///   dotted path, mirrors what `expr_to_path` returns for a direct member).
/// - Any other `Expr` (literal, arith, etc.) → not a valid island props source
///   → `IslandPropsPathUnsupported`.
///
/// Non-inline behavior is byte-identical to pre-T6.
fn island_props_path(
    jsx_attr: &swc_core::ecma::ast::JSXAttr,
    scope: &Scope,
) -> Result<String, LowerError> {
    let err = || LowerError::at(jsx_attr.span, ErrorKind::IslandPropsPathUnsupported);

    let Some(JSXAttrValue::JSXExprContainer(c)) = &jsx_attr.value else {
        return Err(err());
    };
    let JSXExpr::Expr(e) = &c.expr else {
        return Err(err());
    };

    // INLINE MODE: if the expression is a bare ident that maps through the
    // inline subst, remap to the call-site Expr and derive the path from it.
    if let Some(ctx) = &scope.inline
        && let SwcExpr::Ident(id) = strip_paren(e.as_ref())
    {
        let name = id.sym.to_string();
        if let Some(substituted) = ctx.subst.get(&name) {
            return match substituted {
                // Bare call-site field (destructured prop name) → use directly.
                crate::ir::Expr::Field(field_name) => Ok(field_name.clone()),
                // Call-site map binding → use directly (e.g. item in a .map).
                crate::ir::Expr::MapBinding(binding_name) => Ok(binding_name.clone()),
                // Call-site member access: `root.seg0.seg1…` — join into dotted
                // path. This mirrors what `expr_to_path` returns for a member expr.
                crate::ir::Expr::MemberAccess { root, path } => {
                    let mut parts = vec![root.as_str()];
                    parts.extend(path.iter().map(|s| s.as_str()));
                    Ok(parts.join("."))
                }
                // Any other Expr (literal, arith, concat, …) is not a valid
                // island props source — fall back with unsupported.
                _ => Err(err()),
            };
        }
    }

    expr_to_path(e.as_ref(), scope, &err)
}

/// Parse an `isr={{ key, tags?, revalidate? }}` attribute object into
/// `(key_path, tags_path, revalidate)`. Shared by `lower_island` and
/// `lower_ssr_component`. `key` is MANDATORY (a missing key is an `err()`
/// return, never a `None`), hence the non-optional `String` first element.
/// `key`/`tags` accept the same path shape as `props={…}` (destructured ident
/// or one-deep member, via `expr_to_path`); `revalidate` is a non-negative
/// integer literal ≤ u32::MAX/1000 (a larger value would wrap when sent as
/// `revalidate * 1000` ms across NAPI). `err` produces the caller's error
/// variant so a bad isr blames the right element (island vs component).
/// Parsed `isr={{…}}` fields. `key` is mandatory and is EITHER a literal
/// (`key_literal`) or a loader-data path (`key_path`) — exactly one is `Some`.
/// `tags` is optional and likewise either `tags_literal` or `tags_path`.
struct IsrParsed {
    key_path: Option<String>,
    key_literal: Option<String>,
    tags_path: Option<String>,
    tags_literal: Option<Vec<String>>,
    revalidate: Option<u32>,
}

fn parse_isr_object(
    jsx_attr: &swc_core::ecma::ast::JSXAttr,
    scope: &Scope,
    err: &dyn Fn() -> LowerError,
) -> Result<IsrParsed, LowerError> {
    let Some(JSXAttrValue::JSXExprContainer(c)) = &jsx_attr.value else {
        return Err(err());
    };
    let JSXExpr::Expr(e) = &c.expr else {
        return Err(err());
    };
    let SwcExpr::Object(obj) = strip_paren(e.as_ref()) else {
        return Err(err());
    };
    let mut key_path: Option<String> = None;
    let mut key_literal: Option<String> = None;
    let mut tags_path: Option<String> = None;
    let mut tags_literal: Option<Vec<String>> = None;
    let mut revalidate: Option<u32> = None;
    for prop in &obj.props {
        let PropOrSpread::Prop(p) = prop else {
            return Err(err());
        };
        let Prop::KeyValue(kv) = p.as_ref() else {
            return Err(err());
        };
        let pname = match &kv.key {
            PropName::Ident(i) => i.sym.to_string(),
            PropName::Str(s) => s.value.to_string_lossy().into_owned(),
            _ => return Err(err()),
        };
        match pname.as_str() {
            "key" => {
                if key_path.is_some() || key_literal.is_some() {
                    return Err(err());
                }
                if let SwcExpr::Lit(Lit::Str(s)) = strip_paren(&kv.value) {
                    key_literal = Some(s.value.to_string_lossy().into_owned());
                } else {
                    key_path = Some(expr_to_path(&kv.value, scope, err)?);
                }
            }
            "tags" => {
                if tags_path.is_some() || tags_literal.is_some() {
                    return Err(err());
                }
                if let SwcExpr::Array(arr) = strip_paren(&kv.value) {
                    let arr: &ArrayLit = arr;
                    let mut lits = Vec::new();
                    for el in &arr.elems {
                        // No holes, no spreads; every element must be a string literal.
                        let Some(item) = el else {
                            return Err(err());
                        };
                        let item: &ExprOrSpread = item;
                        if item.spread.is_some() {
                            return Err(err());
                        }
                        let SwcExpr::Lit(Lit::Str(s)) = strip_paren(&item.expr) else {
                            return Err(err());
                        };
                        lits.push(s.value.to_string_lossy().into_owned());
                    }
                    tags_literal = Some(lits);
                } else {
                    tags_path = Some(expr_to_path(&kv.value, scope, err)?);
                }
            }
            "revalidate" => {
                let SwcExpr::Lit(Lit::Num(n)) = strip_paren(&kv.value) else {
                    return Err(err());
                };
                // Non-negative integer SECONDS. A bare `as u32` would silently
                // truncate (60.5 → 60) and saturate (-1 → 0, 1e12 → u32::MAX) —
                // turning a typo into a valid-but-wrong TTL. Upper bound is
                // u32::MAX/1000, not u32::MAX: the runtime sends `revalidate *
                // 1000` ms across NAPI as a u32, so a larger value would
                // silently wrap to a garbage TTL. Reject all of these.
                const MAX_REVALIDATE_SECS: f64 = (u32::MAX / 1000) as f64;
                if n.value < 0.0 || n.value.fract() != 0.0 || n.value > MAX_REVALIDATE_SECS {
                    return Err(err());
                }
                revalidate = Some(n.value as u32);
            }
            _ => return Err(err()),
        }
    }
    // `key` is mandatory — a tags-/revalidate-only isr has nothing to key by.
    if key_path.is_none() && key_literal.is_none() {
        return Err(err());
    }
    Ok(IsrParsed {
        key_path,
        key_literal,
        tags_path,
        tags_literal,
        revalidate,
    })
}

/// Extract a ≤ 1-member-deep loader-data path from a bare expression. This is
/// the reusable core shared by `island_props_path` (the `props={…}` attr) and
/// the `isr={{ key, tags }}` object-property parser — both accept the SAME path
/// shape. `err` produces the caller's error (props vs isr) so a bad path is
/// blamed on the right attribute.
///
/// Accepts only:
/// - `Ident(x)` where `x ∈ scope.destructured` → `"x"`.
/// - `Member` exactly one deep off a destructured root (`data.counter`) →
///   `"data.counter"` (FULL dotted path, root included).
///
/// Rejects (via `err`): deeper chains (`data.a.b`), unresolved roots, computed
/// access, non-Ident roots.
fn expr_to_path(
    e: &SwcExpr,
    scope: &Scope,
    err: &dyn Fn() -> LowerError,
) -> Result<String, LowerError> {
    match strip_paren(e) {
        // `counter` — bare destructured ident.
        SwcExpr::Ident(id) => {
            let name = id.sym.to_string();
            if scope.destructured.contains(&name) {
                Ok(name)
            } else {
                Err(err())
            }
        }
        // `data.counter` — exactly one-deep member off a destructured root.
        SwcExpr::Member(m) => {
            // Leaf segment must be a plain ident (no computed/private access).
            let MemberProp::Ident(leaf) = &m.prop else {
                return Err(err());
            };
            // Root must be a bare destructured Ident — a nested member (`data.a.b`)
            // or a map-bound root is rejected.
            let SwcExpr::Ident(root) = strip_paren(&m.obj) else {
                return Err(err());
            };
            let root_name = root.sym.to_string();
            if scope.destructured.contains(&root_name) {
                // FULL dotted path, root included (`data.counter`), NOT leaf-only.
                // The jinja context root IS the loader return whose top-level keys
                // are the destructured prop names (see NativeProfile fixture); the
                // runtime resolves `pathInto(loaderReturn, props_path)`. Leaf-only
                // would resolve `rt.counter` instead of the correct `rt.data.counter`.
                // This also matches what emit_jinja emits for `{{ data.counter }}`.
                Ok(format!("{root_name}.{}", leaf.sym))
            } else {
                Err(err())
            }
        }
        _ => Err(err()),
    }
}

fn lower_element_name(name: &JSXElementName) -> Result<String, LowerError> {
    match name {
        JSXElementName::Ident(ident) => {
            let s = ident.sym.to_string();
            if s.starts_with(|c: char| c.is_ascii_uppercase()) {
                Err(LowerError::at(
                    ident.span,
                    ErrorKind::CustomComponentNotSupported(s),
                ))
            } else {
                Ok(s)
            }
        }
        JSXElementName::JSXMemberExpr(e) => Err(LowerError::at(
            e.span,
            ErrorKind::MemberComponentNotSupported,
        )),
        JSXElementName::JSXNamespacedName(n) => Err(LowerError::at(
            n.span,
            ErrorKind::NamespacedElementNotSupported,
        )),
    }
}

/// Lower a JSX attribute with full T6 precedence:
///
/// 1. `key` → drop (return `Ok(None)`) — React-only; not part of HTML output.
/// 2. `ref` → `RefAttributeNotSupported`.
/// 3. `on[A-Z]…` → `EventHandlerNotSupported(name)` — Phase A3 will route these
///    through islands; for static SSR they're rejected.
/// 4. Name in rename table → emit with the renamed key.
/// 5. Name has any uppercase letter (not in rename table) →
///    `UnknownAttributeRename(name)` — catches `fooBar`, typos like `Class`.
/// 6. Otherwise → emit verbatim (lowercase HTML attribute, `data-*`, `aria-*`).
fn lower_attr(attr: &JSXAttrOrSpread, scope: &Scope) -> Result<Option<JsxAttr>, LowerError> {
    match attr {
        JSXAttrOrSpread::SpreadElement(s) => Err(LowerError::at(
            s.dot3_token,
            ErrorKind::SpreadAttributeNotSupported,
        )),
        JSXAttrOrSpread::JSXAttr(jsx_attr) => {
            // `JSXAttrName::Ident` wraps `IdentName` (NOT `Ident`) in swc_ecma_ast 25.
            let raw_name = match &jsx_attr.name {
                JSXAttrName::Ident(name) => name.sym.to_string(),
                JSXAttrName::JSXNamespacedName(n) => {
                    return Err(LowerError::at(
                        n.span,
                        ErrorKind::NamespacedAttrNotSupported,
                    ));
                }
            };

            // Precedence: REJECTS / DROPS first, RENAMES second, PASSTHROUGH last.
            // 1. key — silently dropped (React-only).
            if raw_name == "key" {
                return Ok(None);
            }
            // 2. ref — Phase A1 has no DOM nodes to ref into.
            if raw_name == "ref" {
                return Err(LowerError::at(
                    jsx_attr.span,
                    ErrorKind::RefAttributeNotSupported,
                ));
            }
            // 3. on[A-Z]… event handler — explicit pre-uppercase-check so it
            //    surfaces the more-specific error instead of UnknownAttributeRename.
            if is_event_handler(&raw_name) {
                return Err(LowerError::at(
                    jsx_attr.span,
                    ErrorKind::EventHandlerNotSupported(raw_name),
                ));
            }
            // 4. Rename table (className → class, etc.).
            // 5. Uppercase-in-name but not in table → UnknownAttributeRename.
            let final_name = match rename_attr(&raw_name) {
                Some(renamed) => renamed.to_string(),
                None => {
                    if raw_name.chars().any(|c| c.is_ascii_uppercase()) {
                        return Err(LowerError::at(
                            jsx_attr.span,
                            ErrorKind::UnknownAttributeRename(raw_name),
                        ));
                    }
                    raw_name
                }
            };

            // `style={{ … }}` object literal → serialize to a CSS declaration
            // string (static) or a Concat (when any value is a member-path).
            // Intercepted BEFORE the generic expr-lowering path, which has no
            // `Object` arm and would otherwise reject it.
            if final_name == "style"
                && let Some(JSXAttrValue::JSXExprContainer(c)) = &jsx_attr.value
                && let JSXExpr::Expr(e) = &c.expr
                && let SwcExpr::Object(obj) = strip_paren(e)
            {
                let value = lower_style_object(obj, scope)?;
                return Ok(Some(JsxAttr {
                    name: final_name,
                    value,
                }));
            }

            // swc_ecma_ast 25's `JSXAttrValue` is `Str | JSXExprContainer | JSXElement |
            // JSXFragment` — it does NOT have a `Lit` variant (the older swc shape the plan
            // listing was written against). Numeric attribute values (`tabIndex={5}`) arrive
            // as `JSXExprContainer(Lit(Lit::Num(_)))` and are handled here via expr lowering.
            let value = match &jsx_attr.value {
                None => AttrValue::Empty,
                Some(JSXAttrValue::Str(s)) => {
                    // `Str.value` is a `Wtf8Atom`; lossy UTF-8 here is safe because the source
                    // we parsed was already valid UTF-8 (we accepted it as `&str`).
                    AttrValue::Static(s.value.to_string_lossy().into_owned())
                }
                Some(JSXAttrValue::JSXExprContainer(c)) => {
                    match &c.expr {
                        // `{}` empty container in attribute position — meaningless;
                        // reject as `JsxInAttrNotSupported`.
                        JSXExpr::JSXEmptyExpr(_) => {
                            return Err(LowerError::at(c.span, ErrorKind::JsxInAttrNotSupported));
                        }
                        JSXExpr::Expr(e) => match lower_expr(e, scope)? {
                            // A `Lit::Num` in attr position keeps its specialized
                            // `StaticNum` slot (matches the T3 shape).
                            crate::ir::Expr::StaticNum(n) => AttrValue::StaticNum(n),
                            // A `Lit::Str` in attr position keeps its `Static`
                            // slot (matches a string-literal attribute).
                            crate::ir::Expr::StaticText(s) => AttrValue::Static(s),
                            expr => AttrValue::Expr(expr),
                        },
                    }
                }
                _ => {
                    return Err(LowerError::at(
                        jsx_attr.span,
                        ErrorKind::JsxInAttrNotSupported,
                    ));
                }
            };
            Ok(Some(JsxAttr {
                name: final_name,
                value,
            }))
        }
    }
}

/// React's `isUnitlessNumber` set (React 19). A numeric `style` value whose
/// ORIGINAL camelCase key is in this set is emitted verbatim; everything else
/// gets a `px` suffix (matching React's runtime style serialization).
const UNITLESS: &[&str] = &[
    "animationIterationCount",
    "aspectRatio",
    "borderImageOutset",
    "borderImageSlice",
    "borderImageWidth",
    "boxFlex",
    "boxFlexGroup",
    "boxOrdinalGroup",
    "columnCount",
    "columns",
    "flex",
    "flexGrow",
    "flexPositive",
    "flexShrink",
    "flexNegative",
    "flexOrder",
    "gridArea",
    "gridRow",
    "gridRowEnd",
    "gridRowSpan",
    "gridRowStart",
    "gridColumn",
    "gridColumnEnd",
    "gridColumnSpan",
    "gridColumnStart",
    "fontWeight",
    "lineClamp",
    "lineHeight",
    "opacity",
    "order",
    "orphans",
    "scale",
    "tabSize",
    "widows",
    "zIndex",
    "zoom",
    "fillOpacity",
    "floodOpacity",
    "stopOpacity",
    "strokeDasharray",
    "strokeDashoffset",
    "strokeMiterlimit",
    "strokeOpacity",
    "strokeWidth",
];

/// camelCase CSS property → kebab-case (`backgroundColor` → `background-color`,
/// `zIndex` → `z-index`). Vendor prefixes with a leading uppercase letter map to
/// a leading dash (`WebkitFoo` → `-webkit-foo`, `MozBar` → `-moz-bar`,
/// `OFoo` → `-o-foo`); lowercase `ms` stays a prefix → `-ms-…`. Keys that already
/// contain `-` or are custom properties (`--foo`) pass through unchanged.
fn css_kebab(camel: &str) -> String {
    // Custom properties and already-kebab keys are passed through untouched.
    if camel.starts_with("--") || camel.contains('-') {
        return camel.to_string();
    }
    // Lowercase `ms` is the one vendor prefix React leaves lowercase; it still
    // emits with a leading dash (`msFlexAlign` → `-ms-flex-align`).
    let leading_ms = camel
        .strip_prefix("ms")
        .is_some_and(|rest| rest.chars().next().is_some_and(|c| c.is_ascii_uppercase()));
    let mut out = String::with_capacity(camel.len() + 2);
    if leading_ms {
        out.push_str("-ms");
    }
    let start = if leading_ms { 2 } else { 0 };
    for ch in camel.chars().skip(start) {
        if ch.is_ascii_uppercase() {
            // Leading uppercase → vendor prefix → leading dash; interior
            // uppercase → word boundary → interior dash. Both push a dash.
            out.push('-');
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

/// Serialize a `style={{ … }}` object literal into an `AttrValue`.
///
/// All-static entries collapse to one `AttrValue::Static("a:b;c:d")` string.
/// Any member-path value forces an `AttrValue::Expr(Expr::Concat([…]))` whose
/// literal runs (property prefixes + separators) are `Expr::StaticText` and
/// whose dynamic values are member-path `Expr`s. The emit layer renders the
/// Concat as `style="{{ "a:" ~ path ~ ";b:c" }}"`.
/// Serialize an integer style value to its CSS string, appending `px` unless the
/// (camelCase) property is unitless. `negate` is set when the source was a unary
/// `-N`. Non-integer numerics → `NonIntegerNumericNotSupported`.
fn num_to_css(
    n: &swc_core::ecma::ast::Number,
    negate: bool,
    camel_key: &str,
) -> Result<String, LowerError> {
    if n.value.fract() != 0.0 {
        return Err(LowerError::at(
            n.span,
            ErrorKind::NonIntegerNumericNotSupported,
        ));
    }
    let v = if negate {
        -(n.value as i64)
    } else {
        n.value as i64
    };
    Ok(if UNITLESS.contains(&camel_key) {
        v.to_string()
    } else {
        format!("{v}px")
    })
}

fn lower_style_object(obj: &ObjectLit, scope: &Scope) -> Result<AttrValue, LowerError> {
    /// One serialized `prop:value` segment: either fully-literal text, or a
    /// literal prefix (`"prop:"`) plus a dynamic member-path value.
    enum Seg {
        Static(String),
        Dynamic {
            prefix: String,
            value: crate::ir::Expr,
        },
    }

    let mut segs: Vec<Seg> = Vec::new();
    for prop in &obj.props {
        // Spread (`{...x}`) and non-KeyValue props (shorthand/getter/setter/
        // method/assign) are not representable as a CSS declaration.
        let PropOrSpread::Prop(p) = prop else {
            return Err(LowerError::at(obj.span, ErrorKind::StyleObjectNotSupported));
        };
        let Prop::KeyValue(kv) = p.as_ref() else {
            return Err(LowerError::at(obj.span, ErrorKind::StyleObjectNotSupported));
        };
        // Key: Ident or string literal only. Computed/numeric keys → reject.
        let camel_key = match &kv.key {
            PropName::Ident(i) => i.sym.to_string(),
            PropName::Str(s) => s.value.to_string_lossy().into_owned(),
            _ => return Err(LowerError::at(obj.span, ErrorKind::StyleObjectNotSupported)),
        };
        let kebab = css_kebab(&camel_key);

        match strip_paren(&kv.value) {
            SwcExpr::Lit(Lit::Str(s)) => {
                let text = s.value.to_string_lossy().into_owned();
                segs.push(Seg::Static(format!("{kebab}:{text}")));
            }
            SwcExpr::Lit(Lit::Num(n)) => {
                segs.push(Seg::Static(format!(
                    "{kebab}:{}",
                    num_to_css(n, false, &camel_key)?
                )));
            }
            // Negative numeric literal: swc parses `-8` as `Unary(Minus, Num(8))`,
            // not `Lit::Num(-8)`. Negative CSS values (margins, offsets) are common.
            SwcExpr::Unary(u)
                if u.op == UnaryOp::Minus
                    && let SwcExpr::Lit(Lit::Num(n)) = strip_paren(&u.arg) =>
            {
                segs.push(Seg::Static(format!(
                    "{kebab}:{}",
                    num_to_css(n, true, &camel_key)?
                )));
            }
            // Member-path / bare-ident dynamic value → lower to a path Expr.
            stripped @ (SwcExpr::Ident(_) | SwcExpr::Member(_)) => {
                let value = lower_expr(stripped, scope)?;
                segs.push(Seg::Dynamic {
                    prefix: format!("{kebab}:"),
                    value,
                });
            }
            // Object/Call/Tpl/Bin/Array/… → not a CSS declaration value.
            _ => {
                return Err(LowerError::at(
                    kv.value.span(),
                    ErrorKind::StyleObjectValueNotSupported,
                ));
            }
        }
    }

    // All-static → join with `;` into a single declaration string.
    if segs.iter().all(|s| matches!(s, Seg::Static(_))) {
        let joined = segs
            .iter()
            .map(|s| match s {
                Seg::Static(t) => t.as_str(),
                Seg::Dynamic { .. } => unreachable!(),
            })
            .collect::<Vec<_>>()
            .join(";");
        return Ok(AttrValue::Static(joined));
    }

    // Any dynamic piece → build a Concat. Literal runs (prefixes + `;`
    // separators) are merged into adjacent StaticText so the emitted jinja
    // concatenates to a valid declaration.
    let mut parts: Vec<crate::ir::Expr> = Vec::new();
    let mut pending = String::new();
    for (i, seg) in segs.iter().enumerate() {
        if i > 0 {
            pending.push(';');
        }
        match seg {
            Seg::Static(t) => pending.push_str(t),
            Seg::Dynamic { prefix, value } => {
                pending.push_str(prefix);
                parts.push(crate::ir::Expr::StaticText(std::mem::take(&mut pending)));
                parts.push(value.clone());
            }
        }
    }
    if !pending.is_empty() {
        parts.push(crate::ir::Expr::StaticText(pending));
    }
    Ok(AttrValue::Expr(crate::ir::Expr::Concat(parts)))
}

/// Match the `on[A-Z].*` event-handler pattern (`onClick`, `onMouseOver`, …).
///
/// Crucially, plain `on` (no following uppercase) is NOT an event handler — it
/// falls through to the standard rename/uppercase check, which will accept it
/// verbatim (it's a valid HTML attribute, e.g. on SVG).
fn is_event_handler(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next() == Some('o')
        && chars.next() == Some('n')
        && matches!(chars.next(), Some(c) if c.is_ascii_uppercase())
}

fn lower_child(
    child: &JSXElementChild,
    scope: &Scope,
    in_map: bool,
) -> Result<Option<JsxNode>, LowerError> {
    match child {
        JSXElementChild::JSXText(text) => {
            let cleaned = normalize_jsx_text(&text.value);
            if cleaned.is_empty() {
                Ok(None)
            } else {
                Ok(Some(JsxNode::Text(cleaned)))
            }
        }
        // `JSXElementChild::JSXElement` wraps `Box<JSXElement>`; auto-deref to `&JSXElement`.
        JSXElementChild::JSXElement(el) => Ok(Some(lower_element(el, scope, in_map)?)),
        JSXElementChild::JSXFragment(f) => Ok(Some(lower_fragment(f, scope, in_map)?)),
        JSXElementChild::JSXSpreadChild(s) => {
            Err(LowerError::at(s.span, ErrorKind::SpreadChildNotSupported))
        }
        JSXElementChild::JSXExprContainer(c) => match &c.expr {
            // `{}` empty container as a child — treat as a dropped (no-op) node,
            // matching React's runtime behavior; no IR shape needed.
            JSXExpr::JSXEmptyExpr(_) => Ok(None),
            JSXExpr::Expr(e) => {
                // T5: recognize `xs.map((item) => <JSX>)` BEFORE the generic
                // `Call` → `CallExpressionNotSupported` fallback fires in
                // `lower_expr`. A `Map` node only makes sense in JSX child
                // position, so the routing happens here.
                if let SwcExpr::Call(call) = e.as_ref()
                    && is_dot_map_call(call)
                {
                    return Ok(Some(lower_call_as_map(call, scope, in_map)?));
                }

                // GATE: inline mode — handle the inline-only `{children}` slot.
                if scope.inline.is_some()
                    && let SwcExpr::Ident(id) = e.as_ref()
                    && id.sym.as_ref() == "children"
                    && scope.destructured.contains(&"children".to_string())
                {
                    // `{children}` → ChildrenSlot unconditionally when "children"
                    // is in the component's destructured params. The splice step
                    // removes the slot cleanly when zero call-site children were
                    // passed, so we must emit the slot regardless of has_children.
                    return Ok(Some(JsxNode::ChildrenSlot));
                }

                // Conditionals are valid in BOTH inline expansion and native
                // route bodies. The test is lowered through `lower_cond_test`
                // (member/compare/logical/not only), and the branches accept
                // JSX elements, fragments, and `null`/`false`/`undefined`
                // (→ Empty). Arithmetic operands and call tests are rejected
                // with `ComplexExpressionNotSupported`.

                // `{cond && <JSX>}` → Cond{alternate: None}.
                if let SwcExpr::Bin(bin) = e.as_ref()
                    && bin.op == BinaryOp::LogicalAnd
                    && is_cond_branch(strip_paren(bin.right.as_ref()))
                {
                    let test = lower_cond_test(&bin.left, scope)?;
                    let consequent = lower_cond_branch(bin.right.as_ref(), scope, in_map)?;
                    return Ok(Some(JsxNode::Cond {
                        test,
                        consequent: Box::new(consequent),
                        alternate: None,
                    }));
                }

                // `{cond ? <A> : <B>}` → Cond{alternate: Some}.
                if let SwcExpr::Cond(cond_expr) = e.as_ref()
                    && is_cond_branch(strip_paren(cond_expr.cons.as_ref()))
                    && is_cond_branch(strip_paren(cond_expr.alt.as_ref()))
                {
                    let test = lower_cond_test(&cond_expr.test, scope)?;
                    let consequent = lower_cond_branch(cond_expr.cons.as_ref(), scope, in_map)?;
                    let alternate = lower_cond_branch(cond_expr.alt.as_ref(), scope, in_map)?;
                    return Ok(Some(JsxNode::Cond {
                        test,
                        consequent: Box::new(consequent),
                        alternate: Some(Box::new(alternate)),
                    }));
                }

                Ok(Some(JsxNode::Expr(lower_expr(e, scope)?)))
            }
        },
    }
}

/// Is `expr` (already paren-stripped) a valid conditional branch?
///
/// Branches accept JSX elements, JSX fragments, and the falsy literals
/// `null` / `false` / `undefined` (which lower to `JsxNode::Empty`).
fn is_cond_branch(expr: &SwcExpr) -> bool {
    match expr {
        SwcExpr::JSXElement(_) | SwcExpr::JSXFragment(_) => true,
        SwcExpr::Lit(Lit::Null(_)) => true,
        SwcExpr::Lit(Lit::Bool(b)) => !b.value,
        SwcExpr::Ident(id) => id.sym.as_ref() == "undefined",
        _ => false,
    }
}

/// Lower one conditional branch to a `JsxNode`.
///
/// `null` / `false` / `undefined` → `JsxNode::Empty`; JSX elements and
/// fragments route through the existing element/fragment lowerers.
fn lower_cond_branch(expr: &SwcExpr, scope: &Scope, in_map: bool) -> Result<JsxNode, LowerError> {
    match strip_paren(expr) {
        SwcExpr::JSXElement(el) => lower_element(el, scope, in_map),
        SwcExpr::JSXFragment(f) => lower_fragment(f, scope, in_map),
        SwcExpr::Lit(Lit::Null(_)) => Ok(JsxNode::Empty),
        SwcExpr::Lit(Lit::Bool(b)) if !b.value => Ok(JsxNode::Empty),
        SwcExpr::Ident(id) if id.sym.as_ref() == "undefined" => Ok(JsxNode::Empty),
        other => Err(LowerError::at(
            other.span(),
            ErrorKind::ComplexExpressionNotSupported,
        )),
    }
}

/// Lower a conditional TEST expression to a jinja-renderable `Expr`.
///
/// Accepts `!x` (Not), comparisons (`>`, `<`, `>=`, `<=`, `===`/`==`,
/// `!==`/`!=`) and logical `&&` / `||` over member/ident/literal operands.
/// Arithmetic operands, calls, and other shapes are rejected with
/// `ComplexExpressionNotSupported` — the test never becomes free text.
fn lower_cond_test(expr: &SwcExpr, scope: &Scope) -> Result<crate::ir::Expr, LowerError> {
    match strip_paren(expr) {
        SwcExpr::Unary(u) if u.op == UnaryOp::Bang => Ok(crate::ir::Expr::Not(Box::new(
            lower_cond_test(u.arg.as_ref(), scope)?,
        ))),
        SwcExpr::Bin(b) => match b.op {
            BinaryOp::Gt
            | BinaryOp::Lt
            | BinaryOp::GtEq
            | BinaryOp::LtEq
            | BinaryOp::EqEqEq
            | BinaryOp::EqEq
            | BinaryOp::NotEqEq
            | BinaryOp::NotEq => {
                let op = match b.op {
                    BinaryOp::Gt => CmpOp::Gt,
                    BinaryOp::Lt => CmpOp::Lt,
                    BinaryOp::GtEq => CmpOp::Ge,
                    BinaryOp::LtEq => CmpOp::Le,
                    BinaryOp::EqEqEq | BinaryOp::EqEq => CmpOp::Eq,
                    BinaryOp::NotEqEq | BinaryOp::NotEq => CmpOp::Ne,
                    _ => unreachable!(),
                };
                Ok(crate::ir::Expr::Compare {
                    op,
                    lhs: Box::new(lower_cond_operand(b.left.as_ref(), scope)?),
                    rhs: Box::new(lower_cond_operand(b.right.as_ref(), scope)?),
                })
            }
            BinaryOp::LogicalAnd | BinaryOp::LogicalOr => {
                let op = if b.op == BinaryOp::LogicalAnd {
                    LogOp::And
                } else {
                    LogOp::Or
                };
                Ok(crate::ir::Expr::Logical {
                    op,
                    lhs: Box::new(lower_cond_test(b.left.as_ref(), scope)?),
                    rhs: Box::new(lower_cond_test(b.right.as_ref(), scope)?),
                })
            }
            _ => Err(LowerError::at(
                b.span,
                ErrorKind::ComplexExpressionNotSupported,
            )),
        },
        other => lower_cond_operand(other, scope),
    }
}

/// Lower a comparison operand (or a bare truthiness test) — only
/// member/ident/string/number shapes are admitted. Anything else (arithmetic,
/// calls, …) is `ComplexExpressionNotSupported`.
fn lower_cond_operand(expr: &SwcExpr, scope: &Scope) -> Result<crate::ir::Expr, LowerError> {
    match strip_paren(expr) {
        stripped @ (SwcExpr::Ident(_)
        | SwcExpr::Member(_)
        | SwcExpr::Lit(Lit::Str(_))
        | SwcExpr::Lit(Lit::Num(_))) => lower_expr(stripped, scope),
        other => Err(LowerError::at(
            other.span(),
            ErrorKind::ComplexExpressionNotSupported,
        )),
    }
}

/// Cheap shape test: is this `obj.map(arrow)`?
///
/// Both the `.map` callee and the single-arrow argument must be present.
/// Full validation (arity, body kind, arg shape) happens in `lower_call_as_map`,
/// which can then emit the right diagnostic.
fn is_dot_map_call(call: &CallExpr) -> bool {
    let Callee::Expr(callee) = &call.callee else {
        return false;
    };
    let SwcExpr::Member(member) = callee.as_ref() else {
        return false;
    };
    let MemberProp::Ident(ident) = &member.prop else {
        return false;
    };
    ident.sym.as_ref() == "map"
}

/// Lower `obj.map((ident) => <JSXElement>)` into `JsxNode::Map`.
///
/// Reject paths:
/// - args.len() != 1, or arg is spread, or arg is not an arrow → `MapShapeNotSupported`
/// - arrow has 0 params or > 1 param (the explicit (item, idx) form) →
///   `MapShapeNotSupported` / `MapIndexParamNotSupported`
/// - arrow param is not a plain `BindingIdent` (e.g. destructured) →
///   `MapShapeNotSupported`
/// - arrow body is not a `<JSXElement>` (either as expr body or as the sole
///   `return <JSX>;` in a block body) → `MapShapeNotSupported`
fn lower_call_as_map(call: &CallExpr, scope: &Scope, _in_map: bool) -> Result<JsxNode, LowerError> {
    // Source object: `obj` of the `.map` member.
    let Callee::Expr(callee) = &call.callee else {
        return Err(LowerError::at(call.span, ErrorKind::MapShapeNotSupported));
    };
    let SwcExpr::Member(member) = callee.as_ref() else {
        return Err(LowerError::at(call.span, ErrorKind::MapShapeNotSupported));
    };
    let source = lower_expr(&member.obj, scope)?;

    // Args: exactly one, not spread, must be an arrow.
    if call.args.len() != 1 {
        return Err(LowerError::at(call.span, ErrorKind::MapShapeNotSupported));
    }
    let arg = &call.args[0];
    if arg.spread.is_some() {
        return Err(LowerError::at(call.span, ErrorKind::MapShapeNotSupported));
    }
    let SwcExpr::Arrow(arrow) = arg.expr.as_ref() else {
        return Err(LowerError::at(call.span, ErrorKind::MapShapeNotSupported));
    };

    let binding = arrow_binding(arrow)?;

    // Body: accept `(item) => <JSX>` / `(item) => (<JSX>)` / a per-item
    // conditional, or the `{ return <JSX>; }` block form.
    let body_expr = arrow_body_expr(arrow)?;

    // Clone-and-extend the scope with the new iter binding. Keeps the rest of
    // the lowering on `&Scope`; no `&mut` plumbing required.
    let mut inner_scope = scope.clone();
    inner_scope.map_bindings.push(binding.clone());
    // Force `in_map = true` for the Map body: any `<Island>` inside the
    // iteration is rejected (id collision + non-per-iteration props path in v1).
    let body = lower_map_body_expr(body_expr, &inner_scope)?;

    let body = match scan_map_xfor_sugar(body_expr, &binding, &inner_scope)? {
        Some(key_path) => {
            if !matches!(&source, Expr::Field(_) | Expr::MemberAccess { .. }) {
                return Err(LowerError::at(call.span, ErrorKind::MapXForSourceNotArray));
            }
            apply_map_xfor_sugar(body, &binding, &source, &key_path)
        }
        None => body,
    };

    Ok(JsxNode::Map {
        source,
        binding,
        body: Box::new(body),
    })
}

/// Pre-scan a `.map()` body for the bare `x-for` sugar flag + its `key`. Runs on
/// the RAW arrow body BEFORE `lower_map_body_expr` (because `lower_attr` drops
/// `key`). Some(key_path) = flag + valid key present; None = no flag (static map);
/// Err = malformed opt-in (the flag is explicit author intent — surface mistakes).
fn scan_map_xfor_sugar(
    body_expr: &SwcExpr,
    binding: &str,
    inner_scope: &Scope,
) -> Result<Option<String>, LowerError> {
    let stripped = strip_paren(body_expr);
    let SwcExpr::JSXElement(el) = stripped else {
        if raw_has_bare_xfor(stripped) {
            return Err(LowerError::at(
                stripped.span(),
                ErrorKind::MapXForBodyNotElement,
            ));
        }
        return Ok(None);
    };
    let mut has_flag = false;
    let mut key_expr: Option<&SwcExpr> = None;
    for a in &el.opening.attrs {
        let JSXAttrOrSpread::JSXAttr(attr) = a else {
            continue;
        };
        let JSXAttrName::Ident(name) = &attr.name else {
            continue;
        };
        match name.sym.as_ref() {
            "x-for" if attr.value.is_none() => has_flag = true,
            "key" => {
                if let Some(JSXAttrValue::JSXExprContainer(c)) = &attr.value
                    && let JSXExpr::Expr(e) = &c.expr
                {
                    key_expr = Some(e);
                }
            }
            _ => {}
        }
    }
    if !has_flag {
        return Ok(None);
    }
    let key = key_expr.ok_or_else(|| LowerError::at(el.span, ErrorKind::MapXForKeyRequired))?;
    let key_path = match lower_expr(key, inner_scope) {
        Ok(Expr::MapMember { root, path }) if root == binding => {
            let mut s = root;
            for seg in path {
                s.push('.');
                s.push_str(&seg);
            }
            s
        }
        // A bare `key={t}` (the whole item) is rejected: the runtime key would be
        // the object's stringification (unstable). Require a member path `t.<x>`.
        _ => return Err(LowerError::at(el.span, ErrorKind::MapXForKeyRequired)),
    };
    Ok(Some(key_path))
}

/// Shallow check: does a non-element body branch carry a bare `x-for`? (so a flag
/// in a conditional map body errors instead of leaking a dead attr).
fn raw_has_bare_xfor(expr: &SwcExpr) -> bool {
    fn el_has(el: &JSXElement) -> bool {
        el.opening.attrs.iter().any(|a| {
            matches!(a,
                JSXAttrOrSpread::JSXAttr(attr)
                  if matches!(&attr.name, JSXAttrName::Ident(n) if n.sym.as_ref() == "x-for")
                     && attr.value.is_none())
        })
    }
    match strip_paren(expr) {
        SwcExpr::JSXElement(el) => el_has(el),
        SwcExpr::Bin(b) => {
            raw_has_bare_xfor(b.left.as_ref()) || raw_has_bare_xfor(b.right.as_ref())
        }
        SwcExpr::Cond(c) => raw_has_bare_xfor(c.cons.as_ref()) || raw_has_bare_xfor(c.alt.as_ref()),
        _ => false,
    }
}

/// Decorate a `.map()` body element with the x-for adopt directives. INVERSE of
/// `transform_xfor_element`: reads map-binding `Expr` attrs and adds `x-bind-*`,
/// reads a single map-binding `Expr` text child and adds `x-text`, reconstructs
/// the `x-for` string, adds `data-x-key`.
fn apply_map_xfor_sugar(body: JsxNode, binding: &str, source: &Expr, key_path: &str) -> JsxNode {
    // Decorate the WHOLE item subtree (root + descendants), not just the root: a
    // freshly reconciled clone is built from the template, so EVERY per-item value
    // — `<img src={c.x}>`, a nested `<span>{c.y}</span>` — must carry a client
    // directive, else the clone shows the template (first-seed) value. Without this
    // recursion a list that GROWS (e.g. clearing a search) re-creates rows from the
    // template and every new row shows the first item's content.
    let mut decorated = decorate_map_node(body, binding);
    // Root-only: reconstruct the `x-for` expr (replace the bare flag) + `data-x-key`.
    if let JsxNode::Element { attrs, .. } = &mut decorated {
        let xfor = format!(
            "{binding} in {} by {key_path}",
            crate::emit_jinja::emit_expr_path(source)
        );
        for a in attrs.iter_mut() {
            if a.name == "x-for" {
                a.value = AttrValue::Static(xfor.clone());
            }
        }
        if let Some(kexpr) = crate::xfor::path_to_map_expr(key_path, binding) {
            set_or_push_attr(attrs, "data-x-key".into(), AttrValue::Expr(kexpr));
        }
    }
    decorated
}

/// Recursively decorate an element subtree for x-for adopt: each element's
/// map-binding `Expr` attrs gain a sibling `x-bind-<name>` (so a client clone
/// re-binds the per-item value); an element whose children are a SINGLE map-binding
/// `Expr` gains `x-text`. Non-elements pass through. Does NOT touch `x-for` /
/// `data-x-key` — those are root-only and added by `apply_map_xfor_sugar`.
fn decorate_map_node(node: JsxNode, binding: &str) -> JsxNode {
    let JsxNode::Element {
        tag,
        attrs,
        children,
    } = node
    else {
        return node;
    };
    let mut new_attrs: Vec<JsxAttr> = Vec::with_capacity(attrs.len() + 1);
    let mut binds: Vec<JsxAttr> = Vec::new();
    for a in attrs {
        if let AttrValue::Expr(e) = &a.value
            && expr_roots_at(e, binding)
        {
            binds.push(JsxAttr {
                name: format!("x-bind-{}", a.name),
                value: AttrValue::Static(path_from_map_expr(e)),
            });
        }
        new_attrs.push(a);
    }
    for b in binds {
        set_or_push_attr(&mut new_attrs, b.name, b.value);
    }
    let new_children: Vec<JsxNode> = children
        .into_iter()
        .map(|c| decorate_map_node(c, binding))
        .collect();
    if let [JsxNode::Expr(e)] = new_children.as_slice()
        && expr_roots_at(e, binding)
    {
        set_or_push_attr(
            &mut new_attrs,
            "x-text".into(),
            AttrValue::Static(path_from_map_expr(e)),
        );
    }
    JsxNode::Element {
        tag,
        attrs: new_attrs,
        children: new_children,
    }
}

fn expr_roots_at(e: &Expr, binding: &str) -> bool {
    matches!(e, Expr::MapBinding(r) | Expr::MapMember { root: r, .. } if r == binding)
}

fn path_from_map_expr(e: &Expr) -> String {
    match e {
        Expr::MapMember { root, path } => {
            let mut s = root.clone();
            for seg in path {
                s.push('.');
                s.push_str(seg);
            }
            s
        }
        Expr::MapBinding(r) => r.clone(),
        _ => String::new(),
    }
}

/// Extract the single `(item)` ident binding from an arrow.
fn arrow_binding(arrow: &ArrowExpr) -> Result<String, LowerError> {
    match arrow.params.len() {
        0 => Err(LowerError::at(arrow.span, ErrorKind::MapShapeNotSupported)),
        1 => match &arrow.params[0] {
            Pat::Ident(BindingIdent { id, .. }) => Ok(id.sym.to_string()),
            other => Err(LowerError::at(
                other.span(),
                ErrorKind::MapShapeNotSupported,
            )),
        },
        // 2+ params is the `(item, idx)` form: explicitly distinguished.
        _ => Err(LowerError::at(
            arrow.span,
            ErrorKind::MapIndexParamNotSupported,
        )),
    }
}

/// Extract the body `&SwcExpr` from an arrow, accepting both forms.
///
/// `(item) => <expr>` lowers as `BlockStmtOrExpr::Expr(<expr>)`.
/// `(item) => { return <expr>; }` lowers as `BlockStmtOrExpr::BlockStmt(...)`
/// with a single return. The returned expression is NOT paren-stripped — the
/// caller (`lower_map_body_expr`) strips where appropriate.
fn arrow_body_expr(arrow: &ArrowExpr) -> Result<&SwcExpr, LowerError> {
    match arrow.body.as_ref() {
        BlockStmtOrExpr::Expr(expr) => Ok(expr.as_ref()),
        BlockStmtOrExpr::BlockStmt(block) => {
            if block.stmts.len() != 1 {
                return Err(LowerError::at(block.span, ErrorKind::MapShapeNotSupported));
            }
            match &block.stmts[0] {
                Stmt::Return(ReturnStmt {
                    arg: Some(expr), ..
                }) => Ok(expr.as_ref()),
                other => Err(LowerError::at(
                    other.span(),
                    ErrorKind::MapShapeNotSupported,
                )),
            }
        }
    }
}

/// Lower a `.map` arrow body to the `Map` node body.
///
/// Accepts a JSX element, or a per-item conditional
/// (`item.flag && <li/>` / `cond ? <a/> : <b/>`; conditional branches may
/// themselves be fragments). The conditional recognition
/// mirrors the `lower_child` expr-container path so per-item conditionals lower
/// identically inside and outside a `.map`. A non-JSX, non-conditional body is
/// `MapShapeNotSupported` (preserving the prior diagnostic for that shape).
///
/// NOTE: a bare-fragment map body (`xs.map(x => <>…</>)`) is intentionally NOT
/// accepted here — it stays `MapShapeNotSupported` (see test
/// `fragment_map_body_still_rejected`). Fragments are valid only as *conditional
/// branches* inside a map body (`xs.map(x => x.f ? <>…</> : null)`), via
/// `lower_cond_branch`. Lifting that restriction is out of scope for S11.
fn lower_map_body_expr(expr: &SwcExpr, scope: &Scope) -> Result<JsxNode, LowerError> {
    match strip_paren(expr) {
        SwcExpr::JSXElement(el) => lower_element(el, scope, true),
        // `cond && <JSX>`
        SwcExpr::Bin(bin)
            if bin.op == BinaryOp::LogicalAnd
                && is_cond_branch(strip_paren(bin.right.as_ref())) =>
        {
            let test = lower_cond_test(bin.left.as_ref(), scope)?;
            let consequent = lower_cond_branch(bin.right.as_ref(), scope, true)?;
            Ok(JsxNode::Cond {
                test,
                consequent: Box::new(consequent),
                alternate: None,
            })
        }
        // `cond ? <A> : <B>`
        SwcExpr::Cond(cond_expr)
            if is_cond_branch(strip_paren(cond_expr.cons.as_ref()))
                && is_cond_branch(strip_paren(cond_expr.alt.as_ref())) =>
        {
            let test = lower_cond_test(cond_expr.test.as_ref(), scope)?;
            let consequent = lower_cond_branch(cond_expr.cons.as_ref(), scope, true)?;
            let alternate = lower_cond_branch(cond_expr.alt.as_ref(), scope, true)?;
            Ok(JsxNode::Cond {
                test,
                consequent: Box::new(consequent),
                alternate: Some(Box::new(alternate)),
            })
        }
        other => Err(LowerError::at(
            other.span(),
            ErrorKind::MapShapeNotSupported,
        )),
    }
}

/// React/JSX text normalization (spec S4.6).
///
/// Matches how JSX treats whitespace so the emitted HTML reads the same as the
/// source TSX:
/// - Internal runs of whitespace collapse to a single space.
/// - A leading/trailing whitespace run is PRESERVED as a single boundary space
///   IF it is inline (contains no line break) — this is the space between text
///   and an adjacent element on the same line, e.g. `a <strong>…` → `"a "`.
/// - A leading/trailing whitespace run that spans a line break is layout
///   indentation and is dropped (JSX behavior).
/// - A whitespace-only node is a single significant space when inline
///   (`<a/> <b/>`), or empty when it spans a line break (the caller drops it).
fn normalize_jsx_text(s: &str) -> String {
    if s.trim().is_empty() {
        // Whitespace-only: a single inline space between elements is significant
        // in JSX; whitespace spanning a line break is indentation, dropped.
        return if has_line_break(s) {
            String::new()
        } else {
            " ".to_string()
        };
    }
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let lead = leading_inline_space(s);
    let trail = trailing_inline_space(s);
    let mut out = String::with_capacity(collapsed.len() + 2);
    if lead {
        out.push(' ');
    }
    out.push_str(&collapsed);
    if trail {
        out.push(' ');
    }
    out
}

fn has_line_break(s: &str) -> bool {
    s.contains('\n') || s.contains('\r')
}

/// True if `s` begins with a whitespace run that contains NO line break — the
/// JSX boundary space between a preceding element and same-line text.
fn leading_inline_space(s: &str) -> bool {
    let mut saw = false;
    for c in s.chars() {
        if c == '\n' || c == '\r' {
            return false;
        }
        if c.is_whitespace() {
            saw = true;
            continue;
        }
        break;
    }
    saw
}

/// True if `s` ends with a whitespace run that contains NO line break.
fn trailing_inline_space(s: &str) -> bool {
    let mut saw = false;
    for c in s.chars().rev() {
        if c == '\n' || c == '\r' {
            return false;
        }
        if c.is_whitespace() {
            saw = true;
            continue;
        }
        break;
    }
    saw
}

/// Lower a JS expression (in JSX `{expr}` position) to an IR `Expr`.
///
/// Resolution rules:
/// - `Ident(x)` →
///   - `x` in destructured prop list → `Field(x)`
///   - `x` is a map iter binding → `MapBinding(x)` (T5 actually pushes these)
///   - `x` is the named param (`function X(props)`'s `props`) →
///     `BareIdentNotSupported` (only chains rooted at the named param are
///     valid)
///   - otherwise → `UnresolvedIdent`
/// - `Member` → routed through `lower_member` to build `MemberAccess` /
///   `MapMember` / `Field` (named-param implicit-props) shapes.
/// - `Lit::Str` → `StaticText`; `Lit::Num` → `StaticNum` (integer-only;
///   fractional → `NonIntegerNumericNotSupported`).
/// - `Tpl` → `TemplateLiteralNotSupported`
/// - `Call` → `CallExpressionNotSupported` (T5 catches `.map(...)` shape
///   BEFORE delegating to this fn)
/// - `Bin | Cond | Unary` → `ComplexExpressionNotSupported`
/// - `Paren` → recurse on the inner expression.
/// - Everything else → `ComplexExpressionNotSupported`.
fn lower_expr(expr: &SwcExpr, scope: &Scope) -> Result<crate::ir::Expr, LowerError> {
    match expr {
        SwcExpr::Ident(id) => {
            let name = id.sym.to_string();
            // Inline mode: substitution takes priority over destructured→Field.
            if let Some(ctx) = &scope.inline
                && let Some(substituted) = ctx.subst.get(&name)
            {
                return Ok(substituted.clone());
            }
            if scope.destructured.contains(&name) {
                Ok(crate::ir::Expr::Field(name))
            } else if scope.map_bindings.contains(&name) {
                Ok(crate::ir::Expr::MapBinding(name))
            } else if scope.named_param.as_deref() == Some(&name) {
                Err(LowerError::at(
                    id.span,
                    ErrorKind::BareIdentNotSupported(name),
                ))
            } else {
                Err(LowerError::at(id.span, ErrorKind::UnresolvedIdent(name)))
            }
        }
        SwcExpr::Member(m) => lower_member(m, scope),
        SwcExpr::Lit(Lit::Str(s)) => Ok(crate::ir::Expr::StaticText(
            s.value.to_string_lossy().into_owned(),
        )),
        SwcExpr::Lit(Lit::Num(n)) => {
            if n.value.fract() != 0.0 {
                Err(LowerError::at(
                    n.span,
                    ErrorKind::NonIntegerNumericNotSupported,
                ))
            } else {
                Ok(crate::ir::Expr::StaticNum(n.value as i64))
            }
        }
        SwcExpr::Tpl(t) => {
            // GATE: inline mode only.
            if scope.inline.is_some() {
                // Template literal → Concat of quasis (StaticText) and exprs.
                let mut parts: Vec<crate::ir::Expr> = Vec::new();
                let quasis = &t.quasis;
                let exprs = &t.exprs;
                for (i, quasi) in quasis.iter().enumerate() {
                    let cooked = quasi
                        .cooked
                        .as_ref()
                        .map(|a| a.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    if !cooked.is_empty() {
                        parts.push(crate::ir::Expr::StaticText(cooked));
                    }
                    if i < exprs.len() {
                        parts.push(lower_expr(&exprs[i], scope)?);
                    }
                }
                Ok(crate::ir::Expr::Concat(parts))
            } else {
                Err(LowerError::at(
                    t.span,
                    ErrorKind::TemplateLiteralNotSupported,
                ))
            }
        }
        SwcExpr::Call(c) => {
            // GATE: inline mode only — method call lowering.
            if scope.inline.is_some() {
                lower_call_as_filter(c, scope)
            } else {
                Err(LowerError::at(
                    c.span,
                    ErrorKind::CallExpressionNotSupported,
                ))
            }
        }
        SwcExpr::Bin(b) => {
            // GATE: inline mode only — arithmetic, comparison, logical.
            if scope.inline.is_some() {
                lower_bin_inline(b, scope)
            } else {
                Err(LowerError::at(
                    b.span,
                    ErrorKind::ComplexExpressionNotSupported,
                ))
            }
        }
        SwcExpr::Cond(c) => Err(LowerError::at(
            c.span,
            ErrorKind::ComplexExpressionNotSupported,
        )),
        SwcExpr::Unary(u) => {
            // GATE: inline mode only — `!` → Not.
            if scope.inline.is_some() {
                if u.op == UnaryOp::Bang {
                    let inner = lower_expr(&u.arg, scope)?;
                    Ok(crate::ir::Expr::Not(Box::new(inner)))
                } else {
                    Err(LowerError::at(
                        u.span,
                        ErrorKind::InlineUntranslatable(format!("{:?}", u.op)),
                    ))
                }
            } else {
                Err(LowerError::at(
                    u.span,
                    ErrorKind::ComplexExpressionNotSupported,
                ))
            }
        }
        SwcExpr::Paren(p) => lower_expr(&p.expr, scope),
        other => Err(LowerError::at(
            other.span(),
            ErrorKind::ComplexExpressionNotSupported,
        )),
    }
}

/// Lower a binary expression in inline mode.
fn lower_bin_inline(
    b: &swc_core::ecma::ast::BinExpr,
    scope: &Scope,
) -> Result<crate::ir::Expr, LowerError> {
    match b.op {
        BinaryOp::Add => {
            let lhs = lower_expr(&b.left, scope)?;
            let rhs = lower_expr(&b.right, scope)?;
            Ok(crate::ir::Expr::Arith {
                op: ArithOp::Add,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            })
        }
        BinaryOp::Sub => {
            let lhs = lower_expr(&b.left, scope)?;
            let rhs = lower_expr(&b.right, scope)?;
            Ok(crate::ir::Expr::Arith {
                op: ArithOp::Sub,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            })
        }
        BinaryOp::Mul => {
            let lhs = lower_expr(&b.left, scope)?;
            let rhs = lower_expr(&b.right, scope)?;
            Ok(crate::ir::Expr::Arith {
                op: ArithOp::Mul,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            })
        }
        BinaryOp::Div => {
            let lhs = lower_expr(&b.left, scope)?;
            let rhs = lower_expr(&b.right, scope)?;
            Ok(crate::ir::Expr::Arith {
                op: ArithOp::Div,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            })
        }
        BinaryOp::Mod => {
            let lhs = lower_expr(&b.left, scope)?;
            let rhs = lower_expr(&b.right, scope)?;
            Ok(crate::ir::Expr::Arith {
                op: ArithOp::Mod,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            })
        }
        // Comparison: === and == both → Eq; !== and != → Ne.
        BinaryOp::EqEqEq | BinaryOp::EqEq => {
            let lhs = lower_expr(&b.left, scope)?;
            let rhs = lower_expr(&b.right, scope)?;
            Ok(crate::ir::Expr::Compare {
                op: CmpOp::Eq,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            })
        }
        BinaryOp::NotEqEq | BinaryOp::NotEq => {
            let lhs = lower_expr(&b.left, scope)?;
            let rhs = lower_expr(&b.right, scope)?;
            Ok(crate::ir::Expr::Compare {
                op: CmpOp::Ne,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            })
        }
        BinaryOp::Gt => {
            let lhs = lower_expr(&b.left, scope)?;
            let rhs = lower_expr(&b.right, scope)?;
            Ok(crate::ir::Expr::Compare {
                op: CmpOp::Gt,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            })
        }
        BinaryOp::Lt => {
            let lhs = lower_expr(&b.left, scope)?;
            let rhs = lower_expr(&b.right, scope)?;
            Ok(crate::ir::Expr::Compare {
                op: CmpOp::Lt,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            })
        }
        BinaryOp::GtEq => {
            let lhs = lower_expr(&b.left, scope)?;
            let rhs = lower_expr(&b.right, scope)?;
            Ok(crate::ir::Expr::Compare {
                op: CmpOp::Ge,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            })
        }
        BinaryOp::LtEq => {
            let lhs = lower_expr(&b.left, scope)?;
            let rhs = lower_expr(&b.right, scope)?;
            Ok(crate::ir::Expr::Compare {
                op: CmpOp::Le,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            })
        }
        BinaryOp::LogicalAnd => {
            let lhs = lower_expr(&b.left, scope)?;
            let rhs = lower_expr(&b.right, scope)?;
            Ok(crate::ir::Expr::Logical {
                op: LogOp::And,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            })
        }
        BinaryOp::LogicalOr => {
            let lhs = lower_expr(&b.left, scope)?;
            let rhs = lower_expr(&b.right, scope)?;
            Ok(crate::ir::Expr::Logical {
                op: LogOp::Or,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            })
        }
        other => Err(LowerError::at(
            b.span,
            ErrorKind::InlineUntranslatable(format!("{other:?}")),
        )),
    }
}

/// Lower a call expression as a filter in inline mode.
/// Only `recv.method(args)` where method ∈ {toUpperCase, toLowerCase, trim, slice, join}.
/// Any other call → `InlineUntranslatable`.
fn lower_call_as_filter(c: &CallExpr, scope: &Scope) -> Result<crate::ir::Expr, LowerError> {
    let Callee::Expr(callee) = &c.callee else {
        return Err(LowerError::at(
            c.span,
            ErrorKind::InlineUntranslatable("call".to_string()),
        ));
    };
    let SwcExpr::Member(member) = callee.as_ref() else {
        return Err(LowerError::at(
            c.span,
            ErrorKind::InlineUntranslatable("call".to_string()),
        ));
    };
    let MemberProp::Ident(method_ident) = &member.prop else {
        return Err(LowerError::at(
            c.span,
            ErrorKind::InlineUntranslatable("call".to_string()),
        ));
    };
    let method_name = method_ident.sym.as_ref();
    let filter_name = match method_name {
        "toUpperCase" => "upper",
        "toLowerCase" => "lower",
        "trim" => "trim",
        "slice" => "slice",
        "join" => "join",
        other => {
            return Err(LowerError::at(
                c.span,
                ErrorKind::InlineUntranslatable(other.to_string()),
            ));
        }
    };
    let recv = lower_expr(&member.obj, scope)?;
    let mut args: Vec<crate::ir::Expr> = Vec::new();
    for arg in &c.args {
        if arg.spread.is_some() {
            return Err(LowerError::at(
                c.span,
                ErrorKind::InlineUntranslatable("spread arg".to_string()),
            ));
        }
        args.push(lower_expr(&arg.expr, scope)?);
    }
    Ok(crate::ir::Expr::Filter {
        value: Box::new(recv),
        name: filter_name.to_string(),
        args,
    })
}

/// Lower a `MemberExpr` into one of the chain-rooted IR shapes.
///
/// Walks `.obj.obj.obj` down to a root `Ident`. Then:
/// - Root in `destructured` and path empty → `Field(root)`
///   (so `{user}` becomes a `Field` even if reached through `lower_member`)
/// - Root in `destructured` and path non-empty → `MemberAccess { root, path }`
/// - Root in `map_bindings` and path empty → `MapBinding(root)`
/// - Root in `map_bindings` and path non-empty → `MapMember { root, path }`
/// - Root is `named_param`:
///   - path empty → `BareIdentNotSupported` (re-uses the Ident rule)
///   - path non-empty → `Field` of first segment, IF chain is exactly 1
///     deep (matches `props.x` → `Field(x)`). Deeper chains (`props.x.y`)
///     fall back to `UnresolvedIdent` because we don't model an implicit
///     `props.` struct yet — caller must use destructuring for deeper shapes.
/// - Root unknown → `UnresolvedIdent`
///
/// A `Computed` (`obj[...]`) anywhere in the chain → `ComputedAccessNotSupported`.
/// A `PrivateName` anywhere in the chain → `ComplexExpressionNotSupported`.
/// A non-`Ident` root (call, literal, etc.) → `ComplexExpressionNotSupported`.
fn lower_member(m: &MemberExpr, scope: &Scope) -> Result<crate::ir::Expr, LowerError> {
    // GATE: inline mode — trailing `.length` → Filter{name:"length", args:[]}.
    if scope.inline.is_some()
        && let MemberProp::Ident(prop_ident) = &m.prop
        && prop_ident.sym.as_ref() == "length"
    {
        let recv = lower_expr(&m.obj, scope)?;
        return Ok(crate::ir::Expr::Filter {
            value: Box::new(recv),
            name: "length".to_string(),
            args: vec![],
        });
    }

    // Collect chain leaf → root, then reverse. The leaf segment is `m.prop`.
    let mut path_rev: Vec<String> = Vec::new();
    let leaf = match &m.prop {
        MemberProp::Ident(id) => id.sym.to_string(),
        MemberProp::Computed(_) => {
            return Err(LowerError::at(
                m.span,
                ErrorKind::ComputedAccessNotSupported,
            ));
        }
        MemberProp::PrivateName(_) => {
            return Err(LowerError::at(
                m.span,
                ErrorKind::ComplexExpressionNotSupported,
            ));
        }
    };
    path_rev.push(leaf);

    let mut cursor: &SwcExpr = &m.obj;
    loop {
        match cursor {
            SwcExpr::Member(inner) => {
                let seg = match &inner.prop {
                    MemberProp::Ident(id) => id.sym.to_string(),
                    MemberProp::Computed(_) => {
                        return Err(LowerError::at(
                            inner.span,
                            ErrorKind::ComputedAccessNotSupported,
                        ));
                    }
                    MemberProp::PrivateName(_) => {
                        return Err(LowerError::at(
                            inner.span,
                            ErrorKind::ComplexExpressionNotSupported,
                        ));
                    }
                };
                path_rev.push(seg);
                cursor = &inner.obj;
            }
            SwcExpr::Paren(p) => {
                cursor = &p.expr;
            }
            SwcExpr::Ident(id) => {
                let root = id.sym.to_string();
                path_rev.reverse();
                let path = path_rev;

                if scope.destructured.contains(&root) {
                    return Ok(crate::ir::Expr::MemberAccess { root, path });
                }
                if scope.map_bindings.contains(&root) {
                    return Ok(crate::ir::Expr::MapMember { root, path });
                }
                if scope.named_param.as_deref() == Some(&root) {
                    // `props.x` → `Field(x)`. Deeper chains (`props.x.y`)
                    // are not modeled in T4; reject as `UnresolvedIdent`
                    // pointing at the first off-the-rails segment.
                    if path.len() == 1 {
                        return Ok(crate::ir::Expr::Field(path.into_iter().next().unwrap()));
                    } else {
                        return Err(LowerError::at(
                            id.span,
                            ErrorKind::UnresolvedIdent(format!("{root}.{}", path.join("."))),
                        ));
                    }
                }
                return Err(LowerError::at(id.span, ErrorKind::UnresolvedIdent(root)));
            }
            other => {
                return Err(LowerError::at(
                    other.span(),
                    ErrorKind::ComplexExpressionNotSupported,
                ));
            }
        }
    }
}

/// Walk the lowered IR root and populate `props.types`.
///
/// T4 scope:
/// - `Field(x)` → `props.types[x] = OwnedString` (creates if absent;
///   compatible if already `OwnedString`; conflict if already `Struct`/`VecOf`).
/// - `MemberAccess { root, path }` → builds a nested `PropType::Struct` chain
///   under `props.types[root]`. Leaf of the chain is `OwnedString`.
///   (Vec-of inference comes in T5 via `MapMember`.)
///
/// `Empty`/`Text`/`StaticText`/`StaticNum`/`MapBinding` contribute no type
/// info. `MapMember` is silently skipped in T4 (T5 wires the surrounding
/// `Map` node before recursing).
fn infer_props_types(node: &JsxNode, props: &mut PropsShape) -> Result<(), LowerError> {
    match node {
        JsxNode::Empty | JsxNode::Text(_) => Ok(()),
        JsxNode::Element {
            attrs, children, ..
        } => {
            for a in attrs {
                // `x-props` serializes its WHOLE value via `json_attr` (shape-agnostic),
                // so it must NOT seed a scalar `OwnedString` type for the prop — the same
                // prop may also be a `.map()` collection source (`VecOf`), and forcing a
                // scalar here would raise a spurious `PropTypeConflict`. Skip inference.
                if a.name == "x-props" {
                    continue;
                }
                if let AttrValue::Expr(e) = &a.value {
                    infer_from_expr(e, props)?;
                }
            }
            for c in children {
                infer_props_types(c, props)?;
            }
            Ok(())
        }
        JsxNode::Expr(e) => infer_from_expr(e, props),
        // `dangerouslySetInnerHTML` member-path → infer the prop it reads from
        // (a literal contributes nothing).
        JsxNode::RawHtml(HeadValue::Path(e)) => infer_from_expr(e, props),
        JsxNode::RawHtml(HeadValue::Literal(_)) => Ok(()),
        // Walk the body for prop references. Also walk `head` entry attribute
        // member-paths (a dynamic value used ONLY in a head entry, e.g.
        // `{ tag:'meta', content: data.title }`, still needs its prop inferred).
        JsxNode::Document { body, head, .. } => {
            for entry in head {
                for (_, hv) in &entry.attrs {
                    if let HeadValue::Path(e) = hv {
                        infer_from_expr(e, props)?;
                    }
                }
            }
            for c in body {
                infer_props_types(c, props)?;
            }
            Ok(())
        }
        JsxNode::Map {
            source,
            binding,
            body,
        } => {
            // T5: seed the source root as `VecOf(Struct(fields))` BEFORE walking
            // the body. The fields are collected from `MapMember { root: binding,
            // path }` references inside the body — this avoids a `PropTypeConflict`
            // that would arise if the body's MapMembers were misread as
            // top-level prop refs.
            let mut element_fields: BTreeMap<String, PropType> = BTreeMap::new();
            collect_map_member_fields(body, binding, &mut element_fields);
            let element_struct = PropType::Struct(element_fields);
            seed_vec_at_source(props, source, element_struct, source)?;

            // Walk the body for any non-MapMember refs (e.g. `Field(x)` from an
            // outer prop captured by closure). MapMember refs are no-ops at this
            // stage since they target the binding, not a prop name.
            infer_props_types(body, props)
        }
        // An island's `props_path` is resolved by `lower_island` against the
        // outer scope at lowering time; its placeholder/manifest are emitted by
        // T2/T3. It contributes no prop-type inference here.
        JsxNode::Island { .. } => Ok(()),
        // SsrComponent is opaque — it has its own type scope and is not
        // recursed into for prop-type inference here.
        JsxNode::SsrComponent { .. } => Ok(()),
        JsxNode::Cond {
            test,
            consequent,
            alternate,
        } => {
            infer_from_expr(test, props)?;
            infer_props_types(consequent, props)?;
            if let Some(alt) = alternate {
                infer_props_types(alt, props)?;
            }
            Ok(())
        }
        JsxNode::ChildrenSlot => Ok(()),
        JsxNode::Fragment { children } => {
            for c in children {
                infer_props_types(c, props)?;
            }
            Ok(())
        }
    }
}

fn infer_from_expr(expr: &crate::ir::Expr, props: &mut PropsShape) -> Result<(), LowerError> {
    match expr {
        crate::ir::Expr::Field(name) => {
            merge_type(props, name, PropType::OwnedString)?;
            Ok(())
        }
        crate::ir::Expr::MemberAccess { root, path } => {
            // Build a `Struct { … Struct { … OwnedString } }` chain.
            let chain = build_struct_chain(path);
            merge_type(props, root, chain)?;
            Ok(())
        }
        // T5 handles MapMember during Map-node inference.
        crate::ir::Expr::MapBinding(_)
        | crate::ir::Expr::MapMember { .. }
        | crate::ir::Expr::StaticText(_)
        | crate::ir::Expr::StaticNum(_) => Ok(()),
        // These variants may appear in inline-mode lowered trees; they carry no
        // top-level prop type information themselves (the sub-expressions do).
        crate::ir::Expr::Arith { lhs, rhs, .. } => {
            infer_from_expr(lhs, props)?;
            infer_from_expr(rhs, props)
        }
        crate::ir::Expr::Concat(parts) => {
            for p in parts {
                infer_from_expr(p, props)?;
            }
            Ok(())
        }
        crate::ir::Expr::Filter { value, args, .. } => {
            infer_from_expr(value, props)?;
            for a in args {
                infer_from_expr(a, props)?;
            }
            Ok(())
        }
        crate::ir::Expr::Compare { lhs, rhs, .. } => {
            infer_from_expr(lhs, props)?;
            infer_from_expr(rhs, props)
        }
        crate::ir::Expr::Logical { lhs, rhs, .. } => {
            infer_from_expr(lhs, props)?;
            infer_from_expr(rhs, props)
        }
        crate::ir::Expr::Not(inner) => infer_from_expr(inner, props),
    }
}

/// Walk a JsxNode subtree collecting `MapMember { root == binding, path }`
/// references and merging them into `fields` as the binding-local struct shape.
fn collect_map_member_fields(
    node: &JsxNode,
    binding: &str,
    fields: &mut BTreeMap<String, PropType>,
) {
    match node {
        JsxNode::Empty | JsxNode::Text(_) => {}
        JsxNode::Element {
            attrs, children, ..
        } => {
            for a in attrs {
                if let AttrValue::Expr(e) = &a.value {
                    collect_map_member_from_expr(e, binding, fields);
                }
            }
            for c in children {
                collect_map_member_fields(c, binding, fields);
            }
        }
        JsxNode::Expr(e) => collect_map_member_from_expr(e, binding, fields),
        // `dangerouslySetInnerHTML` path carries a member-path expr; route it
        // through the same collector (a literal carries nothing).
        JsxNode::RawHtml(HeadValue::Path(e)) => collect_map_member_from_expr(e, binding, fields),
        JsxNode::RawHtml(HeadValue::Literal(_)) => {}
        // `<BrustPage>` is root-only, so a Document never appears inside a Map
        // body — this arm exists only to keep the match exhaustive.
        JsxNode::Document { .. } => {}
        JsxNode::Map { source, body, .. } => {
            // Nested maps: only inherit MapMember refs whose root matches
            // OUR binding (the outer one). The inner Map handles its own
            // binding in its own seeding pass.
            collect_map_member_from_expr(source, binding, fields);
            collect_map_member_fields(body, binding, fields);
        }
        // Islands are rejected under `.map(...)` (see `lower_island`), so an
        // Island node never appears in a Map body. Nothing to collect.
        JsxNode::Island { .. } => {}
        // SsrComponent is opaque in map context — no MapMember refs to collect.
        JsxNode::SsrComponent { .. } => {}
        JsxNode::Cond {
            test,
            consequent,
            alternate,
        } => {
            collect_map_member_from_expr(test, binding, fields);
            collect_map_member_fields(consequent, binding, fields);
            if let Some(alt) = alternate {
                collect_map_member_fields(alt, binding, fields);
            }
        }
        JsxNode::ChildrenSlot => {}
        JsxNode::Fragment { children } => {
            for c in children {
                collect_map_member_fields(c, binding, fields);
            }
        }
    }
}

fn collect_map_member_from_expr(
    expr: &crate::ir::Expr,
    binding: &str,
    fields: &mut BTreeMap<String, PropType>,
) {
    match expr {
        crate::ir::Expr::MapMember { root, path } if root == binding => {
            // Build a Struct chain for the path and merge into fields.
            let chain = build_struct_chain(path);
            merge_field(fields, path.first().expect("path non-empty"), chain);
        }
        crate::ir::Expr::MapBinding(name) if name == binding => {
            // Bare binding reference — yields a String (the binding itself).
            // Marker only; specific field merge happens via MapMember above.
        }
        _ => {}
    }
}

fn merge_field(fields: &mut BTreeMap<String, PropType>, key: &str, incoming: PropType) {
    match fields.get_mut(key) {
        None => {
            // The chain is rooted at `key`, but here we want to insert the
            // VALUE under `key`. The chain we built was `Struct{key => …}`;
            // strip the wrapper and insert the inner value.
            if let PropType::Struct(mut inner) = incoming
                && let Some(value) = inner.remove(key)
            {
                fields.insert(key.to_string(), value);
            }
        }
        Some(existing) => {
            // Best-effort merge; on cross-shape conflict we ignore silently
            // (the outer merge_into will catch any real prop-level conflict).
            if let PropType::Struct(mut inner) = incoming
                && let Some(value) = inner.remove(key)
                && let (PropType::Struct(ex_map), PropType::Struct(in_map)) = (existing, value)
            {
                for (k, v) in in_map {
                    ex_map.entry(k).or_insert(v);
                }
            }
        }
    }
}

/// Seed `props.types[<source root>]` with `VecOf(element_struct)`. If the source
/// is a `MemberAccess`, build a nested Struct chain whose leaf is the VecOf.
fn seed_vec_at_source(
    props: &mut PropsShape,
    source: &crate::ir::Expr,
    element_struct: PropType,
    _expr_for_span: &crate::ir::Expr,
) -> Result<(), LowerError> {
    match source {
        crate::ir::Expr::Field(name) => {
            merge_type(props, name, PropType::VecOf(Box::new(element_struct)))
        }
        crate::ir::Expr::MemberAccess { root, path } => {
            // Build a Struct chain ending in VecOf(element_struct).
            let mut current = PropType::VecOf(Box::new(element_struct));
            for seg in path.iter().rev() {
                let mut map = BTreeMap::new();
                map.insert(seg.clone(), current);
                current = PropType::Struct(map);
            }
            merge_type(props, root, current)
        }
        // Map sourced from a MapBinding/MapMember (nested map binding) or a
        // literal — leave inference alone. Top-level props don't gain info.
        _ => Ok(()),
    }
}

/// Build `Struct { path[0] => Struct { path[1] => … OwnedString } }` for a
/// non-empty path. For a single-segment path, returns
/// `Struct { path[0] => OwnedString }`.
fn build_struct_chain(path: &[String]) -> PropType {
    let mut current = PropType::OwnedString;
    for seg in path.iter().rev() {
        let mut map = BTreeMap::new();
        map.insert(seg.clone(), current);
        current = PropType::Struct(map);
    }
    current
}

/// Merge `incoming` into `props.types[name]`. On conflict (e.g. `OwnedString`
/// where a `Struct` was previously inferred), surface `PropTypeConflict`.
fn merge_type(props: &mut PropsShape, name: &str, incoming: PropType) -> Result<(), LowerError> {
    match props.types.get_mut(name) {
        None => {
            props.types.insert(name.to_string(), incoming);
            Ok(())
        }
        Some(existing) => merge_into(existing, incoming, name),
    }
}

fn merge_into(existing: &mut PropType, incoming: PropType, name: &str) -> Result<(), LowerError> {
    match (existing, incoming) {
        (PropType::OwnedString, PropType::OwnedString) => Ok(()),
        (PropType::Struct(ex_fields), PropType::Struct(in_fields)) => {
            for (k, v) in in_fields {
                match ex_fields.get_mut(&k) {
                    None => {
                        ex_fields.insert(k, v);
                    }
                    Some(ex_v) => merge_into(ex_v, v, name)?,
                }
            }
            Ok(())
        }
        // Any cross-shape combination is a conflict the user must resolve.
        _ => Err(LowerError::at(
            Span::default(),
            ErrorKind::PropTypeConflict(name.to_string()),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compile_full;
    use crate::parser::parse;

    #[test]
    fn lowers_zero_prop_static_jsx() {
        let src = r#"export default function StaticHello() {
  return (
    <div>
      <h1>Hello from compiled Rust</h1>
      <p>This page is statically generated.</p>
    </div>
  )
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        assert_eq!(c.name, "StaticHello");
        match &c.root {
            JsxNode::Element { tag, children, .. } => {
                assert_eq!(tag, "div");
                assert_eq!(children.len(), 2);
            }
            _ => panic!("expected root element"),
        }
    }

    #[test]
    fn tolerates_extra_top_level_statements() {
        // Single-file native component: an `export const behavior` (and a bare
        // `const`) co-located with the `export default function` template. These
        // extra top-level statements are now ignored instead of producing
        // `UnexpectedStatement`; only the default function is lowered.
        let src = r#"import { signal } from "brustjs";
const api = "/api";
export const behavior = (el) => ({ count: 0 });
export function helper() { return 1; }
type Props = { x: string };
export default function Counter() {
  return <div>hello</div>;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        assert_eq!(c.name, "Counter");
        assert!(
            matches!(&c.root, JsxNode::Element { tag, .. } if tag == "div"),
            "expected div root, got {:?}",
            c.root
        );
    }

    #[test]
    fn single_file_native_component_compiles_with_directive_attr() {
        // The canonical single-file native shape: an `export const behavior`
        // next to the default template, whose JSX carries a directive attribute
        // (`x-data`). The default export must still be found + lowered, and the
        // emitted jinja must contain the `x-data` attribute.
        let src = r#"import { signal } from "brustjs";
export const behavior = () => ({});
export default function C() {
  return <div x-data="c" />;
}"#;
        let c = compile_full(src, "<test>", HashMap::new(), HashMap::new()).unwrap();
        assert!(
            c.template.contains("x-data=\"c\""),
            "expected x-data attribute in template, got: {}",
            c.template
        );
    }

    #[test]
    fn rejects_two_default_functions() {
        // The duplicate-default guard is preserved.
        let src = r#"export default function A() { return <a/>; }
export default function B() { return <b/>; }"#;
        let parsed = parse(src, "<test>");
        // swc may reject two default exports at parse time; if it parses, lowering
        // must still reject it as `UnexpectedStatement`.
        if let Ok(parsed) = parsed {
            let err = lower(&parsed).unwrap_err();
            assert!(
                matches!(err.kind, ErrorKind::UnexpectedStatement),
                "got {:?}",
                err.kind
            );
        }
    }

    #[test]
    fn rejects_no_default_function() {
        // The "no default fn found" guard is preserved.
        let src = r#"import { x } from "y";
export const behavior = () => ({});"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::UnexpectedStatement),
            "got {:?}",
            err.kind
        );
    }

    #[test]
    fn capitalised_tag_lowers_to_ssr_component() {
        // Previously rejected as `CustomComponentNotSupported`; now lowers to
        // `JsxNode::SsrComponent` — the entry point for native SSR components.
        let src = "export default function X() { return <Layout/>; }";
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        assert!(
            matches!(c.root, JsxNode::SsrComponent { ref component, .. } if component == "Layout"),
            "expected SsrComponent(Layout), got {:?}",
            c.root
        );
    }

    #[test]
    fn root_fragment_lowers() {
        let src = "export default function X() { return <><a/><b/></>; }";
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        match &c.root {
            JsxNode::Fragment { children } => {
                assert_eq!(children.len(), 2);
                assert!(matches!(&children[0], JsxNode::Element { tag, .. } if tag == "a"));
                assert!(matches!(&children[1], JsxNode::Element { tag, .. } if tag == "b"));
            }
            other => panic!("expected Fragment root, got {other:?}"),
        }
    }

    #[test]
    fn fragment_child_of_element() {
        let src = "export default function X() { return <ul><><li/><li/></></ul>; }";
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        match &c.root {
            JsxNode::Element { tag, children, .. } => {
                assert_eq!(tag, "ul");
                assert_eq!(children.len(), 1);
                match &children[0] {
                    JsxNode::Fragment {
                        children: frag_children,
                    } => {
                        assert_eq!(frag_children.len(), 2);
                        assert!(
                            matches!(&frag_children[0], JsxNode::Element { tag, .. } if tag == "li")
                        );
                        assert!(
                            matches!(&frag_children[1], JsxNode::Element { tag, .. } if tag == "li")
                        );
                    }
                    other => panic!("expected Fragment child, got {other:?}"),
                }
            }
            other => panic!("expected ul element, got {other:?}"),
        }
    }

    #[test]
    fn fragment_drops_whitespace() {
        // Whitespace spanning a line break is indentation → dropped by normalize_jsx_text.
        let src = "export default function X() { return (\n  <>\n    <a/>\n  </>\n); }";
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        match &c.root {
            JsxNode::Fragment { children } => {
                assert_eq!(
                    children.len(),
                    1,
                    "expected exactly 1 child, got {children:?}"
                );
                assert!(matches!(&children[0], JsxNode::Element { tag, .. } if tag == "a"));
            }
            other => panic!("expected Fragment root, got {other:?}"),
        }
    }

    #[test]
    fn fragment_map_body_still_rejected() {
        // xs.map(x => <></>) inside a route → MapShapeNotSupported
        let src = r#"export default function X({ xs }) {
  return <ul>{xs.map(x => <></>)}</ul>;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::MapShapeNotSupported),
            "expected MapShapeNotSupported, got {:?}",
            err.kind
        );
    }

    #[test]
    fn brust_page_in_fragment_rejected() {
        let src = "export default function X() { return <><BrustPage/></>; }";
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::BrustPageMustBeRoot),
            "expected BrustPageMustBeRoot, got {:?}",
            err.kind
        );
    }

    #[test]
    fn brust_page_title_member_path_lowers_to_head_path() {
        let src = r#"export default function X({ d }) {
  return <BrustPage title={d.title}><main>hi</main></BrustPage>;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        match &c.root {
            JsxNode::Document { title, .. } => match title {
                Some(HeadValue::Path(Expr::MemberAccess { root, path })) => {
                    assert_eq!(root, "d");
                    assert_eq!(path, &vec!["title".to_string()]);
                }
                other => panic!("expected HeadValue::Path(MemberAccess), got {other:?}"),
            },
            other => panic!("expected Document, got {other:?}"),
        }
    }

    #[test]
    fn brust_page_title_string_literal_lowers_to_head_literal() {
        let src = r#"export default function X() {
  return <BrustPage title="x"><main>hi</main></BrustPage>;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        match &c.root {
            JsxNode::Document { title, .. } => {
                assert!(
                    matches!(title, Some(HeadValue::Literal(s)) if s == "x"),
                    "expected HeadValue::Literal(\"x\"), got {title:?}"
                );
            }
            other => panic!("expected Document, got {other:?}"),
        }
    }

    #[test]
    fn brust_page_omitted_lang_defaults_to_en_literal() {
        let src = r#"export default function X() {
  return <BrustPage title="x"><main>hi</main></BrustPage>;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        match &c.root {
            JsxNode::Document { lang, .. } => {
                assert!(
                    matches!(lang, Some(HeadValue::Literal(s)) if s == "en"),
                    "expected HeadValue::Literal(\"en\"), got {lang:?}"
                );
            }
            other => panic!("expected Document, got {other:?}"),
        }
    }

    #[test]
    fn brust_page_call_expr_attr_rejected() {
        let src = r#"export default function X({ fn }) {
  return <BrustPage title={fn()}><main>hi</main></BrustPage>;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::BrustPageAttrMustBeStringLiteral(ref n) if n == "title"),
            "expected BrustPageAttrMustBeStringLiteral, got {:?}",
            err.kind
        );
    }

    #[test]
    fn brust_page_arith_attr_rejected() {
        let src = r#"export default function X({ a, b }) {
  return <BrustPage title={a + b}><main>hi</main></BrustPage>;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::BrustPageAttrMustBeStringLiteral(ref n) if n == "title"),
            "expected BrustPageAttrMustBeStringLiteral, got {:?}",
            err.kind
        );
    }

    #[test]
    fn fragment_in_ssr_component_rejected() {
        let src = r#"export default function X() {
  return <Layout><>a</></Layout>;
}"#;
        let err = compile_full(src, "<test>", HashMap::new(), HashMap::new()).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::FragmentInSsrComponentNotSupported),
            "expected FragmentInSsrComponentNotSupported, got {:?}",
            err.kind
        );
    }

    // A fragment NESTED inside a host element that is itself an SSR-component
    // child still reaches the factory emitter (which cannot represent a
    // fragment), so it must be rejected too — not just direct fragment children.
    #[test]
    fn fragment_nested_in_ssr_component_rejected() {
        let src = r#"export default function X() {
  return <Layout><div><>x</></div></Layout>;
}"#;
        let err = compile_full(src, "<test>", HashMap::new(), HashMap::new()).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::FragmentInSsrComponentNotSupported),
            "expected FragmentInSsrComponentNotSupported, got {:?}",
            err.kind
        );
    }

    #[test]
    fn fragment_inline_children_slot() {
        // A component body `<>{children}</>` lowered via inline path yields
        // [Fragment{..}] containing a ChildrenSlot, and splice_children_slots replaces it.
        let src = r#"export default function C({ children }: any) {
  return <>{children}</>;
}"#;
        let nodes = inline_lower(src, HashMap::new(), true).unwrap();
        assert_eq!(nodes.len(), 1);
        match &nodes[0] {
            JsxNode::Fragment { children } => {
                assert_eq!(children.len(), 1);
                assert!(
                    matches!(children[0], JsxNode::ChildrenSlot),
                    "expected ChildrenSlot inside Fragment, got {:?}",
                    children[0]
                );
            }
            other => panic!("expected Fragment, got {other:?}"),
        }

        // Now verify splice_children_slots replaces the slot.
        let call_site_children = vec![JsxNode::Element {
            tag: "span".into(),
            attrs: vec![],
            children: vec![],
        }];
        let mut root = nodes.into_iter().next().unwrap();
        super::splice_children_slots(&mut root, &call_site_children);
        match &root {
            JsxNode::Fragment { children } => {
                assert_eq!(children.len(), 1);
                assert!(
                    matches!(&children[0], JsxNode::Element { tag, .. } if tag == "span"),
                    "expected span after splice, got {:?}",
                    children[0]
                );
            }
            other => panic!("expected Fragment after splice, got {other:?}"),
        }
    }

    #[test]
    fn rejects_spread_attribute() {
        let src = "export default function X(props) { return <div {...props}/>; }";
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::SpreadAttributeNotSupported));
    }

    // T4 — positive cases

    #[test]
    fn lowers_destructured_prop_ident() {
        let src = r#"export default function PropsHello({ title }: { title: string }) {
  return <h1>{title}</h1>;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        assert_eq!(c.props.bindings, vec!["title".to_string()]);
        // Inferred type
        assert_eq!(c.props.types.get("title"), Some(&PropType::OwnedString));
        // Root <h1>{title}</h1>
        match &c.root {
            JsxNode::Element { tag, children, .. } => {
                assert_eq!(tag, "h1");
                assert_eq!(children.len(), 1);
                match &children[0] {
                    JsxNode::Expr(crate::ir::Expr::Field(name)) => assert_eq!(name, "title"),
                    other => panic!("expected Expr(Field(\"title\")), got {other:?}"),
                }
            }
            _ => panic!("expected root element"),
        }
    }

    #[test]
    fn lowers_member_access_two_segments() {
        let src = r#"export default function UserBox({ user }: { user: { name: string } }) {
  return <span>{user.name}</span>;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        // Inferred: user => Struct { name => OwnedString }
        let mut expected_fields = BTreeMap::new();
        expected_fields.insert("name".to_string(), PropType::OwnedString);
        assert_eq!(
            c.props.types.get("user"),
            Some(&PropType::Struct(expected_fields))
        );
        match &c.root {
            JsxNode::Element { children, .. } => match &children[0] {
                JsxNode::Expr(crate::ir::Expr::MemberAccess { root, path }) => {
                    assert_eq!(root, "user");
                    assert_eq!(path, &vec!["name".to_string()]);
                }
                other => panic!("expected MemberAccess, got {other:?}"),
            },
            _ => panic!("expected root element"),
        }
    }

    // T4 — error cases

    #[test]
    fn rejects_unresolved_ident() {
        let src = r#"export default function X() {
  return <span>{nope}</span>;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        match err.kind {
            ErrorKind::UnresolvedIdent(name) => assert_eq!(name, "nope"),
            other => panic!("expected UnresolvedIdent, got {other:?}"),
        }
    }

    #[test]
    fn rejects_template_literal() {
        let src = r#"export default function X({ a }: { a: string }) {
  return <span>{`hi ${a}`}</span>;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::TemplateLiteralNotSupported));
    }

    #[test]
    fn rejects_call_expression() {
        let src = r#"export default function X({ a }: { a: string }) {
  return <span>{a.toUpperCase()}</span>;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::CallExpressionNotSupported));
    }

    #[test]
    fn rejects_complex_expression() {
        let src = r#"export default function X({ a, b }: { a: string; b: string }) {
  return <span>{a + b}</span>;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::ComplexExpressionNotSupported));
    }

    #[test]
    fn rejects_non_integer_number() {
        let src = r#"export default function X() {
  return <span>{1.5}</span>;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::NonIntegerNumericNotSupported));
    }

    #[test]
    fn rejects_bare_named_param() {
        let src = r#"export default function X(props: any) {
  return <span>{props}</span>;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        match err.kind {
            ErrorKind::BareIdentNotSupported(name) => assert_eq!(name, "props"),
            other => panic!("expected BareIdentNotSupported, got {other:?}"),
        }
    }

    // T5 — .map((item) => <JSX>) lowering and Vec<XsItem> inference

    #[test]
    fn lowers_map_one_arg() {
        let src = r#"export default function ListNav({ items }) {
  return <ul>{items.map((item) => (<li>{item.label}</li>))}</ul>;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        match &c.root {
            JsxNode::Element { tag, children, .. } => {
                assert_eq!(tag, "ul");
                assert_eq!(children.len(), 1);
                match &children[0] {
                    JsxNode::Map {
                        source,
                        binding,
                        body,
                    } => {
                        assert_eq!(binding, "item");
                        match source {
                            crate::ir::Expr::Field(name) => assert_eq!(name, "items"),
                            other => panic!("expected Field(\"items\"), got {other:?}"),
                        }
                        match body.as_ref() {
                            JsxNode::Element { tag, .. } => assert_eq!(tag, "li"),
                            other => panic!("expected <li> body, got {other:?}"),
                        }
                    }
                    other => panic!("expected JsxNode::Map, got {other:?}"),
                }
            }
            other => panic!("expected root element, got {other:?}"),
        }
    }

    #[test]
    fn lowers_map_with_member_body() {
        let src = r#"export default function UsersList({ users }) {
  return <ul>{users.map((u) => (<li>{u.name.first}</li>))}</ul>;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        // Body should contain a MapMember{root:"u", path:["name","first"]}
        let map_body = match &c.root {
            JsxNode::Element { children, .. } => match &children[0] {
                JsxNode::Map { body, .. } => body,
                other => panic!("expected Map, got {other:?}"),
            },
            other => panic!("expected element, got {other:?}"),
        };
        let li_children = match map_body.as_ref() {
            JsxNode::Element { children, .. } => children,
            other => panic!("expected <li> element, got {other:?}"),
        };
        match &li_children[0] {
            JsxNode::Expr(crate::ir::Expr::MapMember { root, path }) => {
                assert_eq!(root, "u");
                assert_eq!(path, &vec!["name".to_string(), "first".to_string()]);
            }
            other => panic!("expected MapMember, got {other:?}"),
        }
    }

    #[test]
    fn rejects_map_two_arg() {
        let src = r#"export default function X({ items }) {
  return <ul>{items.map((item, idx) => <li/>)}</ul>;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::MapIndexParamNotSupported),
            "got {:?}",
            err.kind
        );
    }

    #[test]
    fn rejects_map_zero_arg() {
        let src = r#"export default function X({ items }) {
  return <ul>{items.map(() => <li/>)}</ul>;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::MapShapeNotSupported),
            "got {:?}",
            err.kind
        );
    }

    #[test]
    fn rejects_map_non_jsx_body() {
        let src = r#"export default function X({ items }) {
  return <ul>{items.map((item) => item.name)}</ul>;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::MapShapeNotSupported),
            "got {:?}",
            err.kind
        );
    }

    #[test]
    fn infers_vec_of_struct_for_map_member_paths() {
        let src = r#"export default function ListNav({ items }) {
  return <ul>{items.map((item) => (<li><a href={item.href}>{item.label}</a></li>))}</ul>;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        // Expected: props.types["items"] = VecOf(Struct{href: OwnedString, label: OwnedString})
        let mut expected_fields = BTreeMap::new();
        expected_fields.insert("href".to_string(), PropType::OwnedString);
        expected_fields.insert("label".to_string(), PropType::OwnedString);
        assert_eq!(
            c.props.types.get("items"),
            Some(&PropType::VecOf(Box::new(PropType::Struct(
                expected_fields
            ))))
        );
    }

    // T6 — whitespace normalization, attr renames, void-element rejection.

    #[test]
    fn drops_whitespace_only_jsx_text() {
        // The text gaps around the inner <p/> are indentation (whitespace that
        // spans a line break) and must be dropped, leaving the outer <div> with
        // exactly 1 child: <p/>. (Inline whitespace WITHOUT a newline is a
        // significant boundary space — see preserves_inline_boundary_space_*.)
        let src = "export default function X() { return <div>\n   <p/>\n   </div>; }";
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        match &c.root {
            JsxNode::Element { tag, children, .. } => {
                assert_eq!(tag, "div");
                assert_eq!(
                    children.len(),
                    1,
                    "expected just the <p/>, got {children:?}"
                );
                match &children[0] {
                    JsxNode::Element { tag, .. } => assert_eq!(tag, "p"),
                    other => panic!("expected <p/> child, got {other:?}"),
                }
            }
            _ => panic!("expected root element"),
        }
    }

    #[test]
    fn collapses_internal_whitespace_to_single_space() {
        let src = "export default function X() { return <p>foo   bar\n  baz</p>; }";
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        match &c.root {
            JsxNode::Element { children, .. } => {
                assert_eq!(children.len(), 1);
                match &children[0] {
                    JsxNode::Text(s) => assert_eq!(s, "foo bar baz"),
                    other => panic!("expected Text, got {other:?}"),
                }
            }
            _ => panic!("expected root element"),
        }
    }

    #[test]
    fn preserves_inline_boundary_space_around_element() {
        // The space between "a" and <strong> (same line, no newline) must
        // survive so the emitted HTML reads like the source TSX.
        let src = "export default function X() { return <p>You are looking at a <strong>Native Route</strong>. Done</p>; }";
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        let children = match &c.root {
            JsxNode::Element { children, .. } => children,
            other => panic!("expected <p>, got {other:?}"),
        };
        // [ Text("You are looking at a "), <strong>, Text(". Done") ]
        match &children[0] {
            JsxNode::Text(t) => assert_eq!(t, "You are looking at a "),
            other => panic!("expected leading text with trailing space, got {other:?}"),
        }
        match &children[2] {
            JsxNode::Text(t) => assert_eq!(t, ". Done"),
            other => panic!("expected trailing text, got {other:?}"),
        }
    }

    #[test]
    fn drops_indentation_whitespace_bordering_newline() {
        // Leading whitespace that spans a newline is indentation → dropped; the
        // trailing inline space before <code> is kept.
        let src = "export default function X() {\n  return (\n    <p>\n      Edit <code>file</code>\n    </p>\n  );\n}";
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        let children = match &c.root {
            JsxNode::Element { children, .. } => children,
            other => panic!("expected <p>, got {other:?}"),
        };
        match &children[0] {
            JsxNode::Text(t) => assert_eq!(t, "Edit "),
            other => {
                panic!("expected \"Edit \" (indent dropped, inline space kept), got {other:?}")
            }
        }
    }

    #[test]
    fn renames_classname_to_class() {
        let src = r#"export default function X() { return <div className="x"/>; }"#;
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        match &c.root {
            JsxNode::Element { attrs, .. } => {
                assert_eq!(attrs.len(), 1);
                assert_eq!(attrs[0].name, "class");
                match &attrs[0].value {
                    AttrValue::Static(s) => assert_eq!(s, "x"),
                    other => panic!("expected Static(\"x\"), got {other:?}"),
                }
            }
            _ => panic!("expected root element"),
        }
    }

    #[test]
    fn renames_htmlfor_to_for() {
        let src = r#"export default function X() { return <label htmlFor="x"/>; }"#;
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        match &c.root {
            JsxNode::Element { attrs, .. } => {
                assert_eq!(attrs.len(), 1);
                assert_eq!(attrs[0].name, "for");
                match &attrs[0].value {
                    AttrValue::Static(s) => assert_eq!(s, "x"),
                    other => panic!("expected Static(\"x\"), got {other:?}"),
                }
            }
            _ => panic!("expected root element"),
        }
    }

    #[test]
    fn drops_key_attribute() {
        // `key` is a React-only attribute — must be filtered before emit.
        let src = r#"export default function X() { return <li key="a"/>; }"#;
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        match &c.root {
            JsxNode::Element { tag, attrs, .. } => {
                assert_eq!(tag, "li");
                assert!(
                    attrs.is_empty(),
                    "expected key to be dropped, got {attrs:?}"
                );
            }
            _ => panic!("expected root element"),
        }
    }

    #[test]
    fn rejects_ref_attribute() {
        let src = r#"export default function X() { return <div ref="x"/>; }"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::RefAttributeNotSupported),
            "got {:?}",
            err.kind
        );
    }

    #[test]
    fn rejects_onclick_handler() {
        // `{x}` needs `x` in scope, so use destructured props.
        let src = r#"export default function X({ x }) { return <button onClick={x}/>; }"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        match err.kind {
            ErrorKind::EventHandlerNotSupported(name) => assert_eq!(name, "onClick"),
            other => panic!("expected EventHandlerNotSupported(\"onClick\"), got {other:?}"),
        }
    }

    #[test]
    fn rejects_unknown_uppercase_attr() {
        let src = r#"export default function X() { return <div fooBar="x"/>; }"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        match err.kind {
            ErrorKind::UnknownAttributeRename(name) => assert_eq!(name, "fooBar"),
            other => panic!("expected UnknownAttributeRename(\"fooBar\"), got {other:?}"),
        }
    }

    #[test]
    fn rejects_br_with_children() {
        let src = r#"export default function X() { return <br>hi</br>; }"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        match err.kind {
            ErrorKind::VoidElementHasChildren(tag) => assert_eq!(tag, "br"),
            other => panic!("expected VoidElementHasChildren(\"br\"), got {other:?}"),
        }
    }

    // T1 — <Island> recognition path

    #[test]
    fn lowers_island_member_props_full_attrs() {
        let src = r#"export default function Page({ data }) {
  return <Island component={Counter} props={data.counter} hydrate="visible" ssr />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        match &c.root {
            JsxNode::Island {
                component,
                props_path,
                hydrate,
                ssr,
                ..
            } => {
                assert_eq!(component, "Counter");
                // Full dotted path (root included) — `data` is a destructured
                // context key, so the value lives at `loaderReturn.data.counter`.
                assert_eq!(props_path, "data.counter");
                assert_eq!(hydrate, "visible");
                assert!(*ssr);
            }
            other => panic!("expected Island, got {other:?}"),
        }
    }

    #[test]
    fn lowers_island_bare_ident_props_defaults() {
        let src = r#"export default function Page({ counter }) {
  return <Island component={Counter} props={counter} />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        match &c.root {
            JsxNode::Island {
                component,
                props_path,
                hydrate,
                ssr,
                ..
            } => {
                assert_eq!(component, "Counter");
                assert_eq!(props_path, "counter");
                assert_eq!(hydrate, "load");
                assert!(!*ssr);
            }
            other => panic!("expected Island, got {other:?}"),
        }
    }

    #[test]
    fn lowers_propless_island_to_empty_props_path() {
        // A propless island (no `props=` attr) is legal — props_path is "" and the
        // emitters render it as `{}`.
        let src = r#"export default function Page() {
  return <Island component={NavBar} hydrate="load" />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        match &c.root {
            JsxNode::Island {
                component,
                props_path,
                hydrate,
                ssr,
                ..
            } => {
                assert_eq!(component, "NavBar");
                assert_eq!(props_path, "");
                assert_eq!(hydrate, "load");
                assert!(!*ssr);
            }
            other => panic!("expected Island, got {other:?}"),
        }
    }

    #[test]
    fn island_id_attr_is_rejected() {
        // `id=` is no longer supported — addressed by `component={…}` + instance.
        let src = r#"export default function Page({ counter }) {
  return <Island component={Counter} id="myId" props={counter} />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::IslandIdAttrRemoved));
    }

    #[test]
    fn lowers_isr_key_tags_revalidate() {
        let src = r#"export default function Page({ data }) {
  return <Island component={Counter} props={data.counter} hydrate="load" ssr
    isr={{ key: data.cacheKey, tags: data.cacheTags, revalidate: 60 }} />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        match &c.root {
            JsxNode::Island {
                key_path,
                tags_path,
                revalidate,
                ssr,
                ..
            } => {
                assert!(*ssr);
                assert_eq!(key_path.as_deref(), Some("data.cacheKey"));
                assert_eq!(tags_path.as_deref(), Some("data.cacheTags"));
                assert_eq!(*revalidate, Some(60));
            }
            other => panic!("expected Island, got {other:?}"),
        }
    }

    #[test]
    fn isr_without_ssr_is_rejected() {
        let src = r#"export default function Page({ data }) {
  return <Island component={Counter} props={data.counter} hydrate="load"
    isr={{ key: data.cacheKey, tags: data.cacheTags, revalidate: 60 }} />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::IslandIsrUnsupported));
    }

    #[test]
    fn isr_dynamic_revalidate_is_rejected() {
        let src = r#"export default function Page({ data }) {
  return <Island component={Counter} props={data.counter} ssr
    isr={{ key: data.k, revalidate: data.ttl }} />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::IslandIsrUnsupported));
    }

    #[test]
    fn isr_key_only_is_allowed() {
        let src = r#"export default function Page({ data }) {
  return <Island component={Counter} props={data.counter} ssr
    isr={{ key: data.cacheKey }} />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        match &c.root {
            JsxNode::Island {
                key_path,
                tags_path,
                revalidate,
                ..
            } => {
                assert_eq!(key_path.as_deref(), Some("data.cacheKey"));
                assert_eq!(*tags_path, None);
                assert_eq!(*revalidate, None);
            }
            other => panic!("expected Island, got {other:?}"),
        }
    }

    #[test]
    fn isr_fractional_revalidate_is_rejected() {
        // `as u32` would silently truncate 60.5 → 60; reject instead.
        let src = r#"export default function Page({ data }) {
  return <Island component={Counter} props={data.counter} ssr
    isr={{ key: data.cacheKey, revalidate: 60.5 }} />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::IslandIsrUnsupported));
    }

    #[test]
    fn isr_negative_revalidate_is_rejected() {
        // `-1 as u32` would saturate to 0 (expire-immediately); reject instead.
        let src = r#"export default function Page({ data }) {
  return <Island component={Counter} props={data.counter} ssr
    isr={{ key: data.cacheKey, revalidate: -1 }} />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::IslandIsrUnsupported));
    }

    #[test]
    fn isr_oversized_revalidate_is_rejected() {
        // > u32::MAX/1000 secs would overflow when sent as `revalidate*1000` ms.
        let src = r#"export default function Page({ data }) {
  return <Island component={Counter} props={data.counter} ssr
    isr={{ key: data.cacheKey, revalidate: 5000000 }} />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::IslandIsrUnsupported));
    }

    #[test]
    fn isr_without_key_is_rejected() {
        // `key` is mandatory — a tags-/revalidate-only isr has nothing to key by.
        let src = r#"export default function Page({ data }) {
  return <Island component={Counter} props={data.counter} ssr
    isr={{ tags: data.cacheTags, revalidate: 60 }} />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::IslandIsrUnsupported));
    }

    #[test]
    fn isr_empty_object_is_rejected() {
        let src = r#"export default function Page({ data }) {
  return <Island component={Counter} props={data.counter} ssr isr={{}} />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::IslandIsrUnsupported));
    }

    #[test]
    fn rejects_island_deep_props_path() {
        let src = r#"export default function Page({ data }) {
  return <Island component={Counter} props={data.a.b} />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::IslandPropsPathUnsupported));
    }

    #[test]
    fn rejects_island_missing_component() {
        let src = r#"export default function Page({ counter }) {
  return <Island props={counter} />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::IslandMissingComponent));
    }

    #[test]
    fn rejects_island_inside_map() {
        let src = r#"export default function Page({ items }) {
  return <ul>{items.map(i => <Island component={C} props={i.x} />)}</ul>;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::IslandInMapNotSupported));
    }

    #[test]
    fn rejects_island_non_string_id() {
        // Any `id=` form is rejected up front now, regardless of value shape.
        let src = r#"export default function Page({ counter }) {
  return <Island component={C} id={counter} props={counter} />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::IslandIdAttrRemoved));
    }

    #[test]
    fn rejects_island_hyphenated_id() {
        // `id=` is removed entirely; even a previously-"bad" hyphenated value is
        // now caught by the up-front `IslandIdAttrRemoved` reject arm.
        let src = r#"export default function Page({ counter }) {
  return <Island component={C} id="cart-widget" props={counter} />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::IslandIdAttrRemoved));
    }

    #[test]
    fn rejects_island_with_children() {
        let src = r#"export default function Page({ counter }) {
  return <Island component={C} props={counter}>hi</Island>;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::IslandHasChildren));
    }

    #[test]
    fn island_whitespace_only_children_tolerated() {
        let src = "export default function Page({ counter }) {\n  return <Island component={C} props={counter}>\n  </Island>;\n}";
        let parsed = parse(src, "<test>").unwrap();
        let c = lower(&parsed).unwrap();
        assert!(matches!(c.root, JsxNode::Island { .. }));
    }

    #[test]
    fn event_handler_on_normal_element_still_rejected() {
        // Regression guard for requirement #7: the dedicated `<Island>` path must
        // not change normal-element lowering — `onClick` on a `<button>` is still
        // an `EventHandlerNotSupported` error.
        let src = r#"export default function X({ x }) { return <button onClick={x}/>; }"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        match err.kind {
            ErrorKind::EventHandlerNotSupported(name) => assert_eq!(name, "onClick"),
            other => panic!("expected EventHandlerNotSupported(\"onClick\"), got {other:?}"),
        }
    }

    // lower_ssr_component — new tests

    #[test]
    fn lower_ssr_component_leaf() {
        let src =
            "export default function Page({ greeting }) { return <Header user={greeting} />; }";
        let c = compile_full(src, "<test>", HashMap::new(), HashMap::new()).unwrap();
        assert_eq!(c.components.len(), 1);
        assert_eq!(c.components[0].component, "Header");
        assert_eq!(c.components[0].instance, 0);
        assert!(c.islands.is_empty());
    }

    #[test]
    fn lower_ssr_component_camelcase_props_accepted() {
        use crate::parser;
        // Verify camelCase prop names survive lowering — this is the core reason
        // lower_ssr_component uses its own attr loop instead of lower_attr.
        let src = "export default function Page({ data }) { return <Card userName={data.name} isActive={data.active} />; }";
        let parsed = parser::parse(src, "<test>").unwrap();
        let ir = lower(&parsed).unwrap();
        match &ir.root {
            JsxNode::SsrComponent {
                component, props, ..
            } => {
                assert_eq!(component, "Card");
                assert_eq!(props.len(), 2);
                let names: Vec<&str> = props
                    .iter()
                    .map(|p| match p {
                        SsrProp::Attr(a) => a.name.as_str(),
                        SsrProp::Spread(_) => panic!("expected named attr, got spread"),
                    })
                    .collect();
                assert_eq!(names, vec!["userName", "isActive"]);
            }
            other => panic!("expected SsrComponent, got {other:?}"),
        }
    }

    #[test]
    fn lower_ssr_component_event_handler_rejected() {
        let src = "export default function Page({ data }) { return <Card onClick={data.fn} />; }";
        let err = compile_full(src, "<test>", HashMap::new(), HashMap::new()).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::EventHandlerNotSupported(_)),
            "got {:?}",
            err.kind
        );
    }

    #[test]
    fn lower_rejects_ssr_component_in_map() {
        let src = r#"export default function Page({ items }) {
  return <ul>{items.map((item) => <Layout title={item.name} />)}</ul>;
}"#;
        let err = compile_full(src, "<test>", HashMap::new(), HashMap::new()).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::SsrComponentInMapNotSupported(_)),
            "expected SsrComponentInMapNotSupported, got {:?}",
            err.kind
        );
    }

    #[test]
    fn map_xfor_sugar_composite_key_template_literal_rejected() {
        // bare `x-for` + a template-literal key (not a single member path) →
        // MapXForKeyRequired.
        let src = r#"export default function Grid({ items }) {
  return <ul>{items.map((t) => <a x-for key={`${t.a}-${t.b}`} href={t.href} />)}</ul>;
}"#;
        let err = compile_full(src, "<test>", HashMap::new(), HashMap::new()).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::MapXForKeyRequired),
            "expected MapXForKeyRequired, got {:?}",
            err.kind
        );
    }

    #[test]
    fn map_xfor_sugar_no_key_rejected() {
        // bare `x-for` with NO `key` → MapXForKeyRequired.
        let src = r#"export default function Grid({ items }) {
  return <ul>{items.map((t) => <a x-for href={t.href} />)}</ul>;
}"#;
        let err = compile_full(src, "<test>", HashMap::new(), HashMap::new()).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::MapXForKeyRequired),
            "expected MapXForKeyRequired, got {:?}",
            err.kind
        );
    }

    #[test]
    fn map_xfor_sugar_bare_binding_key_rejected() {
        // `key={t}` (the whole item, not a member path) → MapXForKeyRequired:
        // the runtime key would be the object's unstable stringification.
        let src = r#"export default function Grid({ items }) {
  return <ul>{items.map((t) => <a x-for key={t} href={t.href} />)}</ul>;
}"#;
        let err = compile_full(src, "<test>", HashMap::new(), HashMap::new()).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::MapXForKeyRequired),
            "expected MapXForKeyRequired, got {:?}",
            err.kind
        );
    }

    #[test]
    fn map_xfor_sugar_non_array_source_rejected() {
        // bare `x-for` over a nested-map inner source (a map binding member, not a
        // loader array path) → MapXForSourceNotArray.
        let src = r#"export default function Grid({ rows }) {
  return <ul>{rows.map((row) => <ul>{row.cells.map((c) => <a x-for key={c.id} href={c.href} />)}</ul>)}</ul>;
}"#;
        let err = compile_full(src, "<test>", HashMap::new(), HashMap::new()).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::MapXForSourceNotArray),
            "expected MapXForSourceNotArray, got {:?}",
            err.kind
        );
    }

    #[test]
    fn map_xfor_sugar_conditional_body_rejected() {
        // bare `x-for` on a conditional map body (not a single element) →
        // MapXForBodyNotElement.
        let src = r#"export default function Grid({ items }) {
  return <ul>{items.map((t) => t.ok && <a x-for key={t.id} href={t.href} />)}</ul>;
}"#;
        let err = compile_full(src, "<test>", HashMap::new(), HashMap::new()).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::MapXForBodyNotElement),
            "expected MapXForBodyNotElement, got {:?}",
            err.kind
        );
    }

    #[test]
    fn lower_ssr_component_with_children_island_not_in_manifest() {
        let src = r#"export default function Page({ greeting, data }) {
  return <Layout title={greeting}><h1>{greeting}</h1><Island component={Counter} props={data.counter} hydrate="load" /></Layout>;
}"#;
        let c = compile_full(src, "<test>", HashMap::new(), HashMap::new()).unwrap();
        assert_eq!(c.components.len(), 1);
        assert_eq!(c.components[0].component, "Layout");
        assert!(
            c.islands.is_empty(),
            "islands inside SsrComponent must not appear in manifest"
        );
    }

    #[test]
    fn lower_ssr_component_parses_isr() {
        let src = r#"export default function Page({ data }) {
  return <Layout title={data.title}
    isr={{ key: data.cacheKey, tags: data.cacheTags, revalidate: 60 }} />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let ir = lower(&parsed).unwrap();
        match &ir.root {
            JsxNode::SsrComponent {
                component,
                key_path,
                tags_path,
                revalidate,
                props,
                ..
            } => {
                assert_eq!(component, "Layout");
                assert_eq!(key_path.as_deref(), Some("data.cacheKey"));
                assert_eq!(tags_path.as_deref(), Some("data.cacheTags"));
                assert_eq!(*revalidate, Some(60));
                // `isr` is CONSUMED — it must NOT leak as a factory prop. Only
                // `title` survives as a prop.
                let names: Vec<&str> = props
                    .iter()
                    .map(|p| match p {
                        SsrProp::Attr(a) => a.name.as_str(),
                        SsrProp::Spread(_) => panic!("unexpected spread"),
                    })
                    .collect();
                assert_eq!(names, vec!["title"]);
            }
            other => panic!("expected SsrComponent, got {other:?}"),
        }
    }

    #[test]
    fn lower_ssr_component_isr_key_only_allowed() {
        // No `ssr` prerequisite for components (unlike islands).
        let src = r#"export default function Page({ data }) {
  return <Layout isr={{ key: data.cacheKey }} />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let ir = lower(&parsed).unwrap();
        match &ir.root {
            JsxNode::SsrComponent {
                key_path,
                tags_path,
                revalidate,
                ..
            } => {
                assert_eq!(key_path.as_deref(), Some("data.cacheKey"));
                assert_eq!(*tags_path, None);
                assert_eq!(*revalidate, None);
            }
            other => panic!("expected SsrComponent, got {other:?}"),
        }
    }

    #[test]
    fn lower_ssr_component_isr_without_key_rejected() {
        let src = r#"export default function Page({ data }) {
  return <Layout isr={{ tags: data.cacheTags }} />;
}"#;
        let err = compile_full(src, "<test>", HashMap::new(), HashMap::new()).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::ComponentIsrUnsupported(_)),
            "got {:?}",
            err.kind
        );
    }

    #[test]
    fn lower_ssr_component_isr_dynamic_revalidate_rejected() {
        let src = r#"export default function Page({ data }) {
  return <Layout isr={{ key: data.cacheKey, revalidate: data.ttl }} />;
}"#;
        let err = compile_full(src, "<test>", HashMap::new(), HashMap::new()).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::ComponentIsrUnsupported(_)),
            "got {:?}",
            err.kind
        );
    }

    #[test]
    fn lower_ssr_component_isr_literal_key() {
        let src = r#"export default function Page() {
  return <Layout isr={{ key: "navbar", tags: ["nav", "global"], revalidate: 30 }} />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let ir = lower(&parsed).unwrap();
        match &ir.root {
            JsxNode::SsrComponent {
                key_literal,
                key_path,
                tags_literal,
                tags_path,
                revalidate,
                ..
            } => {
                assert_eq!(key_literal.as_deref(), Some("navbar"));
                assert_eq!(*key_path, None);
                assert_eq!(
                    tags_literal.as_deref(),
                    Some(&["nav".to_string(), "global".to_string()][..])
                );
                assert_eq!(*tags_path, None);
                assert_eq!(*revalidate, Some(30));
            }
            other => panic!("expected SsrComponent, got {other:?}"),
        }
    }

    #[test]
    fn lower_island_isr_literal_key_and_empty_tags() {
        let src = r#"export default function Page({ data }) {
  return <Island component={Counter} props={data.counter} ssr isr={{ key: "ssrCounter", tags: [] }} />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let ir = lower(&parsed).unwrap();
        match &ir.root {
            JsxNode::Island {
                key_literal,
                tags_literal,
                ..
            } => {
                assert_eq!(key_literal.as_deref(), Some("ssrCounter"));
                assert_eq!(tags_literal.as_deref(), Some(&[][..]));
            }
            other => panic!("expected Island, got {other:?}"),
        }
    }

    #[test]
    fn lower_isr_nonstring_tag_element_rejected() {
        let src = r#"export default function Page({ data }) {
  return <Island component={Counter} props={data.counter} ssr isr={{ key: "k", tags: [123] }} />;
}"#;
        let err = compile_full(src, "<test>", HashMap::new(), HashMap::new()).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::IslandIsrUnsupported),
            "got {:?}",
            err.kind
        );
    }

    #[test]
    fn lower_isr_mixed_literal_key_path_tags() {
        // literal key + path tags is a valid independent combination.
        let src = r#"export default function Page({ data }) {
  return <Layout isr={{ key: "navbar", tags: data.cacheTags }} />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let ir = lower(&parsed).unwrap();
        match &ir.root {
            JsxNode::SsrComponent {
                key_literal,
                key_path,
                tags_literal,
                tags_path,
                ..
            } => {
                assert_eq!(key_literal.as_deref(), Some("navbar"));
                assert_eq!(*key_path, None);
                assert_eq!(*tags_literal, None);
                assert_eq!(tags_path.as_deref(), Some("data.cacheTags"));
            }
            other => panic!("expected SsrComponent, got {other:?}"),
        }
    }

    #[test]
    fn lower_isr_duplicate_key_rejected() {
        let src = r#"export default function Page({ data }) {
  return <Layout isr={{ key: "a", key: data.x }} />;
}"#;
        let err = compile_full(src, "<test>", HashMap::new(), HashMap::new()).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::ComponentIsrUnsupported(_)),
            "got {:?}",
            err.kind
        );
    }

    // ── T5 inline-mode tests ──────────────────────────────────────────────────

    /// Helper: parse source, call lower_component_inline (no env = T5 mode).
    fn inline_lower(
        src: &str,
        subst: HashMap<String, crate::ir::Expr>,
        has_children: bool,
    ) -> Result<Vec<JsxNode>, LowerError> {
        let parsed = parse(src, "<test>").unwrap();
        super::lower_component_inline(&parsed, subst, has_children, None, None, false)
    }

    // ── Document-root inline (native layout shell) ────────────────────────────

    fn lower_route_with_layout(
        route_src: &str,
        layout_name: &str,
        layout_src: &str,
    ) -> (Component, Vec<String>) {
        let parsed = parse(route_src, "<route>").unwrap();
        let mut sources = HashMap::new();
        sources.insert(layout_name.to_string(), layout_src.to_string());
        super::lower_with_sources(&parsed, sources, HashMap::new()).unwrap()
    }

    const SHELL_LAYOUT: &str = r#"export default function PageLayout({ title, crumb, children }: any) {
  return (
    <BrustPage lang="en" className="dark" title={title}>
      <main><b>{crumb}</b><div className="aa-content">{children}</div></main>
    </BrustPage>
  );
}"#;

    #[test]
    fn native_layout_root_promotes_to_document() {
        let route = r#"export default function Page(d: any) { return <PageLayout native title="T" crumb="C"><p>hi</p></PageLayout>; }"#;
        let (c, _warnings) = lower_route_with_layout(route, "PageLayout", SHELL_LAYOUT);
        match &c.root {
            JsxNode::Document { title, lang, .. } => {
                match title {
                    Some(crate::ir::HeadValue::Literal(s)) => assert_eq!(s, "T"),
                    other => panic!("expected title Literal(\"T\"), got {other:?}"),
                }
                match lang {
                    Some(crate::ir::HeadValue::Literal(s)) => assert_eq!(s, "en"),
                    other => panic!("expected lang Literal(\"en\"), got {other:?}"),
                }
            }
            other => panic!("expected Document, got {other:?}"),
        }
    }

    #[test]
    fn native_layout_head_prop_via_member_path() {
        let route = r#"export default function Page({ pageTitle }: any) { return <PageLayout native title={pageTitle} crumb="C"><p>hi</p></PageLayout>; }"#;
        let (c, _warnings) = lower_route_with_layout(route, "PageLayout", SHELL_LAYOUT);
        match &c.root {
            JsxNode::Document { title, .. } => match title {
                Some(crate::ir::HeadValue::Path(crate::ir::Expr::Field(f))) => {
                    assert_eq!(f, "pageTitle")
                }
                other => panic!("expected title Path(Field(\"pageTitle\")), got {other:?}"),
            },
            other => panic!("expected Document, got {other:?}"),
        }

        let mut sources = HashMap::new();
        sources.insert("PageLayout".to_string(), SHELL_LAYOUT.to_string());
        let compiled = crate::compile_full(route, "<route>", sources, HashMap::new()).unwrap();
        // The jinja head emitter wraps the path in parens before the escape
        // filter (`{{ (pageTitle) | e }}`); assert on the escaped-interpolation
        // shape that actually reaches the template.
        assert!(
            compiled.template.contains("pageTitle") && compiled.template.contains("| e }}</title>"),
            "expected escaped pageTitle in <title>, got:\n{}",
            compiled.template
        );
    }

    #[test]
    fn native_layout_splices_children_into_shell() {
        let route = r#"export default function Page(d: any) { return <PageLayout native title="T" crumb="C"><p>hi</p></PageLayout>; }"#;
        let (c, _warnings) = lower_route_with_layout(route, "PageLayout", SHELL_LAYOUT);
        match &c.root {
            JsxNode::Document { .. } => {}
            other => panic!("expected Document, got {other:?}"),
        }
        let dbg = format!("{:?}", c.root);
        assert!(
            dbg.contains("\"p\""),
            "expected spliced <p> child, got:\n{dbg}"
        );
        assert!(
            !dbg.contains("ChildrenSlot"),
            "expected children slot replaced, got:\n{dbg}"
        );
    }

    #[test]
    fn nested_brustpage_literal_still_rejected() {
        let src =
            r#"export default function Page(d: any) { return <div><BrustPage title="x"/></div>; }"#;
        let parsed = parse(src, "<route>").unwrap();
        let err = super::lower(&parsed).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::BrustPageMustBeRoot),
            "expected BrustPageMustBeRoot, got {:?}",
            err.kind
        );
    }

    #[test]
    fn native_layout_below_root_does_not_promote() {
        let route = r#"export default function Page(d: any) { return <div><PageLayout native title="T" crumb="C"><p>hi</p></PageLayout></div>; }"#;
        let parsed = parse(route, "<route>").unwrap();
        let mut sources = HashMap::new();
        sources.insert("PageLayout".to_string(), SHELL_LAYOUT.to_string());
        // Contract: a native layout used BELOW the route root is reached with
        // doc_root=false, so its body-root `<BrustPage>` hits the nested
        // `BrustPageMustBeRoot` reject inside `lower_component_inline`. That hard
        // error is non-Circular/non-Untranslatable, so `try_native_inline`
        // SWALLOWS it into a soft fallback (warning + SSR component emission) —
        // the route compiles, but as a NON-Document SSR component (no nested
        // <html> shell), with a "not inlined" warning recorded.
        let (c, warnings) = super::lower_with_sources(&parsed, sources, HashMap::new())
            .expect("nested layout soft-falls-back to SSR, does not hard-error");
        let dbg = format!("{:?}", c.root);
        assert!(
            !dbg.contains("Document"),
            "must NOT promote a nested <BrustPage> to a document shell below root, got:\n{dbg}"
        );
        assert!(
            warnings
                .iter()
                .any(|w| w.contains("PageLayout") && w.contains("not inlined")),
            "expected a not-inlined fallback warning, got: {warnings:?}"
        );
    }

    #[test]
    fn native_layout_rooting_in_element_unchanged() {
        let route = r#"export default function Page(d: any) { return <Wrap native label="hi"><p>x</p></Wrap>; }"#;
        let wrap = r#"export default function Wrap({ label, children }: any) { return <section><h1>{label}</h1>{children}</section>; }"#;
        let (c, _warnings) = lower_route_with_layout(route, "Wrap", wrap);
        match &c.root {
            JsxNode::Element { .. } => {}
            other => panic!("expected Element, got {other:?}"),
        }
    }

    #[test]
    fn native_layout_active_conditional_element() {
        let route =
            r#"export default function Page(d: any) { return <Nav native active="list"/>; }"#;
        let nav = r#"export default function Nav({ active }: any) { return <nav>{active === 'list' ? <a className="is-active">L</a> : <a>L</a>}</nav>; }"#;
        let (c, _warnings) = lower_route_with_layout(route, "Nav", nav);
        match &c.root {
            JsxNode::Element { children, .. } => {
                assert!(
                    children.iter().any(|n| matches!(n, JsxNode::Cond { .. })),
                    "expected a Cond child, got {children:?}"
                );
            }
            other => panic!("expected Element, got {other:?}"),
        }
    }

    #[test]
    fn native_layout_allows_fragment_children() {
        // A native layout wrapping conditional content whose alternate is a
        // fragment (`{cond ? <p/> : <>…</>}`) must INLINE + splice. The fragment
        // guard is deferred to the SSR-emission paths; the native-inline success
        // path is exempt because the children become jinja, not factory output.
        // (This is exactly DetailPage's `{notFound ? … : <>…</>}` shape.)
        let route = r#"export default function Page({ notFound }: any) {
  return <PageLayout native title="T" crumb="C">{notFound ? <p>x</p> : <><h1>a</h1><h2>b</h2></>}</PageLayout>;
}"#;
        let (c, _warnings) = lower_route_with_layout(route, "PageLayout", SHELL_LAYOUT);
        assert!(
            matches!(c.root, JsxNode::Document { .. }),
            "expected Document (inline succeeded, no fragment error), got {:?}",
            c.root
        );
    }

    #[test]
    fn inline_substitutes_member_prop() {
        // function C({title}){return <h1>{title}</h1>}
        // subst: title → MemberAccess{root:"data", path:["x"]}
        let src = r#"export default function C({ title }: { title: string }) {
  return <h1>{title}</h1>;
}"#;
        let mut subst = HashMap::new();
        subst.insert(
            "title".to_string(),
            crate::ir::Expr::MemberAccess {
                root: "data".to_string(),
                path: vec!["x".to_string()],
            },
        );
        let nodes = inline_lower(src, subst, false).unwrap();
        assert_eq!(nodes.len(), 1);
        match &nodes[0] {
            JsxNode::Element { tag, children, .. } => {
                assert_eq!(tag, "h1");
                assert_eq!(children.len(), 1);
                match &children[0] {
                    JsxNode::Expr(crate::ir::Expr::MemberAccess { root, path }) => {
                        assert_eq!(root, "data");
                        assert_eq!(path, &vec!["x".to_string()]);
                    }
                    other => panic!("expected MemberAccess, got {other:?}"),
                }
            }
            other => panic!("expected h1 element, got {other:?}"),
        }
    }

    #[test]
    fn inline_children_slot() {
        // function C({children}){return <div>{children}</div>}  has_children=true
        let src = r#"export default function C({ children }: any) {
  return <div>{children}</div>;
}"#;
        let nodes = inline_lower(src, HashMap::new(), true).unwrap();
        assert_eq!(nodes.len(), 1);
        match &nodes[0] {
            JsxNode::Element { tag, children, .. } => {
                assert_eq!(tag, "div");
                assert_eq!(children.len(), 1);
                assert!(
                    matches!(children[0], JsxNode::ChildrenSlot),
                    "expected ChildrenSlot, got {:?}",
                    children[0]
                );
            }
            other => panic!("expected div element, got {other:?}"),
        }
    }

    #[test]
    fn inline_and_to_cond() {
        // function C({show}){return <div>{show && <span/>}</div>}
        let src = r#"export default function C({ show }: any) {
  return <div>{show && <span/>}</div>;
}"#;
        let mut subst = HashMap::new();
        subst.insert(
            "show".to_string(),
            crate::ir::Expr::Field("show".to_string()),
        );
        let nodes = inline_lower(src, subst, false).unwrap();
        assert_eq!(nodes.len(), 1);
        match &nodes[0] {
            JsxNode::Element { tag, children, .. } => {
                assert_eq!(tag, "div");
                assert_eq!(children.len(), 1);
                match &children[0] {
                    JsxNode::Cond {
                        alternate,
                        consequent,
                        ..
                    } => {
                        assert!(alternate.is_none(), "expected no alternate");
                        assert!(
                            matches!(consequent.as_ref(), JsxNode::Element { tag, .. } if tag == "span")
                        );
                    }
                    other => panic!("expected Cond, got {other:?}"),
                }
            }
            other => panic!("expected div, got {other:?}"),
        }
    }

    #[test]
    fn inline_ternary_to_cond() {
        // {ok ? <a/> : <b/>} → Cond{alternate:Some}
        let src = r#"export default function C({ ok }: any) {
  return <div>{ok ? <a/> : <b/>}</div>;
}"#;
        let mut subst = HashMap::new();
        subst.insert("ok".to_string(), crate::ir::Expr::Field("ok".to_string()));
        let nodes = inline_lower(src, subst, false).unwrap();
        let div_children = match &nodes[0] {
            JsxNode::Element { children, .. } => children,
            other => panic!("expected div, got {other:?}"),
        };
        match &div_children[0] {
            JsxNode::Cond {
                alternate,
                consequent,
                ..
            } => {
                assert!(alternate.is_some(), "expected alternate");
                assert!(matches!(consequent.as_ref(), JsxNode::Element { tag, .. } if tag == "a"));
                assert!(
                    matches!(alternate.as_ref().unwrap().as_ref(), JsxNode::Element { tag, .. } if tag == "b")
                );
            }
            other => panic!("expected Cond, got {other:?}"),
        }
    }

    #[test]
    fn inline_ifelse_return_to_cond() {
        // function C({ok}){ if(ok) return <a/>; return <b/>; }
        let src = r#"export default function C({ ok }: any) {
  if (ok) return <a/>;
  return <b/>;
}"#;
        let mut subst = HashMap::new();
        subst.insert("ok".to_string(), crate::ir::Expr::Field("ok".to_string()));
        let nodes = inline_lower(src, subst, false).unwrap();
        assert_eq!(nodes.len(), 1);
        match &nodes[0] {
            JsxNode::Cond {
                alternate,
                consequent,
                ..
            } => {
                assert!(alternate.is_some(), "expected alternate");
                assert!(matches!(consequent.as_ref(), JsxNode::Element { tag, .. } if tag == "a"));
                assert!(
                    matches!(alternate.as_ref().unwrap().as_ref(), JsxNode::Element { tag, .. } if tag == "b")
                );
            }
            other => panic!("expected Cond, got {other:?}"),
        }
    }

    #[test]
    fn inline_template_concat() {
        // {`Hi ${name}`} → Concat([StaticText("Hi "), <name expr>])
        let src = r#"export default function C({ name }: any) {
  return <span>{`Hi ${name}`}</span>;
}"#;
        let mut subst = HashMap::new();
        subst.insert(
            "name".to_string(),
            crate::ir::Expr::Field("name".to_string()),
        );
        let nodes = inline_lower(src, subst, false).unwrap();
        let children = match &nodes[0] {
            JsxNode::Element { children, .. } => children,
            other => panic!("expected span, got {other:?}"),
        };
        match &children[0] {
            JsxNode::Expr(crate::ir::Expr::Concat(parts)) => {
                assert!(parts.len() >= 2, "expected at least 2 parts, got {parts:?}");
                assert!(
                    matches!(&parts[0], crate::ir::Expr::StaticText(s) if s.contains("Hi")),
                    "expected StaticText with 'Hi', got {:?}",
                    parts[0]
                );
            }
            other => panic!("expected Concat, got {other:?}"),
        }
    }

    #[test]
    fn inline_method_upper() {
        // {title.toUpperCase()} → Filter{name:"upper"}
        let src = r#"export default function C({ title }: any) {
  return <span>{title.toUpperCase()}</span>;
}"#;
        let mut subst = HashMap::new();
        subst.insert(
            "title".to_string(),
            crate::ir::Expr::Field("title".to_string()),
        );
        let nodes = inline_lower(src, subst, false).unwrap();
        let children = match &nodes[0] {
            JsxNode::Element { children, .. } => children,
            other => panic!("expected span, got {other:?}"),
        };
        match &children[0] {
            JsxNode::Expr(crate::ir::Expr::Filter { name, args, .. }) => {
                assert_eq!(name, "upper");
                assert!(args.is_empty());
            }
            other => panic!("expected Filter{{upper}}, got {other:?}"),
        }
    }

    #[test]
    fn inline_arith() {
        // {a + b} → Arith{Add}
        let src = r#"export default function C({ a, b }: any) {
  return <span>{a + b}</span>;
}"#;
        let mut subst = HashMap::new();
        subst.insert("a".to_string(), crate::ir::Expr::Field("a".to_string()));
        subst.insert("b".to_string(), crate::ir::Expr::Field("b".to_string()));
        let nodes = inline_lower(src, subst, false).unwrap();
        let children = match &nodes[0] {
            JsxNode::Element { children, .. } => children,
            other => panic!("expected span, got {other:?}"),
        };
        match &children[0] {
            JsxNode::Expr(crate::ir::Expr::Arith { op, .. }) => {
                assert_eq!(*op, crate::ir::ArithOp::Add);
            }
            other => panic!("expected Arith{{Add}}, got {other:?}"),
        }
    }

    #[test]
    fn inline_length() {
        // {items.length} → Filter{name:"length"}
        let src = r#"export default function C({ items }: any) {
  return <span>{items.length}</span>;
}"#;
        let mut subst = HashMap::new();
        subst.insert(
            "items".to_string(),
            crate::ir::Expr::Field("items".to_string()),
        );
        let nodes = inline_lower(src, subst, false).unwrap();
        let children = match &nodes[0] {
            JsxNode::Element { children, .. } => children,
            other => panic!("expected span, got {other:?}"),
        };
        match &children[0] {
            JsxNode::Expr(crate::ir::Expr::Filter { name, args, .. }) => {
                assert_eq!(name, "length");
                assert!(args.is_empty());
            }
            other => panic!("expected Filter{{length}}, got {other:?}"),
        }
    }

    #[test]
    fn inline_unknown_method_untranslatable() {
        // {x.reduce(...)} → Err(InlineUntranslatable)
        let src = r#"export default function C({ x }: any) {
  return <span>{x.reduce((a, b) => a + b, 0)}</span>;
}"#;
        let mut subst = HashMap::new();
        subst.insert("x".to_string(), crate::ir::Expr::Field("x".to_string()));
        let err = inline_lower(src, subst, false).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::InlineUntranslatable(_)),
            "expected InlineUntranslatable, got {:?}",
            err.kind
        );
    }

    /// Lower a native route source to its root JsxNode (no inline ctx).
    fn lower_route_root(src: &str) -> Result<JsxNode, LowerError> {
        let parsed = parse(src, "<test>").unwrap();
        lower(&parsed).map(|c| c.root)
    }

    /// Helper: first child of the lowered route root `<div>`.
    fn route_first_child(src: &str) -> JsxNode {
        match lower_route_root(src).unwrap() {
            JsxNode::Element { children, .. } => children.into_iter().next().expect("a child"),
            other => panic!("expected element root, got {other:?}"),
        }
    }

    #[test]
    fn noninline_logical_now_lowers_to_cond() {
        // THE GATE (lifted): a bare {show && <span/>} on a native route now
        // SUCCEEDS, yielding a Cond instead of ComplexExpressionNotSupported.
        let src = r#"export default function X({ show }: any) {
  return <div>{show && <span/>}</div>;
}"#;
        match route_first_child(src) {
            JsxNode::Cond {
                test, alternate, ..
            } => {
                assert!(matches!(test, crate::ir::Expr::Field(_)));
                assert!(alternate.is_none());
            }
            other => panic!("expected Cond, got {other:?}"),
        }
    }

    #[test]
    fn inline_logical_still_lowers_to_cond() {
        // Regression guard: inline mode output for {cond && <JSX>} unchanged.
        let src = r#"export default function C({ show }: any) {
  return <div>{show && <span/>}</div>;
}"#;
        let nodes = inline_lower(src, HashMap::new(), false).unwrap();
        let children = match &nodes[0] {
            JsxNode::Element { children, .. } => children,
            other => panic!("expected element, got {other:?}"),
        };
        assert!(
            matches!(
                children[0],
                JsxNode::Cond {
                    alternate: None,
                    ..
                }
            ),
            "expected Cond{{alternate:None}}, got {:?}",
            children[0]
        );
    }

    #[test]
    fn noninline_cond_member_test() {
        // {flags.hasPrev && <a/>} → Cond{ test: MemberAccess, alternate: None }
        let src = r#"export default function X({ flags }: any) {
  return <div>{flags.hasPrev && <a/>}</div>;
}"#;
        match route_first_child(src) {
            JsxNode::Cond {
                test, alternate, ..
            } => {
                assert!(
                    matches!(test, crate::ir::Expr::MemberAccess { .. }),
                    "expected MemberAccess, got {test:?}"
                );
                assert!(alternate.is_none());
            }
            other => panic!("expected Cond, got {other:?}"),
        }
    }

    #[test]
    fn noninline_cond_compare_test() {
        // {d.n > 0 && <span/>} → test: Compare{ op: Gt }
        let src = r#"export default function X({ d }: any) {
  return <div>{d.n > 0 && <span/>}</div>;
}"#;
        match route_first_child(src) {
            JsxNode::Cond { test, .. } => match test {
                crate::ir::Expr::Compare { op, .. } => assert_eq!(op, crate::ir::CmpOp::Gt),
                other => panic!("expected Compare{{Gt}}, got {other:?}"),
            },
            other => panic!("expected Cond, got {other:?}"),
        }
    }

    #[test]
    fn noninline_ternary_not_test() {
        // {!d.empty ? <a/> : <b/>} → test: Not(..), alternate: Some(..)
        let src = r#"export default function X({ d }: any) {
  return <div>{!d.empty ? <a/> : <b/>}</div>;
}"#;
        match route_first_child(src) {
            JsxNode::Cond {
                test, alternate, ..
            } => {
                assert!(matches!(test, crate::ir::Expr::Not(_)), "got {test:?}");
                assert!(alternate.is_some());
            }
            other => panic!("expected Cond, got {other:?}"),
        }
    }

    #[test]
    fn noninline_cond_logical_and_test() {
        // {a.x && b.y && <i/>} → test: Logical{ And }
        let src = r#"export default function X({ a, b }: any) {
  return <div>{a.x && b.y && <i/>}</div>;
}"#;
        match route_first_child(src) {
            JsxNode::Cond { test, .. } => match test {
                // `a.x && b.y && <i/>` parses left-assoc as `(a.x && b.y) && <i/>`,
                // so the test is the LHS `a.x && b.y`: a Logical{And} whose operands
                // are member-paths (NOT recursively re-tested). Assert the operand
                // shapes too, so a future swap of `lower_cond_operand`→`lower_cond_test`
                // on the operands can't pass silently.
                crate::ir::Expr::Logical { op, lhs, rhs } => {
                    assert_eq!(op, crate::ir::LogOp::And);
                    assert!(
                        matches!(*lhs, crate::ir::Expr::MemberAccess { .. }),
                        "lhs: {lhs:?}"
                    );
                    assert!(
                        matches!(*rhs, crate::ir::Expr::MemberAccess { .. }),
                        "rhs: {rhs:?}"
                    );
                }
                other => panic!("expected Logical{{And}}, got {other:?}"),
            },
            other => panic!("expected Cond, got {other:?}"),
        }
    }

    #[test]
    fn noninline_cond_inside_map() {
        // items.map(it => it.active && <li/>) → Map{ body: Cond{ test: MapMember } }
        let src = r#"export default function X({ items }: any) {
  return <ul>{items.map((it) => it.active && <li/>)}</ul>;
}"#;
        match route_first_child(src) {
            JsxNode::Map { body, .. } => match *body {
                JsxNode::Cond { test, .. } => assert!(
                    matches!(test, crate::ir::Expr::MapMember { .. }),
                    "expected MapMember, got {test:?}"
                ),
                other => panic!("expected Cond body, got {other:?}"),
            },
            other => panic!("expected Map, got {other:?}"),
        }
    }

    #[test]
    fn noninline_ternary_null_branch_empty() {
        // {cond ? <A/> : null} → Cond with null branch lowered to Empty
        let src = r#"export default function X({ cond }: any) {
  return <div>{cond ? <a/> : null}</div>;
}"#;
        match route_first_child(src) {
            JsxNode::Cond { alternate, .. } => {
                let alt = alternate.expect("alternate present");
                assert!(
                    matches!(*alt, JsxNode::Empty),
                    "expected Empty, got {alt:?}"
                );
            }
            other => panic!("expected Cond, got {other:?}"),
        }
    }

    #[test]
    fn noninline_ternary_fragment_consequent() {
        // {cond ? <>x</> : <b/>} → Cond with a Fragment consequent
        let src = r#"export default function X({ cond }: any) {
  return <div>{cond ? <>x</> : <b/>}</div>;
}"#;
        match route_first_child(src) {
            JsxNode::Cond { consequent, .. } => assert!(
                matches!(*consequent, JsxNode::Fragment { .. }),
                "expected Fragment consequent, got {consequent:?}"
            ),
            other => panic!("expected Cond, got {other:?}"),
        }
    }

    #[test]
    fn noninline_cond_call_test_rejected() {
        // {foo() && <a/>} → ComplexExpressionNotSupported
        let src = r#"export default function X({ foo }: any) {
  return <div>{foo() && <a/>}</div>;
}"#;
        let err = lower_route_root(src).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::ComplexExpressionNotSupported),
            "got {:?}",
            err.kind
        );
    }

    #[test]
    fn noninline_cond_arithmetic_operand_rejected() {
        // {a + b > 0 && <a/>} → ComplexExpressionNotSupported (arithmetic operand)
        let src = r#"export default function X({ a, b }: any) {
  return <div>{a + b > 0 && <a/>}</div>;
}"#;
        let err = lower_route_root(src).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::ComplexExpressionNotSupported),
            "got {:?}",
            err.kind
        );
    }

    // ── T6 native inline tests ────────────────────────────────────────────────

    /// Helper: parse route source + sources map, call lower_with_sources.
    fn lower_with_src(
        route_src: &str,
        sources: HashMap<String, String>,
    ) -> Result<(crate::ir::Component, Vec<String>), LowerError> {
        let parsed = parse(route_src, "<test>").unwrap();
        super::lower_with_sources(&parsed, sources, HashMap::new())
    }

    /// Recursively check that no SsrComponent node exists in the tree.
    fn assert_no_ssr_component(node: &JsxNode) {
        match node {
            JsxNode::SsrComponent { component, .. } => {
                panic!("unexpected SsrComponent({component}) in tree");
            }
            JsxNode::Element { children, .. } => {
                for c in children {
                    assert_no_ssr_component(c);
                }
            }
            JsxNode::Cond {
                consequent,
                alternate,
                ..
            } => {
                assert_no_ssr_component(consequent);
                if let Some(alt) = alternate {
                    assert_no_ssr_component(alt);
                }
            }
            JsxNode::Map { body, .. } => assert_no_ssr_component(body),
            JsxNode::Document { body, .. } => {
                for c in body {
                    assert_no_ssr_component(c);
                }
            }
            _ => {}
        }
    }

    /// Recursively check that no ChildrenSlot remains in tree.
    fn assert_no_children_slot(node: &JsxNode) {
        match node {
            JsxNode::ChildrenSlot => panic!("unexpected ChildrenSlot in tree"),
            JsxNode::Element { children, .. } => {
                for c in children {
                    assert_no_children_slot(c);
                }
            }
            JsxNode::Cond {
                consequent,
                alternate,
                ..
            } => {
                assert_no_children_slot(consequent);
                if let Some(alt) = alternate {
                    assert_no_children_slot(alt);
                }
            }
            JsxNode::Map { body, .. } => assert_no_children_slot(body),
            JsxNode::Document { body, .. } => {
                for c in body {
                    assert_no_children_slot(c);
                }
            }
            _ => {}
        }
    }

    #[test]
    fn native_pure_inlines() {
        // Route: <div><Card native title={data.x}/></div>
        // Card: function Card({title}){return <h1>{title}</h1>}
        // Expected: div contains h1 with MemberAccess(data.x), no SsrComponent.
        let route = r#"export default function P({ data }) {
  return <div><Card native title={data.x}/></div>;
}"#;
        let card = r#"export default function Card({ title }) {
  return <h1>{title}</h1>;
}"#;
        let mut sources = HashMap::new();
        sources.insert("Card".to_string(), card.to_string());
        let (comp, warnings) = lower_with_src(route, sources).unwrap();
        assert!(
            warnings.is_empty(),
            "expected no warnings, got: {warnings:?}"
        );
        assert_no_ssr_component(&comp.root);
        // Check the h1 with MemberAccess is present.
        let h1 = match &comp.root {
            JsxNode::Element { children, .. } => match &children[0] {
                JsxNode::Element { tag, children, .. } => {
                    assert_eq!(tag, "h1");
                    children
                }
                other => panic!("expected h1, got {other:?}"),
            },
            other => panic!("expected div, got {other:?}"),
        };
        match &h1[0] {
            JsxNode::Expr(crate::ir::Expr::MemberAccess { root, path }) => {
                assert_eq!(root, "data");
                assert_eq!(path, &vec!["x".to_string()]);
            }
            other => panic!("expected MemberAccess(data.x), got {other:?}"),
        }
    }

    #[test]
    fn native_hook_falls_back() {
        // Card uses useState → must fall back to SsrComponent, warning contains "useState".
        let route = r#"export default function P({ data }) {
  return <div><Card native title={data.x}/></div>;
}"#;
        let card = r#"export default function Card({ title }) {
  const [v, setV] = useState(0);
  return <h1>{title}</h1>;
}"#;
        let mut sources = HashMap::new();
        sources.insert("Card".to_string(), card.to_string());
        let (comp, warnings) = lower_with_src(route, sources).unwrap();
        // Must have an SsrComponent for Card.
        let has_ssr = {
            fn find_ssr(node: &JsxNode) -> bool {
                match node {
                    JsxNode::SsrComponent { .. } => true,
                    JsxNode::Element { children, .. } => children.iter().any(find_ssr),
                    _ => false,
                }
            }
            find_ssr(&comp.root)
        };
        assert!(has_ssr, "expected SsrComponent fallback for hook");
        assert!(
            warnings
                .iter()
                .any(|w| w.contains("useState") || w.contains("hook")),
            "expected hook warning, got: {warnings:?}"
        );
    }

    #[test]
    fn native_unresolved_falls_back() {
        // sources map is empty → SsrComponent + "unresolved" warning.
        let route = r#"export default function P({ data }) {
  return <div><Card native title={data.x}/></div>;
}"#;
        let (comp, warnings) = lower_with_src(route, HashMap::new()).unwrap();
        let has_ssr = {
            fn find_ssr(node: &JsxNode) -> bool {
                match node {
                    JsxNode::SsrComponent { .. } => true,
                    JsxNode::Element { children, .. } => children.iter().any(find_ssr),
                    _ => false,
                }
            }
            find_ssr(&comp.root)
        };
        assert!(has_ssr, "expected SsrComponent fallback for unresolved");
        assert!(
            warnings.iter().any(|w| w.contains("unresolved")),
            "expected unresolved warning, got: {warnings:?}"
        );
    }

    #[test]
    fn native_children_splice() {
        // Route: <Box native><span/></Box>
        // Box: function Box({children}){return <section>{children}</section>}
        // Expected: section contains the span, no ChildrenSlot.
        let route = r#"export default function P() {
  return <Box native><span/></Box>;
}"#;
        let box_src = r#"export default function Box({ children }) {
  return <section>{children}</section>;
}"#;
        let mut sources = HashMap::new();
        sources.insert("Box".to_string(), box_src.to_string());
        let (comp, warnings) = lower_with_src(route, sources).unwrap();
        assert!(
            warnings.is_empty(),
            "expected no warnings, got: {warnings:?}"
        );
        assert_no_ssr_component(&comp.root);
        assert_no_children_slot(&comp.root);
        // section should contain the span.
        let section_children = match &comp.root {
            JsxNode::Element { tag, children, .. } => {
                assert_eq!(tag, "section");
                children
            }
            other => panic!("expected section, got {other:?}"),
        };
        assert_eq!(section_children.len(), 1);
        match &section_children[0] {
            JsxNode::Element { tag, .. } => assert_eq!(tag, "span"),
            other => panic!("expected span, got {other:?}"),
        }
    }

    #[test]
    fn native_nested_recurses() {
        // Outer native contains <Inner native/>; both pure; sources has both → fully inlined.
        let route = r#"export default function P({ data }) {
  return <Outer native value={data.v}/>;
}"#;
        let outer_src = r#"export default function Outer({ value }) {
  return <div><Inner native val={value}/></div>;
}"#;
        let inner_src = r#"export default function Inner({ val }) {
  return <span>{val}</span>;
}"#;
        let mut sources = HashMap::new();
        sources.insert("Outer".to_string(), outer_src.to_string());
        sources.insert("Inner".to_string(), inner_src.to_string());
        let (comp, warnings) = lower_with_src(route, sources).unwrap();
        assert!(
            warnings.is_empty(),
            "expected no warnings, got: {warnings:?}"
        );
        assert_no_ssr_component(&comp.root);
    }

    #[test]
    fn native_circular_errors() {
        // A native → B native → A native → cycle error.
        let route = r#"export default function P() {
  return <A native/>;
}"#;
        let a_src = r#"export default function A() {
  return <B native/>;
}"#;
        let b_src = r#"export default function B() {
  return <A native/>;
}"#;
        let mut sources = HashMap::new();
        sources.insert("A".to_string(), a_src.to_string());
        sources.insert("B".to_string(), b_src.to_string());
        let err = lower_with_src(route, sources).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::CircularInline(_)),
            "expected CircularInline, got {:?}",
            err.kind
        );
    }

    #[test]
    fn native_isr_inlined_warns() {
        // <Card native isr={{key:'k'}}/> pure → inlines, warnings contains "isr ignored".
        let route = r#"export default function P({ data }) {
  return <Card native isr={{ key: data.k }}/>;
}"#;
        let card = r#"export default function Card() {
  return <h1>hello</h1>;
}"#;
        let mut sources = HashMap::new();
        sources.insert("Card".to_string(), card.to_string());
        let (comp, warnings) = lower_with_src(route, sources).unwrap();
        assert_no_ssr_component(&comp.root);
        assert!(
            warnings.iter().any(|w| w.contains("isr ignored")),
            "expected 'isr ignored' warning, got: {warnings:?}"
        );
    }

    // ── FIX 1 test: ChildrenSlot emitted even when call-site has no children ──

    #[test]
    fn native_children_slot_no_callsite_children() {
        // Route: <Box native/> — NO children at the call site.
        // Box: function Box({children}){return <section>{children}</section>}
        // Expected: the section is present and contains neither ChildrenSlot
        // nor Expr::Field("children"); children spliced to nothing.
        let route = r#"export default function P() {
  return <Box native/>;
}"#;
        let box_src = r#"export default function Box({ children }: any) {
  return <section>{children}</section>;
}"#;
        let mut sources = HashMap::new();
        sources.insert("Box".to_string(), box_src.to_string());
        let (comp, warnings) = lower_with_src(route, sources).unwrap();
        assert!(
            warnings.is_empty(),
            "expected no warnings, got: {warnings:?}"
        );
        // Root must be the inlined <section> — no SsrComponent.
        assert_no_ssr_component(&comp.root);
        // No ChildrenSlot left after splice.
        assert_no_children_slot(&comp.root);
        // No Expr::Field("children") anywhere (the bogus fallback).
        fn assert_no_field_children(node: &JsxNode) {
            match node {
                JsxNode::Expr(crate::ir::Expr::Field(name)) => {
                    assert_ne!(name, "children", "found bogus Expr::Field(\"children\")");
                }
                JsxNode::Element { children, .. } => {
                    for c in children {
                        assert_no_field_children(c);
                    }
                }
                JsxNode::Cond {
                    consequent,
                    alternate,
                    ..
                } => {
                    assert_no_field_children(consequent);
                    if let Some(alt) = alternate {
                        assert_no_field_children(alt);
                    }
                }
                JsxNode::Map { body, .. } => assert_no_field_children(body),
                JsxNode::Document { body, .. } => {
                    for c in body {
                        assert_no_field_children(c);
                    }
                }
                _ => {}
            }
        }
        assert_no_field_children(&comp.root);
        // The section tag must be the root.
        match &comp.root {
            JsxNode::Element { tag, children, .. } => {
                assert_eq!(tag, "section");
                // Zero children: the slot was spliced away.
                assert!(
                    children.is_empty(),
                    "expected empty children, got {children:?}"
                );
            }
            other => panic!("expected section element, got {other:?}"),
        }
    }

    // ── FIX 2 test: lower vs lower_with_sources identical for non-native routes ──

    #[test]
    fn noninline_route_identical_via_with_sources() {
        // A representative non-native route: element + member expr + .map.
        let src = r#"export default function Page({ data }: any) {
  return (
    <ul>
      {data.items.map((item: any) => <li>{item.name}</li>)}
    </ul>
  );
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let comp_plain = super::lower(&parsed).unwrap();
        let (comp_with_src, warnings) =
            super::lower_with_sources(&parsed, HashMap::new(), HashMap::new()).unwrap();
        assert!(
            warnings.is_empty(),
            "expected no warnings from lower_with_sources, got: {warnings:?}"
        );
        // Use Debug equality: proves the inline gate doesn't alter non-native lowering.
        assert_eq!(
            format!("{:?}", comp_plain.root),
            format!("{:?}", comp_with_src.root),
            "lower and lower_with_sources produced different IR for a non-native route"
        );
        assert_eq!(
            format!("{:?}", comp_plain.props),
            format!("{:?}", comp_with_src.props),
        );
    }

    // ── Island props_path remapping through inline subst (bug fix) ───────────

    /// When a native component containing `<Island props={c} …/>` is inlined
    /// with `c={count}` at the call site, the Island's `props_path` must be
    /// remapped to the call-site name (`"count"`), NOT kept as the component's
    /// local param name (`"c"`).
    #[test]
    fn native_island_props_path_remapped() {
        // Route: <WrapCounter native c={count} />
        // WrapCounter: function WrapCounter({c}){ return <div><Island component={Counter} props={c} hydrate="load"/></div> }
        let route = r#"export default function Page({ count }: any) {
  return <WrapCounter native c={count} />;
}"#;
        let wrap_counter = r#"export default function WrapCounter({ c }: any) {
  return (
    <div>
      <Island component={Counter} props={c} hydrate="load" />
    </div>
  );
}"#;
        let mut sources = HashMap::new();
        sources.insert("WrapCounter".to_string(), wrap_counter.to_string());
        let (comp, warnings) = lower_with_src(route, sources).unwrap();
        assert!(
            warnings.is_empty(),
            "expected no warnings, got: {warnings:?}"
        );

        // Find the Island node recursively.
        fn find_island(node: &JsxNode) -> Option<&JsxNode> {
            match node {
                JsxNode::Island { .. } => Some(node),
                JsxNode::Element { children, .. } => children.iter().find_map(find_island),
                JsxNode::Cond {
                    consequent,
                    alternate,
                    ..
                } => find_island(consequent)
                    .or_else(|| alternate.as_ref().and_then(|a| find_island(a))),
                JsxNode::Map { body, .. } => find_island(body),
                JsxNode::Document { body, .. } => body.iter().find_map(find_island),
                _ => None,
            }
        }

        let island = find_island(&comp.root).expect("expected an Island node in the inlined tree");

        match island {
            JsxNode::Island {
                component,
                props_path,
                ..
            } => {
                assert_eq!(component, "Counter");
                assert_eq!(
                    props_path, "count",
                    "props_path must be remapped from 'c' to 'count' (the call-site field name)"
                );
            }
            other => panic!("expected Island, got {other:?}"),
        }
    }

    /// Non-inline Island props_path is unchanged (regression guard).
    #[test]
    fn non_inline_island_props_path_unchanged() {
        let src = r#"export default function Page({ counter }: any) {
  return <Island component={Counter} props={counter} hydrate="load" />;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let comp = super::lower(&parsed).unwrap();
        match &comp.root {
            JsxNode::Island { props_path, .. } => {
                assert_eq!(props_path, "counter");
            }
            other => panic!("expected Island, got {other:?}"),
        }
    }

    // ── style={{…}} object lowering (S1) ──────────────────────────────────

    /// Lower `src` and return the `AttrValue` of the FIRST attribute on the
    /// root element. Panics on compile error.
    fn first_style_attr(src: &str) -> AttrValue {
        let parsed = parse(src, "<test>").unwrap();
        let comp = super::lower(&parsed).unwrap();
        match comp.root {
            JsxNode::Element { mut attrs, .. } => {
                assert_eq!(attrs.len(), 1, "expected exactly one attr");
                let a = attrs.remove(0);
                assert_eq!(a.name, "style");
                a.value
            }
            other => panic!("expected root element, got {other:?}"),
        }
    }

    /// Lower `src` and return the root-element `ErrorKind`.
    fn style_err(src: &str) -> ErrorKind {
        let parsed = parse(src, "<test>").unwrap();
        super::lower(&parsed).unwrap_err().kind
    }

    #[test]
    fn style_object_number_gets_px() {
        let v = first_style_attr(
            r#"export default function X() { return <div style={{ width: 62 }}/>; }"#,
        );
        match v {
            AttrValue::Static(s) => assert_eq!(s, "width:62px"),
            other => panic!("expected Static, got {other:?}"),
        }
    }

    #[test]
    fn style_object_unitless_no_px() {
        let v = first_style_attr(
            r#"export default function X() { return <div style={{ opacity: 1 }}/>; }"#,
        );
        match v {
            AttrValue::Static(s) => assert_eq!(s, "opacity:1"),
            other => panic!("expected Static, got {other:?}"),
        }
    }

    #[test]
    fn style_object_camel_kebab_unitless() {
        let v = first_style_attr(
            r#"export default function X() { return <div style={{ zIndex: 5 }}/>; }"#,
        );
        match v {
            AttrValue::Static(s) => assert_eq!(s, "z-index:5"),
            other => panic!("expected Static, got {other:?}"),
        }
    }

    #[test]
    fn style_object_negative_number_gets_px() {
        // swc parses `-8` as Unary(Minus, Num(8)); negative CSS values must work.
        let v = first_style_attr(
            r#"export default function X() { return <div style={{ marginTop: -8 }}/>; }"#,
        );
        match v {
            AttrValue::Static(s) => assert_eq!(s, "margin-top:-8px"),
            other => panic!("expected Static, got {other:?}"),
        }
    }

    #[test]
    fn css_kebab_branches() {
        // Vendor prefixes + custom properties + already-kebab passthrough — these
        // css_kebab paths are not exercised by the style-object fixtures.
        assert_eq!(super::css_kebab("backgroundColor"), "background-color");
        assert_eq!(super::css_kebab("WebkitTransform"), "-webkit-transform");
        assert_eq!(super::css_kebab("MozUserSelect"), "-moz-user-select");
        assert_eq!(super::css_kebab("msFlexAlign"), "-ms-flex-align");
        assert_eq!(super::css_kebab("--my-var"), "--my-var");
        assert_eq!(super::css_kebab("z-index"), "z-index");
    }

    #[test]
    fn style_object_multi_static_order_preserved() {
        let v = first_style_attr(
            r#"export default function X() { return <div style={{ backgroundColor: "red", width: 62 }}/>; }"#,
        );
        match v {
            AttrValue::Static(s) => assert_eq!(s, "background-color:red;width:62px"),
            other => panic!("expected Static, got {other:?}"),
        }
    }

    #[test]
    fn style_object_dynamic_member_path() {
        let v = first_style_attr(
            r#"export default function X({ c }: any) { return <div style={{ color: c.fg }}/>; }"#,
        );
        match v {
            AttrValue::Expr(Expr::Concat(parts)) => {
                assert_eq!(parts.len(), 2);
                match &parts[0] {
                    Expr::StaticText(s) => assert_eq!(s, "color:"),
                    other => panic!("expected StaticText, got {other:?}"),
                }
                match &parts[1] {
                    Expr::MemberAccess { root, path } => {
                        assert_eq!(root, "c");
                        assert_eq!(path, &vec!["fg".to_string()]);
                    }
                    other => panic!("expected MemberAccess, got {other:?}"),
                }
            }
            other => panic!("expected Expr(Concat), got {other:?}"),
        }
    }

    #[test]
    fn style_object_mixed_dynamic_and_literal() {
        let v = first_style_attr(
            r#"export default function X({ st }: any) { return <div style={{ width: st.w, color: "red" }}/>; }"#,
        );
        match v {
            AttrValue::Expr(Expr::Concat(parts)) => {
                // ["width:", st.w, ";color:red"]
                assert_eq!(parts.len(), 3, "got {parts:?}");
                match &parts[0] {
                    Expr::StaticText(s) => assert_eq!(s, "width:"),
                    other => panic!("expected StaticText, got {other:?}"),
                }
                match &parts[1] {
                    Expr::MemberAccess { root, path } => {
                        assert_eq!(root, "st");
                        assert_eq!(path, &vec!["w".to_string()]);
                    }
                    other => panic!("expected MemberAccess, got {other:?}"),
                }
                match &parts[2] {
                    Expr::StaticText(s) => assert_eq!(s, ";color:red"),
                    other => panic!("expected StaticText, got {other:?}"),
                }
            }
            other => panic!("expected Expr(Concat), got {other:?}"),
        }
    }

    #[test]
    fn style_object_rejects_spread() {
        let src = r#"export default function X({ x }: any) { return <div style={{ ...x }}/>; }"#;
        assert!(
            matches!(style_err(src), ErrorKind::StyleObjectNotSupported),
            "got {:?}",
            style_err(src)
        );
    }

    #[test]
    fn style_object_rejects_computed_key() {
        let src = r#"export default function X({ k }: any) { return <div style={{ [k]: 1 }}/>; }"#;
        assert!(
            matches!(style_err(src), ErrorKind::StyleObjectNotSupported),
            "got {:?}",
            style_err(src)
        );
    }

    #[test]
    fn style_object_rejects_nested_object_value() {
        let src = r#"export default function X() { return <div style={{ a: { b: 1 } }}/>; }"#;
        assert!(
            matches!(style_err(src), ErrorKind::StyleObjectValueNotSupported),
            "got {:?}",
            style_err(src)
        );
    }

    #[test]
    fn style_object_rejects_call_value() {
        let src =
            r#"export default function X({ fn }: any) { return <div style={{ w: fn() }}/>; }"#;
        assert!(
            matches!(style_err(src), ErrorKind::StyleObjectValueNotSupported),
            "got {:?}",
            style_err(src)
        );
    }

    #[test]
    fn style_object_literal_with_quote_lowers_soundly() {
        // A literal value containing a quote; the dynamic case forces a Concat
        // whose StaticText is backslash-escaped by the emitter.
        let v = first_style_attr(
            r#"export default function X({ c }: any) { return <div style={{ content: "\"\"", color: c.fg }}/>; }"#,
        );
        match v {
            AttrValue::Expr(Expr::Concat(parts)) => {
                // ["content:\"\";color:", c.fg]
                match &parts[0] {
                    Expr::StaticText(s) => assert_eq!(s, "content:\"\";color:"),
                    other => panic!("expected StaticText, got {other:?}"),
                }
                match parts.last().unwrap() {
                    Expr::MemberAccess { root, path } => {
                        assert_eq!(root, "c");
                        assert_eq!(path, &vec!["fg".to_string()]);
                    }
                    other => panic!("expected MemberAccess, got {other:?}"),
                }
            }
            other => panic!("expected Expr(Concat), got {other:?}"),
        }
    }
}
