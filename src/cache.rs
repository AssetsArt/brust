use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Deserialize;

const CACHE_CAPACITY: usize = 1000;

#[derive(Debug, Clone, Deserialize)]
pub struct CacheConfig {
    pub ttl_seconds: u64,
    #[serde(default)]
    pub vary: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CacheKey {
    pub method: String,
    pub path: String,
    pub sorted_query: String,
    pub vary_values: Vec<String>,
}

#[derive(Clone)]
pub struct CachedEntry {
    pub response_bytes: Vec<u8>,
    pub inserted_at: Instant,
    pub ttl: Duration,
}

impl CachedEntry {
    pub fn is_expired(&self) -> bool {
        self.inserted_at.elapsed() >= self.ttl
    }
}

pub struct LruCache {
    inner: Mutex<lru::LruCache<CacheKey, CachedEntry>>,
    #[allow(dead_code)] // surfaced via napi in a follow-up
    hits: AtomicU64,
    #[allow(dead_code)]
    misses: AtomicU64,
}

impl LruCache {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(lru::LruCache::new(
                NonZeroUsize::new(CACHE_CAPACITY).expect("CACHE_CAPACITY > 0"),
            )),
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
        }
    }

    pub fn get(&self, key: &CacheKey) -> Option<Vec<u8>> {
        let mut guard = self.inner.lock();
        let entry = guard.get(key)?;
        if entry.is_expired() {
            guard.pop(key);
            self.misses.fetch_add(1, Ordering::Relaxed);
            return None;
        }
        let bytes = entry.response_bytes.clone();
        self.hits.fetch_add(1, Ordering::Relaxed);
        Some(bytes)
    }

    pub fn insert(&self, key: CacheKey, response_bytes: Vec<u8>, ttl: Duration) {
        let entry = CachedEntry {
            response_bytes,
            inserted_at: Instant::now(),
            ttl,
        };
        self.inner.lock().put(key, entry);
    }
}

impl Default for LruCache {
    fn default() -> Self {
        Self::new()
    }
}
