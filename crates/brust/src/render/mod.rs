//! Render dispatch seam.
//!
//! This module abstracts the two pieces of napi coupling in the render path
//! behind the [`RenderDispatch`] trait so the surrounding logic (pool, server,
//! routing, streaming) can be extracted into a pure-Rust `brust-core` crate
//! later. The napi-concrete implementation lives in `crate::dispatch_impl`
//! (`TsfnDispatch`), outside this module.

pub mod dispatch;

pub use dispatch::{RenderDispatch, RenderEnvelope, RenderError};
