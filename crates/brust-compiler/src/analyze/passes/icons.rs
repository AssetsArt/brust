//! lucide-react icons rendered at build time (L23, R23.1/R23.2). An icon from `lucide-react` in a
//! template becomes inline SVG: the build renders the icon component with `react-dom/server`
//! (so the markup is exactly the installed version's), the compiler parses that markup into
//! ordinary elements, and a prop that is not a constant (`size`, `color`, `strokeWidth`,
//! `className`) is rendered as a sentinel and lowered back to a dynamic attribute: a Jinja
//! expression in a static component, an `x-bind` in a native one. This pass runs before the
//! structural snapshot, so everything downstream sees plain elements.
//!
//! First compile: the icon is left as a component (the L22 island) and an [`IconRequest`] is
//! recorded; the build renders the requests and compiles again with `AnalyzeOptions.icon_svgs`.
use super::PassCtx;
use crate::analyze::const_fold::{Folder, map_idents};
use crate::ir::{
    Attr, ComponentIR, Diagnostic, Expr, IconRequest, IdentKind, Node, RawExpr, RawKind,
};
use std::collections::{BTreeMap, HashMap};

/// Props whose value may be a template expression (rendered to one attribute each).
const DYNAMIC_PROPS: &[&str] = &["size", "color", "strokeWidth", "className"];

/// The sentinel the build renders in place of the dynamic prop `name`.
pub fn sentinel(name: &str) -> String {
    format!("__BRUST_ICON_{name}__")
}

pub fn is_lucide(source: &str) -> bool {
    source == "lucide-react" || (source.starts_with("lucide-react/") && source.contains("/icons/"))
}

struct Cx<'a> {
    path: &'a str,
    text: &'a [u8],
    svgs: &'a std::collections::HashMap<String, crate::analyze::component::IconMarkup>,
    consts: std::collections::HashMap<String, RawExpr>,
    requests: Vec<IconRequest>,
    diagnostics: Vec<Diagnostic>,
    /// Literal props of the enclosing `LucideProvider`s (innermost last); `None`: a dynamic one.
    providers: Vec<Option<BTreeMap<String, serde_json::Value>>>,
    /// Icons left as components (not rendered yet, or not renderable).
    unresolved: usize,
    /// An icon was inlined with a runtime spread of the component's props (R34.77).
    spread_icon: bool,
}

pub fn inline(ir: &mut ComponentIR, ctx: &PassCtx<'_>) {
    let none = |_: &str| false;
    let no_imports = |_: &str, _: &str| None;
    let consts = Folder::new(&ir.module_decls, &none, &no_imports).all();
    let mut cx = Cx {
        path: ctx.path,
        text: ctx.text,
        svgs: &ctx.opts.icon_svgs,
        consts,
        requests: Vec::new(),
        diagnostics: Vec::new(),
        providers: Vec::new(),
        unresolved: 0,
        spread_icon: false,
    };
    let mut t = std::mem::replace(&mut ir.template, Node::Fragment(vec![]));
    visit(&mut t, &mut cx);
    ir.template = t;
    ir.icon_requests = cx.requests;
    ir.icon_spread |= cx.spread_icon;
    ir.diagnostics.extend(cx.diagnostics);
}

fn visit_all(ns: &mut [Node], cx: &mut Cx<'_>) {
    ns.iter_mut().for_each(|n| visit(n, cx));
}

fn visit(n: &mut Node, cx: &mut Cx<'_>) {
    match n {
        Node::Element { children, .. } | Node::Fragment(children) => visit_all(children, cx),
        Node::If { then, else_, .. } => {
            visit_all(then, cx);
            visit_all(else_, cx);
        }
        Node::For { body, .. } => visit_all(body, cx),
        Node::Component {
            source: Some(source),
            imported: Some(imported),
            ..
        } if is_lucide(source) && imported == "LucideProvider" => provider(n, cx),
        Node::Component {
            source: Some(source),
            ..
        } if is_lucide(source) => icon(n, cx),
        Node::Component { children, .. } => visit_all(children, cx),
        Node::Text(_) | Node::Slot(_) | Node::Outlet => {}
    }
}

