//! Reads the parser's lowered JSX (`jsx`/`jsxs(tag, props[, key])` calls with
//! `was_jsx_element`) back into template `Node`s. The parser has already applied
//! JSX whitespace collapsing and entity decoding to text children.
use crate::analyze::expr::{Reader, estring, loc_of};
use crate::analyze::names::{MemberRef, member_of};
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
    /// `<DialogPrimitive.Root>` or an alias of it: a member of an import from a package (R34.35).
    Imported {
        name: String,
        m: MemberRef,
    },
    /// Any other member tag; the text says why it is not resolved.
    Member(&'static str),
    /// `Outlet` imported from `@brust/core/routes` (S8).
    Outlet,
    /// A context Provider (`<XProvider>` of Radix's `createContextScope`, or React's `<C.Provider>`): transparent, it
    /// hands its value fields to the consumers under it (S2, R34.102).
    Provider {
        ctx: String,
        react: bool,
    },
}

fn tag_ref(tag: &js_ast::Expr) -> Option<js_ast::Ref> {
    match &tag.data {
        E::EIdentifier(js_ast::E::Identifier { ref_ })
        | E::EImportIdentifier(js_ast::E::ImportIdentifier { ref_ }) => Some(*ref_),
        _ => None,
    }
}

/// A hand-written call to React's JSX runtime (`jsx(…)`, `jsxs(…)`, `jsxDEV(…)`, also aliased or through a
/// namespace import) that is not a lowered JSX element: what compiled-JS packages contain (shadcn S3, R34.67).
/// It builds an element object the reader cannot see through, so the component must not be read as static.
/// Returns the location of the first one.
pub fn jsx_runtime_call(
    calls: &[js_ast::Expr],
    used_at: &[(js_ast::Ref, i32)],
    names: &crate::analyze::names::NameTable<'_>,
) -> Option<u32> {
    const RUNTIMES: [&str; 2] = ["react/jsx-runtime", "react/jsx-dev-runtime"];
    const FNS: [&str; 3] = ["jsx", "jsxs", "jsxDEV"];
    let import = |r: js_ast::Ref| names.import_of(r).filter(|(s, _)| RUNTIMES.contains(s));
    for c in calls {
        let E::ECall(call) = &c.data else { continue };
        if call.was_jsx_element {
            continue;
        }
        let hit = match &call.target.data {
            E::EIdentifier(id) => import(id.ref_).is_some_and(|(_, i)| FNS.contains(&i)),
            E::EImportIdentifier(id) => import(id.ref_).is_some_and(|(_, i)| FNS.contains(&i)),
            // `import * as R from 'react/jsx-runtime'; R.jsx(…)`
            E::EDot(d) => {
                let base = match &d.target.data {
                    E::EIdentifier(id) => Some(id.ref_),
                    E::EImportIdentifier(id) => Some(id.ref_),
                    _ => None,
                };
                base.is_some_and(|b| import(b).is_some_and(|(_, i)| i == "*"))
                    && FNS.contains(&String::from_utf8_lossy(d.name.slice()).as_ref())
            }
            _ => false,
        };
        if hit {
            return Some(loc_of(c));
        }
    }
    // F156: a builder, or the namespace / default import that carries one, read as a value anywhere else
    // (`const h = jsx; h(…)`, `(0, jsx)(…)`, `call(R.jsx)`) can build an element through any spelling: fail closed.
    used_at
        .iter()
        .find(|(r, _)| {
            import(*r).is_some_and(|(_, i)| FNS.contains(&i) || i == "*" || i == "default")
        })
        .map(|(_, at)| (*at).max(0) as u32)
}

