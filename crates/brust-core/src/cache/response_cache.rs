use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};

// Per-request bypass: `true` ⇒ always route to L2; a string ⇒ a key-expression
// whose non-empty result ⇒ route to L2. Untagged so JSON `true` / "expr" both
// deserialize. (bool and string are disjoint JSON types — no ambiguity.)
//
// Notes: `bypass` lives inside CacheConfig, so it only fires on a route that
// also sets ttl_seconds. `false` is a no-op (== omitting bypass). On bypass the
// Rust side only sets the `bypassed` envelope flag + skips L1; the L2 read/write
// (page_cache_get/set) is owned by the TS worker — Rust provides the primitives
// but does no L2 fallback.
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
    /// Static, route-level L1 invalidation tags. L1 entries for this route
    /// carry these tags so `cache.invalidate({ tags })` can evict them (L1 is
    /// no longer TTL-only). Mirrors the island/L2 tag-index pattern.
    #[serde(default)]
    pub tags: Option<Vec<String>>,
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
    /// tag → set of keys carrying that tag. Enables group invalidation, which
    /// moka has no native support for. Mirrors `island_cache::MokaStore`. Stale
    /// entries (key already evicted) are tolerated: invalidate pops a
    /// possibly-absent key (no-op).
    tag_index:
        parking_lot::Mutex<std::collections::HashMap<String, std::collections::HashSet<CacheKey>>>,
    hits: AtomicU64,
    misses: AtomicU64,
    capacity: u64,
}

impl ResponseCache {
    pub fn new() -> Self {
        Self::with_capacity(1000)
    }

    /// Build a response cache with an explicit max-entry capacity. moka fixes
    /// capacity at construction, so the configurable knob is applied here (the
    /// addon reconstructs + swaps the cache at boot via
    /// `AppState::reconfigure_caches`). Capacity is floored at 1.
    pub fn with_capacity(max_capacity: u64) -> Self {
        let capacity = max_capacity.max(1);
        Self {
            inner: moka::sync::Cache::builder()
                .max_capacity(capacity)
                .support_invalidation_closures()
                .expire_after(ResponseExpiry)
                .build(),
            tag_index: parking_lot::Mutex::new(std::collections::HashMap::new()),
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
            capacity,
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

    pub fn insert(&self, key: CacheKey, response_bytes: Vec<u8>, ttl: Duration, tags: &[String]) {
        // Ordering is load-bearing: index the tags BEFORE the moka insert. The
        // reverse (insert then index) could leave a live, un-indexed entry if a
        // panic hit between the two. With this order the worst case is a benign
        // lost-invalidation (a concurrent invalidate_tags racing the insert just
        // misses the not-yet-present key — the entry then lazy-expires via TTL).
        if !tags.is_empty() {
            let mut idx = self.tag_index.lock();
            for tag in tags {
                idx.entry(tag.clone()).or_default().insert(key.clone());
            }
        }
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
            capacity: self.capacity as usize,
        }
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

    /// Remove every L1 entry carrying any of the given tags. Mirrors
    /// `island_cache::MokaStore::invalidate_tags`: collect the affected keys
    /// under the tag-index lock, then DROP it before touching moka — moka's
    /// `invalidate` does internal eviction-scheduling work, and holding the
    /// Mutex across a large tag group would block every concurrent tagged
    /// `insert`. moka invalidation is eventual, so we drive `run_pending_tasks`.
    pub fn invalidate_tags(&self, tags: &[String]) {
        let keys: Vec<CacheKey> = {
            let mut idx = self.tag_index.lock();
            tags.iter()
                .filter_map(|t| idx.remove(t))
                .flatten()
                .collect()
        };
        for k in keys {
            self.inner.invalidate(&k);
        }
        self.inner.run_pending_tasks();
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
        c.insert(
            key("GET", "/a", ""),
            b"a".to_vec(),
            Duration::from_secs(60),
            &[],
        );
        c.insert(
            key("GET", "/a", "x=1"),
            b"a-x".to_vec(),
            Duration::from_secs(60),
            &[],
        );
        c.insert(
            key("GET", "/b", ""),
            b"b".to_vec(),
            Duration::from_secs(60),
            &[],
        );
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
        c.insert(
            key("GET", "/a", ""),
            b"a".to_vec(),
            Duration::from_secs(60),
            &[],
        );
        c.run_pending();
        assert_eq!(c.invalidate_path("GET", "/missing"), 0);
        assert_eq!(c.invalidate_path("POST", "/a"), 0);
        c.run_pending();
        assert_eq!(c.stats().len, 1);
    }

    #[test]
    fn invalidate_tags_removes_all_keyed_entries_in_group() {
        let c = ResponseCache::new();
        c.insert(
            key("GET", "/a", ""),
            b"a".to_vec(),
            Duration::from_secs(60),
            &["grp".to_string()],
        );
        c.insert(
            key("GET", "/a", "x=1"),
            b"a-x".to_vec(),
            Duration::from_secs(60),
            &["grp".to_string()],
        );
        c.insert(
            key("GET", "/b", ""),
            b"b".to_vec(),
            Duration::from_secs(60),
            &["other".to_string()],
        );
        c.run_pending();

        c.invalidate_tags(&["grp".to_string()]);
        c.run_pending();
        assert!(c.get(&key("GET", "/a", "")).is_none());
        assert!(c.get(&key("GET", "/a", "x=1")).is_none());
        assert_eq!(
            c.get(&key("GET", "/b", "")),
            Some(b"b".to_vec()),
            "untagged group survives"
        );
    }

    #[test]
    fn invalidate_tags_no_match_is_noop() {
        let c = ResponseCache::new();
        c.insert(
            key("GET", "/a", ""),
            b"a".to_vec(),
            Duration::from_secs(60),
            &["grp".to_string()],
        );
        c.run_pending();
        c.invalidate_tags(&["missing".to_string()]);
        c.run_pending();
        assert_eq!(c.get(&key("GET", "/a", "")), Some(b"a".to_vec()));
    }

    #[test]
    fn clear_removes_all_entries_and_returns_count() {
        let c = ResponseCache::new();
        c.insert(
            key("GET", "/a", ""),
            b"a".to_vec(),
            Duration::from_secs(60),
            &[],
        );
        c.insert(
            key("GET", "/b", ""),
            b"b".to_vec(),
            Duration::from_secs(60),
            &[],
        );
        c.insert(
            key("GET", "/c", ""),
            b"c".to_vec(),
            Duration::from_secs(60),
            &[],
        );
        c.run_pending();
        let removed = c.clear();
        c.run_pending();
        assert_eq!(removed, 3);
        assert_eq!(c.stats().len, 0);
    }

    #[test]
    fn invalidate_and_clear_preserve_hits_and_misses() {
        let c = ResponseCache::new();
        c.insert(
            key("GET", "/a", ""),
            b"a".to_vec(),
            Duration::from_secs(60),
            &[],
        );
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
