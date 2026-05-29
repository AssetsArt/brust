use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use napi::bindgen_prelude::{Either, Promise};
use napi::threadsafe_function::ThreadsafeFunction;
use parking_lot::RwLock;
use tokio::sync::mpsc;

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
/// CalleeHandled = false matches what Function::build_threadsafe_function().build() produces.
pub type RendererTsfn = ThreadsafeFunction<Either<u32, String>, Promise<u32>, Either<u32, String>, napi::Status, false>;

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

/// One chunk delivered from a worker's `napi_render_chunk` call to handle_conn's
/// per-request chunk loop. `ack` resolves the worker's awaiting Promise so the
/// next chunk can be written into the SAB without overlapping.
pub enum RenderChunk {
    /// Chunk body (first chunk includes meta prefix per spec §4).
    Bytes {
        data: Vec<u8>,
        ack: tokio::sync::oneshot::Sender<()>,
    },
    /// `napi_render_chunk(_, 0)` — close the channel, terminate the response.
    Final {
        ack: tokio::sync::oneshot::Sender<()>,
    },
    /// Combined Bytes + Final. Buffering-path callers use this to eliminate
    /// one tsfn round-trip per render. handle_conn processes this as the
    /// byte-equivalent of Bytes-then-Final consecutive sends.
    BytesAndFinal {
        data: Vec<u8>,
        ack: tokio::sync::oneshot::Sender<()>,
    },
}

/// Per-worker per-request slot. Installed atomically by
/// `WorkerPool::try_claim_render` BEFORE calling `tsfn.call_async`;
/// cleared by `RenderClaim::drop` on exit (RAII — survives panic,
/// cancellation, early returns).
pub struct RenderSlot {
    pub chunk_tx: mpsc::Sender<RenderChunk>,
}

pub struct TsfnEntry {
    pub id: u32,
    /// `Option` so `#[cfg(test)] WorkerPool::register_for_test` can build
    /// an entry without a real napi `ThreadsafeFunction` (the crate is
    /// `cdylib`; napi C runtime symbols are resolved by the Bun host at
    /// load time and aren't linked into the `cargo test` binary).
    /// Production `WorkerPool::register` always sets `Some(...)`; the
    /// three dispatch sites (`dispatch_sse`, `dispatch_ws`, server.rs
    /// render dispatch) unwrap via `.as_ref().expect(...)`.
    pub tsfn: Option<RendererTsfn>,
    pub buf_ptr: BufPtr,
    pub buf_len: usize,
    pub in_flight: AtomicU32,
    pub render_slot: parking_lot::Mutex<Option<RenderSlot>>,
}

impl TsfnEntry {
    pub fn in_flight_guard(self: &Arc<Self>) -> InFlightGuard {
        self.in_flight.fetch_add(1, Ordering::Relaxed);
        InFlightGuard(Arc::clone(self))
    }
}

pub struct InFlightGuard(Arc<TsfnEntry>);

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.0.in_flight.fetch_sub(1, Ordering::Relaxed);
    }
}

/// RAII guard returned by `WorkerPool::try_claim_render`. Holds the per-
/// worker render slot + the in_flight counter for the lifetime of the
/// guard. Drop atomically clears both.
#[must_use = "RenderClaim must be held for the lifetime of the render; \
              dropping it immediately frees the worker and breaks the invariant"]
pub struct RenderClaim {
    entry: Arc<TsfnEntry>,
}

impl RenderClaim {
    pub fn entry(&self) -> &Arc<TsfnEntry> {
        &self.entry
    }
}

impl Drop for RenderClaim {
    fn drop(&mut self) {
        // Order load-bearing: clear slot FIRST so the invariant
        // `in_flight >= render_slot_count` holds at every observable point.
        self.entry.render_slot.lock().take();
        self.entry.in_flight.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Outcome of `WorkerPool::try_claim_render`. Distinguishes "no workers
/// registered" from "every worker mid-render" so dispatchers can emit
/// different 503 bodies.
pub enum ClaimResult {
    Claimed(RenderClaim),
    PoolEmpty,
    AllBusy,
}

#[derive(Default)]
pub struct WorkerPool {
    entries: RwLock<Vec<Arc<TsfnEntry>>>,
    next_id: AtomicU32,
}

impl WorkerPool {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, tsfn: RendererTsfn, buf_ptr: BufPtr, buf_len: usize) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let entry = Arc::new(TsfnEntry {
            id,
            tsfn: Some(tsfn),
            buf_ptr,
            buf_len,
            in_flight: AtomicU32::new(0),
            render_slot: parking_lot::Mutex::new(None),
        });
        self.entries.write().push(entry);
        id
    }

    pub fn registered_count(&self) -> usize {
        self.entries.read().len()
    }

