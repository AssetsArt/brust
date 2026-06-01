//! Emit IR → minijinja template source.
//!
//! Lowering (parser + IR + lower) is unchanged — only the emission target
//! swapped per Sub-project J.
//!
//! See spec `2026-05-28-minijinja-dynamic-routes-design.md` S5 for the
//! IR→jinja table and plan `2026-05-29-minijinja-dynamic-routes-plan.md`
//! Task 1 for the emission rules used here.
//!
//! Determinism is load-bearing: golden fixtures compare byte-for-byte. The
//! output is a single line (no whitespace between sibling elements) so the
//! generated file is compact.

use std::fmt::Write;

use crate::ir::*;

pub fn emit(component: &Component) -> String {
    let mut out = String::new();
    emit_node(&component.root, &mut out);
    out
}

fn emit_node(node: &JsxNode, out: &mut String) {
    match node {
        JsxNode::Empty => {}
        JsxNode::Text(s) => {
            push_html_escaped(out, s);
        }
        JsxNode::Expr(e) => {
            emit_expr_node(e, out);
        }
        JsxNode::Map {
            source,
            binding,
            body,
        } => {
            let _ = write!(out, "{{% for {binding} in {} %}}", emit_expr_path(source));
            emit_node(body, out);
            out.push_str("{% endfor %}");
        }
        JsxNode::Element {
            tag,
            attrs,
            children,
        } => {
            out.push('<');
            out.push_str(tag);
            for a in attrs {
                emit_attr(a, out);
            }
            if is_void(tag) {
                out.push_str("/>");
            } else {
                out.push('>');
                for c in children {
                    emit_node(c, out);
                }
                let _ = write!(out, "</{tag}>");
            }
        }
        // Built-in `<BrustPage>` document shell. The compiler owns the WHOLE
        // html/head/body skeleton. Head is rendered entirely from props (no
        // user head markup): the framework auto tags (charset, viewport) come
        // first, then the prop-driven `<title>`/description meta, then the
        // app.css stylesheet link — so the link is always present without the
        // user writing it, and the framework can append more head tags later.
        // `lang`/`html_class`/`body_class`/`title`/`description` are each a
        // `HeadValue` (validated in `lower_brust_page`): a compile-time string
        // literal (attribute-/text-escaped here for safety) OR a member-path
        // interpolated as `{{ path }}` and rendered verbatim (brust runs
        // minijinja with `AutoEscape::None` — the loader-data-trusted contract,
        // same as host-element `href="{{ item.href }}"`). The islands importmap +
        // bootstrap are still appended after `</html>` by the TS reconcile step.
        JsxNode::Document {
            lang,
            html_class,
            body_class,
            title,
            description,
            body,
        } => {
            out.push_str("<html");
            if let Some(l) = lang {
                emit_head_attr(out, "lang", l);
            }
            if let Some(c) = html_class {
                emit_head_attr(out, "class", c);
            }
            out.push_str("><head>");
            out.push_str("<meta charset=\"utf-8\"/>");
            out.push_str(
                "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"/>",
            );
            if let Some(t) = title {
                out.push_str("<title>");
                match t {
                    HeadValue::Literal(s) => push_html_escaped(out, s),
                    HeadValue::Path(e) => {
                        let _ = write!(out, "{{{{ {} }}}}", emit_expr_path(e));
                    }
                }
                out.push_str("</title>");
            }
            if let Some(d) = description {
                out.push_str("<meta name=\"description\" content=\"");
                match d {
                    HeadValue::Literal(s) => push_attr_escaped(out, s),
                    HeadValue::Path(e) => {
                        let _ = write!(out, "{{{{ {} }}}}", emit_expr_path(e));
                    }
                }
                out.push_str("\"/>");
            }
            out.push_str("<link rel=\"stylesheet\" href=\"/_brust/css/app.css\"/>");
            out.push_str("</head><body");
            if let Some(c) = body_class {
                emit_head_attr(out, "class", c);
            }
            out.push('>');
            for c in body {
                emit_node(c, out);
            }
            out.push_str("</body></html>");
        }
        // SSR component slot. The JS worker fills `comp_<instance>_html` into
        // the template context; `| safe` passes the pre-rendered HTML through
        // unescaped. `instance` is a bare number, safe verbatim as a jinja
        // identifier.
        JsxNode::SsrComponent { instance, .. } => {
            let _ = write!(out, "{{{{ comp_{instance}_html | safe }}}}");
        }
        // Island mount marker. The hydration runtime keys off the
        // `data-brust-*` attributes; the runtime fills `island_<instance>_props`
        // (a pre-serialized, attribute-safe string — NOT `| tojson`, which
        // this minijinja build lacks) and, for ssr, `island_<instance>_html`
        // into the template context. `component` is validated `[A-Za-z0-9_]+`
        // and `instance` is a bare number, so both are safe verbatim as jinja
        // identifiers and inside attribute values — no escaping (escaping is
        // load-bearing for the byte-equal golden fixtures, so we deliberately
        // avoid it here).
        JsxNode::Cond {
            test,
            consequent,
            alternate,
        } => {
            let _ = write!(out, "{{% if {} %}}", emit_expr_path(test));
            emit_node(consequent, out);
            if let Some(alt) = alternate {
                out.push_str("{% else %}");
                emit_node(alt, out);
            }
            out.push_str("{% endif %}");
        }
        JsxNode::ChildrenSlot => unreachable!("ChildrenSlot must be substituted before emit"),
        JsxNode::Fragment { children } => {
            for c in children {
                emit_node(c, out);
            }
        }
        JsxNode::Island {
            component,
            instance,
            props_path: _,
            hydrate,
            ssr,
            ..
        } => {
            let _ = write!(
                out,
                "<div data-brust-island=\"{component}\" data-brust-props=\"{{{{ island_{instance}_props }}}}\" data-brust-hydrate=\"{hydrate}\""
            );
            if *ssr {
                // Close the open tag, emit the server-rendered markup slot
                // (`| safe` passes it through unescaped), then close the div.
                let _ = write!(out, ">{{{{ island_{instance}_html | safe }}}}</div>");
            } else {
                // Client-only: trailing bare `data-brust-csr`, empty body.
                out.push_str(" data-brust-csr></div>");
            }
        }
    }
}

