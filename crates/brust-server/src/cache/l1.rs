//! L1: the per-route response cache, carried from brust-core
//! `cache/response_cache.rs` @ d04718f with the value re-typed — an entry is
//! the merged JSON render context (after loader + jobs), never HTML or framed
//! bytes; Rust re-renders on every hit. API otherwise as 0.1.x, plus
//! `invalidate_tags` returning the removed-key count and `build_cache_key`
//! (moved here from `server/mod.rs`).
//!
//! Tag-index consistency (v2 change): every insert stamps a fresh generation
//! number on the entry and on its index slots; the eviction listener removes an
//! index slot only when the generation matches the evicted value. 0.1.x pruned
//! by key alone, so a re-insert over a live-or-expired key (moka reports
//! `RemovalCause::Replaced`, also for an entry past its per-entry ttl) or a
//! maintenance pass evicting the old entry right after the new insert indexed
//! itself would un-index the NEWER entry, making it immune to tag invalidation.
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CacheKey {
    pub prefix: String,
    pub method: String,
    pub path: String,
    pub sorted_query: String,
}

#[derive(Clone)]
pub struct CachedEntry {
    pub ctx: Arc<Value>,
    /// The loader's response headers (never `Set-Cookie`: such a response is
    /// not cached), replayed on a HIT. `Arc`: cloned on every `get`.
    pub headers: Arc<[(String, String)]>,
    pub ttl: Duration,
    /// Invalidation tags this entry was inserted under. Carried on the entry so
    /// the eviction listener can prune `tag_index` when moka removes the entry
    /// (capacity eviction, TTL expiry, explicit invalidation). `Arc` because the
    /// entry is cloned on every `get`.
    pub tags: Arc<[String]>,
}

/// What moka stores: the public entry plus the insert generation that guards
/// the tag index (see module docs).
#[derive(Clone)]
struct Slot {
    entry: CachedEntry,
    generation: u64,
}

/// Per-entry expiry policy: each entry lives for its own `ttl`, measured from
/// the most recent write. moka enforces this lazily on read and during its
/// maintenance passes. `expire_after_update` mirrors `expire_after_create` so a
/// re-insert of an existing key resets the clock — matching the old
/// `inserted_at = Instant::now()` on every `put` (without it, a re-render that
/// re-caches a live key would silently inherit the stale entry's remaining
/// lifetime instead of a fresh TTL).
struct ResponseExpiry;

impl moka::Expiry<CacheKey, Slot> for ResponseExpiry {
    fn expire_after_create(
        &self,
        _key: &CacheKey,
        value: &Slot,
        _created_at: std::time::Instant,
    ) -> Option<Duration> {
        Some(value.entry.ttl)
    }

    fn expire_after_update(
        &self,
        _key: &CacheKey,
        value: &Slot,
        _updated_at: std::time::Instant,
        _duration_until_expiry: Option<Duration>,
    ) -> Option<Duration> {
        Some(value.entry.ttl)
    }
}

/// Stats snapshot, shared by L1 and the job cache. Serialized to JSON by the
/// /_brust/cache/stats native route.
#[derive(Debug, Clone, Serialize)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    pub len: usize,
    pub capacity: usize,
}

/// tag → (key → generation of the insert that indexed it).
pub(crate) type TagIndex<K> = Mutex<HashMap<String, HashMap<K, u64>>>;

/// Index `key` under `tags` at `generation` (overwrites an older generation).
pub(crate) fn index_tags<K: Clone + Eq + std::hash::Hash>(
    index: &TagIndex<K>,
    key: &K,
    tags: &[String],
    generation: u64,
) {
    if tags.is_empty() {
        return;
    }
    let mut idx = index.lock();
    for tag in tags {
        idx.entry(tag.clone())
            .or_default()
            .insert(key.clone(), generation);
    }
}

/// Eviction-listener body: drop `key` from each of `tags` only while the slot
/// still belongs to the evicted value's `generation`.
pub(crate) fn prune_tags<K: Eq + std::hash::Hash>(
    index: &TagIndex<K>,
    key: &K,
    tags: &[String],
    generation: u64,
) {
    if tags.is_empty() {
        return;
    }
    let mut idx = index.lock();
    for tag in tags {
        if let Some(set) = idx.get_mut(tag) {
            if set.get(key) == Some(&generation) {
                set.remove(key);
            }
            if set.is_empty() {
                idx.remove(tag);
            }
        }
    }
}