    pub fn pick_least_busy(&self) -> Option<Arc<TsfnEntry>> {
        let entries = self.entries.read();
        entries
            .iter()
            .min_by_key(|e| e.in_flight.load(Ordering::Relaxed))
            .cloned()
    }

    /// Atomically reserve an idle render worker and install the chunk
    /// sender. Returns Claimed/PoolEmpty/AllBusy.
    ///
    /// Lock ordering: ALWAYS acquire `entries` (RwLock read) BEFORE the
    /// per-entry `render_slot` (Mutex). Inverting risks deadlock.
    pub fn try_claim_render(
        &self,
        chunk_tx: tokio::sync::mpsc::Sender<RenderChunk>,
    ) -> ClaimResult {
        let entries = self.entries.read();
        if entries.is_empty() {
            return ClaimResult::PoolEmpty;
        }
        for entry in entries.iter() {
            let mut slot = entry.render_slot.lock();
            if slot.is_some() {
                continue;
            }
            // in_flight is a load hint; slot correctness comes from the mutex.
            // Relaxed matches InFlightGuard's existing ordering.
            entry.in_flight.fetch_add(1, Ordering::Relaxed);
            *slot = Some(RenderSlot { chunk_tx });
            drop(slot);
            return ClaimResult::Claimed(RenderClaim {
                entry: Arc::clone(entry),
            });
        }
        ClaimResult::AllBusy
    }

    pub fn entry(&self, id: u32) -> Option<Arc<TsfnEntry>> {
        self.entries.read().iter().find(|e| e.id == id).cloned()
    }

    pub fn remove(&self, id: u32) {
        self.entries.write().retain(|e| e.id != id);
    }
}

/// Dispatch an SSE envelope to the worker. Single long-lived tsfn call:
/// the JS side branches on `kind: 'sse'`, runs middleware, signals open
/// via napi_sse_signal_open, then enters the reader loop. The Rust side
/// holds an in_flight_guard ONLY for the duration of the call_async
/// handoff — the per-conn task in src/sse.rs::sse_conn_task owns the
/// rest of the connection's lifetime independently of the worker pool.
///
/// Returns Err if the tsfn enqueue itself fails (e.g. worker dead).
/// Open-signal timeout + middleware reject handling are caller concerns.
pub async fn dispatch_sse(entry: Arc<TsfnEntry>, envelope_json: String) -> Result<(), napi::Error> {
    let _guard = entry.in_flight_guard();
    entry
        .tsfn
        .as_ref()
        .expect("tsfn is None — only legal in cfg(test) register_for_test; production register always supplies Some")
        .call_async(napi::bindgen_prelude::Either::B(envelope_json))
        .await
        .map(|_| ())
        .map_err(|e| napi::Error::from_reason(format!("sse dispatch failed: {e}")))
}

/// Dispatch a WS envelope to the worker. Single long-lived tsfn call:
/// the JS side branches on `kind: 'ws'`, runs middleware, signals open
/// (101 or 4xx) via napi_ws_signal_open, then registers handler
/// callbacks via napi_ws_register_handlers. The Rust side holds an
/// in_flight_guard ONLY for the duration of the call_async handoff —
/// the per-conn task in src/ws.rs::ws_conn_task owns the rest of the
/// connection's lifetime independently of the worker pool.
///
/// Returns Err if the tsfn enqueue itself fails (e.g. worker dead).
/// Open-signal timeout + middleware reject handling are caller concerns.
pub async fn dispatch_ws(entry: Arc<TsfnEntry>, envelope_json: String) -> Result<(), napi::Error> {
    let _guard = entry.in_flight_guard();
    entry
        .tsfn
        .as_ref()
        .expect("tsfn is None — only legal in cfg(test) register_for_test; production register always supplies Some")
        .call_async(napi::bindgen_prelude::Either::B(envelope_json))
        .await
        .map(|_| ())
        .map_err(|e| napi::Error::from_reason(format!("ws dispatch failed: {e}")))
}

#[cfg(test)]
impl WorkerPool {
    /// Register a worker with `tsfn: None` for pool-logic unit tests.
    /// Production code always sets `Some(...)`; tests using this helper
    /// MUST NOT call dispatch paths that unwrap tsfn.
    pub fn register_for_test(&self) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let entry = Arc::new(TsfnEntry {
            id,
            tsfn: None,
            buf_ptr: BufPtr(Box::leak(vec![0u8; 256*1024].into_boxed_slice()).as_mut_ptr()),
            buf_len: 256 * 1024,
            in_flight: AtomicU32::new(0),
            render_slot: parking_lot::Mutex::new(None),
        });
        self.entries.write().push(entry);
        id
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::{mpsc, oneshot};

