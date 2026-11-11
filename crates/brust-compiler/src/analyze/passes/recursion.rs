//! F523: a component that renders itself (direct recursion) compiles to ONE template macro, not a React island per node.
//!
//! The children pass records every call the component makes to itself (`PassState::self_calls`) with no fallback,
//! island, job or link, and what the call site itself rules out (`self_refusals`). [`check`] runs after the tier pass,
//! when the final tier and jobs are known: it accepts the calls (`ComponentIR::recursion`, the macro's parameters) or
//! makes the component React with `recursion-unsupported` and the reason. It also refuses a caller that would print a
//! recursive macro in a list row the browser builds (C4). Idempotent: `run_passes` may run the pipeline twice.
use super::{PassCtx, PassState};
use crate::ir::{ComponentIR, Diagnostic, Expr, IdentKind, JobKind, Node, Tier};

/// The rule of every refusal of a recursive component, its call sites, and mutual recursion.
pub const RULE: &str = "recursion-unsupported";

/// The deepest a recursive component may nest (its macro's depth counter); past it the render fails through the
/// `recursion_limit` global of brust-jinja, which names the component. minijinja's own limit is 500 depth units and one
/// level costs about 6-9 (54 levels measured with three nested lists at the call, F523 C0): 32 keeps a 1.5x margin.
pub const RECURSION_CAP: u32 = 32;

pub fn check(ir: &mut ComponentIR, st: &PassState, _ctx: &PassCtx<'_>) {
    ir.recursion = None;
    if let Some(&loc) = st.self_calls.first() {
        let name = display_name(ir);
        let why = match &ir.tier {
            // Already React for a reason of its own: React renders the recursion itself.
            Tier::React { .. } => None,
            Tier::Static => refusal(ir, st),
            Tier::Native | Tier::Pending => Some(refusal(ir, st).unwrap_or_else(|| native_why(ir))),
        };
        match why {
            Some(why) => refuse(ir, format!("<{name}> renders itself and {why}"), loc),
            None if matches!(ir.tier, Tier::Static) => {
                ir.recursion = Some(params(ir));
                ir.holds_recursion = true;
            }
            None => {}
        }
    }
    // C4: the rows the client may re-create are the browser's only when this component has a runtime: a static component
    // prints its rows once (a caller that links it is refused at its own call site, `holds_recursion`). One already React
    // for another reason is told too.
    if !matches!(ir.tier, Tier::Static)
        && let Some((loc, name)) = st.recursion_rows.first().cloned()
    {
        refuse(
            ir,
            format!(
                "<{name}> prints a component that renders itself (a template macro the server prints once), and here it sits in a list row the browser re-creates"
            ),
            loc,
        );
    }
    if matches!(ir.tier, Tier::React { .. }) {
        ir.holds_recursion = false;
    }
    if st.self_calls.is_empty() {
        return;
    }
    // The calls to itself carry the component's own tier (its children entry too: React renders them inside its island).
    let tier = ir.tier.clone();
    let own = ir.id.clone();
    for c in ir
        .children
        .iter_mut()
        .filter(|c| c.id.as_deref() == Some(own.as_str()))
    {
        c.tier = tier.clone();
    }
    set_call_tiers(&mut ir.template, &st.self_calls, &tier);
}

/// Makes the component React for `message` (reported once, however often the pipeline runs); one already React only
/// reports it.
fn refuse(ir: &mut ComponentIR, message: String, loc: u32) {
    if !ir
        .diagnostics
        .iter()
        .any(|d| d.rule == RULE && d.message == message)
    {
        ir.diagnostics.push(Diagnostic::fallback(
            RULE,
            message.clone(),
            loc,
            "make the component static (no state, handlers, effects, refs, stores or `useId`, props named one by one), or keep it in React",
        ));
    }
    ir.recursion = None;
    // Already React for a reason of its own: that reason stays, and its jobs are already React's.
    if matches!(ir.tier, Tier::React { .. }) {
        return;
    }
    ir.tier = Tier::React {
        reason: message,
        client_only: false,
    };
    super::tier::react_jobs(ir);
}

