//! Tier decision (spec §3, §8.1) and `needs_worker` (§3.5).
use super::placement::contains_jsx;
use super::{PassCtx, PassState};
use crate::ir::{Attr, ComponentIR, DiagClass, Diagnostic, Expr, Node, Tier};

/// Fallback rules that do not make *this* component React (they concern a child).
const CHILD_ONLY: &[&str] = &["external-component"];

pub fn tier(ir: &mut ComponentIR, st: &mut PassState, ctx: &PassCtx<'_>) {
    check_refs(ir);

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
    } else if ir.state.is_empty()
        && ir.handlers.is_empty()
        && ir.effects.is_empty()
        && ir.refs.is_empty()
        && ir.child_links.is_empty()
        && !has_state_dependent(ir)
    {
        ir.tier = Tier::Static;
    } else {
        ir.tier = Tier::Native;
    }
    // §3.3: a React component's one job is its SSR render over its props;
    // precompute slots and child islands are React's business then.
    if let Tier::React { client_only, .. } = &ir.tier {
        ir.jobs = vec![crate::ir::JobDecl {
            kind: crate::ir::JobKind::Ssr {
                client_only: *client_only,
            },
            // The whole props object (§3.3: "the component's props (JSON)").
            inputs: vec!["*".to_string()],
            outputs: vec![format!("_ssr_{}", ir.id)],
        }];
    }
    ir.needs_worker = !ir.jobs.is_empty();
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
                if let Attr::Dynamic { value, .. } | Attr::Spread(value) = a {
                    f(value);
                }
            }
            children.iter().for_each(|c| visit_exprs(c, f));
        }
        Node::Slot(e) => f(e),
        Node::If { cond, then, else_ } => {
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
        Node::Text(_) => {}
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
            Node::Text(_) | Node::Slot(_) => {}
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
