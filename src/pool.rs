use std::sync::atomic::Ordering;

use crate::worker::WorkerHandle;

pub struct WorkerPool {
    pub workers: Vec<WorkerHandle>,
}

impl WorkerPool {
    pub fn new(workers: Vec<WorkerHandle>) -> Self {
        assert!(!workers.is_empty(), "WorkerPool requires at least one worker");
        Self { workers }
    }

    pub fn pick_least_busy(&self) -> &WorkerHandle {
        self.workers
            .iter()
            .min_by_key(|w| w.in_flight.load(Ordering::Acquire))
            .expect("non-empty per constructor invariant")
    }
}
