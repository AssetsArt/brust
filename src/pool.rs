use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use napi::bindgen_prelude::Promise;
use napi::threadsafe_function::ThreadsafeFunction;
use parking_lot::RwLock;

/// Renderer signature: takes path (String), writes bytes into the worker's pre-registered
/// SharedArrayBuffer, returns Promise<u32> = bytes written (0 = oversized error).
/// CalleeHandled = false matches what Function::build_threadsafe_function().build() produces.
pub type RendererTsfn = ThreadsafeFunction<String, Promise<u32>, String, napi::Status, false>;

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

pub struct TsfnEntry {
    pub id: u32,
    pub tsfn: RendererTsfn,
    pub buf_ptr: BufPtr,
    pub buf_len: usize,
    pub in_flight: AtomicU32,
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
