//! M1b-2 passes over the structural IR, run in a fixed order by
//! [`run_passes`]: deps → placement (uses `server_expr`) → captures →
//! children → cache → tier. Pure functions of the IR, except `children`, which
//! compiles child modules through the [`crate::analyze::modules`] cache.
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
pub fn run_passes(ir: &mut ComponentIR) -> PassState {
    let mut st = PassState::new(ir);
    placement::place(ir, &mut st);
    st
}