    #[test]
    fn render_slot_set_clear_round_trip() {
        let slot_mu: parking_lot::Mutex<Option<RenderSlot>> = parking_lot::Mutex::new(None);
        assert!(slot_mu.lock().is_none());
        let (tx, _rx) = mpsc::channel::<RenderChunk>(1);
        *slot_mu.lock() = Some(RenderSlot { chunk_tx: tx });
        assert!(slot_mu.lock().is_some());
        let taken = slot_mu.lock().take();
        assert!(taken.is_some());
        assert!(slot_mu.lock().is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn render_chunk_enum_bytes_ack_round_trip() {
        let (tx, mut rx) = mpsc::channel::<RenderChunk>(1);
        let (ack_tx, ack_rx) = oneshot::channel::<()>();
        tx.send(RenderChunk::Bytes {
            data: vec![1, 2, 3],
            ack: ack_tx,
        })
        .await
        .unwrap();
        let got = rx.recv().await.unwrap();
        match got {
            RenderChunk::Bytes { data, ack } => {
                assert_eq!(data, vec![1, 2, 3]);
                ack.send(()).unwrap();
            }
            _ => panic!("expected Bytes variant"),
        }
        ack_rx.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn render_chunk_enum_final_ack_drop_returns_err() {
        let (ack_tx, ack_rx) = oneshot::channel::<()>();
        drop(ack_tx);
        assert!(ack_rx.await.is_err());
    }

    #[test]
    fn try_claim_render_returns_pool_empty() {
        let pool = WorkerPool::new();
        let (tx, _rx) = tokio::sync::mpsc::channel::<RenderChunk>(1);
        match pool.try_claim_render(tx) {
            ClaimResult::PoolEmpty => {}
            _ => panic!("expected PoolEmpty"),
        }
    }

    #[test]
    fn try_claim_render_claims_idle_worker() {
        let pool = WorkerPool::new();
        let id = pool.register_for_test();
        let (tx, _rx) = tokio::sync::mpsc::channel::<RenderChunk>(1);
        let claim = match pool.try_claim_render(tx) {
            ClaimResult::Claimed(c) => c,
            _ => panic!("expected Claimed"),
        };
        assert_eq!(claim.entry().id, id);
        assert!(claim.entry().render_slot.lock().is_some());
        assert_eq!(claim.entry().in_flight.load(Ordering::Relaxed), 1);
        drop(claim);
    }

    #[test]
    fn try_claim_render_second_returns_other_idle_worker() {
        let pool = WorkerPool::new();
        let id0 = pool.register_for_test();
        let id1 = pool.register_for_test();
        let (tx0, _rx0) = tokio::sync::mpsc::channel::<RenderChunk>(1);
        let (tx1, _rx1) = tokio::sync::mpsc::channel::<RenderChunk>(1);

        let c0 = match pool.try_claim_render(tx0) {
            ClaimResult::Claimed(c) => c,
            _ => panic!(),
        };
        let c1 = match pool.try_claim_render(tx1) {
            ClaimResult::Claimed(c) => c,
            _ => panic!(),
        };
        assert_ne!(c0.entry().id, c1.entry().id);
        let mut ids = [c0.entry().id, c1.entry().id];
        ids.sort();
        assert_eq!(ids, [id0, id1]);
    }

    #[test]
    fn try_claim_render_all_busy_returns_all_busy() {
        let pool = WorkerPool::new();
        let _id = pool.register_for_test();
        let (tx0, _rx0) = tokio::sync::mpsc::channel::<RenderChunk>(1);
        let (tx1, _rx1) = tokio::sync::mpsc::channel::<RenderChunk>(1);
        let _c0 = match pool.try_claim_render(tx0) {
            ClaimResult::Claimed(c) => c,
            _ => panic!(),
        };
        match pool.try_claim_render(tx1) {
            ClaimResult::AllBusy => {}
            _ => panic!("expected AllBusy"),
        }
    }

    #[test]
    fn render_claim_drop_releases_slot_and_decrements_in_flight() {
        let pool = WorkerPool::new();
        let _id = pool.register_for_test();
        let entry = pool.entries.read()[0].clone();
        {
            let (tx, _rx) = tokio::sync::mpsc::channel::<RenderChunk>(1);
            let _claim = match pool.try_claim_render(tx) {
                ClaimResult::Claimed(c) => c,
                _ => panic!(),
            };
            assert!(entry.render_slot.lock().is_some());
            assert_eq!(entry.in_flight.load(Ordering::Relaxed), 1);
        }
        // Drop ran here.
        assert!(entry.render_slot.lock().is_none());
        assert_eq!(entry.in_flight.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn try_claim_render_after_drop_reuses_worker() {
        let pool = WorkerPool::new();
        let _id = pool.register_for_test();
        let (tx0, _rx0) = tokio::sync::mpsc::channel::<RenderChunk>(1);
        let (tx1, _rx1) = tokio::sync::mpsc::channel::<RenderChunk>(1);
        {
            let _c0 = match pool.try_claim_render(tx0) {
                ClaimResult::Claimed(c) => c,
                _ => panic!(),
            };
        }
        match pool.try_claim_render(tx1) {
            ClaimResult::Claimed(_) => {}
            _ => panic!("expected reuse"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn try_claim_render_race_no_concurrent_double_claim() {
        use std::sync::Arc;
        use tokio::sync::Barrier;

        const M: usize = 4; // workers
        const N: usize = 16; // concurrent claim attempts

        let pool = Arc::new(WorkerPool::new());
        for _ in 0..M {
            pool.register_for_test();
        }

        // start_barrier: every task waits here before calling try_claim_render —
        //                forces simultaneous contention at the claim point.
        // hold_barrier:  every task waits here AFTER claiming/AllBusying and
        //                BEFORE dropping. This guarantees that while any claim
        //                is live, no other task has yet had a chance to release
        //                its claim, so claimed_ids reflects the concurrent claim
        //                state, not sequential reuse.
        let start_barrier = Arc::new(Barrier::new(N));
        let hold_barrier = Arc::new(Barrier::new(N));
        let mut handles = Vec::new();
        for _ in 0..N {
            let pool = Arc::clone(&pool);
            let start = Arc::clone(&start_barrier);
            let hold = Arc::clone(&hold_barrier);
            handles.push(tokio::spawn(async move {
                start.wait().await;
                let (tx, _rx) = tokio::sync::mpsc::channel::<RenderChunk>(1);
                let outcome = match pool.try_claim_render(tx) {
                    ClaimResult::Claimed(c) => {
                        let id = c.entry().id;
                        // Hold the claim until every task is past the claim attempt.
                        hold.wait().await;
                        drop(c);
                        Some(id)
                    }
                    ClaimResult::AllBusy => {
                        hold.wait().await;
                        None
                    }
                    ClaimResult::PoolEmpty => panic!("pool was registered with {M} workers"),
                };
                outcome
            }));
        }

        let mut claimed_ids = Vec::new();
        let mut all_busy_count = 0usize;
        for h in handles {
            match h.await.unwrap() {
                Some(id) => claimed_ids.push(id),
                None => all_busy_count += 1,
            }
        }

        // (1) Exactly M concurrent claims, N-M AllBusy. The hold barrier
        // ensures no claim was released before every contender attempted,
        // so this measures concurrent state — not sequential reuse.
        assert_eq!(
            claimed_ids.len(),
            M,
            "expected {M} concurrent claims, got {} (ids: {:?})",
            claimed_ids.len(),
            claimed_ids,
        );
        assert_eq!(all_busy_count, N - M);

        // (2) Each successful concurrent claim corresponds to a distinct worker.
        // This is the core anti-TOCTOU assertion: two tasks must not have
        // both observed the same worker as idle.
        let mut sorted = claimed_ids.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            M,
            "duplicate ids in concurrent claimed set: {:?}",
            claimed_ids,
        );

        // (3) After all tasks finish (claims released after hold barrier),
        // every slot is None and every in_flight is 0.
        for entry in pool.entries.read().iter() {
            assert!(
                entry.render_slot.lock().is_none(),
                "worker {} slot still held",
                entry.id,
            );
            assert_eq!(
                entry.in_flight.load(Ordering::Relaxed),
                0,
                "worker {} in_flight not drained",
                entry.id,
            );
        }
    }

    fn chunk_kind(c: &RenderChunk) -> &'static str {
        match c {
            RenderChunk::Bytes { .. } => "Bytes",
            RenderChunk::Final { .. } => "Final",
            RenderChunk::BytesAndFinal { .. } => "BytesAndFinal",
        }
    }

    #[tokio::test]
    async fn bytes_and_final_round_trips_through_channel() {
        let (tx, mut rx) = mpsc::channel::<RenderChunk>(1);
        let (ack_tx, ack_rx) = tokio::sync::oneshot::channel::<()>();
        let payload = b"hello world".to_vec();

        tx.send(RenderChunk::BytesAndFinal {
            data: payload.clone(),
            ack: ack_tx,
        })
        .await
        .unwrap();

        let received = rx.recv().await.expect("chunk should arrive");
        match received {
            RenderChunk::BytesAndFinal { data, ack } => {
                assert_eq!(data, payload);
                ack.send(()).expect("ack receiver should still be alive");
            }
            other => panic!("expected BytesAndFinal, got {}", chunk_kind(&other)),
        }
        ack_rx.await.expect("ack should resolve");
    }
}
