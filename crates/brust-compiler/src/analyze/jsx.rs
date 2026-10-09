//! Reads the parser's lowered JSX (`jsx`/`jsxs(tag, props[, key])` calls with
//! `was_jsx_element`) back into template `Node`s. The parser has already applied
//! JSX whitespace collapsing and entity decoding to text children.
use crate::analyze::expr::{Reader, estring, loc_of};
use crate::ir::{Attr, Diagnostic, Expr, HandlerDecl, IdentKind, Node, RawExpr, RawKind};
use bun_ast as js_ast;
use js_ast::OpCode;
use js_ast::b::B;
use js_ast::expr::Data as E;
use js_ast::stmt::Data as S;

/// Reads one lowered JSX call.
pub fn read_jsx(r: &mut Reader<'_, '_>, e: &js_ast::Expr) -> Node {
    read_element(r, e, false)
}

fn jsx_call(e: &js_ast::Expr) -> Option<&js_ast::E::Call> {
    match &e.data {
        E::ECall(c) if c.was_jsx_element => Some(c),
        _ => None,
    }
}

enum Tag {
    Host(String),
    Fragment,
    Component {
        name: String,
        source: Option<String>,
        imported: Option<String>,
    },
    Member,
    /// `Outlet` imported from `@brust/core/routes` (S8).
    Outlet,
}

fn tag_of(r: &Reader<'_, '_>, tag: &js_ast::Expr) -> Tag {
    match &tag.data {
        E::EString(s) => Tag::Host(estring(s)),
        E::EIdentifier(js_ast::E::Identifier { ref_ })
        | E::EImportIdentifier(js_ast::E::ImportIdentifier { ref_ }) => {
            if r.names.is_fragment(*ref_) {
                return Tag::Fragment;
            }
            if r.names.import_of(*ref_) == Some(("@brust/core/routes", "Outlet")) {
                return Tag::Outlet;
            }
            let (name, kind) = r.names.kind_of(*ref_);
            let (source, imported) = match kind {
                IdentKind::Import { source, imported } => (Some(source), Some(imported)),
                _ => (None, None),
            };
            Tag::Component {
                name,
                source,
                imported,
            }
        }
        _ => Tag::Member,
    }
}

