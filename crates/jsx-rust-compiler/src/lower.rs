use std::cell::RefCell;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::rc::Rc;

use swc_core::common::{Span, Spanned};
use swc_core::ecma::ast::{
    ArrayLit, ArrowExpr, AssignPatProp, BinaryOp, BindingIdent, BlockStmt, BlockStmtOrExpr,
    CallExpr, Callee, DefaultDecl, ExportDefaultDecl, Expr as SwcExpr, ExprOrSpread, FnExpr,
    Function, JSXAttrName, JSXAttrOrSpread, JSXAttrValue, JSXElement, JSXElementChild,
    JSXElementName, JSXExpr, Lit, MemberExpr, MemberProp, Module, ModuleDecl, ModuleItem,
    ObjectPatProp, ParenExpr, Pat, Prop, PropName, PropOrSpread, ReturnStmt, Stmt, UnaryOp,
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
    };

    let return_expr = single_return_expr(body)?;
    let jsx = strip_paren(return_expr);
    // `SwcExpr::JSXElement` wraps `Box<JSXElement>` in swc_ecma_ast 25; the `&Box<JSXElement>`
    // binding here coerces to `&JSXElement` at the call site below.
    let element = match jsx {
        SwcExpr::JSXElement(el) => el,
        // Fragment-as-root must surface `FragmentNotSupported` (matches the rest of the
        // tree's fragment-child rejection in `lower_child`).
        SwcExpr::JSXFragment(f) => {
            return Err(LowerError::at(f.span, ErrorKind::FragmentNotSupported));
        }
        _ => {
            return Err(LowerError::at(
                jsx.span(),
                ErrorKind::BodyMustBeSingleReturn,
            ));
        }
    };
    // `<BrustPage>` is the built-in document shell — recognized ONLY at the
    // route root, here, before `lower_element`. `lower_element` itself rejects a
    // nested `<BrustPage>` with `BrustPageMustBeRoot`, so the shell can never be
    // emitted inside the body. Top-level JSX is not under any `.map(...)` —
    // `in_map` starts false and is only forced true when `lower_call_as_map`
    // recurses into a Map body.
    let root = if let JSXElementName::Ident(ident) = &element.opening.name
        && ident.sym.as_ref() == "BrustPage"
    {
        lower_brust_page(element, &scope)?
    } else {
        lower_element(element, &scope, false)?
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

    let scope = Scope {
        destructured: param_shape.destructured.clone(),
        named_param: param_shape.named.clone(),
        map_bindings: Vec::new(),
        inline: None,
        inline_env: Some(env.clone()),
    };

    let return_expr = single_return_expr(body)?;
    let jsx = strip_paren(return_expr);
    let element = match jsx {
        SwcExpr::JSXElement(el) => el,
        SwcExpr::JSXFragment(f) => {
            return Err(LowerError::at(f.span, ErrorKind::FragmentNotSupported));
        }
        _ => {
            return Err(LowerError::at(
                jsx.span(),
                ErrorKind::BodyMustBeSingleReturn,
            ));
        }
    };
    let root = if let JSXElementName::Ident(ident) = &element.opening.name
        && ident.sym.as_ref() == "BrustPage"
    {
        lower_brust_page(element, &scope)?
    } else {
        lower_element(element, &scope, false)?
    };

    let mut props = PropsShape {
        bindings: param_shape.destructured.clone(),
        types: BTreeMap::new(),
    };
    infer_props_types(&root, &mut props)?;

    let warnings = env.warnings.borrow().clone();
    Ok((Component { name, props, root }, warnings))
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
    };

    // Try single-return first.
    if let Ok(return_expr) = single_return_expr(body) {
        let jsx = strip_paren(return_expr);
        let element = match jsx {
            SwcExpr::JSXElement(el) => el,
            SwcExpr::JSXFragment(f) => {
                return Err(LowerError::at(f.span, ErrorKind::FragmentNotSupported));
            }
            _ => {
                return Err(LowerError::at(
                    jsx.span(),
                    ErrorKind::BodyMustBeSingleReturn,
                ));
            }
        };
        let node = lower_element(element, &scope, false)?;
        return Ok(vec![node]);
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
            ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(_)) => {
                return Err(LowerError::at(
                    span_of_item(item),
                    ErrorKind::UnexpectedStatement,
                ));
            }
            _ => {
                return Err(LowerError::at(
                    span_of_item(item),
                    ErrorKind::UnexpectedStatement,
                ));
            }
        }
    }
    found.ok_or_else(|| LowerError::at(Span::default(), ErrorKind::UnexpectedStatement))
}

