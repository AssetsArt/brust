use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use napi::bindgen_prelude::Promise;
use napi::threadsafe_function::ThreadsafeFunction;
use parking_lot::RwLock;
use tokio::sync::mpsc;

/// Renderer signature: takes the envelope JSON (String) and resolves with no value.
/// The HTML/body bytes flow via `napi_render_chunk` through the per-worker
/// `RenderSlot.chunk_tx` channel — the Promise just signals "renderer
/// callback returned" so handle_conn can fall through to terminator/cleanup.
/// CalleeHandled = false matches what Function::build_threadsafe_function().build() produces.
pub type RendererTsfn = ThreadsafeFunction<String, Promise<()>, String, napi::Status, false>;

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
    Bytes { data: Vec<u8>, ack: tokio::sync::oneshot::Sender<()> },
    /// `napi_render_chunk(_, 0)` — close the channel, terminate the response.
    Final { ack: tokio::sync::oneshot::Sender<()> },
}

/// Per-worker per-request slot. Installed by handle_conn BEFORE calling
/// `tsfn.call_async`; cleared by `RenderSlotGuard::drop` on exit (RAII —
/// survives panic, cancellation, early returns).
pub struct RenderSlot {
    pub chunk_tx: mpsc::Sender<RenderChunk>,
}

pub struct TsfnEntry {
    pub id: u32,
    pub tsfn: RendererTsfn,
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

/// RAII guard that clears `TsfnEntry::render_slot` on Drop. Use as
/// `let _slot_guard = RenderSlotGuard { entry: &entry };` in handle_conn
/// after installing the slot. Survives panic + tokio cancellation +
/// early returns — all paths that would otherwise leak the sender and
/// strand the next request on this worker.
pub struct RenderSlotGuard<'e> {
    pub entry: &'e Arc<TsfnEntry>,
}

impl Drop for RenderSlotGuard<'_> {
    fn drop(&mut self) {
        self.entry.render_slot.lock().take();
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.0.in_flight.fetch_sub(1, Ordering::Relaxed);
    }
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
            tsfn,
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
pub async fn dispatch_sse(
    entry: Arc<TsfnEntry>,
    envelope_json: String,
) -> Result<(), napi::Error> {
    let _guard = entry.in_flight_guard();
    entry.tsfn.call_async(envelope_json).await
        .map(|_| ())
        .map_err(|e| {
            napi::Error::from_reason(format!("sse dispatch failed: {e}"))
        })
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
pub async fn dispatch_ws(
    entry: Arc<TsfnEntry>,
    envelope_json: String,
) -> Result<(), napi::Error> {
    let _guard = entry.in_flight_guard();
    entry.tsfn.call_async(envelope_json).await
        .map(|_| ())
        .map_err(|e| {
            napi::Error::from_reason(format!("ws dispatch failed: {e}"))
        })
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
        tx.send(RenderChunk::Bytes { data: vec![1, 2, 3], ack: ack_tx }).await.unwrap();
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
}
