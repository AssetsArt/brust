//! `RenderDispatch` — the napi-free seam between the render path and the worker.
//!
//! The only real napi coupling in the soon-to-be-core modules was (a) the tsfn
//! call `RendererTsfn::call_async(String) -> Promise<u32>` and (b) the SAB raw
//! pointer. Both are abstracted here so `pool.rs`/`server.rs` carry zero napi.
//! The concrete tsfn-backed impl is `crate::dispatch_impl::TsfnDispatch`.
//!
//! REQUEST transport — DO NOT change to SharedArrayBuffer. The render request
//! envelope crosses to the worker INLINE, as a JSON `String` marshaled through
//! napi. Passing it via the SAB instead was tried twice and CLOSED both times:
//! (1) under the multi-thread tokio runtime the Rust-side SAB write was not
//! reliably visible to the Bun worker thread — the worker read a stale prior
//! response from the SAB as the request (`JSON Parse error: Unrecognized token`
//! / `meta_len exceeds chunk size` under load); (2) re-evaluated 2026-06-05
//! (Phase C) with per-slot DISJOINT SAB regions, soaked 120-conn — it STILL
//! corrupted (genuine cross-core visibility/timing: weak-ordered HW + non-atomic
//! JS TypedArray SAB reads, not aliasing), AND bought nothing (`Sab` ≈ `Inline`
//! throughput — both serialize in Rust + `JSON.parse` in JS; the transport swap
//! is a wash). `Inline` is the permanent request carrier. The SAB is used ONLY
//! for the worker's RESPONSE (Rust is the reader there, with atomic semantics
//! under its own control). Do not try SAB-request a third time.
//!
//! v2 (brust-server): the seam carries two call kinds ([`CallKind::Loader`],
//! [`CallKind::Jobs`]) instead of a render, and the worker's response in the
//! slot is plain JSON (no `[meta_len][meta][body]` framing). [`call_worker`] is
//! the only reader of the SAB.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::pool::{ClaimResult, RenderClaim, WorkerPool};

/// Which worker entry point a [`RenderDispatch::call`] targets (spec §1 S1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CallKind {
    Loader,
    Jobs,
}

/// Failure layers from a worker dispatch, mirroring the old
/// `RenderOutcome::{EnqueueFailed, PromiseRejected}` napi arms.
///
/// - `EnqueueFailed`: the bridge enqueue itself failed (worker dead) — caller
///   removes the worker from the pool.
/// - `PromiseRejected`: a JS-level error rejected the call Promise — the
///   worker is still alive.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum DispatchError {
    #[error("enqueue failed: {0}")]
    EnqueueFailed(String),
    #[error("promise rejected: {0}")]
    PromiseRejected(String),
}

