//! Tier decision (spec §3, §8.1) and `needs_worker` (§3.5).
use super::placement::contains_jsx;
use super::{PassCtx, PassState};
use crate::ir::{Attr, ComponentIR, DiagClass, Diagnostic, Expr, Node, Tier};

/// Fallback rules that do not make *this* component React (they concern a child).
pub(super) const CHILD_ONLY: &[&str] = &["external-component", "child-component"];

pub fn tier(ir: &mut ComponentIR, st: &mut PassState, ctx: &PassCtx<'_>) {
    check_refs(ir);
    check_default_shapes(ir);

    // Ruling 1 (M1b-2 plan): JSX built outside the template.
    let mut jsx = st.jsx_code.clone();
    for h in &ir.handlers {
        if contains_jsx(&h.body) {
            jsx.push((h.body.loc, "a handler"));
        }
    }
    for e in &ir.effects {
        if contains_jsx(&e.body) {
            jsx.push((e.body.loc, "an effect"));
        }
    }
    jsx.sort();
    jsx.dedup();
    for (loc, what) in &jsx {
        ir.diagnostics.push(Diagnostic::info(
            "jsx-outside-render",
            format!(
                "{what} at line {} builds JSX; the component renders as a React island",
                ctx.line(*loc)
            ),
            *loc,
            "return data and render it in the component body",
        ));
    }

    if let Some((loc, global)) = st.browser_locs.iter().min().cloned() {
        let message = format!(
            "render reads `{global}` (line {}) — component renders with React on the client",
            ctx.line(loc)
        );
        ir.diagnostics.push(Diagnostic::fallback(
            "browser-global",
            message.clone(),
            loc,
            "read browser globals in useEffect or an event handler",
        ));
        ir.tier = Tier::React {
            reason: message,
            client_only: true,
        };
    } else if let Some(d) = ir
        .diagnostics
        .iter()
        .find(|d| d.class == DiagClass::Fallback && !CHILD_ONLY.contains(&d.rule.as_str()))
    {
        ir.tier = Tier::React {
            reason: d.message.clone(),
            client_only: false,
        };
    } else if let Some((loc, what)) = jsx.first() {
        ir.tier = Tier::React {
            reason: format!("{what} at line {} builds JSX", ctx.line(*loc)),
            client_only: false,
        };
    // F277: a fixed cell (nothing sets it, its first value is the same at every mount) changes nothing.
    } else if ir.state.iter().all(|s| st.cx.is_fixed(&s.name))
        && ir.handlers.is_empty()
        && ir.effects.is_empty()
        && ir.refs.is_empty()
        && ir.child_links.is_empty()
        && !has_state_dependent(ir)
        // A resolved store read updates after first paint (M3-F D7).
        && !ir.stores.iter().any(|s| s.resolved.is_some())
    {
        ir.tier = Tier::Static;
    } else {
        ir.tier = Tier::Native;
    }
    // F548 (R3): an island listed in `[build] islands` that a runtime component places is never server-rendered: it
    // mounts in the browser, like a `browser-global` one (the compile API passes the list as `client_only`).
    if let Tier::React { client_only, .. } = &mut ir.tier
        && !*client_only
        && let Some(e) = &ir.export
        && ctx.opts.client_only.contains(&format!("{}#{e}", ir.source))
    {
        *client_only = true;
    }
    react_jobs(ir);
}

