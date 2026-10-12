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
//! v2 (brust-server): the seam carries three call kinds ([`CallKind::Loader`],
//! [`CallKind::Jobs`], [`CallKind::Fetch`]) instead of a render. `fetch` answers
//! are framed (A2, [`decode_fetch_frame`]); loader/jobs stay plain JSON.
//! `call_worker_decoded` is the only reader of the SAB.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::Poll;
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::pool::{ClaimResult, PlanBox, RenderClaim, WorkerEntry, WorkerPool};
use crate::protocol::{FetchMeta, FetchRequest, FetchResponse};
pub use brust_core::host::CallError;

/// Which worker entry point a [`RenderDispatch::call`] targets (spec §1 S1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CallKind {
    Loader,
    Jobs,
    Fetch,
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

/// Claim a worker slot, AWAITING a free one (up to `timeout`) on AllBusy
/// instead of failing fast with 503. `PoolEmpty` is never waited on.
pub async fn claim_or_wait(
    pool: &WorkerPool,
    timeout: Duration,
    mut try_claim: impl FnMut() -> ClaimResult,
) -> Result<RenderClaim, CallError> {
    // M3-P P7: claim first; register on `idle_notify` only when every slot is busy (its
    // `poll_notified`/`drop_notified` lock showed up on probe I). A stored permit from a release
    // nobody waited on is harmless: the loop re-checks `try_claim` after every wake.
    match try_claim() {
        ClaimResult::Claimed(c) => return Ok(c),
        ClaimResult::PoolEmpty => return Err(CallError::NoWorkers),
        ClaimResult::AllBusy => {}
    }
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
/// parse run inline inside [`Detach`]: if the caller's future is dropped (hyper
/// drops the request future on client disconnect; the deadline below), the
/// remainder is spawned and keeps the slot claimed until the worker's call
/// settles, so the SAB slot is never handed to another request while JS may
/// still be writing it (the `RenderClaim` drop invariant in `pool.rs`).
pub async fn call_worker<Req: Serialize, Resp: DeserializeOwned + Send + 'static>(
    pool: &Arc<WorkerPool>,
    timeout: Duration,
    call_timeout: Duration,
    kind: CallKind,
    req: &Req,
) -> Result<Resp, CallError> {
    call_worker_planned(pool, timeout, call_timeout, kind, req, None)
        .await
        .map(|(r, _)| r)
}

/// A planned call's outcome: the response and the slot cell's content after the call.
type PlannedResult<Resp> = Result<(Resp, Option<PlanBox>), CallError>;

/// [`call_worker`] for a call the worker may plan (M3-P P6): `seed` goes into the
/// claimed slot's plan cell before the call; whatever the cell holds after the
/// Promise resolved is returned beside the response — taken under the claim, so
/// it is never another request's.
pub async fn call_worker_planned<Req: Serialize, Resp: DeserializeOwned + Send + 'static>(
    pool: &Arc<WorkerPool>,
    timeout: Duration,
    call_timeout: Duration,
    kind: CallKind,
    req: &Req,
    seed: Option<PlanBox>,
) -> Result<(Resp, Option<PlanBox>), CallError> {
    call_worker_decoded(pool, timeout, call_timeout, kind, req, seed, |bytes| {
        // M3-P P7: validate UTF-8 once and parse from `str` (serde_json's `from_slice` re-checks
        // every string it reads; ~8% of the D parse).
        std::str::from_utf8(bytes)
            .map_err(|e| CallError::BadResponse(format!("response not UTF-8: {e}")))
            .and_then(|s| {
                serde_json::from_str::<Resp>(s).map_err(|e| CallError::BadResponse(e.to_string()))
            })
    })
    .await
}

/// F82: the per-call cell a `fetch` call seeds into its slot's plan cell. `body` is the heap
/// request body (taken once by `take_fetch_body`); `reply` receives the heap response body
/// (`put_fetch_reply`) and is shared with the decode closure, which runs inside the claim.
pub struct FetchCell {
    pub(crate) body: Option<bytes::Bytes>,
    pub(crate) reply: Arc<parking_lot::Mutex<Option<bytes::Bytes>>>,
}