/// Abstracts the worker bridge: an async call that resolves with the byte
/// length of the JSON response the worker wrote into its SAB slot, plus access
/// to the worker's SAB backing store.
pub trait RenderDispatch: Send + Sync + 'static {
    /// `request_json` is INLINE (see module doc); the worker writes the response
    /// JSON into `buf_slot(slot)` and resolves with its byte length (> 0).
    fn call(
        &self,
        kind: CallKind,
        request_json: String,
        slot: u32,
    ) -> Pin<Box<dyn Future<Output = Result<u32, DispatchError>> + Send>>;

    /// Number of render slots this worker holds. Each slot is an independent
    /// in-flight render reservation backed by a disjoint sub-region of the SAB
    /// (see [`RenderDispatch::buf_slot`]). Defaults to 1 (single in-flight
    /// render per worker — byte-identical to the pre-multi-slot behaviour).
    fn slot_count(&self) -> usize {
        1
    }

    /// The worker's SAB backing store as a `(ptr, len)` pair. Returned together
    /// so a raw pointer can never be obtained without its matching capacity —
    /// this prevents pairing a pointer from one entry with a length from another
    /// (a mismatched-ptr/len OOB-write / use-after-free footgun).
    fn buf(&self) -> (*mut u8, usize);

    /// The disjoint SAB sub-region reserved for `slot` as a `(ptr, cap)` pair.
    ///
    /// With `(base, total) = self.buf()` and `k = self.slot_count()`, the
    /// per-slot capacity is `sub = total / k` and slot `i` owns the bytes
    /// `[i * sub, i * sub + sub)`. The slots are disjoint and tile `[0, total)`;
    /// when `k` does not divide `total` evenly the trailing `total % k` bytes
    /// are unused (acceptable). All the offset-0-relative read/write code stays
    /// correct because it now operates relative to the slot's base pointer.
    ///
    /// At `k == 1` this returns the whole buffer, so single-slot callers are
    /// byte-identical to [`RenderDispatch::buf`].
    fn buf_slot(&self, slot: u32) -> (*mut u8, usize) {
        let (base, total) = self.buf();
        // `.max(1)` guards against a (mis)implementation returning 0 → div-by-zero.
        let k = self.slot_count().max(1);
        let sub = total / k;
        // Defense-in-depth: an out-of-range `slot` must NEVER produce out-of-bounds
        // pointer arithmetic (UB even if the pointer is never dereferenced). Callers
        // that hold a `RenderClaim` always pass a valid slot, and the napi entry
        // points (`napi_render_chunk`/`_final`/`_jinja`) bounds-check the JS-supplied
        // slot and return a clean `Err` before reaching here. This clamp is the last
        // line: a bad slot yields a benign in-bounds `(base, 0)` region — zero
        // capacity makes every downstream bounds check fail safely instead of UB.
        if slot as usize >= k {
            return (base, 0);
        }
        // SAFETY: `slot < k` (checked above) ⇒ `slot * sub + sub <= k * sub <= total`,
        // so the offset stays within the backing store.
        let ptr = unsafe { base.add(slot as usize * sub) };
        (ptr, sub)
    }

    /// Just the SAB capacity, for standalone bounds checks. Defaults to the
    /// length component of [`RenderDispatch::buf`].
    fn buf_len(&self) -> usize {
        self.buf().1
    }
}

/// Why a [`call_worker`] round trip produced no response.
#[derive(Debug, thiserror::Error)]
pub enum CallError {
    /// No workers registered at all — none will ever appear, so 503 at once.
    #[error("no workers")]
    NoWorkers,
    /// Every worker stayed busy until the claim timeout — 503 last-resort.
    #[error("all workers busy")]
    Timeout,
    /// The bridge enqueue failed; the worker was removed from the pool.
    #[error("worker dead: {0}")]
    Enqueue(String),
    /// The worker's Promise rejected; the worker is still alive.
    #[error("worker rejected: {0}")]
    Rejected(String),
    /// Request serialisation, an out-of-bounds length, or unparsable JSON.
    #[error("bad response: {0}")]
    BadResponse(String),
}

/// Claim a worker slot, AWAITING a free one (up to `timeout`) on AllBusy
/// instead of failing fast with 503. `PoolEmpty` is never waited on.
pub async fn claim_or_wait(
    pool: &WorkerPool,
    timeout: Duration,
    mut try_claim: impl FnMut() -> ClaimResult,
) -> Result<RenderClaim, CallError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let notified = pool.idle_notify().notified();
        tokio::pin!(notified);
        notified.as_mut().enable();

        match try_claim() {
            ClaimResult::Claimed(c) => return Ok(c),
            ClaimResult::PoolEmpty => return Err(CallError::NoWorkers),
            ClaimResult::AllBusy => {}
        }

        tokio::select! {
            _ = &mut notified => {}
            _ = tokio::time::sleep_until(deadline) => return Err(CallError::Timeout),
        }
    }
}