/// `in_list_body`: this element is the direct body of a `.map` callback, so a
/// `key` argument is expected here and nowhere else.
fn read_element(r: &mut Reader<'_, '_>, e: &js_ast::Expr, in_list_body: bool) -> Node {
    let Some(call) = jsx_call(e) else {
        return Node::Slot(Expr::Raw(r.expr(e)));
    };
    let loc = loc_of(e);
    let static_children = matches!(&call.target.data,
        E::EImportIdentifier(id) if r.names.name(id.ref_).starts_with("jsxs"));
    let (Some(tag), Some(props)) = (call.args.first(), call.args.get(1)) else {
        return Node::Slot(Expr::Raw(r.opaque(e, "jsx call shape")));
    };
    if let Some(key) = call.args.get(2)
        && !in_list_body
    {
        r.diagnostics.push(Diagnostic::warning(
            "key-outside-list",
            "`key` on an element that is not the body of a list has no effect",
            loc_of(key),
            "remove the key",
        ));
    }
    let tag = tag_of(r, tag);
    if matches!(tag, Tag::Outlet) {
        return Node::Outlet;
    }
    if matches!(tag, Tag::Member) {
        r.diagnostics.push(Diagnostic::fallback(
            "member-tag",
            "member-expression component tags (`<Ctx.Provider>`) are not supported natively",
            loc,
            "import the component under its own name",
        ));
    }
    let E::EObject(obj) = &props.data else {
        return Node::Slot(Expr::Raw(r.opaque(e, "jsx props")));
    };

    let mut attrs = Vec::new();
    let mut props_out = Vec::new();
    let mut children = Vec::new();
    let mut ref_name = None;
    for p in obj.properties.iter() {
        let Some(value) = &p.value else { continue };
        if matches!(p.kind, js_ast::G::PropertyKind::Spread) {
            r.diagnostics.push(Diagnostic::fallback(
                "spread-props",
                "spread props cannot be expanded by the template backend",
                loc_of(value),
                "list the props explicitly",
            ));
            let raw = r.opaque(value, "spread props");
            match tag {
                Tag::Host(_) => attrs.push(Attr::Spread(Expr::Raw(raw))),
                _ => props_out.push(("...".to_string(), Expr::Raw(raw))),
            }
            continue;
        }
        let Some(key) = &p.key else { continue };
        let E::EString(k) = &key.data else { continue };
        let name = estring(k);
        // The parser synthesises the `children` key at the element's own
        // location; an author-written `children={…}` attribute has its own.
        if name == "children" && key.loc.start == e.loc.start {
            children = read_children(r, value, static_children);
            continue;
        }
        if name == "children" {
            r.diagnostics.push(Diagnostic::fallback(
                "children-prop",
                "`children` passed as an attribute is not supported natively",
                loc_of(key),
                "pass children between the tags",
            ));
        }
        match tag {
            Tag::Host(_) => {
                if let Some(attr) = read_attr(r, &name, value, &mut ref_name) {
                    attrs.push(attr);
                }
            }
            _ => {
                let v = r.expr(value);
                props_out.push((name, Expr::Raw(v)));
            }
        }
    }

    match tag {
        Tag::Host(tag) => Node::Element {
            loc,
            tag,
            attrs,
            children,
            host: false,
            ref_name,
        },
        Tag::Fragment => Node::Fragment(children),
        Tag::Outlet => Node::Outlet,
        Tag::Component {
            name,
            source,
            imported,
        } => Node::Component {
            loc,
            name,
            source,
            imported,
            props: props_out,
            children,
            link: None,
            tier: crate::ir::Tier::Pending,
        },
        Tag::Member => Node::Component {
            loc,
            name: "<member>".into(),
            source: None,
            imported: None,
            props: props_out,
            children,
            link: None,
            tier: crate::ir::Tier::Pending,
        },
    }
}

fn read_attr(
    r: &mut Reader<'_, '_>,
    name: &str,
    value: &js_ast::Expr,
    ref_name: &mut Option<String>,
) -> Option<Attr> {
    if name == "ref" {
        if let E::EIdentifier(id) = &value.data {
            let n = r.names.name(id.ref_);
            *ref_name = Some(n.clone());
            return Some(Attr::Ref { name: n });
        }
        r.diagnostics.push(Diagnostic::fallback(
            "ref-shape",
            "`ref` must be a `useRef` binding to be bound natively",
            loc_of(value),
            "pass a ref created with useRef",
        ));
        return Some(Attr::Dynamic {
            name: name.into(),
            value: Expr::Raw(r.expr(value)),
        });
    }
    if name == "dangerouslySetInnerHTML" {
        r.diagnostics.push(Diagnostic::error(
            "no-innerhtml",
            "dangerouslySetInnerHTML is not supported",
            loc_of(value),
            "render the markup as elements, or move this component to React",
        ));
    }
    if let Some(event) = event_name(name) {
        if name.ends_with("Capture") {
            r.diagnostics.push(Diagnostic::fallback(
                "event-capture",
                format!("`{name}` listens in the capture phase, which directives do not support"),
                loc_of(value),
                "use the bubbling handler, or move this component to React",
            ));
        }
        return Some(Attr::Event {
            event,
            handler: hoist_handler(r, value),
        });
    }
    Some(match &value.data {
        E::EString(s) => Attr::Static {
            name: name.into(),
            value: estring(s),
        },
        E::EBoolean(b) if b.value => Attr::Static {
            name: name.into(),
            value: String::new(),
        },
        _ => Attr::Dynamic {
            name: name.into(),
            value: Expr::Raw(r.expr(value)),
        },
    })
}

