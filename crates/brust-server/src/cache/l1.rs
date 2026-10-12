//! L1: the per-route response cache, carried from brust-core
//! `cache/response_cache.rs` @ d04718f with the value re-typed — an entry is
//! the merged JSON render context (after loader + jobs) plus, per the S10
//! amendment of 2026-10-09, the document rendered from it on the MISS (and,
//! lazily, its gzip); a HIT serves those bytes without re-rendering. The body
//! lives and dies with its entry. API otherwise as 0.1.x, plus
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
//!
//! Read front (M3-P P4): reads are served from 64 sharded maps in front of moka,
//! which stays the lifetime policy (capacity, admission, ttl reaping). The design
//! is the job cache's (`JobCache`: generation-stamped entries with their own
//! `expires_at`, the eviction listener's generation-guarded removal, per-shard
//! writer stripes, a 100 ms touch into moka, striped counters) with one
//! difference: shards are `crossbeam_utils::sync::ShardedLock`, because a page
//! probe reads ONE key and every reader of one `RwLock` word writes the same
//! cache line. A `ShardedLock` reader locks only its own sub-lock.
use std::collections::hash_map::RandomState;
use std::collections::{HashMap, HashSet};
use std::hash::BuildHasher;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use crossbeam_utils::sync::{ShardedLock, ShardedLockReadGuard, ShardedLockWriteGuard};

use bytes::Bytes;
use parking_lot::Mutex;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CacheKey {
    pub prefix: String,
    pub method: String,
    pub path: String,
    pub sorted_query: String,
}

/// The document a MISS rendered for an entry's ctx (S10 amendment): a HIT
/// serves these bytes. The render is a pure function of (templates, ctx,
/// manifest) — `useId`s and asset tags included — so they equal a fresh
/// render of `ctx`.
pub struct RenderedBody {
    pub status: u16,
    /// `Content-Type` + the loader's headers, validated once (no
    /// `x-brust-cache` / `Content-Encoding` / `Vary`: those are per request).
    /// Empty for a body that is not stored (nothing reads it then).
    pub headers: http::HeaderMap,
    /// The identity document.
    pub html: Bytes,
    /// Its gzip, made by the first gzip-accepting request (or seeded by a
    /// gzip-accepting MISS). `None` inside: gzip did not shrink it.
    pub gzip: OnceLock<Option<Bytes>>,
}

/// moka's side: policy only (the body lives in the read front).
#[derive(Clone)]
struct Slot {
    /// Per-entry lifetime, measured from the most recent write.
    ttl: Duration,
    /// Invalidation tags this entry was inserted under, carried so the eviction
    /// listener can prune `tag_index` when moka removes the entry.
    tags: Arc<[String]>,
    /// The insert generation that guards the tag index and the front (see module docs).
    generation: u64,
}

/// A read-front entry, as the job cache's `FrontEntry`: the body, its own expiry deadline (checked
/// on every read), the generation tying it to the moka entry that owns its lifetime, and
/// `touched` = millis since `L1Cache::epoch` of the last read forwarded to moka.
struct FrontEntry {
    body: Arc<RenderedBody>,
    expires_at: Option<Instant>,
    generation: u64,
    touched: AtomicU64,
}

type FrontMap = HashMap<CacheKey, FrontEntry>;

/// `ShardedLock`: a reader locks only its own thread's sub-lock, so readers of ONE hot key (probe S)
/// write no shared cache line; a writer locks every sub-lock (writes = MISS inserts, invalidations,
/// listener removals).
#[repr(align(128))]
struct Shard(ShardedLock<FrontMap>);

impl Shard {
    fn read(&self) -> ShardedLockReadGuard<'_, FrontMap> {
        self.0.read().unwrap_or_else(PoisonError::into_inner)
    }

    fn write(&self) -> ShardedLockWriteGuard<'_, FrontMap> {
        self.0.write().unwrap_or_else(PoisonError::into_inner)
    }
}

const SHARDS: usize = 64;
/// A front hit forwards at most one read per key per this interval to moka.
const TOUCH_EVERY_MS: u64 = 100;

/// A hit/miss counter striped by thread. Twin of the job cache's (dedupe after m3p-d: follow-up F-2).
pub(crate) struct StripedCounter([PaddedU64; COUNTER_STRIPES]);

#[repr(align(128))]
#[derive(Default)]
struct PaddedU64(AtomicU64);

const COUNTER_STRIPES: usize = 16;

impl StripedCounter {
    pub(crate) fn new() -> Self {
        Self(std::array::from_fn(|_| PaddedU64::default()))
    }

