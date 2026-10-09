//! M1b-2 passes over the structural IR, run in a fixed order by
//! [`run_passes`]: deps → placement (uses `server_expr`) → children →
//! captures → tier (`cache()` is read with the component, in `component.rs`). Pure functions of the IR, except `children`, which
//! compiles child modules through the [`crate::analyze::modules`] cache.
pub mod captures;
pub mod children;
pub mod deps;
pub mod placement;
pub mod server_expr;
pub mod tier;

use deps::DepsCx;
use placement::{Painted, SlotInfo};
use std::collections::{BTreeSet, HashMap};

use crate::ir::ComponentIR;

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
    let mut st = PassState::new(ir);
    placement::place(ir, &mut st);
    // Children before captures: linked props are client reads of the parent.
    children::children(ir, &mut st, ctx);
    captures::captures(ir, &mut st, ctx);
    tier::tier(ir, &mut st, ctx);
    st
}
