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

use std::future::Future;
use std::pin::Pin;

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
    /// Dispatch a render. `request_json` is the request envelope marshaled as a
    /// JSON string (the INLINE request transport — see the module doc; do NOT
    /// route the request through the SAB). `slot` is the claimed render slot.
    fn call(
        &self,
        request_json: String,
        slot: u32,
    ) -> Pin<Box<dyn Future<Output = Result<u32, RenderError>> + Send>>;

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

/// In-process mock for pool/render unit tests: a leaked 256 KiB buffer (no napi)
/// and a `call` that resolves `Ok(0)`.
#[cfg(test)]
pub struct MockDispatch {
    ptr: *mut u8,
    len: usize,
    slots: usize,
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
        Self { ptr, len, slots: k }
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
        _request_json: String,
        _slot: u32,
    ) -> Pin<Box<dyn Future<Output = Result<u32, RenderError>> + Send>> {
        Box::pin(async { Ok(0u32) })
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
}
