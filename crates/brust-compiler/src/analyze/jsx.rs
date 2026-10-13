//! Reads the parser's lowered JSX (`jsx`/`jsxs(tag, props[, key])` calls with
//! `was_jsx_element`) back into template `Node`s. The parser has already applied
//! JSX whitespace collapsing and entity decoding to text children.
use crate::analyze::expr::{Reader, estring, loc_of};
use crate::ir::template::VOID;
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
    let mut children_prop = false;
    for p in obj.properties.iter() {
        let Some(value) = &p.value else { continue };
        if matches!(p.kind, js_ast::G::PropertyKind::Spread) {
            match spread_source(r, value) {
                // An object literal is a known shape here: its entries are ordinary attributes
                // and props, read as if written one by one (React: later wins, which the
                // lowering applies to the merged list, `lower::template::merge_attrs`).
                Spread::Literal(entries) => {
                    for (name, v) in entries {
                        // Object keys are any string, unlike JSX attribute names (R34.17).
                        if matches!(tag, Tag::Host(_)) && !brust_jinja::spread::attr_name_ok(&name)
                        {
                            r.diagnostics.push(Diagnostic::warning(
                                "unsafe-attr",
                                format!("`{name}` in a spread is not a valid attribute name; it is not rendered"),
                                loc_of(v),
                                "use attribute names only",
                            ));
                            continue;
                        }
                        // `key` is never a prop; `children` from a spread is not read natively.
                        if name == "key" {
                            continue;
                        }
                        if name == "children" {
                            r.diagnostics.push(Diagnostic::fallback(
                                "children-prop",
                                "`children` passed in a spread object is not supported natively",
                                loc_of(v),
                                "pass children between the tags",
                            ));
                            continue;
                        }
                        match tag {
                            Tag::Host(_) => {
                                if let Some(attr) = read_attr(r, &name, v, &mut ref_name) {
                                    attrs.push(attr);
                                }
                            }
                            _ => props_out.push((name, Expr::Raw(r.expr(v)))),
                        }
                    }
                }
                Spread::Props(raw) => match tag {
                    Tag::Host(_) => attrs.push(Attr::Spread(Expr::Raw(raw))),
                    _ => props_out.push((crate::ir::SPREAD_KEY.to_string(), Expr::Raw(raw))),
                },
                Spread::Other => {
                    r.diagnostics.push(Diagnostic::fallback(
                        "spread-props",
                        "only the props object, its `...rest`, a props path or an object literal can be spread natively",
                        loc_of(value),
                        "spread props (or a props path), or list the attributes explicitly",
                    ));
                    let raw = r.opaque(value, "spread props");
                    match tag {
                        Tag::Host(_) => attrs.push(Attr::Spread(Expr::Raw(raw))),
                        _ => props_out.push((crate::ir::SPREAD_KEY.to_string(), Expr::Raw(raw))),
                    }
                }
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
            children_prop = true;
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

    if let Tag::Host(tag) = &tag
        && attrs.iter().any(|a| matches!(a, Attr::InnerHtml { .. }))
    {
        // React throws on both: one of `children` / `dangerouslySetInnerHTML`, and none on a void element.
        if !children.is_empty() || children_prop {
            r.diagnostics.push(Diagnostic::error(
                "innerhtml-children",
                "an element cannot have both children and dangerouslySetInnerHTML",
                loc,
                "drop the children, or put the markup in __html",
            ));
        }
        if VOID.contains(&tag.as_str()) {
            r.diagnostics.push(Diagnostic::error(
                "innerhtml-void",
                format!("<{tag}> is a void element and cannot take dangerouslySetInnerHTML"),
                loc,
                "set dangerouslySetInnerHTML on a container element",
            ));
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
            synthetic: false,
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

/// What a JSX spread spreads (shadcn S1.2, R34.15).
enum Spread<'e> {
    /// `{...{ a: 1, 'data-x': v }}`: the entries, in order (keys are plain strings).
    Literal(Vec<(String, &'e js_ast::Expr)>),
    /// The whole props object, its `...rest`, or a props path: keys known only per call site
    /// (an inlined instance) or at render (`spread_attrs`).
    Props(RawExpr),
    /// Anything else (a local object, a call, state): not expanded.
    Other,
}

fn spread_source<'e>(r: &mut Reader<'_, '_>, value: &'e js_ast::Expr) -> Spread<'e> {
    match &value.data {
        E::EIdentifier(id) if r.names.is_rest(id.ref_) => Spread::Props(RawExpr {
            loc: loc_of(value),
            kind: RawKind::Ident {
                name: crate::ir::REST_PROPS.into(),
                kind: IdentKind::Prop,
            },
        }),
        E::EObject(obj) => {
            let mut entries = Vec::new();
            for p in obj.properties.iter() {
                let (Some(k), Some(v)) = (&p.key, &p.value) else {
                    return Spread::Other;
                };
                let E::EString(k) = &k.data else {
                    return Spread::Other;
                };
                if !matches!(p.kind, js_ast::G::PropertyKind::Normal)
                    || p.flags.contains(js_ast::flags::Property::IsComputed)
                {
                    return Spread::Other;
                }
                entries.push((estring(k), v));
            }
            Spread::Literal(entries)
        }
        _ => {
            let raw = r.expr(value);
            if crate::analyze::passes::deps::prop_path(&raw).is_some() {
                Spread::Props(raw)
            } else {
                Spread::Other
            }
        }
    }
}

fn read_attr(
    r: &mut Reader<'_, '_>,
    name: &str,
    value: &js_ast::Expr,
    ref_name: &mut Option<String>,
) -> Option<Attr> {
    // Bun inlines a literal spread (`{...{ 'a b': 1 }}`) into the props object, so an attribute
    // name here can be any string: one that is not an attribute name is never printed (R34.17).
    if !brust_jinja::spread::attr_name_ok(name) {
        r.diagnostics.push(Diagnostic::warning(
            "unsafe-attr",
            format!("`{name}` is not a valid attribute name; it is not rendered"),
            loc_of(value),
            "use attribute names only",
        ));
        return None;
    }
    // `key` from an inlined spread is React's element key, never an attribute.
    if name == "key" {
        return None;
    }
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
    if name.to_ascii_lowercase().starts_with("x-") {
        r.diagnostics.push(Diagnostic::warning(
            "reserved-attr",
            format!("`{name}` attributes are reserved for brust's runtime and are not rendered"),
            loc_of(value),
            "rename it (`data-x-…`) or move this component to React",
        ));
        return None;
    }
    if name == "dangerouslySetInnerHTML" {
        return read_inner_html(r, value);
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

/// `dangerouslySetInnerHTML={{ __html: v }}` (React's contract): the attribute
/// carries `v`. An object literal is unwrapped at compile time; any other
/// expression `o` reads `o.__html` (null-safe: `o` may be absent).
fn read_inner_html(r: &mut Reader<'_, '_>, value: &js_ast::Expr) -> Option<Attr> {
    let raw = r.expr(value);
    let inner = match raw.kind {
        RawKind::Object(props) => {
            let Some((_, html)) = props.into_iter().find(|(k, _)| k == "__html") else {
                r.diagnostics.push(Diagnostic::error(
                    "innerhtml-shape",
                    "dangerouslySetInnerHTML needs an object with an `__html` key",
                    loc_of(value),
                    "pass `{ __html: markup }`",
                ));
                return None;
            };
            html
        }
        kind => RawExpr {
            loc: raw.loc,
            kind: RawKind::Member {
                target: Box::new(RawExpr { loc: raw.loc, kind }),
                name: "__html".into(),
                optional: true,
            },
        },
    };
    Some(Attr::InnerHtml {
        value: Expr::Raw(inner),
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
    let mut nodes = read_list_arms(r, e);
    if nodes.len() == 1 {
        nodes.remove(0)
    } else {
        Node::Fragment(nodes)
    }
}

/// `.map` callback body: JSX, `c ? A : B` or `c && A`, recursively, every leaf JSX or
/// `null` / `undefined` / `false`, at least one JSX (L6 / G6).
pub fn is_list_body(e: &js_ast::Expr) -> bool {
    fn arms(e: &js_ast::Expr, jsx: &mut bool) -> bool {
        match &e.data {
            E::ECall(c) if c.was_jsx_element => {
                *jsx = true;
                true
            }
            E::ENull(_) | E::EUndefined(_) => true,
            E::EBoolean(b) => !b.value,
            E::EIf(i) => arms(&i.yes, jsx) && arms(&i.no, jsx),
            E::EBinary(b) if b.op == OpCode::BinLogicalAnd => arms(&b.right, jsx),
            _ => false,
        }
    }
    let mut jsx = false;
    arms(e, &mut jsx) && jsx
}

/// The nodes of one `.map` body arm; the callback's `key` belongs to the element arms.
fn read_list_arms(r: &mut Reader<'_, '_>, e: &js_ast::Expr) -> Vec<Node> {
    match &e.data {
        E::EIf(i) => {
            let cond = Expr::Raw(r.expr(&i.test));
            let then = read_list_arms(r, &i.yes);
            let else_ = read_list_arms(r, &i.no);
            vec![Node::If { cond, then, else_ }]
        }
        E::EBinary(b) if b.op == OpCode::BinLogicalAnd => {
            let cond = Expr::Raw(r.expr(&b.left));
            let then = read_list_arms(r, &b.right);
            vec![Node::If {
                cond,
                then,
                else_: Vec::new(),
            }]
        }
        E::ECall(c) if c.was_jsx_element => vec![read_element(r, e, true)],
        _ => Vec::new(),
    }
}

/// The list key of a body: the same key in both arms is that key, different keys are
/// `test ? a : b`, a keyed arm beside a null arm is that arm's key (R6.1). An element arm
/// without a key is a `list-key` error at that arm.
fn list_arm_key(r: &mut Reader<'_, '_>, e: &js_ast::Expr) -> Option<RawExpr> {
    let undefined = |loc| RawExpr {
        loc,
        kind: RawKind::Lit(crate::ir::Literal::Undefined),
    };
    match &e.data {
        E::EIf(i) => {
            let yes = list_arm_key(r, &i.yes);
            let no = list_arm_key(r, &i.no);
            let loc = loc_of(&i.test);
            match (yes, no) {
                // Compared by the code they print: the two arms sit at different locations.
                (Some(a), Some(b)) if a.to_js() == b.to_js() => Some(a),
                (Some(a), Some(b)) => Some(RawExpr {
                    loc,
                    kind: RawKind::Cond {
                        test: Box::new(r.expr(&i.test)),
                        yes: Box::new(a),
                        no: Box::new(b),
                    },
                }),
                // The client evaluates the key for every row, so a key that only exists in
                // one arm is guarded by that arm's condition.
                (Some(a), None) => Some(RawExpr {
                    loc,
                    kind: RawKind::Cond {
                        test: Box::new(r.expr(&i.test)),
                        yes: Box::new(a),
                        no: Box::new(undefined(loc)),
                    },
                }),
                (None, Some(b)) => Some(RawExpr {
                    loc,
                    kind: RawKind::Cond {
                        test: Box::new(r.expr(&i.test)),
                        yes: Box::new(undefined(loc)),
                        no: Box::new(b),
                    },
                }),
                (None, None) => None,
            }
        }
        E::EBinary(b) if b.op == OpCode::BinLogicalAnd => {
            let k = list_arm_key(r, &b.right)?;
            let loc = loc_of(&b.left);
            Some(RawExpr {
                loc,
                kind: RawKind::Cond {
                    test: Box::new(r.expr(&b.left)),
                    yes: Box::new(k),
                    no: Box::new(undefined(loc)),
                },
            })
        }
        E::ECall(c) if c.was_jsx_element => match c.args.get(2) {
            Some(k) => Some(r.expr(k)),
            None => {
                r.diagnostics.push(Diagnostic::error(
                    "list-key",
                    "list items need a `key`",
                    loc_of(e),
                    "add key={item.id} (a stable id) to the element returned by .map",
                ));
                Some(RawExpr {
                    loc: loc_of(e),
                    kind: RawKind::Lit(crate::ir::Literal::Undefined),
                })
            }
        },
        _ => None,
    }
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
        E::ECall(c) => match read_list(r, e, c) {
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
fn read_list(r: &mut Reader<'_, '_>, e: &js_ast::Expr, call: &js_ast::E::Call) -> Option<Node> {
    let E::EDot(dot) = &call.target.data else {
        return None;
    };
    let is_map = dot.name.slice() == b"map" && call.args.len() == 1;
    // A `.map` over data (no JSX in the callback) is an ordinary expression, never a list shape.
    let has_jsx = |arrow: &js_ast::E::Arrow| {
        let mut w = crate::analyze::expr::Walk::default();
        w.stmts(arrow.body.stmts.slice());
        w.calls
            .iter()
            .any(|c| matches!(&c.data, E::ECall(c) if c.was_jsx_element))
    };
    let shape = |r: &mut Reader<'_, '_>, why: &str, arrow: &js_ast::E::Arrow| {
        if !has_jsx(arrow) {
            return None;
        }
        r.diagnostics.push(Diagnostic::fallback(
            "list-shape",
            format!("the list is not a supported shape: {why}"),
            loc_of(e),
            "return one JSX expression from a `(item, index?) => …` callback over an array path",
        ));
        None
    };
    if dot.optional_chain.is_some() {
        return match &call.args.first().map(|a| &a.data) {
            Some(E::EArrow(arrow)) if is_map => {
                shape(r, "`?.map` over a possibly missing list", arrow)
            }
            _ => None,
        };
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
            _ => {
                return shape(
                    r,
                    "a `.map` callback parameter is a pattern or has a default",
                    arrow,
                );
            }
        }
    }
    let block = || "a `.map` callback has a block body; return one JSX expression";
    let [only] = arrow.body.stmts.slice() else {
        return shape(r, block(), arrow);
    };
    let S::SReturn(ret) = &only.data else {
        return shape(r, block(), arrow);
    };
    let body_expr = ret.value?;
    if !is_list_body(&body_expr) {
        return None;
    }

    // `Array.from` iterates any iterable (Set, string, generator); only a props/local path or a
    // `{ length: n }` range is known to be an array the template can iterate.
    if from_callee.is_some() && !array_source_ok(r, src_expr) {
        return shape(
            r,
            "`Array.from` over a source that is not a props path or a `{ length: n }` range",
            arrow,
        );
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
    let key = Expr::Raw(list_arm_key(r, &body_expr).unwrap_or(RawExpr {
        loc: loc_of(&body_expr),
        kind: RawKind::Lit(crate::ir::Literal::Undefined),
    }));
    let body = read_list_arms(r, &body_expr);
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
