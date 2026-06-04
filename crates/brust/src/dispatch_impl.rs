//! napi-concrete implementation of [`brust_core::RenderDispatch`].
//!
//! This is the ONLY render-path module that touches napi. It owns the tsfn type
//! alias and the SAB `BufPtr`, both moved here out of `pool.rs` so the core
//! render modules carry zero napi. The render bridge flow (tsfn `call_async`
//! then await the returned Promise) is reproduced exactly as it was inlined in
//! `server.rs`.

use std::sync::Arc;

use napi::bindgen_prelude::{Either, Promise};
use napi::threadsafe_function::ThreadsafeFunction;

use brust_core::{RenderDispatch, RenderEnvelope, RenderError};

/// Renderer signature: takes the envelope (SAB len as `u32`, or inline JSON
/// `String`) and resolves with a `u32` framed-response length.
///
/// Two response protocols, selected by the resolved `u32`:
/// - **Fast lane** (`len > 0`): the worker wrote a complete framed single-chunk
///   response `[meta_len: u16 BE][meta JSON][body]` into the SAB and resolved
///   with its byte length. Rust reads it directly after `promise.await` — no
///   chunk channel, no per-chunk ack round-trip. Used for action/native/render
///   responses that fit in one chunk.
/// - **Chunk channel** (`len == 0`): the worker streamed bytes via
///   `napi_render_chunk` through the per-worker `RenderSlot.chunk_tx`. Used for
///   React Suspense streaming; SSE/WS resolve 0 too (they own the socket
///   independently via napiSse*/napiWs*).
///
/// CalleeHandled = false matches what Function::build_threadsafe_function().build() produces.
pub type RendererTsfn =
    ThreadsafeFunction<Either<u32, String>, Promise<u32>, Either<u32, String>, napi::Status, false>;

/// Raw pointer to the worker's SharedArrayBuffer backing store. Send+Sync because the
/// backing store is process-global memory (V8 allocates SAB backing outside the GC heap)
/// and only read by Rust AFTER the worker's render callback resolves (napi tsfn.await
/// provides the happens-before).
#[derive(Copy, Clone)]
pub struct BufPtr(pub *mut u8);

// SAFETY: see BufPtr docstring. The Bun Worker keeps the SAB rooted in its module
// scope, so the backing store lives for the worker's whole lifetime.
unsafe impl Send for BufPtr {}
unsafe impl Sync for BufPtr {}

/// The tsfn-backed render dispatcher registered per worker.
///
/// The tsfn is held in an `Arc` so each `call` can move an owned, `'static`
/// handle into the returned boxed future (napi 3.x's `ThreadsafeFunction` does
/// not implement `Clone`; its internal handle is already `Arc`-backed and the
/// type is `Send + Sync`, so wrapping it costs one atomic refcount per call —
/// the same cheap-clone semantics the original inline tsfn dispatch relied on).
pub struct TsfnDispatch {
    pub(crate) tsfn: Arc<RendererTsfn>,
    pub(crate) buf_ptr: BufPtr,
    pub(crate) buf_len: usize,
}

impl RenderDispatch for TsfnDispatch {
    fn call(
        &self,
        env: RenderEnvelope,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<u32, RenderError>> + Send>> {
        let either = match env {
            RenderEnvelope::Sab(n) => Either::A(n),
            RenderEnvelope::Inline(s) => Either::B(s),
            // `RenderEnvelope` is `#[non_exhaustive]` and lives in `brust-core`,
            // so a cross-crate match needs a catch-all. A future variant would
            // hit this; treat an unknown envelope as an empty inline payload.
            _ => Either::B(String::new()),
        };
        // Clone the Arc (cheap atomic bump) so the future owns a 'static handle.
        let tsfn = Arc::clone(&self.tsfn);
        Box::pin(async move {
            match tsfn.call_async(either).await {
                // Bridge enqueue failed → worker dead.
                Err(e) => Err(RenderError::EnqueueFailed(e.to_string())),
                // Enqueued; now await the render Promise.
                Ok(promise) => promise
                    .await
                    .map_err(|e| RenderError::PromiseRejected(e.to_string())),
            }
        })
    }

    fn buf(&self) -> (*mut u8, usize) {
        (self.buf_ptr.0, self.buf_len)
    }
}
