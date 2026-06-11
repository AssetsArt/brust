use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};

const CACHE_CAPACITY: usize = 1000;

// Per-request bypass: `true` ⇒ always route to L2; a string ⇒ a key-expression
// whose non-empty result ⇒ route to L2. Untagged so JSON `true` / "expr" both
// deserialize. (bool and string are disjoint JSON types — no ambiguity.)
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum BypassSpec {
    Always(bool),
    Expr(String),
}

#[derive(Debug, Clone, Deserialize)]
pub struct CacheConfig {
    pub ttl_seconds: u64,
    #[serde(default)]
    pub prefix: Option<String>,
    #[serde(default)]
    pub bypass: Option<BypassSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CacheKey {
    pub prefix: String,
    pub method: String,
    pub path: String,
    pub sorted_query: String,
}

#[derive(Clone)]
pub struct CachedEntry {
    pub response_bytes: Vec<u8>,
    pub ttl: Duration,
}

/// Per-entry expiry policy: each entry lives for its own `ttl`, measured from
/// the most recent write. moka enforces this lazily on read and during its
/// maintenance passes. `expire_after_update` mirrors `expire_after_create` so a
/// re-insert of an existing key resets the clock — matching the old
/// `inserted_at = Instant::now()` on every `put` (without it, a re-render that
/// re-caches a live key would silently inherit the stale entry's remaining
/// lifetime instead of a fresh TTL).
struct ResponseExpiry;

impl moka::Expiry<CacheKey, CachedEntry> for ResponseExpiry {
    fn expire_after_create(
        &self,
        _key: &CacheKey,
        value: &CachedEntry,
        _created_at: std::time::Instant,
    ) -> Option<Duration> {
        Some(value.ttl)
    }