/// One `fetch` round trip (A1 in, A2 out). Never planned. `heap_body` is a request body over the
/// inline threshold; it waits in the call's [`FetchCell`] for the worker to take.
pub async fn call_worker_fetch(
    pool: &Arc<WorkerPool>,
    timeout: Duration,
    call_timeout: Duration,
    req: &FetchRequest<'_>,
    heap_body: Option<bytes::Bytes>,
) -> Result<FetchResponse, CallError> {
    let reply = Arc::new(parking_lot::Mutex::new(None));
    let cell = FetchCell {
        body: heap_body,
        reply: Arc::clone(&reply),
    };
    call_worker_decoded(
        pool,
        timeout,
        call_timeout,
        CallKind::Fetch,
        req,
        Some(Box::new(cell)),
        move |b| decode_fetch_reply(b, &reply),
    )
    .await
    .map(|(r, _)| r)
}

fn fetch_frame_parts(b: &[u8]) -> Result<(FetchMeta, &[u8]), CallError> {
    let Some(head) = b.get(..4) else {
        return Err(CallError::BadResponse(
            "fetch frame shorter than 4 bytes".into(),
        ));
    };
    let n = u32::from_le_bytes(head.try_into().expect("4 bytes")) as usize;
    let Some(meta) = b.get(4..4usize.saturating_add(n)) else {
        return Err(CallError::BadResponse(format!(
            "fetch frame meta_len {n} exceeds {}",
            b.len() - 4
        )));
    };
    let m: FetchMeta = serde_json::from_slice(meta)
        .map_err(|e| CallError::BadResponse(format!("fetch frame meta: {e}")))?;
    Ok((m, &b[4 + n..]))
}

/// A2: `[u32 LE meta_len][meta JSON][body]`; the body is copied (the slot is about to be released).
pub fn decode_fetch_frame(b: &[u8]) -> Result<FetchResponse, CallError> {
    let (m, body) = fetch_frame_parts(b)?;
    Ok(FetchResponse {
        status: m.status,
        headers: m.headers,
        body: bytes::Bytes::copy_from_slice(body),
    })
}

/// F82: [`decode_fetch_frame`], except a meta with `heap: n` takes its body from `reply` (the
/// worker's `putFetchReply`); the framed body must then be empty and the put length must be `n`.
pub(crate) fn decode_fetch_reply(
    b: &[u8],
    reply: &parking_lot::Mutex<Option<bytes::Bytes>>,
) -> Result<FetchResponse, CallError> {
    let (m, framed) = fetch_frame_parts(b)?;
    let Some(n) = m.heap else {
        return Ok(FetchResponse {
            status: m.status,
            headers: m.headers,
            body: bytes::Bytes::copy_from_slice(framed),
        });
    };
    if !framed.is_empty() {
        return Err(CallError::BadResponse(
            "heap reply frame carries a body".into(),
        ));
    }
    let Some(body) = reply.lock().take() else {
        return Err(CallError::BadResponse("heap reply missing".into()));
    };
    if body.len() as u64 != n {
        return Err(CallError::BadResponse(format!(
            "heap reply {} != {n}",
            body.len()
        )));
    }
    Ok(FetchResponse {
        status: m.status,
        headers: m.headers,
        body,
    })
}