fn span_of_item(item: &ModuleItem) -> Span {
    // `ModuleDecl` / `Stmt` are `#[ast_node]` enums and implement `Spanned`; both expose
    // their span via the trait method rather than a field.
    match item {
        ModuleItem::ModuleDecl(decl) => decl.span(),
        ModuleItem::Stmt(stmt) => stmt.span(),
    }
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
/// Accepted shapes (per spec §4.4):
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

    // Third path: any other capitalised tag → SSR component.
    if let JSXElementName::Ident(ident) = &el.opening.name {
        let s = ident.sym.as_ref();
        if s.starts_with(|c: char| c.is_ascii_uppercase()) {
            return lower_ssr_component(el, s, scope, in_map);
        }
    }

    let tag = lower_element_name(&el.opening.name)?;
    // T6: attr precedence (key drop, ref/on*/uppercase rejection, rename table),
    // void-element children check, whitespace-only JSXText filtering.
    let mut attrs = Vec::new();
    for a in &el.opening.attrs {
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

    // T6: void element with non-empty (post-filter) children → error.
    if is_void_element(&tag) && !children.is_empty() {
        return Err(LowerError::at(
            el.opening.span,
            ErrorKind::VoidElementHasChildren(tag),
        ));
    }

    Ok(JsxNode::Element {
        tag,
        attrs,
        children,
    })
}

/// Lower the built-in `<BrustPage …>…</BrustPage>` document shell into
/// `JsxNode::Document`.
///
/// Head content is supplied entirely through PROPS (not a `<head>` child) so the
/// framework keeps full ownership of `<head>` and can inject more tags later
/// without colliding with user markup. All props are OPTIONAL compile-time
/// string literals:
/// - `lang="…"`         → `<html lang>` (default `"en"` emitted if omitted)
/// - `className="…"`     → `<html class>`
/// - `bodyClassName="…"` → `<body class>`
/// - `title="…"`         → `<title>…</title>`
/// - `description="…"`   → `<meta name="description" content="…">`
///
/// A non-literal value (`title={x}`) → `BrustPageAttrMustBeStringLiteral`.
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
    let mut lang: Option<String> = None;
    let mut html_class: Option<String> = None;
    let mut body_class: Option<String> = None;
    let mut title: Option<String> = None;
    let mut description: Option<String> = None;

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
        // Value must be a plain string literal — the shell is rendered in Rust,
        // so its chrome can't depend on runtime props.
        match &jsx_attr.value {
            Some(JSXAttrValue::Str(s)) => {
                *slot = Some(s.value.to_string_lossy().into_owned());
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
        lang = Some("en".to_string());
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
        body,
    })
}