/// One round trip: claim (lockfree) → serialize → call → bounds-check len →
/// from_slice → release claim on every path.
///
/// Cancel-safe: once the claim is taken, the call, the bounds check and the
/// parse run in a spawned task that OWNS the claim. If the caller's future is
/// dropped (hyper drops the request future on client disconnect), the task
/// keeps the slot claimed until the worker's call settles, so the SAB slot is
/// never handed to another request while JS may still be writing it (the
/// `RenderClaim` drop invariant in `pool.rs`).
pub async fn call_worker<Req: Serialize, Resp: DeserializeOwned + Send + 'static>(
    pool: &Arc<WorkerPool>,
    timeout: Duration,
    kind: CallKind,
    req: &Req,
) -> Result<Resp, CallError> {
    let claim = claim_or_wait(pool, timeout, || pool.try_claim_render_lockfree()).await?;
    let json = serde_json::to_string(req)
        .map_err(|e| CallError::BadResponse(format!("request serialise: {e}")))?;
    let pool = Arc::clone(pool);
    let task = tokio::spawn(async move {
        let entry = Arc::clone(claim.entry());
        let slot = claim.slot();
        let len = match entry.dispatch.call(kind, json, slot).await {
            Ok(n) => n,
            Err(DispatchError::EnqueueFailed(m)) => {
                tracing::error!(worker_id = entry.id(), ?kind, error = %m, "enqueue failed — worker dead, removing from pool");
                pool.remove(entry.id());
                return Err(CallError::Enqueue(m));
            }
            Err(DispatchError::PromiseRejected(m)) => return Err(CallError::Rejected(m)),
        };
        let (ptr, cap) = entry.dispatch.buf_slot(slot);
        if len == 0 || len as usize > cap {
            return Err(CallError::BadResponse(format!(
                "resp_len {len} outside (0, {cap}]"
            )));
        }
        // SAFETY: the worker's Promise resolved (happens-before through the dispatch
        // future), JS is done writing this slot's sub-region; `len` is bounds-checked
        // above; `claim` is still held so no other request can write the slot.
        let bytes = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
        let parsed = serde_json::from_slice::<Resp>(bytes)
            .map_err(|e| CallError::BadResponse(e.to_string()));
        drop(claim);
        parsed
    });
    task.await
        .map_err(|e| CallError::BadResponse(format!("worker call task: {e}")))?
}

/// In-process mock for pool/dispatch unit tests: a leaked 256 KiB buffer (no
/// napi) and a `call` that resolves `Ok(0)` — or, when built with
/// [`MockDispatch::replying`], writes a canned response into the slot and
/// resolves with its length (or a forced length via `reply_len`).
#[cfg(test)]
pub struct MockDispatch {
    ptr: *mut u8,
    len: usize,
    slots: usize,
    reply: Option<Vec<u8>>,
    reply_len: Option<u32>,
}

#[cfg(test)]
impl MockDispatch {
    pub fn new() -> Self {
        Self::with_slots(1)
    }

    /// Like [`MockDispatch::new`] but with `k` render slots. The leaked buffer
    /// scales to `k * 256 KiB` so each slot keeps the single-slot capacity.
    pub fn with_slots(k: usize) -> Self {
        let k = k.max(1);
        let b = vec![0u8; 256 * 1024 * k].into_boxed_slice();
        let len = b.len();
        let ptr = Box::leak(b).as_mut_ptr();
        Self {
            ptr,
            len,
            slots: k,
            reply: None,
            reply_len: None,
        }
    }

    /// Single-slot mock whose `call` copies `reply` into the slot and resolves
    /// with `reply.len()`.
    pub fn replying(reply: &[u8]) -> Self {
        Self {
            reply: Some(reply.to_vec()),
            ..Self::new()
        }
    }