/// The DOM event a React `on*` prop listens to (F16): mostly the lowercased
/// name, except where React's synthetic event differs. `onchange`, `on` and
/// `once` are not events. `onChange` stays `change`; the template backend makes
/// it `input` on text-like fields, as React does.
fn event_name(attr: &str) -> Option<String> {
    let rest = attr.strip_prefix("on")?;
    if !rest.starts_with(|c: char| c.is_ascii_uppercase()) {
        return None;
    }
    let base = rest.strip_suffix("Capture").unwrap_or(rest);
    Some(
        match base {
            "DoubleClick" => "dblclick",
            // React's focus events bubble: they are focusin / focusout.
            "Focus" => "focusin",
            "Blur" => "focusout",
            other => return Some(other.to_ascii_lowercase()),
        }
        .to_string(),
    )
}

/// A handler bound to a local name (a `useCallback` or a local function) keeps
/// that name; anything else is hoisted to `_hN` in encounter order.
fn hoist_handler(r: &mut Reader<'_, '_>, value: &js_ast::Expr) -> String {
    let body = r.expr(value);
    if let RawKind::Ident {
        name,
        kind: IdentKind::Local,
    } = &body.kind
    {
        return name.clone();
    }
    let name = format!("_h{}", r.pending_handlers.len() + 1);
    r.pending_handlers.push(HandlerDecl {
        name: name.clone(),
        body,
        item_scoped: r.loop_scope.clone(),
    });
    name
}

/// The `children` value: an array of children for `jsxs`, one child for `jsx`.
fn read_children(r: &mut Reader<'_, '_>, value: &js_ast::Expr, many: bool) -> Vec<Node> {
    let mut out = Vec::new();
    match (&value.data, many) {
        (E::EArray(a), true) => {
            for item in a.items.iter() {
                read_child(r, item, &mut out);
            }
        }
        _ => read_child(r, value, &mut out),
    }
    out
}

/// Reads the JSX body of a `.map` callback in any position (not only as a
/// direct child), where a `key` belongs.
pub fn read_list_body(r: &mut Reader<'_, '_>, e: &js_ast::Expr) -> Node {
    read_element(r, e, true)
}

pub fn is_jsx(e: &js_ast::Expr) -> bool {
    jsx_call(e).is_some()
}

fn read_child(r: &mut Reader<'_, '_>, e: &js_ast::Expr, out: &mut Vec<Node>) {
    match &e.data {
        E::EString(s) => out.push(Node::Text(estring(s))),
        E::ENull(_) | E::EUndefined(_) | E::EBoolean(_) => {}
        E::ECall(c) if c.was_jsx_element => out.push(read_element(r, e, false)),
        E::EBinary(b) if b.op == OpCode::BinLogicalAnd && is_jsx(&b.right) => {
            let cond = Expr::Raw(r.expr(&b.left));
            let mut then = Vec::new();
            read_child(r, &b.right, &mut then);
            out.push(Node::If {
                cond,
                then,
                else_: Vec::new(),
            });
        }
        E::EIf(i) if is_jsx(&i.yes) || is_jsx(&i.no) => {
            let cond = Expr::Raw(r.expr(&i.test));
            let mut then = Vec::new();
            read_child(r, &i.yes, &mut then);
            let mut else_ = Vec::new();
            read_child(r, &i.no, &mut else_);
            out.push(Node::If { cond, then, else_ });
        }
        E::ECall(c) => match read_list(r, c) {
            Some(node) => out.push(node),
            None => out.push(Node::Slot(Expr::Raw(r.expr(e)))),
        },
        _ => out.push(Node::Slot(Expr::Raw(r.expr(e)))),
    }
}

/// A path rooted at a props binding (JSON props are arrays or plain values) or an object literal
/// (the `{ length: n }` range). A state, derived, local or module root may hold a Set or Map.
fn array_source_ok(r: &Reader<'_, '_>, e: &js_ast::Expr) -> bool {
    match &e.data {
        E::EIdentifier(id) => matches!(r.names.kind_of(id.ref_).1, IdentKind::Prop),
        E::EImportIdentifier(id) => matches!(r.names.kind_of(id.ref_).1, IdentKind::Prop),
        E::EObject(_) => true,
        E::EDot(d) => d.optional_chain.is_none() && array_source_ok(r, &d.target),
        _ => false,
    }
}