fn lower_ssr_component(
    el: &JSXElement,
    component_name: &str,
    scope: &Scope,
    in_map: bool,
) -> Result<JsxNode, LowerError> {
    if in_map {
        return Err(LowerError::at(
            el.opening.span,
            ErrorKind::SsrComponentInMapNotSupported(component_name.to_owned()),
        ));
    }
    let component = component_name.to_owned();

    let mut props: Vec<SsrProp> = Vec::new();
    let mut key_path: Option<String> = None;
    let mut key_literal: Option<String> = None;
    let mut tags_path: Option<String> = None;
    let mut tags_literal: Option<Vec<String>> = None;
    let mut revalidate: Option<u32> = None;
    // T6: detect bare `native` attribute before the attr loop.
    let has_native = el.opening.attrs.iter().any(|a| {
        if let JSXAttrOrSpread::JSXAttr(jsx_attr) = a
            && let JSXAttrName::Ident(id) = &jsx_attr.name
        {
            return id.sym.as_ref() == "native";
        }
        false
    });

    // T6: collect call-site children for possible splicing.
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
            subst,
            has_spread,
            subst_err,
            &call_site_children,
            has_isr,
            el.opening.span,
        )?;

        if let Some(node) = inline_result {
            return Ok(node);
        }

        // Fall through to SSR component emission, using isr fields if present.
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

    // Standard (non-native) SSR component path.
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
    subst: HashMap<String, crate::ir::Expr>,
    has_spread: bool,
    subst_err: bool,
    call_site_children: &[JsxNode],
    has_isr: bool,
    span: Span,
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
    let nodes = match lower_component_inline(&parsed_comp, subst, has_children, Some(env.clone())) {
        Ok(n) => n,
        Err(e) => {
            // CircularInline is a hard error — propagate it immediately.
            if matches!(e.kind, ErrorKind::CircularInline(_)) {
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
        // Leaf nodes — nothing to splice.
        JsxNode::Empty
        | JsxNode::Text(_)
        | JsxNode::Expr(_)
        | JsxNode::Island { .. }
        | JsxNode::SsrComponent { .. }
        | JsxNode::ChildrenSlot => {}
    }
}

/// HTML void elements per spec §4 / WHATWG. T6 rejects children on these.
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
    let props_path = props_path
        .ok_or_else(|| LowerError::at(el.opening.span, ErrorKind::IslandPropsPathUnsupported))?;
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
        JSXElementChild::JSXFragment(f) => {
            Err(LowerError::at(f.span, ErrorKind::FragmentNotSupported))
        }
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

                // GATE: inline mode — handle special inline child patterns.
                if scope.inline.is_some() {
                    // `{children}` → ChildrenSlot unconditionally when "children"
                    // is in the component's destructured params. The splice step
                    // removes the slot cleanly when zero call-site children were
                    // passed, so we must emit the slot regardless of has_children.
                    if let SwcExpr::Ident(id) = e.as_ref()
                        && id.sym.as_ref() == "children"
                        && scope.destructured.contains(&"children".to_string())
                    {
                        return Ok(Some(JsxNode::ChildrenSlot));
                    }

                    // `{cond && <JSX>}` → Cond{alternate: None}.
                    if let SwcExpr::Bin(bin) = e.as_ref()
                        && bin.op == BinaryOp::LogicalAnd
                        && let SwcExpr::JSXElement(rhs_el) = strip_paren(bin.right.as_ref())
                    {
                        let test = lower_expr(&bin.left, scope)?;
                        let consequent = lower_element(rhs_el, scope, in_map)?;
                        return Ok(Some(JsxNode::Cond {
                            test,
                            consequent: Box::new(consequent),
                            alternate: None,
                        }));
                    }

                    // `{cond ? <A> : <B>}` → Cond{alternate: Some}.
                    if let SwcExpr::Cond(cond_expr) = e.as_ref() {
                        let test = lower_expr(&cond_expr.test, scope)?;
                        let cons_jsx = strip_paren(cond_expr.cons.as_ref());
                        let alt_jsx = strip_paren(cond_expr.alt.as_ref());
                        if let (SwcExpr::JSXElement(el_a), SwcExpr::JSXElement(el_b)) =
                            (cons_jsx, alt_jsx)
                        {
                            let node_a = lower_element(el_a, scope, in_map)?;
                            let node_b = lower_element(el_b, scope, in_map)?;
                            return Ok(Some(JsxNode::Cond {
                                test,
                                consequent: Box::new(node_a),
                                alternate: Some(Box::new(node_b)),
                            }));
                        }
                    }
                }

                Ok(Some(JsxNode::Expr(lower_expr(e, scope)?)))
            }
        },
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

    // Body: accept either `(item) => <JSX>` (Expr body) or
    // `(item) => { return <JSX>; }` (Block body with single return).
    let jsx_body = arrow_jsx_body(arrow)?;

    // Clone-and-extend the scope with the new iter binding. Keeps the rest of
    // the lowering on `&Scope`; no `&mut` plumbing required.
    let mut inner_scope = scope.clone();
    inner_scope.map_bindings.push(binding.clone());
    // Force `in_map = true` for the Map body: any `<Island>` inside the
    // iteration is rejected (id collision + non-per-iteration props path in v1).
    let body = lower_element(jsx_body, &inner_scope, true)?;

    Ok(JsxNode::Map {
        source,
        binding,
        body: Box::new(body),
    })
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

