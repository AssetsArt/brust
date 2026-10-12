//! The cache contract as tests: one suite of F81/F86/F89 cases that every `PageCache` /
//! `JobStore` implementation must pass — the native moka caches (brust-server unit tests) and the
//! single-thread `cache::local` caches (brust-core unit tests) run the same cases under the same
//! names (`page_cache_conformance!`, `job_store_conformance!`, `shared_clock_conformance!`).
//!
//! Cases are copied from the native tests they cite (`l1.rs`, `job_cache.rs`,
//! `tests/l1_concurrency.rs`), single-thread, with no sleeps: a ttl that had to elapse is
//! `Duration::ZERO`, and `settle()` stands where the native tests drove moka's maintenance.
//! After a capacity fill a case asserts "its own body or none", never presence (moka's TinyLFU
//! may refuse an insert). Test-only (`cfg(any(test, feature = "conformance"))`); not an API.
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use brust_jinja::ctx::Node;
use bytes::Bytes;

use super::stamp::InvalClock;
use super::{CacheKey, JobKey, RenderedBody};
use crate::host::{JobStore, PageCache};

/// A `PageCache` plus the hooks the suite reads.
pub trait ConformL1: PageCache {
    /// Remove every entry; the number removed.
    fn clear(&self) -> usize;
    /// The tag invalidation slot of `t` (cases pick non-colliding names with it).
    fn tag_slot(&self, t: &str) -> usize;
    /// The `(method, path)` invalidation slot.
    fn path_slot(&self, m: &str, p: &str) -> usize;
    /// Keys indexed across all tags.
    fn tag_index_size(&self) -> usize;
    /// Finish deferred maintenance (native: moka's pending tasks).
    fn settle(&self) {}
}

/// A `JobStore` plus the hooks the suite reads.
pub trait ConformJobs: JobStore {
    fn clear(&self);
    /// Remove one key without an invalidation (no read stamp is affected).
    fn invalidate_key(&self, k: &JobKey) -> bool;
    fn tag_slot(&self, t: &str) -> usize;
    fn key_slot(&self, u: &str) -> usize;
    fn tag_index_size(&self) -> usize;
    fn key_index_size(&self) -> usize;
    fn settle(&self) {}
}

/// How a case builds a cache: `(capacity, invalidation clock)`.
pub type Make<'a, C> = &'a dyn Fn(u64, Arc<InvalClock>) -> C;

pub const TTL: Duration = Duration::from_secs(60);

pub fn rb_of(s: &str) -> Arc<RenderedBody> {
    Arc::new(RenderedBody {
        status: 200,
        headers: http::HeaderMap::new(),
        html: Bytes::from(s.to_string()),
        gzip: OnceLock::new(),
    })
}

pub fn key(method: &str, path: &str, query: &str) -> CacheKey {
    CacheKey {
        prefix: String::new(),
        method: method.to_string(),
        path: path.to_string(),
        sorted_query: query.to_string(),
    }
}

pub fn tags(ts: &[&str]) -> Vec<String> {
    ts.iter().map(|t| t.to_string()).collect()
}

pub fn val(v: serde_json::Value) -> Arc<Node> {
    Arc::new(Node::from(v))
}

fn html<C: PageCache>(c: &C, k: &CacheKey) -> Option<Bytes> {
    c.get_with(k, |b| b.html.clone())
}

fn k(s: &str) -> JobKey {
    JobKey(s.to_string())
}

/// The native tests' `L1Cache::new()`.
fn l1<C>(make: Make<'_, C>) -> C {
    make(1000, Arc::default())
}

/// The native tests' `store()` (`JobCache::new(100)`).
fn store<C>(make: Make<'_, C>) -> C {
    make(100, Arc::default())
}

/// Page-cache cases (`l1.rs` + `tests/l1_concurrency.rs`).
pub mod page {
    use super::*;

    /// l1.rs `get_with_runs_the_closure_once_and_only_on_a_hit`.
    pub fn get_with_runs_the_closure_once_and_only_on_a_hit<C: ConformL1>(make: Make<'_, C>) {
        let c = l1(make);
        let k = key("GET", "/g", "");
        let calls = std::cell::Cell::new(0);
        let r = c.get_with(&k, |b| {
            calls.set(calls.get() + 1);
            b.status
        });
        assert_eq!((r, calls.get()), (None, 0));
        c.insert(k.clone(), rb_of("g"), TTL, &[], c.read_stamp());
        let r = c.get_with(&k, |b| {
            calls.set(calls.get() + 1);
            b.status
        });
        assert_eq!((r, calls.get()), (Some(200), 1));
    }