/// The React tail of the decision: run again when a later check makes the component React.
pub fn react_jobs(ir: &mut ComponentIR) {
    // §3.3: a React component's one job is its SSR render over its props;
    // precompute slots and child islands are React's business then.
    if matches!(ir.tier, Tier::React { .. }) && ir.uses_outlet {
        // A React-tier page renders as one island: its template has no `__outlet` slot.
        // Name what made it React: the first fallback, with its own location.
        let (why, loc) = ir
            .diagnostics
            .iter()
            .find(|d| d.class == DiagClass::Fallback && !CHILD_ONLY.contains(&d.rule.as_str()))
            .map(|d| (format!(" ({}: {})", d.rule, d.message), d.loc))
            .unwrap_or_default();
        ir.diagnostics.push(crate::ir::Diagnostic::error(
            "outlet-in-react",
            format!("<Outlet/> is used in a component that renders as a React island{why}"),
            loc,
            "keep layouts native: remove the construct that forces the React tier",
        ));
    }
    // R4.3 (F519): React SSR cannot render a `<Dynamic>` slot (the JS `Dynamic` throws when called), so a component that
    // renders as a React island must not hold one, in its own template or in a child it renders. An error, never a
    // fallback: falling back to React is what cannot render it. Reported once (this tail can run again).
    if matches!(ir.tier, Tier::React { .. })
        && ir.dynamic
        && !ir.diagnostics.iter().any(|d| d.rule == "dynamic-in-react")
    {
        let (why, loc) = ir
            .diagnostics
            .iter()
            .find(|d| d.class == DiagClass::Fallback && !CHILD_ONLY.contains(&d.rule.as_str()))
            .map(|d| (format!(" ({}: {})", d.rule, d.message), d.loc))
            .unwrap_or_else(|| (String::new(), dynamic_loc(&ir.template).unwrap_or(0)));
        ir.diagnostics.push(Diagnostic::error(
            "dynamic-in-react",
            format!(
                "<Dynamic> is rendered by a component that renders as a React island{why}; React cannot render a runtime component"
            ),
            loc,
            "keep the component that renders <Dynamic> (and its callers) native or static: remove the construct that forces the React tier",
        ));
    }
    if let Tier::React { client_only, .. } = &ir.tier {
        // A React island renders its own tree: no precompute slot is used, nothing to evaluate.
        ir.build_eval.clear();
        ir.build_eval_instances.clear();
        ir.jobs = vec![crate::ir::JobDecl {
            kind: crate::ir::JobKind::Ssr {
                client_only: *client_only,
            },
            // The whole props object (§3.3: "the component's props (JSON)").
            inputs: vec!["*".to_string()],
            outputs: vec![format!("_ssr_{}", ir.id)],
            per_item: None,
            props: None,
            literals: Default::default(),
        }];
        // F105: React renders the children itself, so nothing feeds or links them per instance.
        ir.instances.clear();
        ir.child_links.clear();
        // R34.96: no precompute job runs a fused child's job either.
        ir.fused.clear();
    }
    ir.needs_worker = !ir.jobs.is_empty();
}

/// Where the template holds a `<Dynamic>` (or the component that renders one), for a finding with no better place.
fn dynamic_loc(n: &Node) -> Option<u32> {
    match n {
        Node::Dynamic { loc, .. } => Some(*loc),
        Node::Element { children, .. }
        | Node::Component { children, .. }
        | Node::Fragment(children) => children.iter().find_map(dynamic_loc),
        Node::If { then, else_, .. } => then.iter().chain(else_).find_map(dynamic_loc),
        Node::For { body, .. } => body.iter().find_map(dynamic_loc),
        Node::Text(_) | Node::Slot(_) | Node::Outlet => None,
    }
}

fn has_state_dependent(ir: &ComponentIR) -> bool {
    let sd = |e: &Expr| {
        matches!(
            e,
            Expr::Precomputed {
                state_dependent: true,
                ..
            }
        )
    };
    ir.derived.iter().any(|d| sd(&d.expr)) || ir.state.iter().any(|s| sd(&s.init)) || {
        let mut found = false;
        visit_exprs(&ir.template, &mut |e| found |= sd(e));
        found
    }
}

