//! Lowering (spec §4.4, §6, §7): a complete `ComponentIR` to the three
//! artifacts — the minijinja template Rust renders, the precompute job module
//! (`.server.ts`) and the react-free directive chunk (`.client.js`). Consumes
//! only the IR: nothing here names a Bun type (`tests/lower_isolation.rs`).
pub mod server_expr;

use crate::ir::{ComponentIR, Diagnostic};

pub struct LowerCtx<'a> {
    /// Child component id → its IR (from the analysis `ModuleCache`).
    pub resolve: &'a dyn Fn(&str) -> Option<&'a ComponentIR>,
    /// Module specifier the chunk imports the runtime from.
    pub runtime_import: &'a str,
}

pub const DEFAULT_RUNTIME_IMPORT: &str = "brust/runtime-dom";

#[derive(Debug, Clone, Default)]
pub struct Artifacts {
    pub jinja: String,
    pub server_ts: Option<String>,
    pub client_js: Option<String>,
    /// Every member the chunk exports, in order.
    pub members: Vec<String>,
}

pub fn lower(_ir: &ComponentIR, _ctx: &LowerCtx<'_>) -> Result<Artifacts, Diagnostic> {
    Ok(Artifacts::default())
}
