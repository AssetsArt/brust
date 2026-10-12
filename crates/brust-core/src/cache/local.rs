//! Single-thread page and job caches for hosts without threads (Cloudflare Workers): `LocalL1`
//! and `LocalJobs`, the `PageCache` / `JobStore` the Workers host builds `Core` on. They pass the
//! same conformance suite as the native moka caches (`cache::conformance`: the F81/F86/F89 cases),
//! with the same `InvalClock` / `ReadStamp` semantics: every invalidation publishes the clock's
//! next value in a hashed per-tag / per-(method, path) / per-user-key slot (or `cleared_at`), and an
//! insert stamped before a covering invalidation does not land.
//!
//! - **Eviction (R1/R3).** LRU over `HashMap<Rc<K>, _>` + a `BTreeMap<tick, Rc<K>>` recency
//!   order, by entry capacity ([`WORKERS_L1_CAPACITY`] / [`WORKERS_JOB_CAPACITY`] on Workers)
//!   and, for L1, by body bytes ([`L1_MAX_BODY_BYTES`]). A body over the byte cap is not stored
//!   and `insert` still returns `true` (moka's admission drop does the same; `false` means
//!   "invalidated").
//! - **TTL (R2).** Measured in ns on the injected [`Clock`]. Lazy: an expired entry is removed on
//!   read (a miss); each insert sweeps at most 8 expired entries from the LRU end; `stats()` reaps
//!   them all, so `len` counts live entries. A ttl past `u64` ns never expires.
//! - **Bytes (R4).** L1 accounts `html.len()` only. Workers builds brust-core without `gzip`, so
//!   `RenderedBody::gzip` is never filled; a gzip-enabled build would exceed the cap by the gzip
//!   variants made later.
//! - **Hasher (R6).** A fixed `DefaultHasher`: reproducible slots, and colliding keys cost at most
//!   O(capacity) per call inside one isolate.
//! - **Reentrancy.** A single isolate interleaves requests at every `.await`; every method takes
//!   and releases its borrows inside the call and returns no guard, and `get_with` calls `f` with
//!   no borrow held, so `f` may re-enter the cache.
use std::cell::{Cell, RefCell};
use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::{BuildHasher, BuildHasherDefault, Hash};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use brust_jinja::ctx::Node;

use super::stamp::{INVAL_SLOTS, InvalClock, ReadStamp};
use super::{CacheKey, CacheStats, JobKey, RenderedBody};
use crate::host::{Clock, JobStore, PageCache};

/// `[cloudflare] l1_capacity` default (spec §4).
pub const WORKERS_L1_CAPACITY: u64 = 256;
/// `[cloudflare] job_cache_capacity` default (spec §4).
pub const WORKERS_JOB_CAPACITY: u64 = 512;
/// The L1 body-byte cap `LocalL1::with_clock` applies: 256 entries at a 32 KiB page, inside the
/// 128 MB isolate JS and wasm share.
pub const L1_MAX_BODY_BYTES: usize = 8 << 20;
/// Expired entries an insert inspects from the LRU end.
const SWEEP: usize = 8;

type Fixed = BuildHasherDefault<DefaultHasher>;
type Index<K> = HashMap<String, HashSet<Rc<K>, Fixed>, Fixed>;

struct Slot<V> {
    value: V,
    expires_ns: Option<u64>,
    tags: Box<[String]>,
    user_key: Option<Box<str>>,
    tick: u64,
    bytes: usize,
}

impl<V> Slot<V> {
    fn live(&self, now: u64) -> bool {
        self.expires_ns.is_none_or(|e| now < e)
    }
}

/// The LRU store both caches share: entries, recency, the tag and user-key indexes, bytes.
struct Store<K, V> {
    entries: HashMap<Rc<K>, Slot<V>, Fixed>,
    recency: BTreeMap<u64, Rc<K>>,
    tags: Index<K>,
    users: Index<K>,
    next_tick: u64,
    bytes: usize,
}

impl<K: Hash + Eq, V> Store<K, V> {
    fn new() -> Self {
        Self {
            entries: HashMap::default(),
            recency: BTreeMap::new(),
            tags: HashMap::default(),
            users: HashMap::default(),
            next_tick: 0,
            bytes: 0,
        }
    }