/// Emit an `Expr` IR node sitting in JSX child position.
///
/// `Field`/`MemberAccess`/`MapBinding`/`MapMember`/`StaticNum` all render as
/// `{{ ... }}`. `StaticText` is HTML-escaped at compile time and emitted
/// verbatim (no `{{ ... }}` — it's a compile-time string, not a runtime value).
fn emit_expr_node(e: &Expr, out: &mut String) {
    match e {
        Expr::StaticText(s) => {
            push_html_escaped(out, s);
        }
        other => {
            let _ = write!(out, "{{{{ {} }}}}", emit_expr_path(other));
        }
    }
}

/// Emit a `<BrustPage>` head/shell attribute (`lang`/`class`) from a `HeadValue`.
/// Literals are attribute-escaped (pre-escaped at build); member-paths become
/// `{{ path }}` rendered verbatim (brust runs minijinja with `AutoEscape::None`).
fn emit_head_attr(out: &mut String, name: &str, hv: &HeadValue) {
    let _ = write!(out, " {name}=\"");
    match hv {
        HeadValue::Literal(s) => push_attr_escaped(out, s),
        HeadValue::Path(e) => {
            let _ = write!(out, "{{{{ {} }}}}", emit_expr_path(e));
        }
    }
    out.push('"');
}

