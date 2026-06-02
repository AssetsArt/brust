use std::fmt::Write as _;

use crate::ir::{AttrValue, Component, Expr, HeadValue, JsxAttr, JsxNode, SsrProp};

pub struct FactoryOutput {
    pub expr: String,
    pub referenced: Vec<String>,
    pub uses_island: bool,
}

pub fn emit(component: &Component) -> Vec<FactoryOutput> {
    let mut out = Vec::new();
    collect_factories(&component.root, &mut out);
    out
}

fn collect_factories(node: &JsxNode, out: &mut Vec<FactoryOutput>) {
    match node {
        JsxNode::SsrComponent {
            component,
            props,
            children,
            ..
        } => {
            let mut fo = FactoryOutput {
                expr: String::new(),
                referenced: Vec::new(),
                uses_island: false,
            };
            fo.referenced.push(component.clone());
            fo.expr.push_str("(ctx) => ");
            emit_h(component, props, children, &mut fo);
            out.push(fo);
            // Do NOT recurse into children — nested SsrComponents are inline
        }
        JsxNode::Element { children, .. } => {
            for c in children {
                collect_factories(c, out);
            }
        }
        JsxNode::Document { body, .. } => {
            for c in body {
                collect_factories(c, out);
            }
        }
        JsxNode::Map { body, .. } => collect_factories(body, out),
        JsxNode::Empty
        | JsxNode::Text(_)
        | JsxNode::Expr(_)
        | JsxNode::RawHtml(_)
        | JsxNode::Island { .. } => {}
        JsxNode::Cond {
            consequent,
            alternate,
            ..
        } => {
            collect_factories(consequent, out);
            if let Some(alt) = alternate {
                collect_factories(alt, out);
            }
        }
        JsxNode::ChildrenSlot => {}
        JsxNode::Fragment { children } => {
            for c in children {
                collect_factories(c, out);
            }
        }
    }
}

fn emit_h(component: &str, props: &[SsrProp], children: &[JsxNode], fo: &mut FactoryOutput) {
    let _ = write!(fo.expr, "h({component}, {{");
    // Props emit in source order so `{...a, b}` vs `{b, ...a}` override
    // semantics match the JSX. Named → `name: value`; spread → `...expr`.
    for (i, prop) in props.iter().enumerate() {
        if i > 0 {
            fo.expr.push_str(", ");
        }
        match prop {
            SsrProp::Attr(attr) => emit_attr_kv(attr, fo),
            SsrProp::Spread(e) => {
                fo.expr.push_str("...");
                fo.expr.push_str(&emit_expr(e));
            }
        }
    }
    fo.expr.push('}');
    for child in children {
        fo.expr.push_str(", ");
        emit_child(child, fo);
    }
    fo.expr.push(')');
}

fn emit_attr_kv(attr: &JsxAttr, fo: &mut FactoryOutput) {
    let _ = write!(fo.expr, "{}: ", attr.name);
    match &attr.value {
        AttrValue::Empty => fo.expr.push_str("true"),
        AttrValue::Static(s) => {
            fo.expr.push('"');
            fo.expr.push_str(&s.replace('"', "\\\""));
            fo.expr.push('"');
        }
        AttrValue::StaticNum(n) => {
            let _ = write!(fo.expr, "{n}");
        }
        AttrValue::Expr(e) => fo.expr.push_str(&emit_expr(e)),
    }
}