    /// The one removal path: entry, recency, both indexes (empty sets dropped), bytes.
    fn remove(&mut self, k: &K) -> Option<Slot<V>> {
        let s = self.entries.remove(k)?;
        self.recency.remove(&s.tick);
        for t in s.tags.iter() {
            unindex(&mut self.tags, t, k);
        }
        if let Some(u) = &s.user_key {
            unindex(&mut self.users, u, k);
        }
        self.bytes -= s.bytes;
        Some(s)
    }

    /// Store `v` under `k` (replacing any entry), then evict LRU entries past the limits.
    #[allow(clippy::too_many_arguments)]
    fn insert(
        &mut self,
        k: K,
        value: V,
        expires_ns: Option<u64>,
        tags: &[String],
        user_key: Option<&str>,
        bytes: usize,
        now: u64,
        capacity: u64,
        max_bytes: usize,
    ) {
        self.remove(&k);
        self.sweep(now);
        let k = Rc::new(k);
        let tick = self.next_tick;
        self.next_tick += 1;
        self.recency.insert(tick, Rc::clone(&k));
        for t in tags {
            self.tags
                .entry(t.clone())
                .or_default()
                .insert(Rc::clone(&k));
        }
        if let Some(u) = user_key {
            self.users
                .entry(u.to_owned())
                .or_default()
                .insert(Rc::clone(&k));
        }
        self.bytes += bytes;
        self.entries.insert(
            k,
            Slot {
                value,
                expires_ns,
                tags: tags.into(),
                user_key: user_key.map(Into::into),
                tick,
                bytes,
            },
        );
        while self.entries.len() as u64 > capacity || self.bytes > max_bytes {
            let Some((_, lru)) = self.recency.pop_first() else {
                break;
            };
            self.remove(&lru);
        }
    }

    /// The live entry's value (its recency bumped); an expired one is removed. `None` = a miss.
    fn get(&mut self, k: &K, now: u64) -> Option<&V> {
        let live = self.entries.get(k)?.live(now);
        if !live {
            self.remove(k);
            return None;
        }
        let tick = self.next_tick;
        self.next_tick += 1;
        let s = self.entries.get_mut(k)?;
        if let Some(rk) = self.recency.remove(&s.tick) {
            self.recency.insert(tick, rk);
        }
        s.tick = tick;
        Some(&s.value)
    }

    /// Drop expired entries among the `SWEEP` least recently used.
    fn sweep(&mut self, now: u64) {
        let dead: Vec<Rc<K>> = self
            .recency
            .values()
            .take(SWEEP)
            .filter(|k| self.entries.get(&***k).is_some_and(|s| !s.live(now)))
            .cloned()
            .collect();
        for k in dead {
            self.remove(&k);
        }
    }

    /// Drop every expired entry.
    fn reap(&mut self, now: u64) {
        let dead: Vec<Rc<K>> = self
            .entries
            .iter()
            .filter(|(_, s)| !s.live(now))
            .map(|(k, _)| Rc::clone(k))
            .collect();
        for k in dead {
            self.remove(&k);
        }
    }

    fn live_len(&self, now: u64) -> usize {
        self.entries.values().filter(|s| s.live(now)).count()
    }

    /// Remove every key indexed under `names` in `index` (tags or user keys); the distinct count.
    fn take_indexed(&mut self, users: bool, names: &[String]) -> usize {
        let index = if users {
            &mut self.users
        } else {
            &mut self.tags
        };
        let mut keys: HashSet<Rc<K>, Fixed> = HashSet::default();
        for n in names {
            if let Some(set) = index.remove(n.as_str()) {
                keys.extend(set);
            }
        }
        let n = keys.len();
        for k in keys {
            self.remove(&k);
        }
        n
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.recency.clear();
        self.tags.clear();
        self.users.clear();
        self.bytes = 0;
    }

    fn index_size(&self, users: bool) -> usize {
        let index = if users { &self.users } else { &self.tags };
        index.values().map(HashSet::len).sum()
    }
}

fn unindex<K: Hash + Eq>(index: &mut Index<K>, name: &str, k: &K) {
    if let Some(set) = index.get_mut(name) {
        set.remove(k);
        if set.is_empty() {
            index.remove(name);
        }
    }
}