/// The claimed round trip, the slot bytes decoded by `decode` INSIDE the claim (the slot is
/// reused once it drops — F3).
async fn call_worker_decoded<Req: Serialize, R: Send + 'static, D>(
    pool: &Arc<WorkerPool>,
    timeout: Duration,
    call_timeout: Duration,
    kind: CallKind,
    req: &Req,
    seed: Option<PlanBox>,
    decode: D,
) -> Result<(R, Option<PlanBox>), CallError>
where
    D: FnOnce(&[u8]) -> Result<R, CallError> + Send + 'static,
{
    let claim = claim_or_wait(pool, timeout, || pool.try_claim_render_lockfree()).await?;
    if let Some(s) = seed {
        claim.put_plan(s);
    }
    let json = serde_json::to_string(req)
        .map_err(|e| CallError::BadResponse(format!("request serialise: {e}")))?;
    pool.ensure_sweeper();
    let pool = Arc::clone(pool);
    let (stamped, stamped_slot) = (Arc::clone(claim.entry()), claim.slot());
    let call: Pin<Box<dyn Future<Output = PlannedResult<R>> + Send>> = Box::pin(async move {
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
        let parsed = decode(bytes);
        let plan = claim.take_plan();
        drop(claim);
        parsed.map(|r| (r, plan))
    });
    // Deadline: `call_timeout` from the call's start; if the worker planned (M3-P P6), the jobs
    // phase gets `call_timeout` from its own start, as the old separate jobs call did. The claim
    // is still held by `call` while it is pending, so the stamp is this request's. M3-P P7 (R3):
    // the deadline lives in the claimed slot and the pool's sweeper wakes it — no tokio timer per call.
    let mut fut = Detach(Some(call));
    let mut deadline = SlotDeadline {
        at: std::time::Instant::now() + call_timeout,
        call_timeout,
        entry: stamped,
        slot: stamped_slot,
    };
    deadline.entry.arm_deadline(deadline.slot, deadline.at);
    let r = std::future::poll_fn(|cx| {
        if let Poll::Ready(r) = Pin::new(&mut fut).poll(cx) {
            return Poll::Ready(Ok(r));
        }
        deadline.poll(cx).map(Err)
    })
    .await;
    drop(fut);
    match r {
        Ok(Ok(result)) => result,
        Ok(Err(payload)) => Err(CallError::BadResponse(format!(
            "worker call panicked: {}",
            panic_message(&*payload)
        ))),
        // `Detach` was dropped by the timeout: the remainder now runs as its own
        // task and keeps the claim until JS settles (the `RenderClaim` drop rule
        // in `pool.rs`); its late result is dropped, so nothing from this call
        // reaches a cache.
        Err(Elapsed) => Err(CallError::Deadline),
    }
}

/// A claimed call's deadline passed (the `call_worker_decoded` deadline arm).
struct Elapsed;

/// The deadline of one claimed call (M3-P P7, R3). Ready iff now >= `at`, where `at` starts as
/// `call_timeout` after the call and moves to `call_timeout` after the jobs-phase stamp when that
/// is later (the S7 per-phase rule, unchanged). Pending parks the waker in the claimed slot, which
/// the pool's sweeper wakes once the armed deadline passed.
struct SlotDeadline {
    at: std::time::Instant,
    call_timeout: Duration,
    entry: Arc<WorkerEntry>,
    slot: u32,
}

impl SlotDeadline {
    fn poll(&mut self, cx: &mut std::task::Context<'_>) -> Poll<Elapsed> {
        let now = std::time::Instant::now();
        if now >= self.at {
            match self.entry.jobs_phase_since(self.slot) {
                Some(t) if t + self.call_timeout > self.at => {
                    self.at = t + self.call_timeout;
                    self.entry.arm_deadline(self.slot, self.at);
                    if now >= self.at {
                        return Poll::Ready(Elapsed);
                    }
                }
                _ => return Poll::Ready(Elapsed),
            }
        }
        // Parked on every pending poll: the sweeper TAKES the waker when it fires.
        self.entry.park_deadline_waker(self.slot, cx.waker());
        Poll::Pending
    }
}

/// A boxed call future polled inline. Dropped before completion → the remainder
/// is detached onto the runtime (it owns the `RenderClaim`, which must outlive
/// the worker's write — see the INVARIANT in `pool.rs`). A panic while polling
/// is caught and returned as `Err(payload)`; the panicked future is dropped
/// (its locals, the claim included, were already released by the unwind) and
/// is never polled again.
///
/// The inner future is already pinned on the heap, so `Detach` itself is
/// `Unpin` and `drop` can move the `Pin<Box<_>>` into a new task without ever
/// unpinning it.
struct Detach<T: Send + 'static>(Option<Pin<Box<dyn Future<Output = T> + Send>>>);

