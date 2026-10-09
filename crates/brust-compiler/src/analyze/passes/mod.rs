//! M1b-2 passes over the structural IR, run in a fixed order by
//! [`run_passes`]: deps → placement (uses `server_expr`) → captures →
//! children → cache → tier. Pure functions of the IR, except `children`, which
//! compiles child modules through the [`crate::analyze::modules`] cache.
pub mod captures;
pub mod deps;
pub mod placement;
pub mod server_expr;

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
    /// Locations where render reads a browser global.
    pub browser_locs: Vec<u32>,
    pub handler_names: BTreeSet<String>,
    /// Values the client chunk evaluates, beyond handlers/effects/state inits.
    pub client_uses: Vec<ClientUse>,
}

/// Something the client chunk runs, with what it reads.
#[derive(Debug, Clone)]
pub struct ClientUse {
    pub loc: u32,
    pub deps: deps::Deps,
    /// For messages: `a handler`, `an effect`, ….
    pub what: &'static str,
}

/// Inputs every pass may read.
pub struct PassCtx<'a> {
    /// Source text of the module, for line numbers in messages.
    pub text: &'a [u8],
    pub opts: &'a crate::analyze::component::AnalyzeOptions,
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
    captures::captures(ir, &mut st, ctx);
    st
}
