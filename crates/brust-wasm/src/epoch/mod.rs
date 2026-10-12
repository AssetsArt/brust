//! The cache adapter's pull broadcast on Workers (cache adapters spec §4.2.5): the cursor (pure,
//! host-tested) and the per-request sync that drives it (wasm only). The invalidation floor the
//! replay raises lives in `brust_core::l2` (shared with native, ruling L7c).
pub mod cursor;
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
pub mod sync;
