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
    /// Invalidation tags this entry was inserted under. Carried on the entry so
    /// the eviction listener can prune `tag_index` when moka removes the entry
    /// (capacity eviction, TTL expiry, explicit invalidation). `Arc` because the
    /// entry is cloned on every `get`.
    pub tags: std::sync::Arc<[String]>,
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

type TagIndex =
    parking_lot::Mutex<std::collections::HashMap<String, std::collections::HashSet<CacheKey>>>;

pub struct ResponseCache {
    inner: moka::sync::Cache<CacheKey, CachedEntry>,
    /// tag → set of keys carrying that tag. Enables group invalidation, which
    /// moka has no native support for. UNLIKE the island/page caches (whose
    /// keys are developer-controlled), L1 keys are REQUEST-derived — the
    /// sorted query string is part of the key — so an unbounded index would be
    /// attacker-growable (`?x=<random>` per request on any tagged route). The
    /// eviction listener registered in `with_capacity` prunes the index
    /// whenever moka removes an entry (capacity eviction, TTL expiry, explicit
    /// or rejected insert), bounding the index by the live entry set. Shared
    /// `Arc` because the listener closure needs its own handle.
    tag_index: std::sync::Arc<TagIndex>,
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
        let tag_index: std::sync::Arc<TagIndex> =
            std::sync::Arc::new(parking_lot::Mutex::new(std::collections::HashMap::new()));
        // Prune the tag index whenever moka drops an entry, whatever the cause
        // (capacity eviction, TTL expiry, explicit invalidate, rejected insert).
        // Without this the index would grow without bound under request-derived
        // keys. The listener runs on the thread driving moka maintenance; no
        // caller holds the tag_index lock across a moka call (see insert /
        // invalidate_tags / clear), so re-entry cannot deadlock.
        let listener_index = std::sync::Arc::clone(&tag_index);
        let inner = moka::sync::Cache::builder()
            .max_capacity(capacity)
            .support_invalidation_closures()
            .expire_after(ResponseExpiry)
            .eviction_listener(
                move |key: std::sync::Arc<CacheKey>, value: CachedEntry, _cause| {
                    if value.tags.is_empty() {
                        return;
                    }
                    let mut idx = listener_index.lock();
                    for tag in value.tags.iter() {
                        if let Some(set) = idx.get_mut(tag) {
                            set.remove(&*key);
                            if set.is_empty() {
                                idx.remove(tag);
                            }
                        }
                    }
                },
            )
            .build();
        Self {
            inner,
            tag_index,
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
                tags: tags.into(),
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
        // Wipe the tag index alongside moka; the lock is dropped BEFORE
        // run_pending_tasks because the eviction listener (which also locks
        // tag_index) runs during maintenance. A concurrent tagged insert racing
        // the wipe self-heals: its entry is either wiped by invalidate_all (and
        // the listener prunes its index entry) or lands fresh after.
        {
            self.tag_index.lock().clear();
        }
        self.inner.invalidate_all();
        self.inner.run_pending_tasks();
        n
    }

    /// Total keys currently indexed across all tags (test/observability hook
    /// for the eviction-listener pruning invariant).
    #[cfg(test)]
    pub(crate) fn tag_index_size(&self) -> usize {
        self.tag_index.lock().values().map(|s| s.len()).sum()
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
    fn eviction_listener_prunes_other_tags_on_invalidate() {
        // A key tagged [a, b], invalidated via tag a: the index entry for a is
        // removed by invalidate_tags itself; the listener must ALSO prune the
        // key from b's set when moka drops the entry — otherwise every
        // multi-tagged eviction leaks index entries forever.
        let c = ResponseCache::new();
        c.insert(
            key("GET", "/t", ""),
            b"t".to_vec(),
            Duration::from_secs(60),
            &["a".to_string(), "b".to_string()],
        );
        c.run_pending();
        assert_eq!(c.tag_index_size(), 2);
        c.invalidate_tags(&["a".to_string()]);
        c.run_pending();
        assert_eq!(
            c.tag_index_size(),
            0,
            "listener must prune the key from tag b too"
        );
    }

    #[test]
    fn eviction_listener_prunes_on_invalidate_path() {
        let c = ResponseCache::new();
        c.insert(
            key("GET", "/p", "x=1"),
            b"1".to_vec(),
            Duration::from_secs(60),
            &["grp".to_string()],
        );
        c.insert(
            key("GET", "/p", "x=2"),
            b"2".to_vec(),
            Duration::from_secs(60),
            &["grp".to_string()],
        );
        c.run_pending();
        assert_eq!(c.tag_index_size(), 2);
        c.invalidate_path("GET", "/p");
        c.run_pending();
        assert_eq!(
            c.tag_index_size(),
            0,
            "predicate invalidation must prune the tag index via the listener"
        );
    }

    #[test]
    fn clear_wipes_tag_index() {
        let c = ResponseCache::new();
        c.insert(
            key("GET", "/w", ""),
            b"w".to_vec(),
            Duration::from_secs(60),
            &["t".to_string()],
        );
        c.run_pending();
        assert_eq!(c.tag_index_size(), 1);
        c.clear();
        assert_eq!(c.tag_index_size(), 0);
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
