//! Render dispatch seam + worker pool + streaming.
//!
//! [`dispatch`] holds the napi-free [`RenderDispatch`] trait that abstracts the
//! two pieces of napi coupling (the tsfn call and the SAB raw pointer). The
//! napi-concrete implementation (`TsfnDispatch`) lives in the `brust` binding
//! crate, outside core. `pool` and `stream` build on the trait.

pub mod dispatch;
pub mod pool;
pub mod stream;

pub use dispatch::{RenderDispatch, RenderEnvelope, RenderError};
pub use pool::{ClaimResult, RenderChunk, RenderClaim, RenderSlot, TsfnEntry, WorkerPool};
pub use stream::{
    ChunkMeta, build_chunked_response_head, build_single_response_bytes, check_chunk_dispatch,
    format_chunk_framed, split_meta,
};