    fn expire_after_update(
        &self,
        _key: &CacheKey,
        value: &CachedEntry,
        _updated_at: std::time::Instant,
        _duration_until_expiry: Option<Duration>,
    ) -> Option<Duration> {
        Some(value.ttl)
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

pub struct ResponseCache {
    inner: moka::sync::Cache<CacheKey, CachedEntry>,
    hits: AtomicU64,
    misses: AtomicU64,
}

impl ResponseCache {
    pub fn new() -> Self {
        Self {
            inner: moka::sync::Cache::builder()
                .max_capacity(CACHE_CAPACITY as u64)
                .support_invalidation_closures()
                .expire_after(ResponseExpiry)
                .build(),
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
        }
    }

    pub fn get(&self, key: &CacheKey) -> Option<Vec<u8>> {
        // moka enforces TTL expiry internally; an entry returned here is live.
        match self.inner.get(key) {
            Some(entry) => {
                self.hits.fetch_add(1, Ordering::Relaxed);
                Some(entry.response_bytes)
            }
            None => {
                self.misses.fetch_add(1, Ordering::Relaxed);
                None
            }
        }
    }

    pub fn insert(&self, key: CacheKey, response_bytes: Vec<u8>, ttl: Duration) {
        self.inner.insert(
            key,
            CachedEntry {
                response_bytes,
                ttl,
            },
        );
    }

    pub fn stats(&self) -> CacheStats {
        // moka's `entry_count` is eventually consistent — drive pending tasks so
        // the observability endpoint reflects the current entry count instead of
        // a stale lower bound (otherwise a freshly-inserted entry reads as len=0
        // right after the insert). hits/misses are atomic and already exact.
        self.inner.run_pending_tasks();
        CacheStats {
            hits: self.hits.load(Ordering::Relaxed),
            misses: self.misses.load(Ordering::Relaxed),
            len: self.inner.entry_count() as usize,
            capacity: CACHE_CAPACITY,
        }
    }

    /// No-op on moka: the cache capacity is fixed at construction
    /// (`CACHE_CAPACITY`). Retained for API compatibility with the prior
    /// `lru`-backed implementation.
    pub fn resize(&self, _max: NonZeroUsize) {
        // debug, not warn: this is called on the normal `configureCache` startup
        // path, so a warn would flood production logs on every boot.
        tracing::debug!("ResponseCache::resize is a no-op on moka");
    }

    /// Remove every entry whose key has the given method + path (regardless
    /// of query string or vary values). Returns the number of matching
    /// entries at the time of the call. Hits/misses counters are NOT reset.
    ///
    /// moka invalidation is eventual: callers wanting the entries gone before
    /// observing must drive `run_pending_tasks()`.
    pub fn invalidate_path(&self, method: &str, path: &str) -> usize {
        let count = self
            .inner
            .iter()
            .filter(|(k, _)| k.method == method && k.path == path)
            .count();
        let method = method.to_string();
        let path = path.to_string();
        if let Err(e) = self
            .inner
            .invalidate_entries_if(move |k, _| k.method == method && k.path == path)
        {
            tracing::warn!("ResponseCache::invalidate_path failed: {e}");
        }
        self.inner.run_pending_tasks();
        count
    }

    /// Remove every entry. Hits/misses counters are NOT reset (they
    /// represent lifetime totals; operators wanting a fresh window can
    /// scrape `/stats` and compute deltas).
    pub fn clear(&self) -> usize {
        let n = self.inner.entry_count() as usize;
        self.inner.invalidate_all();
        self.inner.run_pending_tasks();
        n
    }

    #[cfg(test)]
    pub(crate) fn run_pending(&self) {
        self.inner.run_pending_tasks();
    }
}

impl Default for ResponseCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(method: &str, path: &str, query: &str) -> CacheKey {
        CacheKey {
            prefix: String::new(),
            method: method.to_string(),
            path: path.to_string(),
            sorted_query: query.to_string(),
        }
    }

    #[test]
    fn prefix_is_collision_free_field() {
        let a = CacheKey {
            prefix: "ten".into(),
            method: "GET".into(),
            path: "/ant".into(),
            sorted_query: String::new(),
        };
        let b = CacheKey {
            prefix: "tenant".into(),
            method: "GET".into(),
            path: "".into(),
            sorted_query: String::new(),
        };
        assert_ne!(a, b, "prefix is a distinct field, cannot collide with path");
    }

    #[test]
    fn invalidate_path_removes_only_matching_entries() {
        let c = ResponseCache::new();
        c.insert(key("GET", "/a", ""), b"a".to_vec(), Duration::from_secs(60));
        c.insert(
            key("GET", "/a", "x=1"),
            b"a-x".to_vec(),
            Duration::from_secs(60),
        );
        c.insert(key("GET", "/b", ""), b"b".to_vec(), Duration::from_secs(60));
        c.run_pending();

        let removed = c.invalidate_path("GET", "/a");
        c.run_pending();
        assert_eq!(removed, 2);
        assert!(c.get(&key("GET", "/a", "")).is_none());
        assert!(c.get(&key("GET", "/a", "x=1")).is_none());
        assert_eq!(c.get(&key("GET", "/b", "")), Some(b"b".to_vec()));
    }

    #[test]
    fn invalidate_path_no_match_returns_zero() {
        let c = ResponseCache::new();
        c.insert(key("GET", "/a", ""), b"a".to_vec(), Duration::from_secs(60));
        c.run_pending();
        assert_eq!(c.invalidate_path("GET", "/missing"), 0);
        assert_eq!(c.invalidate_path("POST", "/a"), 0);
        c.run_pending();
        assert_eq!(c.stats().len, 1);
    }

    #[test]
    fn clear_removes_all_entries_and_returns_count() {
        let c = ResponseCache::new();
        c.insert(key("GET", "/a", ""), b"a".to_vec(), Duration::from_secs(60));
        c.insert(key("GET", "/b", ""), b"b".to_vec(), Duration::from_secs(60));
        c.insert(key("GET", "/c", ""), b"c".to_vec(), Duration::from_secs(60));
        c.run_pending();
        let removed = c.clear();
        c.run_pending();
        assert_eq!(removed, 3);
        assert_eq!(c.stats().len, 0);
    }

    #[test]
    fn invalidate_and_clear_preserve_hits_and_misses() {
        let c = ResponseCache::new();
        c.insert(key("GET", "/a", ""), b"a".to_vec(), Duration::from_secs(60));
        c.run_pending();
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
