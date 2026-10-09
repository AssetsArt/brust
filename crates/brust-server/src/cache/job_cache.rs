//! Per-component job cache: `JobKey` → the job's JSON result, with tag-group
//! invalidation and a per-entry ttl. Carried from brust-core
//! `cache/page_cache.rs` @ d04718f (set-before-index ordering, eviction-listener
//! index pruning) with: a typed key, a JSON payload, expiry enforced by a
//! `moka::Expiry` (mirroring L1's `ResponseExpiry`) instead of the hand-rolled
//! `expires_at`, hit/miss counters, the generation-guarded tag index shared
//! with L1 (see `l1.rs` module docs), a user-key index (`cache({key})` value →
//! its namespaced entries, same generation guard) for `invalidate({key})`, and
//! the insert/invalidate gate (see `L1Cache::insert`). Reads are served by a
//! sharded read front, moka kept as the lifetime policy (see [`JobCache`]).
//!
//! Bounded by ENTRY COUNT (moka `max_capacity`), not bytes: a few very large
//! job values can hold more memory than the count suggests.
use std::collections::HashMap;
use std::collections::hash_map::RandomState;
use std::hash::BuildHasher;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use moka::sync::Cache;
use parking_lot::{Mutex, RwLock};
use serde_json::Value;

use super::l1::{CacheStats, TagIndex, index_tags, prune_tags, take_tagged};

/// `job_key()` hex, or `"k:<componentId>/<jobId>/<user key>"` for `cache({key})`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct JobKey(pub String);

/// What moka tracks per key: the policy side only (ttl, index names,
/// generation). The payload lives in the read front (see [`JobCache`]).
#[derive(Clone)]
struct CachedJob {
    /// `None` = never expires (until invalidated or capacity-evicted).
    ttl: Option<Duration>,
    /// Tags this entry was stored under — carried so the eviction listener can
    /// prune `tag_index` when moka drops the entry.
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

/// A read-front entry: the payload, its own expiry deadline (checked on every
/// read, so a ttl is exact without moka on the read path) and the generation
/// tying it to the moka entry that owns its lifetime.
struct FrontEntry {
    value: Arc<Value>,
    expires_at: Option<Instant>,
    generation: u64,
    /// Millis since `JobCache::epoch` of the last read forwarded to moka.
    touched: AtomicU64,
}

/// One front shard, padded to its own cache lines so hot shards don't
/// false-share their lock words.
#[repr(align(128))]
struct Shard(RwLock<HashMap<JobKey, FrontEntry>>);

const SHARDS: usize = 64;

/// A hit/miss counter striped by thread: one shared `AtomicU64` bumped on
/// every read from 8 threads cost as much as the reads themselves
/// (`plan_C/lookups_x8`). Each thread bumps its own padded slot; `get` sums.
struct StripedCounter([PaddedU64; COUNTER_STRIPES]);

#[repr(align(128))]
#[derive(Default)]
struct PaddedU64(AtomicU64);

const COUNTER_STRIPES: usize = 16;

impl StripedCounter {
    fn new() -> Self {
        Self(std::array::from_fn(|_| PaddedU64::default()))
    }

    fn incr(&self) {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        thread_local! {
            static SLOT: usize = NEXT.fetch_add(1, Ordering::Relaxed) % COUNTER_STRIPES;
        }
        let slot = SLOT.with(|s| *s);
        self.0[slot].0.fetch_add(1, Ordering::Relaxed);
    }