    pub(crate) fn incr(&self) {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        thread_local! {
            static SLOT: usize = NEXT.fetch_add(1, Ordering::Relaxed) % COUNTER_STRIPES;
        }
        let slot = SLOT.with(|s| *s);
        self.0[slot].0.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn get(&self) -> u64 {
        self.0.iter().map(|c| c.0.load(Ordering::Relaxed)).sum()
    }
}

fn shard_of(h: &RandomState, k: &CacheKey) -> usize {
    (h.hash_one(k) as usize) % SHARDS
}

/// Remove `key` from `front` if it still holds the entry stamped `generation`.
fn remove_front(front: &[Shard], shard: usize, key: &CacheKey, generation: u64) {
    let mut m = front[shard].write();
    if m.get(key).is_some_and(|e| e.generation == generation) {
        m.remove(key);
    }
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
        Some(value.ttl)
    }

    fn expire_after_update(
        &self,
        _key: &CacheKey,
        value: &Slot,
        _updated_at: std::time::Instant,
        _duration_until_expiry: Option<Duration>,
    ) -> Option<Duration> {
        Some(value.ttl)
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

/// When an L1 render began, in invalidation-sequence time (F86): taken by `L1Cache::read_stamp`
/// before the render reads app data, required by `L1Cache::insert`. The insert does not land if
/// a covering invalidation took a later sequence number.
#[must_use]
#[derive(Debug, Clone, Copy)]
pub struct ReadStamp(u64);

/// Slots per invalidation-sequence array (`tag_inval`, `path_inval`): 2 KiB each, constant.
const INVAL_SLOTS: usize = 256;

/// tag → (key → generation of the insert that indexed it).
pub(crate) type TagIndex<K> = Mutex<HashMap<String, HashMap<K, u64>>>;

/// Test-only hook run between an insert's index write and its moka insert,
/// to drive the insert/invalidate interleaving deterministically.
#[cfg(test)]
pub(crate) type MidInsertHook = Mutex<Option<Box<dyn Fn() + Send + Sync>>>;

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

/// L1 = a read-mostly front + moka as the policy (see the module docs).
///
/// Reads hit only the front (`SHARDS` `ShardedLock<HashMap>`s): a sub-lock read guard, the entry's
/// own `expires_at` check, and the caller's closure on the body. moka still owns every entry's
/// lifetime (capacity eviction, admission, ttl reaping) and its eviction listener drops the front
/// entry of the same generation (plus the index slots). A front hit forwards a read to moka at most
/// once per key per `TOUCH_EVERY_MS`; a front miss always does, as moka's TinyLFU counts misses
/// toward admission.
///
/// Invariant: a front entry of generation G exists only while moka holds G (or G's insert is in
/// flight). Writers of one key (`insert`, `remove`) serialize on that key's `stripes` mutex, hold
/// it across "stamp generation, index, front write, moka write", and release the front write guard
/// BEFORE any moka call (moka may run the listener inline). The listener takes the tag-index mutex
/// and a shard's write lock, each alone, and never a stripe or the gate; it removes only a matching
/// generation, so it cannot drop a newer entry. Lock order: gate -> stripe -> (index | front).
pub struct L1Cache {
    inner: moka::sync::Cache<CacheKey, Slot>,
    front: Arc<[Shard]>,
    stripes: Box<[Mutex<()>]>,
    hasher: RandomState,
    epoch: Instant,
    /// tag -> set of keys carrying that tag. Enables group invalidation, which
    /// moka has no native support for. UNLIKE the job cache (whose keys are
    /// content/developer-derived), L1 keys are REQUEST-derived — the sorted
    /// query string is part of the key — so an unbounded index would be
    /// attacker-growable (`?x=<random>` per request on any tagged route). The
    /// eviction listener registered in `with_capacity` prunes the index
    /// whenever moka removes an entry (capacity eviction, TTL expiry, explicit
    /// or rejected insert), bounding the index by the live entry set. Shared
    /// `Arc` because the listener closure needs its own handle.
    tag_index: Arc<TagIndex<CacheKey>>,
    /// Insert/invalidate gate (see `insert`): inserts hold it shared across
    /// "index tags, then front + moka insert"; tag invalidation and `clear` hold it
    /// exclusively. Never held by the eviction listener.
    gate: parking_lot::RwLock<()>,
    next_generation: AtomicU64,
    /// Invalidation sequence (F86): every tag/path invalidation and `clear` takes the next value;
    /// a `ReadStamp` is its value when a render began.
    inval_seq: AtomicU64,
    /// The latest `inval_seq` of a tag invalidation, per hashed tag slot.
    tag_inval: Box<[AtomicU64]>,
    /// The latest `inval_seq` of an `invalidate_path`, per hashed (method, path) slot.
    path_inval: Box<[AtomicU64]>,
    /// The `inval_seq` of the latest `clear`.
    cleared_at: AtomicU64,
    hits: StripedCounter,
    misses: StripedCounter,
    capacity: u64,
    #[cfg(test)]
    pub(crate) mid_insert: MidInsertHook,
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
        let front: Arc<[Shard]> = (0..SHARDS)
            .map(|_| Shard(ShardedLock::new(HashMap::new())))
            .collect();
        let hasher = RandomState::new();
        // Prune the tag index and the front whenever moka drops an entry, whatever the cause
        // (capacity eviction, TTL expiry, explicit invalidate, rejected insert, replace). Without
        // this the index would grow without bound under request-derived keys. The generation check
        // keeps a replace/evict of an OLD value from un-indexing or un-serving the NEWER value under
        // the same key. The listener runs on the thread driving moka maintenance (or inline in a
        // moka call); it takes each lock alone, and no caller holds an index or front lock across a
        // moka call, so re-entry cannot deadlock.
        let listener_index = Arc::clone(&tag_index);
        let listener_front = Arc::clone(&front);
        let listener_hasher = hasher.clone();
        let inner = moka::sync::Cache::builder()
            .max_capacity(capacity)
            .expire_after(ResponseExpiry)
            .eviction_listener(move |key: Arc<CacheKey>, value: Slot, _cause| {
                prune_tags(&listener_index, &*key, &value.tags, value.generation);
                remove_front(
                    &listener_front,
                    shard_of(&listener_hasher, &key),
                    &key,
                    value.generation,
                );
            })
            .build();
        Self {
            inner,
            front,
            stripes: (0..SHARDS).map(|_| Mutex::new(())).collect(),
            hasher,
            epoch: Instant::now(),
            tag_index,
            gate: parking_lot::RwLock::new(()),
            next_generation: AtomicU64::new(0),
            inval_seq: AtomicU64::new(0),
            tag_inval: (0..INVAL_SLOTS).map(|_| AtomicU64::new(0)).collect(),
            path_inval: (0..INVAL_SLOTS).map(|_| AtomicU64::new(0)).collect(),
            cleared_at: AtomicU64::new(0),
            hits: StripedCounter::new(),
            misses: StripedCounter::new(),
            capacity,
            #[cfg(test)]
            mid_insert: Mutex::new(None),
        }
    }

    /// Run `f` on the live entry's body under its shard's read guard (no `Arc` clone, no shared
    /// write). `f` must be short and must not call into this cache. A front miss is forwarded to
    /// moka (TinyLFU counts misses toward admission); a front hit at most once per key per
    /// `TOUCH_EVERY_MS`.
    pub fn get_with<R>(
        &self,
        key: &CacheKey,
        f: impl FnOnce(&Arc<RenderedBody>) -> R,
    ) -> Option<R> {
        let shard = shard_of(&self.hasher, key);
        let now = Instant::now();
        let (out, touch) = {
            let m = self.front[shard].read();
            match m.get(key) {
                Some(e) if e.expires_at.is_none_or(|t| now < t) => {
                    let ms = now.saturating_duration_since(self.epoch).as_millis() as u64;
                    let last = e.touched.load(Ordering::Relaxed);
                    let touch = ms.saturating_sub(last) >= TOUCH_EVERY_MS
                        && e.touched
                            .compare_exchange(last, ms, Ordering::Relaxed, Ordering::Relaxed)
                            .is_ok();
                    (Some(f(&e.body)), touch)
                }
                // Missing, or past its ttl (moka reaps it; the listener drops it here).
                _ => (None, true),
            }
        };
        if touch {
            let _ = self.inner.get(key);
        }
        if out.is_some() {
            self.hits.incr();
        } else {
            self.misses.incr();
        }
        out
    }

    pub fn get(&self, key: &CacheKey) -> Option<Arc<RenderedBody>> {
        self.get_with(key, Arc::clone)
    }

    /// Stamp the start of a render (F86): take it before the render reads app data and pass it to
    /// `insert`.
    pub fn read_stamp(&self) -> ReadStamp {
        ReadStamp(self.inval_seq.load(Ordering::SeqCst))
    }

    /// Take the next invalidation sequence number (F86).
    fn next_inval(&self) -> u64 {
        self.inval_seq.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// The `tag_inval` / `path_inval` slot of `v`.
    fn slot<T: std::hash::Hash + ?Sized>(&self, v: &T) -> usize {
        (self.hasher.hash_one(v) as usize) % INVAL_SLOTS
    }

    /// Whether a covering invalidation (`clear`, this key's method + path, or one of `tags`, each
    /// by slot) took a sequence number after `since`.
    fn invalidated_since(&self, key: &CacheKey, tags: &[String], since: ReadStamp) -> bool {
        let after = |a: &AtomicU64| a.load(Ordering::SeqCst) > since.0;
        after(&self.cleared_at)
            || after(&self.path_inval[self.slot(&(key.method.as_str(), key.path.as_str()))])
            || tags
                .iter()
                .any(|t| after(&self.tag_inval[self.slot(t.as_str())]))
    }

    /// Since S10 a HIT serves `body` (with its headers): the render context and the loader's
    /// headers are not stored (ruling R-E; the parameters went with ledger F78). Returns `false`
    /// when the insert did not land: a covering invalidation came after `since` (F86).
    pub fn insert(
        &self,
        key: CacheKey,
        body: Arc<RenderedBody>,
        ttl: Duration,
        tags: &[String],
        since: ReadStamp,
    ) -> bool {
        // Ordering is load-bearing: index the tags BEFORE the moka insert (the
        // reverse could leave a live, un-indexed entry if a panic hit between
        // the two). Index-then-insert alone still raced `invalidate_tags`: an
        // invalidation that took the index between the two steps found the
        // key but removed nothing, then the insert landed live and un-indexed
        // (immune to every later tag invalidation until ttl/capacity). The
        // shared `gate` makes the steps atomic w.r.t. tag invalidation
        // (which holds it exclusively), at no cost between inserts. The
        // eviction listener never takes the gate, so moka running it inline
        // here cannot deadlock.
        let _gate = self.gate.read();
        // The key's stripe covers generation, index and both stores, so same-key inserts index and
        // land in generation order (see `JobCache::insert`).
        let shard = shard_of(&self.hasher, &key);
        let _stripe = self.stripes[shard].lock();
        // F86: the render behind this insert read its data at `since`. Checked under the gate (tag
        // invalidation and `clear` publish under it exclusively) and the stripe (`invalidate_path`
        // publishes, then scans this shard under it), held until the write below. A rejection
        // writes nothing.
        if self.invalidated_since(&key, tags, since) {
            return false;
        }
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        index_tags(&self.tag_index, &key, tags, generation);
        #[cfg(test)]
        if let Some(h) = &*self.mid_insert.lock() {
            h();
        }
        let now = Instant::now();
        // Front first, then moka (whose Replaced notification for the older generation then leaves
        // this entry alone). The front guard is a temporary dropped at the end of this statement,
        // BEFORE the moka call: the listener may run inside it.
        self.front[shard].write().insert(
            key.clone(),
            FrontEntry {
                body,
                // A ttl past `Instant`'s range never expires.
                expires_at: now.checked_add(ttl),
                generation,
                touched: AtomicU64::new(
                    now.saturating_duration_since(self.epoch).as_millis() as u64
                ),
            },
        );
        self.inner.insert(
            key,
            Slot {
                ttl,
                tags: tags.into(),
                generation,
            },
        );
        true
    }

    /// Remove `k` from moka and the front, in that key's write order.
    fn remove(&self, k: &CacheKey) -> bool {
        let shard = shard_of(&self.hasher, k);
        let _stripe = self.stripes[shard].lock();
        let held = self.inner.remove(k).is_some();
        self.front[shard].write().remove(k);
        held
    }

    pub fn stats(&self) -> CacheStats {
        // moka's `entry_count` is eventually consistent — drive pending tasks so
        // the observability endpoint reflects the current entry count instead of
        // a stale lower bound (otherwise a freshly-inserted entry reads as len=0
        // right after the insert). hits/misses are striped atomics and exact.
        self.inner.run_pending_tasks();
        CacheStats {
            hits: self.hits.get(),
            misses: self.misses.get(),
            len: self.inner.entry_count() as usize,
            capacity: self.capacity as usize,
        }
    }

    /// Remove every entry whose key has the given method + path (regardless
    /// of query string or vary values). Returns the number of live matching
    /// entries at the time of the call. Hits/misses counters are NOT reset.
    /// The entries are gone from the read front when this returns.
    ///
    /// Gate-free (see the struct invariant): it publishes its sequence number first, then scans
    /// shard i under `stripes[i]`, so an insert of a matching key either landed before the scan
    /// (and is removed) or checks after the publish (and is rejected).
    pub fn invalidate_path(&self, method: &str, path: &str) -> usize {
        let seq = self.next_inval();
        self.path_inval[self.slot(&(method, path))].fetch_max(seq, Ordering::SeqCst);
        let now = Instant::now();
        let mut live = 0;
        for (shard, s) in self.front.iter().enumerate() {
            let _stripe = self.stripes[shard].lock();
            let keys: Vec<CacheKey> = {
                let m = s.read();
                m.iter()
                    .filter(|(k, _)| k.method == method && k.path == path)
                    .map(|(k, e)| {
                        live += usize::from(e.expires_at.is_none_or(|t| now < t));
                        k.clone()
                    })
                    .collect()
            };
            // No front guard across the moka call: its listener takes this shard's write lock.
            for k in &keys {
                self.inner.remove(k);
                s.write().remove(k);
            }
        }
        self.inner.run_pending_tasks();
        live
    }

    /// Remove every L1 entry carrying any of the given tags; returns the number
    /// of distinct keys collected from the index. Collect the affected keys
    /// under the tag-index lock, then DROP it before touching moka — moka's
    /// `invalidate` does internal eviction-scheduling work, and holding the
    /// Mutex across a large tag group would block every concurrent tagged
    /// `insert`. moka invalidation is eventual, so we drive `run_pending_tasks`.
    pub fn invalidate_tags(&self, tags: &[String]) -> usize {
        let n = {
            let _gate = self.gate.write(); // no insert is mid-way (see `insert`)
            let seq = self.next_inval();
            for t in tags {
                self.tag_inval[self.slot(t.as_str())].fetch_max(seq, Ordering::SeqCst);
            }
            let keys = take_tagged(&self.tag_index, tags);
            let n = keys.len();
            for k in keys {
                self.remove(&k);
            }
            n
        };
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
            let _gate = self.gate.write();
            self.cleared_at
                .fetch_max(self.next_inval(), Ordering::SeqCst);
            self.tag_index.lock().clear();
            self.inner.invalidate_all();
            for s in self.front.iter() {
                s.write().clear();
            }
        }
        self.inner.run_pending_tasks();
        n
    }

    /// Total keys currently indexed across all tags (test/observability hook
    /// for the eviction-listener pruning invariant).
    #[cfg(test)]
    pub(crate) fn tag_index_size(&self) -> usize {
        self.tag_index.lock().values().map(|s| s.len()).sum()
    }

    /// The `tag_inval` slot of `t` (test hook: tests pick non-colliding tags with it).
    #[cfg(test)]
    pub(crate) fn tag_slot(&self, t: &str) -> usize {
        self.slot(t)
    }

    /// The `path_inval` slot of `(m, p)` (test hook, as `tag_slot`).
    #[cfg(test)]
    pub(crate) fn path_slot(&self, m: &str, p: &str) -> usize {
        self.slot(&(m, p))
    }

    /// Entries in the read front (test hook: it must track moka's).
    #[cfg(test)]
    pub(crate) fn front_len(&self) -> usize {
        self.front.iter().map(|s| s.read().len()).sum()
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

    fn rb_of(s: &str) -> Arc<RenderedBody> {
        Arc::new(RenderedBody {
            status: 200,
            headers: http::HeaderMap::new(),
            html: Bytes::from(s.to_string()),
            gzip: OnceLock::new(),
        })
    }

    fn html(c: &L1Cache, k: &CacheKey) -> Option<Bytes> {
        c.get_with(k, |b| b.html.clone())
    }

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
            rb_of("t"),
            Duration::from_secs(60),
            &["a".to_string(), "b".to_string()],
            c.read_stamp(),
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
            rb_of("1"),
            Duration::from_secs(60),
            &["grp".to_string()],
            c.read_stamp(),
        );
        c.insert(
            key("GET", "/p", "x=2"),
            rb_of("2"),
            Duration::from_secs(60),
            &["grp".to_string()],
            c.read_stamp(),
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
            rb_of("w"),
            Duration::from_secs(60),
            &["t".to_string()],
            c.read_stamp(),
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
            rb_of("a"),
            Duration::from_secs(60),
            &[],
            c.read_stamp(),
        );
        c.insert(
            key("GET", "/a", "x=1"),
            rb_of("a-x"),
            Duration::from_secs(60),
            &[],
            c.read_stamp(),
        );
        c.insert(
            key("GET", "/b", ""),
            rb_of("b"),
            Duration::from_secs(60),
            &[],
            c.read_stamp(),
        );
        c.run_pending();

        let removed = c.invalidate_path("GET", "/a");
        c.run_pending();
        assert_eq!(removed, 2);
        assert!(html(&c, &key("GET", "/a", "")).is_none());
        assert!(html(&c, &key("GET", "/a", "x=1")).is_none());
        assert_eq!(
            html(&c, &key("GET", "/b", "")),
            Some(Bytes::from_static(b"b"))
        );
    }

