//! M1b-2 passes over the structural IR, run in a fixed order by
//! [`run_passes`]: stores → deps → placement (uses `server_expr`) → children →
//! captures → tier (`cache()` is read with the component, in `component.rs`). Pure functions of the IR, except `stores`, which
//! reads store modules, and `children`, which compiles child modules, both through the
//! [`crate::analyze::modules`] cache.
pub mod build_eval;
pub mod captures;
pub mod children;
pub mod deps;
pub mod icons;
pub mod placement;
pub mod projection;
pub mod server_expr;
pub mod stores;
pub mod tier;

use deps::DepsCx;
use placement::{Painted, SlotInfo};
use std::collections::{BTreeSet, HashMap};

use crate::ir::{ComponentIR, JobKind};

/// Facts one pass leaves for the next; never serialized.
#[derive(Default)]
pub struct PassState {
    /// Local definitions as read (before placement rewrote them).
    pub cx: DepsCx,
    /// Every first-paint value with its deps.
    pub painted: Vec<Painted>,
    /// Precomputed slots with the expression they came from.
    pub slots: HashMap<String, SlotInfo>,
    /// Where render reads a browser global, and which.
    pub browser_locs: Vec<(u32, String)>,
    pub handler_names: BTreeSet<String>,
    /// Values the client chunk evaluates, beyond handlers/effects/state inits.
    pub client_uses: Vec<ClientUse>,
    /// Code outside the template that builds JSX: (loc, what).
    pub jsx_code: Vec<(u32, &'static str)>,
    /// Every client read, with its raw expression where it has one (`captures` leaves the final list here).
    pub all_uses: Vec<ClientUse>,
    /// Slots the build may evaluate once (L2), filled by placement.
    pub build_eval: Vec<crate::ir::BuildEvalSlot>,
    /// Every component prop as read, by (component node loc, prop key), before placement
    /// rewrote it: `children` hoists a forwarded handler from it (shadcn S1.3).
    pub prop_raws: HashMap<(u32, String), crate::ir::RawExpr>,
    /// S2: the `loc` of every component instance that is a lowered context Provider (its children are printed under a
    /// Provider frame, which placement judges with the allowlist).
    pub provider_locs: std::collections::BTreeSet<u32>,
}

/// Something the client chunk runs, with what it reads.
#[derive(Debug, Clone)]
pub struct ClientUse {
    pub loc: u32,
    pub deps: deps::Deps,
    /// For messages: `a handler`, `an effect`, ….
    pub what: &'static str,
    /// The expression and its loop scope, so captures can recompute `deps`
    /// once placement is known (a props-only slot is not client code).
    pub raw: Option<(crate::ir::RawExpr, Vec<String>)>,
}

/// Inputs every pass may read.
pub struct PassCtx<'a> {
    /// Source text of the module, for line numbers in messages.
    pub text: &'a [u8],
    pub opts: &'a crate::analyze::component::AnalyzeOptions,
    /// Path of the module (relative to `opts.root`).
    pub path: &'a str,
    pub modules: &'a std::cell::RefCell<crate::analyze::modules::ModuleCache>,
    /// Reads a function declared in this module as a structural component.
    pub local: &'a dyn Fn(&str) -> Option<ComponentIR>,
    /// The component the caller asked for (a route component), not a child compiled on the way. Only a
    /// root can be sure nothing links it, so only a root may treat its own props as fixed (ledger F70).
    pub is_root: bool,
}

impl PassCtx<'_> {
    pub fn line(&self, loc: u32) -> u32 {
        crate::ir::line_col(self.text, loc).0
    }
}

impl PassState {
    pub fn new(ir: &ComponentIR) -> Self {
        PassState {
            cx: DepsCx::new(ir),
            handler_names: ir.handlers.iter().map(|h| h.name.clone()).collect(),
            ..Default::default()
        }
    }
}

/// Runs every pass on `ir` (a structural IR from `analyze_component`).
pub fn run_passes(ir: &mut ComponentIR, ctx: &PassCtx<'_>) -> PassState {
    // lucide icons become elements before anything snapshots or places the template (L23).
    icons::inline(ir, ctx);
    // First: `DepsCx` reads the resolved stores.
    stores::resolve(ir, ctx);
    // Before placement: a refused render read never becomes a placed value.
    stores::check_render(ir, ctx);
    // S2: context Providers hand their values to the consumers under them as hidden props, before the structural
    // snapshot and placement so every later pass reads them like any prop.
    let provider_locs = {
        let mut tmp = PassState::new(ir);
        children::contexts(ir, &mut tmp, ctx)
    };
    ir.structural = Some(Box::new(crate::ir::Structural {
        template: ir.template.clone(),
        state: ir.state.clone(),
        derived: ir.derived.clone(),
        refs: ir.refs.clone(),
    }));
    let mut st = PassState::new(ir);
    st.provider_locs = provider_locs;
    placement::place(ir, &mut st, ctx);
    // Children before captures: linked props are client reads of the parent.
    children::children(ir, &mut st, ctx);
    captures::captures(ir, &mut st, ctx);
    // F215: the code brust copies out of the module (jobs, the client chunk, build evaluation) carries its
    // declarations, never a statement that changes them; a component that reads a module binding of such a module
    // falls back.
    if let Some((at, what)) = ir.module_effect.clone() {
        let read = st
            .painted
            .iter()
            .find(|p| !p.deps.module_locals.is_empty() && !p.folds_module)
            .map(|p| p.loc)
            .or_else(|| (!ir.client_module_locals.is_empty()).then_some(at));
        if let Some(loc) = read {
            ir.diagnostics.push(crate::ir::Diagnostic::fallback(
                "module-side-effect",
                format!(
                    "this module has {what}; the code brust compiles copies the module's declarations but not that statement, so a value read from a module binding could differ from React's"
                ),
                loc,
                "move the statement into the function that needs it, or keep this component in React",
            ));
        }
    }
    projection::projection(ir, &st);
    tier::tier(ir, &mut st, ctx);
    // Backstop: the final precompute job never imports a store handle (D8).
    stores::check_jobs(ir, ctx);
    // Job cache keys are computed from the inputs by a path evaluator that cannot read `.length`
    // of a sequence: a job reading `rows.length` is keyed by `rows`. (The client seed keeps the
    // count-only narrowing; see `SeedNode`.)
    for j in &mut ir.jobs {
        j.inputs = deps::minimal_paths(
            j.inputs
                .iter()
                .map(|p| p.strip_suffix(".length").unwrap_or(p).to_string()),
        );
    }
    // C5 (M3-F D8): every ssr job declares the store snapshot; an island's props map carries it
    // (the server evaluates `props`, not `inputs`, when it is set). After `minimal_paths`, which
    // collapses `["*", "__store"]` to `["*"]`.
    for j in ir
        .jobs
        .iter_mut()
        .filter(|j| matches!(j.kind, JobKind::Ssr { .. }))
    {
        if !j.inputs.iter().any(|i| i == "__store") {
            j.inputs.push("__store".into());
            j.inputs.sort();
        }
        if let Some(p) = j.props.as_mut() {
            p.insert("__store".into(), Some("__store".into()));
        }
    }
    st
}
