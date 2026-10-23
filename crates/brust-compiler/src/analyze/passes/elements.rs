//! F288 phase A: the element-value fold (design note `docs/plans/2026-10-23-f288-element-value.md` §2-§4), run in a
//! call-site clone (`specialise`) of a component that reads its `children` only as an element: `typeof children ===
//! "function"` (E1), `React.Children.only(children)` (E2), `children(args)` (E3), `React.cloneElement(child, config)`
//! (E4), a module function of the element (§3, `getElementRef`), and rendering the result (E6). At the call site the
//! element is known (S1: the one element between the tags; S2: the body of the function between them), so every one of
//! these folds into ordinary IR before the passes run. Anything the fold does not finish is a refusal (`Err`): the call
//! site keeps the island it had.
use crate::analyze::element_value::{ElementShape, eval_element_fn};
use crate::ir::{
    BinOp, ComponentIR, Expr, IdentKind, Literal, Node, RawExpr, RawKind, RenderProp, ServerExpr,
    UnOp,
};
use std::collections::HashMap;

/// The refusal the reader gives a component that reads an element as a value; a successful fold drops it.
pub(crate) const ELEMENT_VALUE: &str = "element-value";

/// Folds the element operations of `ir` for this call site. `Ok(false)`: `ir` has none (nothing changed; the caller
/// splices as before). `Ok(true)`: folded; `render` and `content` are consumed.
pub(super) fn fold(
    ir: &mut ComponentIR,
    parsed: &crate::parse::Parsed,
    render: &mut Option<RenderProp>,
    content: &mut Option<Vec<Node>>,
    react_19: bool,
) -> Result<bool, String> {
    if !ir.diagnostics.iter().any(|d| d.rule == ELEMENT_VALUE) {
        return Ok(false);
    }
    if !react_19 {
        return Err(
            "the element fold models React 19's element, and the project resolves another React"
                .into(),
        );
    }
    let render_child = render.as_ref().is_some_and(|r| r.key == "children");
    if render.is_some() && !render_child {
        return Err("a render prop other than `children` beside an element read".into());
    }
    // E1: `typeof children === "function"` is decided by what the call site wrote.
    each_expr(ir, &mut |e| {
        map_raw(e, &mut |x| {
            if is_typeof_children_fn(x) {
                x.kind = RawKind::Lit(Literal::Bool(render_child));
            }
        })
    });
    propagate_literals(ir);
    // E2 / E3: the locals that hold the element.
    let mut elems: HashMap<String, Node> = HashMap::new();
    let mut taken_render = render.take();
    let mut taken_content = content.take();
    let mut i = 0;
    while i < ir.derived.len() {
        let Expr::Raw(e) = &ir.derived[i].expr else {
            i += 1;
            continue;
        };
        let el = if let RawKind::Call { callee, args } = &e.kind
            && is_children(callee)
        {
            let rp = taken_render
                .take()
                .ok_or("`children(…)` is called but the call site wrote no function")?;
            Some(render_element(rp, args)?)
        } else if let RawKind::Call { callee, args } = &e.kind
            && react_member(callee, &["Children", "only"])
            && matches!(args.as_slice(), [a] if is_children(a))
        {
            let nodes = taken_content
                .take()
                .ok_or("`Children.only(children)` but the call site wrote no element")?;
            // React throws for zero or more than one child: that stays React's.
            Some(
                one_element(nodes)
                    .ok_or("`Children.only` of other than one element (React throws)")?,
            )
        } else {
            None
        };
        match el {
            Some(n) => {
                let d = ir.derived.remove(i);
                elems.insert(d.name, n);
            }
            None => i += 1,
        }
    }
    if elems.is_empty() {
        return Err(
            "the component reads its children as an element in a way the fold does not follow"
                .into(),
        );
    }
    // §3: a module function of an element (`getElementRef(child)`), evaluated as written.
    let mut failed = None;
    let shapes: HashMap<String, ElementShape> =
        elems.iter().map(|(k, n)| (k.clone(), shape(n))).collect();
    each_expr(ir, &mut |e| {
        map_raw(e, &mut |x| {
            if failed.is_some() {
                return;
            }
            if let RawKind::Call { callee, args } = &x.kind
                && let RawKind::Ident {
                    name: f,
                    kind: IdentKind::Local,
                } = &callee.kind
                && let [a] = args.as_slice()
                && let RawKind::Ident {
                    name: el,
                    kind: IdentKind::Local,
                } = &a.kind
                && let Some(s) = shapes.get(el)
            {
                match parsed.with_ast(|ast| eval_element_fn(ast, f, s, x.loc)) {
                    Ok(v) => *x = v,
                    Err(why) => failed = Some(format!("`{f}` of an element: {why}")),
                }
            }
        })
    });
    if let Some(why) = failed {
        return Err(why);
    }
    propagate_literals(ir);
    // E4 + E6: `cloneElement(child, config)` where the template renders it.
    let mut failed = None;
    replace_clones(&mut ir.template, &elems, &mut failed);
    if let Some(why) = failed {
        return Err(why);
    }
    // Nothing else may read the element or the children.
    let mut left = Vec::new();
    each_expr_ref(ir, &mut |e| {
        let mut bad = false;
        crate::lower::common::visit_idents(e, &mut |n, k| {
            bad |= (n == "children" && matches!(k, IdentKind::Prop))
                || (elems.contains_key(n) && matches!(k, IdentKind::Local));
        });
        if bad || mentions_element_api(e) {
            left.push(e.loc);
        }
    });
    if !left.is_empty() {
        return Err(
            "the element or the children are read other than by the folded operations".into(),
        );
    }
    if taken_render.is_some() {
        return Err("the call site's function is never called".into());
    }
    if taken_content.as_ref().is_some_and(|c| !c.is_empty()) {
        return Err("the call site's children are never rendered".into());
    }
    ir.diagnostics.retain(|d| d.rule != ELEMENT_VALUE);
    // B1 / F267: the `ref` the config put on the element (`cloneElement(child, { ref })`) desugars as a written one does.
    crate::analyze::component::callback_refs(ir);
    Ok(true)
}