    #[test]
    fn invalidate_path_no_match_returns_zero() {
        let c = L1Cache::new();
        c.insert(
            key("GET", "/a", ""),
            rb_of("a"),
            Duration::from_secs(60),
            &[],
            c.read_stamp(),
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
            rb_of("a"),
            Duration::from_secs(60),
            &["grp".to_string()],
            c.read_stamp(),
        );
        c.insert(
            key("GET", "/a", "x=1"),
            rb_of("a-x"),
            Duration::from_secs(60),
            &["grp".to_string()],
            c.read_stamp(),
        );
        c.insert(
            key("GET", "/b", ""),
            rb_of("b"),
            Duration::from_secs(60),
            &["other".to_string()],
            c.read_stamp(),
        );
        c.run_pending();

        c.invalidate_tags(&["grp".to_string()]);
        c.run_pending();
        assert!(html(&c, &key("GET", "/a", "")).is_none());
        assert!(html(&c, &key("GET", "/a", "x=1")).is_none());
        assert_eq!(
            html(&c, &key("GET", "/b", "")),
            Some(Bytes::from_static(b"b")),
            "untagged group survives"
        );
    }

    #[test]
    fn invalidate_tags_no_match_is_noop() {
        let c = L1Cache::new();
        c.insert(
            key("GET", "/a", ""),
            rb_of("a"),
            Duration::from_secs(60),
            &["grp".to_string()],
            c.read_stamp(),
        );
        c.run_pending();
        c.invalidate_tags(&["missing".to_string()]);
        c.run_pending();
        assert_eq!(
            html(&c, &key("GET", "/a", "")),
            Some(Bytes::from_static(b"a"))
        );
    }

