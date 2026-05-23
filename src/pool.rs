use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use napi::bindgen_prelude::Promise;
use napi::threadsafe_function::ThreadsafeFunction;
use parking_lot::RwLock;

/// Renderer signature: takes a path (String) and returns Promise<String>.
/// CalleeHandled = false matches what Function::build_threadsafe_function().build() produces.
pub type RendererTsfn = ThreadsafeFunction<String, Promise<String>, String, napi::Status, false>;

pub struct TsfnEntry {
    pub id: u32,
    pub tsfn: RendererTsfn,
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

    pub fn register(&self, tsfn: RendererTsfn) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let entry = Arc::new(TsfnEntry {
            id,
            tsfn,
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