/// Remove every tag in `tags` from the index and return the distinct keys they
/// held. The lock is dropped before the caller touches moka.
pub(crate) fn take_tagged<K: Clone + Eq + std::hash::Hash>(
    index: &TagIndex<K>,
    tags: &[String],
) -> HashSet<K> {
    let mut idx = index.lock();
    tags.iter()
        .filter_map(|t| idx.remove(t))
        .flat_map(|m| m.into_keys())
        .collect()
}

pub struct L1Cache {
    inner: moka::sync::Cache<CacheKey, Slot>,
    /// tag → set of keys carrying that tag. Enables group invalidation, which
    /// moka has no native support for. UNLIKE the job cache (whose keys are
    /// content/developer-derived), L1 keys are REQUEST-derived — the sorted
    /// query string is part of the key — so an unbounded index would be
    /// attacker-growable (`?x=<random>` per request on any tagged route). The
    /// eviction listener registered in `with_capacity` prunes the index
    /// whenever moka removes an entry (capacity eviction, TTL expiry, explicit
    /// or rejected insert), bounding the index by the live entry set. Shared
    /// `Arc` because the listener closure needs its own handle.
    tag_index: Arc<TagIndex<CacheKey>>,
    next_generation: AtomicU64,
    hits: AtomicU64,
    misses: AtomicU64,
    capacity: u64,
}

impl L1Cache {
    pub fn new() -> Self {
        Self::with_capacity(1000)
    }

    /// Build an L1 cache with an explicit max-entry capacity. moka fixes
    /// capacity at construction. Capacity is floored at 1.
    pub fn with_capacity(max_capacity: u64) -> Self {
        let capacity = max_capacity.max(1);
        let tag_index: Arc<TagIndex<CacheKey>> = Arc::new(Mutex::new(HashMap::new()));
        // Prune the tag index whenever moka drops an entry, whatever the cause
        // (capacity eviction, TTL expiry, explicit invalidate, rejected insert,
        // replace). Without this the index would grow without bound under
        // request-derived keys. The generation check keeps a replace/evict of
        // an OLD value from un-indexing the NEWER value under the same key. The
        // listener runs on the thread driving moka maintenance; no caller holds
        // the tag_index lock across a moka call (see insert / invalidate_tags /
        // clear), so re-entry cannot deadlock.
        let listener_index = Arc::clone(&tag_index);
        let inner = moka::sync::Cache::builder()
            .max_capacity(capacity)
            .support_invalidation_closures()
            .expire_after(ResponseExpiry)
            .eviction_listener(move |key: Arc<CacheKey>, value: Slot, _cause| {
                prune_tags(&listener_index, &*key, &value.entry.tags, value.generation);
            })
            .build();
        Self {
            inner,
            tag_index,
            next_generation: AtomicU64::new(0),
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
            capacity,
        }
    }

    pub fn get(&self, key: &CacheKey) -> Option<CachedEntry> {
        // moka enforces TTL expiry internally; an entry returned here is live.
        match self.inner.get(key) {
            Some(slot) => {
                self.hits.fetch_add(1, Ordering::Relaxed);
                Some(slot.entry)
            }
            None => {
                self.misses.fetch_add(1, Ordering::Relaxed);
                None
            }
        }
    }