/// Render the "path" form of an expression for use INSIDE `{{ ... }}`,
/// `{% for x in ... %}`, or an attribute's `{{ ... }}` body.
///
/// No `props.` prefix — the jinja template context is the loader's return
/// value, whose top-level keys are the destructured prop names.
fn emit_expr_path(e: &Expr) -> String {
    match e {
        Expr::Field(name) => name.clone(),
        Expr::MemberAccess { root, path } => {
            let mut s = root.clone();
            for seg in path {
                s.push('.');
                s.push_str(seg);
            }
            s
        }
        Expr::MapBinding(name) => name.clone(),
        Expr::MapMember { root, path } => {
            let mut s = root.clone();
            for seg in path {
                s.push('.');
                s.push_str(seg);
            }
            s
        }
        Expr::StaticText(s) => {
            // Shouldn't be reached for `{{ ... }}` context (we route static
            // text through emit_expr_node above), but if a Map source is ever
            // a literal string we render it as a quoted jinja literal.
            format!("\"{}\"", s.replace('"', "\\\""))
        }
        Expr::StaticNum(n) => n.to_string(),
        Expr::Arith { op, lhs, rhs } => {
            let op_str = match op {
                ArithOp::Add => "+",
                ArithOp::Sub => "-",
                ArithOp::Mul => "*",
                ArithOp::Div => "/",
                ArithOp::Mod => "%",
            };
            format!(
                "({}) {} ({})",
                emit_expr_path(lhs),
                op_str,
                emit_expr_path(rhs)
            )
        }
        Expr::Concat(parts) => {
            let rendered: Vec<String> = parts
                .iter()
                .map(|p| match p {
                    Expr::StaticText(s) => format!("\"{}\"", s.replace('"', "\\\"")),
                    other => emit_expr_path(other),
                })
                .collect();
            rendered.join(" ~ ")
        }
        Expr::Filter { value, name, args } => {
            // Parenthesize value if it's a binary op to avoid ambiguity.
            let value_str = match value.as_ref() {
                Expr::Arith { .. } | Expr::Compare { .. } | Expr::Logical { .. } => {
                    format!("({})", emit_expr_path(value))
                }
                other => emit_expr_path(other),
            };
            if args.is_empty() {
                format!("{} | {}", value_str, name)
            } else {
                let args_str: Vec<String> = args.iter().map(emit_expr_path).collect();
                format!("{} | {}({})", value_str, name, args_str.join(", "))
            }
        }
        Expr::Compare { op, lhs, rhs } => {
            let op_str = match op {
                CmpOp::Eq => "==",
                CmpOp::Ne => "!=",
                CmpOp::Gt => ">",
                CmpOp::Lt => "<",
                CmpOp::Ge => ">=",
                CmpOp::Le => "<=",
            };
            format!(
                "({}) {} ({})",
                emit_expr_path(lhs),
                op_str,
                emit_expr_path(rhs)
            )
        }
        Expr::Logical { op, lhs, rhs } => {
            let op_str = match op {
                LogOp::And => "and",
                LogOp::Or => "or",
            };
            format!(
                "({}) {} ({})",
                emit_expr_path(lhs),
                op_str,
                emit_expr_path(rhs)
            )
        }
        Expr::Not(e) => {
            format!("not ({})", emit_expr_path(e))
        }
    }
}

/// Emit one attribute, appending it directly to `out` (caller has already
/// emitted the tag name and an implicit space-prefix is added here).
fn emit_attr(a: &JsxAttr, out: &mut String) {
    match &a.value {
        AttrValue::Empty => {
            out.push(' ');
            out.push_str(&a.name);
        }
        AttrValue::Static(s) => {
            out.push(' ');
            out.push_str(&a.name);
            out.push_str("=\"");
            push_attr_escaped(out, s);
            out.push('"');
        }
        AttrValue::StaticNum(n) => {
            let _ = write!(out, " {}=\"{n}\"", a.name);
        }
        AttrValue::Expr(e) => match e {
            // Static-in-attr-position fell through `lower_attr` only when the
            // user wrote `attr={"raw"}` instead of `attr="raw"`; the AttrValue
            // is reshaped to `AttrValue::Static` by the lowerer in that case,
            // so the `StaticText` branch here is for completeness.
            Expr::StaticText(s) => {
                out.push(' ');
                out.push_str(&a.name);
                out.push_str("=\"");
                push_attr_escaped(out, s);
                out.push('"');
            }
            Expr::StaticNum(n) => {
                let _ = write!(out, " {}=\"{n}\"", a.name);
            }
            other => {
                let _ = write!(out, " {}=\"{{{{ {} }}}}\"", a.name, emit_expr_path(other));
            }
        },
    }
}

/// HTML-escape `s` for text-node position (`<`, `>`, `&`).
///
/// Quotes are NOT escaped here — they're only relevant inside attribute
/// values. minijinja's autoescape would re-escape runtime values; compile-
/// time literals are pre-escaped here so the final HTML is well-formed
/// regardless of autoescape configuration.
fn push_html_escaped(out: &mut String, s: &str) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            other => out.push(other),
        }
    }
}

/// HTML-escape `s` for attribute-value position. Adds `"` escape because
/// attribute values are quoted with `"`.
fn push_attr_escaped(out: &mut String, s: &str) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            other => out.push(other),
        }
    }
}

const VOID: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "keygen", "link", "meta", "param",
    "source", "track", "wbr",
];

