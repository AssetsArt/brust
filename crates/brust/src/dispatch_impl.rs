//! napi-concrete implementation of [`brust_core::RenderDispatch`].
//!
//! This is the ONLY render-path module that touches napi. It owns the tsfn type
//! alias and the SAB `BufPtr`, both moved here out of `pool.rs` so the core
//! render modules carry zero napi. The render bridge flow (tsfn `call_async`
//! then await the returned Promise) is reproduced exactly as it was inlined in
//! `server.rs`.

use std::sync::Arc;

use napi::bindgen_prelude::{FnArgs, Promise};
use napi::threadsafe_function::ThreadsafeFunction;

use brust_core::{RenderDispatch, RenderError};

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
/// The render slot index is passed as a SECOND tsfn argument (NOT folded into
/// the envelope JSON) so the worker writes its response into the right SAB
/// sub-view and calls `napi_render_chunk` with the right slot — while keeping
/// the K=1 request envelope bytes identical to the pre-multi-slot wire.
///
/// `FnArgs` (not a bare tuple) so the two args are SPREAD as positional JS
/// arguments `(requestJson, slot)` — a bare `(A, B)` tuple would arrive as a
/// single array. The request is always the INLINE JSON `String` (the SAB-request
/// transport is closed for good — see the `dispatch` module doc). CalleeHandled
/// = false matches what Function::build_threadsafe_function().build() produces.
pub type RendererTsfn = ThreadsafeFunction<
    FnArgs<(String, u32)>,
    Promise<u32>,
    FnArgs<(String, u32)>,
    napi::Status,
    false,
>;

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
    /// Number of render slots this worker holds. The SAB (`buf_len` bytes total)
    /// is partitioned into `slots` disjoint sub-regions by the default
    /// `buf_slot` impl; `slot_count` reports this count to the pool/render path.
    pub(crate) slots: usize,
}

impl RenderDispatch for TsfnDispatch {
    fn call(
        &self,
        request_json: String,
        slot: u32,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<u32, RenderError>> + Send>> {
        // Clone the Arc (cheap atomic bump) so the future owns a 'static handle.
        let tsfn = Arc::clone(&self.tsfn);
        Box::pin(async move {
            // The slot is the SECOND tsfn arg so the worker writes the right SAB
            // sub-view; at K=1 it is always 0 and the wire stays identical.
            // `.into()` packs the pair into `FnArgs` for positional spreading.
            match tsfn.call_async((request_json, slot).into()).await {
                // Bridge enqueue failed → worker dead.
                Err(e) => Err(RenderError::EnqueueFailed(e.to_string())),
                // Enqueued; now await the render Promise.
                Ok(promise) => promise
                    .await
                    .map_err(|e| RenderError::PromiseRejected(e.to_string())),
            }
        })
    }

    fn slot_count(&self) -> usize {
        self.slots
    }

    fn buf(&self) -> (*mut u8, usize) {
        (self.buf_ptr.0, self.buf_len)
    }
}
