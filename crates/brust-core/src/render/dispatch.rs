//! `RenderDispatch` — the napi-free seam between the render path and the worker.
//!
//! The only real napi coupling in the soon-to-be-core modules was (a) the tsfn
//! call `RendererTsfn::call_async(Either<u32, String>) -> Promise<u32>` and (b)
//! the SAB raw pointer. Both are abstracted here so `pool.rs`/`server.rs` carry
//! zero napi. The concrete tsfn-backed impl is `crate::dispatch_impl::TsfnDispatch`.

use std::future::Future;
use std::pin::Pin;

/// The render envelope handed to a worker.
///
/// - `Inline(json)`: the request envelope marshaled as a JSON string through
///   napi. This is the ONLY variant the dispatch paths construct.
/// - `Sab(len)`: legacy "write the request into the worker's SharedArrayBuffer,
///   pass the byte length" fast lane. **DO NOT REINTRODUCE for request passing.**
///   Under the multi-thread tokio runtime the Rust-side SAB write was not
///   reliably visible to the Bun worker thread (the worker read its own stale
///   prior response from the SAB → corrupt envelope / `meta_len exceeds chunk
///   size` under load). The tsfn call did not publish the SAB write across cores
///   the way a single-thread runtime's timing masked. Requests go `Inline`; the
///   SAB is used only for the worker's RESPONSE (read back via `napi_render_chunk`'s
///   copy, which the napi call publishes correctly). The variant is retained only
///   because `TsfnDispatch::call` still maps it; nothing constructs it.
pub enum RenderEnvelope {
    Sab(u32),
    Inline(String),
}

/// Failure layers from a render dispatch, mirroring the old
/// `RenderOutcome::{EnqueueFailed, PromiseRejected}` napi arms.
///
/// - `EnqueueFailed`: the bridge enqueue itself failed (worker dead) — caller
///   removes the worker from the pool.
/// - `PromiseRejected`: a JS-level error rejected the render Promise — the
///   worker is still alive.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum RenderError {
    #[error("enqueue failed: {0}")]
    EnqueueFailed(String),
    #[error("promise rejected: {0}")]
    PromiseRejected(String),
}

/// Abstracts the worker render bridge: an async call that resolves with a
/// framed-response length (the protocol u32 — `> 0` fast lane, `0` chunk
/// channel), plus access to the worker's SAB backing store.
pub trait RenderDispatch: Send + Sync + 'static {
    fn call(
        &self,
        env: RenderEnvelope,
    ) -> Pin<Box<dyn Future<Output = Result<u32, RenderError>> + Send>>;

    /// The worker's SAB backing store as a `(ptr, len)` pair. Returned together
    /// so a raw pointer can never be obtained without its matching capacity —
    /// this prevents pairing a pointer from one entry with a length from another
    /// (a mismatched-ptr/len OOB-write / use-after-free footgun).
    fn buf(&self) -> (*mut u8, usize);

    /// Just the SAB capacity, for standalone bounds checks. Defaults to the
    /// length component of [`RenderDispatch::buf`].
    fn buf_len(&self) -> usize {
        self.buf().1
    }
}

/// In-process mock for pool/render unit tests: a leaked 256 KiB buffer (no napi)
/// and a `call` that resolves `Ok(0)`.
#[cfg(test)]
pub struct MockDispatch {
    ptr: *mut u8,
    len: usize,
}

#[cfg(test)]
impl MockDispatch {
    pub fn new() -> Self {
        let b = vec![0u8; 256 * 1024].into_boxed_slice();
        let len = b.len();
        let ptr = Box::leak(b).as_mut_ptr();
        Self { ptr, len }
    }
}

#[cfg(test)]
impl Default for MockDispatch {
    fn default() -> Self {
        Self::new()
    }
}

// SAFETY: the buffer is leaked (process-global) and never aliased mutably across
// threads in tests; same justification as the production `BufPtr`.
#[cfg(test)]
unsafe impl Send for MockDispatch {}
#[cfg(test)]
unsafe impl Sync for MockDispatch {}

#[cfg(test)]
impl RenderDispatch for MockDispatch {
    fn call(
        &self,
        _env: RenderEnvelope,
    ) -> Pin<Box<dyn Future<Output = Result<u32, RenderError>> + Send>> {
        Box::pin(async { Ok(0u32) })
    }
    fn buf(&self) -> (*mut u8, usize) {
        (self.ptr, self.len)
    }
}