/// `now + ttl` in ns; `None` (never expires) when it does not fit in `u64`.
fn deadline(now: u64, ttl: Duration) -> Option<u64> {
    u64::try_from(ttl.as_nanos())
        .ok()
        .and_then(|t| now.checked_add(t))
}

fn slots() -> Box<[Cell<u64>]> {
    (0..INVAL_SLOTS).map(|_| Cell::new(0)).collect()
}

/// Publish `seq` in a slot (never lowering it).
fn publish(slot: &Cell<u64>, seq: u64) {
    slot.set(slot.get().max(seq));
}

/// The single-thread page cache (L1) for hosts without threads. See the module docs.
pub struct LocalL1<T: Clock> {
    store: RefCell<Store<CacheKey, Arc<RenderedBody>>>,
    time: T,
    inval: Arc<InvalClock>,
    tag_inval: Box<[Cell<u64>]>,
    path_inval: Box<[Cell<u64>]>,
    cleared_at: Cell<u64>,
    hits: Cell<u64>,
    misses: Cell<u64>,
    capacity: u64,
    max_bytes: usize,
    hasher: Fixed,
}

impl<T: Clock> LocalL1<T> {
    /// `capacity` entries (at least 1) and `max_bytes` of bodies, on `inval`, timed by `time`.
    pub fn with_limits(capacity: u64, max_bytes: usize, inval: Arc<InvalClock>, time: T) -> Self {
        Self {
            store: RefCell::new(Store::new()),
            time,
            inval,
            tag_inval: slots(),
            path_inval: slots(),
            cleared_at: Cell::new(0),
            hits: Cell::new(0),
            misses: Cell::new(0),
            capacity: capacity.max(1),
            max_bytes,
            hasher: Fixed::default(),
        }
    }

    fn slot<V: Hash + ?Sized>(&self, v: &V) -> usize {
        (self.hasher.hash_one(v) as usize) % INVAL_SLOTS
    }

    /// The tag invalidation slot of `t` (tests pick non-colliding tags with it).
    pub fn tag_slot(&self, t: &str) -> usize {
        self.slot(t)
    }

    /// The `(method, path)` invalidation slot.
    pub fn path_slot(&self, m: &str, p: &str) -> usize {
        self.slot(&(m, p))
    }

    /// Keys indexed across all tags.
    pub fn tag_index_size(&self) -> usize {
        self.store.borrow().index_size(false)
    }

    /// A covering invalidation (`clear`, this key's method + path, one of `tags`) came after
    /// `since` (`l1.rs` `invalidated_since`).
    fn invalidated_since(&self, key: &CacheKey, tags: &[String], since: ReadStamp) -> bool {
        let after = |c: &Cell<u64>| c.get() > since.0;
        after(&self.cleared_at)
            || after(&self.path_inval[self.slot(&(key.method.as_str(), key.path.as_str()))])
            || tags
                .iter()
                .any(|t| after(&self.tag_inval[self.slot(t.as_str())]))
    }

    /// Entries stored, expired ones included (tests).
    #[cfg(test)]
    fn raw_len(&self) -> usize {
        self.store.borrow().entries.len()
    }

    /// Remove every entry; the number of live entries removed. Hits/misses are kept.
    pub fn clear(&self) -> usize {
        self.cleared_at.set(self.inval.next());
        let now = self.time.now_ns();
        let mut st = self.store.borrow_mut();
        let n = st.live_len(now);
        st.clear();
        n
    }
}

impl<T: Clock + Default> PageCache for LocalL1<T> {
    fn with_clock(capacity: u64, clock: Arc<InvalClock>) -> Self {
        Self::with_limits(capacity, L1_MAX_BODY_BYTES, clock, T::default())
    }

    fn get_with<R>(&self, key: &CacheKey, f: impl FnOnce(&Arc<RenderedBody>) -> R) -> Option<R> {
        let now = self.time.now_ns();
        let body = self.store.borrow_mut().get(key, now).map(Arc::clone);
        // The borrow is released: `f` may re-enter the cache.
        match body {
            Some(b) => {
                self.hits.set(self.hits.get() + 1);
                Some(f(&b))
            }
            None => {
                self.misses.set(self.misses.get() + 1);
                None
            }
        }
    }