impl<T: Send + 'static> Future for Detach<T> {
    type Output = Result<T, Box<dyn std::any::Any + Send>>;

    fn poll(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Self::Output> {
        use std::task::Poll;
        let Some(inner) = self.0.as_mut() else {
            panic!("Detach polled after completion");
        };
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| inner.as_mut().poll(cx))) {
            Ok(Poll::Pending) => Poll::Pending,
            Ok(Poll::Ready(v)) => {
                self.0 = None;
                Poll::Ready(Ok(v))
            }
            Err(payload) => {
                self.0 = None;
                Poll::Ready(Err(payload))
            }
        }
    }
}

impl<T: Send + 'static> Drop for Detach<T> {
    fn drop(&mut self) {
        if let Some(rest) = self.0.take() {
            match tokio::runtime::Handle::try_current() {
                Ok(h) => {
                    h.spawn(rest);
                }
                // Only outside a runtime (shutdown): the claim is released with
                // the future, there is no worker left to protect.
                Err(_) => tracing::warn!("worker call dropped outside the runtime; claim released"),
            }
        }
    }
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> &str {
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("non-string panic payload")
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
            Duration::from_secs(5),
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
    async fn call_worker_returns_bad_response_on_a_non_utf8_response() {
        let pool = pool_with(MockDispatch::replying(b"{\"ok\":true,\"data\":\"\xff\"}"));
        let r = call_worker::<_, serde_json::Value>(
            &pool,
            Duration::from_millis(100),
            Duration::from_secs(5),
            CallKind::Loader,
            &serde_json::json!({"routeId": "r1"}),
        )
        .await;
        match r {
            Err(CallError::BadResponse(m)) => assert!(m.starts_with("response not UTF-8: "), "{m}"),
            other => panic!("{other:?}"),
        }
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
            Duration::from_secs(5),
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

    /// An A2 frame: `[u32 LE meta_len][meta][body]`.
    fn frame(meta: &[u8], body: &[u8]) -> Vec<u8> {
        let mut f = (meta.len() as u32).to_le_bytes().to_vec();
        f.extend_from_slice(meta);
        f.extend_from_slice(body);
        f
    }

    fn bad(r: Result<FetchResponse, CallError>) -> String {
        match r {
            Err(CallError::BadResponse(m)) => m,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn decode_fetch_frame_table() {
        let body: Vec<u8> = (0u8..=255).collect();
        assert_eq!(
            decode_fetch_frame(&frame(br#"{"status":200,"headers":[["x","1"]]}"#, &body)).unwrap(),
            FetchResponse {
                status: 200,
                headers: vec![("x".into(), "1".into())],
                body: bytes::Bytes::from(body.clone()),
            }
        );
        // Two Set-Cookie pairs survive in order; an empty body is fine.
        let r = decode_fetch_frame(&frame(
            br#"{"status":201,"headers":[["set-cookie","a=1"],["set-cookie","b=2"]]}"#,
            b"",
        ))
        .unwrap();
        assert_eq!(
            (r.status, r.headers.len(), r.body.len()),
            (201, 2, 0),
            "{r:?}"
        );
        assert_eq!(
            bad(decode_fetch_frame(&[1, 0, 0])),
            "fetch frame shorter than 4 bytes"
        );
        // meta_len == len: the meta would run past the frame.
        let mut f = frame(b"{}", b"");
        let n = f.len() as u32;
        f[..4].copy_from_slice(&n.to_le_bytes());
        assert!(bad(decode_fetch_frame(&f)).contains("meta_len"));
        assert!(bad(decode_fetch_frame(&frame(b"{", b"x"))).contains("meta"));
        // A JSON answer (the worker's unknown-kind `{error}`) reads as a huge meta_len.
        assert!(bad(decode_fetch_frame(br#"{"error":"x"}"#)).contains("meta_len"));
    }

    #[test]
    fn fetch_call_kind_serialises_to_fetch() {
        assert_eq!(
            serde_json::to_string(&CallKind::Fetch).unwrap(),
            "\"fetch\""
        );
    }

    fn fetch_request() -> FetchRequest<'static> {
        FetchRequest {
            method: "POST",
            url: "/_brust/action/x",
            headers: vec![],
            body: None,
            req: crate::routing::routes::RequestEnvelope {
                method: "POST",
                url: "/_brust/action/x",
                headers: vec![],
                cookies: vec![],
                search: vec![],
            },
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn call_worker_fetch_round_trips_a_frame() {
        let body: Vec<u8> = (0u8..=255).collect();
        let f = frame(br#"{"status":202,"headers":[["set-cookie","a=1"]]}"#, &body);
        let pool = pool_with(MockDispatch::replying(&f));
        let r = call_worker_fetch(
            &pool,
            Duration::from_millis(100),
            Duration::from_secs(5),
            &fetch_request(),
            None,
        )
        .await
        .expect("round trip");
        assert_eq!(r.status, 202);
        assert_eq!(r.headers, vec![("set-cookie".into(), "a=1".into())]);
        assert_eq!(&r.body[..], &body[..]);
        assert!(matches!(
            pool.try_claim_render_lockfree(),
            ClaimResult::Claimed(_)
        ));
    }

    fn heap_cell(v: Option<&[u8]>) -> parking_lot::Mutex<Option<bytes::Bytes>> {
        parking_lot::Mutex::new(v.map(bytes::Bytes::copy_from_slice))
    }

    #[test]
    fn decode_fetch_reply_table() {
        let meta = br#"{"status":200,"headers":[["x","1"]],"heap":5}"#;
        let r = decode_fetch_reply(&frame(meta, b""), &heap_cell(Some(b"hello"))).unwrap();
        assert_eq!(
            r,
            FetchResponse {
                status: 200,
                headers: vec![("x".into(), "1".into())],
                body: bytes::Bytes::from_static(b"hello"),
            }
        );
        assert!(
            bad(decode_fetch_reply(
                &frame(meta, b"x"),
                &heap_cell(Some(b"hello"))
            ))
            .contains("heap")
        );
        assert!(
            bad(decode_fetch_reply(&frame(meta, b""), &heap_cell(None)))
                .contains("heap reply missing")
        );
        assert!(
            bad(decode_fetch_reply(
                &frame(meta, b""),
                &heap_cell(Some(b"four"))
            ))
            .contains("heap reply 4 != 5")
        );
        // No `heap` key: exactly `decode_fetch_frame`, the cell is ignored.
        let f = frame(br#"{"status":201}"#, b"abc");
        assert_eq!(
            decode_fetch_reply(&f, &heap_cell(Some(b"zzz"))).unwrap(),
            decode_fetch_frame(&f).unwrap()
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn call_worker_fetch_seeds_a_fetch_cell() {
        let f = frame(br#"{"status":200}"#, b"ok");
        let pool = pool_with(MockDispatch::replying(&f));
        let r = call_worker_fetch(
            &pool,
            Duration::from_millis(100),
            Duration::from_secs(5),
            &fetch_request(),
            Some(bytes::Bytes::from_static(b"big")),
        )
        .await
        .expect("round trip");
        assert_eq!(&r.body[..], b"ok");
        let ClaimResult::Claimed(c) = pool.try_claim_render_lockfree() else {
            panic!("slot not claimable again");
        };
        assert!(
            c.entry().slot(0).plan.lock().is_none(),
            "cell dropped with the claim"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn fetch_len_over_capacity_is_bad_response() {
        let pool = pool_with(MockDispatch::reply_len(256 * 1024 + 1));
        let r = call_worker_fetch(
            &pool,
            Duration::from_millis(100),
            Duration::from_secs(5),
            &fetch_request(),
            None,
        )
        .await;
        assert!(bad(r).contains("outside"));
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
        gate: parking_lot::Mutex<Option<tokio::sync::oneshot::Receiver<Result<(), DispatchError>>>>,
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
                if let Ok(Err(e)) = gate.await {
                    return Err(e);
                }
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
                Duration::from_secs(5),
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
        tx.send(Ok(())).unwrap();
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

    fn gated_pool() -> (
        Arc<WorkerPool>,
        tokio::sync::oneshot::Sender<Result<(), DispatchError>>,
    ) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let pool = Arc::new(WorkerPool::new());
        pool.register(Box::new(GatedDispatch {
            inner: MockDispatch::replying(br#"{"ok":true}"#),
            gate: parking_lot::Mutex::new(Some(rx)),
        }));
        (pool, tx)
    }

    async fn call_with(
        pool: &Arc<WorkerPool>,
        claim_ms: u64,
        call_ms: u64,
        kind: CallKind,
    ) -> Result<serde_json::Value, CallError> {
        call_worker(
            pool,
            Duration::from_millis(claim_ms),
            Duration::from_millis(call_ms),
            kind,
            &serde_json::json!({}),
        )
        .await
    }

    async fn wait_claimable(pool: &WorkerPool) {
        let t0 = std::time::Instant::now();
        loop {
            if let ClaimResult::Claimed(_) = pool.try_claim_render_lockfree() {
                return;
            }
            assert!(t0.elapsed() < Duration::from_secs(2), "slot never released");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// M3-P P7: the sweeper walks every registered entry, not the pool's current list, so a
    /// call on a worker removed mid-call (dead worker, dev reload `clear`) still gets its 504.
    #[tokio::test(flavor = "current_thread")]
    async fn a_call_on_a_worker_removed_from_the_pool_still_times_out() {
        for clear in [false, true] {
            let (pool, _release) = gated_pool();
            let p2 = Arc::clone(&pool);
            let call = tokio::spawn(async move { call_with(&p2, 100, 50, CallKind::Loader).await });
            tokio::time::sleep(Duration::from_millis(5)).await;
            if clear {
                pool.clear();
            } else {
                pool.remove(0);
            }
            assert_eq!(pool.registered_count(), 0);
            let r = tokio::time::timeout(Duration::from_secs(2), call)
                .await
                .expect("deadline never fired")
                .unwrap();
            assert!(
                matches!(r, Err(CallError::Deadline)),
                "clear={clear}: {r:?}"
            );
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn deadline_returns_504_error_and_keeps_the_claim_until_js_settles() {
        let (pool, release) = gated_pool();
        let r = call_with(&pool, 100, 50, CallKind::Loader).await;
        assert!(matches!(r, Err(CallError::Deadline)), "{r:?}");
        assert!(
            matches!(pool.try_claim_render_lockfree(), ClaimResult::AllBusy),
            "slot must still be claimed after the deadline"
        );
        release.send(Ok(())).unwrap(); // late settle
        wait_claimable(&pool).await; // released once JS settled
    }

    #[tokio::test(flavor = "current_thread")]
    async fn late_rejection_after_deadline_releases_the_claim_quietly() {
        let (pool, release) = gated_pool();
        let r = call_with(&pool, 100, 50, CallKind::Jobs).await;
        assert!(matches!(r, Err(CallError::Deadline)));
        release
            .send(Err(DispatchError::PromiseRejected("boom".into())))
            .unwrap();
        wait_claimable(&pool).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_timed_out_call_still_occupies_its_slot_so_the_next_caller_gets_timeout_not_deadline()
    {
        let (pool, _release) = gated_pool(); // never settled during the test
        let first = call_with(&pool, 100, 30, CallKind::Loader).await;
        assert!(matches!(first, Err(CallError::Deadline)));
        let second = call_with(&pool, 60, 30, CallKind::Loader).await;
        assert!(matches!(second, Err(CallError::Timeout)), "{second:?}");
    }

    /// Writes `{"ok":true,"data":{}}` and, during the call, swaps the slot's plan cell content
    /// (u32 seed → seed + 1) through `claimed_plan_cell`, as `plan_in_call` does from the worker thread.
    struct Planner(MockDispatch, std::sync::Weak<WorkerPool>);

    impl RenderDispatch for Planner {
        fn call(
            &self,
            kind: CallKind,
            request_json: String,
            slot: u32,
        ) -> Pin<Box<dyn Future<Output = Result<u32, DispatchError>> + Send>> {
            let pool = self.1.upgrade().expect("pool alive during the call");
            let entry = pool.entry(0).expect("the planner is worker 0");
            let cell = entry
                .claimed_plan_cell(slot)
                .expect("the slot is claimed during its call");
            let mut guard = cell.lock();
            if let Some(seed) = guard.take() {
                let n = *seed.downcast::<u32>().expect("u32 seed");
                *guard = Some(Box::new(n + 1));
            }
            drop(guard);
            self.0.call(kind, request_json, slot)
        }
        fn buf(&self) -> (*mut u8, usize) {
            self.0.buf()
        }
    }

    fn planner_pool(d: MockDispatch) -> Arc<WorkerPool> {
        let pool = Arc::new(WorkerPool::new());
        pool.register(Box::new(Planner(d, Arc::downgrade(&pool))));
        pool
    }

    async fn call_planned(
        pool: &Arc<WorkerPool>,
        seed: u32,
    ) -> Result<(serde_json::Value, Option<PlanBox>), CallError> {
        call_worker_planned(
            pool,
            Duration::from_millis(100),
            Duration::from_secs(5),
            CallKind::Loader,
            &serde_json::json!({}),
            Some(Box::new(seed)),
        )
        .await
    }

    #[tokio::test(flavor = "current_thread")]
    async fn call_worker_planned_returns_what_the_cell_holds_after_the_call() {
        let pool = planner_pool(MockDispatch::replying(br#"{"ok":true,"data":{}}"#));
        let (v, plan) = call_planned(&pool, 41).await.expect("round trip");
        assert_eq!(v, serde_json::json!({"ok": true, "data": {}}));
        let plan = plan.expect("the cell's content comes back");
        assert_eq!(*plan.downcast::<u32>().unwrap(), 42);
        let entry = pool.entry(0).unwrap();
        assert!(
            entry.slot(0).plan.lock().is_none(),
            "the cell is empty after"
        );
        assert!(matches!(
            pool.try_claim_render_lockfree(),
            ClaimResult::Claimed(_)
        ));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn call_worker_planned_clears_the_cell_on_a_bad_response() {
        let pool = planner_pool(MockDispatch::reply_len(0));
        let r = call_planned(&pool, 41).await;
        assert!(matches!(r, Err(CallError::BadResponse(_))), "{:?}", r.err());
        let entry = pool.entry(0).unwrap();
        assert!(
            entry.slot(0).plan.lock().is_none(),
            "the cell is empty after"
        );
        assert!(matches!(
            pool.try_claim_render_lockfree(),
            ClaimResult::Claimed(_)
        ));
    }

    /// `call` panics when polled: the claim must be released by unwinding and
    /// the caller must get `BadResponse`, not a torn-down task.
    struct PanickingDispatch(MockDispatch);

    impl RenderDispatch for PanickingDispatch {
        fn call(
            &self,
            _kind: CallKind,
            _request_json: String,
            _slot: u32,
        ) -> Pin<Box<dyn Future<Output = Result<u32, DispatchError>> + Send>> {
            Box::pin(async { panic!("worker exploded") })
        }
        fn buf(&self) -> (*mut u8, usize) {
            self.0.buf()
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_panicking_dispatch_releases_its_slot_and_is_a_bad_response() {
        let pool = Arc::new(WorkerPool::new());
        pool.register(Box::new(PanickingDispatch(MockDispatch::new())));
        let r = call_with(&pool, 100, 1_000, CallKind::Loader).await;
        match r {
            Err(CallError::BadResponse(m)) => assert!(m.contains("worker exploded"), "{m}"),
            other => panic!("expected BadResponse, got {other:?}"),
        }
        assert!(
            matches!(pool.try_claim_render_lockfree(), ClaimResult::Claimed(_)),
            "the slot must be free after the panic"
        );
    }

    /// The happy path must not spawn: the caller's task is the only one alive
    /// before and after a round trip (current_thread runtime, nothing else running).
    #[tokio::test(flavor = "current_thread")]
    async fn detach_runs_the_remainder_off_the_caller() {
        // Deadline fires → the remainder is detached and finishes on its own
        // (the claim is released without anyone awaiting the call again).
        let (pool, release) = gated_pool();
        let r = call_with(&pool, 100, 30, CallKind::Loader).await;
        assert!(matches!(r, Err(CallError::Deadline)));
        release.send(Ok(())).unwrap();
        wait_claimable(&pool).await;
        // And a second, un-gated call on the same (now free) slot round-trips.
        let pool2 = pool_with(MockDispatch::replying(br#"{"ok":true}"#));
        let v = call_with(&pool2, 100, 1_000, CallKind::Jobs)
            .await
            .expect("round trip");
        assert_eq!(v, serde_json::json!({"ok": true}));
    }
}
