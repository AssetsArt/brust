use crate::ir::{AttrValue, Component, Expr, JsxAttr, JsxNode};

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
        JsxNode::Empty | JsxNode::Text(_) | JsxNode::Expr(_) | JsxNode::Island { .. } => {}
    }
}

fn emit_h(component: &str, props: &[JsxAttr], children: &[JsxNode], fo: &mut FactoryOutput) {
    use std::fmt::Write as _;
    let _ = write!(fo.expr, "h({component}, {{");
    for (i, attr) in props.iter().enumerate() {
        if i > 0 {
            fo.expr.push_str(", ");
        }
        emit_attr_kv(attr, fo);
    }
    fo.expr.push('}');
    for child in children {
        fo.expr.push_str(", ");
        emit_child(child, fo);
    }
    fo.expr.push(')');
}

fn emit_attr_kv(attr: &JsxAttr, fo: &mut FactoryOutput) {
    use std::fmt::Write as _;
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
    use std::fmt::Write as _;
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
        JsxNode::Document { .. } => {} // cannot appear as child
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
    }
}