/// A prop value as JSON when it is a constant (a literal, or a module const that folds to one).
fn literal(e: &Expr, cx: &Cx<'_>) -> Option<serde_json::Value> {
    let Expr::Raw(r) = e else { return None };
    if let Some(v) = r.json_literal() {
        return Some(v);
    }
    map_idents(r, &|id| match &id.kind {
        RawKind::Ident {
            name,
            kind: IdentKind::Local,
        } => cx.consts.get(name).cloned(),
        _ => None,
    })
    .json_literal()
}

/// `{...props}` or `{...rest}`: the component's own props object (or its rest), nothing computed.
fn is_own_props_spread(e: &Expr) -> bool {
    let (Expr::Raw(r) | Expr::Server(crate::ir::ServerExpr(r))) = e else {
        return false;
    };
    matches!(&r.kind, RawKind::Ident { name, kind: IdentKind::Prop }
        if name == "*" || name == crate::ir::REST_PROPS)
}

fn provider(n: &mut Node, cx: &mut Cx<'_>) {
    let Node::Component {
        loc,
        props,
        children,
        ..
    } = n
    else {
        return;
    };
    let mut lits = BTreeMap::new();
    let mut dynamic = None;
    for (k, v) in props.iter() {
        match literal(v, cx) {
            Some(j) => {
                lits.insert(k.clone(), j);
            }
            None => dynamic = Some(k.clone()),
        }
    }
    let before = cx.unresolved;
    if let Some(prop) = dynamic {
        let (line, col) = crate::ir::line_col(cx.text, *loc);
        cx.diagnostics.push(Diagnostic::warning(
            "icon-provider-dynamic",
            format!("LucideProvider prop `{prop}` is not a constant (line {line}:{col}); the icons under it render as React islands"),
            *loc,
            "give the provider literal props, or pass the props to each icon",
        ));
        cx.providers.push(None);
    } else {
        cx.providers.push(Some(lits));
    }
    visit_all(children, cx);
    let poisoned = cx.providers.pop().flatten().is_none();
    if !poisoned && cx.unresolved == before {
        // Every icon below was rendered with the provider's values: the provider has nothing left to do.
        let kids = std::mem::take(children);
        *n = Node::Fragment(kids);
    }
}

fn icon(n: &mut Node, cx: &mut Cx<'_>) {
    let Node::Component {
        loc,
        source: Some(source),
        imported: Some(imported),
        props,
        children,
        ..
    } = n
    else {
        return;
    };
    let (loc, source, imported) = (*loc, source.clone(), imported.clone());
    if !children.is_empty() {
        cx.unresolved += 1;
        visit_all(children, cx);
        return;
    }
    // A dynamic provider above: the island keeps the provider's meaning no better, leave it.
    if cx.providers.iter().any(Option::is_none) {
        cx.unresolved += 1;
        return;
    }
    let mut lits: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    let mut dynamic: Vec<String> = Vec::new();
    let mut spread: Option<Expr> = None;
    for (k, v) in props.iter() {
        // `{...props}` / `{...rest}` of this component's own props: the rendered `<svg>` takes them last, as
        // lucide-react does (`{ ...defaults, ...rest }`). Any other spread keeps the island (R34.77).
        if k == crate::ir::SPREAD_KEY && spread.is_none() && is_own_props_spread(v) {
            spread = Some(v.clone());
            continue;
        }
        match literal(v, cx) {
            Some(j) => {
                lits.insert(k.clone(), j);
            }
            None if DYNAMIC_PROPS.contains(&k.as_str()) && matches!(v, Expr::Raw(_)) => {
                dynamic.push(k.clone())
            }
            None => {
                cx.diagnostics.push(Diagnostic::warning(
                    "icon-dynamic-prop",
                    format!("icon prop `{k}` is not a constant and cannot be lowered to an attribute; the icon renders as a React island"),
                    loc,
                    "only size, color, strokeWidth and className may change at run time; make the others literals",
                ));
                cx.unresolved += 1;
                return;
            }
        }
    }
    let mut provider: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    for p in cx.providers.iter().flatten() {
        provider.extend(p.clone());
    }
    let key = format!("{}@{loc}", cx.path);
    if let Some(m) = cx.svgs.get(&key)
        && let Some(mut el) = parse_svg(&m.svg, &m.base, loc, props, &dynamic)
    {
        if let Some(sp) = spread {
            let Node::Element { attrs, .. } = &mut el else {
                cx.unresolved += 1;
                return;
            };
            attrs.push(Attr::Spread(sp));
            cx.spread_icon = true;
        }
        *n = el;
        return;
    }
    let (line, col) = crate::ir::line_col(cx.text, loc);
    cx.requests.push(IconRequest {
        key,
        source,
        export: imported,
        props: lits,
        dynamic,
        provider,
        line,
        col,
    });
    cx.unresolved += 1;
}