    /// F86. The native case also pins `front_len() == 0`, a moka-front detail.
    pub fn an_invalidation_after_the_read_stamp_keeps_the_insert_out<C: ConformL1>(
        make: Make<'_, C>,
    ) {
        let c = l1(make);
        let k = key("GET", "/k", "");
        let s = c.read_stamp();
        c.invalidate_tags(&tags(&["t"]));
        assert!(!c.insert(k.clone(), rb_of("old"), TTL, &tags(&["t"]), s));
        assert!(html(&c, &k).is_none());
        c.settle();
        assert_eq!((c.tag_index_size(), c.stats().len), (0, 0));
    }

    pub fn an_insert_before_the_invalidation_is_still_evicted<C: ConformL1>(make: Make<'_, C>) {
        let c = l1(make);
        let k = key("GET", "/k", "");
        let s = c.read_stamp();
        assert!(c.insert(k.clone(), rb_of("v"), TTL, &tags(&["t"]), s));
        assert_eq!(c.invalidate_tags(&tags(&["t"])), 1);
        assert!(html(&c, &k).is_none());
    }

    pub fn a_stamp_after_the_invalidation_lands<C: ConformL1>(make: Make<'_, C>) {
        let c = l1(make);
        let k = key("GET", "/k", "");
        c.invalidate_tags(&tags(&["t"]));
        let s = c.read_stamp();
        assert!(c.insert(k.clone(), rb_of("new"), TTL, &tags(&["t"]), s));
        assert_eq!(html(&c, &k), Some(Bytes::from_static(b"new")));
    }

    pub fn an_untagged_insert_ignores_tag_invalidation<C: ConformL1>(make: Make<'_, C>) {
        let c = l1(make);
        let k = key("GET", "/k", "");
        let s = c.read_stamp();
        c.invalidate_tags(&tags(&["t"]));
        assert!(c.insert(k.clone(), rb_of("v"), TTL, &[], s));
        assert_eq!(html(&c, &k), Some(Bytes::from_static(b"v")));
    }

