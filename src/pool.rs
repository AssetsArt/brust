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
