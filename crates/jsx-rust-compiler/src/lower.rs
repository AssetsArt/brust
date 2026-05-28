use swc_core::common::{Span, Spanned};
use swc_core::ecma::ast::{
    BlockStmt, DefaultDecl, ExportDefaultDecl, Expr as SwcExpr, FnExpr, JSXAttrName,
    JSXAttrOrSpread, JSXAttrValue, JSXElement, JSXElementChild, JSXElementName, Module, ModuleDecl,
    ModuleItem, ParenExpr, ReturnStmt, Stmt,
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

pub fn lower(parsed: &ParsedSource) -> Result<Component, LowerError> {
    let (name, function) = find_default_export(&parsed.module)?;
    let body =
        function.function.body.as_ref().ok_or_else(|| {
            LowerError::at(function.function.span, ErrorKind::BodyMustBeSingleReturn)
        })?;
    let return_expr = single_return_expr(body)?;
    let jsx = strip_paren(return_expr);
    // `SwcExpr::JSXElement` wraps `Box<JSXElement>` in swc_ecma_ast 25; the `&Box<JSXElement>`
    // binding here coerces to `&JSXElement` at the call site below.
    let element = match jsx {
        SwcExpr::JSXElement(el) => el,
        // Fragment-as-root must surface `FragmentNotSupported` (matches the rest of the
        // tree's fragment-child rejection in `lower_child_t3`).
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
    let root = lower_element(element, &[])?;
    Ok(Component {
        name,
        props: PropsShape::default(),
        root,
    })
}

fn find_default_export(module: &Module) -> Result<(String, &FnExpr), LowerError> {
    let mut found: Option<(String, &FnExpr)> = None;
    for item in &module.body {
        match item {
            ModuleItem::ModuleDecl(ModuleDecl::Import(_)) => continue,
            ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(ExportDefaultDecl {
                decl,
                ..
            })) => {
                if let DefaultDecl::Fn(fn_expr) = decl {
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
                } else {
                    return Err(LowerError::at(
                        span_of_item(item),
                        ErrorKind::UnexpectedStatement,
                    ));
                }
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

fn lower_element(el: &JSXElement, _scope: &[String]) -> Result<JsxNode, LowerError> {
    let tag = lower_element_name(&el.opening.name)?;
    // T6 adds: void-element children check, attr renames, whitespace normalization, on*/ref/key
    let attrs = el
        .opening
        .attrs
        .iter()
        .map(lower_attr_t3)
        .collect::<Result<Vec<_>, _>>()?;

    let mut children = Vec::new();
    for child in &el.children {
        if let Some(node) = lower_child_t3(child)? {
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

fn lower_attr_t3(attr: &JSXAttrOrSpread) -> Result<JsxAttr, LowerError> {
    match attr {
        JSXAttrOrSpread::SpreadElement(s) => Err(LowerError::at(
            s.dot3_token,
            ErrorKind::SpreadAttributeNotSupported,
        )),
        JSXAttrOrSpread::JSXAttr(jsx_attr) => {
            // `JSXAttrName::Ident` wraps `IdentName` (NOT `Ident`) in swc_ecma_ast 6.1.
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
            // as `JSXExprContainer(Lit(Lit::Num(_)))` and are handled in T4+ via expr lowering.
            let value = match &jsx_attr.value {
                None => AttrValue::Empty,
                Some(JSXAttrValue::Str(s)) => {
                    // `Str.value` is a `Wtf8Atom`; lossy UTF-8 here is safe because the source
                    // we parsed was already valid UTF-8 (we accepted it as `&str`).
                    AttrValue::Static(s.value.to_string_lossy().into_owned())
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

fn lower_child_t3(child: &JSXElementChild) -> Result<Option<JsxNode>, LowerError> {
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
        JSXElementChild::JSXElement(el) => Ok(Some(lower_element(el, &[])?)),
        JSXElementChild::JSXFragment(f) => {
            Err(LowerError::at(f.span, ErrorKind::FragmentNotSupported))
        }
        JSXElementChild::JSXSpreadChild(s) => {
            Err(LowerError::at(s.span, ErrorKind::SpreadChildNotSupported))
        }
        // T4 adds: JSXExprContainer handling
        JSXElementChild::JSXExprContainer(c) => Err(LowerError::at(
            c.span,
            ErrorKind::BareIdentNotSupported("(T4)".into()),
        )),
    }
}

fn normalize_whitespace_t3(s: &str) -> String {
    // Static-only T3 rule: drop whitespace-only nodes.
    if s.trim().is_empty() {
        String::new()
    } else {
        s.trim().to_string()
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
}