fn emit_child(node: &JsxNode, fo: &mut FactoryOutput) {
    match node {
        JsxNode::Element {
            tag,
            attrs,
            children,
        } => {
            let _ = write!(fo.expr, "h(\"{tag}\", ");
            if attrs.is_empty() {
                fo.expr.push_str("null");
            } else {
                fo.expr.push('{');
                for (i, a) in attrs.iter().enumerate() {
                    if i > 0 {
                        fo.expr.push_str(", ");
                    }
                    emit_attr_kv(a, fo);
                }
                fo.expr.push('}');
            }
            for c in children {
                fo.expr.push_str(", ");
                emit_child(c, fo);
            }
            fo.expr.push(')');
        }
        JsxNode::Text(s) => {
            fo.expr.push('"');
            fo.expr.push_str(&s.replace('"', "\\\""));
            fo.expr.push('"');
        }
        JsxNode::Expr(e) => {
            fo.expr.push_str(&emit_expr(e));
        }
        JsxNode::Island {
            component,
            props_path,
            hydrate,
            ssr,
            ..
        } => {
            fo.uses_island = true;
            fo.referenced.push(component.clone());
            let _ = write!(
                fo.expr,
                "h(Island, {{component: {component}, props: ctx.{props_path}, hydrate: \"{hydrate}\"",
            );
            if *ssr {
                fo.expr.push_str(", ssr: true");
            }
            fo.expr.push_str("})");
        }
        JsxNode::SsrComponent {
            component,
            props,
            children,
            ..
        } => {
            // Nested SSR component — emit inline, not a separate factory entry
            fo.referenced.push(component.clone());
            emit_h(component, props, children, fo);
        }
        JsxNode::Map {
            source,
            binding,
            body,
        } => {
            let _ = write!(fo.expr, "{}.map(({binding}) => ", emit_expr(source));
            emit_child(body, fo);
            fo.expr.push(')');
        }
        JsxNode::Empty => {}
        // `dangerouslySetInnerHTML` is a native-body (jinja) feature; in the
        // React SSR-component factory path it is emitted as a sibling fragment
        // carrying the prop, so the rendered markup matches the native output.
        JsxNode::RawHtml(hv) => {
            fo.expr
                .push_str("h(\"div\", {dangerouslySetInnerHTML: {__html: ");
            match hv {
                HeadValue::Literal(s) => {
                    // JS double-quoted string: escape backslash FIRST, then quote
                    // and the control chars that a multi-line HTML snippet carries
                    // (a raw newline in a JS "" literal is a syntax error).
                    let escaped = s
                        .replace('\\', "\\\\")
                        .replace('"', "\\\"")
                        .replace('\n', "\\n")
                        .replace('\r', "\\r");
                    fo.expr.push('"');
                    fo.expr.push_str(&escaped);
                    fo.expr.push('"');
                }
                HeadValue::Path(e) => fo.expr.push_str(&emit_expr(e)),
            }
            fo.expr.push_str("}})");
        }
        JsxNode::Document { .. } => {} // cannot appear as child
        JsxNode::Cond { .. } => unreachable!("Cond handled in a later task"),
        JsxNode::ChildrenSlot => unreachable!("ChildrenSlot handled in a later task"),
        JsxNode::Fragment { .. } => {
            unreachable!("fragment rejected as SSR-component child in lower_ssr_component")
        }
    }
}

fn emit_expr(e: &Expr) -> String {
    match e {
        Expr::Field(f) => format!("ctx.{f}"),
        Expr::MemberAccess { root, path } => format!("ctx.{root}.{}", path.join(".")),
        Expr::MapBinding(b) => b.clone(),
        Expr::MapMember { root, path } => format!("{root}.{}", path.join(".")),
        Expr::StaticText(s) => format!("\"{}\"", s.replace('"', "\\\"")),
        Expr::StaticNum(n) => n.to_string(),
        Expr::Arith { .. }
        | Expr::Concat(_)
        | Expr::Filter { .. }
        | Expr::Compare { .. }
        | Expr::Logical { .. }
        | Expr::Not(_) => unreachable!("new Expr variants handled in a later task"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{Component, JsxNode, PropsShape};
    use std::collections::BTreeMap;

    fn component(root: JsxNode) -> Component {
        Component {
            name: "X".into(),
            props: PropsShape {
                bindings: vec![],
                types: BTreeMap::new(),
            },
            root,
        }
    }

    #[test]
    fn factory_descends_through_fragment() {
        // root `<><Layout/></>` → emit produces one FactoryOutput referencing Layout.
        let root = JsxNode::Fragment {
            children: vec![JsxNode::SsrComponent {
                component: "Layout".to_string(),
                instance: 0,
                props: vec![],
                children: vec![],
                key_path: None,
                key_literal: None,
                tags_path: None,
                tags_literal: None,
                revalidate: None,
            }],
        };
        let outputs = emit(&component(root));
        assert_eq!(
            outputs.len(),
            1,
            "expected one FactoryOutput, got {}",
            outputs.len()
        );
        assert!(
            outputs[0].referenced.contains(&"Layout".to_string()),
            "expected Layout in referenced, got {:?}",
            outputs[0].referenced
        );
    }
}
