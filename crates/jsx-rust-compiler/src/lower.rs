use std::collections::BTreeMap;

use swc_core::common::{Span, Spanned};
use swc_core::ecma::ast::{
    ArrowExpr, AssignPatProp, BindingIdent, BlockStmt, BlockStmtOrExpr, CallExpr, Callee,
    DefaultDecl, ExportDefaultDecl, Expr as SwcExpr, FnExpr, Function, JSXAttrName,
    JSXAttrOrSpread, JSXAttrValue, JSXElement, JSXElementChild, JSXElementName, JSXExpr, Lit,
    MemberExpr, MemberProp, Module, ModuleDecl, ModuleItem, ObjectPatProp, ParenExpr, Pat,
    ReturnStmt, Stmt,
};

use crate::ErrorKind;
use crate::ir::*;
use crate::parser::ParsedSource;

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
#[derive(Debug, Default, Clone)]
struct Scope {
    destructured: Vec<String>,
    named_param: Option<String>,
    map_bindings: Vec<String>,
}

/// Lowered param shape: which names are in scope inside JSX.
#[derive(Debug, Default)]
struct ParamShape {
    /// Destructured top-level bindings, if any.
    destructured: Vec<String>,
    /// Single named binding (`function X(props)`), if any.
    named: Option<String>,
}

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
    // Top-level JSX is not under any `.map(...)` — `in_map` starts false and is
    // only forced true when `lower_call_as_map` recurses into a Map body.
    let root = lower_element(element, &scope, false)?;

    let mut props = PropsShape {
        bindings: param_shape.destructured.clone(),
        types: BTreeMap::new(),
    };
    infer_props_types(&root, &mut props)?;

    Ok(Component { name, props, root })
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

    Ok(JsxNode::Island {
        component,
        instance: 0,
        props_path,
        hydrate,
        ssr,
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

    match strip_paren(e.as_ref()) {
        // `props={counter}` — bare destructured ident.
        SwcExpr::Ident(id) => {
            let name = id.sym.to_string();
            if scope.destructured.contains(&name) {
                Ok(name)
            } else {
                Err(err())
            }
        }
        // `props={data.counter}` — exactly one-deep member off a destructured root.
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

/// React-style JSX text normalization (spec §4.6, T6 refinement).
///
/// - Whitespace-only JSXText → empty string (caller drops the node).
/// - JSXText with non-ws content → collapse all runs of `\s+` (spaces, tabs,
///   newlines) to a single space and trim leading/trailing whitespace.
///
/// `split_whitespace().join(" ")` is sufficient for A1 fixtures because none
/// of them require preserving leading/trailing space at text-element boundaries.
fn normalize_jsx_text(s: &str) -> String {
    if s.trim().is_empty() {
        return String::new();
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ")
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
        SwcExpr::Tpl(t) => Err(LowerError::at(
            t.span,
            ErrorKind::TemplateLiteralNotSupported,
        )),
        SwcExpr::Call(c) => Err(LowerError::at(
            c.span,
            ErrorKind::CallExpressionNotSupported,
        )),
        SwcExpr::Bin(b) => Err(LowerError::at(
            b.span,
            ErrorKind::ComplexExpressionNotSupported,
        )),
        SwcExpr::Cond(c) => Err(LowerError::at(
            c.span,
            ErrorKind::ComplexExpressionNotSupported,
        )),
        SwcExpr::Unary(u) => Err(LowerError::at(
            u.span,
            ErrorKind::ComplexExpressionNotSupported,
        )),
        SwcExpr::Paren(p) => lower_expr(&p.expr, scope),
        other => Err(LowerError::at(
            other.span(),
            ErrorKind::ComplexExpressionNotSupported,
        )),
    }
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
    fn rejects_custom_component() {
        let src = "export default function X() { return <Layout/>; }";
        let parsed = parse(src, "<test>").unwrap();
        let err = lower(&parsed).unwrap_err();
        assert!(matches!(
            err.kind,
            ErrorKind::CustomComponentNotSupported(_)
        ));
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
        // The text gaps around the inner <p/> are pure whitespace and must be
        // dropped, leaving the outer <div> with exactly 1 child: <p/>.
        let src = "export default function X() { return <div>   \n   <p/>   </div>; }";
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
}