/// S2: the arrow's body with its parameters bound to the call's arguments (B7's rules: one object literal of pure reads).
fn render_element(rp: RenderProp, args: &[RawExpr]) -> Result<Node, String> {
    let mut map: HashMap<String, RawExpr> = HashMap::new();
    if !rp.params.is_empty() {
        let [arg] = args else {
            return Err("`children` is called with other than one argument".into());
        };
        let RawKind::Object(pairs) = &arg.kind else {
            return Err("`children` is called with a value that is not an object literal".into());
        };
        for (k, local) in &rp.params {
            let value = match pairs.iter().rev().find(|(pk, _)| pk == k) {
                Some((_, v)) => v.clone(),
                None => RawExpr {
                    loc: arg.loc,
                    kind: RawKind::Lit(Literal::Undefined),
                },
            };
            if !super::children::pure_read(&value) {
                return Err(format!("the argument `{k}` of `children` is a computation"));
            }
            map.insert(local.clone(), value);
        }
    }
    let mut body = rp.body;
    for n in &mut body {
        super::children::subst_params(n, &map)?;
    }
    one_element(body)
        .ok_or_else(|| "the function between the tags returns other than one element".into())
}

/// The one component element of `nodes` (whitespace text aside). Phase A: a host element is not folded.
fn one_element(nodes: Vec<Node>) -> Option<Node> {
    let mut it = nodes
        .into_iter()
        .filter(|n| !matches!(n, Node::Text(t) if t.trim().is_empty()));
    let n = it.next()?;
    (it.next().is_none() && matches!(n, Node::Component { .. })).then_some(n)
}

/// What §3 reads of an element: its `ref` prop and whether a spread may add keys. A forwarded ref of the call site's
/// own component (F153c) is `null` here: brust nulls a forwarded ref read as a value (B3) and refuses a call site that
/// hands a ref to a native component, so no ref reaches it (ruling 70370f98: the caller's ref, never the clone's).
fn shape(n: &Node) -> ElementShape {
    let Node::Component {
        props,
        forwarded_ref,
        ..
    } = n
    else {
        return ElementShape {
            props_ref: None,
            open_props: true,
        };
    };
    let null = || RawExpr {
        loc: 0,
        kind: RawKind::Lit(Literal::Null),
    };
    let props_ref = if *forwarded_ref {
        Some(null())
    } else {
        props
            .iter()
            .rev()
            .find(|(k, _)| k == "ref")
            .map(|(_, v)| match v {
                Expr::Raw(r) | Expr::Server(ServerExpr(r)) => r.clone(),
                _ => null(),
            })
    };
    ElementShape {
        props_ref,
        open_props: props.iter().any(|(k, _)| k == crate::ir::SPREAD_KEY),
    }
}