    fn get(&self) -> u64 {
        self.0.iter().map(|c| c.0.load(Ordering::Relaxed)).sum()
    }
}
/// A front hit forwards at most one read per key per this interval to moka,
/// so its LRU order and TinyLFU frequencies still see hot keys.
const TOUCH_EVERY_MS: u64 = 100;

/// Remove `key` from `front` if it still holds the entry stamped `generation`.
fn remove_front(front: &[Shard], shard: usize, key: &JobKey, generation: u64) {
    let mut m = front[shard].0.write();
    if m.get(key).is_some_and(|e| e.generation == generation) {
        m.remove(key);
    }
}

/// Job cache = a read-mostly front + moka as the policy.
///
/// Reads hit only the front (`SHARDS` `RwLock<HashMap>`s): a read lock, the
/// entry's own `expires_at` check and one `Arc` clone. moka records every read
/// it serves (read buffer, frequency sketch, access time), so 8 threads reading
/// the same hot keys contended inside moka (bench `plan_C/lookups_x8`). moka
/// still owns every entry's lifetime — capacity eviction, admission, ttl
/// reaping — and its eviction listener drops the front entry of the same
/// generation (plus the index slots). A front hit forwards a read to moka at
/// most once per key per `TOUCH_EVERY_MS`; a front miss always does, as moka's
/// TinyLFU counts misses toward admission.
///
/// Invariant: a front entry of generation G exists only while moka holds G (or
/// G's insert is in flight). Writers of one key (`insert`, `invalidate_*`)
/// serialize on that key's `stripes` mutex so the front and moka see a key's
/// writes in the same order (and an insert stamps and indexes its generation
/// under it); the listener takes no stripe and removes only a matching
/// generation, so it cannot drop a newer entry. Lock order: gate → stripe →
/// index / front (each alone).
pub struct JobCache {
    cache: Cache<JobKey, CachedJob>,
    front: Arc<[Shard]>,
    stripes: Box<[Mutex<()>]>,
    hasher: RandomState,
    epoch: Instant,
    tag_index: Arc<TagIndex<JobKey>>,
    /// user key → (JobKey → generation): every component's entry stored under
    /// that `cache({key})` value.
    key_index: Arc<TagIndex<JobKey>>,
    /// Insert/invalidate gate, as `L1Cache::gate`: shared across "index, then
    /// moka insert"; exclusive for index-driven invalidation and `clear`.
    gate: RwLock<()>,
    next_generation: AtomicU64,
    hits: StripedCounter,
    misses: StripedCounter,
    capacity: u64,
    #[cfg(test)]
    pub(crate) mid_insert: super::l1::MidInsertHook,
}

impl JobCache {
    pub fn new(max_capacity: u64) -> Self {
        let capacity = max_capacity.max(1);
        let tag_index: Arc<TagIndex<JobKey>> = Arc::new(Mutex::new(HashMap::new()));
        let key_index: Arc<TagIndex<JobKey>> = Arc::new(Mutex::new(HashMap::new()));
        let front: Arc<[Shard]> = (0..SHARDS)
            .map(|_| Shard(RwLock::new(HashMap::new())))
            .collect();
        let hasher = RandomState::new();
        // Prune the indexes and the front on every moka removal (eviction/
        // expiry/admission reject/invalidate/replace), generation-guarded. The
        // listener takes each lock alone (never nested), and no caller holds
        // an index or front lock across a moka call, so it can't deadlock.
        let listener_index = Arc::clone(&tag_index);
        let listener_keys = Arc::clone(&key_index);
        let listener_front = Arc::clone(&front);
        let listener_hasher = hasher.clone();
        let cache = Cache::builder()
            .max_capacity(capacity)
            .expire_after(JobExpiry)
            .eviction_listener(move |key: Arc<JobKey>, value: CachedJob, _cause| {
                prune_tags(&listener_index, &*key, &value.tags, value.generation);
                prune_tags(&listener_keys, &*key, &value.user_key, value.generation);
                let shard = shard_of(&listener_hasher, &key);
                remove_front(&listener_front, shard, &key, value.generation);
            })
            .build();
        Self {
            cache,
            front,
            stripes: (0..SHARDS).map(|_| Mutex::new(())).collect(),
            hasher,
            epoch: Instant::now(),
            tag_index,
            key_index,
            gate: RwLock::new(()),
            next_generation: AtomicU64::new(0),
            hits: StripedCounter::new(),
            misses: StripedCounter::new(),
            capacity,
            #[cfg(test)]
            mid_insert: Mutex::new(None),
        }
    }

    pub fn get(&self, k: &JobKey) -> Option<Arc<Value>> {
        let shard = shard_of(&self.hasher, k);
        let now = Instant::now();
        let (hit, touch) = {
            let m = self.front[shard].0.read();
            match m.get(k) {
                Some(e) if e.expires_at.is_none_or(|t| now < t) => {
                    let ms = now.saturating_duration_since(self.epoch).as_millis() as u64;
                    let last = e.touched.load(Ordering::Relaxed);
                    let touch = ms.saturating_sub(last) >= TOUCH_EVERY_MS
                        && e.touched
                            .compare_exchange(last, ms, Ordering::Relaxed, Ordering::Relaxed)
                            .is_ok();
                    (Some(Arc::clone(&e.value)), touch)
                }
                // Missing, or past its ttl (moka reaps it; the listener then
                // drops this front entry).
                _ => (None, true),
            }
        };
        if touch {
            // Feed moka's access order / frequency sketch (see type docs).
            let _ = self.cache.get(k);
        }
        let counter = if hit.is_some() {
            &self.hits
        } else {
            &self.misses
        };
        counter.incr();
        hit
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
        // listener prunes both indexes (and the front) when moka drops the
        // entry.
        let user_key: Arc<[String]> = user_key.map(String::from).into_iter().collect();
        let _gate = self.gate.read();
        // The key's stripe covers generation, index and both stores, so
        // same-key inserts index and land in generation order. (Without it, a
        // racing pair could index as 6-then-5 but reach moka as 5-then-6: the
        // Replaced notification for 5 then pruned the slot, leaving the live
        // generation 6 un-indexed and immune to tag invalidation.)
        let shard = shard_of(&self.hasher, &k);
        let _stripe = self.stripes[shard].lock();
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        index_tags(&self.tag_index, &k, tags, generation);
        index_tags(&self.key_index, &k, &user_key, generation);
        #[cfg(test)]
        if let Some(h) = &*self.mid_insert.lock() {
            h();
        }
        let now = Instant::now();
        // Front first, then moka (whose Replaced notification for the older
        // generation then leaves this entry alone). The front lock is released
        // before the moka call: the listener may run inside it.
        self.front[shard].0.write().insert(
            k.clone(),
            FrontEntry {
                value,
                // A ttl past `Instant`'s range never expires.
                expires_at: ttl.and_then(|t| now.checked_add(t)),
                generation,
                touched: AtomicU64::new(
                    now.saturating_duration_since(self.epoch).as_millis() as u64
                ),
            },
        );
        self.cache.insert(
            k,
            CachedJob {
                ttl,
                tags: tags.into(),
                user_key,
                generation,
            },
        );
    }