// ---- the SVG markup `renderToStaticMarkup` returned -------------------------------------------

fn decode(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// `(text before the first prop, [(text after it, prop)…], trailing text)`.
type Split = (String, Vec<(String, String)>, String);

/// `value` split around the sentinel of every dynamic prop it contains: `(text, prop)` pairs plus
/// the trailing text.
fn split_sentinels(value: &str, dynamic: &[String]) -> Option<Split> {
    let mut rest = value.to_string();
    let mut head = String::new();
    let mut parts: Vec<(String, String)> = Vec::new();
    loop {
        let hit = dynamic
            .iter()
            .filter_map(|d| rest.find(&sentinel(d)).map(|i| (i, d)))
            .min_by_key(|(i, _)| *i);
        let Some((i, d)) = hit else { break };
        let before = rest[..i].to_string();
        if parts.is_empty() {
            head = before;
        } else {
            parts.last_mut()?.0 = before;
        }
        parts.push((String::new(), d.clone()));
        rest = rest[i + sentinel(d).len()..].to_string();
    }
    if parts.is_empty() {
        return None;
    }
    // `parts[i].0` is the text after the i-th prop (set on the next hit); the last is `rest`.
    Some((head, parts, rest))
}

struct Tok<'a> {
    s: &'a str,
    i: usize,
}

fn parse_svg(
    svg: &str,
    base: &str,
    loc: u32,
    props: &[(String, Expr)],
    dynamic: &[String],
) -> Option<Node> {
    // What React renders when the dynamic props are absent (`undefined`): each dynamic attribute
    // falls back to this, exactly like `size ?? contextSize`.
    let defaults: HashMap<String, String> = {
        let mut t = Tok { s: base, i: 0 };
        match element(&mut t, loc, props, &[], &HashMap::new())? {
            Node::Element { attrs, .. } => attrs
                .into_iter()
                .filter_map(|a| match a {
                    Attr::Static { name, value } => Some((name, value)),
                    _ => None,
                })
                .collect(),
            _ => return None,
        }
    };
    let mut t = Tok { s: svg, i: 0 };
    let node = element(&mut t, loc, props, dynamic, &defaults)?;
    (t.s[t.i..].trim().is_empty()).then_some(node)
}

fn element(
    t: &mut Tok<'_>,
    loc: u32,
    props: &[(String, Expr)],
    dynamic: &[String],
    defaults: &HashMap<String, String>,
) -> Option<Node> {
    let s = t.s.as_bytes();
    if s.get(t.i) != Some(&b'<') {
        return None;
    }
    t.i += 1;
    let start = t.i;
    while t.i < s.len() && !(s[t.i].is_ascii_whitespace() || s[t.i] == b'>' || s[t.i] == b'/') {
        t.i += 1;
    }
    let tag = t.s[start..t.i].to_string();
    if tag.is_empty() || tag.starts_with('/') {
        return None;
    }
    let mut attrs = Vec::new();
    loop {
        while t.i < s.len() && s[t.i].is_ascii_whitespace() {
            t.i += 1;
        }
        match s.get(t.i)? {
            b'>' => {
                t.i += 1;
                break;
            }
            b'/' => {
                // `<tag … />`
                t.i += 1;
                if s.get(t.i) != Some(&b'>') {
                    return None;
                }
                t.i += 1;
                return Some(make(tag, attrs, Vec::new(), loc));
            }
            _ => {}
        }
        let ns = t.i;
        while t.i < s.len()
            && !(s[t.i] == b'=' || s[t.i] == b'>' || s[t.i] == b'/' || s[t.i].is_ascii_whitespace())
        {
            t.i += 1;
        }
        let name = t.s[ns..t.i].to_string();
        let value = if s.get(t.i) == Some(&b'=') {
            t.i += 1;
            if s.get(t.i) != Some(&b'"') {
                return None;
            }
            t.i += 1;
            let vs = t.i;
            while t.i < s.len() && s[t.i] != b'"' {
                t.i += 1;
            }
            let v = decode(&t.s[vs..t.i]);
            t.i += 1;
            v
        } else {
            String::new()
        };
        attrs.push(attr(&name, &value, props, dynamic, defaults)?);
    }
    let mut children = Vec::new();
    loop {
        if t.s[t.i..].starts_with("</") {
            let close = t.s[t.i..].find('>')? + t.i;
            if t.s[t.i + 2..close].trim() != tag {
                return None;
            }
            t.i = close + 1;
            return Some(make(tag, attrs, children, loc));
        }
        if t.s.as_bytes().get(t.i) == Some(&b'<') {
            children.push(element(t, loc, props, dynamic, defaults)?);
        } else {
            let end = t.s[t.i..].find('<')? + t.i;
            let text = decode(&t.s[t.i..end]);
            if !text.is_empty() {
                children.push(Node::Text(text));
            }
            t.i = end;
        }
    }
}

