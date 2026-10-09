//! napi-concrete [`RenderDispatch`]: the worker's tsfn plus its SAB backing store.
//!
//! Adapted from 0.1.x `crates/brust/src/dispatch_impl.rs` with four changes:
//! `brust_server` types, the call kind as the FIRST tsfn argument, the trait's
//! `kind` parameter, and `pub` fields (the binding builds them in `server.rs`).
//! Requests cross INLINE as JSON; the SAB carries the worker's RESPONSE only
//! (see `brust_server::dispatch` module doc — never try an SAB request).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use napi::bindgen_prelude::{FnArgs, Promise};
use napi::threadsafe_function::ThreadsafeFunction;

use brust_server::{CallKind, DispatchError, RenderDispatch};

/// Worker signature: `(kind, requestJson, slot) => Promise<number>`.
///
/// The worker writes the response as plain JSON (no framing) into its slot's
/// sub-region `[slot*sub, slot*sub+sub)` with `sub = floor(len / slots)` and
/// resolves with the byte length (> 0, ≤ sub). `FnArgs` spreads the tuple as
/// positional JS arguments; CalleeHandled = false matches
/// `Function::build_threadsafe_function().build()`.
pub type WorkerTsfn = ThreadsafeFunction<
    FnArgs<(String, String, u32)>,
    Promise<u32>,
    FnArgs<(String, String, u32)>,
    napi::Status,
    false,
>;

/// The JS-facing name of a call kind (the tsfn's first argument).
pub fn kind_str(k: CallKind) -> &'static str {
    match k {
        CallKind::Loader => "loader",
        CallKind::Jobs => "jobs",
    }
}

/// Raw pointer to the worker's SharedArrayBuffer backing store. Send+Sync
/// because the backing store lives outside the GC heap and Rust reads it only
/// AFTER the worker's Promise resolved (the tsfn await is the happens-before).
#[derive(Copy, Clone)]
pub struct BufPtr(pub *mut u8);

// SAFETY: see BufPtr docstring. The Bun Worker keeps the SAB rooted in its
// module scope, so the backing store lives for the worker's whole lifetime.
unsafe impl Send for BufPtr {}
unsafe impl Sync for BufPtr {}

/// The tsfn-backed dispatcher registered per worker. The tsfn sits in an `Arc`
/// so each call moves an owned `'static` handle into its boxed future.
pub struct TsfnDispatch {
    pub tsfn: Arc<WorkerTsfn>,
    pub buf_ptr: BufPtr,
    pub buf_len: usize,
    /// Slots the SAB is partitioned into (the default `buf_slot` does the math).
    pub slots: usize,
}

impl RenderDispatch for TsfnDispatch {
    fn call(
        &self,
        kind: CallKind,
        request_json: String,
        slot: u32,
    ) -> Pin<Box<dyn Future<Output = Result<u32, DispatchError>> + Send>> {
        let tsfn = Arc::clone(&self.tsfn);
        Box::pin(async move {
            match tsfn
                .call_async((kind_str(kind).to_string(), request_json, slot).into())
                .await
            {
                // Bridge enqueue failed → worker dead.
                Err(e) => Err(DispatchError::EnqueueFailed(e.to_string())),
                // Enqueued; now await the worker's Promise.
                Ok(promise) => promise
                    .await
                    .map_err(|e| DispatchError::PromiseRejected(e.to_string())),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_names_match_the_wire() {
        assert_eq!(kind_str(CallKind::Loader), "loader");
        assert_eq!(kind_str(CallKind::Jobs), "jobs");
        // The same spelling `CallKind` serialises to (protocol + logs).
        assert_eq!(
            serde_json::to_string(&CallKind::Loader).unwrap(),
            "\"loader\""
        );
        assert_eq!(serde_json::to_string(&CallKind::Jobs).unwrap(), "\"jobs\"");
    }
}