    /// Single-slot mock whose `call` resolves with `len` without writing.
    pub fn reply_len(len: u32) -> Self {
        Self {
            reply_len: Some(len),
            ..Self::new()
        }
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
        _kind: CallKind,
        _request_json: String,
        slot: u32,
    ) -> Pin<Box<dyn Future<Output = Result<u32, DispatchError>> + Send>> {
        if let Some(n) = self.reply_len {
            return Box::pin(async move { Ok(n) });
        }
        let Some(reply) = &self.reply else {
            return Box::pin(async { Ok(0u32) });
        };
        let (dst, cap) = self.buf_slot(slot);
        assert!(reply.len() <= cap, "mock reply exceeds slot capacity");
        // SAFETY: `dst` is this slot's in-bounds sub-region of the leaked buffer
        // (cap checked above); the caller holds the slot's claim.
        unsafe { std::ptr::copy_nonoverlapping(reply.as_ptr(), dst, reply.len()) };
        let n = reply.len() as u32;
        Box::pin(async move { Ok(n) })
    }
    fn slot_count(&self) -> usize {
        self.slots
    }
    fn buf(&self) -> (*mut u8, usize) {
        (self.ptr, self.len)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Offset of a slot's base pointer from the buffer base, in bytes.
    fn off(d: &MockDispatch, slot: u32) -> usize {
        let (base, _) = d.buf();
        let (p, _) = d.buf_slot(slot);
        (p as usize) - (base as usize)
    }

    #[test]
    fn buf_slot_disjoint_and_tiles() {
        let d = MockDispatch::with_slots(4);
        let (_, total) = d.buf();
        let sub = total / 4;
        // Each slot starts at i*sub with capacity sub: disjoint, in-bounds, tiling.
        for i in 0..4u32 {
            let (_, cap) = d.buf_slot(i);
            assert_eq!(cap, sub, "slot {i} cap");
            assert_eq!(off(&d, i), i as usize * sub, "slot {i} offset");
            // Last byte of this slot stays within the backing store.
            assert!(off(&d, i) + cap <= total, "slot {i} overruns buffer");
        }
        // Adjacent slots don't overlap: slot i ends exactly where slot i+1 begins.
        for i in 0..3u32 {
            assert_eq!(
                off(&d, i) + sub,
                off(&d, i + 1),
                "slots {i}/{} overlap",
                i + 1
            );
        }
    }

    #[test]
    fn buf_slot_k1_is_whole_buffer() {
        let d = MockDispatch::new();
        assert_eq!(d.slot_count(), 1);
        let (bp, bl) = d.buf();
        let (sp, sl) = d.buf_slot(0);
        assert_eq!(sp, bp, "k=1 slot 0 base must equal buf base");
        assert_eq!(sl, bl, "k=1 slot 0 cap must equal whole buffer");
    }

    #[test]
    fn buf_slot_out_of_range_is_benign_not_ub() {
        // An out-of-range slot must NEVER produce out-of-bounds pointer math.
        // It returns the buffer base with ZERO capacity, so callers' bounds checks
        // fail safely. (Guards the napi_render_jinja JS-supplied-slot path.)
        let d = MockDispatch::with_slots(4);
        let (base, _) = d.buf();
        for bad in [4u32, 5, 1000, u32::MAX] {
            let (p, cap) = d.buf_slot(bad);
            assert_eq!(cap, 0, "out-of-range slot {bad} must have zero cap");
            assert_eq!(
                p, base,
                "out-of-range slot {bad} must stay at base (no OOB add)"
            );
        }
    }

    fn pool_with(d: MockDispatch) -> Arc<WorkerPool> {
        let pool = Arc::new(WorkerPool::new());
        pool.register(Box::new(d));
        pool
    }

    #[tokio::test(flavor = "current_thread")]
    async fn call_worker_round_trips_json() {
        let pool = pool_with(MockDispatch::replying(br#"{"ok":true,"data":{"x":1}}"#));
        let v: serde_json::Value = call_worker(
            &pool,
            Duration::from_millis(100),
            CallKind::Loader,
            &serde_json::json!({"routeId": "r1"}),
        )
        .await
        .expect("round trip");
        assert_eq!(v, serde_json::json!({"ok": true, "data": {"x": 1}}));
        // The claim was released: the only slot is claimable again.
        assert!(matches!(
            pool.try_claim_render_lockfree(),
            ClaimResult::Claimed(_)
        ));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn call_worker_returns_bad_response_on_len_over_capacity() {
        let pool = pool_with(MockDispatch::reply_len(256 * 1024 + 1));
        let r = call_worker::<_, serde_json::Value>(
            &pool,
            Duration::from_millis(100),
            CallKind::Jobs,
            &serde_json::json!({"jobs": []}),
        )
        .await;
        assert!(matches!(r, Err(CallError::BadResponse(_))), "{r:?}");
        // Released on the error path too.
        assert!(matches!(
            pool.try_claim_render_lockfree(),
            ClaimResult::Claimed(_)
        ));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn claim_or_wait_times_out_when_all_busy() {
        let pool = pool_with(MockDispatch::new());
        let _held = match pool.try_claim_render_lockfree() {
            ClaimResult::Claimed(c) => c,
            _ => panic!("expected Claimed"),
        };
        let t0 = std::time::Instant::now();
        let r = claim_or_wait(&pool, Duration::from_millis(50), || {
            pool.try_claim_render_lockfree()
        })
        .await;
        let el = t0.elapsed();
        assert!(matches!(r, Err(CallError::Timeout)), "{:?}", r.err());
        assert!(el >= Duration::from_millis(50), "returned early: {el:?}");
        assert!(el < Duration::from_millis(500), "returned late: {el:?}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn claim_or_wait_wakes_when_claim_released() {
        let pool = pool_with(MockDispatch::new());
        let held = match pool.try_claim_render_lockfree() {
            ClaimResult::Claimed(c) => c,
            _ => panic!("expected Claimed"),
        };
        let releaser = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            drop(held);
        });
        let t0 = std::time::Instant::now();
        let r = claim_or_wait(&pool, Duration::from_secs(5), || {
            pool.try_claim_render_lockfree()
        })
        .await;
        assert!(
            r.is_ok(),
            "expected a claim after release, got {:?}",
            r.err()
        );
        assert!(
            t0.elapsed() < Duration::from_secs(1),
            "woke by timeout, not by release"
        );
        releaser.await.unwrap();
    }

    /// Resolves its call only when the test fires the oneshot; the reply is
    /// written into the slot up front.
    struct GatedDispatch {
        inner: MockDispatch,
        gate: parking_lot::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
    }

    impl RenderDispatch for GatedDispatch {
        fn call(
            &self,
            kind: CallKind,
            request_json: String,
            slot: u32,
        ) -> Pin<Box<dyn Future<Output = Result<u32, DispatchError>> + Send>> {
            let reply = self.inner.call(kind, request_json, slot);
            let gate = self.gate.lock().take().expect("one call");
            Box::pin(async move {
                let _ = gate.await;
                reply.await
            })
        }
        fn buf(&self) -> (*mut u8, usize) {
            self.inner.buf()
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn call_worker_keeps_slot_claimed_after_caller_drops() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let pool = Arc::new(WorkerPool::new());
        pool.register(Box::new(GatedDispatch {
            inner: MockDispatch::replying(br#"{"ok":true}"#),
            gate: parking_lot::Mutex::new(Some(rx)),
        }));
        // The caller gives up mid-call (hyper dropping the request future).
        let r = tokio::time::timeout(
            Duration::from_millis(20),
            call_worker::<_, serde_json::Value>(
                &pool,
                Duration::from_millis(100),
                CallKind::Loader,
                &serde_json::json!({}),
            ),
        )
        .await;
        assert!(r.is_err(), "the call must still be pending");
        // The worker has not settled: the slot must stay claimed.
        assert!(matches!(
            pool.try_claim_render_lockfree(),
            ClaimResult::AllBusy
        ));
        tx.send(()).unwrap();
        // Once the worker settles, the spawned task releases the slot.
        let t0 = std::time::Instant::now();
        loop {
            if let ClaimResult::Claimed(_) = pool.try_claim_render_lockfree() {
                break;
            }
            assert!(t0.elapsed() < Duration::from_secs(2), "slot never released");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}
