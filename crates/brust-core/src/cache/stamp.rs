//! Read stamps (F86, F89): the invalidation clock L1 and the job cache share. Every covering
//! invalidation of either cache takes the next clock value and publishes it in a hashed slot; an
//! insert carries the `ReadStamp` its request took before it read app data and does not land if
//! a covering invalidation came after it. `Server` owns one `InvalClock` and builds both caches
//! on it, so `page()` stamps once for both.
use std::sync::atomic::{AtomicU64, Ordering};

/// When a request's render began, in invalidation-clock time: taken by `InvalClock::stamp` (or a
/// cache's `read_stamp`) before the request reads app data, required by `L1Cache::insert` and
/// `JobCache::insert`. An insert does not land if a covering invalidation took a later value.
#[must_use]
#[derive(Debug, Clone, Copy)]
pub struct ReadStamp(#[doc(hidden)] pub u64);

/// The shared invalidation clock: monotonic, SeqCst on both sides.
#[derive(Debug, Default)]
pub struct InvalClock(AtomicU64);

impl InvalClock {
    pub fn stamp(&self) -> ReadStamp {
        ReadStamp(self.0.load(Ordering::SeqCst))
    }

    /// Take the next sequence number (an invalidation publishes it). Native-host seam, not an API.
    #[doc(hidden)]
    pub fn next(&self) -> u64 {
        self.0.fetch_add(1, Ordering::SeqCst) + 1
    }
}

/// Slots per invalidation-sequence array: 2 KiB each, constant. Native-host seam, not an API.
#[doc(hidden)]
pub const INVAL_SLOTS: usize = 256;

/// One zeroed invalidation-sequence array. Native-host seam, not an API.
#[doc(hidden)]
pub fn inval_slots() -> Box<[AtomicU64]> {
    (0..INVAL_SLOTS).map(|_| AtomicU64::new(0)).collect()
}