    /// Remove `k` from moka and the front, in that key's write order.
    fn remove(&self, k: &JobKey) -> bool {
        let shard = shard_of(&self.hasher, k);
        let _stripe = self.stripes[shard].lock();
        let held = self.cache.remove(k).is_some();
        self.front[shard].0.write().remove(k);
        held
    }

    /// Remove one entry; `true` when moka held it (live or not yet reaped).
    pub fn invalidate_key(&self, k: &JobKey) -> bool {
        self.remove(k)
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
            self.remove(&k);
        }
        n
    }

    pub fn clear(&self) {
        // Wipe moka, the front and the indexes atomically from the index's
        // perspective: the exclusive gate keeps every insert out (an insert
        // holds it shared from its index write to its moka insert).
        // run_pending_tasks runs AFTER the locks are dropped — holding the
        // index Mutex across moka's eviction callbacks would deadlock.
        {
            let _gate = self.gate.write();
            self.cache.invalidate_all();
            for s in self.front.iter() {
                s.0.write().clear();
            }
            self.tag_index.lock().clear();
            self.key_index.lock().clear();
        }
        self.cache.run_pending_tasks();
    }

    pub fn stats(&self) -> CacheStats {
        // entry_count is eventually consistent; drive maintenance first (as L1).
        self.cache.run_pending_tasks();
        CacheStats {
            hits: self.hits.get(),
            misses: self.misses.get(),
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

    /// Entries in the read front (test hook: it must track moka's).
    #[cfg(test)]
    pub(crate) fn front_len(&self) -> usize {
        self.front.iter().map(|s| s.0.read().len()).sum()
    }
}

fn shard_of(hasher: &RandomState, k: &JobKey) -> usize {
    (hasher.hash_one(k) as usize) % SHARDS
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
    fn front_follows_moka_evictions_and_expiry() {
        // The read front holds an entry only while moka does: capacity
        // evictions/admission rejects drop it via the listener.
        let s = JobCache::new(10);
        for i in 0..200 {
            s.insert(k(&format!("e{i}")), Arc::new(json!(i)), None, &[], None);
        }
        let len = s.stats().len;
        assert!(len <= 10, "moka bounded: {len}");
        assert_eq!(s.front_len(), len, "front tracks moka's entry set");
        // An expired entry may linger in the front until moka's timer wheel
        // reaps it (coarse, as moka's own entry_count), but never reads.
        let s = store();
        s.insert(
            k("t"),
            Arc::new(json!(1)),
            Some(Duration::from_millis(1)),
            &[],
            None,
        );
        std::thread::sleep(Duration::from_millis(5));
        assert!(s.get(&k("t")).is_none());
        assert!(s.front_len() <= 1);
    }

    #[test]
    fn concurrent_reinserts_leave_front_and_moka_agreeing() {
        // Same-key writers serialize on their stripe, so the front and moka
        // end on the same generation and invalidation reaches the survivor.
        let c = Arc::new(store());
        std::thread::scope(|sc| {
            for t in 0..8 {
                let c = &c;
                sc.spawn(move || {
                    for i in 0..200 {
                        c.insert(
                            k("r"),
                            Arc::new(json!(t * 1000 + i)),
                            None,
                            &["t".into()],
                            None,
                        );
                        let _ = c.get(&k("r"));
                    }
                });
            }
        });
        sync(&c);
        assert_eq!(c.front_len(), 1);
        assert_eq!(c.invalidate_tags(&["t".into()]), 1);
        sync(&c);
        assert!(c.get(&k("r")).is_none());
        assert_eq!(c.front_len(), 0);
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