fn tag_of(r: &Reader<'_, '_>, tag: &js_ast::Expr) -> Tag {
    match &tag.data {
        E::EString(s) => Tag::Host(estring(s)),
        E::EIdentifier(js_ast::E::Identifier { ref_ })
        | E::EImportIdentifier(js_ast::E::ImportIdentifier { ref_ }) => {
            if r.names.is_fragment(*ref_) {
                return Tag::Fragment;
            }
            if let Some(m) = r.names.member_alias_of(*ref_) {
                return Tag::Imported {
                    name: r.names.name(*ref_),
                    m: m.clone(),
                };
            }
            if r.names.import_of(*ref_) == Some(("@brust/core/routes", "Outlet")) {
                return Tag::Outlet;
            }
            if r.names.react_context(*ref_).is_none()
                && let Some(ctx) = r.names.context_of_provider(*ref_)
            {
                return Tag::Provider {
                    ctx: ctx.to_string(),
                    react: false,
                };
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
        // `<C.Provider>` of a React context declared in this module.
        E::EDot(d)
            if d.name.slice() == b"Provider"
                && let Some(x) = crate::analyze::names::ident_ref(&d.target)
                && let Some(ctx) = r.names.react_context(x) =>
        {
            Tag::Provider {
                ctx: ctx.to_string(),
                react: true,
            }
        }
        E::EDot(d) => {
            let imp = |x: js_ast::Ref| {
                r.names
                    .import_of(x)
                    .map(|(s, i)| (s.to_string(), i.to_string()))
            };
            if let Some(m) = member_of(tag, imp) {
                let base = match &d.target.data {
                    E::EIdentifier(id) => id.ref_,
                    E::EImportIdentifier(id) => id.ref_,
                    _ => unreachable!("member_of read an identifier target"),
                };
                return Tag::Imported {
                    name: format!("{}.{}", r.names.name(base), m.member[0]),
                    m,
                };
            }
            let target_ref = match &d.target.data {
                E::EIdentifier(id) => Some(id.ref_),
                E::EImportIdentifier(id) => Some(id.ref_),
                _ => None,
            };
            Tag::Member(match (&d.target.data, target_ref) {
                (E::EDot(_), _) => {
                    "a member tag deeper than one level (`<A.B.C>`) is not resolved; import the component by name"
                }
                (_, Some(x)) if r.names.import_of(x).is_some() => {
                    "a member of a module imported from a relative path or from react is not resolved; import the component by name"
                }
                (_, Some(_)) => {
                    "a member of a local object (`<Ctx.Provider>`, a context provider) is not supported natively; context components are the context lane"
                }
                _ => "a computed member tag is not supported natively",
            })
        }
        _ => Tag::Member("a member tag is not supported natively"),
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
    let mut tag = tag_of(r, tag);
    // R34.28: `<Comp>` of `const Comp = asChild ? Slot.Root : "button"` is the host element; the
    // call site of the component resolves `asChild`.
    let mut poly = false;
    if let Some(ref_) = tag_ref(&call.args[0])
        && let Some(p) = r.names.poly_of(ref_)
    {
        tag = Tag::Host(p.host.clone());
        poly = true;
    }
    if matches!(tag, Tag::Outlet) {
        return Node::Outlet;
    }
    if let Tag::Member(why) = &tag {
        r.diagnostics.push(Diagnostic::fallback(
            "member-tag",
            *why,
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
    // The names a union spread has joined into one attribute or prop each (a later own one replaces it).
    let mut union_names: Vec<String> = Vec::new();
    let mut children_prop = false;
    let mut forwarded_ref = false;
    for p in obj.properties.iter() {
        let Some(value) = &p.value else { continue };
        if matches!(p.kind, js_ast::G::PropertyKind::Spread) {
            match spread_source(r, value, matches!(tag, Tag::Host(_))) {
                // An object literal is a known shape here: its entries are ordinary attributes
                // and props, read as if written one by one (React: later wins, which the
                // lowering applies to the merged list, `lower::template::merge_attrs`).
                Spread::Literal(entries) => {
                    for (name, v) in entries {
                        let v = &v;
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
                                if let Some(attr) =
                                    read_attr(r, &name, v, &mut ref_name, is_custom(&tag))
                                {
                                    attrs.push(attr);
                                }
                            }
                            _ => props_out.push((name, Expr::Raw(r.expr(v)))),
                        }
                    }
                }
                Spread::Union(u) => {
                    let mut keys = Vec::new();
                    u.keys(&mut keys);
                    if keys.len() > UNION_MAX_KEYS {
                        r.diagnostics
                            .push(union_refused(value, "has too many keys"));
                        let raw = r.opaque(value, "spread props");
                        match tag {
                            Tag::Host(_) => attrs.push(Attr::Spread(Expr::Raw(raw))),
                            _ => {
                                props_out.push((crate::ir::SPREAD_KEY.to_string(), Expr::Raw(raw)))
                            }
                        }
                        continue;
                    }
                    for name in keys {
                        let host = matches!(tag, Tag::Host(_));
                        // As for an object literal: `key` is React's, `children` is not read, and a key that is not
                        // an attribute name is not rendered (R34.17).
                        if name == "key" {
                            continue;
                        }
                        if name == "children" {
                            r.diagnostics.push(Diagnostic::fallback(
                                "children-prop",
                                "`children` passed in a spread object is not supported natively",
                                loc_of(value),
                                "pass children between the tags",
                            ));
                            continue;
                        }
                        if host && !brust_jinja::spread::attr_name_ok(&name) {
                            r.diagnostics.push(Diagnostic::warning(
                                "unsafe-attr",
                                format!("`{name}` in a spread is not a valid attribute name; it is not rendered"),
                                loc_of(value),
                                "use attribute names only",
                            ));
                            continue;
                        }
                        // An earlier attribute (or prop) of this name is what a branch without the key leaves in
                        // place, and the joined value takes its position (a later key wins, the first keeps its place).
                        let earlier = if host {
                            attrs.iter().position(|a| match a {
                                Attr::Static { name: n, .. } => *n == name,
                                Attr::Dynamic {
                                    name: n,
                                    value: Expr::Raw(_),
                                } => *n == name,
                                _ => false,
                            })
                        } else {
                            props_out
                                .iter()
                                .position(|(n, v)| *n == name && matches!(v, Expr::Raw(_)))
                        };
                        let absent = match earlier {
                            Some(i) if host => match &attrs[i] {
                                Attr::Static { value, .. } => RawExpr {
                                    loc: 0,
                                    kind: RawKind::Lit(crate::ir::Literal::Str(value.clone())),
                                },
                                Attr::Dynamic {
                                    value: Expr::Raw(raw),
                                    ..
                                } => raw.clone(),
                                _ => unreachable!(),
                            },
                            Some(i) => match &props_out[i].1 {
                                Expr::Raw(raw) => raw.clone(),
                                _ => unreachable!(),
                            },
                            None => RawExpr {
                                loc: 0,
                                kind: RawKind::Lit(crate::ir::Literal::Undefined),
                            },
                        };
                        let mut failed = false;
                        let joined = u.value(&name, &absent, &mut |v| {
                            let raw = if host {
                                read_union_attr(r, &name, v, &mut ref_name)
                            } else if union_key_refused(&name) {
                                // The child may spread these onto an element, where they are not a plain value
                                // (a handler that may be undefined, raw HTML, a ref, a style object): same refusal.
                                None
                            } else {
                                Some(r.expr(v))
                            };
                            if raw.is_none() {
                                failed = true;
                            }
                            raw
                        });
                        match joined {
                            Some(raw) if !failed => {
                                union_names.push(name.clone());
                                match (host, earlier) {
                                    (true, Some(i)) => {
                                        attrs[i] = Attr::Dynamic {
                                            name,
                                            value: Expr::Raw(raw),
                                        }
                                    }
                                    (true, None) => attrs.push(Attr::Dynamic {
                                        name,
                                        value: Expr::Raw(raw),
                                    }),
                                    (false, Some(i)) => props_out[i].1 = Expr::Raw(raw),
                                    (false, None) => props_out.push((name, Expr::Raw(raw))),
                                }
                            }
                            _ => {
                                r.diagnostics.push(union_refused(
                                    value,
                                    &format!(
                                        "gives `{name}` a value that is not a plain attribute value"
                                    ),
                                ));
                                let raw = r.opaque(value, "spread props");
                                match tag {
                                    Tag::Host(_) => attrs.push(Attr::Spread(Expr::Raw(raw))),
                                    _ => props_out
                                        .push((crate::ir::SPREAD_KEY.to_string(), Expr::Raw(raw))),
                                }
                                break;
                            }
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
                if let Some(attr) = read_attr(r, &name, value, &mut ref_name, is_custom(&tag)) {
                    // An own attribute after a union spread replaces the joined one (it keeps the first place).
                    let at = union_names.contains(&name).then(|| {
                        attrs
                            .iter()
                            .position(|a| matches!(a, Attr::Dynamic { name: n, .. } if *n == name))
                    });
                    match at.flatten() {
                        Some(i) => attrs[i] = attr,
                        None => attrs.push(attr),
                    }
                }
            }
            _ => {
                // F153c: the component's own forwarded ref passed on (`<Primitive.label ref={forwardedRef}>`); the
                // children pass decides whether the child can take it.
                if name == "ref"
                    && let E::EIdentifier(id) = &value.data
                    && r.names.is_forwarded_ref(id.ref_)
                {
                    r.names.note_forwarded_ref_dropped(value.loc.start);
                    forwarded_ref = true;
                    continue;
                }
                let rendered = if let E::EArrow(arrow) = &value.data
                    && let Some(rp) = read_render_arrow(r, arrow, loc, &name)
                {
                    r.render_props.push(rp);
                    true
                } else {
                    false
                };
                r.verbatim_unused = rendered;
                let v = r.expr(value);
                r.verbatim_unused = false;
                match union_names
                    .contains(&name)
                    .then(|| props_out.iter().position(|(n, _)| *n == name))
                    .flatten()
                {
                    Some(i) => props_out[i].1 = Expr::Raw(v),
                    None => props_out.push((name, Expr::Raw(v))),
                }
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
            poly,
        },
        Tag::Fragment => Node::Fragment(children),
        Tag::Outlet => Node::Outlet,
        Tag::Provider { ctx, react } => {
            read_provider(r, &ctx, react, props_out, loc);
            // Transparent: a Provider around one element is that element (a Fragment of one would make an interactive
            // component's root a `<brust-host>` wrapper that React does not render).
            match <[Node; 1]>::try_from(children) {
                Ok([one @ Node::Element { .. }]) => one,
                Ok([other]) => Node::Fragment(vec![other]),
                Err(children) => Node::Fragment(children),
            }
        }
        Tag::Component {
            name,
            source,
            imported,
        } => Node::Component {
            loc,
            name,
            source,
            imported,
            member: Vec::new(),
            props: props_out,
            children,
            link: None,
            tier: crate::ir::Tier::Pending,
            forwarded_ref,
        },
        Tag::Imported { name, m } => Node::Component {
            loc,
            name,
            source: Some(m.source),
            imported: Some(m.imported),
            member: m.member,
            props: props_out,
            children,
            link: None,
            tier: crate::ir::Tier::Pending,
            forwarded_ref,
        },
        Tag::Member(_) => Node::Component {
            loc,
            name: "<member>".into(),
            source: None,
            imported: None,
            member: Vec::new(),
            props: props_out,
            children,
            link: None,
            tier: crate::ir::Tier::Pending,
            forwarded_ref,
        },
    }
}

/// B7: `render={({ a, b }) => <jsx/>}` (or `render={() => <jsx/>}`) on a component, read as a template: the keys the
/// arrow destructures, and its JSX body with those names bound as loop bindings (values the callee supplies). `None`
/// for any other shape (a pattern with a default, a rest, a nested pattern or a computed key; an `async` arrow; a block
/// body; a body that is not JSX; a body that needs a hoisted handler or reports a diagnostic): the prop stays the
/// client-only value it always was.
fn read_render_arrow(
    r: &mut Reader<'_, '_>,
    arrow: &js_ast::E::Arrow,
    loc: u32,
    key: &str,
) -> Option<crate::ir::RenderProp> {
    if arrow.is_async || arrow.args.len() > 1 {
        return None;
    }
    let mut params: Vec<(String, js_ast::Ref)> = Vec::new();
    if let Some(p) = arrow.args.slice().first() {
        if p.default.is_some() {
            return None;
        }
        let B::BObject(obj) = p.binding.data else {
            return None;
        };
        for prop in obj.properties() {
            if prop.flags.contains(js_ast::flags::Property::IsSpread)
                || prop.flags.contains(js_ast::flags::Property::IsComputed)
                || prop.default_value.is_some()
            {
                return None;
            }
            let (E::EString(k), B::BIdentifier(id)) = (&prop.key.data, prop.value.data) else {
                return None;
            };
            params.push((estring(k), id.r#ref));
        }
    }
    let [only] = arrow.body.stmts.slice() else {
        return None;
    };
    let S::SReturn(ret) = &only.data else {
        return None;
    };
    let body_expr = ret.value?;
    if !is_jsx(&body_expr) {
        return None;
    }
    // The body is read a second time (the prop itself stays the client-only value), so nothing it does to the reader
    // may stay: diagnostics, hoisted handlers, `useId` hoists, nested render props and, above all, the Providers it
    // would hand to the CALLER's own children.
    let (diags, handlers) = (r.diagnostics.len(), r.pending_handlers.len());
    let (provides, renders) = (r.provides.len(), r.render_props.len());
    let hoisted = r.hoisted_calls.clone();
    for (_, b) in &params {
        r.names.mark_loop_binding(*b);
        r.loop_scope.push(r.names.name(*b));
    }
    let mut body = Vec::new();
    read_child(r, &body_expr, &mut body);
    r.loop_scope.truncate(r.loop_scope.len() - params.len());
    for (_, b) in &params {
        r.names.unmark_loop_binding(*b);
    }
    // Reading this body again is not allowed to leave anything behind.
    // A Provider in the body would have to scope its consumers to the body: not supported, the prop stays as it was.
    let clean = r.diagnostics.len() == diags
        && r.pending_handlers.len() == handlers
        && r.provides.len() == provides
        && r.hoisted_calls == hoisted;
    r.diagnostics.truncate(diags);
    r.pending_handlers.truncate(handlers);
    r.provides.truncate(provides);
    r.render_props.truncate(renders);
    r.hoisted_calls = hoisted;
    clean.then(|| crate::ir::RenderProp {
        loc,
        key: key.to_string(),
        params: params
            .into_iter()
            .map(|(k, b)| (k, r.names.name(b)))
            .collect(),
        body,
    })
}

/// A Provider element (S2): its value fields are what the consumers under it read. Radix's Provider takes them as
/// props (`scope` is the nesting disambiguation: a pass-through is ignored, R34.101); React's takes one `value`, an
/// object literal (a value that is not one is read whole by consumers, which brust refuses: `context-value`).
fn read_provider(
    r: &mut Reader<'_, '_>,
    ctx: &str,
    react: bool,
    props: Vec<(String, Expr)>,
    loc: u32,
) {
    let mut fields: Vec<(String, RawExpr)> = Vec::new();
    let check = |r: &mut Reader<'_, '_>, k: &str| match crate::analyze::context::field_problem(k) {
        Some(what) => {
            r.diagnostics.push(Diagnostic::fallback(
                "context-shape",
                format!("the context field `{k}` {what}"),
                loc,
                "rename the field to a plain identifier, or keep this component in React",
            ));
            false
        }
        None => true,
    };
    if react {
        let value = props
            .into_iter()
            .find(|(k, _)| k == "value")
            .and_then(|(_, e)| match e {
                Expr::Raw(raw) => Some(raw),
                _ => None,
            });
        match value {
            Some(RawExpr {
                kind: RawKind::Object(entries),
                ..
            }) => {
                for (k, v) in entries {
                    if check(r, &k) {
                        fields.push((k, v));
                    }
                }
            }
            // R34.142: a scalar context's Provider hands out one whole value.
            Some(raw) if r.names.scalar_default(ctx).is_some() => {
                fields.push((crate::analyze::hooks::WHOLE_FIELD.to_string(), raw));
            }
            _ => r.diagnostics.push(Diagnostic::fallback(
                "context-value",
                "a context Provider's `value` is not an object literal with plain keys",
                loc,
                "write value={{ a, b }}, or keep this component in React",
            )),
        }
    } else {
        for (k, e) in props {
            if k == "scope" || k == crate::ir::SPREAD_KEY {
                continue;
            }
            if let Expr::Raw(raw) = e
                && check(r, &k)
            {
                fields.push((k, raw));
            }
        }
    }
    r.provides.push(crate::ir::ProvideDecl {
        context: ctx.to_string(),
        fields,
    });
}

/// What a JSX spread spreads (shadcn S1.2, R34.15).
enum Spread {
    /// `{...{ a: 1, 'data-x': v }}`: the entries, in order (keys are plain strings).
    Literal(Vec<(String, js_ast::Expr)>),
    /// The whole props object, its `...rest`, or a props path: keys known only per call site
    /// (an inlined instance) or at render (`spread_attrs`).
    Props(RawExpr),
    /// `{...(c ? {a: 1} : {b: 2})}`, or a `const` holding one: a tree of tests over object literals with
    /// literal keys (R34.66). Each key becomes one attribute (or prop) that reads as `c ? 1 : undefined`.
    Union(Union),
    /// Anything else (a local object, a call, state): not expanded.
    Other,
}

/// The most conditional nodes and distinct keys one union spread may have (a compile-time bound).
const UNION_MAX_NODES: usize = 16;
const UNION_MAX_KEYS: usize = 64;

/// A spread value built of conditionals over object literals (R34.66).
enum Union {
    /// An object literal (or `null`/`undefined`/`false`: nothing is spread): the entries, in order.
    Obj(Vec<(String, js_ast::Expr)>),
    Cond(Box<RawExpr>, Box<Union>, Box<Union>),
}

/// `e` as a [`Union`] whose root is a conditional, `None` for anything else. A test is evaluated once per key, so
/// it must be a pure expression of reads.
fn union_of(r: &mut Reader<'_, '_>, e: &js_ast::Expr, nodes: &mut usize) -> Option<Union> {
    *nodes += 1;
    if *nodes > UNION_MAX_NODES {
        return None;
    }
    match &e.data {
        E::EIdentifier(id) => {
            let init = r.names.cond_const(id.ref_)?;
            union_of(r, &init, nodes)
        }
        E::EIf(i) => {
            let test = r.expr(&i.test);
            if !pure_test(&test) {
                return None;
            }
            let yes = union_branch(r, &i.yes, nodes)?;
            let no = union_branch(r, &i.no, nodes)?;
            Some(Union::Cond(Box::new(test), Box::new(yes), Box::new(no)))
        }
        // `c && {…}`: a falsy `c` spreads nothing.
        E::EBinary(b) if matches!(b.op, OpCode::BinLogicalAnd) => {
            let test = r.expr(&b.left);
            if !pure_test(&test) {
                return None;
            }
            let yes = union_branch(r, &b.right, nodes)?;
            Some(Union::Cond(
                Box::new(test),
                Box::new(yes),
                Box::new(Union::Obj(Vec::new())),
            ))
        }
        _ => None,
    }
}

fn union_branch(r: &mut Reader<'_, '_>, e: &js_ast::Expr, nodes: &mut usize) -> Option<Union> {
    match &e.data {
        E::ENull(_) | E::EUndefined(_) => Some(Union::Obj(Vec::new())),
        E::EBoolean(b) if !b.value => Some(Union::Obj(Vec::new())),
        E::EObject(obj) => {
            let mut entries = Vec::new();
            for p in obj.properties.iter() {
                let (Some(k), Some(v)) = (&p.key, &p.value) else {
                    return None;
                };
                let E::EString(k) = &k.data else {
                    return None;
                };
                if !matches!(p.kind, js_ast::G::PropertyKind::Normal)
                    || p.flags.contains(js_ast::flags::Property::IsComputed)
                {
                    return None;
                }
                entries.push((estring(k), *v));
            }
            Some(Union::Obj(entries))
        }
        _ => union_of(r, e, nodes),
    }
}

/// A test the union repeats per key: reads only (no call, no function, nothing the printer could not repeat).
fn pure_test(e: &RawExpr) -> bool {
    match &e.kind {
        RawKind::Lit(_) | RawKind::Ident { .. } => true,
        RawKind::Member { target, .. } => pure_test(target),
        RawKind::Index { target, index } => pure_test(target) && pure_test(index),
        RawKind::Binary { left, right, .. } => pure_test(left) && pure_test(right),
        RawKind::Unary { value, .. } => pure_test(value),
        RawKind::Cond { test, yes, no } => pure_test(test) && pure_test(yes) && pure_test(no),
        _ => false,
    }
}

impl Union {
    /// Every key, first occurrence first.
    fn keys(&self, out: &mut Vec<String>) {
        match self {
            Union::Obj(entries) => {
                for (k, _) in entries {
                    if !out.contains(k) {
                        out.push(k.clone());
                    }
                }
            }
            Union::Cond(_, y, n) => {
                y.keys(out);
                n.keys(out);
            }
        }
    }

    /// The value of `key` along each branch, joined by the tests; a branch without the key is `undefined`.
    /// `leaf` reads one entry (`None`: not expressible, the whole union fails closed).
    fn value(
        &self,
        key: &str,
        absent: &RawExpr,
        leaf: &mut dyn FnMut(&js_ast::Expr) -> Option<RawExpr>,
    ) -> Option<RawExpr> {
        match self {
            Union::Obj(entries) => match entries.iter().rev().find(|(k, _)| k == key) {
                Some((_, v)) => leaf(v),
                None => Some(absent.clone()),
            },
            Union::Cond(t, y, n) => Some(RawExpr {
                loc: t.loc,
                kind: RawKind::Cond {
                    test: t.clone(),
                    yes: Box::new(y.value(key, absent, leaf)?),
                    no: Box::new(n.value(key, absent, leaf)?),
                },
            }),
        }
    }
}

fn spread_source(r: &mut Reader<'_, '_>, value: &js_ast::Expr, host: bool) -> Spread {
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
                entries.push((estring(k), *v));
            }
            Spread::Literal(entries)
        }
        // F266: on a component, a `const` holding an object literal of plain reads spreads as that literal (the names it reads are
        // consts of the same render, so reading them here is reading them where the object was built).
        E::EIdentifier(id) if !host && r.names.object_const(id.ref_).is_some() => {
            match r
                .names
                .object_const(id.ref_)
                .and_then(|o| plain_object(o, r.names))
            {
                Some(entries) => Spread::Literal(entries),
                None => Spread::Other,
            }
        }
        E::EIdentifier(_) | E::EIf(_) | E::EBinary(_) if union_root(r, value) => {
            let mut nodes = 0;
            match union_of(r, value, &mut nodes) {
                Some(u) => Spread::Union(u),
                None => Spread::Other,
            }
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

/// The entries of an object literal whose keys are plain strings and whose values are reads with no effect (an
/// identifier, a member path of one, a literal): what a spread or an argument may stand for.
/// F280: also a conditional over such reads, and a call of a module function `plain_fn` proves effect-free over such
/// reads (Radix's `isIndeterminate(defaultChecked) ? false : defaultChecked`): reading it where the object is spread
/// instead of where it was built changes nothing.
fn plain_object(
    e: js_ast::Expr,
    names: &crate::analyze::names::NameTable<'_>,
) -> Option<Vec<(String, js_ast::Expr)>> {
    fn read(e: &js_ast::Expr, names: &crate::analyze::names::NameTable<'_>) -> bool {
        match &e.data {
            E::EIf(i) => read(&i.test, names) && read(&i.yes, names) && read(&i.no, names),
            E::ECall(c) => {
                c.optional_chain.is_none()
                    && !c.was_jsx_element
                    && matches!(&c.target.data, E::EIdentifier(id) if names.is_plain_fn(id.ref_))
                    && c.args.iter().all(|a| read(a, names))
            }
            E::EIdentifier(_)
            | E::EString(_)
            | E::ENumber(_)
            | E::EBoolean(_)
            | E::ENull(_)
            | E::EUndefined(_) => true,
            E::EDot(d) => d.optional_chain.is_none() && read(&d.target, names),
            _ => false,
        }
    }
    let E::EObject(obj) = &e.data else {
        return None;
    };
    let mut entries = Vec::new();
    for p in obj.properties.iter() {
        let (Some(k), Some(v)) = (&p.key, &p.value) else {
            return None;
        };
        let E::EString(k) = &k.data else {
            return None;
        };
        if !matches!(p.kind, js_ast::G::PropertyKind::Normal)
            || p.flags.contains(js_ast::flags::Property::IsComputed)
            // N1: `__proto__: x` in a literal sets the prototype, it is not an entry
            || k.slice8() == b"__proto__"
            || !read(v, names)
        {
            return None;
        }
        entries.push((estring(k), *v));
    }
    Some(entries)
}

fn union_refused(value: &js_ast::Expr, why: &str) -> Diagnostic {
    Diagnostic::fallback(
        "spread-props",
        format!("a spread of conditional objects {why}, so it is not expanded natively"),
        loc_of(value),
        "list the attributes explicitly, or spread props",
    )
}

/// A key a union spread never carries, on a host element or a component: an `on[A-Z]*` handler, `style`, `ref` and
/// `dangerouslySetInnerHTML` are not a plain conditional value, so they refuse the whole union (a fallback).
fn union_key_refused(name: &str) -> bool {
    matches!(name, "style" | "ref" | "dangerouslySetInnerHTML")
        || name
            .strip_prefix("on")
            .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_uppercase()))
}

/// One entry of a union spread on a host element, as the expression the joined attribute evaluates. Only a plain
/// attribute value qualifies (a string, a boolean, an expression): handlers, refs, `style`, `class` merging and
/// `dangerouslySetInnerHTML` are not expressible as a conditional value, so they refuse the whole union.
fn read_union_attr(
    r: &mut Reader<'_, '_>,
    name: &str,
    v: &js_ast::Expr,
    ref_name: &mut Option<String>,
) -> Option<RawExpr> {
    if union_key_refused(name) {
        return None;
    }
    let lit = |l| RawExpr {
        loc: loc_of(v),
        kind: RawKind::Lit(l),
    };
    match read_attr(r, name, v, ref_name, false)? {
        Attr::Static { .. } if matches!(v.data, E::EBoolean(_)) => {
            Some(lit(crate::ir::Literal::Bool(true)))
        }
        Attr::Static { value, .. } => Some(lit(crate::ir::Literal::Str(value))),
        Attr::Dynamic {
            value: Expr::Raw(raw),
            ..
        } => Some(raw),
        _ => None,
    }
}

/// `value` could be the root of a union spread: a conditional, `c && {…}`, or a `const` holding a conditional.
fn union_root(r: &Reader<'_, '_>, value: &js_ast::Expr) -> bool {
    match &value.data {
        E::EIdentifier(id) => r.names.cond_const(id.ref_).is_some(),
        E::EIf(_) => true,
        E::EBinary(b) => matches!(b.op, OpCode::BinLogicalAnd),
        _ => false,
    }
}

/// True for a custom element tag (a host tag with `-`).
fn is_custom(tag: &Tag) -> bool {
    matches!(tag, Tag::Host(h) if h.contains('-'))
}

fn read_attr(
    r: &mut Reader<'_, '_>,
    name: &str,
    value: &js_ast::Expr,
    ref_name: &mut Option<String>,
    custom: bool,
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
        // `ref={ref}` with `ref` the forwarded ref of a `forwardRef` component: nothing to bind in HTML (R34.63).
        if let E::EIdentifier(id) = &value.data
            && r.names.is_forwarded_ref(id.ref_)
        {
            r.names.note_forwarded_ref_dropped(value.loc.start);
            return Some(Attr::ForwardRef);
        }
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
        // React writes a literal `true` by the kind of the attribute (`brust_jinja::attr_kind`): `aria-*`, `data-*` and the
        // other booleanish-string attributes as "true" (`aria-hidden` alone is `aria-hidden="true"`), a boolean attribute
        // and `download`/`capture` as the empty value. On any other attribute it prints nothing: that is the dynamic path.
        // A custom element (a tag with `-`) passes every attribute through as given: a literal `true` is the empty value (F213).
        E::EBoolean(b) if b.value && custom => Attr::Static {
            name: name.into(),
            value: String::new(),
        },
        E::EBoolean(b)
            if b.value
                && brust_jinja::attr_kind(&brust_jinja::attr_name(name))
                    != brust_jinja::AttrKind::Plain =>
        {
            Attr::Static {
                name: name.into(),
                value: if brust_jinja::attr_kind(&brust_jinja::attr_name(name))
                    == brust_jinja::AttrKind::Stringify
                {
                    "true".into()
                } else {
                    String::new()
                },
            }
        }
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
pub(crate) fn event_name(attr: &str) -> Option<String> {
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
/// that name; anything else is hoisted to `_hN` in encounter order, skipping every
/// name the module spells (F147: a user's own `_h2` stays theirs).
fn hoist_handler(r: &mut Reader<'_, '_>, value: &js_ast::Expr) -> String {
    let body = r.expr(value);
    if let RawKind::Ident {
        name,
        kind: IdentKind::Local,
    } = &body.kind
    {
        return name.clone();
    }
    let mut n = r.pending_handlers.len() + 1;
    let name = loop {
        let name = format!("_h{n}");
        if !r.names.spells(&name) && !r.pending_handlers.iter().any(|h| h.name == name) {
            break name;
        }
        n += 1;
    };
    r.pending_handlers.push(HandlerDecl {
        name: name.clone(),
        body,
        item_scoped: r.loop_scope.clone(),
        forwarded: None,
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
            vec![Node::If {
                cond,
                then,
                else_,
                and: false,
            }]
        }
        E::EBinary(b) if b.op == OpCode::BinLogicalAnd => {
            let cond = Expr::Raw(r.expr(&b.left));
            let then = read_list_arms(r, &b.right);
            vec![Node::If {
                cond,
                then,
                else_: Vec::new(),
                and: true,
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

/// An identifier or a `.member` chain over one: reading it twice has no effect.
fn pure_path(e: &js_ast::Expr) -> bool {
    match &e.data {
        E::EIdentifier(_) | E::EImportIdentifier(_) => true,
        E::EDot(d) => pure_path(&d.target),
        _ => false,
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
                and: true,
            });
        }
        // `a ?? <X/>` and `a || <X/>` over a plain read (shadcn S1, R34.78): a condition in disguise.
        // `a` is read twice (the test and the slot), so only a side-effect-free path qualifies.
        E::EBinary(b)
            if matches!(b.op, OpCode::BinNullishCoalescing | OpCode::BinLogicalOr)
                && is_jsx(&b.right)
                && pure_path(&b.left) =>
        {
            let left = r.expr(&b.left);
            let cond = if b.op == OpCode::BinLogicalOr {
                Expr::Raw(left.clone())
            } else {
                // `(a ?? undefined) !== undefined`: the template's nullish read treats a missing
                // prop, `null` and `undefined` alike (a bare `a != null` would not see a missing prop).
                let undef = |loc| RawExpr {
                    loc,
                    kind: RawKind::Lit(crate::ir::Literal::Undefined),
                };
                Expr::Raw(RawExpr {
                    loc: left.loc,
                    kind: RawKind::Binary {
                        op: crate::ir::BinOp::StrictNe,
                        left: Box::new(RawExpr {
                            loc: left.loc,
                            kind: RawKind::Binary {
                                op: crate::ir::BinOp::Nullish,
                                left: Box::new(left.clone()),
                                right: Box::new(undef(left.loc)),
                            },
                        }),
                        right: Box::new(undef(left.loc)),
                    },
                })
            };
            let mut else_ = Vec::new();
            read_child(r, &b.right, &mut else_);
            out.push(Node::If {
                cond,
                then: vec![Node::Slot(Expr::Raw(left))],
                else_,
                and: false,
            });
        }
        E::EIf(i) if is_jsx(&i.yes) || is_jsx(&i.no) => {
            let cond = Expr::Raw(r.expr(&i.test));
            let mut then = Vec::new();
            read_child(r, &i.yes, &mut then);
            let mut else_ = Vec::new();
            read_child(r, &i.no, &mut else_);
            out.push(Node::If {
                cond,
                then,
                else_,
                and: false,
            });
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
