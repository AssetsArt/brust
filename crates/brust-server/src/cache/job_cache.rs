//! Per-component job cache: `JobKey` → the job's JSON result, with tag-group
//! invalidation and a per-entry ttl. Carried from brust-core
//! `cache/page_cache.rs` @ d04718f (set-before-index ordering, eviction-listener
//! index pruning) with: a typed key, a JSON payload, expiry enforced by a
//! `moka::Expiry` (mirroring L1's `ResponseExpiry`) instead of the hand-rolled
//! `expires_at`, hit/miss counters, the generation-guarded tag index shared
//! with L1 (see `l1.rs` module docs), a user-key index (`cache({key})` value →
//! its namespaced entries, same generation guard) for `invalidate({key})`, and
//! the insert/invalidate gate (see `L1Cache::insert`).
//!
//! Bounded by ENTRY COUNT (moka `max_capacity`), not bytes: a few very large
//! job values can hold more memory than the count suggests.
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use moka::sync::Cache;
use parking_lot::Mutex;
use serde_json::Value;

use super::l1::{CacheStats, TagIndex, index_tags, prune_tags, take_tagged};

/// `job_key()` hex, or `"k:<componentId>/<jobId>/<user key>"` for `cache({key})`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct JobKey(pub String);

#[derive(Clone)]
struct CachedJob {
    value: Arc<Value>,
    /// `None` = never expires (until invalidated or capacity-evicted).
    ttl: Option<Duration>,
    /// Tags this entry was stored under — carried so the eviction listener can
    /// prune `tag_index` when moka drops the entry. `Arc`: cloned on every get.
    tags: Arc<[String]>,
    /// The `cache({key})` value this entry is indexed under in `key_index`
    /// (pruned by the eviction listener like `tags`). A one-element slice so
    /// the tag-index helpers apply unchanged.
    user_key: Arc<[String]>,
    generation: u64,
}

/// Per-entry expiry: each job lives for its own `ttl` from its most recent
/// write (`None` → no expiry). Both hooks return the value's ttl so a re-insert
/// resets the clock (and a `None` re-insert clears an earlier expiry).
struct JobExpiry;

impl moka::Expiry<JobKey, CachedJob> for JobExpiry {
    fn expire_after_create(
        &self,
        _key: &JobKey,
        value: &CachedJob,
        _created_at: std::time::Instant,
    ) -> Option<Duration> {
        value.ttl
    }

    fn expire_after_update(
        &self,
        _key: &JobKey,
        value: &CachedJob,
        _updated_at: std::time::Instant,
        _duration_until_expiry: Option<Duration>,
    ) -> Option<Duration> {
        value.ttl
    }
}

pub struct JobCache {
    cache: Cache<JobKey, CachedJob>,
    tag_index: Arc<TagIndex<JobKey>>,
    /// user key → (JobKey → generation): every component's entry stored under
    /// that `cache({key})` value.
    key_index: Arc<TagIndex<JobKey>>,
    /// Insert/invalidate gate, as `L1Cache::gate`: shared across "index, then
    /// moka insert"; exclusive for index-driven invalidation and `clear`.
    gate: parking_lot::RwLock<()>,
    next_generation: AtomicU64,
    hits: AtomicU64,
    misses: AtomicU64,
    capacity: u64,
    #[cfg(test)]
    pub(crate) mid_insert: super::l1::MidInsertHook,
}

impl JobCache {
    pub fn new(max_capacity: u64) -> Self {
        let capacity = max_capacity.max(1);
        let tag_index: Arc<TagIndex<JobKey>> = Arc::new(Mutex::new(HashMap::new()));
        // Prune the index on every moka removal (eviction/expiry/invalidate/
        // replace), mirroring L1. Job keys are content/developer-computed, so
        // growth is slower than L1's request-derived keys, but the same
        // unbounded-index shape applies (e.g. per-row keys under a static tag).
        // No caller holds the tag_index lock across a moka call, so the
        // listener can't deadlock.
        let key_index: Arc<TagIndex<JobKey>> = Arc::new(Mutex::new(HashMap::new()));
        let listener_index = Arc::clone(&tag_index);
        let listener_keys = Arc::clone(&key_index);
        let cache = Cache::builder()
            .max_capacity(capacity)
            .expire_after(JobExpiry)
            .eviction_listener(move |key: Arc<JobKey>, value: CachedJob, _cause| {
                prune_tags(&listener_index, &*key, &value.tags, value.generation);
                prune_tags(&listener_keys, &*key, &value.user_key, value.generation);
            })
            .build();
        Self {
            cache,
            tag_index,
            key_index,
            gate: parking_lot::RwLock::new(()),
            next_generation: AtomicU64::new(0),
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
            capacity,
            #[cfg(test)]
            mid_insert: Mutex::new(None),
        }
    }