    fn insert(
        &self,
        key: CacheKey,
        body: Arc<RenderedBody>,
        ttl: Duration,
        tags: &[String],
        since: ReadStamp,
    ) -> bool {
        if self.invalidated_since(&key, tags, since) {
            return false;
        }
        let now = self.time.now_ns();
        let bytes = body.html.len();
        let mut st = self.store.borrow_mut();
        if bytes > self.max_bytes {
            // Not stored (an older entry under the key goes too: it is being replaced).
            st.remove(&key);
            return true;
        }
        st.insert(
            key,
            body,
            deadline(now, ttl),
            tags,
            None,
            bytes,
            now,
            self.capacity,
            self.max_bytes,
        );
        true
    }

    fn read_stamp(&self) -> ReadStamp {
        self.inval.stamp()
    }

    fn invalidate_tags(&self, tags: &[String]) -> usize {
        let seq = self.inval.next();
        for t in tags {
            publish(&self.tag_inval[self.slot(t.as_str())], seq);
        }
        self.store.borrow_mut().take_indexed(false, tags)
    }

    /// Every entry for `method` + `path`, any query/prefix; the number of live ones.
    fn invalidate_path(&self, method: &str, path: &str) -> usize {
        publish(
            &self.path_inval[self.path_slot(method, path)],
            self.inval.next(),
        );
        let now = self.time.now_ns();
        let mut st = self.store.borrow_mut();
        let hits: Vec<Rc<CacheKey>> = st
            .entries
            .keys()
            .filter(|k| k.method == method && k.path == path)
            .cloned()
            .collect();
        let mut live = 0;
        for k in hits {
            if st.remove(&k).is_some_and(|s| s.live(now)) {
                live += 1;
            }
        }
        live
    }

    fn clear_all(&self) -> usize {
        LocalL1::clear(self)
    }

    fn stats(&self) -> CacheStats {
        let now = self.time.now_ns();
        let mut st = self.store.borrow_mut();
        st.reap(now);
        CacheStats {
            hits: self.hits.get(),
            misses: self.misses.get(),
            len: st.entries.len(),
            capacity: self.capacity as usize,
        }
    }
}

/// The single-thread job cache for hosts without threads. See the module docs. Bounded by entry
/// count only (a `Node` has no cheap size).
pub struct LocalJobs<T: Clock> {
    store: RefCell<Store<JobKey, Arc<Node>>>,
    time: T,
    inval: Arc<InvalClock>,
    tag_inval: Box<[Cell<u64>]>,
    key_inval: Box<[Cell<u64>]>,
    cleared_at: Cell<u64>,
    hits: Cell<u64>,
    misses: Cell<u64>,
    capacity: u64,
    hasher: Fixed,
}

impl<T: Clock> LocalJobs<T> {
    /// `capacity` entries (at least 1) on `inval`, timed by `time`.
    pub fn with_limits(capacity: u64, inval: Arc<InvalClock>, time: T) -> Self {
        Self {
            store: RefCell::new(Store::new()),
            time,
            inval,
            tag_inval: slots(),
            key_inval: slots(),
            cleared_at: Cell::new(0),
            hits: Cell::new(0),
            misses: Cell::new(0),
            capacity: capacity.max(1),
            hasher: Fixed::default(),
        }
    }

    fn slot(&self, v: &str) -> usize {
        (self.hasher.hash_one(v) as usize) % INVAL_SLOTS
    }

    /// The tag invalidation slot of `t`.
    pub fn tag_slot(&self, t: &str) -> usize {
        self.slot(t)
    }

    /// The user-key invalidation slot of `u`.
    pub fn key_slot(&self, u: &str) -> usize {
        self.slot(u)
    }

    /// Keys indexed across all tags.
    pub fn tag_index_size(&self) -> usize {
        self.store.borrow().index_size(false)
    }

    /// Keys indexed across all user keys.
    pub fn key_index_size(&self) -> usize {
        self.store.borrow().index_size(true)
    }

    /// A covering invalidation (`clear`, `user_key`, one of `tags`) came after `since`
    /// (`job_cache.rs` `invalidated_since`).
    fn invalidated_since(&self, tags: &[String], user_key: Option<&str>, since: ReadStamp) -> bool {
        let after = |c: &Cell<u64>| c.get() > since.0;
        after(&self.cleared_at)
            || user_key.is_some_and(|u| after(&self.key_inval[self.slot(u)]))
            || tags.iter().any(|t| after(&self.tag_inval[self.slot(t)]))
    }

