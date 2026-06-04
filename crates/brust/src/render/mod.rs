//! Render dispatch seam.
//!
//! This module abstracts the two pieces of napi coupling in the render path
//! behind the [`RenderDispatch`] trait so the surrounding logic (pool, server,
//! routing, streaming) can be extracted into a pure-Rust `brust-core` crate
//! later. The napi-concrete implementation lives in `crate::dispatch_impl`
//! (`TsfnDispatch`), outside this module.

// Crate-internal: the stable seam items are re-exported below; the module itself
// stays crate-private so nothing outside reaches past the trait (incl. the
// test-only MockDispatch).
pub(crate) mod dispatch;

pub use dispatch::{RenderDispatch, RenderEnvelope, RenderError};