fn is_void(tag: &str) -> bool {
    VOID.contains(&tag)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// Build an empty `Component` shell around a single `JsxNode` root.
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
    fn emits_static_element_with_text() {
        let ir = JsxNode::Element {
            tag: "div".into(),
            attrs: vec![],
            children: vec![JsxNode::Text("Hello".into())],
        };
        assert_eq!(emit(&component(ir)), "<div>Hello</div>");
    }

    #[test]
    fn emits_text_expr_as_double_brace() {
        let ir = JsxNode::Element {
            tag: "h1".into(),
            attrs: vec![],
            children: vec![JsxNode::Expr(Expr::Field("title".into()))],
        };
        assert_eq!(emit(&component(ir)), "<h1>{{ title }}</h1>");
    }

    #[test]
    fn emits_attr_expr_as_quoted_double_brace() {
        let ir = JsxNode::Element {
            tag: "a".into(),
            attrs: vec![JsxAttr {
                name: "href".into(),
                value: AttrValue::Expr(Expr::MemberAccess {
                    root: "item".into(),
                    path: vec!["href".into()],
                }),
            }],
            children: vec![],
        };
        assert_eq!(emit(&component(ir)), "<a href=\"{{ item.href }}\"></a>");
    }

    #[test]
    fn emits_map_as_for_loop() {
        let ir = JsxNode::Map {
            source: Expr::Field("items".into()),
            binding: "item".into(),
            body: Box::new(JsxNode::Element {
                tag: "li".into(),
                attrs: vec![],
                children: vec![],
            }),
        };
        assert_eq!(
            emit(&component(ir)),
            "{% for item in items %}<li></li>{% endfor %}"
        );
    }

    #[test]
    fn emits_void_element_self_closing() {
        let ir = JsxNode::Element {
            tag: "br".into(),
            attrs: vec![],
            children: vec![],
        };
        assert_eq!(emit(&component(ir)), "<br/>");
    }

    #[test]
    fn html_escape_in_text() {
        let ir = JsxNode::Element {
            tag: "p".into(),
            attrs: vec![],
            children: vec![JsxNode::Text("a < b & c > d".into())],
        };
        assert_eq!(emit(&component(ir)), "<p>a &lt; b &amp; c &gt; d</p>");
    }

    // Additional coverage for paths not in the spec's six-test minimum.

    #[test]
    fn emits_static_attr_escaped() {
        let ir = JsxNode::Element {
            tag: "div".into(),
            attrs: vec![JsxAttr {
                name: "title".into(),
                value: AttrValue::Static("a < b & \"c\"".into()),
            }],
            children: vec![],
        };
        assert_eq!(
            emit(&component(ir)),
            "<div title=\"a &lt; b &amp; &quot;c&quot;\"></div>"
        );
    }

    #[test]
    fn emits_empty_bare_attr() {
        let ir = JsxNode::Element {
            tag: "input".into(),
            attrs: vec![JsxAttr {
                name: "disabled".into(),
                value: AttrValue::Empty,
            }],
            children: vec![],
        };
        assert_eq!(emit(&component(ir)), "<input disabled/>");
    }

    #[test]
    fn emits_static_num_attr() {
        let ir = JsxNode::Element {
            tag: "input".into(),
            attrs: vec![JsxAttr {
                name: "tabindex".into(),
                value: AttrValue::StaticNum(5),
            }],
            children: vec![],
        };
        assert_eq!(emit(&component(ir)), "<input tabindex=\"5\"/>");
    }

    #[test]
    fn emits_member_access_three_segments() {
        let ir = JsxNode::Element {
            tag: "span".into(),
            attrs: vec![],
            children: vec![JsxNode::Expr(Expr::MemberAccess {
                root: "user".into(),
                path: vec!["address".into(), "city".into()],
            })],
        };
        assert_eq!(emit(&component(ir)), "<span>{{ user.address.city }}</span>");
    }

    #[test]
    fn emits_map_with_member_source() {
        // For `nested.items.map(item => …)` the source is a MemberAccess.
        let ir = JsxNode::Map {
            source: Expr::MemberAccess {
                root: "nested".into(),
                path: vec!["items".into()],
            },
            binding: "item".into(),
            body: Box::new(JsxNode::Element {
                tag: "li".into(),
                attrs: vec![],
                children: vec![],
            }),
        };
        assert_eq!(
            emit(&component(ir)),
            "{% for item in nested.items %}<li></li>{% endfor %}"
        );
    }

    #[test]
    fn emits_map_binding_in_body() {
        // `xs.map(x => <li>{x}</li>)` → `{% for x in xs %}<li>{{ x }}</li>{% endfor %}`
        let ir = JsxNode::Map {
            source: Expr::Field("xs".into()),
            binding: "x".into(),
            body: Box::new(JsxNode::Element {
                tag: "li".into(),
                attrs: vec![],
                children: vec![JsxNode::Expr(Expr::MapBinding("x".into()))],
            }),
        };
        assert_eq!(
            emit(&component(ir)),
            "{% for x in xs %}<li>{{ x }}</li>{% endfor %}"
        );
    }

    #[test]
    fn emits_static_num_in_text_position() {
        let ir = JsxNode::Element {
            tag: "p".into(),
            attrs: vec![],
            children: vec![JsxNode::Expr(Expr::StaticNum(42))],
        };
        assert_eq!(emit(&component(ir)), "<p>{{ 42 }}</p>");
    }

    #[test]
    fn emits_static_text_expr_escaped_no_braces() {
        let ir = JsxNode::Element {
            tag: "p".into(),
            attrs: vec![],
            children: vec![JsxNode::Expr(Expr::StaticText("a & b".into()))],
        };
        assert_eq!(emit(&component(ir)), "<p>a &amp; b</p>");
    }

    // Island mount markers (T2). Byte-equal — golden fixtures (T4) render
    // these through real minijinja with the runtime-supplied context keys
    // `island_<id>_props` / `island_<id>_html`.

    #[test]
    fn emits_ssr_island() {
        let ir = JsxNode::Island {
            component: "Counter".into(),
            instance: 0,
            props_path: "counter".into(),
            hydrate: "load".into(),
            ssr: true,
            key_path: None,
            key_literal: None,
            tags_path: None,
            tags_literal: None,
            revalidate: None,
        };
        assert_eq!(
            emit(&component(ir)),
            "<div data-brust-island=\"Counter\" data-brust-props=\"{{ island_0_props }}\" data-brust-hydrate=\"load\">{{ island_0_html | safe }}</div>"
        );
    }

    #[test]
    fn emits_client_only_island() {
        // ssr:false → no `_html` slot, trailing bare `data-brust-csr`.
        let ir = JsxNode::Island {
            component: "Counter".into(),
            instance: 0,
            props_path: "counter".into(),
            hydrate: "load".into(),
            ssr: false,
            key_path: None,
            key_literal: None,
            tags_path: None,
            tags_literal: None,
            revalidate: None,
        };
        assert_eq!(
            emit(&component(ir)),
            "<div data-brust-island=\"Counter\" data-brust-props=\"{{ island_0_props }}\" data-brust-hydrate=\"load\" data-brust-csr></div>"
        );
    }

    #[test]
    fn emits_island_interpolates_component_and_hydrate() {
        // A different component/hydrate must thread through every slot.
        let ir = JsxNode::Island {
            component: "Cart".into(),
            instance: 0,
            props_path: "cart".into(),
            hydrate: "visible".into(),
            ssr: true,
            key_path: None,
            key_literal: None,
            tags_path: None,
            tags_literal: None,
            revalidate: None,
        };
        assert_eq!(
            emit(&component(ir)),
            "<div data-brust-island=\"Cart\" data-brust-props=\"{{ island_0_props }}\" data-brust-hydrate=\"visible\">{{ island_0_html | safe }}</div>"
        );
    }

    // T2: Cond and new Expr variant tests.

    #[test]
    fn cond_and_emits_if() {
        // Cond with no alternate → `{% if active %}<span></span>{% endif %}`
        let ir = JsxNode::Cond {
            test: Expr::Field("active".into()),
            consequent: Box::new(JsxNode::Element {
                tag: "span".into(),
                attrs: vec![],
                children: vec![],
            }),
            alternate: None,
        };
        assert_eq!(
            emit(&component(ir)),
            "{% if active %}<span></span>{% endif %}"
        );
    }

    #[test]
    fn cond_ternary_emits_if_else() {
        // Cond with alternate → contains `{% if x %}` ... `{% else %}` ... `{% endif %}`
        let ir = JsxNode::Cond {
            test: Expr::Field("x".into()),
            consequent: Box::new(JsxNode::Element {
                tag: "span".into(),
                attrs: vec![],
                children: vec![],
            }),
            alternate: Some(Box::new(JsxNode::Element {
                tag: "div".into(),
                attrs: vec![],
                children: vec![],
            })),
        };
        let out = emit(&component(ir));
        assert!(out.contains("{% if x %}"), "missing if: {out}");
        assert!(out.contains("{% else %}"), "missing else: {out}");
        assert!(out.contains("{% endif %}"), "missing endif: {out}");
        assert_eq!(
            out,
            "{% if x %}<span></span>{% else %}<div></div>{% endif %}"
        );
    }

    #[test]
    fn filter_upper() {
        // `Expr::Filter{ value: Field("name"), name:"upper", args:[] }` in `{{ }}` → `{{ name | upper }}`
        let ir = JsxNode::Element {
            tag: "span".into(),
            attrs: vec![],
            children: vec![JsxNode::Expr(Expr::Filter {
                value: Box::new(Expr::Field("name".into())),
                name: "upper".into(),
                args: vec![],
            })],
        };
        assert_eq!(emit(&component(ir)), "<span>{{ name | upper }}</span>");
    }

    #[test]
    fn compare_gt() {
        // `Compare{Gt, Field("count"), StaticNum(0)}` as Cond test → `{% if (count) > (0) %}`
        let ir = JsxNode::Cond {
            test: Expr::Compare {
                op: CmpOp::Gt,
                lhs: Box::new(Expr::Field("count".into())),
                rhs: Box::new(Expr::StaticNum(0)),
            },
            consequent: Box::new(JsxNode::Empty),
            alternate: None,
        };
        let out = emit(&component(ir));
        assert!(
            out.contains("{% if (count) > (0) %}"),
            "unexpected output: {out}"
        );
    }

    #[test]
    fn concat_template() {
        // `Concat([StaticText("Hi "), Field("name")])` → `{{ "Hi " ~ name }}`
        let ir = JsxNode::Element {
            tag: "p".into(),
            attrs: vec![],
            children: vec![JsxNode::Expr(Expr::Concat(vec![
                Expr::StaticText("Hi ".into()),
                Expr::Field("name".into()),
            ]))],
        };
        assert_eq!(emit(&component(ir)), "<p>{{ \"Hi \" ~ name }}</p>");
    }

    #[test]
    fn emits_fragment_children_no_wrapper() {
        let ir = JsxNode::Fragment {
            children: vec![JsxNode::Text("a".into()), JsxNode::Text("b".into())],
        };
        assert_eq!(emit(&component(ir)), "ab");
    }

    #[test]
    fn emits_fragment_with_expr() {
        let ir = JsxNode::Fragment {
            children: vec![JsxNode::Expr(Expr::Field("t".into()))],
        };
        assert_eq!(emit(&component(ir)), "{{ t }}");
    }

    #[test]
    fn logical_and() {
        // `Logical{And, Field("a"), Field("b")}` as Cond test → `{% if (a) and (b) %}`
        let ir = JsxNode::Cond {
            test: Expr::Logical {
                op: LogOp::And,
                lhs: Box::new(Expr::Field("a".into())),
                rhs: Box::new(Expr::Field("b".into())),
            },
            consequent: Box::new(JsxNode::Empty),
            alternate: None,
        };
        let out = emit(&component(ir));
        assert!(
            out.contains("{% if (a) and (b) %}"),
            "unexpected output: {out}"
        );
    }

    fn document_with(lang: Option<HeadValue>, title: Option<HeadValue>) -> JsxNode {
        JsxNode::Document {
            lang,
            html_class: None,
            body_class: None,
            title,
            description: None,
            body: vec![],
        }
    }

    #[test]
    fn document_title_path_emits_interpolated_title() {
        let ir = document_with(None, Some(HeadValue::Path(Expr::Field("t".into()))));
        let out = emit(&component(ir));
        assert!(
            out.contains("<title>{{ t }}</title>"),
            "unexpected output: {out}"
        );
    }

    #[test]
    fn document_lang_path_emits_interpolated_lang_attr() {
        let ir = document_with(Some(HeadValue::Path(Expr::Field("l".into()))), None);
        let out = emit(&component(ir));
        assert!(out.contains("lang=\"{{ l }}\""), "unexpected output: {out}");
    }

    #[test]
    fn document_title_literal_emits_plain_title() {
        let ir = document_with(None, Some(HeadValue::Literal("Hi".into())));
        let out = emit(&component(ir));
        assert!(
            out.contains("<title>Hi</title>"),
            "unexpected output: {out}"
        );
    }

    #[test]
    fn document_description_path_emits_interpolated_content() {
        // `description` is emitted via an inline `content="…"` write (not
        // emit_head_attr), so it needs its own coverage for the Path branch.
        let ir = JsxNode::Document {
            lang: None,
            html_class: None,
            body_class: None,
            title: None,
            description: Some(HeadValue::Path(Expr::MemberAccess {
                root: "d".into(),
                path: vec!["desc".into()],
            })),
            body: vec![],
        };
        let out = emit(&component(ir));
        assert!(
            out.contains("<meta name=\"description\" content=\"{{ d.desc }}\"/>"),
            "unexpected output: {out}"
        );
    }
}