/// Replaces each `{cloneElement(child, config)}` slot with the element, `config` applied as React 19 applies it: every
/// own key replaces the prop (`ref` is a prop; an `undefined` `ref` is skipped); `key` is refused.
fn replace_clones(n: &mut Node, elems: &HashMap<String, Node>, failed: &mut Option<String>) {
    match n {
        Node::Slot(Expr::Raw(r) | Expr::Server(ServerExpr(r))) => {
            let RawKind::Call { callee, args } = &r.kind else {
                return;
            };
            if !react_member(callee, &["cloneElement"]) {
                return;
            }
            let (
                Some(RawExpr {
                    kind: RawKind::Ident { name, .. },
                    ..
                }),
                Some(config),
            ) = (args.first(), args.get(1))
            else {
                *failed = Some("`cloneElement` of other than an element local and a config".into());
                return;
            };
            if args.len() > 2 {
                *failed = Some("`cloneElement` with children arguments".into());
                return;
            }
            let Some(el) = elems.get(name) else {
                *failed = Some(format!(
                    "`cloneElement` of `{name}`, which is not an element"
                ));
                return;
            };
            let RawKind::Object(pairs) = &config.kind else {
                *failed = Some(
                    "`cloneElement` with a config that is not an object literal of static keys"
                        .into(),
                );
                return;
            };
            let mut el = el.clone();
            let Node::Component {
                props,
                forwarded_ref,
                ..
            } = &mut el
            else {
                return;
            };
            for (k, v) in pairs {
                match k.as_str() {
                    "key" => {
                        *failed = Some("`cloneElement` with a `key`".into());
                        return;
                    }
                    "ref" if matches!(v.kind, RawKind::Lit(Literal::Undefined)) => {}
                    _ => {
                        if k == "ref" {
                            *forwarded_ref = false;
                        }
                        props.retain(|(p, _)| p != k);
                        props.push((k.clone(), Expr::Raw(v.clone())));
                    }
                }
            }
            *n = el;
        }
        Node::Element { children, .. }
        | Node::Component { children, .. }
        | Node::Fragment(children) => children
            .iter_mut()
            .for_each(|c| replace_clones(c, elems, failed)),
        Node::If { then, else_, .. } => then
            .iter_mut()
            .chain(else_.iter_mut())
            .for_each(|c| replace_clones(c, elems, failed)),
        Node::For { body, .. } => body
            .iter_mut()
            .for_each(|c| replace_clones(c, elems, failed)),
        Node::Slot(_) | Node::Text(_) | Node::Outlet => {}
    }
}

fn is_children(e: &RawExpr) -> bool {
    matches!(&e.kind, RawKind::Ident { name, kind: IdentKind::Prop } if name == "children")
}

/// `typeof children === "function"` (either way round, `==` too).
fn is_typeof_children_fn(e: &RawExpr) -> bool {
    let typeof_children = |x: &RawExpr| matches!(&x.kind, RawKind::Unary { op: UnOp::Typeof, value } if is_children(value));
    let function =
        |x: &RawExpr| matches!(&x.kind, RawKind::Lit(Literal::Str(s)) if s == "function");
    matches!(&e.kind, RawKind::Binary { op: BinOp::StrictEq | BinOp::Eq, left, right }
        if (typeof_children(left) && function(right)) || (function(left) && typeof_children(right)))
}

/// `e` is `path` of React: a named import (`cloneElement`, `Children.only`) or a member of the default / namespace
/// import (`React.cloneElement`, `React.Children.only`).
fn react_member(e: &RawExpr, path: &[&str]) -> bool {
    let mut names = Vec::new();
    let mut cur = e;
    while let RawKind::Member { target, name, .. } = &cur.kind {
        names.push(name.as_str());
        cur = target;
    }
    names.reverse();
    let RawKind::Ident {
        kind: IdentKind::Import { source, imported },
        ..
    } = &cur.kind
    else {
        return false;
    };
    if source != "react" {
        return false;
    }
    if imported == "*" || imported == "default" {
        names == path
    } else {
        std::iter::once(imported.as_str())
            .chain(names)
            .eq(path.iter().copied())
    }
}

