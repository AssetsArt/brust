//! Child components (spec §3.2 rule 4, §3.4, §7.4): resolve and compile each
//! `<Child/>`, record its tier, link reactive props into native children
//! (`ChildLink`, `_pN`), and turn `react` children into islands rendered by an
//! `Ssr` job — refusing props an island cannot hydrate from.
use super::deps::{Deps, minimal_paths};
use super::{PassCtx, PassState, run_passes};
use crate::analyze::component::finish_diagnostics;
use crate::analyze::exports::{declared_in, declared_member, package_member};
use crate::analyze::modules::{
    Entry, Export, Lookup, cache_key, compile, is_package_source, resolve, resolve_package,
};
use crate::ir::{
    Attr, ChildLink, ChildRef, ComponentIR, DiagClass, Diagnostic, Expr, ExternalRef, IdentKind,
    InstanceRecord, JobDecl, JobKind, JsCtx, Node, PolyTag, RawExpr, RawKind, ServerExpr, Tier,
    UnOp, component_id, named_component_id,
};
use std::collections::{BTreeSet, HashMap};
use std::rc::Rc;

/// The walker over `ir`'s template (shared by the context frames pass and the children pass).
fn walker<'s, 'c>(ir: &ComponentIR, st: &'s mut PassState, ctx: &'c PassCtx<'c>) -> Walker<'s, 'c> {
    // Module consts the folder may read (R34.49): never a name the component body declares, and
    // never one with a use that is not a proven read (an array or object another use could change).
    let shadowed = |n: &str| {
        ir.derived.iter().any(|d| d.name == n)
            || ir.state.iter().any(|d| d.name == n)
            || ir.id_bindings.iter().any(|i| i == n)
            || ir.refs.iter().any(|r| r.name == n)
            || st.handler_names.contains(n)
    };
    let module_consts: Rc<HashMap<String, RawExpr>> = Rc::new(
        ir.module_decls
            .iter()
            .flat_map(|d| d.consts.iter())
            .filter(|c| !c.mutated && !shadowed(&c.name))
            .map(|c| (c.name.clone(), c.value.clone()))
            .collect(),
    );
    Walker {
        module_consts,
        st,
        ctx,
        links: Vec::new(),
        refs: Vec::new(),
        jobs: Vec::new(),
        diagnostics: Vec::new(),
        loop_scope: Vec::new(),
        lists: Vec::new(),
        items: Vec::new(),
        indexes: Vec::new(),
        list_uses: Vec::new(),
        loop_sources: Vec::new(),
        loop_literals: Vec::new(),
        instance_counts: HashMap::new(),
        instances: Vec::new(),
        eval_instances: Vec::new(),
        folded_instances: Vec::new(),
        ssr_outputs: HashMap::new(),
        row_only: HashMap::new(),
        // Props can change on the client unless nothing can reach this component: a child may be
        // linked by its parent (x-props-bind), a component with state of its own is a host whose
        // props are settable. Only a stateless root (a route component) has fixed props.
        props_reactive: !ctx.is_root
            || !ir.state.is_empty()
            || !ir.effects.is_empty()
            || !ir.handlers.is_empty()
            || !ir.refs.is_empty(),
        props_live: ir.props_are_signal(),
        hold_link: false,
        module_rows: std::cell::Cell::new(0),
        seed_props: if ir.props_are_signal() {
            snapshot_only_props(ir)
        } else {
            BTreeSet::new()
        },
        handlers: Vec::new(),
        own_named: ir.props.iter().map(|p| p.name.clone()).collect(),
        own_scopes: ir
            .props
            .iter()
            .filter(|p| p.name.starts_with("__scope") && p.local == p.name && p.default.is_none())
            .map(|p| p.name.clone())
            .collect(),
        // The contexts pass (a walker of its own, before this one) may add some (a forwarded scope).
        absent: ir.absent_props.iter().cloned().collect(),
        holes: None,
        unwritten: BTreeSet::new(),
        shadowed: BTreeSet::new(),
        shadowed_input: BTreeSet::new(),
        live_forwards: Vec::new(),
        live_props: Vec::new(),
        own_refs: ir.refs.iter().map(|r| r.name.clone()).collect(),
        sink_refs: ir.sink_refs.iter().cloned().collect(),
        ref_nulled: false,
        carry_sites: Vec::new(),
        passes_to_repeater: false,
        passes_to_host: false,
        own_fed: crate::ir::is_fed(ir),
        own_job: ir
            .jobs
            .iter()
            .any(|j| matches!(j.kind, crate::ir::JobKind::Precompute)),
        guard_depth: 0,
        slot_depth: 0,
        spec_salt: (ir.rest_clone_of.is_some() || ir.specialised).then(|| ir.id.clone()),
        no_text: false,
        mount_once: Vec::new(),
        frozen: BTreeSet::new(),
        callable_up: BTreeSet::new(),
        state_inits: ir
            .state
            .iter()
            .map(|s| (s.name.clone(), s.init.clone()))
            .collect(),
        written_inits: ir
            .structural
            .as_deref()
            .map(|st| {
                st.state
                    .iter()
                    .filter_map(|s| match &s.init {
                        Expr::Raw(r) => Some((s.name.clone(), r.clone())),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default(),
        fused: Vec::new(),
        fused_counts: HashMap::new(),
        holds_island: false,
        children_no_text: false,
        provider_locs: Default::default(),
        next_owner: 0,
        native_props: Vec::new(),
        renders: Vec::new(),
        module_names: ir
            .module_decls
            .iter()
            .flat_map(|d| d.names.iter().cloned())
            .collect(),
        fixed_props: ir.fixed_props.iter().cloned().collect(),
        row_handlers: ir
            .handlers
            .iter()
            .filter(|h| !h.item_scoped.is_empty())
            .map(|h| h.name.clone())
            .collect(),
        no_spec: Default::default(),
        shared_locs: BTreeSet::new(),
        spec_failure: None,
        bubbled_pkg: false,
        bubbled_scoped: Vec::new(),
        ctx_defaults: Vec::new(),
        foreign: Default::default(),
    }
}

/// The Provider modules whose helpers a substituted context value calls: alias → (the module's component, names).
type ForeignModules = std::collections::BTreeMap<String, (Rc<ComponentIR>, BTreeSet<String>)>;

/// Cut scope (lead ruling on 84a4650a): a frame VALUE, as it reads at the call site, must be a literal (or operators,
/// templates, arrays and objects over literals and globals). NO prop or state read (it may carry an element), no call (a
/// helper may return one), no import, no module name, no element. Everything that crosses a frame is then primitive.
fn plain_frame_value(r: &RawExpr) -> Result<(), String> {
    match &r.kind {
        RawKind::Lit(_) => Ok(()),
        RawKind::Ident { name, kind } => match kind {
            IdentKind::Global => Ok(()),
            IdentKind::Prop
            | IdentKind::State
            | IdentKind::LoopBinding
            | IdentKind::Local
            | IdentKind::Setter
            | IdentKind::Import { .. }
            | IdentKind::Store { .. }
            | IdentKind::Unknown => Err(format!("a read of `{name}`, which is not plain data")),
        },
        RawKind::Member { target, .. } => plain_frame_value(target),
        RawKind::Index { target, index } => {
            plain_frame_value(target).and_then(|()| plain_frame_value(index))
        }
        RawKind::Call { .. } => Err("a call (its result may be an element)".into()),
        RawKind::Binary { left, right, .. } => {
            plain_frame_value(left).and_then(|()| plain_frame_value(right))
        }
        RawKind::Unary { value, .. } => plain_frame_value(value),
        RawKind::Cond { test, yes, no } => plain_frame_value(test)
            .and_then(|()| plain_frame_value(yes))
            .and_then(|()| plain_frame_value(no)),
        RawKind::Template { parts, .. } => parts.iter().try_for_each(|(p, _)| plain_frame_value(p)),
        RawKind::Array(xs) => xs.iter().try_for_each(plain_frame_value),
        RawKind::Object(ps) => ps.iter().try_for_each(|(_, v)| plain_frame_value(v)),
        RawKind::Arrow { .. } | RawKind::Jsx(_) | RawKind::Opaque { .. } => {
            Err("a function or an element".into())
        }
    }
}

/// What a context Provider hands to the consumers under it (S2, R34.102): each field an expression of the scope that
/// renders the Provider component (its call site), not of the Provider's own body.
struct Frame {
    context: String,
    fields: Vec<(String, RawExpr)>,
    /// R34.116: the fields are expressions of the Provider component's OWN scope (state, a handler, ...), not of the call
    /// site: the Provider is specialised for this call site (R34.122) and the consumers are spliced into the clone.
    /// The number identifies that Provider instance.
    owner: Option<usize>,
    /// The location of the Provider's call site (what a specialisation failure is reported against).
    loc: u32,
    /// W1d PR 2: the Provider named a `scope`.
    scoped: bool,
}

/// S2 context lowering, BEFORE placement (R34.102-R34.104): a Provider component's value fields become hidden props
/// (`ir::ctx_prop`) of every consumer instance under it, so the inlined consumer, its jobs and its template read
/// them like any prop. A consumer with no Provider in this template bubbles its need up: the component declares the
/// hidden prop itself and its own call site fills it (a wrapper around a consumer stays a plain component); only a
/// route component with an unfilled need falls back (`context-no-provider`).
pub fn contexts(
    ir: &mut ComponentIR,
    st: &mut PassState,
    ctx: &PassCtx<'_>,
) -> std::collections::BTreeSet<u32> {
    let mut w = walker(ir, st, ctx);
    w.renders = std::mem::take(&mut ir.render_props);
    let mut template = std::mem::replace(&mut ir.template, Node::Fragment(vec![]));
    let mut frames: Vec<Frame> = Vec::new();
    let mut bubbled: Vec<(String, String)> = Vec::new();
    let mut diags: Vec<Diagnostic> = Vec::new();
    w.shared_locs = shared_component_locs(&template);
    w.frames_node(&mut template, &mut frames, &mut bubbled, &mut diags);
    ir.template = template;
    // The Provider module's helpers the substituted values call, as module declarations of this component (S2).
    for (alias, (cir, names)) in std::mem::take(&mut *w.foreign.borrow_mut()) {
        let mut imports = BTreeSet::new();
        let code = crate::lower::common::module_code(&cir, &names, &mut imports);
        let exports = names.iter().cloned().collect::<Vec<_>>().join(", ");
        ir.module_decls.push(crate::ir::ModuleDecl {
            names: vec![alias.clone()],
            source: format!("const {alias} = (() => {{\n{code}return {{ {exports} }}\n}})()"),
            consts: Vec::new(),
        });
        ir.module_scope.push((
            alias,
            imports
                .into_iter()
                .map(|(local, source, imported)| (local, IdentKind::Import { source, imported }))
                .collect(),
        ));
    }
    ir.ctx_pkg |= w.bubbled_pkg;
    ir.absent_props = w.absent.iter().cloned().collect();
    ir.forwarded_ref_nulled |= w.ref_nulled;
    carried_poly(ir, &w.carry_sites);
    for c in std::mem::take(&mut w.bubbled_scoped) {
        if !ir.ctx_scoped.contains(&c) {
            ir.ctx_scoped.push(c);
        }
    }
    // R34.142: a whole-value need no Provider answers is, at the page, the context's default (React's own rule)
    let defaulted = |c: &str, f: &str| {
        ctx.is_root
            && f == crate::analyze::hooks::WHOLE_FIELD
            && w.ctx_defaults.iter().any(|(x, _)| x == c)
    };
    // F419: the page's own read of a scalar context (`useContext(Ctx)` in the page itself) is the default too.
    if ctx.is_root {
        for u in &ir.ctx_uses {
            let Some((_, d)) = ir.ctx_defaults.iter().find(|(c, _)| c == &u.context) else {
                continue;
            };
            let name = crate::ir::ctx_prop(&u.context, crate::analyze::hooks::WHOLE_FIELD);
            if let Some(p) = ir
                .props
                .iter_mut()
                .find(|p| p.name == name && p.default.is_none())
            {
                p.default = Some(RawExpr {
                    loc: 0,
                    kind: RawKind::Lit(d.clone()),
                });
            }
        }
    }
    for (c, f) in &bubbled {
        let name = crate::ir::ctx_prop(c, f);
        if !ir.props.iter().any(|p| p.name == name) {
            ir.props.push(crate::ir::PropDecl {
                name: name.clone(),
                local: name,
                ts_type: None,
                default: w
                    .ctx_defaults
                    .iter()
                    .find(|(x, _)| x == c)
                    .filter(|_| defaulted(c, f))
                    .map(|(_, d)| RawExpr {
                        loc: 0,
                        kind: RawKind::Lit(d.clone()),
                    }),
            });
        }
        match ir.ctx_uses.iter_mut().find(|u| &u.context == c) {
            Some(u) if !u.fields.contains(f) => u.fields.push(f.clone()),
            Some(_) => {}
            None => ir.ctx_uses.push(crate::ir::CtxUse {
                context: c.clone(),
                fields: vec![f.clone()],
            }),
        }
    }
    for (c, d) in &w.ctx_defaults {
        if bubbled.iter().any(|(x, _)| x == c) && !ir.ctx_defaults.iter().any(|(x, _)| x == c) {
            ir.ctx_defaults.push((c.clone(), d.clone()));
        }
    }
    // F419 (ruling 2): the page's own read of a context with no scalar default (an object default, whose per-field defaults
    // are not modelled) has no Provider above it either; paint nothing wrong: name it and fall back.
    let own_unanswered = || {
        ir.ctx_uses.iter().find(|u| {
            !ir.ctx_defaults.iter().any(|(c, _)| c == &u.context)
                && !bubbled.iter().any(|(c, _)| c == &u.context)
        })
    };
    if ctx.is_root
        && let Some(u) = own_unanswered()
    {
        diags.push(Diagnostic::fallback(
            "context-no-provider",
            format!("`{}` reads a context that no Provider above it provides, and its default is not a plain value", u.context),
            0,
            "render it inside the Provider component, or keep this component in React",
        ));
    }
    if let Some((c, _)) = bubbled.iter().find(|(c, f)| !defaulted(c, f))
        && ctx.is_root
    {
        diags.push(Diagnostic::fallback(
            "context-no-provider",
            format!("`{c}` reads a context that no Provider above it provides"),
            0,
            "render it inside the Provider component, or keep this component in React",
        ));
    }
    ir.diagnostics.extend(diags);
    w.provider_locs
}

pub fn children(ir: &mut ComponentIR, st: &mut PassState, ctx: &PassCtx<'_>) {
    let mut w = walker(ir, st, ctx);
    let mut template = std::mem::replace(&mut ir.template, Node::Fragment(vec![]));
    w.node(&mut template);
    ir.repeats_children = w.passes_to_repeater || template_has_for(&template);
    ir.hosts_children = w.passes_to_host;
    ir.mount_once = std::mem::take(&mut w.mount_once);
    if !w.fused.is_empty() {
        // R34.96: the job of this component also runs its fused children's jobs: their renamed outputs are its
        // outputs, and the props they read are its inputs (the caller's record maps them, A4).
        if let Some(job) = ir
            .jobs
            .iter_mut()
            .find(|j| matches!(j.kind, crate::ir::JobKind::Precompute))
        {
            for f in &w.fused {
                job.outputs.extend(f.outputs.values().cloned());
                for i in f.inputs.values() {
                    if let crate::ir::FusedInput::Prop { path } = i {
                        let root = path.split(['.', '[']).next().unwrap_or(path);
                        let input = format!("props.{root}");
                        if !job.inputs.iter().any(|x| x == &input || x == "*") {
                            job.inputs.push(input);
                        }
                    }
                }
            }
        }
        ir.fused = std::mem::take(&mut w.fused);
    }
    w.resolve_row_only(std::slice::from_mut(&mut template), false);
    debug_assert!(
        w.row_only.is_empty(),
        "every RowOnly link is visited by resolve_row_only"
    );
    ir.template = template;
    for name in std::mem::take(&mut w.callable_up) {
        if !ir.callable_props.contains(&name) {
            ir.callable_props.push(name);
        }
    }
    w.frozen.extend(ir.callable_props.iter().cloned());
    w.frozen.extend(ir.throw_props.iter().cloned());
    ir.frozen_props = std::mem::take(&mut w.frozen).into_iter().collect();
    ir.seed_props = std::mem::take(&mut w.seed_props).into_iter().collect();
    // A list or condition the children lowered folded its slot away: the precompute job no longer
    // computes what no node reads (the server would warn about the missing output on every request).
    let mut live = BTreeSet::new();
    super::placement::collect_slots(ir, &mut |slot, _, _| {
        live.insert(slot.to_string());
    });
    for j in ir
        .jobs
        .iter_mut()
        .filter(|j| matches!(j.kind, crate::ir::JobKind::Precompute))
    {
        // A fused child's slots are read by the printer through the renamed outputs (R34.96), not by a node.
        j.outputs.retain(|o| {
            live.contains(o) || ir.fused.iter().any(|f| f.outputs.values().any(|x| x == o))
        });
    }
    ir.jobs
        .retain(|j| !(matches!(j.kind, crate::ir::JobKind::Precompute) && j.outputs.is_empty()));
    ir.child_links.extend(w.links);
    ir.instances.extend(w.instances);
    ir.build_eval_instances.extend(w.eval_instances);
    ir.folded_instances.extend(w.folded_instances);
    ir.holds_island |= w.holds_island;
    ir.children_no_text |= w.children_no_text || children_in_no_text(&ir.template, false);
    ir.children.extend(w.refs);
    ir.absent_props = w.absent.iter().cloned().collect();
    ir.forwarded_ref_nulled |= w.ref_nulled;
    carried_poly(ir, &w.carry_sites);
    ir.unwritten_props = w.unwritten.iter().cloned().collect();
    ir.shadowed_props = w.shadowed.iter().cloned().collect();
    ir.shadowed_input = w.shadowed_input.iter().cloned().collect();
    ir.live_forwards.extend(w.live_forwards);
    ir.live_props.extend(w.live_props);
    ir.jobs.extend(w.jobs);
    ir.diagnostics.extend(w.diagnostics);
    ir.handlers.extend(w.handlers);
}

struct Walker<'s, 'c> {
    /// F388 (Mellow N1): the node being read sits directly in an element whose content model takes no text.
    no_text: bool,
    /// Foldable module `const` initializers by name (see `children`).
    module_consts: Rc<HashMap<String, RawExpr>>,
    st: &'s mut PassState,
    ctx: &'s PassCtx<'c>,
    links: Vec<ChildLink>,
    refs: Vec<ChildRef>,
    jobs: Vec<JobDecl>,
    diagnostics: Vec<Diagnostic>,
    loop_scope: Vec<String>,
    /// Prop paths of the enclosing `For` sources, and whether the source
    /// reads state.
    lists: Vec<(Vec<String>, bool)>,
    /// Item bindings of the enclosing `For`s, innermost last.
    items: Vec<String>,
    /// Index bindings of the enclosing `For`s, aligned with `items`.
    indexes: Vec<Option<String>>,
    /// The enclosing `For` sources as client reads, used when a linked child sits in the row.
    list_uses: Vec<super::ClientUse>,
    /// The enclosing `For` sources as props paths (`None` = not a plain path).
    loop_sources: Vec<Option<String>>,
    /// The enclosing `For` sources as compile-time constant arrays (F142 R34.43), aligned.
    loop_literals: Vec<Option<serde_json::Value>>,
    instance_counts: HashMap<String, u32>,
    instances: Vec<InstanceRecord>,
    /// Instances whose child job the build may run once (F149, R34.88-R34.90).
    eval_instances: Vec<crate::ir::BuildEvalInstance>,
    /// Instances the build ran (the recompile): no record, their slots are literals.
    folded_instances: Vec<crate::ir::FoldedInstance>,
    ssr_outputs: HashMap<String, u32>,
    /// `RowOnly` links by id with the client reads they imply, resolved after the walk.
    /// With the child's name and location when it derives values from its props on the server (F96d).
    row_only: HashMap<u32, RowOnlyLink>,
    /// Whether this component's own props can change after first paint (see `children`).
    props_reactive: bool,
    /// F320: this component's props are a signal on the client wherever it renders: it has an instance of its own
    /// (state, effects, handlers, refs), so its chunk reads `props()` and every caller that passes a changing value
    /// links it (lowering binds such a read in a slot already, F96d; `lower::template::expr_reactive` agrees). A
    /// stateless component's props change only where a caller links it, which its compile cannot know (F75: a child's
    /// IR depends only on its own subtree): F319's freeze answers for it per call site.
    props_live: bool,
    /// F320: this component's props read only as a cell's first value (`ComponentIR::seed_props`).
    seed_props: BTreeSet<String>,
    /// F320: the call site being walked keeps F319's freeze instead of a link that only a changing prop would ask for,
    /// because the child binds a handler on its own element (`forward_handlers`), which needs an unlinked instance.
    hold_link: bool,
    /// F325: lists being walked whose source reads module-level data (`lower::template::module_source`): inside them no
    /// prop counts as changing, so their rows keep F319's freeze and the chunk ships none of that data.
    module_rows: std::cell::Cell<usize>,
    /// Handlers hoisted from props a static child spreads onto an element (shadcn S1.3).
    handlers: Vec<crate::ir::HandlerDecl>,
    /// This component's named props (its `...rest` holds every other key).
    own_named: BTreeSet<String>,
    /// switch-provider-chain: this component's own `__scope*` props, read under their own name with no default.
    own_scopes: BTreeSet<String>,
    /// Keys this component's own call sites must not pass (`ComponentIR::absent_props`, F153c).
    absent: BTreeSet<String>,
    /// S2 F3: a child of this template is a React island, or holds one.
    holds_island: bool,
    /// F388 (Mellow N1): a `{children}` of this component reaches a child that prints its children where no text can sit.
    children_no_text: bool,
    /// S2: component instances that push a Provider frame.
    provider_locs: std::collections::BTreeSet<u32>,
    /// R34.116: the number of native Provider instances met so far (their frame owner ids).
    next_owner: usize,
    /// R34.116: the hidden context props a native frame filled, as (consumer location, prop, frame owner).
    native_props: Vec<(u32, String, usize)>,
    /// S2: names declared at module level of the component's module (a call-site name among them cannot be carried).
    module_names: BTreeSet<String>,
    /// S2: props the call site fixes for the life of this (specialised) component.
    fixed_props: BTreeSet<String>,
    /// S2: the handlers of this component declared in a list row (they read the row's bindings).
    row_handlers: BTreeSet<String>,
    /// B7: the render-prop arrows this component writes, until the Component node that passes one takes it.
    renders: Vec<crate::ir::RenderProp>,
    /// R34.122: call sites (by location) whose specialisation failed; they are read as island Providers.
    no_spec: std::collections::HashSet<u32>,
    /// F344 (Mellow N1): component call sites of this template that share a source offset. A host clone is keyed by its
    /// call site's offset (`host_spec`, `host_wanted`), and content spliced from another module (a clone's content,
    /// R34.123/F307) keeps that module's offsets, so two sites can share one: neither is specialised (fail closed).
    shared_locs: BTreeSet<u32>,
    /// R34.122: the location and reason of the specialisation that just failed.
    spec_failure: Option<(u32, String)>,
    /// A need bubbled out of a package-source consumer ([`ComponentIR::ctx_pkg`]).
    bubbled_pkg: bool,
    /// W1d PR 2: contexts a scoped consumer bubbled up (no Provider answered it here).
    bubbled_scoped: Vec<String>,
    /// R34.142: the literal defaults of the scalar contexts the bubbled needs name.
    ctx_defaults: Vec<(String, crate::ir::Literal)>,
    /// S2: names of a Provider's module that a substituted context value reads, per Provider component (the alias
    /// of its module scope in this component's jobs, the component, the names).
    foreign: std::cell::RefCell<ForeignModules>,
    /// F148a: while the children or element props of a React island lower, the props the tree reads from this
    /// component's own props (R34.116): the hole's island prop name (`$p<N>`, `$c<N>`) and the expression it takes.
    holes: Option<Vec<(String, Expr)>>,
    /// Keys this component's own call sites must not write (`ComponentIR::unwritten_props`, F164).
    unwritten: BTreeSet<String>,
    /// Keys this component's own call sites must not write because it binds them live ahead of a spread of its
    /// own rest (`ComponentIR::shadowed_props`).
    shadowed: BTreeSet<String>,
    /// Keys the `__in_rest` its call sites pass must not carry (`ComponentIR::shadowed_input`).
    shadowed_input: BTreeSet<String>,
    /// Live props hoisted onto a static child's element (`ComponentIR::live_forwards`).
    live_forwards: Vec<crate::ir::Forwarded>,
    /// Live props of a native child that its element binds itself (`ComponentIR::live_props`, F329b).
    live_props: Vec<crate::ir::Forwarded>,
    /// The ref cells of this component (F267).
    own_refs: BTreeSet<String>,
    /// F329: `ComponentIR::sink_refs`.
    sink_refs: BTreeSet<String>,
    /// A child this component passes its forwarded ref to reads it as `null` (`ComponentIR::forwarded_ref_nulled`).
    ref_nulled: bool,
    /// F369a: the polymorphic children this component spreads its whole rest into, and whether each is a site a carrier
    /// may be recognised at (see [`Walker::carry_site`]).
    carry_sites: Vec<(PolyTag, bool)>,
    /// Slot content handed to a component that repeats it (`ComponentIR::repeats_children`, F169).
    passes_to_repeater: bool,
    /// This component hands its own `{children}` to a component that prints them under a native host element
    /// (`ComponentIR::hosts_children`, F214).
    passes_to_host: bool,
    /// This component runs a precompute job of its own, or has `useId` values: its caller feeds it per instance.
    own_fed: bool,
    /// ... and a `Precompute` job exists for fused children to join (R34.96).
    own_job: bool,
    /// Open `If` branches: a fused child's job would run whether or not the branch renders (v1: refused).
    guard_depth: u32,
    /// F277: open component children (slot content): the host may print them conditionally, or once per row.
    slot_depth: u32,
    /// F298: this component is a clone (a rest clone, `ComponentIR::rest_clone_of`, or any specialised one: F307 found
    /// two routes' Provider clones naming the same host clone inside them): its id, mixed into the ids and cache keys of
    /// the clones made inside it.
    spec_salt: Option<String>,
    /// F295: what makes an instance of this component unable to mount again (`ComponentIR::mount_once`).
    mount_once: Vec<String>,
    /// F319: props read where a change would not be followed (`ComponentIR::frozen_props`).
    frozen: BTreeSet<String>,
    /// W1d (progress): this component spreads its own props/rest onto a child that may call a function prop, so its
    /// own callers must not pass one under those names (`callable_props` gains them; F340: only the child's names, not
    /// every key such as a `className`).
    callable_up: BTreeSet<String>,
    /// F277: this component's state cells by name: their initial values (a cell is its initial value at mount).
    state_inits: HashMap<String, Expr>,
    /// F337 (M2, Mellow A5): each state's initializer as written (structural IR), so a lazy one (`useState(() => …)`,
    /// which placement turns into its value) is never mistaken for a literal seed.
    written_inits: HashMap<String, RawExpr>,
    /// Children whose jobs run inside this component's job (`ComponentIR::fused`).
    fused: Vec<crate::ir::FusedInstance>,
    fused_counts: HashMap<String, u32>,
}

/// The largest constant list (JSON bytes) a per-row-literal instance carries in the manifest
/// (F142 R34.43, ruling Q3: the same cap as island-children's per-instance tree).
const MAX_ROWS_JSON: usize = 64 * 1024;

/// A resolved child.
struct Child {
    id: Option<String>,
    path: Option<String>,
    tier: Tier,
    /// The compiled child has a precompute job, an island's ssr render or `useId` values the server
    /// must feed per instance (`ir::is_fed`).
    fed: bool,
    /// The compiled child reads a resolved store at render, or a job of its reads `__store` (C5; an
    /// island's ssr render always does).
    stores: bool,
    /// The compiled child has a precompute job (or an island's ssr render, L4) over its props: the
    /// server computes it once, so a link that changes those props later would leave it stale (F96d).
    prop_precompute: bool,
    /// F337: ... but every value it precomputes over props is one its chunk recomputes when they change (only
    /// Precompute jobs, `ComponentIR::props_slots_recomputable`, props a signal): a link may change them.
    recomputes: bool,
    /// Where the child spreads its props (shadcn S1.2): the call-site keys that land in a spread.
    spread: SpreadSink,
    /// The child's polymorphic tag (`asChild`, R34.28): the call site must resolve it.
    poly: Option<PolyTag>,
    /// The polymorphic element spreads an object of keys known only at render (a props path, not the
    /// props or their rest): a class or style the `asChild` child brings cannot be merged with it at
    /// compile time.
    poly_runtime_spread: bool,
    /// What else the child does with those keys, for a handler the parent may bind (shadcn S1.3).
    onward: HandlerSink,
    /// The props roots the compiled child's jobs read (the server feeds each instance these).
    job_roots: BTreeSet<String>,
    /// A job of the child reads the whole props object (`*`).
    job_all: bool,
    /// The compiled child is a `forwardRef` component (R34.63): a call site that passes `ref` needs React.
    forwards_ref: bool,
    /// F267: the compiled child hands the ref its caller passes to exactly one element it always renders
    /// (`ref={forwardedRef}` on a host element outside any list or condition).
    ref_site: bool,
    /// The compiled child spreads its props onto an inlined lucide icon (R34.77).
    icon_spread: bool,
    /// The compiled child reads `children` as a value (`children ?? <X/>`, `children ? a : b`), not only as `{children}`:
    /// an inlined instance has the markup, not a value to test.
    reads_children_value: bool,
    /// F300: the component hands its whole `...rest` to a specialised Provider as data (`__in_rest`, F278), and JSX
    /// children are not data: the ones a caller gives would be dropped from what the clone spreads.
    rest_as_data: bool,
    /// The compiled child has `useId` values (the server seeds them per instance, per row).
    use_id: bool,
    /// A static child that is not fed itself but has fed children of its own (F164 re-base).
    inner: Option<Inner>,
    /// The compiled child's template repeats something in a list (a `For`): slot content is printed once and pasted per row.
    has_for: bool,
    /// The slot content given to this child is printed under a native host element that is not the caller's (F214): the
    /// child is native and renders `{children}`, or passes its `{children}` on to one that does.
    hosts_children: bool,
    /// Keys the call site must not pass (`ComponentIR::absent_props`).
    absent: Vec<String>,
    /// The compiled child (S2 context frames read its `provides` / `ctx_uses` / props / derived).
    ir: Option<Rc<ComponentIR>>,
    /// Whether the build may run the child's precompute job for a constant-input instance (F149,
    /// `build_eval::instance_job`); `None` when the child is not fed.
    job_eval: Option<Result<Vec<crate::ir::EvalStub>, String>>,
    /// The child's job outputs (`_sN`), all of which an evaluated instance must get.
    job_outputs: Vec<String>,
    /// The job modules fused into the child's job (R34.96), which an evaluated instance stages too.
    job_fused: Vec<crate::ir::FusedEvalJob>,
    /// Keys the call site must not write at all (`ComponentIR::unwritten_props`).
    unwritten: Vec<String>,
    /// Keys the call site must not write at all (`ComponentIR::shadowed_props`).
    shadowed: Vec<String>,
    /// Keys the call site's `__in_rest` must not carry (`ComponentIR::shadowed_input`).
    shadowed_input: Vec<String>,
}

/// F267: the number of `ref={forwardedRef}` elements of `n` that always render (`always`: not inside a list, a
/// condition or a component's children); `None` when one sits where it does not.
fn forward_ref_sites(n: &Node, always: bool) -> Option<usize> {
    match n {
        Node::Element {
            attrs, children, ..
        } => {
            let own = attrs
                .iter()
                .filter(|a| matches!(a, Attr::ForwardRef))
                .count();
            if own > 0 && !always {
                return None;
            }
            let mut total = own;
            for c in children {
                total += forward_ref_sites(c, always)?;
            }
            Some(total)
        }
        Node::Fragment(cs) => cs
            .iter()
            .try_fold(0, |t, c| forward_ref_sites(c, always).map(|x| t + x)),
        Node::If { then, else_, .. } => then
            .iter()
            .chain(else_.iter())
            .try_fold(0, |t, c| forward_ref_sites(c, false).map(|x| t + x)),
        Node::For { body, .. } => body
            .iter()
            .try_fold(0, |t, c| forward_ref_sites(c, false).map(|x| t + x)),
        Node::Component { children, .. } => children
            .iter()
            .try_fold(0, |t, c| forward_ref_sites(c, false).map(|x| t + x)),
        Node::Text(_) | Node::Slot(_) | Node::Outlet => Some(0),
    }
}

/// Facts that decide whether a handler landing in a static child's spread can be bound by the
/// parent on the child's element (shadcn S1.3, R34.18). The default refuses every key.
#[derive(Clone, Debug, Default)]
struct HandlerSink {
    /// The keys the child spreads into another component (a binding would be needed there).
    components: SpreadSink,
    /// Prop roots the child reads by name outside its spreads; `None` = the whole props object.
    reads: Option<BTreeSet<String>>,
    /// Spreads of the child's props or its rest, anywhere in its template (elements and components): a live value
    /// is bound on the one element a single spread lands on (2b-handlers C2; a child that reads its rest as a value is
    /// React already, `prop-pattern`).
    spread_sites: usize,
}

impl HandlerSink {
    fn of(ir: &ComponentIR) -> HandlerSink {
        let mut t = ir.template.clone();
        strip_spreads(&mut t);
        let cx = super::deps::DepsCx::new(ir);
        let mut d = cx.deps_node(&t, &[]);
        for h in &ir.handlers {
            d.union(&cx.deps(&h.body, &h.item_scoped));
        }
        for e in &ir.effects {
            d.union(&cx.deps(&e.body, &[]));
        }
        let roots = d.prop_roots();
        HandlerSink {
            components: SpreadSink::of_where(ir, false),
            reads: (!roots.contains("*")).then_some(roots),
            spread_sites: count_prop_spreads(&ir.template),
        }
    }
}

/// The polymorphic element of `n` carries a spread that is neither the props nor their rest (a
/// props path such as `{...attrs}`): its keys are known only at render.
fn poly_has_runtime_spread(n: &Node) -> bool {
    match n {
        Node::Element {
            poly,
            attrs,
            children,
            ..
        } => {
            (*poly
                && attrs.iter().any(|a| match a {
                    Attr::Spread(Expr::Raw(r) | Expr::Server(ServerExpr(r))) => !matches!(
                        &r.kind,
                        RawKind::Ident { name, kind: IdentKind::Prop }
                            if name == "*" || name == crate::ir::REST_PROPS
                    ),
                    Attr::Spread(_) => true,
                    _ => false,
                }))
                || children.iter().any(poly_has_runtime_spread)
        }
        Node::Fragment(cs) => cs.iter().any(poly_has_runtime_spread),
        Node::If { then, else_, .. } => then.iter().chain(else_).any(poly_has_runtime_spread),
        Node::For { body, .. } => body.iter().any(poly_has_runtime_spread),
        Node::Component { children, .. } => children.iter().any(poly_has_runtime_spread),
        Node::Text(_) | Node::Slot(_) | Node::Outlet => false,
    }
}

/// F369a: a component whose ONE polymorphic child gets the whole rest of its props (`<Primitive.span {...rest}/>`, Radix
/// `RovingFocusGroup.Item`) passes `asChild` straight to that element, so it is polymorphic itself: its call sites resolve the
/// flag (`check_poly`) instead of being told to leave it out (`absent_props`, F153c). Anywhere the flag might not reach the
/// element unchanged keeps the old requirement.
fn carried_poly(ir: &mut ComponentIR, sites: &[(PolyTag, bool)]) {
    let [(poly, true)] = sites else {
        return;
    };
    if ir.poly.is_some() {
        return;
    }
    // the rest has no other consumer: a second element or value reading it would print `asChild` / `children` as React does
    // not (React hands the flag to the Slot and its children to the clone)
    if rest_consumers(&ir.template, &poly.flag) != 1 {
        return;
    }
    ir.absent_props.retain(|k| k != &poly.flag);
    ir.poly = Some(poly.clone());
}

/// Whether `r` reads the component's rest or props object, other than as `<rest>.<flag>` (a read of the flag itself inside a
/// carrier is allowed on purpose: the flag still reaches the polymorphic child through the spread).
fn reads_rest(r: &RawExpr, flag: &str) -> bool {
    let rest = |x: &RawExpr| {
        matches!(&x.kind, RawKind::Ident { name, kind: IdentKind::Prop }
            if name == "*" || name == crate::ir::REST_PROPS)
    };
    match &r.kind {
        RawKind::Ident { .. } => rest(r),
        RawKind::Member { target, name, .. } if rest(target) => name != flag,
        RawKind::Member { target, .. } => reads_rest(target, flag),
        RawKind::Index { target, index } => reads_rest(target, flag) || reads_rest(index, flag),
        RawKind::Call { callee, args } => {
            reads_rest(callee, flag) || args.iter().any(|a| reads_rest(a, flag))
        }
        RawKind::Binary { left, right, .. } => reads_rest(left, flag) || reads_rest(right, flag),
        RawKind::Unary { value, .. } => reads_rest(value, flag),
        RawKind::Cond { test, yes, no } => {
            reads_rest(test, flag) || reads_rest(yes, flag) || reads_rest(no, flag)
        }
        RawKind::Template { parts, .. } => parts.iter().any(|(p, _)| reads_rest(p, flag)),
        RawKind::Array(xs) => xs.iter().any(|x| reads_rest(x, flag)),
        RawKind::Object(ps) => ps.iter().any(|(_, v)| reads_rest(v, flag)),
        RawKind::Lit(_) => false,
        // a function or code outside the subset: it may read anything
        RawKind::Arrow { .. } | RawKind::Jsx(_) | RawKind::Opaque { .. } => true,
    }
}

/// How many places of `n` consume the component's rest or props: each spread of the whole rest, each other read of it.
fn rest_consumers(n: &Node, flag: &str) -> usize {
    let expr_reads = |e: &Expr| match e {
        Expr::Raw(r) | Expr::Server(ServerExpr(r)) => usize::from(reads_rest(r, flag)),
        Expr::ClientOnly { .. } | Expr::Precomputed { .. } => 0,
    };
    let whole = |e: &Expr| {
        matches!(e, Expr::Raw(r) | Expr::Server(ServerExpr(r)) if matches!(&r.kind,
            RawKind::Ident { name, kind: IdentKind::Prop } if name == "*" || name == crate::ir::REST_PROPS))
    };
    match n {
        Node::Element {
            attrs, children, ..
        } => {
            attrs
                .iter()
                .map(|a| match a {
                    Attr::Spread(v) if whole(v) => 1,
                    Attr::Spread(v)
                    | Attr::Dynamic { value: v, .. }
                    | Attr::InnerHtml { value: v } => expr_reads(v),
                    _ => 0,
                })
                .sum::<usize>()
                + children
                    .iter()
                    .map(|c| rest_consumers(c, flag))
                    .sum::<usize>()
        }
        Node::Component {
            props, children, ..
        } => {
            props
                .iter()
                .map(|(k, v)| {
                    if k == crate::ir::SPREAD_KEY && whole(v) {
                        1
                    } else {
                        expr_reads(v)
                    }
                })
                .sum::<usize>()
                + children
                    .iter()
                    .map(|c| rest_consumers(c, flag))
                    .sum::<usize>()
        }
        Node::Slot(e) => expr_reads(e),
        Node::If {
            cond, then, else_, ..
        } => {
            expr_reads(cond)
                + then
                    .iter()
                    .chain(else_)
                    .map(|c| rest_consumers(c, flag))
                    .sum::<usize>()
        }
        Node::For { source, body, .. } => {
            expr_reads(source) + body.iter().map(|c| rest_consumers(c, flag)).sum::<usize>()
        }
        Node::Fragment(cs) => cs.iter().map(|c| rest_consumers(c, flag)).sum(),
        Node::Text(_) | Node::Outlet => 0,
    }
}

/// The call of a carrier's template that hands the whole rest on: `(name, source, imported, member, loc)`.
/// Where the whole rest / props of `n` are spread (outside lists): `Some(None)` onto an element, `Some(Some(call))` into a
/// component, `None` when there is none, or it sits in a list.
fn whole_rest_site(n: &Node) -> Option<Option<CallRef>> {
    let own = |v: &Expr| {
        matches!(v, Expr::Raw(RawExpr { kind: RawKind::Ident { name, kind: IdentKind::Prop }, .. })
            | Expr::Server(ServerExpr(RawExpr { kind: RawKind::Ident { name, kind: IdentKind::Prop }, .. }))
            if name == "*" || name == crate::ir::REST_PROPS)
    };
    match n {
        Node::Element {
            attrs, children, ..
        } => {
            if attrs.iter().any(|a| matches!(a, Attr::Spread(v) if own(v))) {
                return Some(None);
            }
            children.iter().find_map(whole_rest_site)
        }
        Node::Component {
            name,
            source,
            imported,
            member,
            props,
            children,
            loc,
            ..
        } => {
            if props
                .iter()
                .any(|(k, v)| k == crate::ir::SPREAD_KEY && own(v))
            {
                return Some(Some((
                    name.clone(),
                    source.clone(),
                    imported.clone(),
                    member.clone(),
                    *loc,
                )));
            }
            children.iter().find_map(whole_rest_site)
        }
        Node::Fragment(cs) => cs.iter().find_map(whole_rest_site),
        Node::If { then, else_, .. } => then.iter().chain(else_).find_map(whole_rest_site),
        Node::For { .. } | Node::Text(_) | Node::Slot(_) | Node::Outlet => None,
    }
}

/// A value written as a literal (a string, number, boolean, `null` or `undefined`): the same at every render.
fn is_literal_value(v: &Expr) -> bool {
    match v {
        Expr::Raw(r) | Expr::Server(ServerExpr(r)) => {
            r.json_literal().is_some()
                || matches!(r.kind, RawKind::Lit(crate::ir::Literal::Undefined))
        }
        _ => false,
    }
}

/// A component call by the names `resolve_child` takes.
type CallRef = (String, Option<String>, Option<String>, Vec<String>, u32);

fn carrier_call(n: &Node) -> Option<CallRef> {
    match n {
        Node::Component {
            name,
            source,
            imported,
            member,
            props,
            loc,
            ..
        } if props.iter().any(|(k, v)| {
            k == crate::ir::SPREAD_KEY
                && matches!(v, Expr::Raw(r) | Expr::Server(ServerExpr(r)) if matches!(&r.kind,
                    RawKind::Ident { name, kind: IdentKind::Prop } if name == "*" || name == crate::ir::REST_PROPS))
        }) =>
        {
            Some((
                name.clone(),
                source.clone(),
                imported.clone(),
                member.clone(),
                *loc,
            ))
        }
        Node::Element { children, .. }
        | Node::Component { children, .. }
        | Node::Fragment(children) => children.iter().find_map(carrier_call),
        Node::If { .. } | Node::For { .. } | Node::Text(_) | Node::Slot(_) | Node::Outlet => None,
    }
}

/// The attributes of the polymorphic element of `n` (the one `asChild` replaces), `None` when there is none.
fn poly_element_attrs(n: &Node) -> Option<&[Attr]> {
    match n {
        Node::Element {
            poly: true, attrs, ..
        } => Some(attrs),
        Node::Element { children, .. } | Node::Component { children, .. } => {
            children.iter().find_map(poly_element_attrs)
        }
        Node::Fragment(cs) => cs.iter().find_map(poly_element_attrs),
        Node::If { then, else_, .. } => then.iter().chain(else_).find_map(poly_element_attrs),
        Node::For { body, .. } => body.iter().find_map(poly_element_attrs),
        Node::Text(_) | Node::Slot(_) | Node::Outlet => None,
    }
}

/// The fed children of a static, unfed child component (F164 re-base): its records are re-based onto the caller,
/// which numbers and feeds them as its own.
#[derive(Clone, Debug)]
struct Inner {
    records: Vec<InstanceRecord>,
    refs: Vec<ChildRef>,
    /// A fed child of it was evaluated at build (`folded_instances`): its slot lookup is local to that component.
    folded: bool,
    /// Static: its template is printed inline, so the caller can number and feed its children. A Native wrapper (state,
    /// handlers) keeps its records on itself, where no chain component's `instances[]` can see them.
    rebasable: bool,
}

impl Inner {
    fn of(ir: &ComponentIR) -> Option<Inner> {
        let has = !ir.instances.is_empty() || !ir.folded_instances.is_empty();
        (has && !matches!(ir.tier, Tier::React { .. }) && !crate::ir::is_fed(ir)).then(|| Inner {
            records: ir.instances.clone(),
            refs: ir.children.clone(),
            folded: !ir.folded_instances.is_empty(),
            // F328 (ruling on note 84cd6abb, option a): a native wrapper's template is inlined in its caller like a static
            // one, so the caller can number and feed its children's records, provided none of the fed children is
            // created by the client later (under a condition or in a list of the wrapper: its ids would not exist).
            rebasable: match ir.tier {
                Tier::Static => true,
                Tier::Native => !fed_under_condition(ir),
                _ => false,
            },
        })
    }
}

/// F344 (Mellow N1): the source offsets two or more component call sites of `template` share (clones excluded).
fn shared_component_locs(template: &Node) -> BTreeSet<u32> {
    fn walk(n: &Node, seen: &mut BTreeSet<u32>, shared: &mut BTreeSet<u32>) {
        match n {
            Node::Component {
                loc,
                children,
                source,
                ..
            } => {
                // A clone already (content specialised where it was written) is never specialised again.
                if source.as_deref() != Some(SPEC_SOURCE) && !seen.insert(*loc) {
                    shared.insert(*loc);
                }
                children.iter().for_each(|c| walk(c, seen, shared));
            }
            Node::Element { children, .. } | Node::Fragment(children) => {
                children.iter().for_each(|c| walk(c, seen, shared))
            }
            Node::If { then, else_, .. } => {
                then.iter().chain(else_).for_each(|c| walk(c, seen, shared))
            }
            Node::For { body, .. } => body.iter().for_each(|c| walk(c, seen, shared)),
            Node::Text(_) | Node::Slot(_) | Node::Outlet => {}
        }
    }
    let (mut seen, mut shared) = (BTreeSet::new(), BTreeSet::new());
    walk(template, &mut seen, &mut shared);
    shared
}

/// A fed child (one with an instance record of `ir`) sits under a condition or in a list of `ir`'s template.
fn fed_under_condition(ir: &ComponentIR) -> bool {
    let fed: BTreeSet<&str> = ir.instances.iter().map(|r| r.child_id.as_str()).collect();
    let ids: HashMap<&str, &str> = ir
        .children
        .iter()
        .filter_map(|c| c.id.as_deref().map(|id| (c.name.as_str(), id)))
        .collect();
    fn walk(n: &Node, cond: bool, fed: &BTreeSet<&str>, ids: &HashMap<&str, &str>) -> bool {
        match n {
            Node::Component { name, children, .. } => {
                (cond && ids.get(name.as_str()).is_some_and(|id| fed.contains(id)))
                    || children.iter().any(|c| walk(c, cond, fed, ids))
            }
            Node::Element { children, .. } | Node::Fragment(children) => {
                children.iter().any(|c| walk(c, cond, fed, ids))
            }
            Node::If { then, else_, .. } => {
                then.iter().chain(else_).any(|c| walk(c, true, fed, ids))
            }
            Node::For { body, .. } => body.iter().any(|c| walk(c, true, fed, ids)),
            Node::Text(_) | Node::Slot(_) | Node::Outlet => false,
        }
    }
    walk(&ir.template, false, &fed, &ids)
}

fn inner_name(r: &ChildRef) -> &str {
    &r.name
}

/// Whether `n` repeats anything in a list (`lower::template` pastes slot content once per row there).
fn template_has_for(n: &Node) -> bool {
    match n {
        Node::For { .. } => true,
        Node::Element { children, .. }
        | Node::Component { children, .. }
        | Node::Fragment(children) => children.iter().any(template_has_for),
        Node::If { then, else_, .. } => then.iter().chain(else_).any(template_has_for),
        Node::Text(_) | Node::Slot(_) | Node::Outlet => false,
    }
}

/// The `source` of a `Component` node that names a specialised clone (its `imported` is the module-cache key).
const SPEC_SOURCE: &str = "\u{0}spec";

/// F402: the `source` of a `Primitive.<tag>` component of the Radix factory that `rebase_sources` moved into a clone of
/// another package scope. The clone cannot name the factory's package, so the node carries the module that declares the
/// factory (the writer's scope resolved it) in `imported`, and the tag stays in `member`.
const PRIMITIVE_SOURCE: &str = "\u{0}primitive";

/// A stable 32-bit mix of the call site (module and location): the suffix of a clone's id. Ids are per call site
/// (R34.124); equal chunks share a factory module, not an id.
/// F238: the call site a clone's id and module-cache key name (`site`: the module and the enclosing clone's id) with a
/// stable hash of the content it is made with (after `Carry` and `rebase_sources`), so different content at one offset
/// of one template never reuses a clone.
fn clone_site<R: std::fmt::Debug>(site: &str, nodes: &[Node], render: &R) -> String {
    format!(
        "{site}~{:016x}",
        crate::lower::fnv64(format!("{nodes:?}{render:?}").as_bytes())
    )
}

fn spec_hash(path: &str, loc: u32) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in path.bytes().chain(loc.to_le_bytes()) {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// The content given to a component is read in the module that renders it; once it moves into a clone of the component
/// it is read in the component's module. Relative specifiers are rewritten to reach the same file from there; a
/// component declared in the rendering module, or a bare specifier of another package scope, cannot be reached.
fn rebase_sources(
    nodes: &mut [Node],
    from: &str,
    to: &str,
    opts: &crate::analyze::component::AnalyzeOptions,
    modules: &std::cell::RefCell<crate::analyze::modules::ModuleCache>,
) -> Result<(), String> {
    // F267: the clone is compiled in the module the content was written in: every name reads as it did.
    if from == to {
        return Ok(());
    }
    for n in nodes {
        match n {
            Node::Component {
                name,
                source,
                imported,
                member,
                children,
                ..
            } => {
                match source {
                    // F288: a component declared (exported or not) in the module that renders the content is named from
                    // the clone's module by its file and local name, when it compiles without React (a native or static
                    // child prints into the clone; there is nothing to import for it).
                    None => {
                        let lookup =
                            compile(from, &Export::Named(name.clone()), None, opts, modules);
                        if let Some(why) = package_needs_react(&lookup, &modules.borrow(), false) {
                            return Err(format!(
                                "<{name}> (declared in the module that renders it) needs React: {why}"
                            ));
                        }
                        *source = Some(relative_spec(to, from));
                        *imported = Some(name.clone());
                        member.clear();
                    }
                    Some(s) if s.starts_with("./") || s.starts_with("../") => {
                        let Some(target) = resolve(from, s, opts) else {
                            return Err(format!("cannot resolve {s} from {from}"));
                        };
                        *s = relative_spec(to, &target);
                    }
                    Some(s) => {
                        if crate::analyze::modules::package_scope(from)
                            != crate::analyze::modules::package_scope(to)
                        {
                            // F402: `Primitive.<tag>` is the host element wherever it is written: resolved in the scope
                            // of the module that wrote it (the clone's package cannot see the factory's package), it is
                            // named from the clone by the module that declares the factory.
                            if let Some(decl) = primitive_in_scope(from, s, imported, member, opts)
                            {
                                *source = Some(PRIMITIVE_SOURCE.to_string());
                                *imported = Some(decl);
                                rebase_sources(children, from, to, opts, modules)?;
                                continue;
                            }
                            // W1d (progress): the export is a module of the build's package sources: name that file
                            // from the clone's module instead, when it compiles without React. F306 (Radix's
                            // `Switch.Thumb`, declared beside `Switch.Root` in the clone's own module) is the case
                            // where that file is the clone's module itself.
                            let err = || {
                                format!(
                                    "<{name}> is imported from a package of another scope than the component it is given to (written in {from})"
                                )
                            };
                            let (Some(imp), Ok(entry)) = (
                                imported.as_deref(),
                                crate::analyze::modules::resolve_package(from, s, opts),
                            ) else {
                                return Err(err());
                            };
                            let Some((path, export)) = declared_member(&entry, imp, member, opts)
                            else {
                                return Err(err());
                            };
                            if !crate::analyze::modules::is_package_source(&path) {
                                return Err(err());
                            }
                            let lookup = compile(&path, &export, None, opts, modules);
                            if package_needs_react(&lookup, &modules.borrow(), false).is_some() {
                                return Err(err());
                            }
                            *s = relative_spec(to, &path);
                            *imported = Some(match export {
                                Export::Default => "default".to_string(),
                                Export::Named(n) => n,
                            });
                            member.clear();
                        }
                    }
                }
                rebase_sources(children, from, to, opts, modules)?;
            }
            Node::Element { children, .. } | Node::Fragment(children) => {
                rebase_sources(children, from, to, opts, modules)?
            }
            Node::If { then, else_, .. } => {
                rebase_sources(then, from, to, opts, modules)?;
                rebase_sources(else_, from, to, opts, modules)?;
            }
            Node::For { body, .. } => rebase_sources(body, from, to, opts, modules)?,
            Node::Text(_) | Node::Slot(_) | Node::Outlet => {}
        }
    }
    Ok(())
}

/// F402: the module that declares the Radix `Primitive` factory, when the component `<imported>.<tag>` that the module at
/// `from` imports from the bare specifier `spec` is one of its tags (R34.65), resolved in `from`'s own package scope.
fn primitive_in_scope(
    from: &str,
    spec: &str,
    imported: &Option<String>,
    member: &[String],
    opts: &crate::analyze::component::AnalyzeOptions,
) -> Option<String> {
    let ([tag], Some(imported)) = (member, imported.as_deref()) else {
        return None;
    };
    if imported == "*" {
        return None;
    }
    let entry = crate::analyze::modules::resolve_package(from, spec, opts).ok()?;
    let there = if imported == "default" {
        Export::Default
    } else {
        Export::Named(imported.to_string())
    };
    let (decl, Export::Named(n)) = declared_in(&entry, &there, opts) else {
        return None;
    };
    crate::analyze::primitive::primitive_nodes(&decl, &n, opts)?
        .iter()
        .any(|t| t == tag)
        .then_some(decl)
}

/// The relative specifier that reaches the project-relative file `target` from the module at `from`.
fn relative_spec(from: &str, target: &str) -> String {
    let dir: Vec<&str> = from
        .rsplit_once('/')
        .map_or(Vec::new(), |(d, _)| d.split('/').collect());
    let t: Vec<&str> = target.split('/').collect();
    let mut i = 0;
    while i < dir.len() && i + 1 < t.len() && dir[i] == t[i] {
        i += 1;
    }
    let ups = dir.len() - i;
    let rest = t[i..].join("/");
    if ups == 0 {
        format!("./{rest}")
    } else {
        format!("{}{rest}", "../".repeat(ups))
    }
}

/// R34.123: puts `content` where the component reads its `{children}`. Exactly one read is spliced; two would repeat the
/// content (and its ids and jobs).
fn splice_children(ir: &mut ComponentIR, content: Vec<Node>) -> Result<(), String> {
    fn count(n: &Node) -> usize {
        match n {
            Node::Slot(Expr::Raw(r) | Expr::Server(ServerExpr(r))) => matches!(
                &r.kind,
                RawKind::Ident { name, kind: IdentKind::Prop } if name == "children"
            ) as usize,
            Node::Element { children, .. }
            | Node::Component { children, .. }
            | Node::Fragment(children) => children.iter().map(count).sum(),
            Node::If { then, else_, .. } => then.iter().chain(else_).map(count).sum(),
            Node::For { body, .. } => body.iter().map(count).sum(),
            Node::Text(_) | Node::Slot(_) | Node::Outlet => 0,
        }
    }
    fn put(n: &mut Node, content: &mut Option<Vec<Node>>) {
        match n {
            Node::Slot(Expr::Raw(r) | Expr::Server(ServerExpr(r))) if matches!(&r.kind, RawKind::Ident { name, kind: IdentKind::Prop } if name == "children") =>
            {
                let mut nodes = content.take().unwrap_or_default();
                // F307 S4: one node takes the slot's own place, so a bare text slot that is an element's only child binds
                // `x-text` on that element (as a hand-written `<div>{x}</div>`), not on a wrapper React does not print.
                *n = if nodes.len() == 1 {
                    nodes.pop().unwrap()
                } else {
                    Node::Fragment(nodes)
                };
            }
            Node::Element { children, .. }
            | Node::Component { children, .. }
            | Node::Fragment(children) => children.iter_mut().for_each(|c| put(c, content)),
            Node::If { then, else_, .. } => then
                .iter_mut()
                .chain(else_.iter_mut())
                .for_each(|c| put(c, content)),
            Node::For { body, .. } => body.iter_mut().for_each(|c| put(c, content)),
            Node::Text(_) | Node::Slot(_) | Node::Outlet => {}
        }
    }
    // `{open && children}`, a condition on it, an attribute from it: only the markup of the children can be answered.
    if reads_children_as_value(ir) {
        return Err("the component reads its children as a value, not only as markup".into());
    }
    match count(&ir.template) {
        // F324: the component never prints its `{children}`, so React drops the call site's content, unless the rest
        // (or the whole props) it spreads carries it as `children` onto an element or a component. The clone cannot
        // say where that lands (`splice_rest_children` is the forwarder's), so it is refused and the call site keeps
        // its React island, which carries the content.
        // W1d (progress): ONE host element with no children of its own that spreads the rest (or the props) is where React puts
        // them (explicit JSX children win over a spread's `children`, none are written): the content is that element's.
        0 if !content.is_empty() && reads_rest_or_props(ir) => {
            let mut content = Some(content);
            if put_into_rest_host(&mut ir.template, &mut content) == 1 && content.is_none() {
                Ok(())
            } else {
                Err(
                    "the component spreads its `...rest` (or props) and the content given to it would reach that spread as `children`"
                        .into(),
                )
            }
        }
        0 => Ok(()),
        1 => {
            put(&mut ir.template, &mut Some(content));
            Ok(())
        }
        n => Err(format!("the component reads its children {n} times")),
    }
}

/// Whether the call's props select the Slot of a polymorphic tag (a literal true flag, compared with `negate`).
fn flag_selects_slot(poly: &crate::ir::PolyTag, props: &[(String, Expr)]) -> bool {
    let flag = props
        .iter()
        .rev()
        .find(|(k, _)| k == &poly.flag)
        .is_some_and(|(_, v)| {
            matches!(v, Expr::Raw(r) | Expr::Server(ServerExpr(r))
            if matches!(r.json_literal(), Some(serde_json::Value::Bool(true))))
        });
    flag != poly.negate
}

/// The React prop of a DOM event name the compiler reads from (`jsx::event_name`'s inverse), `None` for one it does not know.
fn event_prop(event: &str) -> Option<&'static str> {
    Some(match event {
        "click" => "onClick",
        "dblclick" => "onDoubleClick",
        "contextmenu" => "onContextMenu",
        "mousedown" => "onMouseDown",
        "mouseup" => "onMouseUp",
        "mousemove" => "onMouseMove",
        "mouseenter" => "onMouseEnter",
        "mouseleave" => "onMouseLeave",
        "mouseover" => "onMouseOver",
        "mouseout" => "onMouseOut",
        "keydown" => "onKeyDown",
        "keyup" => "onKeyUp",
        "focusin" => "onFocus",
        "focusout" => "onBlur",
        "input" => "onInput",
        "change" => "onChange",
        "pointerdown" => "onPointerDown",
        "pointerup" => "onPointerUp",
        "pointermove" => "onPointerMove",
        "pointerenter" => "onPointerEnter",
        "pointerleave" => "onPointerLeave",
        _ => return None,
    })
}

/// F369b: puts the ONE `child` (a host element or a component call) where the component's polymorphic element is
/// (React's Slot: the child takes the element's place, the element's attributes merged under its own props, its own
/// children kept). A component child is given the element's attributes as PROPS (the element's handlers as `on*` props,
/// its collection marker as the collection-item prop). The component is no longer polymorphic afterwards (the flag is
/// settled), so its call site resolves nothing. Refused, and the call site keeps its `slot-native` refusal, when: the
/// polymorphic element is not unique, its only child is not the component's `{children}`, the child is neither a host
/// element with plain attributes nor a plain component call, the element carries a ref, or the merge would join a
/// class, a style or a handler (a later row, Mellow F1).
fn splice_poly(ir: &mut ComponentIR, child: Node) -> Result<(), String> {
    fn count(n: &Node) -> usize {
        match n {
            Node::Element { poly, children, .. } => {
                usize::from(*poly) + children.iter().map(count).sum::<usize>()
            }
            Node::Component { children, .. } | Node::Fragment(children) => {
                children.iter().map(count).sum()
            }
            Node::If { then, else_, .. } => then.iter().chain(else_).map(count).sum(),
            Node::For { body, .. } => body.iter().map(count).sum(),
            Node::Text(_) | Node::Slot(_) | Node::Outlet => 0,
        }
    }
    fn is_children_slot(n: &Node) -> bool {
        matches!(n, Node::Slot(Expr::Raw(r) | Expr::Server(ServerExpr(r)))
            if matches!(&r.kind, RawKind::Ident { name, kind: IdentKind::Prop } if name == "children"))
    }
    fn merge_key(name: &str) -> String {
        let k = name.to_ascii_lowercase();
        if k == "classname" { "class".into() } else { k }
    }
    fn is_class_or_style(k: &str) -> bool {
        k == "style" || k == "class"
    }
    /// The element's attributes as the props of a component call.
    fn as_props(
        attrs: &[Attr],
        handlers: &[crate::ir::HandlerDecl],
        used: &mut Vec<String>,
    ) -> Result<Vec<(String, Expr)>, String> {
        let mut out = Vec::new();
        for a in attrs {
            match a {
                Attr::Static { name, value } if !value.is_empty() => out.push((
                    name.clone(),
                    Expr::Raw(RawExpr {
                        loc: 0,
                        kind: RawKind::Lit(crate::ir::Literal::Str(value.clone())),
                    }),
                )),
                Attr::Static { .. } => {
                    return Err("an attribute of the element has an empty value".into());
                }
                Attr::Dynamic { name, value } => out.push((name.clone(), value.clone())),
                Attr::Spread(e) => out.push((crate::ir::SPREAD_KEY.to_string(), e.clone())),
                Attr::CollectionItem { data } => {
                    out.push((crate::ir::COLLECTION_ITEM_PROP.to_string(), data.clone()));
                }
                Attr::Event { event, handler } => {
                    let prop = event_prop(event).ok_or_else(|| {
                        format!(
                            "the element's `{event}` handler has no React prop the compiler knows"
                        )
                    })?;
                    let h = handlers
                        .iter()
                        .find(|h| &h.name == handler)
                        .ok_or("a handler of the element is not declared")?;
                    used.push(handler.clone());
                    out.push((prop.to_string(), Expr::Raw(h.body.clone())));
                }
                Attr::Ref { .. } | Attr::ForwardRef | Attr::InnerHtml { .. } => {
                    return Err("the element carries a ref or raw markup".into());
                }
            }
        }
        Ok(out)
    }
    fn put(
        n: &mut Node,
        child: &mut Option<Node>,
        handlers: &[crate::ir::HandlerDecl],
        used: &mut Vec<String>,
    ) -> Result<(), String> {
        match n {
            Node::Element {
                poly: true,
                attrs,
                children,
                tag,
                ..
            } => {
                if !matches!(children.as_slice(), [only] if is_children_slot(only)) {
                    return Err(
                        "the polymorphic element prints more than the component's `{children}`"
                            .into(),
                    );
                }
                let spreads = attrs.iter().any(|a| matches!(a, Attr::Spread(_)));
                let has_class = |attrs: &[Attr]| {
                    attrs.iter().any(|o| {
                        matches!(o, Attr::Static { name, .. } | Attr::Dynamic { name, .. } if merge_key(name) == "class")
                    })
                };
                match child.take() {
                    Some(Node::Element {
                        tag: ctag,
                        attrs: cattrs,
                        children: ckids,
                        poly: false,
                        ..
                    }) => {
                        if matches!(ctag.as_str(), "style" | "script") {
                            return Err(format!("the child is a <{ctag}> element"));
                        }
                        let mut keys = Vec::new();
                        for a in &cattrs {
                            let (Attr::Static { name, .. } | Attr::Dynamic { name, .. }) = a else {
                                return Err(
                                    "the child has a handler, a ref, a spread or another directive"
                                        .into(),
                                );
                            };
                            let k = merge_key(name);
                            if k == "style" || (k == "class" && (spreads || has_class(attrs))) {
                                return Err("a class or style of the child would be joined with the element's".into());
                            }
                            keys.push(k);
                        }
                        // The child's props win over the element's (`mergeProps(slotProps, childProps)`).
                        attrs.retain(|a| match a {
                            Attr::Static { name, .. } | Attr::Dynamic { name, .. } => {
                                !keys.contains(&merge_key(name))
                            }
                            _ => true,
                        });
                        attrs.extend(cattrs);
                        *children = ckids;
                        *tag = ctag;
                        if let Node::Element { poly, .. } = n {
                            *poly = false;
                        }
                        Ok(())
                    }
                    Some(Node::Component {
                        loc,
                        name,
                        source,
                        imported,
                        member,
                        props: cprops,
                        children: ckids,
                        link,
                        tier,
                        forwarded_ref,
                    }) => {
                        if link.is_some() || forwarded_ref {
                            return Err("the child component is linked or takes a ref".into());
                        }
                        let mut mine = as_props(attrs, handlers, used)?;
                        let mut ckeys = Vec::new();
                        for (k, _) in &cprops {
                            if k == crate::ir::SPREAD_KEY || k == "ref" || k == "key" {
                                return Err(
                                    "the child component is given a spread, a ref or a key".into(),
                                );
                            }
                            let mk = merge_key(k);
                            if is_class_or_style(&mk)
                                && (spreads || mine.iter().any(|(o, _)| merge_key(o) == mk))
                            {
                                return Err("a class or style of the child would be joined with the element's".into());
                            }
                            if event_prop_of(k) && mine.iter().any(|(o, _)| o == k) {
                                return Err(
                                    "a handler of the child would be composed with the element's"
                                        .into(),
                                );
                            }
                            ckeys.push(mk);
                        }
                        mine.retain(|(k, _)| {
                            k == crate::ir::SPREAD_KEY || !ckeys.contains(&merge_key(k))
                        });
                        mine.extend(cprops);
                        *n = Node::Component {
                            loc,
                            name,
                            source,
                            imported,
                            member,
                            props: mine,
                            children: ckids,
                            link: None,
                            tier,
                            forwarded_ref: false,
                        };
                        Ok(())
                    }
                    _ => Err("the child is not a host element or a component call".into()),
                }
            }
            Node::Element { children, .. }
            | Node::Component { children, .. }
            | Node::Fragment(children) => children
                .iter_mut()
                .try_for_each(|c| put(c, child, handlers, used)),
            Node::If { then, else_, .. } => then
                .iter_mut()
                .chain(else_.iter_mut())
                .try_for_each(|c| put(c, child, handlers, used)),
            Node::For { body, .. } => body
                .iter_mut()
                .try_for_each(|c| put(c, child, handlers, used)),
            Node::Text(_) | Node::Slot(_) | Node::Outlet => Ok(()),
        }
    }
    /// Whether a prop key is an `on*` handler prop.
    fn event_prop_of(k: &str) -> bool {
        k.len() > 2 && k.starts_with("on") && k[2..].starts_with(|c: char| c.is_ascii_uppercase())
    }
    if count(&ir.template) != 1 {
        return Err("the component has no single polymorphic element".into());
    }
    let mut used = Vec::new();
    let handlers = ir.handlers.clone();
    put(&mut ir.template, &mut Some(child), &handlers, &mut used)?;
    // A handler that became a prop of the child is no longer one of this component's own.
    ir.handlers.retain(|h| !used.contains(&h.name));
    ir.poly = None;
    Ok(())
}

/// The elements of `n` that spread the rest or the props among their attributes: how many there are, and the content moved
/// into the first when it has no children of its own and it is the only one (the caller checks the count).
fn put_into_rest_host(n: &mut Node, content: &mut Option<Vec<Node>>) -> usize {
    fn spreads_rest(attrs: &[Attr]) -> bool {
        attrs.iter().any(|a| {
            matches!(a, Attr::Spread(Expr::Raw(r))
                if matches!(&r.kind, RawKind::Ident { name, kind: IdentKind::Prop }
                    if name == crate::ir::REST_PROPS || name == "*"))
        })
    }
    fn comp_spreads_rest(props: &[(String, Expr)]) -> bool {
        props.iter().any(|(k, v)| {
            k == crate::ir::SPREAD_KEY
                && matches!(v, Expr::Raw(r)
                    if matches!(&r.kind, RawKind::Ident { name, kind: IdentKind::Prop }
                        if name == crate::ir::REST_PROPS || name == "*"))
        })
    }
    fn count(n: &Node) -> usize {
        match n {
            Node::Element {
                attrs, children, ..
            } => usize::from(spreads_rest(attrs)) + children.iter().map(count).sum::<usize>(),
            Node::Component {
                props, children, ..
            } => usize::from(comp_spreads_rest(props)) + children.iter().map(count).sum::<usize>(),
            Node::Fragment(children) => children.iter().map(count).sum(),
            Node::If { then, else_, .. } => then.iter().chain(else_).map(count).sum(),
            Node::For { body, .. } => body.iter().map(count).sum(),
            Node::Text(_) | Node::Slot(_) | Node::Outlet => 0,
        }
    }
    fn put(n: &mut Node, content: &mut Option<Vec<Node>>) {
        match n {
            Node::Element {
                attrs, children, ..
            } => {
                if spreads_rest(attrs) && children.is_empty() {
                    if let Some(c) = content.take() {
                        *children = c;
                    }
                } else {
                    children.iter_mut().for_each(|c| put(c, content));
                }
            }
            Node::Component {
                props, children, ..
            } => {
                if comp_spreads_rest(props) && children.is_empty() {
                    if let Some(c) = content.take() {
                        *children = c;
                    }
                } else {
                    children.iter_mut().for_each(|c| put(c, content));
                }
            }
            Node::Fragment(children) => children.iter_mut().for_each(|c| put(c, content)),
            Node::If { then, else_, .. } => then
                .iter_mut()
                .chain(else_.iter_mut())
                .for_each(|c| put(c, content)),
            Node::For { body, .. } => body.iter_mut().for_each(|c| put(c, content)),
            Node::Text(_) | Node::Slot(_) | Node::Outlet => {}
        }
    }
    let total = count(n);
    if total == 1 {
        put(n, content);
    }
    total
}

/// F324: whether the template (or a render prop's body) of `ir` reads its `...rest` or its whole props anywhere.
fn reads_rest_or_props(ir: &ComponentIR) -> bool {
    let cx = super::deps::DepsCx::new(ir);
    let mut nodes: Vec<&Node> = vec![&ir.template];
    nodes.extend(ir.render_props.iter().flat_map(|rp| rp.body.iter()));
    nodes
        .into_iter()
        .any(|n| cx.deps_node(n, &[]).props.iter().any(|p| p == "*"))
}

/// F307 S4: the rule a host clone refused for a bare text slot is reported under.
const SLOT_TEXT_WRAPPER: &str = "slot-text-wrapper";

/// F307 S4: the template's `{children}` slot is the only child of an element (a text node spliced there binds `x-text`
/// on that element, as a hand-written `<div>{x}</div>` does).
fn children_slot_is_lone(n: &Node) -> bool {
    fn is_slot(n: &Node) -> bool {
        matches!(n, Node::Slot(Expr::Raw(r) | Expr::Server(ServerExpr(r))) if matches!(&r.kind, RawKind::Ident { name, kind: IdentKind::Prop } if name == "children"))
    }
    match n {
        Node::Element { children, .. } if children.len() == 1 && is_slot(&children[0]) => true,
        Node::Element { children, .. }
        | Node::Component { children, .. }
        | Node::Fragment(children) => children.iter().any(children_slot_is_lone),
        Node::If { then, else_, .. } => then.iter().chain(else_).any(children_slot_is_lone),
        Node::For { body, .. } => body.iter().any(children_slot_is_lone),
        Node::Text(_) | Node::Slot(_) | Node::Outlet => false,
    }
}

/// F342: the children a call site gives reach the component's markup only through its `...rest` (or whole props)
/// spread: it prints no `{children}` and does not name `children` (which a rest would then leave out).
fn carries_children_by_rest(ir: &ComponentIR) -> bool {
    !prints_children_slot(ir)
        && !ir.props.iter().any(|p| p.name == "children")
        && reads_rest_or_props(ir)
}

/// F309: the template of `ir` prints `{children}` somewhere.
fn prints_children_slot(ir: &ComponentIR) -> bool {
    fn any(n: &Node) -> bool {
        match n {
            Node::Slot(Expr::Raw(r) | Expr::Server(ServerExpr(r))) => matches!(
                &r.kind,
                RawKind::Ident { name, kind: IdentKind::Prop } if name == "children"
            ),
            Node::Element { children, .. }
            | Node::Component { children, .. }
            | Node::Fragment(children) => children.iter().any(any),
            Node::If { then, else_, .. } => then.iter().chain(else_).any(any),
            Node::For { body, .. } => body.iter().any(any),
            Node::Text(_) | Node::Slot(_) | Node::Outlet => false,
        }
    }
    any(&ir.template)
}

/// F328b: the template spreads the whole props object (`{...props}`) into a component (switch-provider-chain PR3: not an
/// element: a clone that only moves the children onto its own element, with no Provider of the component's on the way,
/// gains nothing, and a native clone of it would then host them and refuse a handler its caller hoists onto that element).
fn spreads_whole_props(n: &Node) -> bool {
    let whole = |e: &Expr| matches!(e, Expr::Raw(r) | Expr::Server(ServerExpr(r)) if matches!(&r.kind, RawKind::Ident { name, kind: IdentKind::Prop } if name == "*"));
    match n {
        Node::Component {
            props, children, ..
        } => {
            props
                .iter()
                .any(|(k, v)| k == crate::ir::SPREAD_KEY && whole(v))
                || children.iter().any(spreads_whole_props)
        }
        Node::Element { children, .. } => children.iter().any(spreads_whole_props),
        Node::Fragment(cs) => cs.iter().any(spreads_whole_props),
        Node::If { then, else_, .. } => then.iter().chain(else_).any(spreads_whole_props),
        Node::For { body, .. } => body.iter().any(spreads_whole_props),
        Node::Text(_) | Node::Slot(_) | Node::Outlet => false,
    }
}

/// F298: puts a call site's children where the component spreads its `...rest` (into a component or an element, in its
/// template or in a render prop it passes): there they render in React, since the rest carries them as `children`.
/// Exactly one such spread, with no children of its own, and a component that never names `children` itself.
fn splice_rest_children(ir: &mut ComponentIR, content: Vec<Node>) -> Result<(), String> {
    fn is_rest(e: &Expr) -> bool {
        // F328b: a spread of the whole props object (Radix's `{...props}` in RovingFocusGroup) carries `children` as well.
        matches!(e, Expr::Raw(r) | Expr::Server(ServerExpr(r)) if matches!(&r.kind, RawKind::Ident { name, kind: IdentKind::Prop } if name == crate::ir::REST_PROPS || name == "*"))
    }
    fn sites(n: &mut Node, out: &mut Vec<*mut Vec<Node>>) {
        match n {
            Node::Component {
                props, children, ..
            } => {
                if props
                    .iter()
                    .any(|(k, v)| k == crate::ir::SPREAD_KEY && is_rest(v))
                {
                    out.push(children as *mut Vec<Node>);
                }
                children.iter_mut().for_each(|c| sites(c, out));
            }
            Node::Element {
                attrs, children, ..
            } => {
                if attrs
                    .iter()
                    .any(|a| matches!(a, crate::ir::Attr::Spread(e) if is_rest(e)))
                {
                    out.push(children as *mut Vec<Node>);
                }
                children.iter_mut().for_each(|c| sites(c, out));
            }
            Node::Fragment(children) => children.iter_mut().for_each(|c| sites(c, out)),
            Node::If { then, else_, .. } => then
                .iter_mut()
                .chain(else_.iter_mut())
                .for_each(|c| sites(c, out)),
            Node::For { body, .. } => body.iter_mut().for_each(|c| sites(c, out)),
            Node::Text(_) | Node::Slot(_) | Node::Outlet => {}
        }
    }
    if ir.props.iter().any(|p| p.name == "children") || reads_children_as_value(ir) {
        return Err("the component reads `children` itself".into());
    }
    let mut found: Vec<*mut Vec<Node>> = Vec::new();
    sites(&mut ir.template, &mut found);
    for rp in &mut ir.render_props {
        rp.body.iter_mut().for_each(|n| sites(n, &mut found));
    }
    match found.as_slice() {
        // SAFETY: the pointers are to distinct `children` vectors of nodes of `ir`, which is borrowed mutably for the
        // whole function and not otherwise touched between collecting them and this write.
        [one] => {
            let children = unsafe { &mut **one };
            if !children.is_empty() {
                return Err("the element the rest is spread into has children of its own".into());
            }
            *children = content;
            Ok(())
        }
        [] => Err("the component spreads its rest nowhere it renders".into()),
        _ => Err("the component spreads its rest more than once".into()),
    }
}

/// F305: `Some(true)` when `r` reads an import, and only as the callee of a direct call (`cn(…)`) or of a namespace
/// import's member (`fmt.date(…)`, `import * as fmt`), with no element, no code printed as written and no name the
/// content binds itself (a list row's): the whole value can be computed at the call site. `Some(false)` when it reads no import; `None` when an import is read as a value (data,
/// which F325 keeps out of a clone) or the value cannot be moved.
fn imports_called_only(r: &RawExpr, bound: &[String]) -> Option<bool> {
    fn walk(r: &RawExpr, bound: &[String], callee: bool, seen: &mut bool) -> Option<()> {
        match &r.kind {
            RawKind::Lit(_) => Some(()),
            RawKind::Ident { name, kind } => match kind {
                IdentKind::Import { .. } if callee => {
                    *seen = true;
                    Some(())
                }
                IdentKind::Import { .. } | IdentKind::Store { .. } | IdentKind::Unknown => None,
                IdentKind::LoopBinding | IdentKind::Local if bound.iter().any(|b| b == name) => {
                    None
                }
                _ => Some(()),
            },
            // `fmt.date(…)` with `import * as fmt`: one member of a namespace import is the callee. Any other member
            // chain under a callee (`DATA.items.join(…)`) reads the import as data (Mellow N1, F325).
            RawKind::Member { target, .. } => match &target.kind {
                RawKind::Ident {
                    kind: IdentKind::Import { imported, .. },
                    ..
                } if callee && imported == "*" => {
                    *seen = true;
                    Some(())
                }
                _ => walk(target, bound, false, seen),
            },
            RawKind::Index { target, index } => {
                walk(target, bound, false, seen)?;
                walk(index, bound, false, seen)
            }
            RawKind::Call { callee: c, args } => {
                walk(c, bound, true, seen)?;
                args.iter().try_for_each(|a| walk(a, bound, false, seen))
            }
            RawKind::Binary { left, right, .. } => {
                walk(left, bound, false, seen)?;
                walk(right, bound, false, seen)
            }
            RawKind::Unary { value, .. } => walk(value, bound, false, seen),
            RawKind::Cond { test, yes, no } => {
                walk(test, bound, false, seen)?;
                walk(yes, bound, false, seen)?;
                walk(no, bound, false, seen)
            }
            RawKind::Template { parts, .. } => parts
                .iter()
                .try_for_each(|(p, _)| walk(p, bound, false, seen)),
            RawKind::Array(xs) => xs.iter().try_for_each(|x| walk(x, bound, false, seen)),
            RawKind::Object(ps) => ps.iter().try_for_each(|(_, v)| walk(v, bound, false, seen)),
            RawKind::Arrow { .. } | RawKind::Opaque { .. } | RawKind::Jsx(_) => None,
        }
    }
    let mut seen = false;
    walk(r, bound, false, &mut seen).map(|()| seen)
}

/// A call site's clone: its id, its module-cache key and the hidden inputs the call site must now pass (S2).
type Specialised = (String, String, Vec<(String, Expr)>);

/// S2 (R34.123, Mellow S2): the names of the component that renders a call site, read in the content that moves into
/// the clone, are carried in as hidden inputs of the clone. Each distinct name becomes a prop `__in_<name>` the call
/// site fills with the name itself (an expression of its own scope, so a constant is seeded, a live value crosses the
/// existing link, a function crosses as a client-only prop), and the content reads that prop. A handler of the caller
/// written in the content (`onClick={() => …}`) becomes a handler of the clone that calls the carried function.
/// What cannot cross is refused by name: the caller's whole props or `...rest`, a ref, a list row's bindings, imports,
/// stores, module-level functions, and a name read inside code printed as written.
/// The hidden input that carries the call site's whole `...rest` into a clone (F278).
pub(crate) const REST_INPUT: &str = "__in_rest";

struct Carry<'a> {
    native: &'a [(u32, String, usize)],
    owner: usize,
    module_names: &'a BTreeSet<String>,
    row_handlers: &'a BTreeSet<String>,
    handler_names: &'a BTreeSet<String>,
    module_consts: &'a HashMap<String, RawExpr>,
    taken: Vec<String>,
    inputs: Vec<(String, Expr)>,
    handlers: Vec<crate::ir::HandlerDecl>,
}

impl<'a> Carry<'a> {
    fn new(
        native: &'a [(u32, String, usize)],
        owner: usize,
        module_names: &'a BTreeSet<String>,
        row_handlers: &'a BTreeSet<String>,
        handler_names: &'a BTreeSet<String>,
        module_consts: &'a HashMap<String, RawExpr>,
        taken: Vec<String>,
    ) -> Self {
        Carry {
            native,
            owner,
            module_names,
            row_handlers,
            handler_names,
            module_consts,
            taken,
            inputs: Vec::new(),
            handlers: Vec::new(),
        }
    }

    fn finish(&mut self) -> (Vec<(String, Expr)>, Vec<crate::ir::HandlerDecl>) {
        (
            std::mem::take(&mut self.inputs),
            std::mem::take(&mut self.handlers),
        )
    }

    /// The hidden prop that carries the call site's `name`, registering it on first use.
    fn input(&mut self, name: &str, kind: &IdentKind, loc: u32) -> Result<String, String> {
        let hidden = format!("__in_{name}");
        if self.inputs.iter().any(|(h, _)| *h == hidden) {
            return Ok(hidden);
        }
        if self.taken.contains(&hidden) {
            return Err(format!("the component already has a prop `{hidden}`"));
        }
        self.inputs.push((
            hidden.clone(),
            Expr::Raw(RawExpr {
                loc,
                kind: RawKind::Ident {
                    name: name.to_string(),
                    kind: kind.clone(),
                },
            }),
        ));
        Ok(hidden)
    }

    /// F278: `{...rest}` of the call site's component, spread into an element or a component of the content: its keys
    /// are known per instance, so the clone takes the whole object as one hidden input (`__in_rest`) and spreads
    /// that (a props path), exactly as the call site would have spread its own rest.
    fn rest_spread(&mut self, e: &mut Expr) -> Result<bool, String> {
        let (Expr::Raw(r) | Expr::Server(ServerExpr(r))) = e else {
            return Ok(false);
        };
        let RawKind::Ident {
            name,
            kind: IdentKind::Prop,
        } = &r.kind
        else {
            return Ok(false);
        };
        if name != crate::ir::REST_PROPS {
            return Ok(false);
        }
        let hidden = REST_INPUT.to_string();
        if !self.inputs.iter().any(|(h, _)| *h == hidden) {
            if self.taken.contains(&hidden) {
                return Err(format!("the component already has a prop `{hidden}`"));
            }
            self.inputs.push((hidden.clone(), Expr::Raw(r.clone())));
        }
        *r = RawExpr {
            loc: r.loc,
            kind: RawKind::Ident {
                name: hidden,
                kind: IdentKind::Prop,
            },
        };
        Ok(true)
    }

    fn raw(&mut self, r: &mut RawExpr, bound: &[String], what: &str) -> Result<(), String> {
        let loc = r.loc;
        match &mut r.kind {
            RawKind::Lit(_) => Ok(()),
            RawKind::Ident { name, kind } => {
                let refuse = |why: &str| {
                    Err(format!(
                        "{what} reads `{name}`, a name of the component that renders it ({why})"
                    ))
                };
                match kind {
                    IdentKind::Global => Ok(()),
                    IdentKind::LoopBinding | IdentKind::Local
                        if bound.iter().any(|b| b == name) =>
                    {
                        Ok(())
                    }
                    IdentKind::LoopBinding => refuse("a binding of an enclosing list"),
                    IdentKind::Prop if name == "*" || name == crate::ir::REST_PROPS => {
                        refuse("its whole props object")
                    }
                    IdentKind::Local
                        if self.module_names.contains(name.as_str())
                            && !self.module_consts.contains_key(name.as_str()) =>
                    {
                        refuse("a module-level declaration")
                    }
                    IdentKind::Prop | IdentKind::State | IdentKind::Setter | IdentKind::Local => {
                        let hidden = self.input(name, kind, loc)?;
                        *r = RawExpr {
                            loc,
                            kind: RawKind::Ident {
                                name: hidden,
                                kind: IdentKind::Prop,
                            },
                        };
                        Ok(())
                    }
                    IdentKind::Import { .. } => refuse("an import"),
                    IdentKind::Store { .. } => refuse("a store"),
                    IdentKind::Unknown => refuse("unknown"),
                }
            }
            RawKind::Member { target, .. } => self.raw(target, bound, what),
            RawKind::Index { target, index } => {
                self.raw(target, bound, what)?;
                self.raw(index, bound, what)
            }
            RawKind::Call { callee, args } => {
                self.raw(callee, bound, what)?;
                args.iter_mut().try_for_each(|a| self.raw(a, bound, what))
            }
            RawKind::Binary { left, right, .. } => {
                self.raw(left, bound, what)?;
                self.raw(right, bound, what)
            }
            RawKind::Unary { value, .. } => self.raw(value, bound, what),
            RawKind::Cond { test, yes, no } => {
                self.raw(test, bound, what)?;
                self.raw(yes, bound, what)?;
                self.raw(no, bound, what)
            }
            RawKind::Template { parts, .. } => parts
                .iter_mut()
                .try_for_each(|(p, _)| self.raw(p, bound, what)),
            RawKind::Array(xs) => xs.iter_mut().try_for_each(|x| self.raw(x, bound, what)),
            RawKind::Object(ps) => ps
                .iter_mut()
                .try_for_each(|(_, v)| self.raw(v, bound, what)),
            // Code printed as written cannot have a name replaced in it.
            RawKind::Arrow { captures, .. } | RawKind::Opaque { captures, .. } => {
                match captures
                    .iter()
                    .find(|(n, k)| !matches!(k, IdentKind::Global) && !bound.contains(n))
                {
                    Some((n, _)) => Err(format!(
                        "{what} reads `{n}` inside code printed as written, a name of the component that renders it"
                    )),
                    None => Ok(()),
                }
            }
            RawKind::Jsx(node) => self.node(node, bound),
        }
    }

    fn expr(&mut self, e: &mut Expr, bound: &[String], what: &str) -> Result<(), String> {
        match e {
            Expr::Raw(r) | Expr::Server(ServerExpr(r)) => {
                if imports_called_only(r, bound) == Some(true) {
                    return self.whole(r);
                }
                self.raw(r, bound, what)
            }
            _ => Ok(()),
        }
    }

    /// F305: a value of the content that calls an import of the call site (`className={cn("…", x)}`) is computed where
    /// it is written: the call site passes the whole value as one hidden input, and the clone reads that prop. No import
    /// crosses into the clone's module (a package source never imports app code); only the value does, as data, as
    /// any input does.
    fn whole(&mut self, r: &mut RawExpr) -> Result<(), String> {
        let mut n = self.inputs.len() + 1;
        let hidden = loop {
            let h = format!("__inx{n}");
            if !self.inputs.iter().any(|(k, _)| *k == h) && !self.taken.contains(&h) {
                break h;
            }
            n += 1;
        };
        self.inputs.push((hidden.clone(), Expr::Raw(r.clone())));
        *r = RawExpr {
            loc: r.loc,
            kind: RawKind::Ident {
                name: hidden,
                kind: IdentKind::Prop,
            },
        };
        Ok(())
    }

    fn nodes(&mut self, ns: &mut [Node], bound: &[String]) -> Result<(), String> {
        ns.iter_mut().try_for_each(|n| self.node(n, bound))
    }

    fn node(&mut self, n: &mut Node, bound: &[String]) -> Result<(), String> {
        match n {
            Node::Element {
                attrs, children, ..
            } => {
                for a in attrs.iter_mut() {
                    match a {
                        Attr::Static { .. } | Attr::ForwardRef => {}
                        Attr::CollectionItem { data } => {
                            self.expr(data, bound, "the data of a collection item")?
                        }
                        Attr::Dynamic { name, value } => {
                            let what = format!("the attribute `{name}`");
                            self.expr(value, bound, &what)?
                        }
                        Attr::InnerHtml { value } | Attr::Spread(value) => {
                            if !self.rest_spread(value)? {
                                self.expr(value, bound, "an attribute")?
                            }
                        }
                        Attr::Event { handler, .. } => {
                            let h = handler.clone();
                            if bound.contains(&h) {
                                continue;
                            }
                            if !self.handler_names.contains(&h) {
                                return Err(format!(
                                    "the handler `{h}` is not a handler of the component that renders it"
                                ));
                            }
                            if self.row_handlers.contains(&h) {
                                return Err(format!(
                                    "the handler `{h}` is written in a list row of the component that renders it"
                                ));
                            }
                            let hidden = self.input(&h, &IdentKind::Local, 0)?;
                            let own = format!("__inh_{h}");
                            if !self.handlers.iter().any(|d| d.name == own) {
                                self.handlers.push(crate::ir::HandlerDecl {
                                    name: own.clone(),
                                    body: RawExpr {
                                        loc: 0,
                                        kind: RawKind::Ident {
                                            name: hidden,
                                            kind: IdentKind::Prop,
                                        },
                                    },
                                    item_scoped: Vec::new(),
                                    forwarded: None,
                                });
                            }
                            *handler = own;
                        }
                        Attr::Ref { name } => {
                            return Err(format!("the ref `{name}` is written in the content"));
                        }
                    }
                }
                self.nodes(children, bound)
            }
            Node::Slot(e) => self.expr(e, bound, "a text"),
            Node::If {
                cond, then, else_, ..
            } => {
                self.expr(cond, bound, "a condition")?;
                self.nodes(then, bound)?;
                self.nodes(else_, bound)
            }
            Node::For {
                source,
                item,
                index,
                key,
                body,
            } => {
                // A list's source is data the rows print once (F325): never computed at the call site and shipped as
                // an input, so an import there stays refused.
                match source {
                    Expr::Raw(r) | Expr::Server(ServerExpr(r)) => self.raw(r, bound, "a list")?,
                    _ => {}
                }
                let mut inner = bound.to_vec();
                inner.push(item.clone());
                if let Some(i) = index {
                    inner.push(i.clone());
                }
                self.expr(key, &inner, "a list key")?;
                self.nodes(body, &inner)
            }
            Node::Component {
                loc,
                props,
                children,
                ..
            } => {
                for (k, v) in props.iter_mut() {
                    // Filled by the frame of THIS Provider: an expression of its own scope.
                    if self
                        .native
                        .iter()
                        .any(|(l, kk, o)| l == loc && kk == k && *o == self.owner)
                    {
                        continue;
                    }
                    if k == crate::ir::SPREAD_KEY && self.rest_spread(v)? {
                        continue;
                    }
                    let what = format!("the prop `{k}`");
                    self.expr(v, bound, &what)?;
                }
                self.nodes(children, bound)
            }
            Node::Fragment(cs) => self.nodes(cs, bound),
            Node::Text(_) | Node::Outlet => Ok(()),
        }
    }
}

/// B7 (R34.122 b, R34.123): the component calls its render prop where it renders (`render(ctx)`, alone or as
/// `typeof render === "function" ? render(ctx) : children`); the call site wrote the prop as an arrow, so the arrow's
/// body is put where the call is, its parameters replaced by the call's arguments. Exactly one call; every other use of
/// the prop is refused (a clone has no function to hand around). An argument is substituted only when it is a pure
/// read (an `Ident`/`Member` chain), so the body never re-evaluates or reorders a computation.
fn splice_render(ir: &mut ComponentIR, rp: crate::ir::RenderProp) -> Result<(), String> {
    let key = rp.key.clone();
    let typeof_helpers: Vec<String> = ir
        .module_decls
        .iter()
        .filter_map(|d| match d.names.as_slice() {
            [n] if is_typeof_function_helper(&d.source, n) => Some(n.clone()),
            _ => None,
        })
        .collect();
    let named = |e: &RawExpr, what: &str| matches!(&e.kind, RawKind::Ident { name, kind: IdentKind::Prop } if name == what);
    // `render(args)`
    let call_args = |e: &RawExpr| -> Option<Vec<RawExpr>> {
        match &e.kind {
            RawKind::Call { callee, args } if named(callee, &key) => Some(args.clone()),
            _ => None,
        }
    };
    // `typeof render === "function"`, either way round, `!==` as the else of the same, or `render` itself
    let is_fn_test = |e: &RawExpr| -> bool {
        let typeof_key = |x: &RawExpr| matches!(&x.kind, RawKind::Unary { op: UnOp::Typeof, value } if named(value, &key));
        let function = |x: &RawExpr| matches!(&x.kind, RawKind::Lit(crate::ir::Literal::Str(s)) if s == "function");
        match &e.kind {
            RawKind::Binary {
                op: crate::ir::BinOp::StrictEq | crate::ir::BinOp::Eq,
                left,
                right,
            } => (typeof_key(left) && function(right)) || (function(left) && typeof_key(right)),
            // `isFunction(render)` of a module helper that is exactly `typeof v === "function"`
            RawKind::Call { callee, args } => {
                matches!(&callee.kind, RawKind::Ident { name, kind: IdentKind::Local } if typeof_helpers.contains(name))
                    && matches!(args.as_slice(), [a] if named(a, &key))
            }
            _ => named(e, &key),
        }
    };
    fn find(
        n: &mut Node,
        hit: &mut dyn FnMut(&mut RawExpr) -> Option<Vec<RawExpr>>,
        found: &mut Vec<(Vec<RawExpr>, *mut Node)>,
    ) {
        match n {
            Node::Slot(Expr::Raw(r) | Expr::Server(ServerExpr(r))) => {
                if let Some(args) = hit(r) {
                    found.push((args, n as *mut Node));
                }
            }
            Node::Element { children, .. }
            | Node::Component { children, .. }
            | Node::Fragment(children) => children.iter_mut().for_each(|c| find(c, hit, found)),
            Node::If { then, else_, .. } => then
                .iter_mut()
                .chain(else_.iter_mut())
                .for_each(|c| find(c, hit, found)),
            Node::For { body, .. } => body.iter_mut().for_each(|c| find(c, hit, found)),
            Node::Text(_) | Node::Slot(_) | Node::Outlet => {}
        }
    }
    let mut found: Vec<(Vec<RawExpr>, *mut Node)> = Vec::new();
    let mut hit = |r: &mut RawExpr| -> Option<Vec<RawExpr>> {
        if let Some(args) = call_args(r) {
            return Some(args);
        }
        if let RawKind::Cond { test, yes, no } = &r.kind
            && is_fn_test(test)
            && let Some(args) = call_args(yes)
            && !mentions_prop(no, &key)
        {
            return Some(args);
        }
        None
    };
    find(&mut ir.template, &mut hit, &mut found);
    let [(args, at)] = &found[..] else {
        return Err(format!(
            "the component does not call its `{key}` prop exactly once where it renders"
        ));
    };
    // The parameters, bound to the arguments of the call.
    let mut map: std::collections::HashMap<String, RawExpr> = std::collections::HashMap::new();
    if !rp.params.is_empty() {
        let [arg] = &args[..] else {
            return Err(format!(
                "`{key}` is called with {} arguments, the arrow takes one object",
                args.len()
            ));
        };
        // F266: a `const ctx = { a, b }` of the component stands for its literal (`render(ctx)`); the names it reads are
        // consts of the same render, so reading them where the body lands is reading them where the object was built.
        let literal = match &arg.kind {
            RawKind::Ident {
                name,
                kind: IdentKind::Local,
            } if ir.safe_objects.contains(name) => ir
                .derived
                .iter()
                .find(|d| &d.name == name)
                .and_then(|d| match &d.expr {
                    Expr::Raw(e) if matches!(e.kind, RawKind::Object(_)) => Some(e.clone()),
                    _ => None,
                }),
            _ => None,
        };
        let arg = literal.as_ref().unwrap_or(arg);
        let RawKind::Object(pairs) = &arg.kind else {
            return Err(format!(
                "`{key}` is called with a value that is not an object literal"
            ));
        };
        for (k, local) in &rp.params {
            let value = match pairs.iter().rev().find(|(pk, _)| pk == k) {
                Some((_, v)) => v.clone(),
                None => RawExpr {
                    loc: arg.loc,
                    kind: RawKind::Lit(crate::ir::Literal::Undefined),
                },
            };
            if !pure_read(&value) {
                return Err(format!(
                    "the argument `{k}` of `{key}` is a computation, not a plain read"
                ));
            }
            map.insert(local.clone(), value);
        }
    } else if !args.iter().all(pure_read) {
        return Err(format!("`{key}` is called with a computation"));
    }
    let mut body = rp.body;
    for n in &mut body {
        subst_params(n, &map)?;
    }
    // SAFETY: `at` points into `ir.template`, which nothing has touched since `find` returned.
    unsafe { *(*at) = Node::Fragment(body) };
    // Nothing else may read the prop.
    if ir_reads_prop(ir, &key) {
        return Err(format!(
            "the component uses its `{key}` prop other than by calling it"
        ));
    }
    Ok(())
}

/// `function name(v) { return typeof v === "function" }`: the only helper `typeof_helpers` accepts as a test.
fn is_typeof_function_helper(source: &str, name: &str) -> bool {
    let flat: String = source.split_whitespace().collect();
    let Some(rest) = flat.strip_prefix(&format!("function{name}(")) else {
        return false;
    };
    let Some((param, body)) = rest.split_once(')') else {
        return false;
    };
    !param.is_empty()
        && param
            .chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '$')
        && (body == format!("{{returntypeof{param}===\"function\";}}")
            || body == format!("{{returntypeof{param}===\"function\"}}"))
}

fn mentions_prop(e: &RawExpr, key: &str) -> bool {
    let mut found = false;
    crate::lower::common::visit_idents(e, &mut |n, k| {
        found |= n == key && matches!(k, IdentKind::Prop);
    });
    found
}

/// `a`, `a.b.c`, a literal, an object literal of those: a read with no effect and one value.
pub(crate) fn pure_read(e: &RawExpr) -> bool {
    match &e.kind {
        RawKind::Lit(_) => true,
        RawKind::Ident { .. } => true,
        RawKind::Member { target, .. } => pure_read(target),
        RawKind::Object(ps) => ps.iter().all(|(_, v)| pure_read(v)),
        _ => false,
    }
}

/// Whether any expression of `ir` reads the prop `key` (the component's template, its derived values, handlers,
/// effects, state and ref initialisers, provided context fields and prop defaults).
fn ir_reads_prop(ir: &ComponentIR, key: &str) -> bool {
    fn node(n: &Node, key: &str) -> bool {
        let ex = |e: &Expr| match e {
            Expr::Raw(r) | Expr::Server(ServerExpr(r)) => mentions_prop(r, key),
            _ => false,
        };
        match n {
            Node::Element {
                attrs, children, ..
            } => {
                attrs.iter().any(|a| match a {
                    Attr::Dynamic { value, .. }
                    | Attr::InnerHtml { value }
                    | Attr::Spread(value) => ex(value),
                    _ => false,
                }) || children.iter().any(|c| node(c, key))
            }
            Node::Component {
                props, children, ..
            } => props.iter().any(|(_, v)| ex(v)) || children.iter().any(|c| node(c, key)),
            Node::Fragment(cs) => cs.iter().any(|c| node(c, key)),
            Node::If {
                cond, then, else_, ..
            } => ex(cond) || then.iter().chain(else_).any(|c| node(c, key)),
            Node::For {
                source,
                key: k,
                body,
                ..
            } => ex(source) || ex(k) || body.iter().any(|c| node(c, key)),
            Node::Slot(e) => ex(e),
            Node::Text(_) | Node::Outlet => false,
        }
    }
    let ex = |e: &Expr| match e {
        Expr::Raw(r) | Expr::Server(ServerExpr(r)) => mentions_prop(r, key),
        _ => false,
    };
    node(&ir.template, key)
        || ir.derived.iter().any(|d| ex(&d.expr))
        || ir.handlers.iter().any(|h| mentions_prop(&h.body, key))
        || ir.effects.iter().any(|e| {
            mentions_prop(&e.body, key) || e.deps.iter().flatten().any(|d| mentions_prop(d, key))
        })
        || ir.state.iter().any(|s| ex(&s.init))
        || ir.refs.iter().any(|r| ex(&r.init))
        || ir
            .provides
            .iter()
            .any(|p| p.fields.iter().any(|(_, v)| mentions_prop(v, key)))
        || ir
            .props
            .iter()
            .any(|p| p.name != key && p.default.as_ref().is_some_and(|d| mentions_prop(d, key)))
}

/// `map` (parameter local -> the call's argument) applied to every expression of `n`.
pub(super) fn subst_params(
    n: &mut Node,
    map: &std::collections::HashMap<String, RawExpr>,
) -> Result<(), String> {
    fn ex(e: &mut Expr, map: &std::collections::HashMap<String, RawExpr>) -> Result<(), String> {
        match e {
            Expr::Raw(r) | Expr::Server(ServerExpr(r)) => subst_raw(r, map),
            _ => Ok(()),
        }
    }
    match n {
        Node::Element {
            attrs, children, ..
        } => {
            for a in attrs {
                match a {
                    Attr::Dynamic { value, .. }
                    | Attr::InnerHtml { value }
                    | Attr::Spread(value) => ex(value, map)?,
                    _ => {}
                }
            }
            children.iter_mut().try_for_each(|c| subst_params(c, map))
        }
        Node::Component {
            props, children, ..
        } => {
            for (_, v) in props {
                ex(v, map)?;
            }
            children.iter_mut().try_for_each(|c| subst_params(c, map))
        }
        Node::Fragment(cs) => cs.iter_mut().try_for_each(|c| subst_params(c, map)),
        Node::If {
            cond, then, else_, ..
        } => {
            ex(cond, map)?;
            then.iter_mut()
                .chain(else_.iter_mut())
                .try_for_each(|c| subst_params(c, map))
        }
        Node::For {
            source,
            item,
            index,
            key,
            body,
        } => {
            ex(source, map)?;
            if map.contains_key(item.as_str())
                || index.as_ref().is_some_and(|i| map.contains_key(i.as_str()))
            {
                return Err("a list in the render body binds a name the arrow also takes".into());
            }
            // Capture avoidance: an argument substituted into the row would read the row's binding instead of the
            // callee's own value of the same name (`({ on: c }) => xs.map((on) => c ? on : 0)`).
            let binds = |n: &str| item == n || index.as_deref() == Some(n);
            let mut captured = None;
            for v in map.values() {
                crate::lower::common::visit_idents(v, &mut |n, _| {
                    if binds(n) {
                        captured = Some(n.to_string());
                    }
                });
            }
            if let Some(n) = captured {
                return Err(format!(
                    "a list in the render body binds `{n}`, which an argument of the call reads"
                ));
            }
            ex(key, map)?;
            body.iter_mut().try_for_each(|c| subst_params(c, map))
        }
        Node::Slot(e) => ex(e, map),
        Node::Text(_) | Node::Outlet => Ok(()),
    }
}

fn subst_raw(
    r: &mut RawExpr,
    map: &std::collections::HashMap<String, RawExpr>,
) -> Result<(), String> {
    match &mut r.kind {
        RawKind::Ident {
            name,
            kind: IdentKind::LoopBinding,
        } => {
            if let Some(v) = map.get(name.as_str()) {
                *r = v.clone();
            }
            Ok(())
        }
        RawKind::Lit(_) | RawKind::Ident { .. } => Ok(()),
        RawKind::Member { target, .. } => subst_raw(target, map),
        RawKind::Index { target, index } => {
            subst_raw(target, map)?;
            subst_raw(index, map)
        }
        RawKind::Call { callee, args } => {
            subst_raw(callee, map)?;
            args.iter_mut().try_for_each(|a| subst_raw(a, map))
        }
        RawKind::Binary { left, right, .. } => {
            subst_raw(left, map)?;
            subst_raw(right, map)
        }
        RawKind::Unary { value, .. } => subst_raw(value, map),
        RawKind::Cond { test, yes, no } => {
            subst_raw(test, map)?;
            subst_raw(yes, map)?;
            subst_raw(no, map)
        }
        RawKind::Template { parts, .. } => {
            parts.iter_mut().try_for_each(|(p, _)| subst_raw(p, map))
        }
        RawKind::Array(xs) => xs.iter_mut().try_for_each(|x| subst_raw(x, map)),
        RawKind::Object(ps) => ps.iter_mut().try_for_each(|(_, v)| subst_raw(v, map)),
        // Code printed as written cannot have a name replaced in it.
        RawKind::Arrow { captures, .. } | RawKind::Opaque { captures, .. } => {
            match captures.iter().find(|(n, _)| map.contains_key(n.as_str())) {
                Some((n, _)) => Err(format!("`{n}` is read inside code printed as written")),
                None => Ok(()),
            }
        }
        RawKind::Jsx(node) => subst_params(node, map),
    }
}

/// F300: whether `n` calls a component with the hidden input that carries the caller's whole `...rest` (`__in_rest`).
fn template_passes_rest_as_data(n: &Node) -> bool {
    match n {
        Node::Component {
            props, children, ..
        } => {
            props.iter().any(|(k, _)| k == REST_INPUT)
                || children.iter().any(template_passes_rest_as_data)
        }
        Node::Element { children, .. } | Node::Fragment(children) => {
            children.iter().any(template_passes_rest_as_data)
        }
        Node::If { then, else_, .. } => then.iter().chain(else_).any(template_passes_rest_as_data),
        Node::For { body, .. } => body.iter().any(template_passes_rest_as_data),
        Node::Text(_) | Node::Slot(_) | Node::Outlet => false,
    }
}

/// Whether `n` renders the component's own `{children}`.
fn template_reads_children(n: &Node) -> bool {
    match n {
        Node::Slot(Expr::Raw(r) | Expr::Server(ServerExpr(r))) => {
            matches!(&r.kind, RawKind::Ident { name, kind: IdentKind::Prop } if name == "children")
        }
        Node::Element { children, .. }
        | Node::Component { children, .. }
        | Node::Fragment(children) => children.iter().any(template_reads_children),
        Node::If { then, else_, .. } => then.iter().chain(else_).any(template_reads_children),
        Node::For { body, .. } => body.iter().any(template_reads_children),
        Node::Text(_) | Node::Slot(_) | Node::Outlet => false,
    }
}

/// How many times `n` spreads its props or their rest (on an element or into a component).
fn count_prop_spreads(n: &Node) -> usize {
    let own = |v: &Expr| {
        matches!(v, Expr::Raw(RawExpr { kind: RawKind::Ident { name, kind: IdentKind::Prop }, .. })
            | Expr::Server(ServerExpr(RawExpr { kind: RawKind::Ident { name, kind: IdentKind::Prop }, .. }))
            if name == "*" || name == crate::ir::REST_PROPS)
    };
    match n {
        Node::Element {
            attrs, children, ..
        } => {
            attrs
                .iter()
                .filter(|a| matches!(a, Attr::Spread(v) if own(v)))
                .count()
                + children.iter().map(count_prop_spreads).sum::<usize>()
        }
        Node::Component {
            props, children, ..
        } => {
            props
                .iter()
                .filter(|(k, v)| (k == crate::ir::SPREAD_KEY || k == REST_INPUT) && own(v))
                .count()
                + children.iter().map(count_prop_spreads).sum::<usize>()
        }
        Node::Fragment(cs) => cs.iter().map(count_prop_spreads).sum(),
        Node::If { then, else_, .. } => then.iter().chain(else_).map(count_prop_spreads).sum(),
        Node::For { body, .. } => body.iter().map(count_prop_spreads).sum(),
        Node::Text(_) | Node::Slot(_) | Node::Outlet => 0,
    }
}

/// `n` without its spreads (attribute and component), for what a child reads by name.
fn strip_spreads(n: &mut Node) {
    match n {
        Node::Element {
            attrs, children, ..
        } => {
            attrs.retain(|a| !matches!(a, Attr::Spread(_)));
            children.iter_mut().for_each(strip_spreads);
        }
        Node::Component {
            props, children, ..
        } => {
            props.retain(|(k, _)| k != crate::ir::SPREAD_KEY);
            children.iter_mut().for_each(strip_spreads);
        }
        Node::Fragment(cs) => cs.iter_mut().for_each(strip_spreads),
        Node::If { then, else_, .. } => then.iter_mut().chain(else_).for_each(strip_spreads),
        Node::For { body, .. } => body.iter_mut().for_each(strip_spreads),
        Node::Text(_) | Node::Slot(_) | Node::Outlet => {}
    }
}

/// Which props of a call site a child spreads onto an element or another component.
#[derive(Clone, Debug, Default)]
enum SpreadSink {
    #[default]
    None,
    /// Every key except these (`{...props}` / `{...rest}`; several spreads union).
    AllBut(Vec<String>),
    /// Exactly these keys (`{...props.attrs}` spreads the call site's `attrs`).
    Only(Vec<String>),
}

impl SpreadSink {
    fn lands(&self, key: &str) -> bool {
        match self {
            SpreadSink::None => false,
            SpreadSink::AllBut(omit) => !omit.iter().any(|k| k == key),
            SpreadSink::Only(keys) => keys.iter().any(|k| k == key),
        }
    }

    /// The child's props spreads, read from its template (React tier: none, it renders itself).
    fn of(ir: &ComponentIR) -> SpreadSink {
        Self::of_where(ir, true)
    }

    /// [`Self::of`], counting spreads onto elements only when `elements` (always those into
    /// components).
    fn of_where(ir: &ComponentIR, elements: bool) -> SpreadSink {
        let named: Vec<String> = ir.props.iter().map(|p| p.name.clone()).collect();
        let mut sink = SpreadSink::None;
        let mut add = |v: &Expr| {
            let raw = match v {
                Expr::Raw(r) | Expr::Server(ServerExpr(r)) => r,
                _ => return,
            };
            let next = match &raw.kind {
                RawKind::Ident {
                    name,
                    kind: IdentKind::Prop,
                } if name == "*" => SpreadSink::AllBut(Vec::new()),
                RawKind::Ident {
                    name,
                    kind: IdentKind::Prop,
                } if name == crate::ir::REST_PROPS => SpreadSink::AllBut(named.clone()),
                _ => match crate::analyze::passes::deps::prop_path(raw) {
                    Some(p) => {
                        SpreadSink::Only(vec![p.split('.').next().unwrap_or(&p).to_string()])
                    }
                    None => return,
                },
            };
            sink = match (std::mem::take(&mut sink), next) {
                (SpreadSink::None, n) => n,
                (SpreadSink::AllBut(a), SpreadSink::AllBut(b)) => {
                    SpreadSink::AllBut(a.into_iter().filter(|k| b.contains(k)).collect())
                }
                (SpreadSink::AllBut(a), SpreadSink::Only(b))
                | (SpreadSink::Only(b), SpreadSink::AllBut(a)) => {
                    SpreadSink::AllBut(a.into_iter().filter(|k| !b.contains(k)).collect())
                }
                (SpreadSink::Only(mut a), SpreadSink::Only(b)) => {
                    a.extend(b);
                    SpreadSink::Only(a)
                }
                (s, SpreadSink::None) => s,
            };
        };
        fn walk(n: &Node, elements: bool, add: &mut dyn FnMut(&Expr)) {
            match n {
                Node::Element {
                    attrs, children, ..
                } => {
                    for a in attrs {
                        if let Attr::Spread(v) = a
                            && elements
                        {
                            add(v);
                        }
                    }
                    children.iter().for_each(|c| walk(c, elements, add));
                }
                Node::Component {
                    props, children, ..
                } => {
                    for (k, v) in props {
                        // F278: the rest handed to a clone as its input is spread there
                        if k == crate::ir::SPREAD_KEY || k == REST_INPUT {
                            add(v);
                        }
                    }
                    children.iter().for_each(|c| walk(c, elements, add));
                }
                Node::Fragment(cs) => cs.iter().for_each(|c| walk(c, elements, add)),
                Node::If { then, else_, .. } => then
                    .iter()
                    .chain(else_)
                    .for_each(|c| walk(c, elements, add)),
                Node::For { body, .. } => body.iter().for_each(|c| walk(c, elements, add)),
                Node::Text(_) | Node::Slot(_) | Node::Outlet => {}
            }
        }
        if !matches!(ir.tier, Tier::React { .. }) {
            walk(&ir.template, elements, &mut add);
        }
        sink
    }
}

/// Client reads a `RowOnly` link implies, and the child's (name, loc) when it precomputes over props.
type RowOnlyLink = (Vec<super::ClientUse>, Option<(String, u32)>);

fn linked_prop_precompute(name: &str, loc: u32) -> Diagnostic {
    Diagnostic::fallback(
        "linked-prop-precompute",
        format!(
            "<{name}> derives values from its props on the server, but its props change on the client"
        ),
        loc,
        "derive the value in the parent, or keep the child's props constant; the component renders as a React island",
    )
}

/// The marker key of a lowered element in an island's `children` prop (read by `reviveSource`).
const MARK: &str = "$brust";

/// The literal prop of an island instance that lists the props holding an element tree (R34.52):
/// the only thing that makes the revive turn a prop back into elements.
const X_KEY: &str = "$x";

/// R34.69 (F158): `name` is a page or layout and takes request data as props, so the caller's lowered JSX
/// (children or an element prop) is never revived for it; the caller renders with React instead.
fn root_host_diag(diagnostics: &mut Vec<Diagnostic>, name: &str, loc: u32) {
    diagnostics.push(Diagnostic::fallback(
        "revive-host-route-root",
        format!(
            "<{name}> is a page or layout, whose props are request data; brust never revives JSX children or element props for it"
        ),
        loc,
        "render it without JSX children, or move the shared part into a component that is not a route",
    ));
}

/// Shadcn S1 (R34.23): the most JSON one island instance's lowered children may take.
const MAX_CHILDREN_JSON: usize = 64 * 1024;

/// The component reads `children` somewhere other than as the child `{children}` itself (a condition, an attribute, a
/// `??`): the only reads an inlined instance can answer is the markup, never a value to test.
fn reads_children_as_value(ir: &ComponentIR) -> bool {
    fn strip(n: &mut Node) {
        match n {
            Node::Slot(Expr::Raw(r) | Expr::Server(ServerExpr(r))) if matches!(&r.kind, RawKind::Ident { name, kind: IdentKind::Prop } if name == "children") =>
            {
                *n = Node::Text(String::new());
            }
            Node::Element { children, .. }
            | Node::Fragment(children)
            | Node::Component { children, .. } => children.iter_mut().for_each(strip),
            Node::If { then, else_, .. } => then.iter_mut().chain(else_).for_each(strip),
            Node::For { body, .. } => body.iter_mut().for_each(strip),
            _ => {}
        }
    }
    let mut t = ir
        .structural
        .as_ref()
        .map_or_else(|| ir.template.clone(), |s| s.template.clone());
    strip(&mut t);
    let d = super::deps::DepsCx::new(ir).deps_node(&t, &[]);
    d.props
        .iter()
        .any(|p| p == "children" || p.starts_with("children."))
}

/// A key lucide-react 1.56 reads itself: any `aria-*`, `role` or `title` (it then drops its own `aria-hidden`),
/// `nonScalingStroke`, `iconNode`, `icon`, besides [`ICON_OWN_PROPS`]. Brust bakes `aria-hidden` at build time, so none of
/// them may reach an icon through a runtime spread.
fn icon_reads_itself(k: &str) -> bool {
    ICON_OWN_PROPS.contains(&k)
        || k.starts_with("aria-")
        || matches!(
            k,
            "role" | "title" | "nonScalingStroke" | "iconNode" | "icon"
        )
}

/// Props a lucide icon component reads itself; none may reach one through a runtime spread (R34.77).
const ICON_OWN_PROPS: &[&str] = &[
    "size",
    "color",
    "strokeWidth",
    "absoluteStrokeWidth",
    "width",
    "height",
    "className",
    "class",
    "children",
    "ref",
    "key",
    "style",
];

/// F148a (R34.120): at most this many values a lowered tree reads from props, per island.
const MAX_HOLES: usize = 64;

/// F148a (R34.121): the prop a wrapper's call site binds to the constant tree of its children, for the island
/// inside the wrapper that renders `{children}`. Reserved: no call site may pass it.
const CH_PROP: &str = "__ch";

/// F148a (R34.118): a name a prop-path value may not take on an element or a component: an object, a handler, or
/// a prop the revive reads itself.
fn hole_name_ok(k: &str) -> bool {
    !matches!(
        k,
        "children" | "ref" | "key" | "dangerouslySetInnerHTML" | "style" | "__proto__"
    ) && !k.starts_with('$')
        && crate::analyze::jsx::event_name(k).is_none()
}

/// A folded constant carries no marker key: it would read back as one of the compiler's nodes (R34.26 (d)).
fn marker_free(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::Object(o) => !o.contains_key(MARK) && o.values().all(marker_free),
        serde_json::Value::Array(a) => a.iter().all(marker_free),
        _ => true,
    }
}

/// A prop name an element may travel under (R34.52): never one the revive strips or reads itself.
fn slot_prop_ok(k: &str) -> bool {
    !matches!(
        k,
        "children" | "ref" | "key" | "dangerouslySetInnerHTML" | "__proto__"
    ) && !k.starts_with('$')
}

/// Attributes React reads a bare `<x disabled />` of as `true`; any other bare or empty attribute is
/// ambiguous in the IR (`aria-hidden` is `"true"`, `alt=""` is empty) and does not lower.
const BOOLEAN_ATTRS: &[&str] = &[
    "disabled",
    "checked",
    "selected",
    "readOnly",
    "required",
    "hidden",
    "multiple",
    "autoFocus",
    "autoPlay",
    "controls",
    "loop",
    "muted",
    "open",
    "reversed",
    "defaultChecked",
    "defaultSelected",
    "noValidate",
    "formNoValidate",
    "async",
    "defer",
    "inert",
    "playsInline",
    "allowFullScreen",
    "itemScope",
    "default",
    "noModule",
];

/// A JSON value as the literal expression the template and the SSR job print.
fn raw_json(v: &serde_json::Value, loc: u32) -> crate::ir::RawKind {
    use crate::ir::{Literal, RawKind};
    use serde_json::Value;
    let sub = |v: &Value| RawExpr {
        loc,
        kind: raw_json(v, loc),
    };
    match v {
        Value::Null => RawKind::Lit(Literal::Null),
        Value::Bool(b) => RawKind::Lit(Literal::Bool(*b)),
        Value::Number(n) => RawKind::Lit(Literal::Num(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => RawKind::Lit(Literal::Str(s.clone())),
        Value::Array(a) => RawKind::Array(a.iter().map(sub).collect()),
        Value::Object(o) => RawKind::Object(o.iter().map(|(k, v)| (k.clone(), sub(v))).collect()),
    }
}

/// `lucide-react` + `Heart` → `heart_1a2b3c4d`: the export's name and a hash of where it is from.
fn external_component_id(source: &str, export: &str, member: &[String]) -> String {
    let base = if export == "default" {
        source.rsplit('/').next().unwrap_or(source)
    } else if export == "*" {
        ""
    } else {
        export
    };
    let mut name: String = base
        .chars()
        .chain(member.iter().flat_map(|m| m.chars()))
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    if let Some(first) = name.get(..1).map(str::to_ascii_lowercase) {
        name.replace_range(..1, &first);
    }
    if name.is_empty() {
        name = "external".into();
    }
    // A member path is part of the identity: `Dialog.Root` and `Dialog.Trigger` are two components, and
    // a plain export keeps the id it always had.
    let scope = if member.is_empty() {
        format!("package:{source}")
    } else {
        format!("package:{source}:{export}:{}", member.join("."))
    };
    named_component_id(&scope, &name)
}

/// W1d (progress): a Provider that is React in its own module only because its frame needs a native provider
/// (`context-state`) and that a call site can specialise (`specialisable`): the call site builds a native clone, so the
/// package component is not an island of package source.
fn state_frame_provider(ir: &ComponentIR) -> bool {
    !ir.provides.is_empty()
        && !crate::analyze::context::frames_are_plain(ir)
        && crate::analyze::context::native_provider_problem(ir).is_none()
        && ir
            .diagnostics
            .iter()
            .filter(|d| d.class == DiagClass::Fallback)
            .all(|d| d.rule == "context-state")
}

/// F288 G7: `ir` refuses an element read (`element-value`), and every other refusal it has is one a clone of it for a
/// call site may drop (the clone decides: a clone that still needs React keeps the call site's island).
fn element_only(ir: &ComponentIR) -> bool {
    !ir.specialised
        && ir.provides.is_empty()
        && ir
            .diagnostics
            .iter()
            .any(|d| d.rule == super::elements::ELEMENT_VALUE)
        && ir
            .diagnostics
            .iter()
            .filter(|d| d.class == DiagClass::Fallback)
            .all(|d| {
                matches!(
                    d.rule.as_str(),
                    super::elements::ELEMENT_VALUE
                        | "ref-in-render"
                        | "client-function-in-job"
                        | "jsx-const-child"
                        | "children-read"
                ) || super::tier::CHILD_ONLY.contains(&d.rule.as_str())
            })
}

/// Why a component compiled from package source cannot be used as compiled (F153c): it, or a component in its
/// subtree, renders as React (an island of a package's SOURCE would run code the React build never ran), or it
/// failed to compile. `None` = static or native all the way down.
fn package_needs_react(
    lookup: &Lookup,
    modules: &crate::analyze::modules::ModuleCache,
    state_frames: bool,
) -> Option<String> {
    let ir = match lookup {
        Lookup::Compiled(ir) => ir.clone(),
        Lookup::Cycle => return Some("an import cycle".into()),
        Lookup::Failed(d) => return Some(d.message.clone()),
    };
    let by_id: HashMap<String, Rc<ComponentIR>> = modules
        .done()
        .into_iter()
        .map(|(_, ir)| (ir.id.clone(), ir))
        .collect();
    let mut stack = vec![ir];
    let mut seen = BTreeSet::new();
    while let Some(ir) = stack.pop() {
        if !seen.insert(ir.id.clone()) {
            continue;
        }
        // F288: an element reader is specialised at the call site like a state-frame Provider, from a package source too:
        // a call site that cannot keep its clone leaves a React child in that source, so the outermost package import
        // (written in app code) keeps its published island.
        if let Tier::React { reason, .. } = &ir.tier
            && !(element_only(&ir) || (state_frames && state_frame_provider(&ir)))
        {
            // F288 (u1): a call site whose clone failed is React because of that failure (the island it keeps is only
            // the consequence): name the failure.
            let reason = ir
                .diagnostics
                .iter()
                .find(|d| d.rule == "specialise-unsupported")
                .map_or(reason.as_str(), |d| d.message.as_str());
            return Some(format!(
                "{} renders as React in its source: {reason}",
                ir.source
            ));
        }
        for c in &ir.children {
            if let Tier::React { reason, .. } = &c.tier {
                return Some(format!(
                    "<{}> in {} renders as React: {reason}",
                    c.name, ir.source
                ));
            }
            if let Some(next) = c.id.as_ref().and_then(|id| by_id.get(id)) {
                stack.push(next.clone());
            }
        }
    }
    None
}

/// The export name of a `Primitive.<tag>` component (R34.65).
const PRIMITIVE_EXPORT: &str = "Primitive";

fn react(reason: &str) -> Tier {
    Tier::React {
        reason: reason.into(),
        client_only: false,
    }
}

/// F388 (Mellow N1): a child template whose root (through fragments and its `brust-host` wrapper) is a `left && <X/>`
/// that keeps the else branch printing `left`. By the time the caller reads it, `left` may be a server expression, so
/// the shape is the `&&` branch with one slot as its else.
fn falsy_left_root(n: &Node) -> bool {
    match n {
        Node::Fragment(ns) => ns.iter().any(falsy_left_root),
        Node::Element { tag, children, .. } if tag == "brust-host" => {
            children.iter().any(falsy_left_root)
        }
        Node::If {
            and: true, else_, ..
        } => matches!(else_.as_slice(), [Node::Slot(_)]),
        _ => false,
    }
}

/// F388 (Mellow N1): call-site content that is (through fragments and branches) the component's own `{children}`.
fn passes_children(n: &Node) -> bool {
    match n {
        Node::Slot(Expr::Raw(r) | Expr::Server(ServerExpr(r))) => {
            matches!(&r.kind, RawKind::Ident { name, kind: IdentKind::Prop } if name == "children")
        }
        Node::Fragment(ns) => ns.iter().any(passes_children),
        Node::If { then, else_, .. } => then.iter().chain(else_).any(passes_children),
        _ => false,
    }
}

/// F388 (Mellow N1): the template prints `{children}` directly in an element that takes no text (its `brust-host` wrapper
/// and fragments, branches and lists are transparent; a component it renders them through counts as the same element).
fn children_in_no_text(n: &Node, no_text: bool) -> bool {
    match n {
        Node::Slot(Expr::Raw(r) | Expr::Server(ServerExpr(r))) => {
            no_text
                && matches!(&r.kind, RawKind::Ident { name, kind: IdentKind::Prop } if name == "children")
        }
        Node::Element { tag, children, .. } => {
            let nt = if tag == "brust-host" {
                no_text
            } else {
                crate::analyze::component::NO_TEXT.contains(&tag.as_str())
            };
            children.iter().any(|c| children_in_no_text(c, nt))
        }
        Node::Component { children, .. } | Node::Fragment(children) => {
            children.iter().any(|c| children_in_no_text(c, no_text))
        }
        Node::If { then, else_, .. } => then
            .iter()
            .chain(else_)
            .any(|c| children_in_no_text(c, no_text)),
        Node::For { body, .. } => body.iter().any(|c| children_in_no_text(c, no_text)),
        _ => false,
    }
}

impl Walker<'_, '_> {
    fn node(&mut self, n: &mut Node) {
        match n {
            Node::Element { tag, children, .. } => {
                let saved = self.no_text;
                self.no_text = crate::analyze::component::NO_TEXT.contains(&tag.as_str());
                children.iter_mut().for_each(|c| self.node(c));
                self.no_text = saved;
            }
            Node::Fragment(children) => children.iter_mut().for_each(|c| self.node(c)),
            Node::If { then, else_, .. } => {
                self.guard_depth += 1;
                then.iter_mut().for_each(|c| self.node(c));
                else_.iter_mut().for_each(|c| self.node(c));
                self.guard_depth -= 1;
            }
            Node::For {
                source,
                item,
                index,
                body,
                ..
            } => {
                let src = (self.paths_of(source), self.deps_of(source).reactive());
                let n = self.loop_scope.len();
                self.loop_scope.push(item.clone());
                self.loop_scope.extend(index.iter().cloned());
                let raw = match &*source {
                    Expr::Server(ServerExpr(r)) => Some(r.clone()),
                    Expr::Precomputed { slot, .. } => {
                        self.st.slots.get(slot).map(|i| i.raw.clone())
                    }
                    _ => None,
                };
                let use_ = super::ClientUse {
                    loc: raw.as_ref().map_or(0, |r| r.loc),
                    deps: self.deps_of(source),
                    what: "a list the client updates",
                    raw: raw.map(|r| (r, self.loop_scope[..n].to_vec())),
                };
                let list_path = self.list_path(source);
                let literal = match &*source {
                    Expr::Raw(r) | Expr::Server(ServerExpr(r)) => {
                        r.json_literal().filter(serde_json::Value::is_array)
                    }
                    _ => None,
                };
                self.loop_sources.push(list_path);
                self.loop_literals.push(literal);
                self.lists.push(src);
                self.list_uses.push(use_);
                self.items.push(item.clone());
                self.indexes.push(index.clone());
                let module = self.module_list(source);
                self.module_rows
                    .set(self.module_rows.get() + usize::from(module));
                body.iter_mut().for_each(|c| self.node(c));
                self.module_rows
                    .set(self.module_rows.get() - usize::from(module));
                self.indexes.pop();
                self.items.pop();
                self.loop_sources.pop();
                self.loop_literals.pop();
                self.list_uses.pop();
                self.lists.pop();
                self.loop_scope.truncate(n);
            }
            Node::Component { .. } => self.component(n),
            Node::Text(_) | Node::Slot(_) | Node::Outlet => {}
        }
    }

    /// The first component in `nodes` (at any depth) that reads a context (`ctx_uses` non-empty), is not itself a
    /// React island, and carries a job, a `useId` or fed child instances (a wrapper around one), or reads a context declared in a package
    /// source (`ctx_pkg`; revived from the map source it would not share the Provider island's dist `createContext`): those need the
    /// hidden inputs a frame fills. A plain one is revived by the island from its source and reads the island's own
    /// React context.
    /// F298: a component among `nodes` (at any depth) reads a context.
    fn reads_context_in(&mut self, nodes: &[Node]) -> bool {
        nodes.iter().any(|n| match n {
            Node::Component {
                loc,
                name,
                source,
                imported,
                member,
                children,
                ..
            } => {
                let reads = name != "<member>" && {
                    let mark = self.diagnostics.len();
                    let child = self.resolve_child(
                        name,
                        source.as_deref(),
                        imported.as_deref(),
                        member,
                        *loc,
                    );
                    self.diagnostics.truncate(mark);
                    child.ir.as_ref().is_some_and(|c| !c.ctx_uses.is_empty())
                };
                reads || self.reads_context_in(children)
            }
            Node::Element { children, .. } | Node::Fragment(children) => {
                self.reads_context_in(children)
            }
            Node::If { then, else_, .. } => {
                self.reads_context_in(then) || self.reads_context_in(else_)
            }
            Node::For { body, .. } => self.reads_context_in(body),
            Node::Text(_) | Node::Slot(_) | Node::Outlet => false,
        })
    }

    fn consumer_in(&mut self, nodes: &[Node]) -> Option<String> {
        for n in nodes {
            match n {
                Node::Component {
                    loc,
                    name,
                    source,
                    imported,
                    member,
                    children,
                    ..
                } => {
                    if name != "<member>" {
                        let mark = self.diagnostics.len();
                        let child = self.resolve_child(
                            name,
                            source.as_deref(),
                            imported.as_deref(),
                            member,
                            *loc,
                        );
                        self.diagnostics.truncate(mark);
                        if child.ir.as_ref().is_some_and(|c| {
                            matches!(c.tier, Tier::Static | Tier::Native)
                                && !c.ctx_uses.is_empty()
                                && (c.ctx_pkg
                                    || !c.jobs.is_empty()
                                    || c.use_id_slots > 0
                                    || !c.instances.is_empty())
                        }) {
                            return Some(name.clone());
                        }
                    }
                    if let Some(w) = self.consumer_in(children) {
                        return Some(w);
                    }
                }
                Node::Element { children, .. } | Node::Fragment(children) => {
                    if let Some(w) = self.consumer_in(children) {
                        return Some(w);
                    }
                }
                Node::If { then, else_, .. } => {
                    if let Some(w) = self.consumer_in(then).or_else(|| self.consumer_in(else_)) {
                        return Some(w);
                    }
                }
                Node::For { body, .. } => {
                    if let Some(w) = self.consumer_in(body) {
                        return Some(w);
                    }
                }
                Node::Text(_) | Node::Slot(_) | Node::Outlet => {}
            }
        }
        None
    }

    /// The frames walk of [`contexts`].
    fn frames_node(
        &mut self,
        n: &mut Node,
        frames: &mut Vec<Frame>,
        bubbled: &mut Vec<(String, String)>,
        diags: &mut Vec<Diagnostic>,
    ) {
        // R34.122: a call site that cannot be specialised keeps the island Provider it had before (the page stays what
        // it was): the node is read again as an ordinary one, with the reason as an info.
        let snapshot = matches!(n, Node::Component { .. }).then(|| {
            (
                n.clone(),
                frames.len(),
                bubbled.len(),
                diags.len(),
                self.native_props.len(),
            )
        });
        self.frames_node_once(n, frames, bubbled, diags);
        let mine = match n {
            Node::Component { loc, .. } => Some(*loc),
            _ => None,
        };
        // A failure belongs to the Provider call site it names; an outer wrapper handles one found deeper.
        if self.spec_failure.as_ref().map(|(l, _)| *l) == mine
            && mine.is_some()
            && let Some((loc, why)) = self.spec_failure.take()
            && let Some((saved, nf, nb, nd, np)) = snapshot
        {
            *n = saved;
            frames.truncate(nf);
            bubbled.truncate(nb);
            diags.truncate(nd);
            self.native_props.truncate(np);
            self.no_spec.insert(loc);
            diags.push(Diagnostic::info(
                "specialise-unsupported",
                format!("this component stays a React island for this call site: {why}"),
                loc,
                "keep the content simple (components, text, constants) to have the Provider lowered",
            ));
            self.frames_node_once(n, frames, bubbled, diags);
        }
    }

    fn frames_node_once(
        &mut self,
        n: &mut Node,
        frames: &mut Vec<Frame>,
        bubbled: &mut Vec<(String, String)>,
        diags: &mut Vec<Diagnostic>,
    ) {
        match n {
            Node::Element { children, .. } | Node::Fragment(children) => children
                .iter_mut()
                .for_each(|c| self.frames_node(c, frames, bubbled, diags)),
            Node::If { then, else_, .. } => {
                then.iter_mut()
                    .for_each(|c| self.frames_node(c, frames, bubbled, diags));
                else_
                    .iter_mut()
                    .for_each(|c| self.frames_node(c, frames, bubbled, diags));
            }
            Node::For {
                body, item, index, ..
            } => {
                // F344: the row's names are loop bindings here too (a clone made in a row must not pin a row value).
                let n = self.loop_scope.len();
                self.loop_scope.push(item.clone());
                self.loop_scope.extend(index.iter().cloned());
                body.iter_mut()
                    .for_each(|c| self.frames_node(c, frames, bubbled, diags));
                self.loop_scope.truncate(n);
            }
            Node::Component {
                loc,
                name,
                source,
                imported,
                member,
                props,
                children,
                ..
            } => {
                if name == "<member>" {
                    children
                        .iter_mut()
                        .for_each(|c| self.frames_node(c, frames, bubbled, diags));
                    return;
                }
                let mark = self.diagnostics.len();
                let child =
                    self.resolve_child(name, source.as_deref(), imported.as_deref(), member, *loc);
                // The children pass resolves it again and reports; these diagnostics are not repeated.
                self.diagnostics.truncate(mark);
                let Some(mut cir) = child.ir.clone() else {
                    children
                        .iter_mut()
                        .for_each(|c| self.frames_node(c, frames, bubbled, diags));
                    return;
                };
                // F298: children that travel in the rest the component spreads under a Provider of its own reach that
                // Provider only inside the component: a clone of it for this call site holds them where the rest is
                // spread. Tried only for a context consumer among the children; anything else keeps today's path.
                if let Some(from) = child.path.clone()
                    && cir.provides.is_empty()
                    && !cir.specialised
                    && (cir.props_rest.is_some() || spreads_whole_props(&cir.template))
                    && !children.is_empty()
                    && self.reads_context_in(children)
                {
                    match self.specialise_forwarder(&cir, &from, *loc, children, props) {
                        Ok((clone, (id, key, inputs))) => {
                            props.extend(inputs);
                            *name = id;
                            *source = Some(SPEC_SOURCE.to_string());
                            *imported = Some(key);
                            member.clear();
                            children.clear();
                            cir = clone;
                        }
                        Err(why) => diags.push(Diagnostic::info(
                            "rest-children-unsupported",
                            format!("the children of <{name}> stay outside it: {why}"),
                            *loc,
                            "",
                        )),
                    }
                }
                // A React island (and what it receives as children or element props) renders with React's own
                // context at run time: nothing in its subtree is read here, and it provides nothing at compile time.
                // R34.116/R34.122: a Provider whose frame is state-valued is specialised for this call site below.
                let native_prov = child.path.is_some()
                    && !self.no_spec.contains(loc)
                    && self.specialisable(&cir, self.renders.iter().any(|r| r.loc == *loc));
                // F288 G7 (A1): a component that reads its children only as an element is specialised per call site like
                // a Provider (the same `specialise`, the same key), with no frame of its own.
                let element_spec = !native_prov
                    && child.path.is_some()
                    && !self.no_spec.contains(loc)
                    && self.element_specialisable(&cir);
                let island = !matches!(cir.tier, Tier::Static | Tier::Native)
                    && !native_prov
                    && !element_spec;
                // R34.140: a `<Collection.Slot>` over a component hands it the root marker, which only a native instance's
                // host prints; a static (hostless) component or a React island would drop it, and `getItems()` would find
                // nothing where React finds the items (fail closed)
                if props
                    .iter()
                    .any(|(k, _)| k == crate::ir::COLLECTION_ROOT_PROP)
                    && !matches!(cir.tier, Tier::Native)
                    && !native_prov
                {
                    diags.push(Diagnostic::fallback(
                        "collection-shape",
                        format!(
                            "<Collection.Slot> wraps <{name}>, which is not a native component with a host of its own to carry the collection root"
                        ),
                        *loc,
                        "put the Slot around an element, or around a component that holds state",
                    ));
                }
                // F328b: a `<Collection.ItemSlot>` over a component hands it the item data; the caller prints the item
                // markers on the child's host, so the child must be a static or native component whose root is ONE
                // host element (a React island or a fragment root has no element to carry them: fail closed).
                if props
                    .iter()
                    .any(|(k, _)| k == crate::ir::COLLECTION_ITEM_PROP)
                    && (island
                        // React's Slot hands the markers to the child as props: a child that does not spread them onto its
                        // element drops them (the item is then not listed); brust prints them only where React does.
                        || !child.spread.lands("data-radix-collection-item")
                        // The item directive reads its data in the scope of the nearest `x-data`: the child's element must be in
                        // THIS component's scope (a static child printed inline), and this component must have an instance on the client.
                        || !matches!(cir.tier, Tier::Static)
                        || !self.props_live
                        || !matches!(
                            &cir.template,
                            Node::Element {
                                synthetic: false,
                                ..
                            }
                        ))
                {
                    diags.push(Diagnostic::fallback(
                        "collection-shape",
                        format!(
                            "<Collection.ItemSlot> wraps <{name}>, which is not a static component, inside a component with state or handlers, that spreads its props onto its one root element to carry the item markers"
                        ),
                        *loc,
                        "put the ItemSlot around an element, or around a component that renders one element",
                    ));
                }
                // F3 (fail closed): a Provider that is lowered away no longer shares a React tree with an island
                // under it, which would hydrate standalone and read the context DEFAULT. Any island (or a static
                // child holding one) under an active frame, or inside a Provider's own tree, keeps the page React.
                // R34.122: an island among the content of a native frame cannot move into the clone (it would hydrate
                // standalone and read the context default): that Provider call site keeps its island.
                let under_native = (island || cir.holds_island)
                    .then(|| frames.iter().rev().find_map(|f| f.owner.map(|_| f.loc)))
                    .flatten();
                if let Some(at) = under_native {
                    self.spec_failure.get_or_insert((
                        at,
                        format!("<{name}> is, or holds, a React island in the content"),
                    ));
                } else if ((island || cir.holds_island) && !frames.is_empty())
                    || (!island && cir.holds_island && !cir.provides.is_empty())
                {
                    diags.push(Diagnostic::fallback(
                        "context-island",
                        format!(
                            "<{name}> is, or holds, a React island under a context Provider that is rendered natively; an island would not see the Provider's value"
                        ),
                        *loc,
                        "keep the island outside the Provider, or render the page with React",
                    ));
                }
                // A context consumer passed as the children of a React island is revived by the island from its source: it
                // reads the island's own (real React) context, which brust did not lower, so it must not be compiled as a
                // native consumer waiting for a frame. Fail closed (the page renders with React) instead of leaving a
                // consumer with a job and no instance record (R34.97: valid React is never a build error).
                if island && let Some(who) = self.consumer_in(children) {
                    diags.push(Diagnostic::fallback(
                        "context-island",
                        format!("<{who}> reads a context and is passed as the children of the React island <{name}>; the island supplies that context at run time"),
                        *loc,
                        "render the page with React, or keep the consumer inside the Provider component",
                    ));
                }
                if island {
                    return;
                }
                // The `__ctx_` prefix is the lowering's own. This pass runs before the lowering adds any hidden prop, so
                // every prop met here with that prefix was written by the author: it would override a frame value.
                if !self.ctx.specialised
                    && let Some((k, _)) = props.iter().find(|(k, _)| k.starts_with("__ctx_"))
                {
                    diags.push(Diagnostic::fallback(
                        "context-shape",
                        format!("the prop `{k}` uses the `__ctx_` prefix, which brust reserves for context values"),
                        *loc,
                        "rename the prop",
                    ));
                }
                // W1d PR 2 (Mellow C4): the scope a call site would hand to a native component is never followed (frames are
                // resolved by position), so a `__scope*` attribute on one stays an island. An unknown spread is already
                // refused (`spread-props`); a props or rest spread can only carry what a caller wrote, which this refuses.
                // switch-provider-chain (ruling 7a25d5e0): this component's own scope prop handed on unchanged under its
                // own name (Radix's `Switch` to `SwitchTrigger`) names a scope only if a caller passes one: the
                // requirement "callers do not pass it" moves up (`absent_props`, as `require_absent` does).
                let forwards_own_scope = |k: &str, v: &Expr| {
                    !self.ctx.is_root
                        && self.own_scopes.contains(k)
                        && matches!(v, Expr::Raw(r) | Expr::Server(ServerExpr(r))
                            if matches!(&r.kind, RawKind::Ident { name, kind: IdentKind::Prop } if name == k))
                };
                // F356 (ruling 7a25d5e0): a written literal `undefined` names no scope (as `require_absent` reads it).
                let scope_undefined = |v: &Expr| {
                    matches!(v, Expr::Raw(r) | Expr::Server(ServerExpr(r))
                        if matches!(r.kind, RawKind::Lit(crate::ir::Literal::Undefined)))
                };
                if !self.ctx.specialised
                    && matches!(cir.tier, Tier::Static | Tier::Native)
                    && let Some((k, _)) = props.iter().find(|(k, v)| {
                        k.starts_with("__scope") && !forwards_own_scope(k, v) && !scope_undefined(v)
                    })
                {
                    diags.push(Diagnostic::fallback(
                        "context-scope",
                        format!("the prop `{k}` hands a Radix scope to <{name}>, which brust resolves by position"),
                        *loc,
                        "do not pass a scope to a native component, or keep this component in React",
                    ));
                }
                if !self.ctx.specialised && matches!(cir.tier, Tier::Static | Tier::Native) {
                    for (k, v) in props.iter() {
                        if k.starts_with("__scope") && !scope_undefined(v) {
                            self.absent.insert(k.clone());
                        }
                    }
                }
                // Consumer: each field it reads comes from the nearest frame of its context, else bubbles up.
                for u in &cir.ctx_uses {
                    for f in &u.fields {
                        let hidden = crate::ir::ctx_prop(&u.context, f);
                        if props.iter().any(|(k, _)| k == &hidden) {
                            continue;
                        }
                        let whole = f == crate::analyze::hooks::WHOLE_FIELD;
                        if let Some(fr) = frames.iter().rev().find(|fr| fr.context == u.context)
                            && whole
                                != fr
                                    .fields
                                    .iter()
                                    .any(|(k, _)| k == crate::analyze::hooks::WHOLE_FIELD)
                            && (whole || !fr.fields.is_empty())
                        {
                            diags.push(Diagnostic::fallback(
                                "context-shape",
                                format!(
                                    "<{name}> reads a context {} and its Provider hands out {}",
                                    if whole { "as a whole value" } else { "by field" },
                                    if whole { "fields" } else { "a whole value" },
                                ),
                                *loc,
                                "read the context the way its Provider writes the value, or keep this component in React",
                            ));
                        }
                        // W1d PR 2 (Mellow C2): with a scope anywhere in the region, nested frames of one context cannot be
                        // told apart by position (React picks the Provider by scope): fail closed
                        let region: Vec<&Frame> =
                            frames.iter().filter(|fr| fr.context == u.context).collect();
                        if region.len() >= 2
                            && (cir.ctx_scoped.contains(&u.context)
                                || region.iter().any(|fr| fr.scoped))
                            && !diags
                                .iter()
                                .any(|d| d.rule == "context-scope" && d.loc == *loc)
                        {
                            diags.push(Diagnostic::fallback(
                                "context-scope",
                                format!(
                                    "<{name}> reads a context under nested Providers of the same context and a scope is in play; position alone cannot tell which one its scope names"
                                ),
                                *loc,
                                "do not nest scoped Providers of one context, or keep this component in React",
                            ));
                        }
                        if !frames.iter().any(|fr| fr.context == u.context)
                            && cir.ctx_scoped.contains(&u.context)
                            && !self.bubbled_scoped.contains(&u.context)
                        {
                            self.bubbled_scoped.push(u.context.clone());
                        }
                        let value = match frames.iter().rev().find(|fr| fr.context == u.context) {
                            Some(fr) => Expr::Raw(
                                fr.fields
                                    .iter()
                                    .find(|(k, _)| k == f)
                                    .map(|(_, v)| v.clone())
                                    .unwrap_or_else(|| RawExpr {
                                        loc: *loc,
                                        kind: RawKind::Lit(crate::ir::Literal::Undefined),
                                    }),
                            ),
                            None => {
                                self.bubbled_pkg |= cir.ctx_pkg;
                                if let Some((_, d)) =
                                    cir.ctx_defaults.iter().find(|(c, _)| c == &u.context)
                                    && !self.ctx_defaults.iter().any(|(c, _)| c == &u.context)
                                {
                                    self.ctx_defaults.push((u.context.clone(), d.clone()));
                                }
                                if !bubbled.iter().any(|(c, g)| c == &u.context && g == f) {
                                    bubbled.push((u.context.clone(), f.clone()));
                                }
                                Expr::Raw(RawExpr {
                                    loc: *loc,
                                    kind: RawKind::Ident {
                                        name: hidden.clone(),
                                        kind: IdentKind::Prop,
                                    },
                                })
                            }
                        };
                        if let Some(o) = frames
                            .iter()
                            .rev()
                            .find(|fr| fr.context == u.context)
                            .and_then(|fr| fr.owner)
                        {
                            self.native_props.push((*loc, hidden.clone(), o));
                        }
                        props.push((hidden, value));
                    }
                }
                // Provider: its values, in this scope, for the children passed to it.
                let mut pushed = 0;
                let owner = native_prov.then(|| {
                    self.next_owner += 1;
                    self.next_owner
                });
                // A clone already holds the content its frame served: it pushes no frame of its own.
                for pd in cir.provides.iter().filter(|_| !cir.specialised) {
                    if let Some(o) = owner {
                        // R34.116: the fields stay expressions of the Provider's own scope.
                        frames.push(Frame {
                            context: pd.context.clone(),
                            fields: pd.fields.clone(),
                            owner: Some(o),
                            loc: *loc,
                            scoped: pd.scoped,
                        });
                        pushed += 1;
                        continue;
                    }
                    let mut fields = Vec::new();
                    let mut failed = None;
                    for (k, raw) in &pd.fields {
                        match self.subst(raw, &cir, props, 0).and_then(|v| {
                            plain_frame_value(&v)
                                .map(|()| v)
                                .map_err(|w| format!("`{k}` is {w}"))
                        }) {
                            Ok(v) => fields.push((k.clone(), v)),
                            Err(why) => {
                                failed = Some(why);
                                break;
                            }
                        }
                    }
                    match failed {
                        None => {
                            frames.push(Frame {
                                context: pd.context.clone(),
                                fields,
                                owner: None,
                                loc: *loc,
                                scoped: pd.scoped,
                            });
                            pushed += 1;
                        }
                        Some(why) => diags.push(Diagnostic::fallback(
                            "context-value",
                            format!(
                                "<{name}> provides a value brust cannot express where it is used: {why}"
                            ),
                            *loc,
                            "keep this component in React, or provide plain props-derived values",
                        )),
                    }
                }
                if pushed > 0 {
                    self.provider_locs.insert(*loc);
                }
                children
                    .iter_mut()
                    .for_each(|c| self.frames_node(c, frames, bubbled, diags));
                // B7: the body of a render prop is read where the Provider renders it, under its frame.
                let mut render = None;
                if (owner.is_some() || element_spec)
                    && let Some(i) = self.renders.iter().position(|r| r.loc == *loc)
                {
                    let mut rp = self.renders.remove(i);
                    rp.body
                        .iter_mut()
                        .for_each(|c| self.frames_node(c, frames, bubbled, diags));
                    render = Some(rp);
                }
                frames.truncate(frames.len() - pushed);
                // An element clone owns no frame (`usize::MAX`), as a rest clone (F298).
                if let Some(o) = owner.or(element_spec.then_some(usize::MAX))
                    && self.spec_failure.as_ref().map(|(l, _)| *l) != Some(*loc)
                {
                    // R34.122: the Provider and its content become one component for this call site.
                    let from = child.path.clone().unwrap_or_default();
                    let render_key = render.as_ref().map(|r| r.key.clone());
                    match self.specialise(&cir, &from, (o, *loc, render), props, children) {
                        Ok((id, key, inputs)) => {
                            if let Some(k) = render_key {
                                props.retain(|(p, _)| *p != k);
                            }
                            // S2: the call site's names the content reads cross as props of the clone.
                            props.extend(inputs);
                            *name = id;
                            *source = Some(SPEC_SOURCE.to_string());
                            *imported = Some(key);
                            member.clear();
                            children.clear();
                        }
                        Err(why) => self.spec_failure = Some((*loc, why)),
                    }
                }
                // F307 (option B): the children pass refused this call site's content, printed inside the child's own host
                // (`slot-owner`): the child is cloned for it with the content at its `{children}`, so the content's
                // directives are the clone's own. After the content's frames are read, so A1 sees every consumer in it.
                if owner.is_none()
                    && self.st.host_spec.contains(loc)
                    && !children.is_empty()
                    && let Some(from) = child.path.clone()
                {
                    let poly_flag = cir
                        .poly
                        .as_ref()
                        .filter(|p| flag_selects_slot(p, props))
                        .map(|p| p.flag.clone());
                    match self.specialise_host(&cir, &from, *loc, children, props) {
                        Ok((id, key, inputs)) => {
                            // F369b: the flag is settled in the clone (the child is in its element's place).
                            if let Some(flag) = poly_flag {
                                props.retain(|(k, _)| *k != flag);
                            }
                            props.extend(inputs);
                            *name = id;
                            *source = Some(SPEC_SOURCE.to_string());
                            *imported = Some(key);
                            member.clear();
                            children.clear();
                        }
                        Err(why) => diags.push(Diagnostic::info(
                            if why.starts_with(SLOT_TEXT_WRAPPER) {
                                SLOT_TEXT_WRAPPER
                            } else {
                                "host-specialise-unsupported"
                            },
                            format!("the children of <{name}> stay outside it: {why}"),
                            *loc,
                            "",
                        )),
                    }
                }
            }
            Node::Text(_) | Node::Slot(_) | Node::Outlet => {}
        }
    }

    /// F288 G7: `cir` refuses an element read (`element-value`), and every other refusal it has is one a clone of it for a
    /// call site may drop (the clone decides: a clone that still needs React keeps the call site's island).
    fn element_specialisable(&self, cir: &ComponentIR) -> bool {
        element_only(cir)
    }

    /// R34.116: whether `cir` is a Provider whose frame is state-valued and a native clone of it can carry the frame.
    fn specialisable(&self, cir: &ComponentIR, render: bool) -> bool {
        // A clone already carries its content (it is what a call site names after specialising).
        !cir.specialised
            && !cir.provides.is_empty()
            && !crate::analyze::context::frames_are_plain(cir)
            && crate::analyze::context::native_provider_problem(cir).is_none()
            // The island diagnostic `context-state` is the only reason it is React; a clone drops it.
            && cir
                .diagnostics
                .iter()
                .filter(|d| d.class == DiagClass::Fallback)
                .all(|d| {
                    d.rule == "context-state"
                        || super::tier::CHILD_ONLY.contains(&d.rule.as_str())
                        // B7: the call of the render prop is what it reads as a value; it is spliced away.
                        || (render && d.rule == "jsx-const-child")
                })
    }

    /// R34.122-R34.123: a clone of `cir` (re-read from its module) whose `{children}` is `content`, compiled as its own
    /// component. Returns its id and cache key.
    fn specialise(
        &mut self,
        cir: &Rc<ComponentIR>,
        c_path: &str,
        site: (usize, u32, Option<crate::ir::RenderProp>),
        props: &[(String, Expr)],
        content: &mut Vec<Node>,
    ) -> Result<Specialised, String> {
        // (the Provider instance's owner id, the call site's location, its render prop)
        let (owner, loc, render) = site;
        let ctx = self.ctx;
        let export = match &cir.export {
            Some(n) => Export::Named(n.clone()),
            None => Export::Default,
        };
        // F374: with no children written at the call site, a spread (or a `children` prop) may still carry them, and
        // the clone's `{children}` would be empty where React renders them (`function Outer(props) { return <Prov
        // {...props} /> }`, `<Outer>hello</Outer>` printed an empty section). Refused by name: the Provider stays an
        // island and React renders it with its children.
        // F288 S2: the function between the tags is the `children` render prop, which the clone does hold.
        let render_children = render.as_ref().is_some_and(|r| r.key == "children");
        if content.is_empty()
            && let Some((k, _)) = props.iter().find(|(k, _)| {
                k == crate::ir::SPREAD_KEY
                    || k == REST_INPUT
                    || (k == "children" && !render_children)
            })
        {
            return Err(if k == "children" {
                "its children are given as the `children` prop, which the clone cannot hold".into()
            } else {
                "a spread may carry its children, which the clone cannot hold".into()
            });
        }
        let mut nodes = std::mem::take(content);
        self.check_owner(&nodes, owner)?;
        self.check_inner_providers(cir, &nodes)?;
        let mut carry = Carry::new(
            &self.native_props,
            owner,
            &self.module_names,
            &self.row_handlers,
            &self.st.handler_names,
            &self.module_consts,
            cir.props.iter().map(|p| p.name.clone()).collect(),
        );
        carry.nodes(&mut nodes, &[])?;
        rebase_sources(&mut nodes, ctx.path, c_path, ctx.opts, ctx.modules)?;
        // B7: the render prop's body moves into the clone like the children do. Any other function the call site
        // passes cannot cross (the clone has no instance to hand it to).
        let mut render = render;
        if let Some(rp) = &mut render {
            if let Some((k, _)) = props
                .iter()
                .find(|(k, v)| *k != rp.key && matches!(v, Expr::ClientOnly { .. }))
            {
                return Err(format!(
                    "the prop `{k}` is a function besides the render prop"
                ));
            }
            let locals: Vec<String> = rp.params.iter().map(|(_, l)| l.clone()).collect();
            self.check_owner(&rp.body, owner)?;
            carry.nodes(&mut rp.body, &locals)?;
            rebase_sources(&mut rp.body, ctx.path, c_path, ctx.opts, ctx.modules)?;
        }
        let exp = cir.export.as_deref().unwrap_or("default");
        // One clone per call site: its id is built from the call site, so its jinja, jobs and instance records are the
        // call site's own. Clones whose chunks are equal share ONE factory module at lowering (R34.124). Inside a rest
        // clone (F298) the call site is that clone's: the same call of the same module holds other content there.
        // F238: and the content's shape, so two call sites at one offset of one template (content written in another
        // module keeps that module's offsets) never share a clone.
        let site = match &self.spec_salt {
            Some(salt) => format!("{}#{salt}", ctx.path),
            None => ctx.path.to_string(),
        };
        let site = clone_site(&site, &nodes, &render);
        let id = format!("{}_s{:08x}", cir.id, spec_hash(&site, loc));
        let key = format!("{c_path}#{exp}~spec~{site}~{loc}");
        let mut once = Some(nodes);
        let clone_id = id.clone();
        let (inputs, clone_handlers) = carry.finish();
        // An input the call site does not change on the client stays fixed in the clone.
        let fixed = self.pinned(cir, props, &inputs);
        let react_19 = super::elements::resolves_react_19(&ctx.opts.root);
        let clone = crate::analyze::modules::compile_specialised(
            c_path,
            &export,
            key.clone(),
            ctx.opts,
            ctx.modules,
            &mut |ir: &mut ComponentIR, parsed: &crate::parse::Parsed| {
                // F288: a component that reads its children as an element folds them for this call site first.
                let mut content = once.take();
                if !super::elements::fold(ir, parsed, &mut render, &mut content, react_19)? {
                    if let Some(rp) = render.take() {
                        splice_render(ir, rp)?;
                    }
                    splice_children(ir, content.unwrap_or_default())?;
                }
                for (hidden, _) in &inputs {
                    ir.props.push(crate::ir::PropDecl {
                        name: hidden.clone(),
                        local: hidden.clone(),
                        ts_type: None,
                        default: None,
                    });
                }
                ir.handlers.extend(clone_handlers.iter().cloned());
                ir.fixed_props = fixed.clone();
                ir.id = clone_id.clone();
                ir.specialised = true;
                ir.diagnostics.retain(|d| d.rule != "context-state");
                Ok(())
            },
        )?;
        // A clone that still needs React would be an island of the Provider WITHOUT the content that moved into it:
        // the call site keeps the island it had, with its children.
        if let Tier::React { reason, .. } = &clone.tier {
            let reason = reason.clone();
            ctx.modules.borrow_mut().remove(&key);
            return Err(format!("the specialised component needs React ({reason})"));
        }
        Ok((id, key, inputs))
    }

    /// F298: a clone of `cir`, a component that spreads its `...rest` under a Provider of its own, with the call site's
    /// children (`content`) put where the rest is spread (`splice_rest_children`), compiled as a component of its own:
    /// the consumers among them then sit under that Provider, as they render in React. The call site's names they read
    /// cross as hidden inputs (`Carry`), as for a Provider's content (R34.123). `content` is left as it was on `Err`.
    fn specialise_forwarder(
        &mut self,
        cir: &Rc<ComponentIR>,
        c_path: &str,
        loc: u32,
        content: &[Node],
        props: &[(String, Expr)],
    ) -> Result<(Rc<ComponentIR>, Specialised), String> {
        let ctx = self.ctx;
        let export = match &cir.export {
            Some(n) => Export::Named(n.clone()),
            None => Export::Default,
        };
        let mut nodes = content.to_vec();
        // No native frame is open around this call site's children for them (`usize::MAX` owns none): a consumer of an
        // outer native Provider among them keeps today's path.
        self.check_owner(&nodes, usize::MAX)?;
        let mut carry = Carry::new(
            &self.native_props,
            usize::MAX,
            &self.module_names,
            &self.row_handlers,
            &self.st.handler_names,
            &self.module_consts,
            cir.props.iter().map(|p| p.name.clone()).collect(),
        );
        carry.nodes(&mut nodes, &[])?;
        rebase_sources(&mut nodes, ctx.path, c_path, ctx.opts, ctx.modules)?;
        let exp = cir.export.as_deref().unwrap_or("default");
        let site = match &self.spec_salt {
            Some(salt) => format!("{}#{salt}", ctx.path),
            None => ctx.path.to_string(),
        };
        // F238: the content's shape too (see `specialise`).
        let site = clone_site(&site, &nodes, &None::<()>);
        let id = format!("{}_r{:08x}", cir.id, spec_hash(&site, loc));
        let key = format!("{c_path}#{exp}~rest~{site}~{loc}");
        let clone_id = id.clone();
        let (inputs, clone_handlers) = carry.finish();
        let fixed = self.pinned(cir, props, &inputs);
        let mut once = Some(nodes);
        let clone = crate::analyze::modules::compile_specialised(
            c_path,
            &export,
            key.clone(),
            ctx.opts,
            ctx.modules,
            &mut |ir: &mut ComponentIR, _: &crate::parse::Parsed| {
                splice_rest_children(ir, once.take().unwrap_or_default())?;
                for (hidden, _) in &inputs {
                    ir.props.push(crate::ir::PropDecl {
                        name: hidden.clone(),
                        local: hidden.clone(),
                        ts_type: None,
                        default: None,
                    });
                }
                ir.handlers.extend(clone_handlers.iter().cloned());
                ir.fixed_props = fixed.clone();
                ir.id = clone_id.clone();
                ir.specialised = true;
                ir.rest_clone_of = Some(ctx.path.to_string());
                Ok(())
            },
        )?;
        if let Tier::React { reason, .. } = &clone.tier {
            // The Provider inside that stayed an island says why better than the island it left.
            let reason = clone
                .diagnostics
                .iter()
                .find(|d| d.rule == "specialise-unsupported")
                .map_or_else(|| reason.clone(), |d| d.message.clone());
            ctx.modules.borrow_mut().remove(&key);
            return Err(format!("the specialised component needs React ({reason})"));
        }
        Ok((clone, (id, key, inputs)))
    }

    /// F307: a `slot-owner` refusal at `loc` the frames pass may answer by cloning the child with the content (on the
    /// component's second read, `run_passes`). Only a lowered child of a module (not a Provider, not a clone) that prints
    /// a real `{children}` slot (S1), and not polymorphic (`asChild`: its host is the element between its tags, which
    /// the call site must keep); a call site already tried keeps its refusal.
    fn want_host(&mut self, loc: u32, child: &Child) {
        if child.path.is_some()
            && child.poly.is_none()
            && !self.st.host_spec.contains(&loc)
            && child
                .ir
                .as_deref()
                .is_some_and(|c| c.provides.is_empty() && !c.specialised && prints_children_slot(c))
        {
            self.st.host_wanted.insert(loc);
        }
    }

    /// F369b: a `slot-native` refusal at `loc` (a native polymorphic parent, a literal true flag, ONE child) the frames
    /// pass may answer by cloning the parent with the child in its polymorphic element's place (`splice_poly`).
    fn want_host_poly(&mut self, loc: u32, child: &Child) {
        if child.path.is_some()
            && child.poly.is_some()
            && !self.st.host_spec.contains(&loc)
            && child
                .ir
                .as_deref()
                .is_some_and(|c| c.provides.is_empty() && !c.specialised && prints_children_slot(c))
        {
            self.st.host_wanted.insert(loc);
        }
    }

    /// F307 (option B): a clone of the host child `cir` whose `{children}` is `content`, compiled as a component of its
    /// own for this call site. The call site's names the content reads cross as hidden inputs (`Carry`, as for a
    /// Provider's content, R34.123). Refused, and the call site keeps its `slot-owner` refusal, when: the child is a
    /// Provider or a clone, does not print a real `{children}` slot (S1: children that reach its element through
    /// `...rest` are F324's), the content reads the frame of a native Provider around the call site (A1 / C2: no frame
    /// crosses the clone's boundary), Carry cannot express a name, or the clone still needs React.
    fn specialise_host(
        &mut self,
        cir: &Rc<ComponentIR>,
        c_path: &str,
        loc: u32,
        content: &[Node],
        props: &[(String, Expr)],
    ) -> Result<Specialised, String> {
        if !cir.provides.is_empty() || cir.specialised {
            return Err("it provides a context, or is a clone already".into());
        }
        if self.shared_locs.contains(&loc) {
            return Err("another call site in this component has the same source offset (content written in another module), so the clone could not be told apart".into());
        }
        if !matches!(cir.tier, Tier::Native | Tier::Static) {
            return Err("it is not lowered".into());
        }
        if !prints_children_slot(cir) {
            return Err("it does not print a `{children}` slot of its own".into());
        }
        // F369b: a polymorphic parent given its flag: the call's one child takes the polymorphic element's place.
        let poly_child = match &cir.poly {
            Some(p) if flag_selects_slot(p, props) => match content {
                [only @ (Node::Element { poly: false, .. } | Node::Component { .. })] => {
                    Some(only.clone())
                }
                _ => {
                    return Err(
                        "the flag selects the child, which is not exactly one host element".into(),
                    );
                }
            },
            _ => None,
        };
        // S4: a bare text slot of the content is printed in a `<span x-text>` unless it is an element's only child; React
        // prints a text node, so that clone would not render what React renders.
        if content.iter().any(|c| matches!(c, Node::Slot(_)))
            && !(content.len() == 1 && children_slot_is_lone(&cir.template))
        {
            return Err(format!(
                "{SLOT_TEXT_WRAPPER}: a bare text slot of the content would need a wrapper element React does not print"
            ));
        }
        let ctx = self.ctx;
        let export = match &cir.export {
            Some(n) => Export::Named(n.clone()),
            None => Export::Default,
        };
        let mut nodes = content.to_vec();
        // No native frame is opened by the clone for its content (`usize::MAX` owns none): a consumer of a native
        // Provider around the call site would read the clone's members by name (A1, and scoped frames, C2).
        self.check_owner(&nodes, usize::MAX)?;
        let mut carry = Carry::new(
            &self.native_props,
            usize::MAX,
            &self.module_names,
            &self.row_handlers,
            &self.st.handler_names,
            &self.module_consts,
            cir.props.iter().map(|p| p.name.clone()).collect(),
        );
        carry.nodes(&mut nodes, &[])?;
        rebase_sources(&mut nodes, ctx.path, c_path, ctx.opts, ctx.modules)?;
        let exp = cir.export.as_deref().unwrap_or("default");
        let site = match &self.spec_salt {
            Some(salt) => format!("{}#{salt}", ctx.path),
            None => ctx.path.to_string(),
        };
        let id = format!("{}_h{:08x}", cir.id, spec_hash(&site, loc));
        let key = format!(
            "{c_path}#{exp}~{}~{site}~{loc}",
            if poly_child.is_some() {
                "polyhost"
            } else {
                "host"
            }
        );
        let clone_id = id.clone();
        let (inputs, clone_handlers) = carry.finish();
        let fixed = self.pinned(cir, props, &inputs);
        let is_poly = poly_child.is_some();
        let mut once = Some(nodes);
        let clone = crate::analyze::modules::compile_specialised(
            c_path,
            &export,
            key.clone(),
            ctx.opts,
            ctx.modules,
            &mut |ir: &mut ComponentIR, _: &crate::parse::Parsed| {
                let content = once.take().unwrap_or_default();
                if is_poly {
                    splice_poly(ir, content.into_iter().next().ok_or("no child")?)?;
                } else {
                    splice_children(ir, content)?;
                }
                for (hidden, _) in &inputs {
                    ir.props.push(crate::ir::PropDecl {
                        name: hidden.clone(),
                        local: hidden.clone(),
                        ts_type: None,
                        default: None,
                    });
                }
                ir.handlers.extend(clone_handlers.iter().cloned());
                ir.fixed_props = fixed.clone();
                ir.id = clone_id.clone();
                ir.specialised = true;
                Ok(())
            },
        )?;
        if let Tier::React { reason, .. } = &clone.tier {
            let reason = reason.clone();
            ctx.modules.borrow_mut().remove(&key);
            return Err(format!("the specialised component needs React ({reason})"));
        }
        Ok((id, key, inputs))
    }

    /// F342: a spread at this call site of this component's whole props, or of its `...rest` while it does not name
    /// `children`: the call site's children given to this component travel in it.
    fn spreads_own_children(&self, props: &[(String, Expr)]) -> bool {
        props.iter().any(|(k, v)| {
            k == crate::ir::SPREAD_KEY
                && matches!(v, Expr::Raw(r) | Expr::Server(ServerExpr(r)) if matches!(&r.kind,
                    RawKind::Ident { name, kind: IdentKind::Prop }
                        if name == "*" || (name == crate::ir::REST_PROPS && !self.own_named.contains("children"))))
        })
    }

    /// F345: what a clone's one call site does not change on the client, pinned in its `fixed_props` (a clone reads every
    /// other prop as a signal, `ComponentIR::props_are_signal`): each hidden input and each declared prop whose value at
    /// the call site reads no state and no prop that changes here (F320's rule, `live`), and each declared prop the call
    /// site does not pass (it stays at its default, or comes in a spread of this component's own rest), unless a spread of
    /// unknown keys there may carry it. A pinned value that reads a prop of THIS component (a stateless wrapper passing
    /// its own prop on, F323) freezes that prop here (F319): a caller passing a changing value falls back
    /// (`frozen-prop`). F319's own freeze at an unlinked call site already does so; this one also holds where the clone
    /// is linked for another reason.
    fn pinned(
        &mut self,
        cir: &ComponentIR,
        props: &[(String, Expr)],
        inputs: &[(String, Expr)],
    ) -> Vec<String> {
        // A spread of this component's own rest or props carries only what its caller gave, which F319 freezes per call
        // site (`*`, never live by F320's rule): the props it may carry are pinned too, and `*` frozen here. Any other
        // spread (keys known only at render) may carry a changing value: what it may carry is not pinned.
        let mut spread = false;
        let mut frozen = Vec::new();
        for (k, v) in props {
            if k != crate::ir::SPREAD_KEY {
                continue;
            }
            let own = matches!(v, Expr::Raw(r) | Expr::Server(ServerExpr(r)) if matches!(&r.kind,
                RawKind::Ident { name, kind: IdentKind::Prop } if name == "*" || name == crate::ir::REST_PROPS));
            if own && !self.live(v) {
                frozen.extend(self.changing_prop_roots(&self.deps_of(v)));
            } else {
                spread = true;
            }
        }
        let mut given: Vec<(&str, &Expr)> = inputs.iter().map(|(h, v)| (h.as_str(), v)).collect();
        let mut fixed = Vec::new();
        for p in &cir.props {
            // A context value (`__ctx_*`) is a Provider frame's member, filled by the frames pass where its consumer is
            // written (not always at this call site): its liveness belongs to that frame, so it is never pinned.
            // Pinned, a trigger's clone printed a state Provider's `checked` once (switch-provider-chain PR1).
            if p.name.starts_with("__ctx_") {
                continue;
            }
            match props.iter().rev().find(|(k, _)| *k == p.name) {
                Some((_, v)) => given.push((&p.name, v)),
                None if !spread && p.name != "children" => fixed.push(p.name.clone()),
                None => {}
            }
        }
        for (name, v) in given {
            // F344: a row value changes per instance: pinned, a row the client adds would print the first row's value
            // (F358's class). Not pinned, the clone follows it. (Clones are made in the frames pass, which does not know
            // whether a list re-creates its rows: every row value counts.)
            let row = !self.deps_of(v).loop_bindings.is_empty();
            if matches!(v, Expr::ClientOnly { .. }) || (!self.live(v) && !row) {
                frozen.extend(self.changing_prop_roots(&self.deps_of(v)));
                fixed.push(name.to_string());
            }
        }
        self.frozen.extend(frozen);
        fixed
    }

    /// A consumer in `content` of a context that a Provider INSIDE `cir`'s template provides (below `cir` itself) reads,
    /// in React, that inner Provider wherever the content lands under it; the value the call site hands it (Carry: the
    /// frame open where the content is written, or the context default) would override it in the clone. Refused by
    /// name (found with F238: `<Prov>` calling a native `<Frame>` around its `{children}`, the content reading Frame's
    /// context, printed the default).
    fn check_inner_providers(&self, cir: &ComponentIR, content: &[Node]) -> Result<(), String> {
        let modules = self.ctx.modules.borrow();
        let by_id: HashMap<String, Rc<ComponentIR>> = modules
            .done()
            .into_iter()
            .map(|(_, ir)| (ir.id.clone(), ir))
            .collect();
        let mut below = BTreeSet::new();
        let mut stack: Vec<Rc<ComponentIR>> = cir
            .children
            .iter()
            .filter_map(|c| c.id.as_ref().and_then(|id| by_id.get(id)).cloned())
            .collect();
        let mut seen = BTreeSet::new();
        while let Some(ir) = stack.pop() {
            if !seen.insert(ir.id.clone()) {
                continue;
            }
            below.extend(ir.provides.iter().map(|p| p.context.clone()));
            stack.extend(
                ir.children
                    .iter()
                    .filter_map(|c| c.id.as_ref().and_then(|id| by_id.get(id)).cloned()),
            );
        }
        if below.is_empty() {
            return Ok(());
        }
        fn walk(n: &Node, below: &BTreeSet<String>) -> Option<String> {
            match n {
                Node::Component {
                    name,
                    props,
                    children,
                    ..
                } => props
                    .iter()
                    .find_map(|(k, _)| {
                        let rest = k.strip_prefix("__ctx_")?;
                        below
                            .iter()
                            .any(|c| rest.starts_with(&format!("{c}_")))
                            .then(|| name.clone())
                    })
                    .or_else(|| children.iter().find_map(|c| walk(c, below))),
                Node::Element { children, .. } | Node::Fragment(children) => {
                    children.iter().find_map(|c| walk(c, below))
                }
                Node::If { then, else_, .. } => {
                    then.iter().chain(else_).find_map(|c| walk(c, below))
                }
                Node::For { body, .. } => body.iter().find_map(|c| walk(c, below)),
                Node::Text(_) | Node::Slot(_) | Node::Outlet => None,
            }
        }
        match content.iter().find_map(|n| walk(n, &below)) {
            Some(who) => Err(format!(
                "<{who}> in the content reads a context that a Provider inside `{}` provides around it",
                cir.export.as_deref().unwrap_or("default")
            )),
            None => Ok(()),
        }
    }

    /// A1: a consumer in `content` that reads the frame of ANOTHER native Provider (an outer one) would, once spliced,
    /// read the clone's own members by name. Refused.
    fn check_owner(&self, content: &[Node], owner: usize) -> Result<(), String> {
        fn walk(n: &Node, owner: usize, native: &[(u32, String, usize)]) -> Result<(), String> {
            match n {
                Node::Component {
                    loc,
                    props,
                    children,
                    ..
                } => {
                    for (k, _) in props {
                        if native
                            .iter()
                            .any(|(l, kk, o)| l == loc && kk == k && *o != owner)
                        {
                            return Err(format!(
                                "a consumer reads the frame of an outer Provider from inside another Provider's content (`{k}`)"
                            ));
                        }
                    }
                    children.iter().try_for_each(|c| walk(c, owner, native))
                }
                Node::Element { children, .. } | Node::Fragment(children) => {
                    children.iter().try_for_each(|c| walk(c, owner, native))
                }
                Node::If { then, else_, .. } => then
                    .iter()
                    .chain(else_)
                    .try_for_each(|c| walk(c, owner, native)),
                Node::For { body, .. } => body.iter().try_for_each(|c| walk(c, owner, native)),
                Node::Text(_) | Node::Slot(_) | Node::Outlet => Ok(()),
            }
        }
        content
            .iter()
            .try_for_each(|c| walk(c, owner, &self.native_props))
    }

    /// `raw`, an expression of the Provider component `cir`'s body, as an expression of the scope that renders it
    /// (`props` are the call site's): its props become the call site's values (a default when absent), its derived
    /// locals are expanded, the rest is copied. `Err(why)` for anything this cannot express.
    fn subst(
        &self,
        raw: &RawExpr,
        cir: &Rc<ComponentIR>,
        props: &[(String, Expr)],
        depth: u8,
    ) -> Result<RawExpr, String> {
        if depth > 8 {
            return Err("a chain of derived values deeper than 8".into());
        }
        let go = |r: &RawExpr| self.subst(r, cir, props, depth);
        let b = |r: &RawExpr| -> Result<Box<RawExpr>, String> { Ok(Box::new(go(r)?)) };
        let kind = match &raw.kind {
            RawKind::Lit(_) => raw.kind.clone(),
            RawKind::Ident { name, kind } => match kind {
                IdentKind::Prop if name != "*" => {
                    // Spreads at the call site: the caller's own props object or its `...rest` carries every prop it
                    // does not name (R34.14: `rest.k` is prop `k`); any other spread is not read here.
                    let mut carried = false;
                    for (k, e) in props {
                        if k != crate::ir::SPREAD_KEY {
                            continue;
                        }
                        match e {
                            Expr::Raw(RawExpr {
                                kind:
                                    RawKind::Ident {
                                        name: src,
                                        kind: IdentKind::Prop,
                                    },
                                ..
                            }) if src == "*" || src == crate::ir::REST_PROPS => {
                                carried |= !self.own_named.iter().any(|n| n == name);
                            }
                            _ => {
                                return Err(format!(
                                    "the prop `{name}` may come from a spread of unknown keys"
                                ));
                            }
                        }
                    }
                    let explicit = props.iter().rev().find(|(k, _)| k == name).map(|(_, e)| e);
                    let default = match cir
                        .props
                        .iter()
                        .find(|p| &p.name == name)
                        .and_then(|p| p.default.as_ref())
                    {
                        Some(d) => self.subst(d, cir, props, depth + 1)?,
                        None => RawExpr {
                            loc: raw.loc,
                            kind: RawKind::Lit(crate::ir::Literal::Undefined),
                        },
                    };
                    if carried {
                        if explicit.is_some() {
                            return Err(format!(
                                "the prop `{name}` is given and a spread after it may carry it too"
                            ));
                        }
                        // The caller's own prop `name`; the Provider's default applies when it is undefined.
                        let read = RawExpr {
                            loc: raw.loc,
                            kind: RawKind::Ident {
                                name: name.clone(),
                                kind: IdentKind::Prop,
                            },
                        };
                        let undefined = RawExpr {
                            loc: raw.loc,
                            kind: RawKind::Lit(crate::ir::Literal::Undefined),
                        };
                        if matches!(default.kind, RawKind::Lit(crate::ir::Literal::Undefined)) {
                            return Ok(read);
                        }
                        return Ok(RawExpr {
                            loc: raw.loc,
                            kind: RawKind::Cond {
                                test: Box::new(RawExpr {
                                    loc: raw.loc,
                                    kind: RawKind::Binary {
                                        op: crate::ir::BinOp::StrictEq,
                                        left: Box::new(read.clone()),
                                        right: Box::new(undefined),
                                    },
                                }),
                                yes: Box::new(default),
                                no: Box::new(read),
                            },
                        });
                    }
                    match explicit {
                        Some(Expr::Raw(r)) => return Ok(r.clone()),
                        Some(_) => {
                            return Err(format!("the prop `{name}` is not a plain expression"));
                        }
                        None => return Ok(default),
                    }
                }
                IdentKind::Local => {
                    let derived = cir
                        .structural
                        .as_ref()
                        .map(|s| s.derived.as_slice())
                        .unwrap_or(&[])
                        .iter()
                        .find(|d| &d.name == name);
                    if let Some(Expr::Raw(r)) = derived.map(|d| &d.expr) {
                        return self.subst(r, cir, props, depth + 1);
                    }
                    // A module-level `const` of a primitive literal is that literal.
                    if let Some(c) = cir
                        .module_decls
                        .iter()
                        .flat_map(|d| &d.consts)
                        .find(|c| &c.name == name && !c.mutated)
                        && matches!(c.value.kind, RawKind::Lit(_))
                    {
                        return Ok(RawExpr {
                            loc: raw.loc,
                            kind: c.value.kind.clone(),
                        });
                    }
                    if !cir.module_scope.iter().any(|(n, _)| n == name) {
                        return Err(format!(
                            "`{name}` is not a name the Provider's module declares"
                        ));
                    }
                    if cir.source == self.ctx.path {
                        // The same module: its declarations are this component's own.
                        return Ok(raw.clone());
                    }
                    // Another module (a package's source): the helper runs in this component's jobs through a copy of the
                    // module's declarations, kept apart in a function scope (no export, no rename).
                    let mut imports = BTreeSet::new();
                    let names: BTreeSet<String> = [name.clone()].into();
                    crate::lower::common::module_code(cir, &names, &mut imports);
                    if let Some((_, s, _)) = imports.iter().find(|(_, s, _)| s.starts_with('.')) {
                        return Err(format!(
                            "the Provider's module reads a relative import ({s})"
                        ));
                    }
                    let alias = format!("__ctxm_{}", cir.id);
                    self.foreign
                        .borrow_mut()
                        .entry(alias.clone())
                        .or_insert_with(|| (cir.clone(), BTreeSet::new()))
                        .1
                        .insert(name.clone());
                    return Ok(RawExpr {
                        loc: raw.loc,
                        kind: RawKind::Member {
                            target: Box::new(RawExpr {
                                loc: raw.loc,
                                kind: RawKind::Ident {
                                    name: alias,
                                    kind: IdentKind::Local,
                                },
                            }),
                            name: name.clone(),
                            optional: false,
                        },
                    });
                }
                IdentKind::Global | IdentKind::Import { .. } => raw.kind.clone(),
                _ => return Err(format!("`{name}` is state, a handler or a loop value")),
            },
            RawKind::Member {
                target,
                name,
                optional,
            } => RawKind::Member {
                target: b(target)?,
                name: name.clone(),
                optional: *optional,
            },
            RawKind::Index { target, index } => RawKind::Index {
                target: b(target)?,
                index: b(index)?,
            },
            RawKind::Call { callee, args } => RawKind::Call {
                callee: b(callee)?,
                args: args.iter().map(go).collect::<Result<_, _>>()?,
            },
            RawKind::Binary { op, left, right } => RawKind::Binary {
                op: *op,
                left: b(left)?,
                right: b(right)?,
            },
            RawKind::Unary { op, value } => RawKind::Unary {
                op: *op,
                value: b(value)?,
            },
            RawKind::Cond { test, yes, no } => RawKind::Cond {
                test: b(test)?,
                yes: b(yes)?,
                no: b(no)?,
            },
            RawKind::Template { head, parts } => RawKind::Template {
                head: head.clone(),
                parts: parts
                    .iter()
                    .map(|(p, t)| Ok((go(p)?, t.clone())))
                    .collect::<Result<_, String>>()?,
            },
            RawKind::Array(xs) => RawKind::Array(xs.iter().map(go).collect::<Result<_, _>>()?),
            RawKind::Object(ps) => RawKind::Object(
                ps.iter()
                    .map(|(k, v)| Ok((k.clone(), go(v)?)))
                    .collect::<Result<_, String>>()?,
            ),
            RawKind::Arrow { .. } | RawKind::Jsx(_) | RawKind::Opaque { .. } => {
                return Err("an expression outside the subset".into());
            }
        };
        Ok(RawExpr { loc: raw.loc, kind })
    }

    /// F277: `v` has the same value whenever this component mounts: it reads literals, module names, fixed cells, the
    /// props of a route component (fixed for the page), and state cells whose initial value is itself such a value
    /// (a cell is its initial value at mount). A prop of any other component, a store, a list item, a browser global or
    /// opaque code may differ at a later mount (an `x-if` of the caller re-creates this component).
    fn same_at_every_mount(&self, v: &Expr) -> bool {
        let mut seen = BTreeSet::new();
        self.mount_value(&self.deps_of(v), &mut seen)
    }

    fn mount_value(&self, d: &Deps, seen: &mut BTreeSet<String>) -> bool {
        (d.props.is_empty() || self.ctx.is_root)
            && d.stores.is_empty()
            && d.loop_bindings.is_empty()
            && !d.browser
            && !d.opaque
            && d.state.iter().all(|s| {
                if !seen.insert(s.clone()) {
                    return false;
                }
                self.state_inits
                    .get(s)
                    .is_some_and(|init| self.mount_value(&self.st.cx.deps_expr(init, &[]), seen))
            })
    }

    fn deps_of(&self, e: &Expr) -> Deps {
        match e {
            Expr::Precomputed { slot, per_item, .. } => {
                let mut d = self
                    .st
                    .slots
                    .get(slot)
                    .map(|i| i.deps.clone())
                    .unwrap_or_default();
                if let Some(item) = per_item {
                    d.loop_bindings.insert(item.clone());
                }
                d
            }
            other => self.st.cx.deps_expr(other, &self.loop_scope),
        }
    }

    fn paths_of(&self, e: &Expr) -> Vec<String> {
        match e {
            Expr::Precomputed { inputs, .. } => inputs.clone(),
            other => self.st.cx.deps_expr(other, &self.loop_scope).prop_paths(),
        }
    }

    /// A component that lives in a package, rendered as a React island (L22); a member path
    /// (`Dialog` + `["Root"]`, R34.35) selects a value off the export.
    fn external_child(
        &mut self,
        name: &str,
        source: &str,
        export: &str,
        member: &[String],
        loc: u32,
    ) -> Child {
        self.external_child_why(name, source, export, member, loc, None)
    }

    /// [`Self::external_child`]; `why`: why the package's source was not compiled instead (F153c).
    fn external_child_why(
        &mut self,
        name: &str,
        source: &str,
        export: &str,
        member: &[String],
        loc: u32,
        why: Option<String>,
    ) -> Child {
        let ctx = self.ctx;
        let at = if member.is_empty() {
            String::new()
        } else {
            format!(
                " ({}{})",
                if export == "*" {
                    String::new()
                } else {
                    format!("{export}.")
                },
                member.join(".")
            )
        };
        self.diagnostics.push(Diagnostic::fallback(
            "external-component",
            match &why {
                None => format!("<{name}> comes from the package {source}{at}; it renders as a React island"),
                Some(w) => format!(
                    "<{name}> comes from the package {source}{at}; it renders as a React island (package source: {w})"
                ),
            },
            loc,
            "use a component from this project to keep it native",
        ));
        // The island is the package export itself: a synthetic React-tier component the
        // build resolves as `{package, export}` (L22).
        let id = external_component_id(source, export, member);
        // Not a path: the key and `source` only need to be unique and safe as a file stem.
        let key: String = format!(
            "package {source} {export}{}",
            member.iter().map(|m| format!(" {m}")).collect::<String>()
        )
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
        let known = ctx.modules.borrow().get(&key).is_some();
        if !known {
            let mut synthetic = ComponentIR::new(id.clone(), key.clone());
            synthetic.external = Some(ExternalRef {
                source: source.to_string(),
                export: export.to_string(),
                member: member.to_vec(),
            });
            synthetic.tier = react("external component");
            super::tier::react_jobs(&mut synthetic);
            ctx.modules
                .borrow_mut()
                .insert(key, Entry::Done(Rc::new(synthetic)));
        }
        Child {
            id: Some(id),
            path: None,
            tier: react("external component"),
            fed: false,
            stores: false,
            prop_precompute: false,
            recomputes: false,
            spread: SpreadSink::None,
            poly: None,
            poly_runtime_spread: false,
            onward: HandlerSink::default(),
            job_roots: BTreeSet::new(),
            job_all: false,
            forwards_ref: false,
            ref_site: false,
            icon_spread: false,
            reads_children_value: false,
            rest_as_data: false,
            use_id: false,
            has_for: false,
            hosts_children: false,
            inner: None,
            absent: Vec::new(),
            ir: None,
            job_eval: None,
            job_outputs: Vec::new(),
            job_fused: Vec::new(),
            unwritten: Vec::new(),
            shadowed: Vec::new(),
            shadowed_input: Vec::new(),
        }
    }

    fn resolve_child(
        &mut self,
        name: &str,
        source: Option<&str>,
        imported: Option<&str>,
        member: &[String],
        loc: u32,
    ) -> Child {
        let ctx = self.ctx;
        // R34.122: a call site the pass already specialised names its clone in the module cache.
        if source == Some(SPEC_SOURCE)
            && let Some(key) = imported
            && let Some(Entry::Done(ir)) = ctx.modules.borrow().get(key).cloned()
        {
            let path = ir.source.clone();
            let id = ir.id.clone();
            return self.finish(name, Some(id), Some(path), Lookup::Compiled(ir), loc);
        }
        // F402: a `Primitive.<tag>` the rebase moved into a clone of another package scope.
        if source == Some(PRIMITIVE_SOURCE)
            && let (Some(decl), [tag]) = (imported, member)
        {
            return self.primitive_child(name, decl, tag, loc);
        }
        let Some(source) = source else {
            return self.local_child(name, loc);
        };
        let Some(path) = resolve(ctx.path, source, ctx.opts) else {
            if crate::analyze::modules::is_relative_spec(source) {
                self.diagnostics.push(Diagnostic::error(
                    "unresolved-import",
                    if crate::analyze::modules::import_leaves_root(ctx.path, source, ctx.opts) {
                        format!("cannot resolve component <{name}> from {source}: it leaves the app root")
                    } else {
                        format!("cannot resolve component <{name}> from {source}")
                    },
                    loc,
                    "import a .tsx/.ts module or a directory with index.tsx",
                ));
                return Child {
                    id: None,
                    path: None,
                    tier: react("unresolved import"),
                    fed: false,
                    stores: false,
                    prop_precompute: false,
                    recomputes: false,
                    spread: SpreadSink::None,
                    poly: None,
                    poly_runtime_spread: false,
                    onward: HandlerSink::default(),
                    job_roots: BTreeSet::new(),
                    job_all: false,
                    forwards_ref: false,
                    ref_site: false,
                    icon_spread: false,
                    reads_children_value: false,
                    rest_as_data: false,
                    use_id: false,
                    has_for: false,
                    hosts_children: false,
                    inner: None,
                    absent: Vec::new(),
                    ir: None,
                    job_eval: None,
                    job_outputs: Vec::new(),
                    job_fused: Vec::new(),
                    unwritten: Vec::new(),
                    shadowed: Vec::new(),
                    shadowed_input: Vec::new(),
                };
            }
            // A package export (a member of one included): its source when the build wrote it (F153c), else
            // the island is the export itself.
            return self.package_child(
                name,
                ctx.path,
                source,
                imported.unwrap_or("default"),
                member,
                loc,
            );
        };
        let export = match imported {
            None | Some("default") => Export::Default,
            Some(n) => Export::Named(n.to_string()),
        };
        // The component is the one the export is declared by, however many barrels it crosses (R34.11).
        let (path, export) = declared_in(&path, &export, ctx.opts);
        // `export { Root }` after `const Root = DialogPrimitive.Root`: the component is the package member.
        if let Some(m) = package_member(&path, &export, ctx.opts) {
            return self.package_child(name, &path, &m.source, &m.imported, &m.member, loc);
        }
        let id = match &export {
            Export::Default => component_id(&path),
            Export::Named(n) => named_component_id(&path, n),
        };
        let lookup = compile(&path, &export, None, ctx.opts, ctx.modules);
        self.finish(name, Some(id), Some(path), lookup, loc)
    }

    /// A component a bare import of the module at `from` names (F153c, R34.61): compiled from the package source
    /// the build wrote, like app code. Fails closed to the React island of the export (today's L22 rule) when the
    /// build refused the package, the export cannot be followed, or anything in the compiled subtree needs React:
    /// an island is always the published package export, never its source (G1, R34.62).
    fn package_child(
        &mut self,
        name: &str,
        from: &str,
        source: &str,
        imported: &str,
        member: &[String],
        loc: u32,
    ) -> Child {
        let ctx = self.ctx;
        // Inside a package source, an import the build did not write is not followed either: the subtree is then
        // React, and the app-level import falls back as a whole.
        let entry = match resolve_package(from, source, ctx.opts) {
            Ok(entry) => entry,
            Err(why) => return self.external_child_why(name, source, imported, member, loc, why),
        };
        // R34.65: `Primitive.<tag>` of the Radix factory is the host element.
        if let [tag] = member
            && imported != "*"
        {
            let there = if imported == "default" {
                Export::Default
            } else {
                Export::Named(imported.to_string())
            };
            if let (decl, Export::Named(n)) = declared_in(&entry, &there, ctx.opts)
                && let Some(nodes) = crate::analyze::primitive::primitive_nodes(&decl, &n, ctx.opts)
                && nodes.iter().any(|t| t == tag)
            {
                return self.primitive_child(name, &decl, tag, loc);
            }
        }
        let Some((path, export)) = declared_member(&entry, imported, member, ctx.opts) else {
            return self.external_child_why(
                name,
                source,
                imported,
                member,
                loc,
                Some("the export is not declared in a form the compiler follows".into()),
            );
        };
        let id = match &export {
            Export::Default => component_id(&path),
            Export::Named(n) => named_component_id(&path, n),
        };
        let lookup = compile(&path, &export, None, ctx.opts, ctx.modules);
        // A state-frame Provider is not an island of package source when written in app code: a call site specialises
        // it, and one that cannot keeps the published export's island (F188). From inside a package source there is
        // no published spelling to fall back to.
        let needs_react =
            package_needs_react(&lookup, &ctx.modules.borrow(), !is_package_source(from));
        if let Some(why) = needs_react {
            // Only the outermost package import is the island: a nested one says nothing new.
            if is_package_source(from) {
                return self.external_child(name, source, imported, member, loc);
            }
            return self.external_child_why(name, source, imported, member, loc, Some(why));
        }
        // F188 (R34.62): written in app code, the component also has a published spelling: wherever the build needs
        // React code for it (a revive hook inside an island's children) it imports that, never the map source.
        if !is_package_source(from) {
            ctx.modules.borrow_mut().set_dist(
                &cache_key(&crate::analyze::modules::normalize(&path), &export),
                ExternalRef {
                    source: source.to_string(),
                    export: imported.to_string(),
                    member: member.to_vec(),
                },
            );
        }
        self.finish(name, Some(id), Some(path), lookup, loc)
    }

    /// `Primitive.<tag>` of a recognised Radix factory declared in the module at `decl` (R34.65): the component the
    /// factory makes for `tag`, as the source it is equivalent to (asChild aside, which the call site resolves like
    /// `Button`'s; the write-only `window` marker dropped). Compiled once per tag, beside the factory's module.
    fn primitive_child(&mut self, name: &str, decl: &str, tag: &str, loc: u32) -> Child {
        let ctx = self.ctx;
        let dir = decl.rsplit_once('/').map_or("", |(d, _)| d);
        let path = format!("{dir}/primitive.{tag}.tsx");
        let export = Export::Named(PRIMITIVE_EXPORT.to_string());
        let source = format!(
            "import * as React from 'react'\n\
             import {{ Slot }} from '@radix-ui/react-slot'\n\
             const {PRIMITIVE_EXPORT} = React.forwardRef(function {PRIMITIVE_EXPORT}({{ asChild, ...primitiveProps }}: any, forwardedRef: any) {{\n  \
             const Comp = asChild ? Slot : '{tag}'\n  \
             return <Comp {{...primitiveProps}} ref={{forwardedRef}} />\n\
             }})\n\
             export {{ {PRIMITIVE_EXPORT} }}\n"
        );
        let id = named_component_id(&path, PRIMITIVE_EXPORT);
        let lookup = compile(
            &path,
            &export,
            Some(source.into_bytes()),
            ctx.opts,
            ctx.modules,
        );
        self.finish(name, Some(id), Some(path), lookup, loc)
    }

    /// A component declared in this module.
    fn local_child(&mut self, name: &str, loc: u32) -> Child {
        let ctx = self.ctx;
        let key = cache_key(ctx.path, &Export::Named(name.into()));
        let id = named_component_id(ctx.path, name);
        let cached = ctx.modules.borrow().get(&key).cloned();
        let lookup = match cached {
            Some(Entry::InProgress) => Lookup::Cycle,
            Some(Entry::Done(ir)) => Lookup::Compiled(ir),
            Some(Entry::Failed(d)) => Lookup::Failed(d),
            None => {
                let Some(mut child) = (ctx.local)(name) else {
                    self.diagnostics.push(Diagnostic::fallback(
                        "local-component",
                        format!("<{name}> is not a function declaration in this module"),
                        loc,
                        "declare it as `function Name(props) { … }`",
                    ));
                    return Child {
                        id: None,
                        path: Some(ctx.path.into()),
                        tier: react("local component"),
                        fed: false,
                        stores: false,
                        prop_precompute: false,
                        recomputes: false,
                        spread: SpreadSink::None,
                        poly: None,
                        poly_runtime_spread: false,
                        onward: HandlerSink::default(),
                        job_roots: BTreeSet::new(),
                        job_all: false,
                        forwards_ref: false,
                        ref_site: false,
                        icon_spread: false,
                        reads_children_value: false,
                        rest_as_data: false,
                        use_id: false,
                        has_for: false,
                        hosts_children: false,
                        inner: None,
                        absent: Vec::new(),
                        ir: None,
                        job_eval: None,
                        job_outputs: Vec::new(),
                        job_fused: Vec::new(),
                        unwritten: Vec::new(),
                        shadowed: Vec::new(),
                        shadowed_input: Vec::new(),
                    };
                };
                ctx.modules
                    .borrow_mut()
                    .insert(key.clone(), Entry::InProgress);
                let child_ctx = PassCtx {
                    text: ctx.text,
                    opts: ctx.opts,
                    path: ctx.path,
                    modules: ctx.modules,
                    local: ctx.local,
                    is_root: false,
                    specialised: false,
                };
                run_passes(&mut child, &child_ctx);
                finish_diagnostics(&mut child, ctx.text);
                let child = Rc::new(child);
                ctx.modules
                    .borrow_mut()
                    .insert(key, Entry::Done(child.clone()));
                Lookup::Compiled(child)
            }
        };
        self.finish(name, Some(id), Some(ctx.path.into()), lookup, loc)
    }

    fn finish(
        &mut self,
        name: &str,
        id: Option<String>,
        path: Option<String>,
        lookup: Lookup,
        loc: u32,
    ) -> Child {
        let mut fed = false;
        let mut stores = false;
        let mut prop_precompute = false;
        let mut recomputes = false;
        let mut spread = SpreadSink::None;
        let mut poly = None;
        let mut poly_runtime_spread = false;
        let mut onward = HandlerSink::default();
        let mut job_roots = BTreeSet::new();
        let mut job_all = false;
        let mut use_id = false;
        let mut has_for = false;
        let mut hosts_children = false;
        let mut inner = None;
        let mut forwards_ref = false;
        let mut ref_site = false;
        let mut icon_spread = false;
        let mut reads_children_value = false;
        let mut rest_as_data = false;
        let mut absent = Vec::new();
        let mut child_ir = None;
        let mut job_eval = None;
        let mut job_outputs = Vec::new();
        let mut job_fused = Vec::new();
        let mut unwritten = Vec::new();
        let mut shadowed = Vec::new();
        let mut shadowed_input = Vec::new();
        let tier = match lookup {
            Lookup::Compiled(ir) => {
                child_ir = Some(ir.clone());
                forwards_ref = ir.forwards_ref;
                ref_site = ir.forwards_ref && forward_ref_sites(&ir.template, true) == Some(1);
                icon_spread = ir.icon_spread;
                absent = ir.absent_props.clone();
                has_for = ir.repeats_children || template_has_for(&ir.template);
                hosts_children = ir.hosts_children
                    || (matches!(ir.tier, Tier::Native) && template_reads_children(&ir.template));
                reads_children_value =
                    matches!(ir.tier, Tier::Static | Tier::Native) && reads_children_as_value(&ir);
                rest_as_data = matches!(ir.tier, Tier::Static | Tier::Native)
                    && template_passes_rest_as_data(&ir.template);
                unwritten = ir.unwritten_props.clone();
                shadowed = ir.shadowed_props.clone();
                shadowed_input = ir.shadowed_input.clone();
                inner = Inner::of(&ir);
                job_all = ir.jobs.iter().any(|j| j.inputs.iter().any(|i| i == "*"));
                job_roots = ir
                    .jobs
                    .iter()
                    .flat_map(|j| &j.inputs)
                    .filter(|i| i.as_str() != "*")
                    .map(|i| {
                        let i = i.strip_prefix("props.").unwrap_or(i);
                        i.split(['.', '[']).next().unwrap_or(i).to_string()
                    })
                    .collect();
                spread = SpreadSink::of(&ir);
                poly = ir.poly.clone();
                poly_runtime_spread = poly.is_some() && poly_has_runtime_spread(&ir.template);
                if matches!(ir.tier, Tier::Static) {
                    onward = HandlerSink::of(&ir);
                }
                if matches!(&ir.tier, Tier::React { reason, .. } if reason == crate::analyze::modules::OPAQUE_EXPORT)
                {
                    self.diagnostics.push(Diagnostic::fallback(
                        "child-component",
                        format!(
                            "<{name}> renders as a React island: {} is not a function declaration",
                            ir.source
                        ),
                        loc,
                        "declare the child as `export function Name(props) { … }`",
                    ));
                }
                // An island's ssr job reads `__store` whether or not the wrapper reads a store (L4).
                stores = ir.stores.iter().any(|s| s.resolved.is_some())
                    || ir
                        .jobs
                        .iter()
                        .any(|j| j.inputs.iter().any(|i| i == "__store"));
                fed = crate::ir::is_fed(&ir);
                if fed && let Some(p) = &path {
                    job_eval = Some(super::build_eval::instance_job(&ir, p, self.ctx.opts));
                    job_outputs = ir.jobs.iter().flat_map(|j| j.outputs.clone()).collect();
                    job_fused = ir
                        .fused
                        .iter()
                        .map(|f| crate::ir::FusedEvalJob {
                            child_id: f.child_id.clone(),
                            stubs: f.stubs.clone(),
                        })
                        .collect();
                }
                use_id = ir.use_id_slots > 0;
                // An island's ssr render over the wrapper's props is computed once too (L4).
                prop_precompute = ir.jobs.iter().any(|j| {
                    crate::ir::feeds_instances(j) && j.inputs.iter().any(|i| i != "__store")
                });
                recomputes = ir.props_slots_recomputable
                    && ir.props_are_signal()
                    && ir.use_id_slots == 0
                    && ir
                        .jobs
                        .iter()
                        .filter(|j| crate::ir::feeds_instances(j))
                        .all(|j| matches!(j.kind, crate::ir::JobKind::Precompute));
                ir.tier.clone()
            }
            Lookup::Cycle => {
                self.diagnostics.push(Diagnostic::fallback(
                    "import-cycle",
                    format!("<{name}> is part of an import cycle with this component"),
                    loc,
                    "break the cycle; the child renders as a React island",
                ));
                react("import cycle")
            }
            Lookup::Failed(d) if d.class == crate::ir::DiagClass::Fallback => {
                self.diagnostics.push(Diagnostic::fallback(
                    "child-component",
                    format!("<{name}> renders as a React island: {}", d.message),
                    loc,
                    "declare the child as `export function Name(props) { … }`",
                ));
                react("child is not a function declaration")
            }
            Lookup::Failed(d) => {
                self.diagnostics.push(Diagnostic::error(
                    "child-component",
                    format!("<{name}> could not be compiled: {}", d.message),
                    loc,
                    "fix the child component",
                ));
                react("child failed to compile")
            }
        };
        Child {
            id,
            path,
            tier,
            fed,
            stores,
            prop_precompute,
            recomputes,
            spread,
            poly,
            poly_runtime_spread,
            onward,
            job_roots,
            job_all,
            forwards_ref,
            ref_site,
            icon_spread,
            reads_children_value,
            rest_as_data,
            use_id,
            inner,
            has_for,
            hosts_children,
            absent,
            ir: child_ir,
            job_eval,
            job_outputs,
            job_fused,
            unwritten,
            shadowed,
            shadowed_input,
        }
    }

    /// Re-bases the fed children of a static component inlined here onto this component (F164): each record of the
    /// wrapper becomes one of ours, numbered in template order, with the wrapper's prop paths replaced by what this
    /// call site passes. `Err` = a shape it cannot bind (the caller falls back to React).
    fn rebase(&mut self, inner: &Inner, props: &[(String, Expr)]) -> Result<(), String> {
        if !inner.rebasable {
            return Err(
                "it has state or handlers of its own, so the server cannot feed its children"
                    .into(),
            );
        }
        if inner.folded {
            return Err("one of its instances was evaluated at build".into());
        }
        if !self.loop_sources.is_empty() {
            return Err("it sits in a list".into());
        }
        // A spread may carry any key: it matters only for a root a record binds from this wrapper's props (below).
        let spread = props.iter().any(|(k, _)| k == crate::ir::SPREAD_KEY);
        let mut out = Vec::new();
        for r in &inner.records {
            if !r.loops.is_empty() || r.rows_literal.is_some() {
                return Err("its child sits in a list".into());
            }
            if r.exprs
                .values()
                .any(|e| e != crate::lower::server_expr::UNDEFINED)
            {
                return Err("its child reads a computed value".into());
            }
            let mut rec = InstanceRecord {
                child_id: r.child_id.clone(),
                k: 0,
                loops: Vec::new(),
                props: Default::default(),
                literals: r.literals.clone(),
                exprs: r.exprs.clone(),
                rows_literal: None,
            };
            for (n, path) in &r.props {
                let Some(path) = path else {
                    return Err(format!("its child's prop `{n}` has no binding"));
                };
                let end = path.find(['.', '[']).unwrap_or(path.len());
                let (root, rest) = path.split_at(end);
                if root == "__store" {
                    rec.props.insert(n.clone(), Some(path.clone()));
                    continue;
                }
                if root == "children" {
                    return Err("its child reads `children`".into());
                }
                let given = props.iter().rev().find(|(k, _)| k == root).map(|(_, v)| v);
                if given.is_none() && spread {
                    return Err(format!(
                        "props are spread into it (record {} binds `{n}` from `{root}`)",
                        r.child_id
                    ));
                }
                let Some(v) = given else {
                    rec.exprs
                        .insert(n.clone(), crate::lower::server_expr::UNDEFINED.to_string());
                    continue;
                };
                if matches!(v, Expr::ClientOnly { .. }) || self.reads_state(v) {
                    return Err(format!("`{root}` is a function or changes on the client"));
                }
                if let Some(p) = self.prop_path(v) {
                    rec.props.insert(n.clone(), Some(format!("{p}{rest}")));
                } else if !rest.is_empty() {
                    return Err(format!(
                        "`{root}` is not a props path and its child reads inside it"
                    ));
                } else if let Some(j) = match v {
                    Expr::Raw(r) | Expr::Server(ServerExpr(r)) => r.json_literal_ordered(),
                    _ => None,
                } {
                    rec.literals.insert(n.clone(), j);
                } else if let Some(e) = self.instance_expr(v) {
                    rec.exprs.insert(n.clone(), e);
                } else {
                    return Err(format!(
                        "`{root}` is not a path, a literal or a template expression"
                    ));
                }
            }
            out.push(rec);
        }
        for mut rec in out {
            let k = self
                .instance_counts
                .entry(rec.child_id.clone())
                .or_insert(0);
            *k += 1;
            rec.k = *k;
            self.instances.push(rec);
        }
        for r in &inner.refs {
            if r.id.is_some() && !self.refs.iter().any(|x| x.id == r.id) {
                self.refs.push(ChildRef {
                    name: format!("{}.{}", inner_name(r), self.refs.len()),
                    ..r.clone()
                });
            }
        }
        Ok(())
    }

    /// Fuses the job of the fed child `child` into this component's own job (R34.96, PR 2b analysis half): every
    /// root of the child's job is bound from this component's props, a literal, one of its own precompute slots, or
    /// left out (the child's default applies). `false` = not fused; the caller keeps today's record or fallback.
    fn try_fuse(
        &mut self,
        name: &str,
        loc: u32,
        props: &[(String, Expr)],
        child: &Child,
        child_id: &str,
    ) -> bool {
        use crate::ir::{FusedInput, FusedInstance};
        let spreads = props.iter().any(|(k, _)| k == crate::ir::SPREAD_KEY);
        let plain = matches!(child.tier, Tier::Static)
            && !child.use_id
            && !child.stores
            && !child.job_all
            && !child.job_roots.contains("children")
            && !child.job_roots.contains("__store")
            && !child.job_outputs.is_empty()
            && self.loop_sources.is_empty()
            && self.guard_depth == 0
            && !props.iter().any(|(k, _)| k == "children");
        if !plain {
            return false;
        }
        let mut inputs = std::collections::BTreeMap::new();
        for root in &child.job_roots {
            let given = props.iter().rev().find(|(k, _)| k == root).map(|(_, v)| v);
            let input = match given {
                None => FusedInput::Undefined,
                Some(Expr::ClientOnly { .. }) => return false,
                Some(
                    v @ Expr::Precomputed {
                        slot,
                        per_item: None,
                        state_dependent: false,
                        ..
                    },
                ) if !self.deps_of(v).reactive() => FusedInput::Slot { name: slot.clone() },
                Some(v) => {
                    if self.reads_state(v) {
                        return false;
                    }
                    if let Some(path) = self.prop_path(v) {
                        // This component's own `children` is markup, never a job input: the fused job
                        // would read it as absent (review r1, Afrojack). Whole-component fallback (T2).
                        if path.split(['.', '[']).next() == Some("children") {
                            return false;
                        }
                        FusedInput::Prop { path }
                    } else if let Some(value) = match v {
                        Expr::Raw(r) | Expr::Server(ServerExpr(r)) => {
                            r.json_literal().or_else(|| self.fold_json(r))
                        }
                        _ => None,
                    } {
                        FusedInput::Literal { value }
                    } else {
                        return false;
                    }
                }
            };
            inputs.insert(root.clone(), input);
        }
        let has_slot = inputs
            .values()
            .any(|i| matches!(i, FusedInput::Slot { .. }));
        // Without a job of its own to join, the record (or the 2a re-base) already serves the child.
        if !self.own_job {
            debug_assert!(!has_slot, "a slot input implies a precompute job");
            return false;
        }
        // A spread of this component's props carries only keys the call sites are required to leave out.
        if spreads && self.spread_feeds_no_job_input(name, props, child).is_err() {
            return false;
        }
        let ordinal = {
            let n = self.fused_counts.entry(child_id.to_string()).or_insert(0);
            *n += 1;
            *n
        };
        let outputs = child
            .job_outputs
            .iter()
            .map(|slot| (slot.clone(), format!("_fj_{child_id}_{ordinal}_{slot}")))
            .collect();
        let (eval_refused, stubs) = match &child.job_eval {
            Some(Ok(stubs)) => (None, stubs.clone()),
            Some(Err(why)) => (Some(why.clone()), Vec::new()),
            None => (Some("not fed".to_string()), Vec::new()),
        };
        self.fused.push(FusedInstance {
            child_id: child_id.to_string(),
            loc,
            ordinal,
            inputs,
            outputs,
            eval_refused,
            stubs,
        });
        true
    }

    /// A spread of this component's own props into a fed child (F164, R34.83): fine when no input root of the child's
    /// jobs can ride it. The roots it could carry that this call does not write after it become this component's
    /// `unwritten_props`, which its call sites check (`require_unwritten`); any spread whose keys are not known to be
    /// this component's own props, a job that reads the whole props object or `children`, and a route root (whose
    /// props are the request) keep the refusal.
    fn spread_feeds_no_job_input(
        &mut self,
        name: &str,
        props: &[(String, Expr)],
        child: &Child,
    ) -> Result<(), String> {
        let refused = || {
            format!(
                "props are spread into <{name}>, which the server feeds per instance (a job or useId)"
            )
        };
        if child.job_all || child.job_roots.contains("children") {
            return Err(refused());
        }
        let last = props
            .iter()
            .rposition(|(k, _)| k == crate::ir::SPREAD_KEY)
            .unwrap_or(0);
        let mut carried = Vec::new();
        for root in child.job_roots.iter().filter(|r| r.as_str() != "__store") {
            if props[last + 1..].iter().any(|(k, _)| k == root) {
                continue; // written after the spread: it wins, and is bound as written
            }
            match self.spread_carries(root, props) {
                Ok(false) => {}
                Ok(true) if !self.ctx.is_root => carried.push(root.clone()),
                _ => return Err(refused()),
            }
        }
        self.unwritten.extend(carried);
        Ok(())
    }

    /// The call site of a component that spreads its props into a fed child (`unwritten_props`): `key` is written
    /// nowhere in it, not even as a literal `false`, because the spread would carry it into a job input the server
    /// does not bind. A spread of this component's own props passes the requirement up; anything else falls back.
    fn require_unwritten(
        &mut self,
        name: &str,
        key: &str,
        props: &[(String, Expr)],
        loc: u32,
    ) -> bool {
        let carried = self.spread_carries(key, props);
        let ok = !props.iter().any(|(k, _)| k == key)
            && match carried {
                Ok(false) => true,
                Ok(true) if !self.ctx.is_root => {
                    self.unwritten.insert(key.to_string());
                    true
                }
                _ => false,
            };
        if !ok {
            self.diagnostics.push(Diagnostic::fallback(
                "spread-props",
                format!(
                    "the prop `{key}` of <{name}> reaches a per-instance job of a child <{name}> spreads its props into, through a spread the server cannot feed (or props of unknown keys are spread in)"
                ),
                loc,
                "leave the prop out (pass it to the inner component directly), or keep the component interactive with React",
            ));
        }
        ok
    }

    /// The call site of a component that binds `key` live ahead of a spread of its own rest (`shadowed_props`): the
    /// call site must not write `key`, or in React its value would replace the live one. A spread of this
    /// component's own props passes the requirement up; anything else falls back, named. `input`: the child binds it
    /// ahead of a spread of its hidden rest (`shadowed_input`), so only the `__in_rest` this call site passes is checked.
    fn require_shadowed(
        &mut self,
        name: &str,
        key: &str,
        props: &[(String, Expr)],
        loc: u32,
        input: bool,
    ) -> bool {
        let carried = if input {
            let rest: Vec<(String, Expr)> = props
                .iter()
                .filter(|(k, _)| k == REST_INPUT)
                .cloned()
                .collect();
            self.spread_sources(key, &rest)
        } else {
            self.spread_sources(key, props)
        };
        // F329b (W3): the call site WRITES the key, once, with a value the child's element can take over per call site: a literal
        // (`'aria-pressed': undefined`, `role: 'radio'`) or a live prop this call binds itself (`live_props`). The printed item
        // list is per call site and the child's own binding comes first (A3), so the later key replaces it and the shared
        // chunk is not involved. After the last spread nothing a spread carries can replace it; before an own-rest spread the
        // requirement moves up like any other (callers may not write the key); before a spread of unknown keys it is refused.
        let written_once = !input && props.iter().filter(|(k, _)| k == key).count() == 1;
        let value_ok = written_once
            && props.iter().find(|(k, _)| k == key).is_some_and(|(_, v)| {
                self.live_props.iter().any(|f| f.loc == loc && f.key == key) || is_literal_value(v)
            });
        let after_last_spread = {
            let at = props.iter().position(|(k, _)| k == key);
            let last = props
                .iter()
                .rposition(|(k, _)| k == crate::ir::SPREAD_KEY || k == REST_INPUT);
            at.zip(last).is_none_or(|(at, sp)| sp < at)
        };
        let carry = |this: &mut Self| match carried {
            Ok((false, false)) => true,
            Ok(src) if !this.ctx.is_root => {
                this.shadow(key, src);
                true
            }
            _ => false,
        };
        let ok = if value_ok && after_last_spread {
            true
        } else if value_ok {
            carry(self)
        } else {
            (input || !props.iter().any(|(k, _)| k == key)) && carry(self)
        };
        if !ok {
            self.diagnostics.push(Diagnostic::fallback(
                "spread-props",
                format!(
                    "the prop `{key}` of <{name}> is bound live by <{name}> ahead of a spread of its rest, so a value written here (or props of unknown keys spread in) could replace it"
                ),
                loc,
                "leave the prop out, or keep the component interactive with React",
            ));
        }
        ok
    }

    /// Whether the props spread into a child at this call site may carry `key` (F153c): `Ok(true)` when one of them is
    /// this component's own props object, or its `...rest` and `key` is not a named prop; `Err` when a spread of
    /// keys known only at render (a props path) is among them.
    fn spread_carries(&self, key: &str, props: &[(String, Expr)]) -> Result<bool, ()> {
        self.spread_sources(key, props)
            .map(|(own, input)| own || input)
    }

    /// `spread_carries` by source, `(own, input)`: `own` when this component's own props object or rest may carry `key`,
    /// `input` when its hidden rest (`__in_rest`, a clone's call site rest) may: the requirement moves up to different
    /// keys of the call site (`shadow`).
    fn spread_sources(&self, key: &str, props: &[(String, Expr)]) -> Result<(bool, bool), ()> {
        let mut own = false;
        let mut input = false;
        for (k, v) in props {
            // F278: the call site's whole rest handed to a clone as its hidden input behaves as the spread of it.
            let rest_input = k == REST_INPUT;
            if k != crate::ir::SPREAD_KEY && !rest_input {
                continue;
            }
            match v {
                Expr::Raw(r) | Expr::Server(ServerExpr(r)) => match &r.kind {
                    // inside the clone: the spread of that input, whose keys are the caller's rest
                    RawKind::Ident {
                        name,
                        kind: IdentKind::Prop,
                    } if name == REST_INPUT && !rest_input => input = true,
                    RawKind::Ident {
                        name,
                        kind: IdentKind::Prop,
                    } if name == "*" => own = true,
                    RawKind::Ident {
                        name,
                        kind: IdentKind::Prop,
                    } if name == crate::ir::REST_PROPS => own |= !self.own_named.contains(key),
                    _ => return Err(()),
                },
                _ => return Err(()),
            }
        }
        Ok((own, input))
    }

    /// Moves a `shadowed_props` requirement on `key` up to this component's call sites, by where the spread that may
    /// carry it comes from (`spread_sources`).
    fn shadow(&mut self, key: &str, (own, input): (bool, bool)) {
        if own {
            self.shadowed.insert(key.to_string());
        }
        if input {
            self.shadowed_input.insert(key.to_string());
        }
    }

    /// The child must not get `key` (its `absent_props`, F153c): a written literal `false` / `undefined` is fine, a
    /// spread of this component's own props passes the requirement to this component's call sites, anything
    /// else falls back. `true` = satisfied (the child renders as compiled).
    fn require_absent(
        &mut self,
        name: &str,
        key: &str,
        props: &[(String, Expr)],
        loc: u32,
    ) -> bool {
        let written = props.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v);
        let falsy = match written {
            None => true,
            Some(Expr::Raw(r) | Expr::Server(ServerExpr(r))) => {
                matches!(r.json_literal(), Some(serde_json::Value::Bool(false)))
                    || matches!(r.kind, RawKind::Lit(crate::ir::Literal::Undefined))
            }
            Some(_) => false,
        };
        // A route root's props come from the request: no call site checks a requirement passed up to it.
        let carried = self.spread_carries(key, props).and_then(|c| {
            if c && self.ctx.is_root {
                Err(())
            } else {
                Ok(c)
            }
        });
        if falsy && let Ok(carries) = carried {
            if carries {
                self.absent.insert(key.to_string());
            }
            return true;
        }
        // switch-provider-chain (ruling 7a25d5e0): a scope the child hands on (its own `__scope*` prop) selects a
        // context instance, which brust resolves by position (W1d PR 2, Mellow C4).
        if key.starts_with("__scope") {
            self.diagnostics.push(Diagnostic::fallback(
                "context-scope",
                format!(
                    "<{name}> hands its prop `{key}` to a native component as a Radix scope, and this call site may pass one (or props of unknown keys are spread in); brust resolves scopes by position"
                ),
                loc,
                "do not pass a scope, or keep this component in React",
            ));
            return false;
        }
        self.diagnostics.push(Diagnostic::fallback(
            "slot-dynamic",
            format!(
                "`{key}` of <{name}> is not a literal `false` or absent (or props of unknown keys are spread in), so brust cannot tell which element it renders"
            ),
            loc,
            "leave the prop out, or keep the page on React",
        ));
        false
    }

    /// F316: records a reason this component's instances must mount once (each distinct reason, in the order found).
    fn add_mount_once(&mut self, reason: String) {
        if !self.mount_once.contains(&reason) {
            self.mount_once.push(reason);
        }
    }

    /// Mirrors `lower::template::expr_reactive`.
    /// F295: the deps of a prop value `v` passed to `<name>` as they stay while this instance lives: snapshot cells
    /// (read as their value at mount) do not change, so they do not link the child. Leaving them out is right only if
    /// this component mounts once, which it then asks of its callers (`mount_once`).
    fn deps_while_mounted(&mut self, v: &Expr, name: &str, k: &str) -> Deps {
        let mut d = self.deps_of(v);
        if !matches!(v, Expr::Raw(_) | Expr::Server(_)) || !d.reactive() || d.changes_after_mount()
        {
            return d;
        }
        d.state.clear();
        self.add_mount_once(format!(
            "<{name}> gets `{k}`, a value taken once at mount, with no link"
        ));
        d
    }

    /// F319: the roots of the props `d` reads that can change on the client (this component's props can, and the call
    /// site did not fix the prop). `children` is left out: slot content is the caller's markup, bound in its scope.
    /// A read of the rest or of the whole props object is the root `*` (deps): every prop that lands there.
    fn changing_prop_roots(&self, d: &Deps) -> Vec<String> {
        if !self.props_reactive {
            return Vec::new();
        }
        d.props
            .iter()
            .map(|p| p.split(['.', '[']).next().unwrap_or(p).to_string())
            .filter(|r| r != "children" && !self.fixed_props.contains(r))
            .collect()
    }

    fn reads_state(&self, e: &Expr) -> bool {
        match e {
            Expr::Precomputed {
                state_dependent, ..
            } => *state_dependent,
            other => self.deps_of(other).reactive(),
        }
    }

    /// A list source the client re-evaluates: it reads state, or it reads props that can change.
    fn source_reactive(&self, e: &Expr) -> bool {
        self.reads_state(e)
            || (self.props_reactive
                && self.deps_of(e).props.iter().any(|p| {
                    let root = p.split(['.', '[']).next().unwrap_or(p);
                    !self.fixed_props.contains(root)
                }))
    }

    /// F325: the list source reads module-level data (an import, a module const).
    fn module_list(&self, source: &Expr) -> bool {
        crate::lower::template::module_source(&self.deps_of(source))
    }

    /// F320: `e` changes on the client: state, or a prop of a component whose props are a signal (`props_live`).
    fn live(&self, e: &Expr) -> bool {
        self.reads_state(e) || self.reads_changing_prop(&self.deps_of(e))
    }

    /// F320: `d` reads a named prop that changes on the client: this component's props are a signal (`props_live`) and
    /// the prop is not one its call site fixed.
    fn reads_changing_prop(&self, d: &Deps) -> bool {
        self.props_live
            && self.module_rows.get() == 0
            && d.props.iter().any(|p| {
                let root = p.split(['.', '[']).next().unwrap_or(p);
                // The rest or the whole props object (`*`) stays with F319's freeze, answered per call site: counting it
                // here would link every child it is spread into (and refuse a handler in that spread, spread-handler).
                // A clone's `__in_rest` (F278/F298) is the call site's rest carried in: the same, answered at that site.
                // A context value (`__ctx_*`) is fed by the Provider's frame, not by a caller: its own machinery binds it.
                !matches!(root, "children" | "*" | REST_INPUT)
                    && !root.starts_with("__ctx_")
                    && !self.fixed_props.contains(root)
                    && !self.seed_props.contains(root)
            })
    }

    /// F320: one prop of a link decision (`instance_needs_link`): `(true, _)` when the value is a function or reads a
    /// prop that changes (the child must follow it, as for state).
    fn link_input(&self, k: &str, v: &Expr, d: Deps) -> (bool, Deps) {
        (
            matches!(v, Expr::ClientOnly { .. })
                || (!self.hold_link && (self.reads_changing_prop(&d) || self.passes_ctx(k, &d))),
            d,
        )
    }

    /// switch-provider-chain PR3: the frames pass handed a consumer child its context value (`k` is the child's hidden
    /// `__ctx_*` prop) as one of this component's own (the consumer sits under another component, such as a Thumb
    /// carried in a trigger's rest, F298). The frame keeps this component's copy current, but the child takes it as a
    /// prop: unlinked, it would print it once (F319 then freezes the value, and a state Provider above refuses). Only
    /// that key: a context value an author passes under a key of their own (`name={name}`) keeps F319's answer per call
    /// site (frozen, refused only where the Provider's value changes).
    fn passes_ctx(&self, k: &str, d: &Deps) -> bool {
        k.starts_with("__ctx_") && self.props_live && self.module_rows.get() == 0 && reads_ctx(d)
    }

    /// Whether the client can re-create the rows of this list: an enclosing list can, its
    /// source changes (state, or props of a component whose props can change), or its body
    /// carries a directive of its own.
    fn row_reactive(&self, source: &Expr, body: &[Node], enclosing: bool) -> bool {
        enclosing || self.source_reactive(source) || body.iter().any(|n| self.body_directive(n))
    }

    /// `lower::template::needs_directives` without the row-only links this pass decides:
    /// a component counts only through an `Always` link (or its slot children).
    fn body_directive(&self, n: &Node) -> bool {
        match n {
            Node::Element {
                attrs, children, ..
            } => {
                attrs.iter().any(|a| match a {
                    Attr::Event { .. } | Attr::Ref { .. } => true,
                    Attr::Dynamic { value, .. } | Attr::InnerHtml { value } => self.live(value),
                    _ => false,
                }) || children.iter().any(|c| self.body_directive(c))
            }
            // F320: a prop that changes is as live as state for a row.
            Node::Slot(e) => self.live(e),
            Node::If {
                cond, then, else_, ..
            } => self.live(cond) || then.iter().chain(else_).any(|c| self.body_directive(c)),
            Node::For { source, body, .. } => {
                let module = self.module_list(source);
                self.module_rows
                    .set(self.module_rows.get() + usize::from(module));
                let r = self.source_reactive(source) || body.iter().any(|c| self.body_directive(c));
                self.module_rows
                    .set(self.module_rows.get() - usize::from(module));
                r
            }
            Node::Component { link, children, .. } => {
                link.is_some_and(|id| !self.row_only.contains_key(&id))
                    || children.iter().any(|c| self.body_directive(c))
            }
            Node::Fragment(cs) => cs.iter().any(|c| self.body_directive(c)),
            Node::Text(_) | Node::Outlet => false,
        }
    }

    /// What in slot content is bound by an instance (this component's) when printed: a handler, a ref, a binding that
    /// reads state, a list or condition over state, a linked or hoisted child. `None` for markup the server prints once.
    fn owned_directive(&self, n: &Node) -> Option<&'static str> {
        match n {
            Node::Element {
                attrs, children, ..
            } => attrs
                .iter()
                .find_map(|a| match a {
                    Attr::Event { .. } => Some("an event handler"),
                    Attr::Ref { .. } => Some("a ref"),
                    Attr::Dynamic { value, .. }
                    | Attr::InnerHtml { value }
                    | Attr::Spread(value)
                        if self.source_reactive(value) =>
                    {
                        Some("an attribute that changes on the client")
                    }
                    _ => None,
                })
                .or_else(|| children.iter().find_map(|c| self.owned_directive(c))),
            // The caller's own `{children}` passed on is that caller's content, judged where it is given.
            Node::Slot(_) if template_reads_children(n) => None,
            Node::Slot(e) if self.source_reactive(e) => Some("text that changes on the client"),
            Node::Slot(_) | Node::Text(_) | Node::Outlet => None,
            Node::If {
                cond, then, else_, ..
            } => {
                if self.source_reactive(cond) {
                    Some("a condition that changes on the client")
                } else {
                    then.iter()
                        .chain(else_)
                        .find_map(|c| self.owned_directive(c))
                }
            }
            Node::For { source, body, .. } => {
                if self.source_reactive(source) {
                    Some("a list that changes on the client")
                } else {
                    body.iter().find_map(|c| self.owned_directive(c))
                }
            }
            Node::Component {
                loc,
                link,
                children,
                ..
            } => {
                if link.is_some_and(|id| !self.row_only.contains_key(&id)) {
                    Some("a component with props that change on the client")
                } else if self
                    .handlers
                    .iter()
                    .any(|h| h.forwarded.as_ref().is_some_and(|f| f.loc == *loc))
                    || self.live_forwards.iter().any(|f| f.loc == *loc)
                {
                    Some("a handler or a live value bound on a child's element")
                } else {
                    children.iter().find_map(|c| self.owned_directive(c))
                }
            }
            Node::Fragment(cs) => cs.iter().find_map(|c| self.owned_directive(c)),
        }
    }

    /// Second pass (ledger F70): a `RowOnly` link survives only inside a row the client can
    /// re-create; elsewhere the instance is plain HTML, so the link, its `_pN` member and the
    /// client reads it implied are dropped. Surviving ids keep their numbers (`_pN` is a
    /// name, not an index: a dropped link leaves a gap).
    fn resolve_row_only(&mut self, nodes: &mut [Node], reactive: bool) {
        for n in nodes {
            match n {
                Node::For { source, body, .. } => {
                    let module = self.module_list(source);
                    self.module_rows
                        .set(self.module_rows.get() + usize::from(module));
                    let r = self.row_reactive(source, body, reactive);
                    if !r {
                        // F319: rows printed once (no x-for): a prop they read would not be followed.
                        let mut exprs = Vec::new();
                        node_exprs(body, &mut exprs);
                        for e in exprs {
                            let roots = self.changing_prop_roots(&self.deps_of(&e));
                            self.frozen.extend(roots);
                        }
                    }
                    self.resolve_row_only(body, r);
                    self.module_rows
                        .set(self.module_rows.get() - usize::from(module));
                }
                Node::Component { link, children, .. } => {
                    if let Some(id) = *link
                        && let Some((uses, pc)) = self.row_only.remove(&id)
                    {
                        if reactive {
                            // The client re-creates this row, so its props change: values the
                            // child computed from them on the server would freeze (F96d).
                            if let Some((name, loc)) = pc {
                                self.diagnostics.push(linked_prop_precompute(&name, loc));
                            }
                            self.st.client_uses.extend(uses);
                        } else {
                            *link = None;
                            self.links.retain(|l| l.id != id);
                        }
                    }
                    self.resolve_row_only(children, reactive);
                }
                Node::Element { children, .. } | Node::Fragment(children) => {
                    self.resolve_row_only(children, reactive)
                }
                Node::If { then, else_, .. } => {
                    self.resolve_row_only(then, reactive);
                    self.resolve_row_only(else_, reactive);
                }
                Node::Text(_) | Node::Slot(_) | Node::Outlet => {}
            }
        }
    }

    fn component(&mut self, n: &mut Node) {
        let Node::Component {
            loc,
            name,
            source,
            imported,
            member,
            props,
            children,
            link,
            tier,
            forwarded_ref,
        } = n
        else {
            return;
        };
        if name == "<member>" {
            self.slot_depth += 1;
            children.iter_mut().for_each(|c| self.node(c));
            self.slot_depth -= 1;
            return;
        }
        let child = self.resolve_child(name, source.as_deref(), imported.as_deref(), member, *loc);
        // L23: a lucide icon with reactive props is inlined by the second compile; only if it is
        // still a component then (`icons_final`) is a prop it cannot hydrate from an error.
        let pending_icon = !self.ctx.opts.icons_final
            && source.as_deref().is_some_and(super::icons::is_lucide)
            && !self
                .ctx
                .opts
                .icon_svgs
                .contains_key(&format!("{}@{loc}", self.ctx.path));
        // R34.56: a value an island cannot hydrate from makes the HOST React (React renders the
        // whole subtree, function and all); valid React is never a build error.
        let island_err = |rule: &str, msg: String, loc: u32, fix: &str| {
            if pending_icon {
                Diagnostic::warning(rule, msg, loc, fix)
            } else {
                Diagnostic::fallback(rule, msg, loc, fix)
            }
        };
        *tier = child.tier.clone();
        // F388 (Mellow N1): a `left && <X/>` that prints its falsy `left` must not land in an element that takes no text
        // (a table part, a select), across a component boundary either way: the child's root `&&` in an element of THIS
        // template, or a `&&` given as children that the child prints in such an element of ITS template.
        if let Some(c) = child.ir.as_deref() {
            let at = if self.no_text && falsy_left_root(&c.template) {
                Some(format!(
                    "<{name}> renders `left && <X/>` at its root, here inside an element that takes no text"
                ))
            } else if children.iter().any(falsy_left_root) && c.children_no_text {
                Some(format!(
                    "<{name}> prints the `left && <X/>` given as its children inside an element that takes no text"
                ))
            } else {
                None
            };
            // This component's own `{children}`, handed to such a child, lands there too.
            if c.children_no_text && children.iter().any(passes_children) {
                self.children_no_text = true;
            }
            if let Some(at) = at {
                self.diagnostics.push(Diagnostic::fallback(
                    crate::analyze::component::AND_FALSY_IN_TABLE,
                    format!("{at} (a table part or a select), and `left` may be a number React would print there"),
                    *loc,
                    "test a boolean (`n > 0 && <tr/>`), or keep this component in React",
                ));
            }
        }
        if !matches!(child.tier, Tier::Static | Tier::Native)
            || child.ir.as_ref().is_some_and(|c| c.holds_island)
        {
            self.holds_island = true;
        }
        // R34.64: a `ref` at the call site of a `forwardRef` component reaches an element React attaches it to; a
        // static or native render has none to give it.
        // F153c: passing this component's own forwarded ref on is React's `ref` chain; it ends on a host element
        // (dropped, R34.63) only when the child forwards it there itself.
        if *forwarded_ref && (!child.forwards_ref || matches!(child.tier, Tier::React { .. })) {
            self.diagnostics.push(Diagnostic::fallback(
                "forwardref-ref",
                format!(
                    "the forwarded ref is passed to <{name}>, which does not forward it to an element; the component renders as a React island"
                ),
                *loc,
                "pass the ref to an element, or to a forwardRef component that does",
            ));
        }
        // F364: this component's forwarded ref goes to a child that reads it as `null`: so does this one, for its callers
        if *forwarded_ref && child.ir.as_deref().is_some_and(|c| c.forwarded_ref_nulled) {
            self.ref_nulled = true;
        }
        // F267: a ref of this component's own bound on the one element an inlined child hands its `ref` to.
        let ref_cell = self.forward_ref(*loc, props, &child);
        let ref_fwd = ref_cell.is_some();
        // F329: a `ref` that is one of this component's sink refs (nothing reads it: its every use is a component's `ref` prop)
        // hands nothing to anyone, so it is dropped here and the child renders without it, as React's would be unobservable.
        if child.forwards_ref
            && !ref_fwd
            && matches!(child.tier, Tier::Static | Tier::Native)
            && !child.ir.as_deref().is_some_and(|c| c.forwarded_ref_nulled)
            && props.iter().filter(|(k, _)| k == "ref").count() == 1
            && matches!(
                self.st.prop_raws.get(&(*loc, "ref".to_string())),
                Some(RawExpr { kind: RawKind::Ident { name, .. }, .. }) if self.sink_refs.contains(name)
            )
            // a spread on either side may carry a `ref` of its own (React: the later one wins)
            && !props.iter().any(|(k, _)| k == crate::ir::SPREAD_KEY)
        {
            props.retain(|(k, _)| k != "ref");
        }
        if child.forwards_ref && !ref_fwd && props.iter().any(|(k, _)| k == "ref") {
            self.diagnostics.push(Diagnostic::fallback(
                "forwardref-ref",
                format!("`ref` is passed to the forwardRef component <{name}>; brust renders it without a ref"),
                *loc,
                "drop the ref, or keep this component in React",
            ));
        }
        self.hold_link = false;
        let live = self.forward_live(name, *loc, props, &child, ref_fwd);
        let (mut hoisted, unbound) = self.forward_handlers(name, *loc, props, &child, &live);
        // A hoisted handler is a member of this component, printed from its own declaration: the prop's slot in the
        // precompute job is read by nothing any more, and must not keep the job (and a per-instance feed) alive.
        for (k, v) in props.iter_mut() {
            if hoisted.contains(k) && matches!(v, Expr::Precomputed { .. }) {
                *v = Expr::Raw(RawExpr {
                    loc: *loc,
                    kind: RawKind::Lit(crate::ir::Literal::Undefined),
                });
            }
        }
        // A live value the parent binds itself is, like a hoisted handler, the parent's own member: not a prop of the
        // instance, and nothing for `check_spread` to refuse.
        hoisted.extend(live);
        if let Some(cell) = ref_cell {
            // the prop is the parent's ref cell, as the printer binds it (not a function value)
            for (k, v) in props.iter_mut() {
                if k == "ref" {
                    *v = Expr::Raw(RawExpr {
                        loc: *loc,
                        kind: RawKind::Ident {
                            name: cell.clone(),
                            kind: IdentKind::Local,
                        },
                    });
                }
            }
            hoisted.push("ref".to_string());
            self.live_forwards.push(crate::ir::Forwarded {
                loc: *loc,
                key: "ref".to_string(),
            });
        }
        self.check_children_read(name, props, children, &child, *loc);
        // F148a (R34.121): the island inside this wrapper renders its `{children}`: the call site hands the
        // wrapper the constant tree of them as the reserved prop `__ch`, which only a compiler-written call
        // can set. Children that are not a constant tree are the same fallback a React wrapper gave.
        let mut ch_nested: Option<Vec<String>> = None;
        if !matches!(child.tier, Tier::React { .. }) && child.job_roots.contains(CH_PROP) {
            if props.iter().any(|(k, _)| k == crate::ir::SPREAD_KEY) {
                // R34.121: `__ch` is the call site's alone. A spread could carry one from request data into a
                // tree the revive walks, so a wrapper whose island renders `{children}` takes no spread, by this
                // rule and not only by the per-instance rule of `check_spread`.
                self.diagnostics.push(Diagnostic::fallback(
                    "spread-props",
                    format!("props are spread into <{name}>, whose island renders `{{children}}`: the tree for it comes from the call site only"),
                    *loc,
                    "pass these props explicitly",
                ));
            } else if props.iter().any(|(k, _)| k == CH_PROP) {
                self.diagnostics.push(Diagnostic::fallback(
                    "island-prop",
                    format!("the prop `{CH_PROP}` of <{name}> is reserved by brust"),
                    *loc,
                    "rename the prop",
                ));
            } else if !children.is_empty() {
                self.holes = None;
                match self.lower_children(children) {
                    Ok((tree, nested)) => {
                        let raw = RawExpr {
                            loc: *loc,
                            kind: raw_json(&tree, *loc),
                        };
                        props.push((CH_PROP.into(), Expr::Server(ServerExpr(raw))));
                        ch_nested = Some(nested);
                    }
                    Err(why) => self.diagnostics.push(Diagnostic::fallback(
                        "island-children",
                        format!("the children of <{name}> reach a React island inside it and cannot be lowered: {why}"),
                        *loc,
                        "render the children inside the island component, or pass constant markup",
                    )),
                }
            }
        }
        self.check_spread(name, props, &child, *loc, &hoisted, &unbound);
        // A hoisted handler is the parent's own member: not a prop of the instance.
        let kept: Vec<(String, Expr)> = props
            .iter()
            .filter(|(k, _)| !hoisted.contains(k))
            .cloned()
            .collect();
        self.check_poly(name, props, children, &child, *loc);
        if !matches!(child.tier, Tier::React { .. }) {
            for key in child.absent.clone() {
                if !self.require_absent(name, &key, props, *loc) {
                    break;
                }
            }
            for key in child.unwritten.clone() {
                if !self.require_unwritten(name, &key, props, *loc) {
                    break;
                }
            }
            for key in child.shadowed.clone() {
                if !self.require_shadowed(name, &key, props, *loc, false) {
                    break;
                }
            }
            for key in child.shadowed_input.clone() {
                if !self.require_shadowed(name, &key, props, *loc, true) {
                    break;
                }
            }
        }
        if !self.refs.iter().any(|r| r.name == *name) {
            self.refs.push(ChildRef {
                name: name.clone(),
                id: child.id.clone(),
                path: child.path.clone(),
                tier: child.tier.clone(),
                nested: None,
                x: Vec::new(),
                holes: Vec::new(),
            });
        }
        if let Some(nested) = ch_nested {
            self.note_nested(name, nested);
        }
        let child_id = child.id.clone().unwrap_or_else(|| name.clone());
        match &child.tier {
            Tier::React { client_only, .. } => {
                let mut inputs = Vec::new();
                let mut prop_map = std::collections::BTreeMap::new();
                let mut literals = std::collections::BTreeMap::new();
                let mut ok = true;
                let mut element_props: Vec<(String, serde_json::Value)> = Vec::new();
                // F148a: the values the lowered children and element props read from this component's props.
                self.holes = Some(Vec::new());
                // R34.69: a route component's props are request data; the revive never runs for it, so the
                // caller may not hand it lowered JSX (children or an element prop).
                // A route component is the default export of its file, so a named or same-file component of a
                // route file is not one: compare ids, not files.
                let root_host = child.id.as_deref().is_some_and(|id| {
                    self.ctx
                        .opts
                        .route_roots
                        .iter()
                        .any(|p| component_id(p) == id)
                });
                for (k, v) in props.iter() {
                    // `$`-prefixed props are the compiler's own (`$x`, the revive switch): a call-site prop of
                    // that name, written or inlined from a literal spread, could make data revive as elements.
                    if k.starts_with('$') {
                        self.diagnostics.push(Diagnostic::fallback(
                            "island-prop",
                            format!("the prop `{k}` of the React island <{name}> starts with `$`, which brust reserves for its own island props"),
                            *loc,
                            "rename the prop",
                        ));
                        continue;
                    }
                    // An element as a prop of the island (R34.52): lowered like children, revived
                    // from the names in the instance's `$x` literal.
                    if let Expr::Raw(RawExpr {
                        kind: RawKind::Jsx(el),
                        ..
                    }) = v
                    {
                        if root_host {
                            root_host_diag(&mut self.diagnostics, name, *loc);
                            continue;
                        }
                        let mark = self.holes.as_ref().map_or(0, Vec::len);
                        let lowered = if slot_prop_ok(k) {
                            self.lower_children(std::slice::from_ref(&**el))
                        } else {
                            Err("a prop name the revive reserves".to_string())
                        };
                        if lowered.is_err()
                            && let Some(h) = self.holes.as_mut()
                        {
                            h.truncate(mark);
                        }
                        match lowered {
                            Ok((tree, nested)) => {
                                literals.insert(k.clone(), crate::ir::OJson::from(tree.clone()));
                                element_props.push((k.clone(), tree));
                                self.note_nested(name, nested);
                            }
                            Err(why) => self.diagnostics.push(Diagnostic::fallback(
                                "island-children",
                                format!("JSX passed as the prop `{k}` of the React island <{name}> cannot be lowered: {why}"),
                                *loc,
                                "render the element inside the island component, or pass constant markup",
                            )),
                        }
                        continue;
                    }
                    let d = self.deps_of(v);
                    let why = if matches!(v, Expr::ClientOnly { .. }) {
                        Some("a function".to_string())
                    } else if !d.state.is_empty() {
                        Some(format!(
                            "a reactive value (reads state `{}`)",
                            d.state.iter().cloned().collect::<Vec<_>>().join("`, `")
                        ))
                    } else if !d.stores.is_empty() {
                        Some(format!(
                            "a reactive value (reads store `{}`)",
                            d.stores.iter().cloned().collect::<Vec<_>>().join("`, `")
                        ))
                    } else {
                        None
                    };
                    if let Some(why) = why {
                        ok = false;
                        self.diagnostics.push(island_err(
                            "island-prop",
                            format!("prop `{k}` passed to the React island <{name}> is {why}"),
                            *loc,
                            "pass JSON values to keep this component native; it renders with React meanwhile",
                        ));
                        continue;
                    }
                    inputs.extend(self.paths_of(v));
                    let lit = match v {
                        Expr::Raw(r) | Expr::Server(ServerExpr(r)) => r.json_literal_ordered(),
                        _ => None,
                    };
                    match lit {
                        Some(j) => {
                            literals.insert(k.clone(), j);
                        }
                        None => match self.prop_path(v) {
                            Some(path) => {
                                prop_map.insert(k.clone(), Some(path));
                            }
                            None => {
                                // The server hands an island a props path or a JSON value (the manifest refuses
                                // anything else with `ssr-prop-not-a-path`); valid React is never a build error.
                                ok = false;
                                self.diagnostics.push(island_err(
                                    "island-prop",
                                    format!("prop `{k}` of the React island <{name}> is an expression over props, which the server cannot hand to the island"),
                                    *loc,
                                    "pass a prop as it is, or a JSON value; the component renders with React meanwhile",
                                ));
                            }
                        },
                    }
                }
                if !element_props.is_empty() {
                    for (k, tree) in &element_props {
                        let raw = RawExpr {
                            loc: *loc,
                            kind: raw_json(tree, *loc),
                        };
                        if let Some(slot) = props.iter_mut().find(|(n, _)| n == k) {
                            slot.1 = Expr::Server(ServerExpr(raw));
                        }
                    }
                    let names = serde_json::Value::Array(
                        element_props
                            .iter()
                            .map(|(k, _)| serde_json::Value::String(k.clone()))
                            .collect(),
                    );
                    let raw = RawExpr {
                        loc: *loc,
                        kind: raw_json(&names, *loc),
                    };
                    props.push((X_KEY.to_string(), Expr::Server(ServerExpr(raw))));
                    if let Some(r) = self.refs.iter_mut().find(|r| r.name == *name) {
                        for (k, _) in &element_props {
                            if !r.x.contains(k) {
                                r.x.push(k.clone());
                            }
                        }
                        r.x.sort();
                    }
                    literals.insert(X_KEY.to_string(), crate::ir::OJson::from(names));
                }
                if !children.is_empty() && root_host {
                    root_host_diag(&mut self.diagnostics, name, *loc);
                } else if !children.is_empty() {
                    let mark = self.holes.as_ref().map_or(0, Vec::len);
                    let lowered = self.lower_children(children);
                    if lowered.is_err()
                        && let Some(h) = self.holes.as_mut()
                    {
                        h.truncate(mark);
                    }
                    match lowered {
                        Ok((tree, nested)) => {
                            let raw = RawExpr {
                                loc: *loc,
                                kind: raw_json(&tree, *loc),
                            };
                            literals.insert("children".to_string(), crate::ir::OJson::from(tree));
                            props.push(("children".into(), Expr::Server(ServerExpr(raw))));
                            children.clear();
                            if let Some(r) = self.refs.iter_mut().find(|r| r.name == *name) {
                                let all = r.nested.get_or_insert_with(Vec::new);
                                for id in nested {
                                    if !all.contains(&id) {
                                        all.push(id);
                                    }
                                }
                            }
                        }
                        Err(why) => self.diagnostics.push(Diagnostic::fallback(
                            "island-children",
                            format!("JSX children passed to the React island <{name}> cannot be lowered: {why}"),
                            *loc,
                            "render the children inside the island component, or pass constant markup",
                        )),
                    }
                }
                // F148a (R34.120): each value the trees read from props is one more island prop, filled by the
                // same path as a scalar prop-path prop; the revive reads only the names listed on the ref.
                for (key, expr) in self.holes.take().unwrap_or_default() {
                    inputs.extend(self.paths_of(&expr));
                    let path = if key.starts_with("$c") {
                        Some(CH_PROP.to_string())
                    } else {
                        self.prop_path(&expr)
                    };
                    prop_map.insert(key.clone(), path);
                    props.push((key.clone(), expr));
                    if let Some(r) = self.refs.iter_mut().find(|r| r.name == *name)
                        && !r.holes.contains(&key)
                    {
                        r.holes.push(key);
                        r.holes.sort();
                    }
                }
                if ok && self.lists.iter().any(|(_, stateful)| *stateful) {
                    ok = false;
                    self.diagnostics.push(island_err(
                        "island-prop",
                        format!("the React island <{name}> sits in a list that changes with state"),
                        *loc,
                        "key the list on props only to keep this component native; it renders with React meanwhile",
                    ));
                }
                if ok
                    && self.items.last().is_some()
                    && (!self.ctx.is_root || self.loop_sources.len() > 1)
                {
                    // F53 (R34.97): the server hands an island's job one array indexed by ONE list of the route
                    // component; a row of an inlined component, or a second list, has no slot key.
                    ok = false;
                    self.diagnostics.push(island_err(
                        "nested-instance",
                        format!(
                            "the React island <{name}> has per-row props and sits in nested lists or in a component inlined into its callers, which the server cannot feed per row"
                        ),
                        *loc,
                        "map over the list in the route component, or keep this component interactive with React",
                    ));
                }
                if ok {
                    for (src, _) in &self.lists {
                        inputs.extend(src.iter().cloned());
                    }
                    let count = self.ssr_outputs.entry(child_id.clone()).or_insert(0);
                    *count += 1;
                    let output = if *count == 1 {
                        format!("_ssr_{child_id}")
                    } else {
                        format!("_ssr_{child_id}_{count}")
                    };
                    self.jobs.push(JobDecl {
                        kind: JobKind::Ssr {
                            client_only: *client_only,
                        },
                        inputs: minimal_paths(inputs),
                        outputs: vec![output],
                        per_item: self.items.last().cloned(),
                        props: Some(prop_map),
                        literals,
                    });
                }
            }
            _ => {
                // An element as a prop travels only to a React island (R34.52); anything else
                // keeps the fallback `placement` used to raise for it.
                if props.iter().any(|(_, v)| {
                    matches!(
                        v,
                        Expr::Raw(RawExpr {
                            kind: RawKind::Jsx(_),
                            ..
                        })
                    )
                }) && !self.diagnostics.iter().any(|d| d.rule == "jsx-expression")
                {
                    self.diagnostics.push(Diagnostic::fallback(
                        "jsx-expression",
                        "JSX inside an expression that is not a list, a condition or a child",
                        *loc,
                        "use a ternary, && or .map directly in the JSX children",
                    ));
                }
                // R34.96: a fed child of a component that has a job of its own runs inside that job.
                let fused = child.fed && self.try_fuse(name, *loc, props, &child, &child_id);
                // The template backend numbers every inlined instance of a child id.
                let k = if fused {
                    0
                } else {
                    let k = self.instance_counts.entry(child_id.clone()).or_insert(0);
                    *k += 1;
                    *k
                };
                let row_invariant = !fused && child.fed && self.row_invariant(&kept, &child);
                // F142 R34.43: one enclosing list that is a constant array feeds the instance per
                // row from the literal the manifest carries (capped, ruling Q3).
                let rows_literal = match (&self.loop_sources[..], &self.loop_literals[..]) {
                    ([None], [Some(rows)]) if child.fed && !row_invariant => Some(rows.clone()),
                    _ => None,
                };
                let too_big = rows_literal
                    .as_ref()
                    .map(|r| r.to_string().len())
                    .filter(|n| *n > MAX_ROWS_JSON);
                if let Some(size) = too_big {
                    self.diagnostics.push(Diagnostic::fallback(
                        "instance-list-path",
                        format!(
                            "<{name}> has a job of its own and reads the rows of a constant list of {size} bytes, over the {MAX_ROWS_JSON} byte cap"
                        ),
                        *loc,
                        "move the list into a loader (it then comes from props), or keep the page a React island",
                    ));
                }
                let rows_literal = rows_literal.filter(|_| too_big.is_none());
                if child.fed
                    && !row_invariant
                    && rows_literal.is_none()
                    && too_big.is_none()
                    && self.loop_sources.iter().any(Option::is_none)
                {
                    // Fail closed softly (ruling on challenge 4dc45c45, F142): the server feeds a
                    // per-instance job by indexing the list's props path; over a local or store list
                    // there is none, and the build would refuse the page (`manifest.ts`
                    // instance-list-path). Valid React never becomes a build error: an island instead.
                    self.diagnostics.push(Diagnostic::fallback(
                        "instance-list-path",
                        format!(
                            "<{name}> has a job of its own and sits in a list that is not a props path, so the server cannot feed it per row"
                        ),
                        *loc,
                        "map over a list that comes from props (a loader), or keep the page a React island",
                    ));
                }
                if child.fed && !row_invariant && self.loop_sources.len() > 1 {
                    self.diagnostics.push(Diagnostic::fallback(
                        "nested-instance",
                        format!(
                            "<{name}> has a job or useId and sits inside nested lists, which the server cannot feed per row"
                        ),
                        *loc,
                        "flatten the lists or render the child per row in its own component",
                    ));
                }
                if child.fed && !fused && self.own_fed && !self.ctx.is_root {
                    // This component is inlined into its callers and its server instance cannot also feed a
                    // child of its own that was not fused (F53, R34.97).
                    self.diagnostics.push(Diagnostic::fallback(
                        "nested-instance",
                        format!(
                            "<{name}> has a job or useId and sits inside <{}> that has its own, which the server cannot feed through it",
                            self.ctx.path
                        ),
                        *loc,
                        "use it directly in the route component, or keep this component interactive with React",
                    ));
                }
                if child.fed && !fused {
                    let mut record = InstanceRecord {
                        child_id: child_id.clone(),
                        k,
                        // F142 R34.42: the same inputs in every row, so one job call feeds them all.
                        loops: if row_invariant {
                            Vec::new()
                        } else {
                            self.loop_sources.clone()
                        },
                        props: Default::default(),
                        literals: Default::default(),
                        exprs: Default::default(),
                        rows_literal,
                    };
                    let child_name = name.clone();
                    for (name, v) in kept.iter() {
                        // F164: a spread is not an input; `spread_feeds_no_job_input` proved it carries none.
                        if matches!(v, Expr::ClientOnly { .. }) || name == crate::ir::SPREAD_KEY {
                            continue;
                        }
                        // F328: a Provider frame field (`__ctx_*`) the child's job reads nothing of: the child reads it on
                        // the client only, so the server record binds nothing for it.
                        if name.starts_with("__ctx_")
                            && !child.job_all
                            && !child.job_roots.contains(name.as_str())
                        {
                            continue;
                        }
                        // F149 R34.88: folded with this module's consts (`const v = "outline"`).
                        let lit = match v {
                            Expr::Raw(r) | Expr::Server(ServerExpr(r)) => {
                                r.json_literal_ordered().or_else(|| self.fold_ojson(r))
                            }
                            _ => None,
                        };
                        if let Some(p) = self.prop_path(v) {
                            record.props.insert(name.clone(), Some(p));
                        } else if let Some(j) = lit {
                            record.literals.insert(name.clone(), j);
                        } else if let Some(e) = self.instance_expr(v) {
                            record.exprs.insert(name.clone(), e);
                        } else if let Some(seed) = self.state_seed(v).filter(|_| {
                            // ...only for a child that follows the change itself: its chunk recomputes every value its
                            // job derives from props (F337 `recomputes`) and the job is its own (A3).
                            child.recomputes && !fused
                        }) {
                            // F337 (M2, Mellow A5): this component's state, read whole: the server paints it at its
                            // initial value, so the child's job is fed that value (a literal or a props path).
                            match seed {
                                Ok(j) => {
                                    record.literals.insert(name.clone(), j);
                                }
                                Err(p) => {
                                    record.props.insert(name.clone(), Some(p));
                                }
                            }
                        } else {
                            // The manifest has no binding for this value (a job's output, a call): its
                            // `instance-prop-path` build error becomes an island here (F164, R34.97).
                            self.diagnostics.push(Diagnostic::fallback(
                                "instance-prop-path",
                                format!(
                                    "the prop `{name}` of <{child_name}> is not a props path, a literal or a template expression over props, and <{child_name}> has a job or useId the server feeds per instance"
                                ),
                                *loc,
                                "compute it in a loader and pass it as a prop, or keep the page a React island",
                            ));
                            record.props.insert(name.clone(), None);
                        }
                    }
                    // C5: the child's jobs read `__store`; a fed child sits under a chain component
                    // whose props are the ctx, so the path is `__store` itself (else the manifest
                    // refuses the child job's input root as uncovered).
                    if child.stores {
                        record
                            .props
                            .insert("__store".into(), Some("__store".into()));
                    }
                    // A prop the call site does not pass is `undefined` for the child's job, as in
                    // React (a destructuring default applies): an expression the server evaluates to
                    // undefined drops the key. The manifest requires every input root bound.
                    for root in &child.job_roots {
                        if !record.props.contains_key(root)
                            && !record.literals.contains_key(root)
                            && !record.exprs.contains_key(root)
                        {
                            record.exprs.insert(
                                root.clone(),
                                crate::lower::server_expr::UNDEFINED.to_string(),
                            );
                        }
                    }
                    if !self.fold_instance(name, *loc, &child, &record) {
                        self.instances.push(record);
                    }
                }
                // Native / static child (§7.4, F70): see `instance_needs_link`. F277: a prop the child reads only as
                // the first value of a cell nothing sets is read once, when the instance mounts. Where the instance
                // mounts with this component and never again (not under a condition, in a row or in slot content),
                // and the value is the same at every mount of this component, what it becomes later never reaches the
                // child: no link for it.
                let snapshot = if self.guard_depth == 0
                    && self.loop_scope.is_empty()
                    && self.slot_depth == 0
                {
                    child
                        .ir
                        .as_deref()
                        .map(snapshot_only_props)
                        .unwrap_or_default()
                } else {
                    BTreeSet::new()
                };
                // F319 (fail closed): the child reads these props where it would not follow a change. A value that
                // changes here refuses; one of this component's own props passes the requirement up.
                if let Some(c) = child.ir.as_deref() {
                    let named: BTreeSet<&str> = c.props.iter().map(|p| p.name.as_str()).collect();
                    let mut checks: Vec<(&str, &Expr)> = Vec::new();
                    for root in &c.frozen_props {
                        if root == "*" {
                            // The child reads its rest (or its whole props object) where it would not follow a change:
                            // every key that lands there (a spread passed to it is never a named key).
                            for (k, v) in props.iter() {
                                // F329b: a live key its element binds itself (`x-prop-*`) follows the change
                                if self.live_props.iter().any(|f| f.loc == *loc && &f.key == k) {
                                    continue;
                                }
                                if k != "children"
                                    && (c.props_rest.is_none() || !named.contains(k.as_str()))
                                {
                                    checks.push((k.as_str(), v));
                                }
                            }
                            continue;
                        }
                        // The last written key, and any spread after it that may carry the key over it.
                        let last = props.iter().rposition(|(k, _)| k == root);
                        for (i, (k, v)) in props.iter().enumerate() {
                            if Some(i) == last
                                || (k == crate::ir::SPREAD_KEY && last.is_none_or(|l| i > l))
                            {
                                checks.push((root.as_str(), v));
                            }
                        }
                    }
                    // W1d (progress): a function passed for a prop the child's helper call may run (`getValueLabel={fmt}`,
                    // an arrow, an import) is never run by the child's job, which evaluates the module's own default:
                    // refused whatever the value is.
                    for root in &c.callable_props {
                        // A key written at this call site refuses. A spread of this component's own props or rest
                        // (`{...props}` onto the Root) carries whatever ITS callers pass: the requirement moves up
                        // to them (`*`), and the refusal happens at the concrete call site.
                        let mut refuse = false;
                        for (k, v) in props.iter() {
                            if k == crate::ir::SPREAD_KEY {
                                // F347: only the rest or the whole props (an exact `*`) deliver a key under the name its
                                // callers wrote, so the requirement moves up to them. A path (`{...props.cfg}`) delivers
                                // `cfg`'s members, which no caller key names: refused here.
                                let whole = matches!(v, Expr::Raw(r) | Expr::Server(ServerExpr(r))
                                    if crate::analyze::passes::deps::prop_path(r).as_deref() == Some("*"));
                                if matches!(v, Expr::ClientOnly { .. })
                                    || self.reads_state(v)
                                    || self.deps_of(v).props.is_empty()
                                    || !whole
                                {
                                    refuse = true;
                                } else {
                                    self.callable_up.insert(root.clone());
                                }
                            } else if k == root
                                || (root == "*"
                                    && k != "children"
                                    && (c.props_rest.is_none() || !named.contains(k.as_str()))
                                    // a literal (`data-x="1"`) is not a function
                                    && !matches!(v, Expr::Raw(r) | Expr::Server(ServerExpr(r)) if r.json_literal().is_some()))
                            {
                                refuse = true;
                            }
                        }
                        if refuse {
                            self.diagnostics.push(Diagnostic::fallback(
                                "frozen-prop",
                                format!("<{name}> may call a function prop (`{root}`), which a call site passes here; the server evaluates the module's own default, not the function passed"),
                                *loc,
                                "do not pass the function, or keep this component in React",
                            ));
                        }
                    }
                    for (root, v) in checks {
                        // switch-provider-chain PR3 D2: a row value in a list whose rows the client re-creates is a value
                        // that changes too: a new row would keep the first row's value where the child does not follow it.
                        if matches!(v, Expr::ClientOnly { .. })
                            || self.reads_state(v)
                            || (self.rows_recreated() && !self.deps_of(v).loop_bindings.is_empty())
                        {
                            let what = if root == crate::ir::SPREAD_KEY {
                                "a prop spread into it".to_string()
                            } else {
                                format!("its prop `{root}`")
                            };
                            self.diagnostics.push(Diagnostic::fallback(
                                "frozen-prop",
                                format!("<{name}> reads {what} where it would not follow a change (the rows of a list printed once, a prop of a child it does not link, or a key printed once through a spread), and this call site passes a value that changes on the client"),
                                *loc,
                                "pass a value that does not change, or keep this component in React",
                            ));
                        } else {
                            let roots = self.changing_prop_roots(&self.deps_of(v));
                            self.frozen.extend(roots);
                        }
                    }
                }
                // F295: the child prints a value it took at mount where the client never re-applies it. Here it mounts
                // with this component and never again, so this component inherits the promise from its own callers;
                // anywhere else a later mount would print the server's value where React takes the current one.
                if let Some(whats) = child
                    .ir
                    .as_deref()
                    .map(|c| c.mount_once.as_slice())
                    .filter(|w| !w.is_empty())
                {
                    if self.guard_depth == 0 && self.loop_scope.is_empty() && self.slot_depth == 0 {
                        for what in whats {
                            self.add_mount_once(format!("<{name}> → {what}"));
                        }
                    } else {
                        let what = whats.join("; and ");
                        self.diagnostics.push(Diagnostic::fallback(
                            "snapshot-remount",
                            format!("<{name}> → {what}; here <{name}> can mount again after the first paint (under a condition, in a row or in slot content), when React would take the value current then"),
                            *loc,
                            "render it where it mounts once with this component, or keep this component in React",
                        ));
                    }
                }
                let link_props: Vec<(bool, Deps)> = kept
                    .iter()
                    .filter(|(k, v)| !(snapshot.contains(k) && self.same_at_every_mount(v)))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect::<Vec<_>>()
                    .into_iter()
                    .map(|(k, v)| {
                        let d = self.deps_while_mounted(&v, name, &k);
                        self.link_input(&k, &v, d)
                    })
                    .collect();
                let mut need = instance_needs_link(&child.tier, link_props);
                // F300: a snapshot the child takes from a prop of THIS (non-route) component. Where this component
                // mounts again (an `x-if` of its caller re-creates it) the child must start from the props it is
                // given then, which only a link carries (F277 seeds a late host from its parent's current props).
                if need == LinkNeed::None
                    && !self.ctx.is_root
                    && kept.iter().any(|(k, v)| {
                        child
                            .ir
                            .as_deref()
                            .is_some_and(|c| snapshot_only_props(c).contains(k))
                            && !matches!(v, Expr::ClientOnly { .. })
                            && !self.deps_of(v).props.is_empty()
                            && !self.same_at_every_mount(v)
                    })
                {
                    need = LinkNeed::Always;
                }
                // F319: a child this component does not link takes its props once: a prop of this component it is
                // given would not be followed.
                // A prop the child reads only as the first value of a cell nothing sets (F277, F295) is taken once in
                // React too: not frozen.
                if need == LinkNeed::None {
                    let seeds = child
                        .ir
                        .as_deref()
                        .map(snapshot_only_props)
                        .unwrap_or_default();
                    for (k, v) in kept.iter() {
                        if seeds.contains(k) {
                            continue;
                        }
                        let roots = self.changing_prop_roots(&self.deps_of(v));
                        self.frozen.extend(roots);
                    }
                }
                // F337: unless the child's chunk recomputes every such value from its props (`recomputes`), its job is
                // its own, not fused into this component's (Mellow A3), and no function this call site passes feeds that
                // job (the record cannot bind a function: the server would paint without it). A3 is unreachable today
                // (a fused child is refused upstream in every shape the review probed); kept as the stated guard.
                let fn_fed = kept.iter().any(|(k, v)| {
                    matches!(v, Expr::ClientOnly { .. })
                        && (child.job_all || child.job_roots.contains(k.as_str()))
                });
                if need == LinkNeed::Always
                    && child.prop_precompute
                    && !(child.recomputes && !fused && !fn_fed)
                {
                    // Fail closed (F96d): the child computed values from its props once, on the
                    // server; a linked prop that changes would leave them stale with no warning.
                    self.diagnostics.push(linked_prop_precompute(name, *loc));
                }
                if need != LinkNeed::None {
                    // The parent chunk rebuilds the row's `_pN` from the list: it reads the source,
                    // and every prop is a client read. For a `RowOnly` link these reads are
                    // committed only if the link survives `resolve_row_only`.
                    let mut uses: Vec<super::ClientUse> = self.list_uses.clone();
                    let id = self.links.len() as u32 + 1;
                    for (_, v) in props.iter() {
                        let deps = self.deps_of(v);
                        let raw = match v {
                            Expr::Server(ServerExpr(r)) => Some(r.clone()),
                            Expr::Precomputed { slot, .. } => {
                                self.st.slots.get(slot).map(|i| i.raw.clone())
                            }
                            _ => None,
                        };
                        uses.push(super::ClientUse {
                            loc: *loc,
                            deps,
                            what: "a prop of a linked child",
                            raw: raw.map(|r| (r, self.loop_scope.clone())),
                        });
                    }
                    let link_props = props
                        .iter()
                        .map(|(k, v)| (k.clone(), self.link_prop(v)))
                        .collect();
                    self.links.push(ChildLink {
                        id,
                        child: child_id,
                        props_member: format!("_p{id}"),
                        item_scoped: self.loop_scope.clone(),
                        props: link_props,
                    });
                    *link = Some(id);
                    match need {
                        LinkNeed::Always => self.st.client_uses.extend(uses),
                        LinkNeed::RowOnly => {
                            let pc = child.prop_precompute.then(|| (name.clone(), *loc));
                            self.row_only.insert(id, (uses, pc));
                        }
                        LinkNeed::None => unreachable!(),
                    }
                }
            }
        }
        // After this node's own link id: `_pN` follow document order.
        let fed_before = self.instances.len();
        self.slot_depth += 1;
        children.iter_mut().for_each(|c| self.node(c));
        self.slot_depth -= 1;
        if let Some(inner) = &child.inner
            && let Err(why) = self.rebase(inner, props)
        {
            self.diagnostics.push(Diagnostic::fallback(
                "nested-instance",
                format!(
                    "<{name}> contains a child with a job or useId, which the server cannot feed through it: {why}"
                ),
                *loc,
                "use the child directly in the route component, or keep this component interactive with React",
            ));
        }
        if child.has_for && !matches!(child.tier, Tier::React { .. }) && !children.is_empty() {
            self.passes_to_repeater = true;
        }
        // F214: slot content printed under a native child's host element is bound by that host's instance (the runtime
        // binds every directive by the nearest `x-data`), so a directive of THIS component in it would read, call and
        // write the child's members. Directives are owned by the component whose scope resolves their names; until a
        // frame can say otherwise (a native Provider), the only owner of slot content is its caller, and the caller
        // stays on React.
        // F342: the same for a native child whose `...rest` (or whole props) carries the children onto an element of its
        // own: everything a native child prints is under its host.
        let rest_hosts = matches!(child.tier, Tier::Native)
            && child.ir.as_deref().is_some_and(carries_children_by_rest);
        // F342 (Mellow F1): THIS component's own children travel in its rest or props, spread at this call site into a
        // child that hosts what it is given (a native host, or a static child linked here): they reach that host
        // whatever this component is, so it hosts its children too (`hosts_children`, read by its callers' guard).
        if self.spreads_own_children(props)
            && ((!matches!(child.tier, Tier::React { .. }) && (child.hosts_children || rest_hosts))
                || (link.is_some()
                    && matches!(child.tier, Tier::Static)
                    && child
                        .ir
                        .as_deref()
                        .is_some_and(|c| prints_children_slot(c) || carries_children_by_rest(c))))
        {
            self.passes_to_host = true;
        }
        if (child.hosts_children || rest_hosts)
            && !matches!(child.tier, Tier::React { .. })
            && !children.is_empty()
        {
            if children.iter().any(template_reads_children) {
                self.passes_to_host = true;
            }
            if let Some(what) = children.iter().find_map(|c| self.owned_directive(c)) {
                self.want_host(*loc, &child);
                self.diagnostics.push(Diagnostic::fallback(
                    "slot-owner",
                    format!(
                        "the children given to <{name}> contain {what}, and <{name}> prints them inside its own host element, which would bind them to its instance instead of this component's"
                    ),
                    *loc,
                    "move the interactive part into the component that owns its state, or keep this component interactive with React",
                ));
            }
        }
        // F309 (the guard above, for a static child): a static child LINKED here gets a host of its own (`x-data` on its
        // root), and the runtime binds the slot content it prints by that nearest host too (`nearestInstance`), so a
        // directive of this component in it would look for its members in the child and never update. Fail closed.
        if link.is_some()
            && matches!(child.tier, Tier::Static)
            && !children.is_empty()
            && child
                .ir
                .as_deref()
                .is_some_and(|c| prints_children_slot(c) || carries_children_by_rest(c))
            && let Some(what) = children.iter().find_map(|c| self.owned_directive(c))
        {
            self.want_host(*loc, &child);
            self.diagnostics.push(Diagnostic::fallback(
                "slot-owner",
                format!(
                    "the children given to <{name}> contain {what}, and <{name}> is linked here, so it prints them inside a host element of its own, which would bind them to its instance instead of this component's"
                ),
                *loc,
                "move the interactive part into the component that owns its state, or keep this component interactive with React",
            ));
        }
        if child.has_for
            && !matches!(child.tier, Tier::React { .. })
            && self.instances.len() > fed_before
        {
            // Slot content is printed once and pasted per row: a job or `useId` inside it would repeat.
            self.diagnostics.push(Diagnostic::fallback(
                "nested-instance",
                format!(
                    "children with a job or useId are passed to <{name}>, which repeats them in a list"
                ),
                *loc,
                "render the child inside the repeating component, or keep this component interactive with React",
            ));
        }
    }

    /// Fail closed (shadcn S1.4, R34.29/R34.31): a child with a polymorphic tag (`asChild`) is
    /// resolved here, at its call site. No `asChild`, or a literal `false`, prints the host
    /// element. A literal `asChild` with exactly one host-element child whose attributes are
    /// plain values prints that child with the component's attributes merged in. Anything else
    /// (a value the call site cannot see, a component or text child, a handler, a ref, a
    /// stateful component) keeps the caller on React.
    fn check_poly(
        &mut self,
        name: &str,
        props: &[(String, Expr)],
        children: &[Node],
        child: &Child,
        loc: u32,
    ) {
        let Some(poly) = &child.poly else { return };
        if matches!(child.tier, Tier::React { .. }) {
            return;
        }
        let refuse = |rule: &str, why: String, fix: &str| Diagnostic::fallback(rule, why, loc, fix);
        let flag = props
            .iter()
            .rev()
            .find(|(k, _)| k == &poly.flag)
            .map(|(_, v)| v);
        let value = match flag {
            None => Some(false),
            Some(Expr::Raw(r)) | Some(Expr::Server(ServerExpr(r))) => match r.json_literal() {
                Some(serde_json::Value::Bool(b)) => Some(b),
                _ => None,
            },
            Some(_) => None,
        };
        let spreads_in = props.iter().any(|(k, _)| k == crate::ir::SPREAD_KEY);
        // F153c: absent (or a literal false) while this component's own props are spread in is the host element,
        // provided this component's call sites leave the flag out too.
        if spreads_in
            && value == Some(false)
            && !poly.negate
            && self.spread_carries(&poly.flag, props).is_ok()
        {
            let flag = poly.flag.clone();
            // F369a: recognised as a carrier only when nothing can stop the flag on the way: this is the one, unconditional
            // polymorphic child; the spread is this component's whole rest (not a path, not a clone input, not the flag
            // named); the flag is not written on the call; the element has no runtime spread of keys of its own.
            let whole_rest = props.iter().all(|(k, v)| {
                k != crate::ir::SPREAD_KEY
                    || matches!(v, Expr::Raw(r) | Expr::Server(ServerExpr(r)) if matches!(&r.kind,
                        RawKind::Ident { name, kind: IdentKind::Prop } if name == "*" || name == crate::ir::REST_PROPS))
            }) && !props.iter().any(|(k, _)| k == REST_INPUT || k == &poly.flag);
            // the child's children are the rest's (`children` in it): children written between its tags are the Slot's
            // content instead, and React clones THAT element, not the caller's
            // (A member read of the flag inside a carrier, `rest.asChild`, is allowed on purpose: the flag still reaches the
            // child through the spread. The list and whole-rest guards below are defence in depth: a list child or a
            // path spread is refused earlier, so no fixture reaches them alone.)
            let carrier = whole_rest
                && children.is_empty()
                && self.guard_depth == 0
                && self.loop_scope.is_empty()
                && !self.own_named.contains(&flag)
                && !self.ctx.is_root
                && !child.poly_runtime_spread
                && self.spread_sources(&flag, props) == Ok((true, false));
            self.carry_sites.push((poly.clone(), carrier));
            self.require_absent(name, &flag, props, loc);
            return;
        }
        let Some(value) = value.filter(|_| !spreads_in) else {
            self.diagnostics.push(refuse(
                "slot-dynamic",
                format!(
                    "`{}` of <{name}> is not a literal (or props are spread in), so brust cannot tell which element it renders",
                    poly.flag
                ),
                "write the prop as a literal (`asChild` or `asChild={false}`), or keep the page on React",
            ));
            return;
        };
        if value == poly.negate {
            return; // the host element
        }
        // Q5 (R34.117): a native CONSUMER of the Provider this clone was specialised for may be `asChild`: its host
        // is the child element, and everything it binds is the frame's members, fed as hidden `__ctx_` props whose
        // values are the clone's own (the frames pass already refused an outer Provider's frame, A1/A2). A
        // component with state of its own, one outside a clone, or one with no frame member is not.
        let is_frame = |k: &str| k.starts_with("__ctx_");
        let owned_consumer = self.ctx.specialised
            && matches!(child.tier, Tier::Native)
            && props.iter().any(|(k, _)| is_frame(k))
            && child.ir.as_ref().is_some_and(|ir| {
                ir.state.is_empty() && ir.refs.is_empty() && ir.effects.is_empty()
            });
        if !matches!(child.tier, Tier::Static) && !owned_consumer {
            // Not inside a Provider's clone, and not a consumer of a frame: those keep the Q5 limits (A1).
            if matches!(
                children,
                [Node::Element { poly: false, .. } | Node::Component { .. }]
            ) && !self.ctx.specialised
                && !props.iter().any(|(k, _)| is_frame(k))
            {
                self.want_host_poly(loc, child);
            }
            self.diagnostics.push(refuse(
                "slot-native",
                format!(
                    "<{name}> has state of its own and is rendered with `{}`",
                    poly.flag
                ),
                "use `asChild` on a component without state, or keep the page on React",
            ));
            return;
        }
        if props
            .iter()
            .any(|(k, v)| matches!(v, Expr::ClientOnly { .. }) && !is_frame(k))
        {
            self.diagnostics.push(refuse(
                "slot-handler",
                format!("a function is passed to <{name}> with `{}`", poly.flag),
                "put the handler on the child element after the component is static, or keep the page on React",
            ));
            return;
        }
        let [only] = children else {
            self.diagnostics.push(refuse(
                "slot-child-shape",
                format!(
                    "`{}` on <{name}> needs exactly one element between the tags, found {}",
                    poly.flag,
                    children.len()
                ),
                "wrap the content in one element such as <a>",
            ));
            return;
        };
        if let Node::Component {
            loc: cloc,
            name: cname,
            source,
            imported,
            member,
            props: cprops,
            link,
            forwarded_ref,
            ..
        } = only
        {
            self.check_poly_component(
                name,
                child,
                loc,
                (cname, source, imported, member, *cloc),
                (cprops, link.is_some(), *forwarded_ref),
            );
            return;
        }
        let Node::Element {
            tag: child_tag,
            attrs,
            poly: nested,
            ..
        } = only
        else {
            let (rule, what) = ("slot-child-shape", "text or an expression");
            self.diagnostics.push(refuse(
                rule,
                format!(
                    "`{}` on <{name}> has {what} as its child; only one host element is supported",
                    poly.flag
                ),
                "pass a host element such as <a href=\"…\">",
            ));
            return;
        };
        // A raw-text body (`<style>`, `<script>`) is printed as text, not as markup.
        if matches!(child_tag.as_str(), "style" | "script") {
            self.diagnostics.push(refuse(
                "slot-child-shape",
                format!(
                    "the child of <{name}> with `{}` is a <{child_tag}> element",
                    poly.flag
                ),
                "pass an element such as <a>, or keep the page on React",
            ));
            return;
        }
        // The component spreads keys known only at render and the child brings a class or style: the
        // merge needs both sides at compile time (valid React never becomes a build error).
        let brings_merge_key = attrs.iter().any(|a| match a {
            Attr::Static { name, .. } | Attr::Dynamic { name, .. } => {
                matches!(
                    name.to_ascii_lowercase().as_str(),
                    "class" | "classname" | "style"
                )
            }
            _ => false,
        });
        if child.poly_runtime_spread && brings_merge_key {
            self.diagnostics.push(refuse(
                "slot-merge",
                format!(
                    "<{name}> spreads an object of keys known only at render, and the child under `{}` has a class or style that would merge with it",
                    poly.flag
                ),
                "move the class or style to the component call, or keep the page on React",
            ));
            return;
        }
        let bad = attrs.iter().find_map(|a| match a {
            Attr::Static { .. } | Attr::ForwardRef => None,
            Attr::Dynamic { value, .. } => self
                .reads_state(value)
                .then_some(("slot-child-attr", "an attribute that changes on the client")),
            Attr::Event { .. } => Some(("slot-handler", "an event handler")),
            Attr::CollectionItem { .. } => Some(("slot-child-shape", "a collection item")),
            Attr::Ref { .. } => Some(("slot-ref", "a ref")),
            Attr::Spread(_) | Attr::InnerHtml { .. } => {
                Some(("slot-child-shape", "a spread or dangerouslySetInnerHTML"))
            }
        });
        if let Some((rule, what)) =
            bad.or((*nested).then_some(("slot-child-shape", "a polymorphic element")))
        {
            self.diagnostics.push(refuse(
                rule,
                format!("the child of <{name}> with `{}` has {what}", poly.flag),
                "give the child plain attributes, or keep the page on React",
            ));
        }
    }

    /// F363a: `asChild` of a static component over ONE static component. React's Slot hands the component's element
    /// attributes to the child as PROPS (`cloneElement`, `className` joined), so the child prints them wherever it spreads
    /// its props; brust passes them the same way at the call site. Anything the merge cannot be proved for keeps the
    /// caller on React (`slot-child-component`, or the merge rules' own codes).
    fn check_poly_component(
        &mut self,
        name: &str,
        parent: &Child,
        loc: u32,
        (cname, source, imported, member, cloc): (
            &String,
            &Option<String>,
            &Option<String>,
            &Vec<String>,
            u32,
        ),
        (cprops, linked, forwarded_ref): (&[(String, Expr)], bool, bool),
    ) {
        let Some(poly) = &parent.poly else { return };
        let cc = self.resolve_child(cname, source.as_deref(), imported.as_deref(), member, cloc);
        let refuse = |rule: &str, why: String, fix: &str| Diagnostic::fallback(rule, why, loc, fix);
        let attrs = parent
            .ir
            .clone()
            .and_then(|ir| self.poly_attrs_through(&ir, 4));
        let why = if !matches!(cc.tier, Tier::Static) {
            Some("it is not a static component (a React island, or one with state of its own)")
        } else if cc.poly.is_some() || cc.fed || cc.use_id || linked /* a link needs a native child: no fixture, defence */ || forwarded_ref
        {
            Some("it is polymorphic itself, has a job or `useId`, or takes a ref")
        } else if !cc.absent.is_empty() // fixture: Carry
            // The five below have no fixture: a Static child cannot reach them (they need a native, live or fed-through-spread
            // shape, which the tier guard refuses first); kept as fail-closed defence.
            || !cc.unwritten.is_empty() // a spread into a fed child (needs a job)
            || !cc.shadowed.is_empty() // a live value bound ahead of the rest (native)
            || !cc.shadowed_input.is_empty() // the same through a clone's hidden rest (native)
            || cc.rest_as_data // the whole rest handed to a clone as data (native)
            // children printed under a native host
            || cc.hosts_children
        {
            Some("it puts requirements on the props it is given")
        } else if !cc.spread.lands("data-slot")
            || !cc.ir.as_deref().is_some_and(|ir| {
                matches!(
                    ir.template,
                    Node::Element {
                        synthetic: false,
                        ..
                    }
                )
            })
        {
            Some("it does not spread its props onto the one element it renders")
        } else if attrs.as_deref().is_none_or(|a| {
            a.iter().any(|a| {
                !matches!(
                    a,
                    Attr::Static { .. } | Attr::Dynamic { .. } | Attr::Spread(_)
                )
            })
        }) {
            Some("the element it replaces carries a handler, a ref or other directive")
        } else {
            None
        };
        if let Some(why) = why {
            self.diagnostics.push(refuse(
                "slot-child-component",
                format!(
                    "`{}` on <{name}> has the component <{cname}> as its child, and {why}; only a static component that spreads its props onto one element is supported",
                    poly.flag
                ),
                "pass a host element such as <a href=\"…\">, or keep the page on React",
            ));
            return;
        }
        // What the child is given must be values: no function, no live value, no ref, no spread (a key the merge cannot see).
        let bad = cprops.iter().find_map(|(k, v)| {
            if matches!(v, Expr::ClientOnly { .. }) {
                Some(("slot-handler", "a function"))
            } else if k == crate::ir::SPREAD_KEY || k == REST_INPUT {
                Some(("slot-child-shape", "a spread"))
            } else if k == "ref" || k == "key" || k == crate::ir::COLLECTION_ITEM_PROP {
                Some(("slot-ref", "a ref, a key or a collection item"))
            } else if self.reads_state(v) {
                Some(("slot-child-attr", "a prop that changes on the client"))
            } else {
                None
            }
        });
        if let Some((rule, what)) = bad {
            self.diagnostics.push(refuse(
                rule,
                format!(
                    "the child <{cname}> of <{name}> with `{}` is given {what}",
                    poly.flag
                ),
                "give the child plain props, or keep the page on React",
            ));
            return;
        }
        // The merge joins `className` and needs both sides at compile time; `style` is not merged at all.
        let brings = |keys: &[&str]| {
            cprops
                .iter()
                .any(|(k, _)| keys.contains(&k.to_ascii_lowercase().as_str()))
        };
        if brings(&["style"]) || (parent.poly_runtime_spread && brings(&["class", "classname"])) {
            self.diagnostics.push(refuse(
                "slot-merge",
                format!(
                    "<{name}> spreads an object of keys known only at render, or the child <{cname}> under `{}` brings a style, which would merge with it",
                    poly.flag
                ),
                "move the class or style to the component call, or keep the page on React",
            ));
        }
    }

    /// The attributes of the element `asChild` replaces in `ir`: its own polymorphic element, or (a carrier, F369a) the one in the
    /// polymorphic child it hands its whole rest to, after inlining. `depth` bounds the chain.
    fn poly_attrs_through(&mut self, ir: &ComponentIR, depth: u32) -> Option<Vec<Attr>> {
        if let Some(a) = poly_element_attrs(&ir.template) {
            return Some(a.to_vec());
        }
        if depth == 0 {
            return None;
        }
        let (cname, source, imported, member, cloc) = carrier_call(&ir.template)?;
        let cc = self.resolve_child(
            &cname,
            source.as_deref(),
            imported.as_deref(),
            &member,
            cloc,
        );
        let inner = cc.ir.clone()?;
        cc.poly.as_ref()?;
        self.poly_attrs_through(&inner, depth - 1)
    }

    /// `r` folded to JSON with this module's consts (`crate::ir::FoldEnv`, which runs no user code).
    fn fold_ojson(&self, r: &RawExpr) -> Option<crate::ir::OJson> {
        let consts = self.module_consts.clone();
        let lookup = move |n: &str| consts.get(n).cloned();
        crate::ir::FoldEnv::new(&lookup).fold(r).ok()?.to_ojson()
    }

    fn fold_json(&self, r: &RawExpr) -> Option<serde_json::Value> {
        let consts = self.module_consts.clone();
        let lookup = move |n: &str| consts.get(n).cloned();
        crate::ir::FoldEnv::new(&lookup).fold(r).ok()?.to_json()
    }

    /// F149 (R34.88-R34.90): a static instance whose job inputs are all constant, of a child whose
    /// job the build may run, is a build-evaluation candidate; in the recompile, with every output
    /// evaluated, it is folded (`true`: its record is dropped and its slots print as literals).
    fn fold_instance(
        &mut self,
        name: &str,
        loc: u32,
        child: &Child,
        record: &InstanceRecord,
    ) -> bool {
        let Some(verdict) = &child.job_eval else {
            return false;
        };
        let constant = record.loops.is_empty()
            && record.rows_literal.is_none()
            && record.props.is_empty()
            && record
                .exprs
                .values()
                .all(|e| e == crate::lower::server_expr::UNDEFINED);
        if !constant {
            return false;
        }
        let stubs = match verdict {
            Ok(stubs) => stubs.clone(),
            Err(why) => {
                self.diagnostics.push(Diagnostic::info(
                    "build-eval-instance",
                    format!("<{name}> keeps its per-request job: {why}"),
                    loc,
                    "only constants and the packages cn, clsx, tailwind-merge and class-variance-authority run at build",
                ));
                return false;
            }
        };
        let key = format!("{}@{}", self.ctx.path, loc);
        let values: Option<std::collections::BTreeMap<String, serde_json::Value>> = child
            .job_outputs
            .iter()
            .map(|o| {
                let v = self.ctx.opts.slot_values.get(&format!("{key}#{o}"))?;
                Some((o.clone(), v.clone()))
            })
            .collect();
        if let Some(values) = values.filter(|v| !v.is_empty()) {
            self.folded_instances.push(crate::ir::FoldedInstance {
                child_id: record.child_id.clone(),
                k: record.k,
                values,
            });
            return true;
        }
        let (line, col) = crate::ir::line_col(self.ctx.text, loc);
        self.eval_instances.push(crate::ir::BuildEvalInstance {
            key,
            child_id: record.child_id.clone(),
            k: record.k,
            inputs: crate::ir::OJson::Obj(
                record
                    .literals
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect(),
            ),
            outputs: child.job_outputs.clone(),
            stubs,
            fused: child.job_fused.clone(),
            line,
            col,
        });
        false
    }

    /// Shadcn S1 (R34.21): the JSX children of a React island as a JSON tree, so they travel in its
    /// props (the island and its SSR job revive them with React). Only a constant tree lowers; the
    /// `Err` names what stopped it (R34.23). Also returns the ids of the components inside the tree.
    /// Lists, constant conditions and element-valued props lower too (R34.50-R34.52): the constants
    /// are folded by [`crate::ir::FoldEnv`], which never runs user code.
    fn lower_children(
        &mut self,
        nodes: &[Node],
    ) -> Result<(serde_json::Value, Vec<String>), String> {
        let consts = self.module_consts.clone();
        let lookup = move |n: &str| consts.get(n).cloned();
        let mut env = crate::ir::FoldEnv::new(&lookup);
        let mut nested = Vec::new();
        let mut bytes = 0usize;
        let mut items = self.lower_nodes(nodes, &mut nested, &mut env, &mut bytes, 0)?;
        let tree = if items.len() == 1 {
            items.remove(0)
        } else {
            serde_json::Value::Array(items)
        };
        let size = tree.to_string().len();
        if size > MAX_CHILDREN_JSON {
            return Err(format!(
                "the lowered tree is {size} bytes, over the {MAX_CHILDREN_JSON} byte cap"
            ));
        }
        nested.sort();
        nested.dedup();
        Ok((tree, nested))
    }

    /// The ids inside a lowered tree the island `name` revives (`ChildRef.nested`).
    fn note_nested(&mut self, name: &str, nested: Vec<String>) {
        if let Some(r) = self.refs.iter_mut().find(|r| r.name == name) {
            let all = r.nested.get_or_insert_with(Vec::new);
            for id in nested {
                if !all.contains(&id) {
                    all.push(id);
                }
            }
        }
    }

    /// F148a (R34.116-R34.120): the island prop that carries a value the lowered tree reads from this
    /// component's own props, and the marker node name for it. `element` is `{children}`: the caller's
    /// constant tree (`$c<N>`, bound by the call site as the prop `__ch`); otherwise a plain props path of
    /// a named prop (`$p<N>`), which the revive renders only when it is a primitive. `Err` is the reason
    /// the value cannot be a hole.
    fn add_hole(&mut self, e: &Expr, element: bool) -> Result<String, String> {
        let Some(n) = self.holes.as_ref().map(Vec::len) else {
            return Err("props are not available here".into());
        };
        let loc = self.raw_of(e).map(|r| r.loc).unwrap_or(0);
        // The same value read twice is one hole.
        if let Some(prefix) = self
            .holes
            .as_ref()
            .map(|_| if element { "$c" } else { "$p" })
        {
            let want = if element {
                Some(CH_PROP.to_string())
            } else {
                self.prop_path(e)
            };
            if want.is_some() {
                let same = self.holes.as_ref().into_iter().flatten().find(|(k, x)| {
                    k.starts_with(prefix)
                        && match x {
                            Expr::Raw(r) | Expr::Server(ServerExpr(r)) => match &r.kind {
                                RawKind::Ident { name, .. } if element => name == CH_PROP,
                                _ => !element && self.prop_path(x) == want,
                            },
                            _ => false,
                        }
                });
                if let Some((k, _)) = same {
                    return Ok(k.clone());
                }
            }
        }
        if n >= MAX_HOLES {
            return Err(format!("more than {MAX_HOLES} values read from props"));
        }
        let (key, expr) = if element {
            // The caller's tree is a compile-time constant bound by the wrapper's call site. A route
            // component has no call site: its props are request data (R34.69), so it never has one.
            let route_file = self.ctx.opts.route_roots.iter().any(|p| p == self.ctx.path);
            if self.ctx.is_root || route_file {
                return Err("`children` of a route component is request data, not a tree".into());
            }
            let raw = RawExpr {
                loc,
                kind: RawKind::Ident {
                    name: CH_PROP.into(),
                    kind: IdentKind::Prop,
                },
            };
            (format!("$c{n}"), Expr::Server(ServerExpr(raw)))
        } else {
            if self.deps_of(e).reactive() {
                return Err("it reads state or a store".into());
            }
            let Some(path) = self.prop_path(e) else {
                return Err("it is not a plain props path".into());
            };
            let root = path.split('.').next().unwrap_or("");
            if path.contains("[idx]") || !self.own_named.contains(root) {
                return Err("it is not a named prop of this component".into());
            }
            (format!("$p{n}"), e.clone())
        };
        if let Some(h) = self.holes.as_mut() {
            h.push((key.clone(), expr));
        }
        Ok(key)
    }

    /// `e` is the bare `{children}` prop of this component.
    fn is_children_prop(&self, e: &Expr) -> bool {
        matches!(
            self.raw_of(e),
            Some(RawExpr { kind: RawKind::Ident { name, kind: IdentKind::Prop }, .. }) if name == "children"
        )
    }

    /// The expression as the folder reads it: a slot reads back as the expression it came from.
    fn raw_of(&self, e: &Expr) -> Option<RawExpr> {
        match e {
            Expr::Raw(r) | Expr::Server(ServerExpr(r)) => Some(r.clone()),
            Expr::Precomputed { slot, .. } => self.st.slots.get(slot).map(|s| s.raw.clone()),
            _ => None,
        }
    }

    fn fold_expr(
        &self,
        e: &Expr,
        env: &mut crate::ir::FoldEnv<'_>,
    ) -> Result<crate::ir::V, String> {
        match self.raw_of(e) {
            Some(r) => env.fold(&r),
            None if matches!(e, Expr::ClientOnly { .. }) => Err("a function".into()),
            None => Err("a value computed at request time".into()),
        }
    }

    fn lower_nodes(
        &mut self,
        nodes: &[Node],
        nested: &mut Vec<String>,
        env: &mut crate::ir::FoldEnv<'_>,
        bytes: &mut usize,
        lists: u32,
    ) -> Result<Vec<serde_json::Value>, String> {
        use crate::ir::V;
        use serde_json::{Map, Value, json};
        let mut out = Vec::new();
        for n in nodes {
            match n {
                Node::Text(t) => out.push(Value::String(t.clone())),
                Node::Slot(e) => match self.fold_expr(e, env) {
                    Ok(v @ (V::Str(_) | V::Num(_))) => match v.to_json() {
                        Some(j) => out.push(j),
                        None => return Err("a number that is not finite".into()),
                    },
                    Ok(V::Undef | V::Null | V::Bool(_)) => {}
                    Ok(_) => return Err("an array or object rendered as a child".into()),
                    Err(why) => {
                        // F148a: `{children}` is the caller's constant tree; any other plain props path
                        // is a value the revive renders as a primitive (R34.116, R34.117).
                        if self.holes.is_some() {
                            let element = self.is_children_prop(e);
                            match self.add_hole(e, element) {
                                Ok(key) => {
                                    let kind = if element { "slot" } else { "v" };
                                    out.push(json!({ MARK: kind, "k": key }));
                                    continue;
                                }
                                Err(r) => {
                                    return Err(format!(
                                        "an expression that is not a constant ({why}; not a hole: {r})"
                                    ));
                                }
                            }
                        }
                        return Err(format!("an expression that is not a constant ({why})"));
                    }
                },
                Node::Fragment(c) => out.push(
                    json!({ MARK: "fr", "c": self.lower_nodes(c, nested, env, bytes, lists)? }),
                ),
                Node::Element {
                    tag,
                    attrs,
                    children,
                    ..
                } => {
                    if !tag.starts_with(|c: char| c.is_ascii_alphabetic())
                        || !tag.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                    {
                        return Err(format!("`<{tag}>` is not a plain element name"));
                    }
                    let mut p = Map::new();
                    for a in attrs {
                        match a {
                            Attr::ForwardRef => {}
                            Attr::CollectionItem { .. } => {
                                return Err(
                                    "a collection item (its data is read on the client)".into()
                                );
                            }
                            Attr::Static { name, value } if value.is_empty() => {
                                if !BOOLEAN_ATTRS.contains(&name.as_str()) {
                                    return Err(format!(
                                        "`{name}` is a bare or empty attribute (React reads it as `true` or \"\" by name)"
                                    ));
                                }
                                p.insert(name.clone(), Value::Bool(true));
                            }
                            Attr::Static { name, value } => {
                                p.insert(name.clone(), Value::String(value.clone()));
                            }
                            Attr::Dynamic { name, value } => match self.fold_expr(value, env) {
                                Ok(V::Null | V::Undef) => {}
                                Ok(v) => match v.to_json() {
                                    Some(j) if marker_free(&j) => {
                                        p.insert(name.clone(), j);
                                    }
                                    Some(_) => {
                                        return Err(format!(
                                            "attribute `{name}` holds the key `{MARK}`, which brust reserves"
                                        ));
                                    }
                                    None => {
                                        return Err(format!(
                                            "attribute `{name}` is not a constant (a value JSON cannot hold)"
                                        ));
                                    }
                                },
                                Err(why) => {
                                    if self.holes.is_some() {
                                        if !hole_name_ok(name) {
                                            return Err(format!(
                                                "attribute `{name}` is not a constant ({why}; not a hole: `{name}` cannot take a value from props)"
                                            ));
                                        }
                                        match self.add_hole(value, false) {
                                            Ok(key) => {
                                                p.insert(
                                                    name.clone(),
                                                    json!({ MARK: "v", "k": key }),
                                                );
                                                continue;
                                            }
                                            Err(r) => {
                                                return Err(format!(
                                                    "attribute `{name}` is not a constant ({why}; not a hole: {r})"
                                                ));
                                            }
                                        }
                                    }
                                    return Err(format!(
                                        "attribute `{name}` is not a constant ({why})"
                                    ));
                                }
                            },
                            Attr::Event { event, .. } => {
                                return Err(format!("an event handler (`{event}`)"));
                            }
                            Attr::Ref { .. } => return Err("a ref".into()),
                            Attr::Spread(_) => return Err("a spread".into()),
                            Attr::InnerHtml { .. } => {
                                return Err("dangerouslySetInnerHTML".into());
                            }
                        }
                    }
                    out.push(
                        json!({ MARK: "el", "t": tag, "p": p, "c": self.lower_nodes(children, nested, env, bytes, lists)? }),
                    );
                }
                Node::Component {
                    loc,
                    name,
                    source,
                    imported,
                    member,
                    props,
                    children,
                    ..
                } => {
                    if name == "<member>" {
                        return Err("a member tag such as <A.B>".into());
                    }
                    let mut p = Map::new();
                    let mut slots: Vec<String> = Vec::new();
                    for (k, v) in props {
                        if k == crate::ir::SPREAD_KEY {
                            return Err(format!("a spread into <{name}>"));
                        }
                        if k.starts_with('$') {
                            return Err(format!(
                                "the prop `{k}` of <{name}> starts with `$`, which brust reserves"
                            ));
                        }
                        // An element as a prop (R34.52): lowered to a marker tree and named in `x`,
                        // the only list of props the revive turns back into elements.
                        if let Expr::Raw(RawExpr {
                            kind: RawKind::Jsx(el),
                            ..
                        }) = v
                        {
                            if !slot_prop_ok(k) {
                                return Err(format!(
                                    "an element passed as the prop `{k}` of <{name}>"
                                ));
                            }
                            let mut items = self.lower_nodes(
                                std::slice::from_ref(&**el),
                                nested,
                                env,
                                bytes,
                                lists,
                            )?;
                            let tree = if items.len() == 1 {
                                items.remove(0)
                            } else {
                                json!({ MARK: "fr", "c": items })
                            };
                            p.insert(k.clone(), tree);
                            slots.push(k.clone());
                            continue;
                        }
                        match self.fold_expr(v, env) {
                            Ok(V::Null | V::Undef) => {}
                            Ok(v) => match v.to_json() {
                                Some(j) if marker_free(&j) => {
                                    p.insert(k.clone(), j);
                                }
                                Some(_) => {
                                    return Err(format!(
                                        "prop `{k}` of <{name}> holds the key `{MARK}`, which brust reserves"
                                    ));
                                }
                                None => {
                                    return Err(format!(
                                        "prop `{k}` of <{name}> is not a constant (a value JSON cannot hold)"
                                    ));
                                }
                            },
                            Err(why) => {
                                if self.holes.is_some() {
                                    if !hole_name_ok(k) {
                                        return Err(format!(
                                            "prop `{k}` of <{name}> is not a constant ({why}; not a hole: `{k}` cannot take a value from props)"
                                        ));
                                    }
                                    match self.add_hole(v, false) {
                                        Ok(key) => {
                                            p.insert(k.clone(), json!({ MARK: "v", "k": key }));
                                            continue;
                                        }
                                        Err(r) => {
                                            return Err(format!(
                                                "prop `{k}` of <{name}> is not a constant ({why}; not a hole: {r})"
                                            ));
                                        }
                                    }
                                }
                                return Err(format!(
                                    "prop `{k}` of <{name}> is not a constant ({why})"
                                ));
                            }
                        }
                    }
                    let child = self.resolve_child(
                        name,
                        source.as_deref(),
                        imported.as_deref(),
                        member,
                        *loc,
                    );
                    let Some(id) = child.id.clone() else {
                        return Err(format!("<{name}> could not be resolved"));
                    };
                    if !self.refs.iter().any(|r| r.name == *name) {
                        self.refs.push(ChildRef {
                            name: name.clone(),
                            id: child.id.clone(),
                            path: child.path.clone(),
                            tier: child.tier.clone(),
                            nested: None,
                            x: Vec::new(),
                            holes: Vec::new(),
                        });
                    }
                    nested.push(id.clone());
                    let mut node = json!({ MARK: "cmp", "id": id, "p": p, "c": self.lower_nodes(children, nested, env, bytes, lists)? });
                    if !slots.is_empty() {
                        node["x"] = json!(slots);
                    }
                    out.push(node);
                }
                Node::If {
                    cond,
                    then,
                    else_,
                    and,
                } => {
                    match self.fold_expr(cond, env) {
                        Ok(c) => {
                            let branch = if c.truthy() { then } else { else_ };
                            out.extend(self.lower_nodes(branch, nested, env, bytes, lists)?);
                        }
                        Err(why) => {
                            // F148a (R34.122): a condition over a plain prop is a marker node; the revive takes
                            // the branch by the truthiness of a primitive.
                            let key = if self.holes.is_some() {
                                self.add_hole(cond, false).map_err(|r| {
                                format!("a condition that is not a constant ({why}; not a hole: {r})")
                            })?
                            } else {
                                return Err(format!("a condition that is not a constant ({why})"));
                            };
                            let yes = self.lower_nodes(then, nested, env, bytes, lists)?;
                            let no = self.lower_nodes(else_, nested, env, bytes, lists)?;
                            let mut node = json!({ MARK: "if", "k": key, "c": yes, "e": no });
                            // `cond && <X/>`: React renders a falsy number (0) as text there (unless the else branch
                            // already prints `cond`, F388).
                            if *and && else_.is_empty() {
                                node["a"] = json!(true);
                            }
                            out.push(node);
                        }
                    }
                }
                Node::For {
                    source,
                    item,
                    index,
                    key,
                    body,
                } => {
                    let src = self.fold_expr(source, env).map_err(|why| {
                        format!("a list over data that is not a constant ({why})")
                    })?;
                    let V::Arr(rows) = src else {
                        return Err("a list over a value that is not an array".into());
                    };
                    let count = rows.len();
                    for (i, row) in rows.into_iter().enumerate() {
                        env.bind(item, row);
                        let mut bound = 1;
                        if let Some(ix) = index {
                            env.bind(ix, V::Num(i as f64));
                            bound += 1;
                        }
                        let step = self
                            .fold_expr(key, env)
                            .map_err(|why| {
                                format!("the key of a list item is not a constant ({why})")
                            })
                            .and_then(|_| self.lower_nodes(body, nested, env, bytes, lists + 1));
                        env.unbind(bound);
                        let rows_out = step?;
                        if lists == 0 {
                            *bytes += rows_out.iter().map(|v| v.to_string().len()).sum::<usize>();
                            if *bytes > MAX_CHILDREN_JSON {
                                return Err(format!(
                                    "the list has {count} items and its lowered tree is over the {MAX_CHILDREN_JSON} byte cap"
                                ));
                            }
                        }
                        out.extend(rows_out);
                    }
                }
                Node::Outlet => return Err("<Outlet/>".into()),
            }
        }
        Ok(out)
    }

    /// A fed instance inside lists whose job inputs are the same in every row (F142, R34.42): no
    /// prop reads a loop binding, the child has no `useId` values (ids differ per row) and its
    /// jobs do not read `children`, and every list that is not a props path cannot change on the
    /// client (rows the client re-creates would get no job output). A precompute job is a function
    /// of its inputs (the job cache's contract: its key is the inputs), so one call feeds every row.
    fn row_invariant(&self, props: &[(String, Expr)], child: &Child) -> bool {
        if self.loop_sources.is_empty() || child.use_id || child.job_roots.contains("children") {
            return false;
        }
        let row_free = props.iter().all(|(_, v)| {
            !matches!(v, Expr::ClientOnly { .. }) && self.deps_of(v).loop_bindings.is_empty()
        });
        row_free && !self.rows_recreated()
    }

    /// The enclosing lists may re-create their rows on the client (a list from state, or from props that change): a row
    /// made there starts from the row template, with what each instance in it was given at the first paint.
    fn rows_recreated(&self) -> bool {
        !self
            .loop_sources
            .iter()
            .zip(&self.lists)
            .all(|(path, (paths, reactive))| {
                path.is_some() || !(*reactive || (!paths.is_empty() && self.props_reactive))
            })
    }

    /// Live values the parent binds itself (2b-handlers, R34.18 extended): a prop that reads state and lands in a
    /// static child's spread is, like a hoisted handler, an attribute of the child's element written in the
    /// parent's scope (`ComponentIR::live_forwards`); the child then has nothing live left and stays unlinked.
    /// Everything a spread could disagree about fails closed, each key on its own (`check_spread` refuses it with its
    /// own message): the child is not static, the key is not an attribute a hand-written element would bind
    /// (C3), the child reads it elsewhere or reads its rest as a value or spreads it more than once (C2), or a later
    /// spread may replace it and is not this component's own rest (C1). A later spread of this component's own rest
    /// carries exactly the keys a call site writes, so the requirement moves to the call sites: none may write the
    /// key (`shadowed_props`), which the one shared chunk could not honour per instance.
    fn forward_live(
        &mut self,
        name: &str,
        loc: u32,
        props: &[(String, Expr)],
        child: &Child,
        ref_fwd: bool,
    ) -> Vec<String> {
        let mut live: Vec<String> = Vec::new();
        let mut cands: Vec<(String, (bool, bool))> = Vec::new();
        if !matches!(child.tier, Tier::Static) {
            return live;
        }
        for (i, (k, v)) in props.iter().enumerate() {
            if k == crate::ir::SPREAD_KEY
                || matches!(v, Expr::ClientOnly { .. })
                || cands.iter().any(|(c, _)| c == k)
                || !child.spread.lands(k)
                // F320: a prop that changes is as live as state here (it is forwarded, not printed once). A context
                // value (`__ctx_*`) too: the frame resolves it in this component's scope, where the parent binds it.
                || !(self.live(v) || reads_ctx(&self.deps_of(v)))
                || !(live_key_ok(k) || self.snapshot_key_ok(k, v))
                // F296 C1 / F299: a Slot merges the call site's `style` and `className` with its child's.
                || (matches!(k.as_str(), "style" | "class" | "className")
                    && self.style_may_merge(props, child))
                || child.onward.spread_sites != 1
                || child.onward.components.lands(k)
                || child
                    .onward
                    .reads
                    .as_ref()
                    .is_none_or(|r| r.contains(k.as_str()))
                // The last write of the key is the one React uses.
                || props[i + 1..].iter().any(|(o, _)| o == k)
            {
                continue;
            }
            // Spreads after the key may replace it.
            let later: Vec<(String, Expr)> = props[i + 1..]
                .iter()
                .filter(|(o, _)| o == crate::ir::SPREAD_KEY)
                .cloned()
                .collect();
            let mut shadow = (false, false);
            if !later.is_empty() {
                match self.spread_sources(k, &later) {
                    Ok((false, false)) => {}
                    Ok(src) if !self.ctx.is_root => shadow = src,
                    _ => continue,
                }
            }
            cands.push((k.clone(), shadow));
        }
        // The parent binds these on the child's element in ITS scope. If the instance is linked anyway (another prop of
        // it, bound by name or read from a row, is live), that element is the child's host and the directives would
        // resolve in the child's scope: bind nothing, and refuse as before (2b-handlers review F1, C7). Handlers are
        // either hoisted (no link) or refused, so they do not count here.
        let keys: Vec<&String> = cands.iter().map(|(k, _)| k).collect();
        let need = instance_needs_link(
            &child.tier,
            props
                .iter()
                .filter(|(k, v)| {
                    !keys.contains(&k) && !is_handler_prop(k, v) && !(ref_fwd && *k == "ref")
                })
                .map(|(k, v)| self.link_input(k, v, self.deps_of(v))),
        );
        if need != LinkNeed::None {
            return live;
        }
        for (k, shadow) in cands {
            self.shadow(&k, shadow);
            self.live_forwards.push(crate::ir::Forwarded {
                loc,
                key: k.clone(),
            });
            live.push(k);
        }
        let _ = name;
        live
    }

    /// F300: `defaultChecked` / `defaultValue` (the keys `live_key_ok` refuses as property writes) of a value that
    /// reads state only through snapshot cells. Nothing it reads changes after mount, so the computed behind
    /// `x-bind-checked` / `x-bind-value` runs once, when the instance mounts, with the value current then (F277
    /// reseeds a late mount from its parent's current props): the property write equals React's initial
    /// `defaultChecked` / `defaultValue`, and nothing repaints it later. The rest of the gate is `live_key_ok`'s.
    fn snapshot_key_ok(&self, k: &str, v: &Expr) -> bool {
        matches!(k, "defaultChecked" | "defaultValue")
            && matches!(v, Expr::Raw(_) | Expr::Server(_))
            && !self.deps_of(v).changes_after_mount()
    }

    /// F296 C1 (and F299 for `className`): the child may render a Slot (`asChild`) at this call site, and a Slot MERGES
    /// `style` (the call site's object over its child element's own) and `className` (both class lists), where a host
    /// element's spread replaces them. True unless the flag is known
    /// to select the host element: absent or a literal for the host, and no spread that could carry the flag.
    fn style_may_merge(&self, props: &[(String, Expr)], child: &Child) -> bool {
        let Some(poly) = &child.poly else {
            return false;
        };
        let flag = props
            .iter()
            .rev()
            .find(|(k, _)| k == &poly.flag)
            .map(|(_, v)| v);
        let value = match flag {
            None => Some(false),
            Some(Expr::Raw(r)) | Some(Expr::Server(ServerExpr(r))) => match r.json_literal() {
                Some(serde_json::Value::Bool(b)) => Some(b),
                _ => None,
            },
            Some(_) => None,
        };
        let spreads_in = props.iter().any(|(k, _)| k == crate::ir::SPREAD_KEY);
        let unknown_spread =
            spreads_in && (poly.negate || self.spread_carries(&poly.flag, props).is_err());
        !(value == Some(poly.negate) && !unknown_spread)
    }

    /// F267: whether the `ref` of this call site is a ref cell of this component and `child` is an inlined `forwardRef`
    /// component that hands its ref to exactly one element it always renders: the parent binds `x-ref` there, in its own
    /// scope, and the child stays static and unlinked.
    fn forward_ref(&self, loc: u32, props: &[(String, Expr)], child: &Child) -> Option<String> {
        let ok = matches!(child.tier, Tier::Static)
            && child.ref_site
            && props.iter().filter(|(k, _)| k == "ref").count() == 1
            && !props.iter().any(|(k, _)| k == "asChild")
            // a spread after the ref could carry a `ref` of its own (React 19 passes it as a prop)
            && props
                .iter()
                .rposition(|(k, _)| k == crate::ir::SPREAD_KEY)
                .zip(props.iter().position(|(k, _)| k == "ref"))
                .is_none_or(|(spread, at)| spread < at);
        if !ok {
            return None;
        }
        match self.st.prop_raws.get(&(loc, "ref".to_string())) {
            Some(RawExpr {
                kind: RawKind::Ident { name, .. },
                ..
            }) if self.own_refs.contains(name) => Some(name.clone()),
            _ => None,
        }
    }

    /// Event handlers the parent binds itself (shadcn S1.3, R34.18): an `on*` prop that lands in
    /// the spread of a static child, which spreads it onto elements only and reads it nowhere else,
    /// becomes a handler of the parent (`_hN`, [`crate::ir::Forwarded`]); the inline print binds it
    /// on the child's element, as if written there. The child stays static and unlinked.
    /// Returns the hoisted keys (plus the dropped invalid names: neither are props of the instance),
    /// and the handler keys that land in the spread but cannot be bound, with why (R34.19:
    /// `check_spread` refuses them).
    fn forward_handlers(
        &mut self,
        name: &str,
        loc: u32,
        props: &[(String, Expr)],
        child: &Child,
        live: &[String],
    ) -> (Vec<String>, Vec<(String, String)>) {
        // A spread of unknown keys replaces a handler only when it comes after the handler's last
        // occurrence (React: later wins); `{...props} onMouseDown={…}` keeps the handler (F153c, Label).
        let spread_after = |key: &str| {
            let last = props.iter().rposition(|(k, _)| k == key).unwrap_or(0);
            props[last..]
                .iter()
                .any(|(k, _)| k == crate::ir::SPREAD_KEY)
        };
        let mut want: Vec<String> = Vec::new();
        let mut unbound: Vec<(String, String)> = Vec::new();
        // Keys that are not attribute names (a quoted key of a literal spread, which Bun inlines
        // into the props): never an `x-on-*` attribute. Dropped with a warning, as React drops an
        // invalid attribute name and as the reader drops a hand-written one (review F1, R34.17).
        let mut dropped: Vec<String> = Vec::new();
        for (k, v) in props {
            if !is_handler_prop(k, v) || !child.spread.lands(k) {
                continue;
            }
            if !handler_key_ok(k) {
                if !dropped.contains(k) {
                    self.diagnostics.push(Diagnostic::warning(
                        "unsafe-attr",
                        format!("`{k}` reaches an element through the spread of <{name}> but is not a valid event attribute name; it is not bound"),
                        loc,
                        "pass attribute names only",
                    ));
                    dropped.push(k.clone());
                }
                continue;
            }
            let why = if k.ends_with("Capture") {
                Some("listens in the capture phase, which directives do not support".to_string())
            } else if !matches!(child.tier, Tier::Static) {
                // F369c: a handler that lands on the ONE element a NATIVE child's rest reaches is bound by that element
                // itself (`x-prop-on-<event>="<key>"`, read live from the instance's props); anything it cannot honour
                // keeps the refusal.
                if !spread_after(k) && self.native_handler_ok(k, props, child) {
                    if !self.live_props.iter().any(|f| f.loc == loc && &f.key == k) {
                        self.live_props.push(crate::ir::Forwarded {
                            loc,
                            key: k.clone(),
                        });
                    }
                    continue;
                }
                Some(format!(
                    "<{name}> is not static (a handler can be bound only on a static child's element)"
                ))
            } else if spread_after(k) {
                Some(format!(
                    "props of unknown keys are also spread into <{name}> here, and may replace it"
                ))
            } else if child.onward.components.lands(k) {
                Some(format!("<{name}> passes it on to another component"))
            } else if child
                .onward
                .reads
                .as_ref()
                .is_none_or(|r| r.contains(k.as_str()))
            {
                Some(format!("<{name}> also reads it by name"))
            } else if !self.st.prop_raws.contains_key(&(loc, k.clone())) {
                Some("its value was not read".to_string())
            } else {
                None
            };
            match why {
                Some(w) => unbound.push((k.clone(), w)),
                // A key given twice is one handler: the last value (`prop_raws` keeps it).
                None if !want.contains(k) => want.push(k.clone()),
                None => {}
            }
        }
        if want.is_empty() {
            return (dropped, unbound);
        }
        // Bound on the child's element, so the instance must paint once: no link for the rest.
        let rest: Vec<(String, Expr)> = props
            .iter()
            .filter(|(k, _)| !want.contains(k) && !dropped.contains(k) && !live.contains(k))
            .cloned()
            .collect();
        let rest: Vec<(Expr, Deps)> = rest
            .iter()
            .map(|(k, v)| (v.clone(), self.deps_while_mounted(v, name, k)))
            .collect();
        let need = instance_needs_link(
            &child.tier,
            rest.iter()
                .map(|(v, d)| (matches!(v, Expr::ClientOnly { .. }), d.clone())),
        );
        // F320: a link only a changing prop would ask for gives way to the handler: the instance stays unlinked and
        // F319's freeze answers for those props per call site (a caller passing a constant keeps the page native).
        if need == LinkNeed::None && rest.iter().any(|(_, d)| self.reads_changing_prop(d)) {
            self.hold_link = true;
        }
        if need != LinkNeed::None {
            let why = match need {
                LinkNeed::RowOnly => format!(
                    "another prop of <{name}> reads the row, and the handler makes the client render the row"
                ),
                _ => format!("<{name}> is linked (another prop of it changes on the client)"),
            };
            unbound.extend(want.drain(..).map(|k| (k, why.clone())));
            return (dropped, unbound);
        }
        for k in &want {
            let body = self.st.prop_raws[&(loc, k.clone())].clone();
            let mut n = self.st.handler_names.len() + 1;
            while self.st.handler_names.contains(&format!("_h{n}"))
                || self.st.reserved.contains(&format!("_h{n}"))
            {
                n += 1;
            }
            let hname = format!("_h{n}");
            self.st.handler_names.insert(hname.clone());
            self.handlers.push(crate::ir::HandlerDecl {
                name: hname,
                body,
                item_scoped: self.loop_scope.clone(),
                forwarded: Some(crate::ir::Forwarded {
                    loc,
                    key: k.clone(),
                }),
            });
        }
        want.extend(dropped);
        (want, unbound)
    }

    /// Fail closed (shadcn S1.2, R34.15): a spread is expanded into HTML only. A function or a
    /// value that changes on the client reaching an element through the child's spread would
    /// need a binding the child's chunk does not have, so the parent renders with React instead;
    /// likewise a spread passed to a React island or to a child the server feeds per instance.
    /// An event handler the parent binds itself (`hoisted`) is not refused; one that lands in the
    /// spread but cannot be bound (`unbound`, R34.19) is, with its own code.
    /// R34.78: a static or native child that tests `children` as a value cannot be inlined with children given.
    fn check_children_read(
        &mut self,
        name: &str,
        props: &[(String, Expr)],
        given: &[Node],
        child: &Child,
        loc: u32,
    ) {
        if child.rest_as_data && !given.is_empty() {
            self.diagnostics.push(Diagnostic::fallback(
                "children-rest",
                format!("<{name}> passes its `...rest` to a component it specialises as data, and the children given to it are markup, which that object cannot carry"),
                loc,
                "render the children inside the component that reads them, or keep this component in React",
            ));
        }
        // F328b: the child would call `children` if it were a function; React calls one. Only children that are provably nodes
        // (elements, components, text, literals, templates) are inlined; an identifier, a call, a member or a function is not
        // provable, and neither is `children` handed in as a prop.
        let provably_node = |g: &Node| match g {
            Node::Slot(Expr::Raw(r) | Expr::Server(ServerExpr(r))) => {
                matches!(r.kind, RawKind::Lit(_) | RawKind::Template { .. })
            }
            Node::Slot(_) => false,
            _ => true,
        };
        if child.ir.as_deref().is_some_and(|c| c.children_called)
            && (!given.iter().all(provably_node) || props.iter().any(|(k, _)| k == "children"))
        {
            self.diagnostics.push(Diagnostic::fallback(
                "children-read",
                format!("<{name}> calls its `children` when it is a function, and the children given here are not provably nodes"),
                loc,
                "pass elements or text as children, or keep the component interactive with React",
            ));
        }
        if child.reads_children_value && !given.is_empty() {
            self.diagnostics.push(Diagnostic::fallback(
                "children-read",
                format!("<{name}> reads `children` as a value, which an inlined instance with children cannot answer"),
                loc,
                "render `{children}` only, or keep the component interactive with React",
            ));
        }
    }

    /// F369c: whether the handler prop `k` of a call of a NATIVE child can be bound by the element it lands on
    /// (`x-prop-on-<event>="<key>"`, printed in the template per call site; the binder calls the prop's CURRENT value).
    /// Fails closed, each on its own: the child is not native or has a job / a rest as data; the event is not one the
    /// `x-on-*` binder accepts (`handler_key_ok`, the allowlist `forward_handlers` uses) or is a capture one; the child
    /// reads the key by name or passes it to another component; the key is given twice; the call sits in a list; the rest
    /// does not reach exactly ONE element through static components only; or that path binds a handler of the same event
    /// itself (the order of the two is not proven, so the caller stays on React).
    fn native_handler_ok(&mut self, k: &str, props: &[(String, Expr)], child: &Child) -> bool {
        if !matches!(child.tier, Tier::Native)
            || child.fed
            || child.prop_precompute
            || child.rest_as_data
            || !self.loop_scope.is_empty()
            || k.ends_with("Capture")
            || !handler_key_ok(k)
            || props.iter().filter(|(o, _)| o == k).count() != 1
        {
            return false;
        }
        let Some(event) = crate::analyze::jsx::event_name(k) else {
            return false;
        };
        // Only an event React itself has a prop for: an unknown `onPick` is no DOM event React ever listens to, and a
        // listener for it would fire on a custom event React ignores.
        if event_prop(&event) != Some(k) {
            return false;
        }
        let Some(ir) = child.ir.clone() else {
            return false;
        };
        let sink = HandlerSink::of(&ir);
        if sink.reads.as_ref().is_none_or(|r| r.contains(k)) {
            return false;
        }
        self.rest_reaches_one_element(&ir, 4) && !self.rest_path_binds_event(&ir, &event, 4)
    }

    /// F369c: whether `ir`, or a static component its whole rest is handed to, binds a handler of `event` on an element
    /// of its own.
    fn rest_path_binds_event(&mut self, ir: &ComponentIR, event: &str, depth: u32) -> bool {
        fn binds(n: &Node, event: &str) -> bool {
            match n {
                Node::Element {
                    attrs, children, ..
                } => {
                    attrs
                        .iter()
                        .any(|a| matches!(a, Attr::Event { event: e, .. } if e == event))
                        || children.iter().any(|c| binds(c, event))
                }
                Node::Component { children, .. } | Node::Fragment(children) => {
                    children.iter().any(|c| binds(c, event))
                }
                Node::If { then, else_, .. } => then.iter().chain(else_).any(|c| binds(c, event)),
                Node::For { body, .. } => body.iter().any(|c| binds(c, event)),
                Node::Text(_) | Node::Slot(_) | Node::Outlet => false,
            }
        }
        // a handler hoisted from a prop of a static child (`<Prim onClick>`) is bound on that child's element
        if binds(&ir.template, event)
            || ir.handlers.iter().any(|h| {
                h.forwarded.as_ref().is_some_and(|f| {
                    crate::analyze::jsx::event_name(&f.key).is_none_or(|e| e == event)
                })
            })
        {
            return true;
        }
        if depth == 0 {
            return true;
        }
        match whole_rest_site(&ir.template) {
            Some(Some((cname, source, imported, member, cloc))) => {
                let cc = self.resolve_child(
                    &cname,
                    source.as_deref(),
                    imported.as_deref(),
                    &member,
                    cloc,
                );
                cc.ir
                    .clone()
                    .is_none_or(|inner| self.rest_path_binds_event(&inner, event, depth - 1))
            }
            Some(None) => false,
            None => true,
        }
    }

    /// F329b: whether the live prop `k` of a call of a NATIVE child can be bound by the element it lands on
    /// (`x-prop-<attribute>="<key>"`, printed in the template per call site, never as a chunk member). Everything the
    /// binding cannot honour fails closed, each on its own: the child is not native or has a job / a rest as data; the key is
    /// not an attribute the server print and the binder agree on (`live_key_ok`, never `class`/`style`/the URL attributes,
    /// A5), or the child reads it elsewhere; a spread of unknown keys may follow it; the call sits in a list (A6); the rest does
    /// not reach exactly ONE element through static components only (a native one between would own the directive).
    fn native_rest_live_ok(
        &mut self,
        k: &str,
        v: &Expr,
        props: &[(String, Expr)],
        child: &Child,
        after_spreads: bool,
    ) -> bool {
        if k == crate::ir::SPREAD_KEY
            || !matches!(child.tier, Tier::Native)
            || child.fed
            || child.prop_precompute
            || child.rest_as_data
            || !after_spreads
            || !self.loop_scope.is_empty()
            || !child.spread.lands(k)
            || !live_key_ok(k)
            // a camelCase DOM name (`viewBox`) cannot be set from a lowercase `x-prop-*` attribute name (HTML lowercases it)
            || brust_jinja::attr_name(k).chars().any(|c| c.is_ascii_uppercase())
            || matches!(
                brust_jinja::spread::attr_key(k).as_str(),
                "class" | "style" | "children"
            )
            || !matches!(v, Expr::Raw(_) | Expr::Server(_))
            || props.iter().filter(|(o, _)| o == k).count() != 1
        {
            return false;
        }
        let Some(ir) = child.ir.clone() else {
            return false;
        };
        let sink = HandlerSink::of(&ir);
        if sink.reads.as_ref().is_none_or(|r| r.contains(k)) {
            return false;
        }
        self.rest_reaches_one_element(&ir, 4)
    }

    /// F329b: the rest `ir` spreads lands on exactly one element, through STATIC components only.
    fn rest_reaches_one_element(&mut self, ir: &ComponentIR, depth: u32) -> bool {
        if depth == 0 || count_prop_spreads(&ir.template) != 1 {
            return false;
        }
        match whole_rest_site(&ir.template) {
            Some(None) => true,
            Some(Some((cname, source, imported, member, cloc))) => {
                let cc = self.resolve_child(
                    &cname,
                    source.as_deref(),
                    imported.as_deref(),
                    &member,
                    cloc,
                );
                matches!(cc.tier, Tier::Static)
                    && cc
                        .ir
                        .clone()
                        .is_some_and(|inner| self.rest_reaches_one_element(&inner, depth - 1))
            }
            None => false,
        }
    }

    fn check_spread(
        &mut self,
        name: &str,
        props: &[(String, Expr)],
        child: &Child,
        loc: u32,
        hoisted: &[String],
        unbound: &[(String, String)],
    ) {
        let spreads_in = props.iter().any(|(k, _)| k == crate::ir::SPREAD_KEY);
        let refuse = |why: String| {
            Diagnostic::fallback(
                "spread-props",
                why,
                loc,
                "pass these props explicitly, or keep the component that receives them interactive with React",
            )
        };
        if spreads_in && matches!(child.tier, Tier::React { .. }) {
            self.diagnostics.push(refuse(format!(
                "props are spread into the React island <{name}>"
            )));
            return;
        }
        if spreads_in
            && child.fed
            && let Err(why) = self.spread_feeds_no_job_input(name, props, child)
        {
            self.diagnostics.push(refuse(why));
            return;
        }
        if child.icon_spread {
            // R34.77: the icon inside reads these keys itself (`size` sets width and height, `className`
            // merges with its own class): a runtime spread would print them as plain attributes instead.
            if spreads_in {
                self.diagnostics.push(refuse(format!(
                    "props of unknown keys are spread into <{name}>, which spreads them onto an icon that reads some of them itself"
                )));
                return;
            }
            if let Some((k, _)) = props
                .iter()
                .find(|(k, _)| icon_reads_itself(k) && child.spread.lands(k))
            {
                self.diagnostics.push(refuse(format!(
                    "the prop `{k}` of <{name}> reaches an icon through a spread, and the icon reads `{k}` itself"
                )));
                return;
            }
        }
        if let Some((k, why)) = unbound.first() {
            let rule = if k.ends_with("Capture") {
                "event-capture"
            } else {
                "spread-handler"
            };
            self.diagnostics.push(Diagnostic::fallback(
                rule,
                format!("the handler `{k}` reaches an element through the spread of <{name}>, but {why}"),
                loc,
                "pass the handler to an element the parent writes, or keep the component interactive with React",
            ));
            return;
        }
        for (k, v) in props {
            if hoisted.contains(k) {
                continue;
            }
            let live = matches!(v, Expr::ClientOnly { .. }) || self.reads_state(v);
            if !live {
                continue;
            }
            // F295: a value that reads state only through snapshot cells (cells nothing sets, read as their value at
            // mount) never changes while the instance lives: printed once through the spread, it is right as long as
            // the instance mounts once, which its callers must promise (`mount_once`).
            let snapshot_only = match v {
                Expr::Raw(_) | Expr::Server(_) => !self.deps_of(v).changes_after_mount(),
                _ => false,
            };
            // Props spread in carry keys known only at render: a linked instance next to them could
            // repaint an attribute the spread set.
            // F278: a prop the compiler wrote (`__ctx_…`, `__in_…`) AFTER the last spread is not replaced by it (React:
            // the later key wins) and no caller can name it, so the spread cannot repaint what it binds.
            // F329 W1: the same for ANY key written after the last spread: the later key wins in React and the spread
            // cannot carry it here; whether the CHILD lets it reach an element is `child.spread.lands(k)` below.
            let after_spreads = props
                .iter()
                .rposition(|(o, _)| o == crate::ir::SPREAD_KEY)
                .zip(props.iter().position(|(o, _)| o == k))
                .is_none_or(|(spread, at)| spread < at);
            if k == crate::ir::SPREAD_KEY || (spreads_in && !after_spreads) || child.spread.lands(k)
            {
                if snapshot_only {
                    self.add_mount_once(format!(
                        "<{name}> gets `{k}`, a value taken once at mount, through a spread"
                    ));
                    continue;
                }
                let function = matches!(v, Expr::ClientOnly { .. });
                // F329b: a live value that lands on an element through a NATIVE child's rest is bound by that element itself.
                if !function && self.native_rest_live_ok(k, v, props, child, after_spreads) {
                    if !self.live_props.iter().any(|f| f.loc == loc && &f.key == k) {
                        self.live_props.push(crate::ir::Forwarded {
                            loc,
                            key: k.clone(),
                        });
                    }
                    continue;
                }
                // F369c: a handler a native child's element binds itself (`live_props`, set by `forward_handlers`).
                if crate::analyze::jsx::event_name(k).is_some()
                    && self.live_props.iter().any(|f| f.loc == loc && &f.key == k)
                {
                    continue;
                }
                if function && crate::analyze::jsx::event_name(k).is_none() {
                    // R34.19: not an event, so no element binding can stand for it (a render prop).
                    self.diagnostics.push(Diagnostic::fallback(
                        "spread-function",
                        format!("prop `{k}` of <{name}> is a function that is not an event handler, and props reach <{name}> through a spread"),
                        loc,
                        "pass it as a named prop the child reads, or keep the component interactive with React",
                    ));
                    return;
                }
                let what = if function {
                    "a function"
                } else {
                    "a value that changes on the client"
                };
                self.diagnostics.push(refuse(format!(
                    "prop `{k}` of <{name}> is {what} and reaches an element through a spread, which brust expands into HTML only"
                )));
                return;
            }
        }
    }

    /// A plain props path of `e` (`item.price`), `[idx]` standing for the current row of
    /// the innermost list; `None` for anything else.
    /// F337 (M2, Mellow A5): `e` reads one of this component's states whole, outside any row, whose initial value is a
    /// literal (`Ok`, its JSON) or a props path (`Err`, the path): what the server paints for it. A lazy, store, context,
    /// ref or any other initializer is `None`.
    fn state_seed(&self, e: &Expr) -> Option<Result<crate::ir::OJson, String>> {
        let (Expr::Raw(r) | Expr::Server(ServerExpr(r))) = e else {
            return None;
        };
        let RawKind::Ident {
            name,
            kind: IdentKind::State,
        } = &r.kind
        else {
            return None;
        };
        if !self.items.is_empty() {
            return None;
        }
        let i = self.written_inits.get(name)?;
        if let Some(j) = i.json_literal_ordered() {
            return Some(Ok(j));
        }
        match plain_path(i, None)? {
            // A hidden input (a Provider frame's `__ctx_*`, a clone's `__in_*`) is a value the call site or a frame hands
            // in, not data the page's props carry: a context-initialised state is no seed (Mellow A5, review round 1).
            PlainPath::Props(p) if p.starts_with("__ctx_") || p.starts_with("__in_") => None,
            PlainPath::Props(p) => Some(Err(p)),
            PlainPath::Row(_) => None,
        }
    }

    fn prop_path(&self, e: &Expr) -> Option<String> {
        let r = match e {
            Expr::Raw(r) | Expr::Server(ServerExpr(r)) => r,
            _ => return None,
        };
        match plain_path(r, self.items.last().map(String::as_str))? {
            PlainPath::Props(p) => Some(p),
            PlainPath::Row(rest) => Some(format!(
                "{}[idx]{rest}",
                self.loop_sources.last()?.as_ref()?
            )),
        }
    }

    /// `e` as a jinja expression the server evaluates per instance (F105): a §6.2 value over
    /// the props (`__props`) and the innermost row (`__row`, `__idx`). `None` for anything
    /// else, and always for a value that reads state or a store (R3.2: the parent's job).
    fn instance_expr(&self, e: &Expr) -> Option<String> {
        let Expr::Server(se) = e else { return None };
        if self.deps_of(e).reactive() {
            return None;
        }
        let item = self.items.last().map(String::as_str);
        let index = self.indexes.last().cloned().flatten();
        if !server_subset(&se.0, item, index.as_deref()) {
            return None;
        }
        let names = |name: &str, kind: &IdentKind| match kind {
            IdentKind::LoopBinding if Some(name) == item => Some("__row".to_string()),
            IdentKind::LoopBinding if Some(name) == index.as_deref() => Some("__idx".to_string()),
            _ => None,
        };
        Some(crate::lower::server_expr::to_jinja(
            se,
            &crate::lower::server_expr::JinjaCtx {
                in_loop: None,
                props_prefix: Some("__props."),
                names: &names,
            },
        ))
    }

    /// The path of a `For` source relative to props, when it is a plain path of the
    /// props or of the enclosing row.
    fn list_path(&self, source: &Expr) -> Option<String> {
        let r = match source {
            Expr::Raw(r) | Expr::Server(ServerExpr(r)) => r,
            _ => return None,
        };
        let outer = self.items.last().map(String::as_str);
        match plain_path(r, outer)? {
            PlainPath::Props(p) => Some(p),
            PlainPath::Row(rest) => Some(format!(
                "{}[idx]{rest}",
                self.loop_sources.last()?.as_ref()?
            )),
        }
    }

    /// The parent chunk's expression for one linked prop.
    fn link_prop(&self, v: &Expr) -> Expr {
        match v {
            Expr::Server(ServerExpr(r)) => Expr::Server(ServerExpr(r.clone())),
            Expr::Precomputed { slot, js, .. } => Expr::ClientOnly {
                js: self
                    .st
                    .slots
                    .get(slot)
                    .map(|i| i.raw.to_js_in(JsCtx::Client))
                    .unwrap_or_else(|| js.clone()),
            },
            Expr::ClientOnly { js } => Expr::ClientOnly { js: js.clone() },
            Expr::Raw(r) => Expr::ClientOnly {
                js: r.to_js_in(JsCtx::Client),
            },
        }
    }
}

/// A forwarded handler's key prints as `x-on-<event>`: it must be an attribute name whose event is
/// plain `[a-z0-9]+` (no quote, space, `=` or `>` can reach the tag).
pub(crate) fn handler_key_ok(k: &str) -> bool {
    brust_jinja::spread::attr_name_ok(k)
        && crate::analyze::jsx::event_name(k).is_some_and(|e| {
            !e.is_empty()
                && e.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

/// `d` reads a context value (`__ctx_*`, fed by the Provider's frame).
fn reads_ctx(d: &Deps) -> bool {
    d.props.iter().any(|p| p.starts_with("__ctx_"))
}

/// A live prop the parent binds on a child's element prints as `x-bind-<attr>`: it must pass the gate a hand-written
/// attribute passes (2b-handlers C3), and none of the keys the binder sets as a property (`value`, `checked`,
/// `selected`: refused when the element has a model, which is not known here, so refused here), the URL attributes,
/// or that are not attributes at all. `style` and `className` are allowed (F296, F299, spread-live option A): React
/// REPLACES an element's own `style`/`className` with the spread's (it never merges), so the parent's binding equals
/// what the element prints; where something merges them instead (`asChild`'s Slot), the caller of this gate refuses
/// them (`style_may_merge`).
pub(crate) fn live_key_ok(k: &str) -> bool {
    let html = brust_jinja::attr_name(k);
    brust_jinja::spread::attr_name_ok(k)
        && brust_jinja::spread::attr_name_ok(&html)
        && !brust_jinja::is_refused_attr(&html)
        && crate::analyze::jsx::event_name(k).is_none()
        && !k.to_ascii_lowercase().starts_with("x-")
        // The element is the child's: `<a href="">` keeps its empty href in React, which the print decides by the tag.
        && !brust_jinja::is_url_attr(&html)
        && !matches!(
            html.as_str(),
            "value" | "checked" | "selected" | "children" | "key" | "ref"
        )
        && k != "dangerouslySetInnerHTML"
}

/// An `on*` prop whose value can be a function (anything but a literal): bound as an event
/// handler where it lands on an element. A literal is dropped from the HTML, as React does.
fn is_handler_prop(k: &str, v: &Expr) -> bool {
    if crate::analyze::jsx::event_name(k).is_none() {
        return false;
    }
    match v {
        Expr::Raw(r) | Expr::Server(ServerExpr(r)) => r.json_literal().is_none(),
        Expr::Precomputed { .. } | Expr::ClientOnly { .. } => true,
    }
}

/// Why a native/static child instance gets a runtime link (`x-props-bind`, spec §7.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkNeed {
    /// Every prop is a constant or a plain prop path: the instance paints once, no link.
    None,
    /// A prop is a function or reads state, or the child has a behaviour of its own and
    /// reads the row: linked wherever it sits.
    Always,
    /// A static child reads only the row's loop bindings: linked only inside a row the
    /// client can re-create, plain HTML everywhere else (ledger F70).
    RowOnly,
}

/// F277: the props of `ir` read nowhere but in the first value of a state cell nothing sets (a B4 never-written ref,
/// `const [x] = useState(init)`): the child takes them once, at its first render. Fail closed: the IR as serialised,
/// with those cells, the prop declarations and the client's prop list (`client_props` and its projections, which count
/// the cells' first values) left out, must not spell the prop's name (or its local) in any string, and must not read
/// the whole props object (`*`). Keys are struct fields, or a child's prop names (an instance record), not reads.
fn snapshot_only_props(ir: &ComponentIR) -> BTreeSet<String> {
    let cx = super::deps::DepsCx::new(ir);
    let mut out: BTreeSet<String> = ir
        .state
        .iter()
        .filter(|s| s.is_fixed())
        .flat_map(|s| cx.deps_expr(&s.init, &[]).prop_roots())
        .collect();
    if out.is_empty() || out.contains("*") {
        return BTreeSet::new();
    }
    let Ok(mut rest) = serde_json::to_value(ir) else {
        return BTreeSet::new();
    };
    if let Some(o) = rest.as_object_mut() {
        for k in [
            "id",
            "source",
            "props",
            "client_props",
            "client_prop_projections",
        ] {
            o.remove(k);
        }
        if let Some(state) = o.get_mut("state").and_then(|s| s.as_array_mut()) {
            state.retain(|s| s.get("setter").is_some_and(|x| !x.is_null()));
        }
    }
    if spells(&rest, &|s| s == "*") {
        return BTreeSet::new();
    }
    out.retain(|k| {
        let local = ir
            .props
            .iter()
            .find(|p| &p.name == k)
            .map(|p| p.local.as_str());
        [Some(k.as_str()), local]
            .into_iter()
            .flatten()
            .all(|n| !spells(&rest, &|s| names_word(s, n)))
    });
    out
}

/// Some string of `v` passes `f`.
fn spells(v: &serde_json::Value, f: &dyn Fn(&str) -> bool) -> bool {
    match v {
        serde_json::Value::String(s) => f(s),
        serde_json::Value::Array(a) => a.iter().any(|x| spells(x, f)),
        serde_json::Value::Object(o) => o.values().any(|x| spells(x, f)),
        _ => false,
    }
}

/// `s` holds `name` as a whole identifier (not inside a longer one).
fn names_word(s: &str, name: &str) -> bool {
    let ident = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '$';
    s.match_indices(name).any(|(i, _)| {
        !s[..i].chars().next_back().is_some_and(ident)
            && !s[i + name.len()..].chars().next().is_some_and(ident)
    })
}

/// The link decision for one `<Child …/>` from the child's tier and what each prop reads
/// (`function` = the prop is `Expr::ClientOnly`, or F320 reads a prop that changes: the child must follow it).
pub fn instance_needs_link(tier: &Tier, props: impl IntoIterator<Item = (bool, Deps)>) -> LinkNeed {
    let mut loop_only = false;
    for (function, d) in props {
        if function || d.reactive() {
            return LinkNeed::Always;
        }
        loop_only |= !d.loop_bindings.is_empty();
    }
    match (loop_only, tier) {
        (false, _) => LinkNeed::None,
        (true, Tier::Static) => LinkNeed::RowOnly,
        (true, _) => LinkNeed::Always,
    }
}

/// Whether the server can evaluate `r` for a child instance: literals, props, the innermost
/// row's item and index, and the operators and calls the jinja printer maps one to one.
fn server_subset(r: &RawExpr, item: Option<&str>, index: Option<&str>) -> bool {
    let sub = |e: &RawExpr| server_subset(e, item, index);
    match &r.kind {
        RawKind::Lit(_) => true,
        RawKind::Ident { name, kind } => match kind {
            // The whole props object (`*`) would hand the child the server's own context keys.
            IdentKind::Prop => name != "*",
            IdentKind::LoopBinding => Some(name.as_str()) == item || Some(name.as_str()) == index,
            _ => false,
        },
        RawKind::Member { target, .. } => {
            let whole_props = matches!(&target.kind, RawKind::Ident { name, kind: IdentKind::Prop } if name == "*");
            whole_props || sub(target)
        }
        RawKind::Index { target, index: i } => sub(target) && sub(i),
        RawKind::Unary { op, value } => *op != UnOp::Typeof && sub(value),
        RawKind::Binary { left, right, .. } => sub(left) && sub(right),
        RawKind::Cond { test, yes, no } => sub(test) && sub(yes) && sub(no),
        RawKind::Template { parts, .. } => parts.iter().all(|(p, _)| sub(p)),
        RawKind::Array(items) => items.iter().all(sub),
        RawKind::Object(props) => props.iter().all(|(_, v)| sub(v)),
        RawKind::Call { callee, args } => {
            let RawKind::Member { target, name, .. } = &callee.kind else {
                return false;
            };
            let global = match &target.kind {
                RawKind::Ident {
                    name: obj,
                    kind: IdentKind::Global,
                } => Some(obj.as_str()),
                _ => None,
            };
            let known = match global {
                Some(obj) => {
                    matches!((obj, name.as_str()), ("Object", "keys" | "entries"))
                        && args.len() == 1
                }
                None => {
                    sub(target)
                        && matches!(
                            name.as_str(),
                            "toUpperCase"
                                | "toLowerCase"
                                | "trim"
                                | "slice"
                                | "startsWith"
                                | "endsWith"
                                | "includes"
                                | "join"
                        )
                }
            };
            known && args.iter().all(sub)
        }
        RawKind::Arrow { .. } | RawKind::Jsx(_) | RawKind::Opaque { .. } => false,
    }
}

/// A value read as a path: from the props, or from the innermost row's item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum PlainPath {
    Props(String),
    /// `""` for the item itself, `.title` for a member of it.
    Row(String),
}

pub(super) fn plain_path(r: &RawExpr, item: Option<&str>) -> Option<PlainPath> {
    match &r.kind {
        RawKind::Ident {
            name,
            kind: IdentKind::Prop,
        } if name != "*" => Some(PlainPath::Props(name.clone())),
        RawKind::Ident {
            name,
            kind: IdentKind::LoopBinding,
        } if Some(name.as_str()) == item => Some(PlainPath::Row(String::new())),
        RawKind::Member {
            target,
            name,
            optional: false,
        } => match plain_path(target, item)? {
            PlainPath::Props(p) => Some(PlainPath::Props(format!("{p}.{name}"))),
            PlainPath::Row(rest) => Some(PlainPath::Row(format!("{rest}.{name}"))),
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(loc: u32, source: Option<&str>, children: Vec<Node>) -> Node {
        Node::Component {
            loc,
            name: "C".into(),
            source: source.map(str::to_string),
            imported: None,
            member: vec![],
            props: vec![],
            children,
            link: None,
            tier: Tier::Pending,
            forwarded_ref: false,
        }
    }

    fn client(js: &str) -> Expr {
        Expr::ClientOnly { js: js.into() }
    }

    // F238 (Mellow, review): two call sites at one offset of one template with different content get different clone
    // ids (and keys); the same content gets the same one. On main the colliding shape is refused by F3 first, so this
    // pins the key itself.
    #[test]
    fn clone_ids_at_one_site_and_offset_differ_by_content() {
        let a = vec![Node::Text("a".into())];
        let b = vec![Node::Text("b".into())];
        let id = |n: &[Node]| spec_hash(&clone_site("m.tsx#c1", n, &None::<()>), 7);
        assert_ne!(id(&a), id(&b));
        assert_eq!(id(&a), id(&a.clone()));
        assert_ne!(
            clone_site("m.tsx#c1", &a, &None::<()>),
            clone_site("m.tsx#c1", &a, &Some("render"))
        );
    }

    // F365(a): the refusal in `specialise_host` rests on this set, and no fixture reaches it with a real collision.
    #[test]
    fn shared_component_locs_counts_call_sites_that_share_an_offset() {
        let locs = |n: &Node| shared_component_locs(n).into_iter().collect::<Vec<_>>();
        // two calls at one offset (nested in a call's own content too): counted
        let t = Node::Fragment(vec![
            call(7, None, vec![call(7, None, vec![])]),
            call(9, None, vec![]),
        ]);
        assert_eq!(locs(&t), vec![7]);
        // distinct offsets: none
        let t = Node::Fragment(vec![call(1, None, vec![]), call(2, None, vec![])]);
        assert!(locs(&t).is_empty());
        // a clone (SPEC_SOURCE) at the offset of its original is not a second call site
        let t = Node::Fragment(vec![
            call(7, None, vec![]),
            call(7, Some(SPEC_SOURCE), vec![]),
        ]);
        assert!(locs(&t).is_empty());
        // ... and two clones are not either
        let t = Node::Fragment(vec![
            call(7, Some(SPEC_SOURCE), vec![]),
            call(7, Some(SPEC_SOURCE), vec![]),
        ]);
        assert!(locs(&t).is_empty());
        // a clone's own content is still walked: a real call inside it that repeats an offset counts
        let t = Node::Fragment(vec![
            call(3, None, vec![]),
            call(7, Some(SPEC_SOURCE), vec![call(3, None, vec![])]),
        ]);
        assert_eq!(locs(&t), vec![3]);
        // under an If (either arm) and a For: counted
        let t = Node::Fragment(vec![
            call(5, None, vec![]),
            Node::If {
                cond: client("c"),
                then: vec![call(5, None, vec![])],
                else_: vec![],
                and: false,
            },
        ]);
        assert_eq!(locs(&t), vec![5]);
        let t = Node::Fragment(vec![
            Node::If {
                cond: client("c"),
                then: vec![],
                else_: vec![call(6, None, vec![])],
                and: false,
            },
            call(6, None, vec![]),
        ]);
        assert_eq!(locs(&t), vec![6]);
        let t = Node::Fragment(vec![
            call(8, None, vec![]),
            Node::For {
                source: client("xs"),
                item: "x".into(),
                index: None,
                key: client("x"),
                body: vec![call(8, None, vec![])],
            },
        ]);
        assert_eq!(locs(&t), vec![8]);
    }

    fn d(state: &[&str], loops: &[&str]) -> Deps {
        let mut d = Deps::default();
        d.state.extend(state.iter().map(|s| s.to_string()));
        d.loop_bindings.extend(loops.iter().map(|s| s.to_string()));
        d
    }

    #[test]
    fn link_decisions() {
        let s = Tier::Static;
        let n = Tier::Native;
        for (tier, props, want) in [
            (&s, vec![], LinkNeed::None),
            (&s, vec![(false, d(&[], &[]))], LinkNeed::None),
            (&s, vec![(false, d(&[], &["b"]))], LinkNeed::RowOnly),
            (
                &s,
                vec![(false, d(&[], &["b"])), (false, d(&["q"], &[]))],
                LinkNeed::Always,
            ),
            (&s, vec![(true, d(&[], &[]))], LinkNeed::Always),
            (
                &s,
                vec![(false, d(&["selected"], &["t"]))],
                LinkNeed::Always,
            ),
            (&n, vec![(false, d(&[], &["it"]))], LinkNeed::Always),
            (&n, vec![(false, d(&[], &[]))], LinkNeed::None),
            (
                &Tier::Pending,
                vec![(false, d(&[], &["x"]))],
                LinkNeed::Always,
            ),
        ] {
            assert_eq!(
                instance_needs_link(tier, props.clone()),
                want,
                "{tier:?} {props:?}"
            );
        }
    }
}

/// F319: every expression the markup of `nodes` prints or passes (slots, attribute values, conditions, list sources,
/// component props), at any depth.
fn node_exprs(nodes: &[Node], out: &mut Vec<Expr>) {
    for n in nodes {
        match n {
            Node::Slot(e) => out.push(e.clone()),
            Node::Element {
                attrs, children, ..
            } => {
                for a in attrs {
                    if let Attr::Dynamic { value, .. }
                    | Attr::InnerHtml { value }
                    | Attr::Spread(value) = a
                    {
                        out.push(value.clone());
                    }
                }
                node_exprs(children, out);
            }
            Node::Component {
                props, children, ..
            } => {
                out.extend(props.iter().map(|(_, v)| v.clone()));
                node_exprs(children, out);
            }
            Node::If {
                cond, then, else_, ..
            } => {
                out.push(cond.clone());
                node_exprs(then, out);
                node_exprs(else_, out);
            }
            Node::For { source, body, .. } => {
                out.push(source.clone());
                node_exprs(body, out);
            }
            Node::Fragment(cs) => node_exprs(cs, out),
            Node::Text(_) | Node::Outlet => {}
        }
    }
}
