//! Render dispatch seam + worker pool + streaming.
//!
//! [`dispatch`] holds the napi-free [`RenderDispatch`] trait that abstracts the
//! two pieces of napi coupling (the tsfn call and the SAB raw pointer). The
//! napi-concrete implementation (`TsfnDispatch`) lives in the `brust` binding
//! crate, outside core. `pool` and `stream` build on the trait.

pub mod dispatch;
pub mod pool;
pub mod stream;

// Crate-internal re-export of the dispatch seam: in-crate callers (server, pool)
// reach the trait + envelope/error through `crate::render::*`. The napi binding
// does NOT use this seam — it goes through the crate-root `pub use` in `lib.rs`
// or full submodule paths — so this stays `pub(crate)`. The `pool` and `stream`
// items are reached via their full `render::pool::*` / `render::stream::*` paths,
// so they need no mod-level re-export.
pub(crate) use dispatch::{RenderDispatch, RenderEnvelope, RenderError};
