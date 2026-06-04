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
/// - `Sab(len)`: the dispatcher already serialized the request envelope into the
///   worker's SharedArrayBuffer; `len` is its byte length (the SAB fast lane).
/// - `Inline(json)`: an inline JSON envelope (SSE/WS handoff) passed by value.
#[non_exhaustive]
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
    fn buf_ptr(&self) -> *mut u8;
    fn buf_len(&self) -> usize;
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
    fn buf_ptr(&self) -> *mut u8 {
        self.ptr
    }
    fn buf_len(&self) -> usize {
        self.len
    }
}