/// `e` names one of React's element functions anywhere.
fn mentions_element_api(e: &RawExpr) -> bool {
    let mut found = false;
    let mut v = |x: &RawExpr| {
        found |= react_member(x, &["cloneElement"])
            || react_member(x, &["isValidElement"])
            || react_member(x, &["Children"])
            || react_member(x, &["Children", "only"]);
    };
    walk_raw(e, &mut v);
    found
}

/// Simplifies after E1: a derived local bound to a literal is that literal where it is read, and `||` / `&&` / `?:` /
/// `!` over a literal fold. Repeated to a fixed point.
fn propagate_literals(ir: &mut ComponentIR) {
    for _ in 0..8 {
        let lits: HashMap<String, Literal> = ir
            .derived
            .iter()
            .filter_map(|d| match &d.expr {
                Expr::Raw(RawExpr {
                    kind: RawKind::Lit(l),
                    ..
                }) => Some((d.name.clone(), l.clone())),
                _ => None,
            })
            .collect();
        let mut changed = false;
        each_expr(ir, &mut |e| {
            map_raw(e, &mut |x| {
                if let RawKind::Ident {
                    name,
                    kind: IdentKind::Local,
                } = &x.kind
                    && let Some(l) = lits.get(name)
                {
                    x.kind = RawKind::Lit(l.clone());
                    changed = true;
                }
                if let Some(s) = simplified(x) {
                    *x = s;
                    changed = true;
                }
            })
        });
        if !changed {
            break;
        }
    }
}

fn lit_truthy(e: &RawExpr) -> Option<bool> {
    let RawKind::Lit(l) = &e.kind else {
        return None;
    };
    Some(match l {
        Literal::Bool(b) => *b,
        Literal::Null | Literal::Undefined => false,
        Literal::Str(s) => !s.is_empty(),
        Literal::Num(n) => *n != 0.0 && !n.is_nan(),
    })
}

fn simplified(x: &RawExpr) -> Option<RawExpr> {
    match &x.kind {
        RawKind::Binary {
            op: BinOp::Or,
            left,
            right,
        } => match lit_truthy(left)? {
            true => Some((**left).clone()),
            false => Some((**right).clone()),
        },
        RawKind::Binary {
            op: BinOp::And,
            left,
            right,
        } => match lit_truthy(left)? {
            true => Some((**right).clone()),
            false => Some((**left).clone()),
        },
        RawKind::Cond { test, yes, no } => match lit_truthy(test)? {
            true => Some((**yes).clone()),
            false => Some((**no).clone()),
        },
        RawKind::Unary {
            op: UnOp::Not,
            value,
        } => Some(RawExpr {
            loc: x.loc,
            kind: RawKind::Lit(Literal::Bool(!lit_truthy(value)?)),
        }),
        _ => None,
    }
}

/// Every render-position expression of `ir` (derived values, the template, ref and state initialisers, effect deps).
fn each_expr(ir: &mut ComponentIR, f: &mut dyn FnMut(&mut RawExpr)) {
    fn ex(e: &mut Expr, f: &mut dyn FnMut(&mut RawExpr)) {
        if let Expr::Raw(r) | Expr::Server(ServerExpr(r)) = e {
            f(r)
        }
    }
    fn node(n: &mut Node, f: &mut dyn FnMut(&mut RawExpr)) {
        match n {
            Node::Slot(e) => ex(e, f),
            Node::Element {
                attrs, children, ..
            } => {
                for a in attrs {
                    match a {
                        crate::ir::Attr::Dynamic { value, .. }
                        | crate::ir::Attr::InnerHtml { value }
                        | crate::ir::Attr::Spread(value) => ex(value, f),
                        _ => {}
                    }
                }
                children.iter_mut().for_each(|c| node(c, f));
            }
            Node::Component {
                props, children, ..
            } => {
                props.iter_mut().for_each(|(_, v)| ex(v, f));
                children.iter_mut().for_each(|c| node(c, f));
            }
            Node::Fragment(cs) => cs.iter_mut().for_each(|c| node(c, f)),
            Node::If {
                cond, then, else_, ..
            } => {
                ex(cond, f);
                then.iter_mut()
                    .chain(else_.iter_mut())
                    .for_each(|c| node(c, f));
            }
            Node::For {
                source, key, body, ..
            } => {
                ex(source, f);
                ex(key, f);
                body.iter_mut().for_each(|c| node(c, f));
            }
            Node::Text(_) | Node::Outlet => {}
        }
    }
    ir.derived.iter_mut().for_each(|d| ex(&mut d.expr, f));
    node(&mut ir.template, f);
    ir.refs.iter_mut().for_each(|r| ex(&mut r.init, f));
    ir.state.iter_mut().for_each(|s| ex(&mut s.init, f));
    for e in &mut ir.effects {
        e.deps.iter_mut().flatten().for_each(|d| f(d));
    }
    for w in &mut ir.render_ref_writes {
        f(&mut w.value);
    }
}