    #[test]
    fn clear_removes_all_entries_and_returns_count() {
        let c = L1Cache::new();
        c.insert(
            key("GET", "/a", ""),
            rb_of("a"),
            Duration::from_secs(60),
            &[],
            c.read_stamp(),
        );
        c.insert(
            key("GET", "/b", ""),
            rb_of("b"),
            Duration::from_secs(60),
            &[],
            c.read_stamp(),
        );
        c.insert(
            key("GET", "/c", ""),
            rb_of("c"),
            Duration::from_secs(60),
            &[],
            c.read_stamp(),
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
            rb_of("a"),
            Duration::from_secs(60),
            &[],
            c.read_stamp(),
        );
        c.run_pending();
        let _ = html(&c, &key("GET", "/a", "")); // hit
        let _ = html(&c, &key("GET", "/missing", "")); // miss
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
            rb_of("1"),
            Duration::from_millis(1),
            &["t".to_string()],
            c.read_stamp(),
        );
        std::thread::sleep(Duration::from_millis(5));
        c.insert(
            k.clone(),
            rb_of("2"),
            Duration::from_secs(60),
            &["t".to_string()],
            c.read_stamp(),
        );
        c.run_pending();
        assert_eq!(c.tag_index_size(), 1, "new entry stays indexed");
        assert_eq!(c.invalidate_tags(&["t".to_string()]), 1);
        assert!(
            html(&c, &k).is_none(),
            "tag invalidation reaches the new entry"
        );
        assert_eq!(c.tag_index_size(), 0);
    }

    #[test]
    fn invalidate_between_index_and_insert_is_not_lost() {
        // Deterministic interleaving: the insert thread pauses after writing the
        // tag index and before the moka insert; the invalidation starts in that
        // window. Ungated it ran there (taking the index, removing nothing) and
        // the insert then landed live and un-indexed; gated it waits for the
        // insert and removes the entry.
        let c = Arc::new(L1Cache::new());
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        *c.mid_insert.lock() = Some(Box::new(move || {
            tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(50));
        }));
        let k = key("GET", "/race", "");
        let (c2, k2) = (Arc::clone(&c), k.clone());
        let ins = std::thread::spawn(move || {
            let since = c2.read_stamp();
            c2.insert(
                k2,
                rb_of("1"),
                Duration::from_secs(60),
                &["t".to_string()],
                since,
            )
        });
        rx.recv().unwrap();
        c.invalidate_tags(&["t".to_string()]);
        ins.join().unwrap();
        assert!(html(&c, &k).is_none(), "invalidated entry must not survive");
        c.run_pending();
        assert_eq!(c.tag_index_size(), 0);
    }

    fn ins(c: &L1Cache, k: CacheKey, body: &str, ttl: Duration, tags: &[&str]) {
        let tags: Vec<String> = tags.iter().map(|t| t.to_string()).collect();
        c.insert(k, rb_of(body), ttl, &tags, c.read_stamp());
    }

    #[test]
    fn front_follows_moka_evictions_and_expiry() {
        let c = L1Cache::with_capacity(10);
        for i in 0..200 {
            ins(
                &c,
                key("GET", &format!("/p{i}"), ""),
                "x",
                Duration::from_secs(60),
                &[],
            );
        }
        c.run_pending();
        let len = c.stats().len;
        assert!(len <= 10, "moka bound the entry count: {len}");
        assert_eq!(
            c.front_len(),
            len,
            "the listener dropped every evicted front entry"
        );
    }

    #[test]
    fn ttl_is_exact_on_the_read_front() {
        let c = L1Cache::new();
        let k = key("GET", "/ttl", "");
        ins(&c, k.clone(), "t", Duration::from_millis(30), &[]);
        assert_eq!(html(&c, &k), Some(Bytes::from_static(b"t")));
        std::thread::sleep(Duration::from_millis(40));
        // No run_pending: the read itself enforces the deadline.
        assert!(html(&c, &k).is_none());
    }

    #[test]
    fn invalidation_reaches_the_front_without_maintenance() {
        let c = L1Cache::new();
        let ttl = Duration::from_secs(60);
        ins(&c, key("GET", "/a", ""), "a", ttl, &["g"]);
        ins(&c, key("GET", "/b", "x=1"), "b", ttl, &[]);
        ins(&c, key("GET", "/d", ""), "d", ttl, &["g"]);
        assert_eq!(c.invalidate_path("GET", "/b"), 1);
        assert!(html(&c, &key("GET", "/b", "x=1")).is_none());
        assert_eq!(c.invalidate_tags(&["g".to_string()]), 2);
        assert!(html(&c, &key("GET", "/a", "")).is_none());
        assert!(html(&c, &key("GET", "/d", "")).is_none());
        ins(&c, key("GET", "/a", ""), "a", ttl, &[]);
        c.run_pending(); // clear() returns moka's eventually-consistent entry_count
        assert_eq!(c.clear(), 1);
        assert!(html(&c, &key("GET", "/a", "")).is_none());
        c.run_pending();
        assert_eq!((c.front_len(), c.tag_index_size()), (0, 0));
    }

    #[test]
    fn concurrent_reinserts_leave_front_and_moka_agreeing() {
        let c = L1Cache::new();
        let k = key("GET", "/hot", "");
        std::thread::scope(|sc| {
            for t in 0..8 {
                let (c, k) = (&c, &k);
                sc.spawn(move || {
                    for i in 0..200 {
                        ins(
                            c,
                            k.clone(),
                            &format!("{t}-{i}"),
                            Duration::from_secs(60),
                            &["t"],
                        );
                        let _ = html(c, k);
                    }
                });
            }
        });
        c.run_pending();
        assert_eq!(c.front_len(), 1);
        assert_eq!(c.invalidate_tags(&["t".to_string()]), 1);
        assert!(html(&c, &k).is_none());
        assert_eq!(c.front_len(), 0);
    }

    #[test]
    fn counters_are_exact_across_threads() {
        let c = L1Cache::new();
        let (hit, miss) = (key("GET", "/h", ""), key("GET", "/m", ""));
        ins(&c, hit.clone(), "h", Duration::from_secs(60), &[]);
        std::thread::scope(|sc| {
            for _ in 0..8 {
                sc.spawn(|| {
                    for _ in 0..1000 {
                        assert!(html(&c, &hit).is_some());
                    }
                    for _ in 0..10 {
                        assert!(html(&c, &miss).is_none());
                    }
                });
            }
        });
        let st = c.stats();
        assert_eq!((st.hits, st.misses), (8000, 80));
    }

    #[test]
    fn get_with_runs_the_closure_once_and_only_on_a_hit() {
        let c = L1Cache::new();
        let k = key("GET", "/g", "");
        let calls = std::cell::Cell::new(0);
        let r = c.get_with(&k, |b| {
            calls.set(calls.get() + 1);
            b.status
        });
        assert_eq!((r, calls.get()), (None, 0));
        ins(&c, k.clone(), "g", Duration::from_secs(60), &[]);
        let r = c.get_with(&k, |b| {
            calls.set(calls.get() + 1);
            b.status
        });
        assert_eq!((r, calls.get()), (Some(200), 1));
    }

    // ----- F86: read stamps -----

    const TTL: Duration = Duration::from_secs(60);

    fn tags(ts: &[&str]) -> Vec<String> {
        ts.iter().map(|t| t.to_string()).collect()
    }

    #[test]
    fn an_invalidation_after_the_read_stamp_keeps_the_insert_out() {
        let c = L1Cache::new();
        let k = key("GET", "/k", "");
        let s = c.read_stamp();
        c.invalidate_tags(&tags(&["t"]));
        assert!(!c.insert(k.clone(), rb_of("old"), TTL, &tags(&["t"]), s));
        assert!(html(&c, &k).is_none());
        c.run_pending();
        assert_eq!(
            (c.front_len(), c.tag_index_size(), c.stats().len),
            (0, 0, 0)
        );
    }

    #[test]
    fn an_insert_before_the_invalidation_is_still_evicted() {
        let c = L1Cache::new();
        let k = key("GET", "/k", "");
        let s = c.read_stamp();
        assert!(c.insert(k.clone(), rb_of("v"), TTL, &tags(&["t"]), s));
        assert_eq!(c.invalidate_tags(&tags(&["t"])), 1);
        assert!(html(&c, &k).is_none());
    }

    #[test]
    fn a_stamp_after_the_invalidation_lands() {
        let c = L1Cache::new();
        let k = key("GET", "/k", "");
        c.invalidate_tags(&tags(&["t"]));
        let s = c.read_stamp();
        assert!(c.insert(k.clone(), rb_of("new"), TTL, &tags(&["t"]), s));
        assert_eq!(html(&c, &k), Some(Bytes::from_static(b"new")));
    }

    #[test]
    fn an_untagged_insert_ignores_tag_invalidation() {
        let c = L1Cache::new();
        let k = key("GET", "/k", "");
        let s = c.read_stamp();
        c.invalidate_tags(&tags(&["t"]));
        assert!(c.insert(k.clone(), rb_of("v"), TTL, &[], s));
        assert_eq!(html(&c, &k), Some(Bytes::from_static(b"v")));
    }

    #[test]
    fn an_unrelated_tag_invalidation_does_not_reject() {
        let c = L1Cache::new();
        let k = key("GET", "/k", "");
        let b = (0..)
            .map(|i| format!("u{i}"))
            .find(|b| c.tag_slot(b) != c.tag_slot("t"))
            .unwrap();
        let s = c.read_stamp();
        c.invalidate_tags(&[b]);
        assert!(c.insert(k.clone(), rb_of("v"), TTL, &tags(&["t"]), s));
        assert_eq!(html(&c, &k), Some(Bytes::from_static(b"v")));
    }

    #[test]
    fn clear_after_the_stamp_keeps_the_insert_out() {
        let c = L1Cache::new();
        let k = key("GET", "/k", "");
        let s = c.read_stamp();
        c.clear();
        assert!(!c.insert(k.clone(), rb_of("old"), TTL, &[], s));
        assert!(html(&c, &k).is_none());
    }

    #[test]
    fn a_rejected_insert_leaves_the_newer_entry() {
        let c = L1Cache::new();
        let k = key("GET", "/k", "");
        let s1 = c.read_stamp();
        c.invalidate_tags(&tags(&["t"]));
        let s2 = c.read_stamp();
        assert!(c.insert(k.clone(), rb_of("new"), TTL, &tags(&["t"]), s2));
        assert!(!c.insert(k.clone(), rb_of("old"), TTL, &tags(&["t"]), s1));
        assert_eq!(html(&c, &k), Some(Bytes::from_static(b"new")));
        c.run_pending();
        assert_eq!(c.tag_index_size(), 1);
    }

    #[test]
    fn invalidate_path_after_the_stamp_keeps_the_insert_out() {
        let c = L1Cache::new();
        let k = key("GET", "/p", "x=1");
        let s = c.read_stamp();
        c.invalidate_path("GET", "/p");
        assert!(!c.insert(k.clone(), rb_of("old"), TTL, &[], s));
        assert!(html(&c, &k).is_none());
    }

    #[test]
    fn invalidate_path_of_another_path_does_not_reject() {
        let c = L1Cache::new();
        let k = key("GET", "/p", "x=1");
        let q = (0..)
            .map(|i| format!("/q{i}"))
            .find(|q| c.path_slot("GET", q) != c.path_slot("GET", "/p"))
            .unwrap();
        let s = c.read_stamp();
        c.invalidate_path("GET", &q);
        assert!(c.insert(k.clone(), rb_of("v"), TTL, &[], s));
        assert_eq!(html(&c, &k), Some(Bytes::from_static(b"v")));
    }
}