    pub fn an_unrelated_tag_invalidation_does_not_reject<C: ConformL1>(make: Make<'_, C>) {
        let c = l1(make);
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

    pub fn clear_after_the_stamp_keeps_the_insert_out<C: ConformL1>(make: Make<'_, C>) {
        let c = l1(make);
        let k = key("GET", "/k", "");
        let s = c.read_stamp();
        c.clear();
        assert!(!c.insert(k.clone(), rb_of("old"), TTL, &[], s));
        assert!(html(&c, &k).is_none());
    }

    pub fn a_rejected_insert_leaves_the_newer_entry<C: ConformL1>(make: Make<'_, C>) {
        let c = l1(make);
        let k = key("GET", "/k", "");
        let s1 = c.read_stamp();
        c.invalidate_tags(&tags(&["t"]));
        let s2 = c.read_stamp();
        assert!(c.insert(k.clone(), rb_of("new"), TTL, &tags(&["t"]), s2));
        assert!(!c.insert(k.clone(), rb_of("old"), TTL, &tags(&["t"]), s1));
        assert_eq!(html(&c, &k), Some(Bytes::from_static(b"new")));
        c.settle();
        assert_eq!(c.tag_index_size(), 1);
    }

    pub fn invalidate_path_after_the_stamp_keeps_the_insert_out<C: ConformL1>(make: Make<'_, C>) {
        let c = l1(make);
        let k = key("GET", "/p", "x=1");
        let s = c.read_stamp();
        c.invalidate_path("GET", "/p");
        assert!(!c.insert(k.clone(), rb_of("old"), TTL, &[], s));
        assert!(html(&c, &k).is_none());
    }

    pub fn invalidate_path_of_another_path_does_not_reject<C: ConformL1>(make: Make<'_, C>) {
        let c = l1(make);
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

    /// l1.rs `invalidate_path_removes_only_matching_entries` + `_no_match_returns_zero`.
    pub fn invalidate_path_counts_live_matches_across_queries<C: ConformL1>(make: Make<'_, C>) {
        let c = l1(make);
        c.insert(key("GET", "/a", ""), rb_of("a"), TTL, &[], c.read_stamp());
        c.insert(
            key("GET", "/a", "x=1"),
            rb_of("a-x"),
            TTL,
            &[],
            c.read_stamp(),
        );
        c.insert(key("GET", "/b", ""), rb_of("b"), TTL, &[], c.read_stamp());
        c.settle();

        let removed = c.invalidate_path("GET", "/a");
        c.settle();
        assert_eq!(removed, 2);
        assert!(html(&c, &key("GET", "/a", "")).is_none());
        assert!(html(&c, &key("GET", "/a", "x=1")).is_none());
        assert_eq!(
            html(&c, &key("GET", "/b", "")),
            Some(Bytes::from_static(b"b"))
        );
        assert_eq!(c.invalidate_path("GET", "/missing"), 0);
        assert_eq!(c.invalidate_path("POST", "/b"), 0);
        c.settle();
        assert_eq!(c.stats().len, 1);
    }

    /// l1.rs `invalidate_tags_removes_all_keyed_entries_in_group` + the index pruning.
    pub fn invalidate_tags_counts_distinct_keys_and_prunes_the_index<C: ConformL1>(
        make: Make<'_, C>,
    ) {
        let c = l1(make);
        let grp = tags(&["grp"]);
        c.insert(key("GET", "/a", ""), rb_of("a"), TTL, &grp, c.read_stamp());
        c.insert(
            key("GET", "/a", "x=1"),
            rb_of("a-x"),
            TTL,
            &tags(&["grp", "two"]),
            c.read_stamp(),
        );
        c.insert(
            key("GET", "/b", ""),
            rb_of("b"),
            TTL,
            &tags(&["other"]),
            c.read_stamp(),
        );
        c.settle();

        assert_eq!(c.invalidate_tags(&tags(&["grp", "two"])), 2);
        c.settle();
        assert!(html(&c, &key("GET", "/a", "")).is_none());
        assert!(html(&c, &key("GET", "/a", "x=1")).is_none());
        assert_eq!(
            html(&c, &key("GET", "/b", "")),
            Some(Bytes::from_static(b"b")),
            "untagged group survives"
        );
        assert_eq!(c.invalidate_tags(&tags(&["missing"])), 0);
        assert_eq!(c.invalidate_tags(&tags(&["other"])), 1);
        c.settle();
        assert_eq!(c.tag_index_size(), 0);
    }

    pub fn invalidate_and_clear_preserve_hits_and_misses<C: ConformL1>(make: Make<'_, C>) {
        let c = l1(make);
        c.insert(key("GET", "/a", ""), rb_of("a"), TTL, &[], c.read_stamp());
        c.settle();
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

    /// v2 regression: a re-insert must not let the old value un-index the new one.
    pub fn reinsert_keeps_newer_entry_tag_indexed<C: ConformL1>(make: Make<'_, C>) {
        let c = l1(make);
        let k = key("GET", "/r", "");
        c.insert(k.clone(), rb_of("1"), TTL, &tags(&["t"]), c.read_stamp());
        c.insert(k.clone(), rb_of("2"), TTL, &tags(&["t"]), c.read_stamp());
        c.settle();
        assert_eq!(c.tag_index_size(), 1, "new entry stays indexed");
        assert_eq!(c.invalidate_tags(&["t".to_string()]), 1);
        assert!(
            html(&c, &k).is_none(),
            "tag invalidation reaches the new entry"
        );
        assert_eq!(c.tag_index_size(), 0);
    }

    /// l1.rs `front_follows_moka_evictions_and_expiry`: capacity bounds the live count, and a key
    /// that reads at all reads its own body.
    pub fn capacity_bounds_len_and_never_serves_a_foreign_body<C: ConformL1>(make: Make<'_, C>) {
        let c = make(10, Arc::default());
        for i in 0..200 {
            let b = format!("b{i}");
            c.insert(
                key("GET", &format!("/p{i}"), ""),
                rb_of(&b),
                TTL,
                &[],
                c.read_stamp(),
            );
        }
        c.settle();
        let len = c.stats().len;
        assert!(len <= 10, "capacity bound the entry count: {len}");
        for i in 0..200 {
            if let Some(h) = html(&c, &key("GET", &format!("/p{i}"), "")) {
                assert_eq!(h, Bytes::from(format!("b{i}")), "foreign body at /p{i}");
            }
        }
    }

    /// F81 `hot_key_writer_makes_progress_under_twelve_readers`, single-thread: 300 writer ops on
    /// one key (every 7th an `invalidate_path`), three reads after every op.
    pub fn hot_key_interleaved_with_path_invalidation_ends_consistent<C: ConformL1>(
        make: Make<'_, C>,
    ) {
        let cache = l1(make);
        let hot = key("GET", "/hot", "");
        let (mut max_started, mut last_insert, mut invalidated_after_last) = (0, None, false);
        for i in 0..300 {
            if i % 7 == 6 {
                cache.invalidate_path("GET", "/hot");
                invalidated_after_last = true;
            } else {
                max_started = i;
                cache.insert(
                    hot.clone(),
                    rb_of(&format!("v{i}")),
                    TTL,
                    &tags(&["hot"]),
                    cache.read_stamp(),
                );
                last_insert = Some(i);
                invalidated_after_last = false;
            }
            for _ in 0..3 {
                if let Some(b) = html(&cache, &hot) {
                    let s = String::from_utf8(b.to_vec()).unwrap();
                    let n: usize = s
                        .strip_prefix('v')
                        .and_then(|n| n.parse().ok())
                        .unwrap_or_else(|| panic!("foreign body {s:?}"));
                    assert!(n <= max_started, "value {n} was never inserted yet");
                }
            }
        }
        let got = html(&cache, &hot).map(|b| String::from_utf8(b.to_vec()).unwrap());
        if invalidated_after_last {
            assert_eq!(got, None);
        } else {
            assert_eq!(got, Some(format!("v{}", last_insert.unwrap())));
        }
        assert!(cache.stats().len <= 1);
    }

    /// F81 `owners_churn_under_capacity_with_tag_invalidation_and_clear`, single-thread: 8 owners
    /// round-robin x 300 rounds at caps 64 and 500; `invalidate_path` every 3rd round, the `all`
    /// tag every 50th, `clear` at 5 fixed strides.
    pub fn owners_churn_under_capacity_with_tag_invalidation_and_clear<C: ConformL1>(
        make: Make<'_, C>,
    ) {
        const OWNERS: usize = 8;
        const ROUNDS: usize = 300;
        const CLEARS: usize = 5;
        for cap in [64, 500] {
            let cache = make(cap, Arc::default());
            let total = OWNERS * ROUNDS;
            let mut progress = 0;
            let mut clears = 0;
            for j in 0..ROUNDS {
                for o in 0..OWNERS {
                    let k = key("GET", &format!("/o{o}/k{j}"), "");
                    let v = format!("{o}-{j}");
                    cache.insert(
                        k.clone(),
                        rb_of(&v),
                        TTL,
                        &[format!("owner{o}"), "all".to_owned()],
                        cache.read_stamp(),
                    );
                    // Admission or a tag/clear may drop it; a DIFFERENT body is never legal.
                    if let Some(b) = html(&cache, &k) {
                        assert_eq!(b, Bytes::from(v), "cap {cap}: stale/foreign body");
                    }
                    if j % 3 == 0 {
                        cache.invalidate_path("GET", &k.path);
                        assert!(
                            html(&cache, &k).is_none(),
                            "cap {cap}: readable after invalidate_path"
                        );
                    }
                    if j % 50 == 49 {
                        cache.invalidate_tags(&tags(&["all"]));
                    }
                    progress += 1;
                    if clears < CLEARS && progress >= total * (clears + 1) / (CLEARS + 1) {
                        cache.clear();
                        clears += 1;
                    }
                }
            }
            cache.clear();
            for o in 0..OWNERS {
                for j in (0..ROUNDS).step_by(ROUNDS / 6 + 1) {
                    assert!(html(&cache, &key("GET", &format!("/o{o}/k{j}"), "")).is_none());
                }
            }
            assert_eq!(cache.stats().len, 0);
        }
    }
}

/// Job-store cases (`job_cache.rs`).
pub mod jobs {
    use super::*;
    use serde_json::json;

    pub fn set_then_get_returns_payload<C: ConformJobs>(make: Make<'_, C>) {
        let s = store(make);
        s.insert(
            k("k1"),
            Arc::new(Node::from(json!("PAYLOAD"))),
            None,
            &[],
            None,
            s.read_stamp(),
        );
        assert_eq!(
            s.get(&k("k1")),
            Some(Arc::new(Node::from(json!("PAYLOAD"))))
        );
    }

    pub fn missing_is_none<C: ConformJobs>(make: Make<'_, C>) {
        assert!(store(make).get(&k("nope")).is_none());
    }

    /// A zero ttl is a miss on the very next read, with no maintenance in between.
    pub fn zero_ttl_expires_immediately<C: ConformJobs>(make: Make<'_, C>) {
        let s = store(make);
        s.insert(
            k("k"),
            Arc::new(Node::from(json!("x"))),
            Some(Duration::ZERO),
            &[],
            None,
            s.read_stamp(),
        );
        assert!(s.get(&k("k")).is_none());
        assert_eq!(s.stats().misses, 1, "the read counts as a miss");
    }

    /// The native case waits out a 1 ms ttl; here the short entry has a zero ttl.
    pub fn ttl_none_survives_until_invalidated<C: ConformJobs>(make: Make<'_, C>) {
        let s = store(make);
        s.insert(
            k("n"),
            Arc::new(Node::from(json!("x"))),
            None,
            &["t".into()],
            None,
            s.read_stamp(),
        );
        s.insert(
            k("short"),
            Arc::new(Node::from(json!("y"))),
            Some(Duration::ZERO),
            &[],
            None,
            s.read_stamp(),
        );
        s.settle();
        assert!(s.get(&k("short")).is_none(), "ttl'd neighbour expired");
        assert_eq!(
            s.get(&k("n")),
            Some(Arc::new(Node::from(json!("x")))),
            "None never expires"
        );
        // A re-insert with `None` over a ttl'd entry clears the expiry too.
        s.insert(
            k("short"),
            Arc::new(Node::from(json!("z"))),
            Some(Duration::from_secs(60)),
            &[],
            None,
            s.read_stamp(),
        );
        s.insert(
            k("short"),
            Arc::new(Node::from(json!("z"))),
            None,
            &[],
            None,
            s.read_stamp(),
        );
        assert!(s.get(&k("short")).is_some());
        assert_eq!(s.invalidate_tags(&["t".into()]), 1);
        s.settle();
        assert!(s.get(&k("n")).is_none(), "gone once invalidated");
    }

    pub fn stats_count_hits_and_misses<C: ConformJobs>(make: Make<'_, C>) {
        let s = make(7, Arc::default());
        s.insert(
            k("a"),
            Arc::new(Node::from(json!(1))),
            None,
            &[],
            None,
            s.read_stamp(),
        );
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

    pub fn invalidate_tags_removes_group<C: ConformJobs>(make: Make<'_, C>) {
        let s = store(make);
        s.insert(
            k("a"),
            Arc::new(Node::from(json!("a"))),
            None,
            &["user:1".into()],
            None,
            s.read_stamp(),
        );
        s.insert(
            k("b"),
            Arc::new(Node::from(json!("b"))),
            None,
            &["user:1".into()],
            None,
            s.read_stamp(),
        );
        s.insert(
            k("c"),
            Arc::new(Node::from(json!("c"))),
            None,
            &["user:2".into()],
            None,
            s.read_stamp(),
        );
        assert_eq!(s.invalidate_tags(&["user:1".into()]), 2);
        s.settle();
        assert!(s.get(&k("a")).is_none());
        assert!(s.get(&k("b")).is_none());
        assert!(s.get(&k("c")).is_some());
    }

    pub fn user_key_invalidates_every_namespaced_entry<C: ConformJobs>(make: Make<'_, C>) {
        let s = store(make);
        s.insert(
            k("k:a/j0/5"),
            Arc::new(Node::from(json!(1))),
            None,
            &[],
            Some("5"),
            s.read_stamp(),
        );
        s.insert(
            k("k:b/j0/5"),
            Arc::new(Node::from(json!(2))),
            None,
            &[],
            Some("5"),
            s.read_stamp(),
        );
        s.insert(
            k("k:b/j0/6"),
            Arc::new(Node::from(json!(3))),
            None,
            &[],
            Some("6"),
            s.read_stamp(),
        );
        assert_eq!(s.key_index_size(), 3);
        assert_eq!(s.invalidate_user_key("5"), 2);
        s.settle();
        assert!(s.get(&k("k:a/j0/5")).is_none());
        assert!(s.get(&k("k:b/j0/5")).is_none());
        assert!(s.get(&k("k:b/j0/6")).is_some());
        assert_eq!(s.invalidate_user_key("5"), 0);
        // A re-insert keeps the newer entry indexed; removing the entry prunes the index.
        s.insert(
            k("k:b/j0/6"),
            Arc::new(Node::from(json!(4))),
            None,
            &[],
            Some("6"),
            s.read_stamp(),
        );
        s.settle();
        assert_eq!(s.key_index_size(), 1);
        assert!(s.invalidate_key(&k("k:b/j0/6")));
        s.settle();
        assert_eq!(s.key_index_size(), 0);
        s.insert(
            k("k:c/j0/7"),
            Arc::new(Node::from(json!(5))),
            None,
            &[],
            Some("7"),
            s.read_stamp(),
        );
        s.clear();
        assert_eq!(s.key_index_size(), 0);
    }

    pub fn reinsert_keeps_newer_entry_tag_indexed<C: ConformJobs>(make: Make<'_, C>) {
        let s = store(make);
        s.insert(
            k("r"),
            Arc::new(Node::from(json!(1))),
            None,
            &["t".into()],
            None,
            s.read_stamp(),
        );
        s.insert(
            k("r"),
            Arc::new(Node::from(json!(2))),
            None,
            &["t".into()],
            None,
            s.read_stamp(),
        );
        s.settle();
        assert_eq!(s.tag_index_size(), 1, "new entry stays indexed");
        assert_eq!(s.invalidate_tags(&["t".into()]), 1);
        s.settle();
        assert!(
            s.get(&k("r")).is_none(),
            "tag invalidation reaches the new entry"
        );
    }

    /// F89. The native case also pins `front_len() == 0`, a moka-front detail.
    pub fn invalidate_user_key_after_the_read_stamp_keeps_the_insert_out<C: ConformJobs>(
        make: Make<'_, C>,
    ) {
        let c = store(make);
        let s0 = c.read_stamp();
        assert_eq!(c.invalidate_user_key("u"), 0);
        assert!(!c.insert(k("k:a/j0/u"), val(json!("old")), None, &[], Some("u"), s0));
        assert!(c.get(&k("k:a/j0/u")).is_none());
        c.settle();
        assert_eq!(
            (c.key_index_size(), c.tag_index_size(), c.stats().len),
            (0, 0, 0)
        );
    }

    /// F89. The native case also pins `front_len() == 0`.
    pub fn a_tag_invalidation_after_the_read_stamp_keeps_the_insert_out<C: ConformJobs>(
        make: Make<'_, C>,
    ) {
        let c = store(make);
        let s0 = c.read_stamp();
        assert_eq!(c.invalidate_tags(&tags(&["t"])), 0);
        assert!(!c.insert(
            k("k:a/j0/u"),
            val(json!("old")),
            None,
            &tags(&["t"]),
            Some("u"),
            s0
        ));
        assert!(c.get(&k("k:a/j0/u")).is_none());
        c.settle();
        assert_eq!(
            (c.key_index_size(), c.tag_index_size(), c.stats().len),
            (0, 0, 0)
        );
    }

    pub fn an_insert_before_the_invalidation_is_still_evicted<C: ConformJobs>(make: Make<'_, C>) {
        let c = store(make);
        let s0 = c.read_stamp();
        assert!(c.insert(k("k:a/j0/u"), val(json!("v")), None, &[], Some("u"), s0));
        assert_eq!(c.invalidate_user_key("u"), 1);
        assert!(c.get(&k("k:a/j0/u")).is_none());
    }

    pub fn a_stamp_after_the_invalidation_lands<C: ConformJobs>(make: Make<'_, C>) {
        let c = store(make);
        c.invalidate_user_key("u");
        let s0 = c.read_stamp();
        assert!(c.insert(k("k:a/j0/u"), val(json!("new")), None, &[], Some("u"), s0));
        assert!(c.get(&k("k:a/j0/u")).is_some());
    }

    pub fn an_unrelated_user_key_does_not_reject<C: ConformJobs>(make: Make<'_, C>) {
        let c = store(make);
        let b = (0..)
            .map(|i| format!("u{i}"))
            .find(|b| c.key_slot(b) != c.key_slot("u"))
            .unwrap();
        let s0 = c.read_stamp();
        c.invalidate_user_key(&b);
        assert!(c.insert(k("k:a/j0/u"), val(json!("v")), None, &[], Some("u"), s0));
        assert!(c.get(&k("k:a/j0/u")).is_some());
    }

    pub fn an_unrelated_tag_does_not_reject<C: ConformJobs>(make: Make<'_, C>) {
        let c = store(make);
        let b = (0..)
            .map(|i| format!("t{i}"))
            .find(|b| c.tag_slot(b) != c.tag_slot("t"))
            .unwrap();
        let s0 = c.read_stamp();
        c.invalidate_tags(&[b]);
        assert!(c.insert(k("hash"), val(json!("v")), None, &tags(&["t"]), None, s0));
        assert!(c.get(&k("hash")).is_some());
    }

    pub fn a_tag_named_like_the_user_key_does_not_reject<C: ConformJobs>(make: Make<'_, C>) {
        let c = store(make);
        let s0 = c.read_stamp();
        c.invalidate_tags(&tags(&["u"]));
        assert!(c.insert(k("k:a/j0/u"), val(json!("v")), None, &[], Some("u"), s0));
        assert!(c.get(&k("k:a/j0/u")).is_some());
    }

    pub fn clear_after_the_stamp_keeps_the_insert_out<C: ConformJobs>(make: Make<'_, C>) {
        let c = store(make);
        let s0 = c.read_stamp();
        c.clear();
        assert!(!c.insert(k("hash"), val(json!("old")), None, &[], None, s0));
        assert!(c.get(&k("hash")).is_none());
    }

    pub fn a_rejected_insert_leaves_the_newer_entry<C: ConformJobs>(make: Make<'_, C>) {
        let c = store(make);
        let s1 = c.read_stamp();
        c.invalidate_user_key("u");
        let s2 = c.read_stamp();
        assert!(c.insert(k("k:a/j0/u"), val(json!("new")), None, &[], Some("u"), s2));
        assert!(!c.insert(k("k:a/j0/u"), val(json!("old")), None, &[], Some("u"), s1));
        assert_eq!(
            c.get(&k("k:a/j0/u")).as_deref(),
            Some(&Node::from(json!("new")))
        );
        c.settle();
        assert_eq!(c.key_index_size(), 1);
    }

    /// R2: one uniform check — a tagged content-keyed job is exactly where the app says the
    /// value is not a pure function of its hashed inputs.
    pub fn a_content_keyed_insert_is_checked_against_its_tags<C: ConformJobs>(make: Make<'_, C>) {
        let c = store(make);
        let s0 = c.read_stamp();
        c.invalidate_tags(&tags(&["t"]));
        assert!(!c.insert(k("hash1"), val(json!(1)), None, &tags(&["t"]), None, s0));
        assert!(c.insert(k("hash2"), val(json!(2)), None, &[], None, s0));
    }
}

/// Cases over one `InvalClock` shared by a page cache and a job store, as `Core::new` builds them
/// (F89: a rejected job insert keeps its page out of L1; the pipeline branch is host-agnostic).
pub mod shared {
    use super::*;
    use serde_json::json;

    pub fn one_clock_a_user_key_invalidation_rejects_a_job_stamped_before_it_and_advances_l1<
        L: ConformL1,
        J: ConformJobs,
    >(
        make_l1: Make<'_, L>,
        make_jobs: Make<'_, J>,
    ) {
        let clock = Arc::new(InvalClock::default());
        let (l1, jobs) = (make_l1(1000, Arc::clone(&clock)), make_jobs(100, clock));
        let s = l1.read_stamp();
        jobs.invalidate_user_key("u");
        assert!(!jobs.insert(k("k:a/j0/u"), val(json!(1)), None, &[], Some("u"), s));
        assert!(l1.read_stamp().0 > s.0);
    }

    pub fn one_clock_an_l1_tag_invalidation_rejects_neither_an_untagged_job_nor_an_unrelated_key<
        L: ConformL1,
        J: ConformJobs,
    >(
        make_l1: Make<'_, L>,
        make_jobs: Make<'_, J>,
    ) {
        let clock = Arc::new(InvalClock::default());
        let (l1, jobs) = (make_l1(1000, Arc::clone(&clock)), make_jobs(100, clock));
        let s = jobs.read_stamp();
        l1.invalidate_tags(&tags(&["t"]));
        assert!(jobs.read_stamp().0 > s.0);
        assert!(jobs.insert(k("hash"), val(json!(1)), None, &[], None, s));
        assert!(jobs.insert(k("k:a/j0/u"), val(json!(2)), None, &[], Some("u"), s));
        assert!(jobs.get(&k("hash")).is_some());
        assert!(jobs.get(&k("k:a/j0/u")).is_some());
    }
}

/// One `#[test]` per page-cache case, in a `page` module, for `$make: Fn(u64, Arc<InvalClock>) -> C`.
#[macro_export]
macro_rules! page_cache_conformance {
    ($make:expr) => {
        mod page {
            use super::*;
            $crate::__conformance_tests!(page, $make;
                get_with_runs_the_closure_once_and_only_on_a_hit,
                an_invalidation_after_the_read_stamp_keeps_the_insert_out,
                an_insert_before_the_invalidation_is_still_evicted,
                a_stamp_after_the_invalidation_lands,
                an_untagged_insert_ignores_tag_invalidation,
                an_unrelated_tag_invalidation_does_not_reject,
                clear_after_the_stamp_keeps_the_insert_out,
                a_rejected_insert_leaves_the_newer_entry,
                invalidate_path_after_the_stamp_keeps_the_insert_out,
                invalidate_path_of_another_path_does_not_reject,
                invalidate_path_counts_live_matches_across_queries,
                invalidate_tags_counts_distinct_keys_and_prunes_the_index,
                invalidate_and_clear_preserve_hits_and_misses,
                reinsert_keeps_newer_entry_tag_indexed,
                capacity_bounds_len_and_never_serves_a_foreign_body,
                hot_key_interleaved_with_path_invalidation_ends_consistent,
                owners_churn_under_capacity_with_tag_invalidation_and_clear,
            );
        }
    };
}

/// One `#[test]` per job-store case, in a `jobs` module.
#[macro_export]
macro_rules! job_store_conformance {
    ($make:expr) => {
        mod jobs {
            use super::*;
            $crate::__conformance_tests!(jobs, $make;
                set_then_get_returns_payload,
                missing_is_none,
                zero_ttl_expires_immediately,
                ttl_none_survives_until_invalidated,
                stats_count_hits_and_misses,
                invalidate_tags_removes_group,
                user_key_invalidates_every_namespaced_entry,
                reinsert_keeps_newer_entry_tag_indexed,
                invalidate_user_key_after_the_read_stamp_keeps_the_insert_out,
                a_tag_invalidation_after_the_read_stamp_keeps_the_insert_out,
                an_insert_before_the_invalidation_is_still_evicted,
                a_stamp_after_the_invalidation_lands,
                an_unrelated_user_key_does_not_reject,
                an_unrelated_tag_does_not_reject,
                a_tag_named_like_the_user_key_does_not_reject,
                clear_after_the_stamp_keeps_the_insert_out,
                a_rejected_insert_leaves_the_newer_entry,
                a_content_keyed_insert_is_checked_against_its_tags,
            );
        }
    };
}

/// One `#[test]` per shared-clock case, in a `shared` module.
#[macro_export]
macro_rules! shared_clock_conformance {
    ($make_l1:expr, $make_jobs:expr) => {
        mod shared {
            use super::*;
            #[test]
            fn one_clock_a_user_key_invalidation_rejects_a_job_stamped_before_it_and_advances_l1() {
                $crate::cache::conformance::shared::one_clock_a_user_key_invalidation_rejects_a_job_stamped_before_it_and_advances_l1(&$make_l1, &$make_jobs)
            }
            #[test]
            fn one_clock_an_l1_tag_invalidation_rejects_neither_an_untagged_job_nor_an_unrelated_key()
            {
                $crate::cache::conformance::shared::one_clock_an_l1_tag_invalidation_rejects_neither_an_untagged_job_nor_an_unrelated_key(&$make_l1, &$make_jobs)
            }
        }
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __conformance_tests {
    ($group:ident, $make:expr; $($case:ident),* $(,)?) => {
        $(
            #[test]
            fn $case() {
                $crate::cache::conformance::$group::$case(&$make)
            }
        )*
    };
}