    pub fn get(&self, k: &JobKey) -> Option<Arc<Value>> {
        // moka enforces per-entry expiry on read; an entry returned here is live.
        match self.cache.get(k) {
            Some(job) => {
                self.hits.fetch_add(1, Ordering::Relaxed);
                Some(job.value)
            }
            None => {
                self.misses.fetch_add(1, Ordering::Relaxed);
                None
            }
        }
    }

    /// `user_key`: the evaluated `cache({key})` value, indexed so
    /// [`JobCache::invalidate_user_key`] finds this entry.
    pub fn insert(
        &self,
        k: JobKey,
        value: Arc<Value>,
        ttl: Option<Duration>,
        tags: &[String],
        user_key: Option<&str>,
    ) {
        // Index BEFORE the moka insert, under the shared gate (see
        // `L1Cache::insert`: without the gate an invalidation landing between
        // the two steps loses the entry from the index forever). The eviction
        // listener prunes both indexes when moka drops the entry.
        let user_key: Arc<[String]> = user_key.map(String::from).into_iter().collect();
        let _gate = self.gate.read();
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        index_tags(&self.tag_index, &k, tags, generation);
        index_tags(&self.key_index, &k, &user_key, generation);
        #[cfg(test)]
        if let Some(h) = &*self.mid_insert.lock() {
            h();
        }
        self.cache.insert(
            k,
            CachedJob {
                value,
                ttl,
                tags: tags.into(),
                user_key,
                generation,
            },
        );
    }

    /// Remove one entry; `true` when moka held it (live or not yet reaped).
    pub fn invalidate_key(&self, k: &JobKey) -> bool {
        self.cache.remove(k).is_some()
    }

    /// Remove every entry carrying any of `tags`; returns the number of
    /// distinct keys collected from the index.
    pub fn invalidate_tags(&self, tags: &[String]) -> usize {
        self.invalidate_indexed(&self.tag_index, tags)
    }

    /// Remove every entry stored under the `cache({key})` value `user_key`, in
    /// any component/job; returns the number of keys collected from the index.
    pub fn invalidate_user_key(&self, user_key: &str) -> usize {
        self.invalidate_indexed(&self.key_index, &[user_key.to_string()])
    }

    fn invalidate_indexed(&self, index: &TagIndex<JobKey>, names: &[String]) -> usize {
        let _gate = self.gate.write(); // no insert is mid-way (see `insert`)
        let keys = take_tagged(index, names);
        let n = keys.len();
        for k in keys {
            self.cache.invalidate(&k);
        }
        n
    }

    pub fn clear(&self) {
        // Wipe moka + the tag index atomically from the index's perspective
        // (a concurrent tagged insert also locks tag_index, so it can't slip an
        // entry in between the two wipes). run_pending_tasks runs AFTER the lock
        // is dropped — holding the Mutex across moka's eviction callbacks risks
        // re-entrant deadlock if a callback ever calls back into the cache.
        {
            let _gate = self.gate.write();
            let mut idx = self.tag_index.lock();
            let mut keys = self.key_index.lock();
            self.cache.invalidate_all();
            idx.clear();
            keys.clear();
        }
        self.cache.run_pending_tasks();
    }

    pub fn stats(&self) -> CacheStats {
        // entry_count is eventually consistent; drive maintenance first (as L1).
        self.cache.run_pending_tasks();
        CacheStats {
            hits: self.hits.load(Ordering::Relaxed),
            misses: self.misses.load(Ordering::Relaxed),
            len: self.cache.entry_count() as usize,
            capacity: self.capacity as usize,
        }
    }

    /// Total keys currently indexed across all tags (test hook for the
    /// eviction-listener pruning invariant).
    #[cfg(test)]
    pub(crate) fn tag_index_size(&self) -> usize {
        self.tag_index.lock().values().map(|s| s.len()).sum()
    }