/// The component as its author wrote it: its function's name.
pub fn display_name(ir: &ComponentIR) -> String {
    if let Some(n) = ir.local_name.as_ref().or(ir.export.as_ref()) {
        return n.clone();
    }
    let base = ir.id.rsplit_once('_').map_or(ir.id.as_str(), |(b, _)| b);
    let mut cs = base.chars();
    cs.next()
        .map(|c| c.to_uppercase().collect::<String>() + cs.as_str())
        .unwrap_or_default()
}

/// The macro's parameters: every declared prop, then every other prop the template reads, in order, once.
fn params(ir: &ComponentIR) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in &ir.props {
        if !out.contains(&p.name) {
            out.push(p.name.clone());
        }
    }
    for r in prop_reads(ir) {
        if r != "*" && r != crate::ir::REST_PROPS && !out.contains(&r) {
            out.push(r);
        }
    }
    out
}

/// Every prop name the template (and the derived values it prints) reads, in order.
fn prop_reads(ir: &ComponentIR) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut f = |e: &Expr| {
        if let Expr::Raw(r) | Expr::Server(crate::ir::ServerExpr(r)) = e {
            crate::lower::common::visit_idents(r, &mut |name, kind| {
                if *kind == IdentKind::Prop && !out.iter().any(|o| o == name) {
                    out.push(name.to_string());
                }
            });
        }
    };
    visit(&ir.template, &mut f);
    for d in &ir.derived {
        f(&d.expr);
    }
    for s in &ir.state {
        f(&s.init);
    }
    out
}

fn visit(n: &Node, f: &mut dyn FnMut(&Expr)) {
    match n {
        Node::Element {
            attrs, children, ..
        } => {
            for a in attrs {
                match a {
                    crate::ir::Attr::Dynamic { value, .. }
                    | crate::ir::Attr::Spread(value)
                    | crate::ir::Attr::InnerHtml { value }
                    | crate::ir::Attr::CollectionItem { data: value } => f(value),
                    crate::ir::Attr::Static { .. }
                    | crate::ir::Attr::Event { .. }
                    | crate::ir::Attr::Ref { .. }
                    | crate::ir::Attr::ForwardRef => {}
                }
            }
            children.iter().for_each(|c| visit(c, f));
        }
        Node::Slot(e) => f(e),
        Node::If {
            cond, then, else_, ..
        } => {
            f(cond);
            then.iter().chain(else_).for_each(|c| visit(c, f));
        }
        Node::For {
            source, key, body, ..
        } => {
            f(source);
            f(key);
            body.iter().for_each(|c| visit(c, f));
        }
        Node::Component {
            props, children, ..
        } => {
            props.iter().for_each(|(_, v)| f(v));
            children.iter().for_each(|c| visit(c, f));
        }
        Node::Fragment(cs) => cs.iter().for_each(|c| visit(c, f)),
        Node::Dynamic {
            component, props, ..
        } => {
            f(component);
            f(props);
        }
        Node::Text(_) | Node::Outlet => {}
    }
}