    /// Remove one key without an invalidation: no read stamp is affected (the native
    /// `JobCache::invalidate_key`).
    pub fn invalidate_key(&self, k: &JobKey) -> bool {
        self.store.borrow_mut().remove(k).is_some()
    }

    /// Remove every entry. Hits/misses are kept.
    pub fn clear(&self) {
        self.cleared_at.set(self.inval.next());
        self.store.borrow_mut().clear();
    }
}

impl<T: Clock + Default> JobStore for LocalJobs<T> {
    fn with_clock(capacity: u64, clock: Arc<InvalClock>) -> Self {
        Self::with_limits(capacity, clock, T::default())
    }

    fn get(&self, k: &JobKey) -> Option<Arc<Node>> {
        let now = self.time.now_ns();
        let v = self.store.borrow_mut().get(k, now).map(Arc::clone);
        let n = if v.is_some() {
            &self.hits
        } else {
            &self.misses
        };
        n.set(n.get() + 1);
        v
    }

    fn insert(
        &self,
        k: JobKey,
        v: Arc<Node>,
        ttl: Option<Duration>,
        tags: &[String],
        user_key: Option<&str>,
        since: ReadStamp,
    ) -> bool {
        if self.invalidated_since(tags, user_key, since) {
            return false;
        }
        let now = self.time.now_ns();
        self.store.borrow_mut().insert(
            k,
            v,
            ttl.and_then(|t| deadline(now, t)),
            tags,
            user_key,
            0,
            now,
            self.capacity,
            usize::MAX,
        );
        true
    }

    fn read_stamp(&self) -> ReadStamp {
        self.inval.stamp()
    }

    fn invalidate_tags(&self, tags: &[String]) -> usize {
        let seq = self.inval.next();
        for t in tags {
            publish(&self.tag_inval[self.slot(t)], seq);
        }
        self.store.borrow_mut().take_indexed(false, tags)
    }

    fn invalidate_user_key(&self, user_key: &str) -> usize {
        publish(&self.key_inval[self.slot(user_key)], self.inval.next());
        self.store
            .borrow_mut()
            .take_indexed(true, &[user_key.to_owned()])
    }

    fn clear_all(&self) {
        LocalJobs::clear(self)
    }