/// [`each_expr`] for reading, handlers and effect bodies included.
fn each_expr_ref(ir: &mut ComponentIR, f: &mut dyn FnMut(&RawExpr)) {
    each_expr(ir, &mut |e| f(e));
    for h in &ir.handlers {
        f(&h.body);
    }
    for e in &ir.effects {
        f(&e.body);
    }
}

/// Post-order rewrite of `e` and its sub-expressions (not into code printed as written).
fn map_raw(e: &mut RawExpr, f: &mut dyn FnMut(&mut RawExpr)) {
    match &mut e.kind {
        RawKind::Member { target, .. } => map_raw(target, f),
        RawKind::Index { target, index } => {
            map_raw(target, f);
            map_raw(index, f);
        }
        RawKind::Call { callee, args } => {
            map_raw(callee, f);
            args.iter_mut().for_each(|a| map_raw(a, f));
        }
        RawKind::Binary { left, right, .. } => {
            map_raw(left, f);
            map_raw(right, f);
        }
        RawKind::Unary { value, .. } => map_raw(value, f),
        RawKind::Cond { test, yes, no } => {
            map_raw(test, f);
            map_raw(yes, f);
            map_raw(no, f);
        }
        RawKind::Template { parts, .. } => parts.iter_mut().for_each(|(p, _)| map_raw(p, f)),
        RawKind::Array(xs) => xs.iter_mut().for_each(|x| map_raw(x, f)),
        RawKind::Object(ps) => ps.iter_mut().for_each(|(_, v)| map_raw(v, f)),
        _ => {}
    }
    f(e);
}

/// Pre-order visit of `e` and its sub-expressions, into function bodies too (a name read anywhere counts).
fn walk_raw(e: &RawExpr, f: &mut dyn FnMut(&RawExpr)) {
    f(e);
    match &e.kind {
        RawKind::Member { target, .. } => walk_raw(target, f),
        RawKind::Index { target, index } => {
            walk_raw(target, f);
            walk_raw(index, f);
        }
        RawKind::Call { callee, args } => {
            walk_raw(callee, f);
            args.iter().for_each(|a| walk_raw(a, f));
        }
        RawKind::Binary { left, right, .. } => {
            walk_raw(left, f);
            walk_raw(right, f);
        }
        RawKind::Unary { value, .. } => walk_raw(value, f),
        RawKind::Cond { test, yes, no } => {
            walk_raw(test, f);
            walk_raw(yes, f);
            walk_raw(no, f);
        }
        RawKind::Template { parts, .. } => parts.iter().for_each(|(p, _)| walk_raw(p, f)),
        RawKind::Array(xs) => xs.iter().for_each(|x| walk_raw(x, f)),
        RawKind::Object(ps) => ps.iter().for_each(|(_, v)| walk_raw(v, f)),
        RawKind::Arrow { body, .. } => {
            if let crate::ir::ArrowBody::Expr(b) = body {
                walk_raw(b, f)
            }
        }
        _ => {}
    }
}

/// Whether the project resolves React 19 (the element shape §3 models): `node_modules/react` from `root` up, else the
/// versions in bun's isolated store under `root`. Unknown counts as not 19.
pub(super) fn resolves_react_19(root: &std::path::Path) -> bool {
    let major = |p: &std::path::Path| -> Option<u64> {
        let v: serde_json::Value = serde_json::from_slice(&std::fs::read(p).ok()?).ok()?;
        v["version"].as_str()?.split('.').next()?.parse().ok()
    };
    for dir in root.ancestors() {
        if let Some(m) = major(&dir.join("node_modules/react/package.json")) {
            return m == 19;
        }
    }
    let Ok(store) = std::fs::read_dir(root.join("node_modules/.bun")) else {
        return false;
    };
    let majors: Vec<u64> = store
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().starts_with("react@"))
        .filter_map(|e| major(&e.path().join("node_modules/react/package.json")))
        .collect();
    !majors.is_empty() && majors.iter().all(|m| *m == 19)
}