/// Why a static component that calls itself is no macro (`None`: it is one). C3: nothing per instance may remain (the
/// macro body sees its parameters and the render's root context only), and every prop must be nameable as a parameter.
fn refusal(ir: &ComponentIR, st: &PassState) -> Option<String> {
    if ir.specialised || ir.fixed_clone_of.is_some() || ir.rest_clone_of.is_some() {
        return Some(
            "this copy of it is made for one call site, which its calls to itself would not render"
                .into(),
        );
    }
    if let Some((_, why)) = st.self_refusals.first() {
        return Some(why.clone());
    }
    if ir.use_id_slots > 0 {
        return Some("calls `useId`, whose values the server feeds per instance".into());
    }
    if let Some((_, child)) = st.fed_children.first() {
        return Some(format!(
            "renders <{child}>, which has a job or `useId` the server feeds per instance"
        ));
    }
    if let Some(j) = ir.jobs.first() {
        return Some(match j.kind {
            JobKind::Ssr { .. } => {
                "holds a React island, which the server renders per instance".into()
            }
            JobKind::Precompute => {
                "computes a value the template cannot (a server job per instance)".into()
            }
        });
    }
    if !ir.instances.is_empty()
        || !ir.fused.is_empty()
        || !ir.folded_instances.is_empty()
        || !ir.build_eval_instances.is_empty()
    {
        return Some("renders a child with a job or `useId` the server feeds per instance".into());
    }
    if !ir.stores.is_empty() {
        return Some("reads a store".into());
    }
    if !ir.ctx_uses.is_empty() {
        return Some("reads a context".into());
    }
    if !ir.provides.is_empty() {
        return Some("provides a context".into());
    }
    if ir.poly.is_some() {
        return Some("has a polymorphic (`asChild`) element".into());
    }
    if ir.props_rest.is_some()
        || ir.props_whole.is_some()
        || prop_reads(ir)
            .iter()
            .any(|r| r == "*" || r == crate::ir::REST_PROPS)
    {
        return Some(
            "takes the rest of its props (`...rest`) or reads its whole props object, which a call to itself cannot pass prop by prop"
                .into(),
        );
    }
    // A default printed inside the macro reads the other prop by its template name, which is the caller's there.
    for p in &ir.props {
        let mut reads = false;
        if let Some(d) = &p.default {
            crate::lower::common::visit_idents(d, &mut |_, kind| {
                reads |= *kind == IdentKind::Prop;
            });
        }
        if reads {
            return Some(format!(
                "gives the prop `{}` a default that reads another prop",
                p.name
            ));
        }
    }
    for p in params(ir) {
        if p == "children" {
            return Some(
                "takes `children`, which a call to itself would have to pass as markup".into(),
            );
        }
        if let Some((_, what)) = crate::analyze::names::template_name_problem(&p) {
            return Some(format!("has the prop `{p}`, which {what}"));
        }
        if crate::analyze::names::TEMPLATE_OWN.contains(&p.as_str())
            || crate::analyze::names::JINJA_RESERVED_LOCALS.contains(&p.as_str())
        {
            return Some(format!(
                "has the prop `{p}`, a name the server template reserves"
            ));
        }
    }
    None
}

/// Why a component that calls itself needs the client runtime (a macro is printed once, by the server).
fn native_why(ir: &ComponentIR) -> String {
    if !ir.state.is_empty() {
        "has state (`useState`), which a template macro printed by the server cannot keep".into()
    } else if !ir.handlers.is_empty() {
        "binds an event handler, which a template macro printed by the server cannot".into()
    } else if !ir.effects.is_empty() {
        "runs an effect, which a template macro printed by the server cannot".into()
    } else if !ir.refs.is_empty() {
        "takes a ref (`useRef`), which a template macro printed by the server cannot".into()
    } else if ir.stores.iter().any(|s| s.resolved.is_some()) {
        "reads a store, which changes after the server printed the macro".into()
    } else if !ir.child_links.is_empty() {
        "passes a child values that change on the client, which a template macro printed by the server cannot".into()
    } else {
        "needs the client runtime, which a template macro printed by the server cannot have".into()
    }
}

/// The `tier` of the component nodes at `locs` (the calls to itself).
fn set_call_tiers(n: &mut Node, locs: &[u32], tier: &Tier) {
    match n {
        Node::Component {
            loc,
            tier: t,
            children,
            ..
        } => {
            if locs.contains(loc) {
                *t = tier.clone();
            }
            children
                .iter_mut()
                .for_each(|c| set_call_tiers(c, locs, tier));
        }
        Node::Element { children, .. } | Node::Fragment(children) => children
            .iter_mut()
            .for_each(|c| set_call_tiers(c, locs, tier)),
        Node::If { then, else_, .. } => then
            .iter_mut()
            .chain(else_.iter_mut())
            .for_each(|c| set_call_tiers(c, locs, tier)),
        Node::For { body, .. } => body.iter_mut().for_each(|c| set_call_tiers(c, locs, tier)),
        Node::Text(_) | Node::Slot(_) | Node::Outlet | Node::Dynamic { .. } => {}
    }
}