/// Extract a `&JSXElement` from an arrow body, accepting both forms.
///
/// `(item) => <JSX>` lowers as `BlockStmtOrExpr::Expr(JSXElement)`.
/// `(item) => (<JSX>)` lowers as `BlockStmtOrExpr::Expr(Paren(JSXElement))` —
/// strip Paren wrappers since they're trivial.
/// `(item) => { return <JSX>; }` lowers as `BlockStmtOrExpr::BlockStmt(...)`.
fn arrow_jsx_body(arrow: &ArrowExpr) -> Result<&JSXElement, LowerError> {
    match arrow.body.as_ref() {
        BlockStmtOrExpr::Expr(expr) => match strip_paren(expr.as_ref()) {
            SwcExpr::JSXElement(el) => Ok(el),
            other => Err(LowerError::at(
                other.span(),
                ErrorKind::MapShapeNotSupported,
            )),
        },
        BlockStmtOrExpr::BlockStmt(block) => {
            if block.stmts.len() != 1 {
                return Err(LowerError::at(block.span, ErrorKind::MapShapeNotSupported));
            }
            match &block.stmts[0] {
                Stmt::Return(ReturnStmt {
                    arg: Some(expr), ..
                }) => match strip_paren(expr.as_ref()) {
                    SwcExpr::JSXElement(el) => Ok(el),
                    other => Err(LowerError::at(
                        other.span(),
                        ErrorKind::MapShapeNotSupported,
                    )),
                },
                other => Err(LowerError::at(
                    other.span(),
                    ErrorKind::MapShapeNotSupported,
                )),
            }
        }
    }
}

/// React/JSX text normalization (spec §4.6).
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
        // Walk the body for prop references; the shell/head props are
        // compile-time literals and contribute no prop types.
        JsxNode::Document { body, .. } => {
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
    fn rejects_fragment() {
        let src = "export default function X() { return <><a/></>; }";
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::FragmentNotSupported));
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
        let c = compile_full(src, "<test>", HashMap::new()).unwrap();
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
        let err = compile_full(src, "<test>", HashMap::new()).unwrap_err();
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
        let err = compile_full(src, "<test>", HashMap::new()).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::SsrComponentInMapNotSupported(_)),
            "expected SsrComponentInMapNotSupported, got {:?}",
            err.kind
        );
    }

    #[test]
    fn lower_ssr_component_with_children_island_not_in_manifest() {
        let src = r#"export default function Page({ greeting, data }) {
  return <Layout title={greeting}><h1>{greeting}</h1><Island component={Counter} props={data.counter} hydrate="load" /></Layout>;
}"#;
        let c = compile_full(src, "<test>", HashMap::new()).unwrap();
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
        let err = compile_full(src, "<test>", HashMap::new()).unwrap_err();
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
        let err = compile_full(src, "<test>", HashMap::new()).unwrap_err();
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
        let err = compile_full(src, "<test>", HashMap::new()).unwrap_err();
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
        let err = compile_full(src, "<test>", HashMap::new()).unwrap_err();
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
        super::lower_component_inline(&parsed, subst, has_children, None)
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

    #[test]
    fn noninline_logical_still_errors() {
        // THE GATE: normal route (no inline ctx) with {show && <span/>} → Err(ComplexExpressionNotSupported).
        let src = r#"export default function X({ show }: any) {
  return <div>{show && <span/>}</div>;
}"#;
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(
            matches!(err.kind, ErrorKind::ComplexExpressionNotSupported),
            "expected ComplexExpressionNotSupported (gate check), got {:?}",
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
        super::lower_with_sources(&parsed, sources)
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
        let (comp_with_src, warnings) = super::lower_with_sources(&parsed, HashMap::new()).unwrap();
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
}