    /// Total keys currently in the user-key index.
    #[cfg(test)]
    pub(crate) fn key_index_size(&self) -> usize {
        self.key_index.lock().values().map(|s| s.len()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn store() -> JobCache {
        JobCache::new(100)
    }
    fn sync(s: &JobCache) {
        s.cache.run_pending_tasks();
    }
    fn k(s: &str) -> JobKey {
        JobKey(s.to_string())
    }

    #[test]
    fn set_then_get_returns_payload() {
        let s = store();
        s.insert(k("k1"), Arc::new(json!("PAYLOAD")), None, &[], None);
        assert_eq!(s.get(&k("k1")), Some(Arc::new(json!("PAYLOAD"))));
    }
    #[test]
    fn missing_is_none() {
        assert!(store().get(&k("nope")).is_none());
    }
    #[test]
    fn zero_ttl_expires_immediately() {
        // moka 0.12.16 per-entry expiry: the expiration time (write time +
        // ttl) is stamped at insert, and a read treats `expiration_time <= now`
        // as expired, so ZERO is a miss on the very next read with no
        // maintenance pass in between. (Reaping the entry from entry_count is
        // left to moka's timer wheel and is NOT immediate — not asserted.)
        let s = store();
        s.insert(
            k("k"),
            Arc::new(json!("x")),
            Some(Duration::ZERO),
            &[],
            None,
        );
        assert!(s.get(&k("k")).is_none());
        assert_eq!(s.stats().misses, 1, "the read counts as a miss");
    }
    #[test]
    fn future_ttl_is_hit() {
        let s = store();
        s.insert(
            k("k"),
            Arc::new(json!("x")),
            Some(Duration::from_secs(60)),
            &[],
            None,
        );
        assert!(s.get(&k("k")).is_some());
    }
    #[test]
    fn invalidate_key_removes_one() {
        let s = store();
        s.insert(k("a"), Arc::new(json!("a")), None, &[], None);
        s.insert(k("b"), Arc::new(json!("b")), None, &[], None);
        assert!(s.invalidate_key(&k("a")));
        assert!(
            !s.invalidate_key(&k("a")),
            "second invalidate finds nothing"
        );
        sync(&s);
        assert!(s.get(&k("a")).is_none());
        assert!(s.get(&k("b")).is_some());
    }
    #[test]
    fn invalidate_tags_removes_group() {
        let s = store();
        s.insert(k("a"), Arc::new(json!("a")), None, &["user:1".into()], None);
        s.insert(k("b"), Arc::new(json!("b")), None, &["user:1".into()], None);
        s.insert(k("c"), Arc::new(json!("c")), None, &["user:2".into()], None);
        assert_eq!(s.invalidate_tags(&["user:1".into()]), 2);
        sync(&s);
        assert!(s.get(&k("a")).is_none());
        assert!(s.get(&k("b")).is_none());
        assert!(s.get(&k("c")).is_some());
    }
    #[test]
    fn eviction_listener_prunes_other_tags_on_invalidate() {
        let s = store();
        s.insert(
            k("k"),
            Arc::new(json!("x")),
            None,
            &["a".into(), "b".into()],
            None,
        );
        sync(&s);
        assert_eq!(s.tag_index_size(), 2);
        s.invalidate_tags(&["a".into()]);
        sync(&s);
        assert_eq!(s.tag_index_size(), 0, "listener prunes the key from b too");
    }

    #[test]
    fn clear_wipes_tag_index() {
        let s = store();
        s.insert(k("k"), Arc::new(json!("x")), None, &["t".into()], None);
        sync(&s);
        assert_eq!(s.tag_index_size(), 1);
        s.clear();
        assert_eq!(s.tag_index_size(), 0);
    }

    #[test]
    fn clear_empties() {
        let s = store();
        s.insert(k("a"), Arc::new(json!("a")), None, &["t".into()], None);
        s.clear();
        assert!(s.get(&k("a")).is_none());
    }

    #[test]
    fn ttl_none_survives_until_invalidated() {
        let s = store();
        s.insert(k("n"), Arc::new(json!("x")), None, &["t".into()], None);
        s.insert(
            k("short"),
            Arc::new(json!("y")),
            Some(Duration::from_millis(1)),
            &[],
            None,
        );
        std::thread::sleep(Duration::from_millis(20));
        sync(&s);
        assert!(s.get(&k("short")).is_none(), "ttl'd neighbour expired");
        assert_eq!(
            s.get(&k("n")),
            Some(Arc::new(json!("x"))),
            "None never expires"
        );
        // A re-insert with `None` over a ttl'd entry clears the expiry too.
        s.insert(
            k("short"),
            Arc::new(json!("z")),
            Some(Duration::from_secs(60)),
            &[],
            None,
        );
        s.insert(k("short"), Arc::new(json!("z")), None, &[], None);
        assert!(s.get(&k("short")).is_some());
        assert_eq!(s.invalidate_tags(&["t".into()]), 1);
        sync(&s);
        assert!(s.get(&k("n")).is_none(), "gone once invalidated");
    }

    #[test]
    fn stats_count_hits_and_misses() {
        let s = JobCache::new(7);
        s.insert(k("a"), Arc::new(json!(1)), None, &[], None);
        let _ = s.get(&k("a"));
        let _ = s.get(&k("a"));
        let _ = s.get(&k("missing"));
        let st = s.stats();
        assert_eq!((st.hits, st.misses, st.len, st.capacity), (2, 1, 1, 7));
        s.clear();
        let st = s.stats();
        assert_eq!(
            (st.hits, st.misses, st.len),
            (2, 1, 0),
            "clear keeps counters"
        );
    }

    #[test]
    fn reinsert_keeps_newer_entry_tag_indexed() {
        // v2 regression (see l1.rs module docs): the Replaced notification for
        // the old value must not un-index the new value.
        let s = store();
        s.insert(k("r"), Arc::new(json!(1)), None, &["t".into()], None);
        s.insert(k("r"), Arc::new(json!(2)), None, &["t".into()], None);
        sync(&s);
        assert_eq!(s.tag_index_size(), 1, "new entry stays indexed");
        assert_eq!(s.invalidate_tags(&["t".into()]), 1);
        sync(&s);
        assert!(
            s.get(&k("r")).is_none(),
            "tag invalidation reaches the new entry"
        );
    }

    #[test]
    fn user_key_invalidates_every_namespaced_entry() {
        let s = store();
        s.insert(k("k:a/j0/5"), Arc::new(json!(1)), None, &[], Some("5"));
        s.insert(k("k:b/j0/5"), Arc::new(json!(2)), None, &[], Some("5"));
        s.insert(k("k:b/j0/6"), Arc::new(json!(3)), None, &[], Some("6"));
        assert_eq!(s.key_index_size(), 3);
        assert_eq!(s.invalidate_user_key("5"), 2);
        sync(&s);
        assert!(s.get(&k("k:a/j0/5")).is_none());
        assert!(s.get(&k("k:b/j0/5")).is_none());
        assert!(s.get(&k("k:b/j0/6")).is_some());
        assert_eq!(s.invalidate_user_key("5"), 0);
        // The index is pruned when moka drops an entry (generation-guarded: a
        // re-insert keeps the newer entry indexed).
        s.insert(k("k:b/j0/6"), Arc::new(json!(4)), None, &[], Some("6"));
        sync(&s);
        assert_eq!(s.key_index_size(), 1);
        assert!(s.invalidate_key(&k("k:b/j0/6")));
        sync(&s);
        assert_eq!(s.key_index_size(), 0);
        s.insert(k("k:c/j0/7"), Arc::new(json!(5)), None, &[], Some("7"));
        s.clear();
        assert_eq!(s.key_index_size(), 0);
    }

    #[test]
    fn invalidate_between_index_and_insert_is_not_lost() {
        // See the L1 twin: the invalidation starts while the insert is paused
        // between its index write and its moka insert.
        for by_key in [false, true] {
            let c = Arc::new(store());
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            *c.mid_insert.lock() = Some(Box::new(move || {
                tx.send(()).unwrap();
                std::thread::sleep(Duration::from_millis(50));
            }));
            let c2 = Arc::clone(&c);
            let ins = std::thread::spawn(move || {
                c2.insert(k("r"), Arc::new(json!(1)), None, &["t".into()], Some("u"))
            });
            rx.recv().unwrap();
            if by_key {
                c.invalidate_user_key("u");
            } else {
                c.invalidate_tags(&["t".into()]);
            }
            ins.join().unwrap();
            assert!(c.get(&k("r")).is_none(), "by_key={by_key}");
        }
    }
}
