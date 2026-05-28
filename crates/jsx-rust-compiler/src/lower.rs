use std::collections::BTreeMap;

use swc_core::common::{Span, Spanned};
use swc_core::ecma::ast::{
    AssignPatProp, BindingIdent, BlockStmt, DefaultDecl, ExportDefaultDecl, Expr as SwcExpr,
    FnExpr, Function, JSXAttrName, JSXAttrOrSpread, JSXAttrValue, JSXElement, JSXElementChild,
    JSXElementName, JSXExpr, Lit, MemberExpr, MemberProp, Module, ModuleDecl, ModuleItem,
    ObjectPatProp, ParenExpr, Pat, ReturnStmt, Stmt,
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
/// body and popped after. T4 only initializes it empty; T5 will push entries.
#[derive(Debug, Default)]
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
    let root = lower_element(element, &scope)?;

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

fn lower_element(el: &JSXElement, scope: &Scope) -> Result<JsxNode, LowerError> {
    let tag = lower_element_name(&el.opening.name)?;
    // T6 adds: void-element children check, attr renames, whitespace normalization, on*/ref/key
    let attrs = el
        .opening
        .attrs
        .iter()
        .map(|a| lower_attr_t4(a, scope))
        .collect::<Result<Vec<_>, _>>()?;

    let mut children = Vec::new();
    for child in &el.children {
        if let Some(node) = lower_child(child, scope)? {
            children.push(node);
        }
    }

    Ok(JsxNode::Element {
        tag,
        attrs,
        children,
    })
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

fn lower_attr_t4(attr: &JSXAttrOrSpread, scope: &Scope) -> Result<JsxAttr, LowerError> {
    match attr {
        JSXAttrOrSpread::SpreadElement(s) => Err(LowerError::at(
            s.dot3_token,
            ErrorKind::SpreadAttributeNotSupported,
        )),
        JSXAttrOrSpread::JSXAttr(jsx_attr) => {
            // `JSXAttrName::Ident` wraps `IdentName` (NOT `Ident`) in swc_ecma_ast 25.
            let name = match &jsx_attr.name {
                JSXAttrName::Ident(name) => name.sym.to_string(),
                JSXAttrName::JSXNamespacedName(n) => {
                    return Err(LowerError::at(
                        n.span,
                        ErrorKind::NamespacedAttrNotSupported,
                    ));
                }
            };
            // T6 promotes this to full attr-precedence handling.
            //
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
            Ok(JsxAttr { name, value })
        }
    }
}

fn lower_child(child: &JSXElementChild, scope: &Scope) -> Result<Option<JsxNode>, LowerError> {
    match child {
        JSXElementChild::JSXText(text) => {
            let cleaned = normalize_whitespace_t3(&text.value);
            if cleaned.is_empty() {
                Ok(None)
            } else {
                Ok(Some(JsxNode::Text(cleaned)))
            }
        }
        // `JSXElementChild::JSXElement` wraps `Box<JSXElement>`; auto-deref to `&JSXElement`.
        JSXElementChild::JSXElement(el) => Ok(Some(lower_element(el, scope)?)),
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
            JSXExpr::Expr(e) => Ok(Some(JsxNode::Expr(lower_expr(e, scope)?))),
        },
    }
}

fn normalize_whitespace_t3(s: &str) -> String {
    // Static-only T3 rule: drop whitespace-only nodes. T6 will refine.
    if s.trim().is_empty() {
        String::new()
    } else {
        s.trim().to_string()
    }
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
        JsxNode::Map { source, body, .. } => {
            // T5 will refine: the `source` informs `VecOf` inference and the
            // body's `MapMember` references inform the element struct. For
            // T4 we still walk so any `Field`/`MemberAccess` references in
            // the source contribute to top-level props.
            infer_from_expr(source, props)?;
            infer_props_types(body, props)
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
}
