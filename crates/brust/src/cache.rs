use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

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

/// Stats snapshot. Serialized to JSON by the /_brust/cache/stats native route.
#[derive(Debug, Clone, Serialize)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    pub len: usize,
    pub capacity: usize,
}

pub struct LruCache {
    inner: Mutex<lru::LruCache<CacheKey, CachedEntry>>,
    hits: AtomicU64,
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
        let entry = match guard.get(key) {
            Some(e) => e,
            None => {
                self.misses.fetch_add(1, Ordering::Relaxed);
                return None;
            }
        };
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

    pub fn stats(&self) -> CacheStats {
        let guard = self.inner.lock();
        CacheStats {
            hits: self.hits.load(Ordering::Relaxed),
            misses: self.misses.load(Ordering::Relaxed),
            len: guard.len(),
            capacity: guard.cap().get(),
        }
    }

    /// Resize the LRU. If shrinking below current length, excess LRU entries
    /// are evicted. Safe to call at any time; no-op if `max == capacity`.
    pub fn resize(&self, max: NonZeroUsize) {
        self.inner.lock().resize(max);
    }

    /// Remove every entry whose key has the given method + path (regardless
    /// of query string or vary values). Returns the number of entries
    /// removed. Hits/misses counters are NOT reset.
    pub fn invalidate_path(&self, method: &str, path: &str) -> usize {
        let mut guard = self.inner.lock();
        // `lru` has no remove-by-predicate. Snapshot the matching keys,
        // then pop each. Allocation cost is proportional to matches, not
        // total cache size.
        let to_remove: Vec<CacheKey> = guard
            .iter()
            .filter(|(k, _)| k.method == method && k.path == path)
            .map(|(k, _)| k.clone())
            .collect();
        for k in &to_remove {
            guard.pop(k);
        }
        to_remove.len()
    }

    /// Remove every entry. Hits/misses counters are NOT reset (they
    /// represent lifetime totals; operators wanting a fresh window can
    /// scrape `/stats` and compute deltas).
    pub fn clear(&self) -> usize {
        let mut guard = self.inner.lock();
        let removed = guard.len();
        guard.clear();
        removed
    }
}

impl Default for LruCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(method: &str, path: &str, query: &str) -> CacheKey {
        CacheKey {
            method: method.to_string(),
            path: path.to_string(),
            sorted_query: query.to_string(),
            vary_values: Vec::new(),
        }
    }

    #[test]
    fn invalidate_path_removes_only_matching_entries() {
        let c = LruCache::new();
        c.insert(key("GET", "/a", ""), b"a".to_vec(), Duration::from_secs(60));
        c.insert(
            key("GET", "/a", "x=1"),
            b"a-x".to_vec(),
            Duration::from_secs(60),
        );
        c.insert(key("GET", "/b", ""), b"b".to_vec(), Duration::from_secs(60));

        let removed = c.invalidate_path("GET", "/a");
        assert_eq!(removed, 2);
        assert!(c.get(&key("GET", "/a", "")).is_none());
        assert!(c.get(&key("GET", "/a", "x=1")).is_none());
        assert_eq!(c.get(&key("GET", "/b", "")), Some(b"b".to_vec()));
    }

    #[test]
    fn invalidate_path_no_match_returns_zero() {
        let c = LruCache::new();
        c.insert(key("GET", "/a", ""), b"a".to_vec(), Duration::from_secs(60));
        assert_eq!(c.invalidate_path("GET", "/missing"), 0);
        assert_eq!(c.invalidate_path("POST", "/a"), 0);
        assert_eq!(c.stats().len, 1);
    }

    #[test]
    fn clear_removes_all_entries_and_returns_count() {
        let c = LruCache::new();
        c.insert(key("GET", "/a", ""), b"a".to_vec(), Duration::from_secs(60));
        c.insert(key("GET", "/b", ""), b"b".to_vec(), Duration::from_secs(60));
        c.insert(key("GET", "/c", ""), b"c".to_vec(), Duration::from_secs(60));
        let removed = c.clear();
        assert_eq!(removed, 3);
        assert_eq!(c.stats().len, 0);
    }

    #[test]
    fn invalidate_and_clear_preserve_hits_and_misses() {
        let c = LruCache::new();
        c.insert(key("GET", "/a", ""), b"a".to_vec(), Duration::from_secs(60));
        let _ = c.get(&key("GET", "/a", "")); // hit
        let _ = c.get(&key("GET", "/missing", "")); // miss
        assert_eq!(c.stats().hits, 1);
        assert_eq!(c.stats().misses, 1);

        c.invalidate_path("GET", "/a");
        assert_eq!(c.stats().hits, 1);
        assert_eq!(c.stats().misses, 1);

        c.clear();
        assert_eq!(c.stats().hits, 1);
        assert_eq!(c.stats().misses, 1);
    }
}