/// `source.map((item, index?) => <jsx key={…}/>)` and `Array.from(source, (item, index?) => <jsx key={…}/>)`
/// → `For`. `None` when the call is not that shape (it is then read as a plain slot).
fn read_list(r: &mut Reader<'_, '_>, call: &js_ast::E::Call) -> Option<Node> {
    let E::EDot(dot) = &call.target.data else {
        return None;
    };
    if dot.optional_chain.is_some() {
        return None;
    }
    // (the source expression, `Array.from` callee when that form, the callback)
    let (src_expr, from_callee, arrow) = if dot.name.slice() == b"map" && call.args.len() == 1 {
        let E::EArrow(arrow) = &call.args[0].data else {
            return None;
        };
        (&dot.target, None, arrow)
    } else if dot.name.slice() == b"from"
        && call.args.len() == 2
        && matches!(&dot.target.data, E::EIdentifier(id) if r.names.name(id.ref_) == "Array" && matches!(r.names.kind_of(id.ref_).1, IdentKind::Global))
    {
        // F40: `Array.from(xs, fn)` is the same list as `xs.map(fn)`; the `{ length: n }`
        // range keeps the `Array.from({ length: n })` source the template subset knows.
        let E::EArrow(arrow) = &call.args[1].data else {
            return None;
        };
        (&call.args[0], Some(&call.target), arrow)
    } else {
        return None;
    };
    let params = arrow.args.slice();
    if params.is_empty() || params.len() > 2 || arrow.is_async {
        return None;
    }
    let mut bindings = Vec::new();
    for p in params {
        match p.binding.data {
            B::BIdentifier(id) if p.default.is_none() => bindings.push(id.r#ref),
            _ => return None,
        }
    }
    let [only] = arrow.body.stmts.slice() else {
        return None;
    };
    let S::SReturn(ret) = &only.data else {
        return None;
    };
    let body_expr = ret.value?;
    let body_call = jsx_call(&body_expr)?;

    // `Array.from` iterates any iterable (Set, string, generator); only a props/local path or a
    // `{ length: n }` range is known to be an array the template can iterate.
    if from_callee.is_some() && !array_source_ok(r, src_expr) {
        return None;
    }
    let first = r.expr(src_expr);
    let source = Expr::Raw(match (from_callee, &first.kind) {
        (Some(callee), RawKind::Object(_)) => RawExpr {
            loc: first.loc,
            kind: RawKind::Call {
                callee: Box::new(r.expr(callee)),
                args: vec![first],
            },
        },
        _ => first,
    });
    let item = r.names.name(bindings[0]);
    let index = bindings.get(1).map(|b| r.names.name(*b));
    for b in &bindings {
        r.names.mark_loop_binding(*b);
    }
    r.loop_scope.push(item.clone());
    if let Some(i) = &index {
        r.loop_scope.push(i.clone());
    }
    let key = match body_call.args.get(2) {
        Some(k) => Expr::Raw(r.expr(k)),
        None => {
            r.diagnostics.push(Diagnostic::error(
                "list-key",
                "list items need a `key`",
                loc_of(&body_expr),
                "add key={item.id} (a stable id) to the element returned by .map",
            ));
            Expr::Raw(RawExpr {
                loc: loc_of(&body_expr),
                kind: RawKind::Lit(crate::ir::Literal::Undefined),
            })
        }
    };
    let body = vec![read_element(r, &body_expr, true)];
    r.loop_scope.truncate(r.loop_scope.len() - bindings.len());
    for b in &bindings {
        r.names.unmark_loop_binding(*b);
    }
    Some(Node::For {
        source,
        item,
        index,
        key,
        body,
    })
}