    fn stats(&self) -> CacheStats {
        let now = self.time.now_ns();
        let mut st = self.store.borrow_mut();
        st.reap(now);
        CacheStats {
            hits: self.hits.get(),
            misses: self.misses.get(),
            len: st.entries.len(),
            capacity: self.capacity as usize,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::pin::Pin;
    use std::task::{Context, Poll, Waker};

    use serde_json::json;

    use super::*;
    use crate::cache::conformance::{key, rb_of, tags, val};
    use crate::host::ManualClock;

    const TTL: Duration = Duration::from_secs(60);

    fn l1(cap: u64, max_bytes: usize, t: &ManualClock) -> LocalL1<ManualClock> {
        LocalL1::with_limits(cap, max_bytes, Arc::default(), t.clone())
    }

    fn jobs(t: &ManualClock) -> LocalJobs<ManualClock> {
        LocalJobs::with_limits(64, Arc::default(), t.clone())
    }

    fn html(c: &LocalL1<ManualClock>, k: &CacheKey) -> Option<bytes::Bytes> {
        c.get_with(k, |b| b.html.clone())
    }

    fn jk(s: &str) -> JobKey {
        JobKey(s.to_string())
    }

    #[test]
    fn ttl_is_exact_on_the_injected_clock() {
        let t = ManualClock::default();
        let ttl = Duration::from_secs(30);
        let (c, j) = (l1(8, L1_MAX_BODY_BYTES, &t), jobs(&t));
        let k = key("GET", "/t", "");
        assert!(c.insert(k.clone(), rb_of("t"), ttl, &[], c.read_stamp()));
        assert!(j.insert(jk("j"), val(json!(1)), Some(ttl), &[], None, j.read_stamp()));
        t.set_ns(29_999_999_999);
        assert!(html(&c, &k).is_some());
        assert!(j.get(&jk("j")).is_some());
        t.set_ns(30_000_000_000);
        assert!(html(&c, &k).is_none());
        assert!(j.get(&jk("j")).is_none());
        assert_eq!((c.stats().len, j.stats().len), (0, 0));
    }

    #[test]
    fn a_huge_ttl_never_expires() {
        let t = ManualClock::default();
        let (c, j) = (l1(8, L1_MAX_BODY_BYTES, &t), jobs(&t));
        let k = key("GET", "/t", "");
        assert!(c.insert(k.clone(), rb_of("t"), Duration::MAX, &[], c.read_stamp()));
        assert!(j.insert(
            jk("j"),
            val(json!(1)),
            Some(Duration::MAX),
            &[],
            None,
            j.read_stamp()
        ));
        t.advance(Duration::from_secs(10 * 365 * 24 * 3600));
        assert!(html(&c, &k).is_some());
        assert!(j.get(&jk("j")).is_some());
    }

    #[test]
    fn lru_evicts_the_least_recently_read() {
        let t = ManualClock::default();
        let c = l1(3, L1_MAX_BODY_BYTES, &t);
        let k = |p: &str| key("GET", p, "");
        for p in ["/a", "/b", "/c"] {
            c.insert(k(p), rb_of(p), TTL, &[], c.read_stamp());
        }
        assert!(html(&c, &k("/a")).is_some());
        c.insert(k("/d"), rb_of("/d"), TTL, &[], c.read_stamp());
        assert!(
            html(&c, &k("/b")).is_none(),
            "b was the least recently read"
        );
        for p in ["/a", "/c", "/d"] {
            assert!(html(&c, &k(p)).is_some(), "{p}");
        }
    }

    #[test]
    fn the_byte_cap_evicts_lru_and_skips_an_oversize_body() {
        let t = ManualClock::default();
        let c = l1(10, 100, &t);
        let k = |i: usize| key("GET", &format!("/p{i}"), "");
        for i in 0..4 {
            assert!(c.insert(k(i), rb_of(&"x".repeat(30)), TTL, &[], c.read_stamp()));
        }
        assert!(
            html(&c, &k(0)).is_none(),
            "120 bytes > 100: the LRU body goes"
        );
        assert!(c.insert(k(9), rb_of(&"y".repeat(101)), TTL, &[], c.read_stamp()));
        assert!(html(&c, &k(9)).is_none(), "an oversize body is not stored");
        for i in 1..4 {
            assert!(html(&c, &k(i)).is_some(), "/p{i}");
        }
    }

    #[test]
    fn insert_sweeps_expired_tail_entries() {
        let t = ManualClock::default();
        let c = l1(16, L1_MAX_BODY_BYTES, &t);
        for i in 0..5 {
            let p = format!("/e{i}");
            c.insert(
                key("GET", &p, ""),
                rb_of(&p),
                Duration::from_secs(1),
                &[],
                c.read_stamp(),
            );
        }
        t.advance(Duration::from_secs(2));
        c.insert(key("GET", "/new", ""), rb_of("n"), TTL, &[], c.read_stamp());
        assert_eq!(c.raw_len(), 1);
    }

    #[test]
    fn get_with_closure_may_reenter_the_cache() {
        let t = ManualClock::default();
        let c = l1(8, L1_MAX_BODY_BYTES, &t);
        let (a, b) = (key("GET", "/a", ""), key("GET", "/b", ""));
        c.insert(a.clone(), rb_of("a"), TTL, &tags(&["t"]), c.read_stamp());
        let got = c.get_with(&a, |body| {
            assert!(c.insert(b.clone(), rb_of("b"), TTL, &[], c.read_stamp()));
            assert_eq!(c.invalidate_tags(&tags(&["t"])), 1);
            body.html.clone()
        });
        assert_eq!(got.as_deref(), Some(&b"a"[..]));
        assert!(
            html(&c, &b).is_some(),
            "the insert made inside f is visible"
        );
        assert!(
            html(&c, &a).is_none(),
            "the invalidation made inside f applied"
        );
    }

    /// Pending once, then ready: one `.await` point where the isolate runs another request.
    struct YieldOnce(bool);

    impl Future for YieldOnce {
        type Output = ();
        fn poll(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<()> {
            if self.0 {
                Poll::Ready(())
            } else {
                self.0 = true;
                Poll::Pending
            }
        }
    }

    fn poll<F: Future>(f: Pin<&mut F>) -> Poll<F::Output> {
        f.poll(&mut Context::from_waker(Waker::noop()))
    }

    /// F86/F89 on one isolate: a render stamps, yields (its loader `.await`), and inserts; an
    /// action's invalidation runs at the yield. The insert must not land; one stamped after the
    /// invalidation lands.
    #[test]
    fn interleaved_requests_on_one_isolate_keep_f86_f89() {
        let t = ManualClock::default();
        let c = l1(8, L1_MAX_BODY_BYTES, &t);
        let k = key("GET", "/k", "");
        let render = |body: &'static str| {
            let (c, k) = (&c, k.clone());
            async move {
                let s = c.read_stamp();
                YieldOnce(false).await;
                c.insert(k, rb_of(body), TTL, &tags(&["t"]), s)
            }
        };
        let mut a = std::pin::pin!(render("old"));
        assert!(poll(a.as_mut()).is_pending());
        c.invalidate_tags(&tags(&["t"]));
        assert_eq!(poll(a.as_mut()), Poll::Ready(false));
        assert!(html(&c, &k).is_none());
        c.invalidate_tags(&tags(&["t"]));
        let mut b = std::pin::pin!(render("new"));
        assert!(poll(b.as_mut()).is_pending());
        assert_eq!(poll(b.as_mut()), Poll::Ready(true));
        assert!(html(&c, &k).is_some());

        let j = jobs(&t);
        let call = |v: i64| {
            let j = &j;
            async move {
                let s = j.read_stamp();
                YieldOnce(false).await;
                j.insert(jk("k:a/j0/u"), val(json!(v)), None, &[], Some("u"), s)
            }
        };
        let mut a = std::pin::pin!(call(1));
        assert!(poll(a.as_mut()).is_pending());
        j.invalidate_user_key("u");
        assert_eq!(poll(a.as_mut()), Poll::Ready(false));
        assert!(j.get(&jk("k:a/j0/u")).is_none());
        j.invalidate_user_key("u");
        let mut b = std::pin::pin!(call(2));
        assert!(poll(b.as_mut()).is_pending());
        assert_eq!(poll(b.as_mut()), Poll::Ready(true));
        assert!(j.get(&jk("k:a/j0/u")).is_some());
    }
}

#[cfg(test)]
mod conformance {
    use super::*;
    use crate::cache::JobKey;
    use crate::cache::conformance::{ConformJobs, ConformL1};
    use crate::host::{JobStore, ManualClock};

    impl ConformL1 for LocalL1<ManualClock> {
        fn clear(&self) -> usize {
            LocalL1::clear(self)
        }
        fn tag_slot(&self, t: &str) -> usize {
            LocalL1::tag_slot(self, t)
        }
        fn path_slot(&self, m: &str, p: &str) -> usize {
            LocalL1::path_slot(self, m, p)
        }
        fn tag_index_size(&self) -> usize {
            LocalL1::tag_index_size(self)
        }
    }

    crate::page_cache_conformance!(<LocalL1<ManualClock> as PageCache>::with_clock);

    impl ConformJobs for LocalJobs<ManualClock> {
        fn clear(&self) {
            LocalJobs::clear(self)
        }
        fn invalidate_key(&self, k: &JobKey) -> bool {
            LocalJobs::invalidate_key(self, k)
        }
        fn tag_slot(&self, t: &str) -> usize {
            LocalJobs::tag_slot(self, t)
        }
        fn key_slot(&self, u: &str) -> usize {
            LocalJobs::key_slot(self, u)
        }
        fn tag_index_size(&self) -> usize {
            LocalJobs::tag_index_size(self)
        }
        fn key_index_size(&self) -> usize {
            LocalJobs::key_index_size(self)
        }
    }

    crate::job_store_conformance!(<LocalJobs<ManualClock> as JobStore>::with_clock);
    crate::shared_clock_conformance!(
        <LocalL1<ManualClock> as PageCache>::with_clock,
        <LocalJobs<ManualClock> as JobStore>::with_clock
    );
}
