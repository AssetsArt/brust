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

use napi::bindgen_prelude::{FnArgs, Promise, ToNapiValue};
use napi::threadsafe_function::ThreadsafeFunction;

use brust_server::{CallKind, DispatchError, RenderDispatch};

/// Worker signature: `(kind, requestJson, slot) => Promise<number>`.
///
/// The worker writes the response as plain JSON (no framing) into its slot's
/// sub-region `[slot*sub, slot*sub+sub)` with `sub = floor(len / slots)` and
/// resolves with the byte length (> 0, ≤ sub). `FnArgs` spreads the tuple as
/// positional JS arguments; CalleeHandled = false matches
/// `Function::build_threadsafe_function::<T>().build_callback(|ctx| Ok(ctx.value))`
/// (what `.build()` does, with the data type decoupled from the declared
/// args). `kind` is a `&'static str` on the Rust side (no per-call allocation;
/// napi copies it into a JS string on the worker thread), wrapped in
/// [`KindArg`].
pub type WorkerTsfn = ThreadsafeFunction<
    FnArgs<(KindArg, String, u32)>,
    Promise<u32>,
    FnArgs<(KindArg, String, u32)>,
    napi::Status,
    false,
>;

/// The call kind as the tsfn's first argument: a `&'static str` behind a
/// lifetime-free newtype. A bare `&'static str` inside the tsfn type does not
/// compile here: the dispatch future holds the tsfn across an `.await`, the
/// compiler erases that `'static` in the generator witness, and the tsfn's
/// `Send`/`Sync` impls (which demand `T: 'static`) then cannot be proven
/// ("higher-ranked lifetime error"). The newtype has no lifetime parameter to
/// erase.
pub struct KindArg(pub &'static str);

impl ToNapiValue for KindArg {
    unsafe fn to_napi_value(
        env: napi::sys::napi_env,
        val: Self,
    ) -> napi::Result<napi::sys::napi_value> {
        // SAFETY: forwarded verbatim; the caller upholds `env`'s validity.
        unsafe { <&str as ToNapiValue>::to_napi_value(env, val.0) }
    }
}

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
///
/// Lifetime invariant: the pointer stays valid for as long as the pool may
/// hold this dispatcher, i.e. the process lifetime. `brust start`
/// (`packages/brust/src/run.ts`) allocates every worker's SAB on the MAIN
/// thread, keeps it in a module-level array until the process exits and hands
/// it to the worker (`workerData.sab`); a SAB's backing store is shared and
/// ref-counted across threads, so the worker's isolate going away does not
/// free it. A worker exit makes the process drain and exit (run.ts, no
/// respawn in M2); until then a call to the dead worker fails at the tsfn
/// enqueue (`EnqueueFailed`) and never reads the buffer.
///
/// Not a napi reference: `napi_ref`s belong to the env that created them (the
/// worker's), are invalidated when that env is torn down and may only be
/// released on its thread, so a ref held here would neither keep the store
/// alive past the worker nor be droppable from the server's threads.
/// Main-thread ownership is the guarantee. (A buffer allocated inside the
/// worker, `startWorker()` without `sab`, is only for tests: it lives as long
/// as that worker.)
#[derive(Copy, Clone)]
pub struct BufPtr(pub *mut u8);

// SAFETY: see BufPtr docstring — the backing store outlives every dispatcher
// that can read it (main-thread owned for the process lifetime), and reads are
// ordered after the worker's write by the resolved Promise.
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
                .call_async((KindArg(kind_str(kind)), request_json, slot).into())
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