    pub fn insert(
        &self,
        key: CacheKey,
        ctx: Arc<Value>,
        headers: Arc<[(String, String)]>,
        ttl: Duration,
        tags: &[String],
    ) {
        // Ordering is load-bearing: index the tags BEFORE the moka insert. The
        // reverse (insert then index) could leave a live, un-indexed entry if a
        // panic hit between the two. With this order the worst case is a benign
        // lost-invalidation (a concurrent invalidate_tags racing the insert just
        // misses the not-yet-present key — the entry then lazy-expires via TTL).
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        index_tags(&self.tag_index, &key, tags, generation);
        self.inner.insert(
            key,
            Slot {
                entry: CachedEntry {
                    ctx,
                    headers,
                    ttl,
                    tags: tags.into(),
                },
                generation,
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
            tracing::warn!("L1Cache::invalidate_path failed: {e}");
        }
        self.inner.run_pending_tasks();
        count
    }

    /// Remove every L1 entry carrying any of the given tags; returns the number
    /// of distinct keys collected from the index. Collect the affected keys
    /// under the tag-index lock, then DROP it before touching moka — moka's
    /// `invalidate` does internal eviction-scheduling work, and holding the
    /// Mutex across a large tag group would block every concurrent tagged
    /// `insert`. moka invalidation is eventual, so we drive `run_pending_tasks`.
    pub fn invalidate_tags(&self, tags: &[String]) -> usize {
        let keys = take_tagged(&self.tag_index, tags);
        let n = keys.len();
        for k in keys {
            self.inner.invalidate(&k);
        }
        self.inner.run_pending_tasks();
        n
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

impl Default for L1Cache {
    fn default() -> Self {
        Self::new()
    }
}

/// L1 key for a request: path and query split at the first `?`, query pairs
/// sorted so `?b=2&a=1` and `?a=1&b=2` share an entry. (server/mod.rs:1787-1798)
pub fn build_cache_key(method: &str, full_path: &str, prefix: String) -> CacheKey {
    let (path_only, query) = match full_path.split_once('?') {
        Some((p, q)) => (p, q),
        None => (full_path, ""),
    };
    CacheKey {
        prefix,
        method: method.to_string(),
        path: path_only.to_string(),
        sorted_query: sort_query(query),
    }
}

fn sort_query(query: &str) -> String {
    if query.is_empty() {
        return String::new();
    }
    let mut pairs: Vec<&str> = query.split('&').filter(|p| !p.is_empty()).collect();
    pairs.sort_unstable();
    pairs.join("&")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
        let c = L1Cache::new();
        c.insert(
            key("GET", "/t", ""),
            Arc::new(json!("t")),
            Arc::from([]),
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
        let c = L1Cache::new();
        c.insert(
            key("GET", "/p", "x=1"),
            Arc::new(json!("1")),
            Arc::from([]),
            Duration::from_secs(60),
            &["grp".to_string()],
        );
        c.insert(
            key("GET", "/p", "x=2"),
            Arc::new(json!("2")),
            Arc::from([]),
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
        let c = L1Cache::new();
        c.insert(
            key("GET", "/w", ""),
            Arc::new(json!("w")),
            Arc::from([]),
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
        let c = L1Cache::new();
        c.insert(
            key("GET", "/a", ""),
            Arc::new(json!("a")),
            Arc::from([]),
            Duration::from_secs(60),
            &[],
        );
        c.insert(
            key("GET", "/a", "x=1"),
            Arc::new(json!("a-x")),
            Arc::from([]),
            Duration::from_secs(60),
            &[],
        );
        c.insert(
            key("GET", "/b", ""),
            Arc::new(json!("b")),
            Arc::from([]),
            Duration::from_secs(60),
            &[],
        );
        c.run_pending();

        let removed = c.invalidate_path("GET", "/a");
        c.run_pending();
        assert_eq!(removed, 2);
        assert!(c.get(&key("GET", "/a", "")).map(|e| e.ctx).is_none());
        assert!(c.get(&key("GET", "/a", "x=1")).map(|e| e.ctx).is_none());
        assert_eq!(
            c.get(&key("GET", "/b", "")).map(|e| e.ctx),
            Some(Arc::new(json!("b")))
        );
    }

    #[test]
    fn invalidate_path_no_match_returns_zero() {
        let c = L1Cache::new();
        c.insert(
            key("GET", "/a", ""),
            Arc::new(json!("a")),
            Arc::from([]),
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
        let c = L1Cache::new();
        c.insert(
            key("GET", "/a", ""),
            Arc::new(json!("a")),
            Arc::from([]),
            Duration::from_secs(60),
            &["grp".to_string()],
        );
        c.insert(
            key("GET", "/a", "x=1"),
            Arc::new(json!("a-x")),
            Arc::from([]),
            Duration::from_secs(60),
            &["grp".to_string()],
        );
        c.insert(
            key("GET", "/b", ""),
            Arc::new(json!("b")),
            Arc::from([]),
            Duration::from_secs(60),
            &["other".to_string()],
        );
        c.run_pending();

        c.invalidate_tags(&["grp".to_string()]);
        c.run_pending();
        assert!(c.get(&key("GET", "/a", "")).map(|e| e.ctx).is_none());
        assert!(c.get(&key("GET", "/a", "x=1")).map(|e| e.ctx).is_none());
        assert_eq!(
            c.get(&key("GET", "/b", "")).map(|e| e.ctx),
            Some(Arc::new(json!("b"))),
            "untagged group survives"
        );
    }

    #[test]
    fn invalidate_tags_no_match_is_noop() {
        let c = L1Cache::new();
        c.insert(
            key("GET", "/a", ""),
            Arc::new(json!("a")),
            Arc::from([]),
            Duration::from_secs(60),
            &["grp".to_string()],
        );
        c.run_pending();
        c.invalidate_tags(&["missing".to_string()]);
        c.run_pending();
        assert_eq!(
            c.get(&key("GET", "/a", "")).map(|e| e.ctx),
            Some(Arc::new(json!("a")))
        );
    }

    #[test]
    fn clear_removes_all_entries_and_returns_count() {
        let c = L1Cache::new();
        c.insert(
            key("GET", "/a", ""),
            Arc::new(json!("a")),
            Arc::from([]),
            Duration::from_secs(60),
            &[],
        );
        c.insert(
            key("GET", "/b", ""),
            Arc::new(json!("b")),
            Arc::from([]),
            Duration::from_secs(60),
            &[],
        );
        c.insert(
            key("GET", "/c", ""),
            Arc::new(json!("c")),
            Arc::from([]),
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
        let c = L1Cache::new();
        c.insert(
            key("GET", "/a", ""),
            Arc::new(json!("a")),
            Arc::from([]),
            Duration::from_secs(60),
            &[],
        );
        c.run_pending();
        let _ = c.get(&key("GET", "/a", "")).map(|e| e.ctx); // hit
        let _ = c.get(&key("GET", "/missing", "")).map(|e| e.ctx); // miss
        assert_eq!(c.stats().hits, 1);
        assert_eq!(c.stats().misses, 1);

        c.invalidate_path("GET", "/a");
        assert_eq!(c.stats().hits, 1);
        assert_eq!(c.stats().misses, 1);

        c.clear();
        assert_eq!(c.stats().hits, 1);
        assert_eq!(c.stats().misses, 1);
    }

    #[test]
    fn build_cache_key_sorts_query_and_applies_prefix() {
        let k = build_cache_key("GET", "/p?b=2&a=1", "tenant-acme".to_string());
        assert_eq!(k.prefix, "tenant-acme");
        assert_eq!(k.path, "/p");
        assert_eq!(k.sorted_query, "a=1&b=2");
    }

    #[test]
    fn reinsert_keeps_newer_entry_tag_indexed() {
        // v2 regression: re-inserting a key (moka: RemovalCause::Replaced, also
        // reported for an entry already past its per-entry ttl) must not let
        // the listener for the OLD value un-index the NEW value.
        let c = L1Cache::new();
        let k = key("GET", "/r", "");
        c.insert(
            k.clone(),
            Arc::new(json!(1)),
            Arc::from([]),
            Duration::from_millis(1),
            &["t".to_string()],
        );
        std::thread::sleep(Duration::from_millis(5));
        c.insert(
            k.clone(),
            Arc::new(json!(2)),
            Arc::from([]),
            Duration::from_secs(60),
            &["t".to_string()],
        );
        c.run_pending();
        assert_eq!(c.tag_index_size(), 1, "new entry stays indexed");
        assert_eq!(c.invalidate_tags(&["t".to_string()]), 1);
        assert!(
            c.get(&k).map(|e| e.ctx).is_none(),
            "tag invalidation reaches the new entry"
        );
        assert_eq!(c.tag_index_size(), 0);
    }
}