fn make(tag: String, attrs: Vec<Attr>, children: Vec<Node>, loc: u32) -> Node {
    Node::Element {
        loc,
        tag,
        attrs,
        children,
        host: false,
        ref_name: None,
        synthetic: false,
        poly: false,
    }
}

fn prop_expr(name: &str, props: &[(String, Expr)]) -> Option<RawExpr> {
    match props.iter().find(|(k, _)| k == name) {
        Some((_, Expr::Raw(r))) => Some(r.clone()),
        _ => None,
    }
}

/// One attribute of the rendered markup: static, or dynamic where the value carries a sentinel.
/// React treats an `undefined` (or `null`) size / color / strokeWidth as absent and renders the
/// default (or the provider's value), so the dynamic value is `prop ?? <default>` and a
/// `className` template is only used when the prop is truthy.
fn attr(
    name: &str,
    value: &str,
    props: &[(String, Expr)],
    dynamic: &[String],
    defaults: &HashMap<String, String>,
) -> Option<Attr> {
    let Some((head, parts, tail)) = split_sentinels(value, dynamic) else {
        return Some(Attr::Static {
            name: name.to_string(),
            value: value.to_string(),
        });
    };
    let html = if name == "class" { "className" } else { name };
    let default = defaults.get(name).map(|d| RawExpr {
        loc: 0,
        kind: RawKind::Lit(crate::ir::Literal::Str(d.clone())),
    });
    if head.is_empty() && parts.len() == 1 && tail.is_empty() {
        let e = prop_expr(&parts[0].1, props)?;
        let value = match default {
            Some(d) => RawExpr {
                loc: e.loc,
                kind: RawKind::Binary {
                    op: crate::ir::BinOp::Nullish,
                    left: Box::new(e),
                    right: Box::new(d),
                },
            },
            None => e,
        };
        return Some(Attr::Dynamic {
            name: html.to_string(),
            value: Expr::Raw(value),
        });
    }
    // `"lucide lucide-heart " + className`: a template over the props.
    let mut tparts = Vec::new();
    let mut tests = Vec::new();
    for (i, (_, prop)) in parts.iter().enumerate() {
        let after = if i + 1 < parts.len() {
            parts[i].0.clone()
        } else {
            tail.clone()
        };
        let e = prop_expr(prop, props)?;
        tests.push(e.clone());
        tparts.push((e, after));
    }
    let loc = tparts.first().map(|p| p.0.loc).unwrap_or(0);
    let template = RawExpr {
        loc,
        kind: RawKind::Template {
            head,
            parts: tparts,
        },
    };
    // Absent props render the default string; present ones the template.
    let value = match (default, tests.into_iter().next()) {
        (Some(d), Some(test)) => RawExpr {
            loc,
            kind: RawKind::Cond {
                test: Box::new(test),
                yes: Box::new(template),
                no: Box::new(d),
            },
        },
        _ => template,
    };
    Some(Attr::Dynamic {
        name: html.to_string(),
        value: Expr::Raw(value),
    })
}