fn visit_exprs(n: &Node, f: &mut impl FnMut(&Expr)) {
    match n {
        Node::Element {
            attrs, children, ..
        } => {
            for a in attrs {
                if let Attr::Dynamic { value, .. }
                | Attr::Spread(value)
                | Attr::InnerHtml { value } = a
                {
                    f(value);
                }
            }
            children.iter().for_each(|c| visit_exprs(c, f));
        }
        Node::Slot(e) => f(e),
        Node::If {
            cond, then, else_, ..
        } => {
            f(cond);
            then.iter().chain(else_).for_each(|c| visit_exprs(c, f));
        }
        Node::For {
            source, key, body, ..
        } => {
            f(source);
            f(key);
            body.iter().for_each(|c| visit_exprs(c, f));
        }
        Node::Component {
            props, children, ..
        } => {
            props.iter().for_each(|(_, v)| f(v));
            children.iter().for_each(|c| visit_exprs(c, f));
        }
        Node::Fragment(cs) => cs.iter().for_each(|c| visit_exprs(c, f)),
        Node::Dynamic {
            component, props, ..
        } => {
            f(component);
            f(props);
        }
        Node::Text(_) | Node::Outlet => {}
    }
}

/// F21: `ref={x}` binds natively only when `x` is a `useRef` binding.
fn check_refs(ir: &mut ComponentIR) {
    let refs: Vec<String> = ir.refs.iter().map(|r| r.name.clone()).collect();
    let mut bad = Vec::new();
    fn walk(n: &Node, refs: &[String], bad: &mut Vec<(u32, String)>) {
        match n {
            Node::Element {
                loc,
                attrs,
                children,
                ..
            } => {
                for a in attrs {
                    if let Attr::Ref { name } = a
                        && !refs.contains(name)
                    {
                        bad.push((*loc, name.clone()));
                    }
                }
                children.iter().for_each(|c| walk(c, refs, bad));
            }
            Node::If { then, else_, .. } => {
                then.iter().chain(else_).for_each(|c| walk(c, refs, bad))
            }
            Node::For { body, .. } => body.iter().for_each(|c| walk(c, refs, bad)),
            Node::Component { children, .. } | Node::Fragment(children) => {
                children.iter().for_each(|c| walk(c, refs, bad))
            }
            Node::Text(_) | Node::Slot(_) | Node::Outlet | Node::Dynamic { .. } => {}
        }
    }
    walk(&ir.template, &refs, &mut bad);
    for (loc, name) in bad {
        ir.diagnostics.push(Diagnostic::fallback(
            "ref-shape",
            format!("`ref={{{name}}}` is not a useRef binding of this component"),
            loc,
            "pass a ref created with useRef in this component",
        ));
    }
}

/// F161 (R39.1): the server template prints a destructuring default with `lower::server_expr`, which turns anything
/// outside its subset into `none`. That matters only for a prop the TEMPLATE reads: a prop read only inside a job
/// (`props.p ?? default` in JS) keeps its default exactly. So the fallback is decided here, after placement, from the
/// reads the template really prints.
fn check_default_shapes(ir: &mut ComponentIR) {
    let mut read: std::collections::BTreeSet<String> = Default::default();
    super::placement::template_server_raws(ir, &mut |r| {
        crate::lower::common::visit_idents(r, &mut |name, kind| {
            if *kind == crate::ir::IdentKind::Prop {
                read.insert(name.to_string());
            }
        });
    });
    let mut defaulted: std::collections::HashSet<String> = Default::default();
    let mut found: Vec<Diagnostic> = Vec::new();
    for p in &ir.props {
        let Some(d) = &p.default else { continue };
        if read.contains(&p.name)
            && let Some((code, why)) = crate::analyze::hooks::default_unprintable(d, &defaulted)
        {
            found.push(Diagnostic::fallback(
                code,
                format!(
                    "the default of the prop `{}` is {why}, which the server template cannot evaluate",
                    p.name
                ),
                d.loc,
                "use a literal, an earlier prop, or a plain expression as the default",
            ));
        }
        defaulted.insert(p.name.clone());
        defaulted.insert(p.local.clone());
    }
    ir.diagnostics.extend(found);
}
