//! The shared second cache tier (cache adapters, `docs/design/2026-10-12-cache-adapter-design.md`):
//! the contract types a host's `Host::l2_get` / `Host::l2_set` speak, the per-core counters behind
//! `stats.l2`, and the invalidation floor that keeps an L2 body older than a replayed invalidation
//! from being served (spec §4.2.3; native and Workers alike, ruling L7c).
//!
//! The adapter itself is TypeScript (`@brust/core/cache-adapter`); the core never calls it directly.
//! Tier 1 (the in-process L1 + job cache) is unchanged and always consulted first.
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use bytes::Bytes;
use http::{HeaderMap, HeaderName, HeaderValue};
use serde::Serialize;

use crate::cache::{CacheKey, RenderedBody};
use crate::config::InvalidateArgs;

/// The configured adapter, fixed for the core's lifetime. `None` in `CoreConfig` = no L2.
#[derive(Clone, Debug)]
pub struct L2Config {
    /// The `[cache] adapter` name (`stats.l2.adapter`).
    pub adapter: String,
    /// The `store.get` budget on the request path (spec R7).
    pub get_timeout: Duration,
    /// A bigger rendered body is not written (`set_oversize`).
    pub max_body_bytes: usize,
    pub namespace: String,
    /// The build's id (16 hex chars of sha256 over the build output, computed by the build).
    pub build_id: String,
}

/// A shared-tier key: `"<namespace>:<build_id>:p:" + hex(blake3(prefix ‖ 0 ‖ method ‖ 0 ‖ path ‖ 0 ‖ sorted_query))`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct L2Key(pub String);

impl L2Key {
    pub fn of(cfg: &L2Config, k: &CacheKey) -> Self {
        let mut h = blake3::Hasher::new();
        for (i, part) in [&k.prefix, &k.method, &k.path, &k.sorted_query]
            .into_iter()
            .enumerate()
        {
            if i > 0 {
                h.update(&[0]);
            }
            h.update(part.as_bytes());
        }
        L2Key(format!(
            "{}:{}:p:{}",
            cfg.namespace,
            cfg.build_id,
            h.finalize().to_hex()
        ))
    }
}

/// What a lookup knows about the request.
pub struct L2Probe<'a> {
    pub key: &'a L2Key,
    /// The request path (no query): the floor's `(GET, path)` name.
    pub path: &'a str,
    /// The route's cache tags.
    pub tags: &'a [String],
}

/// A stored page: identity body + its validated headers, in order (repeats kept).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct L2Page {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Bytes,
}

/// `store.set`'s metadata. `stamp` = the broadcast seq the lookup returned (`None` = unguarded).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct L2SetMeta {
    pub ttl_ms: u64,
    pub tags: Vec<String>,
    pub method: String,
    pub path: String,
    pub stamp: Option<u64>,
}

/// A host's answer to one `l2_get`.
#[derive(Debug)]
pub enum L2Lookup {
    /// No adapter store (the default `Host::l2_get`).
    Off,
    /// Not there. `stamp` = the broadcast seq now: the write guard's base (ruling L2: write on any miss).
    Miss {
        stamp: Option<u64>,
    },
    /// There, but older than an invalidation this instance replayed: a miss that may write.
    Floor {
        stamp: Option<u64>,
    },
    Hit {
        page: L2Page,
        stamp: Option<u64>,
        /// The stamp the entry was written under (ruling L1); `None` = never floor-rejected.
        entry_stamp: Option<u64>,
        stored_at_ms: Option<u64>,
    },
    /// The `get_timeout` budget ran out: no stamp, no write.
    Timeout,
    Failed(String),
}

/// Response headers that belong to one response, never to a stored page.
const PER_REQUEST: [&str; 6] = [
    "x-brust-cache",
    "content-encoding",
    "vary",
    "content-length",
    "transfer-encoding",
    "set-cookie",
];

/// A page's headers as ordered pairs (repeats kept); non-UTF-8 values are skipped.
pub fn pairs_of(h: &HeaderMap) -> Vec<(String, String)> {
    h.iter()
        .filter_map(|(k, v)| Some((k.as_str().to_owned(), v.to_str().ok()?.to_owned())))
        .collect()
}

/// The `RenderedBody` an L2 page becomes: per-request headers dropped, invalid names/values skipped.
pub fn page_from_l2(p: L2Page) -> RenderedBody {
    let mut headers = HeaderMap::with_capacity(p.headers.len());
    for (k, v) in &p.headers {
        let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) else {
            continue;
        };
        if PER_REQUEST.contains(&name.as_str()) {
            continue;
        }
        headers.append(name, value);
    }
    RenderedBody {
        status: p.status,
        headers,
        html: p.body,
        gzip: Default::default(),
    }
}

/// The L1 TTL of a body read from L2 (R6): what is left of `ttl` since `stored_at_ms`, at least 1 s;
/// `None` = already expired (treated as a miss). No `stored_at` → the full `ttl`.
pub fn remaining_ttl(ttl: Duration, stored_at_ms: Option<u64>, now_ms: u64) -> Option<Duration> {
    let Some(at) = stored_at_ms else {
        return Some(ttl);
    };
    let age = Duration::from_millis(now_ms.saturating_sub(at));
    if age >= ttl {
        return None;
    }
    Some((ttl - age).max(Duration::from_secs(1)).min(ttl))
}

macro_rules! counters {
    ($($f:ident),* $(,)?) => {
        /// The `stats.l2` counters (spec §8 + `set_oversize`), one set per core.
        #[derive(Debug, Default)]
        pub struct L2Counters { $(pub $f: AtomicU64,)* }

        /// `stats.l2`: the adapter name, then the counters in spec §8 order.
        #[derive(Debug, Clone, Serialize, PartialEq, Eq)]
        pub struct L2Stats { pub adapter: String, $(pub $f: u64,)* }

        impl L2Counters {
            /// Bump the counter named `name` (the JS side's `l2Count`); `false` = no such counter.
            pub fn bump(&self, name: &str) -> bool {
                match name {
                    $(stringify!($f) => { self.$f.fetch_add(1, Ordering::Relaxed); true })*
                    _ => false,
                }
            }

            pub fn snapshot(&self, adapter: &str) -> L2Stats {
                L2Stats { adapter: adapter.to_owned(), $($f: self.$f.load(Ordering::Relaxed),)* }
            }
        }
    };
}

counters!(
    hits,
    misses,
    timeouts,
    errors,
    rejected_floor,
    sets,
    set_refused,
    set_dropped,
    set_oversize,
    published,
    publish_errors,
    received,
    skipped_own,
    resets,
    epoch_polls,
    poll_errors,
);

/// Names the floor remembers at most (oldest raised first out).
pub const FLOOR_NAMES: usize = 4096;

/// The invalidation floor (spec §4.2.3, ruling L7c): per tag and per `(method, path)`, the seq of
/// the last invalidation this instance replayed. An L2 hit whose `entry_stamp` is below the floor
/// of its route tags or its `GET path` was written before that invalidation and is a miss.
/// `global` is raised by a same-generation clear (a gap: which names moved is unknown).
#[derive(Debug, Default)]
pub struct Floor {
    names: HashMap<String, (u64, u64)>,
    global: Option<u64>,
    tick: u64,
}

fn tag_name(t: &str) -> String {
    format!("t:{t}")
}

fn path_name(method: &str, path: &str) -> String {
    format!("p:{method} {path}")
}

impl Floor {
    fn raise_name(&mut self, name: String, seq: u64) {
        self.tick += 1;
        let tick = self.tick;
        let e = self.names.entry(name).or_insert((0, tick));
        e.0 = e.0.max(seq);
        e.1 = tick;
        if self.names.len() > FLOOR_NAMES
            && let Some(old) = self
                .names
                .iter()
                .min_by_key(|(_, (_, t))| *t)
                .map(|(k, _)| k.clone())
        {
            self.names.remove(&old);
        }
    }

    /// An invalidation with `seq` was replayed: raise the floors of its tags and path.
    pub fn raise(&mut self, args: &InvalidateArgs, seq: u64) {
        for t in &args.tags {
            self.raise_name(tag_name(t), seq);
        }
        if let Some(p) = &args.path {
            self.raise_name(path_name(args.method.as_deref().unwrap_or("GET"), p), seq);
        }
    }

    /// A gap in the same generation: every entry written before `seq` is suspect.
    pub fn clear_at(&mut self, seq: u64) {
        self.global = Some(self.global.map_or(seq, |g| g.max(seq)));
    }

    /// A new generation: the old seq space means nothing any more.
    pub fn reset(&mut self) {
        *self = Floor::default();
    }

    /// The hit is older than an invalidation of its tags/path (or a gap clear).
    pub fn rejects(&self, entry_stamp: Option<u64>, path: &str, tags: &[String]) -> bool {
        let Some(s) = entry_stamp else {
            return false;
        };
        if self.global.is_some_and(|g| s < g) {
            return true;
        }
        let below = |name: String| self.names.get(&name).is_some_and(|(f, _)| s < *f);
        tags.iter().any(|t| below(tag_name(t))) || below(path_name("GET", path))
    }
}

/// The core's floor: locked only on an L2 hit and on a replay.
#[derive(Debug, Default)]
pub struct SharedFloor(Mutex<Floor>);

impl SharedFloor {
    pub fn with<R>(&self, f: impl FnOnce(&mut Floor) -> R) -> R {
        let mut g = self.0.lock().unwrap_or_else(|p| p.into_inner());
        f(&mut g)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(ns: &str, b: &str) -> L2Config {
        L2Config {
            adapter: "custom".into(),
            get_timeout: Duration::from_millis(50),
            max_body_bytes: 1 << 20,
            namespace: ns.into(),
            build_id: b.into(),
        }
    }

    fn key(prefix: &str, m: &str, p: &str, q: &str) -> CacheKey {
        CacheKey {
            prefix: prefix.into(),
            method: m.into(),
            path: p.into(),
            sorted_query: q.into(),
        }
    }

    #[test]
    fn l2_key_is_namespaced_and_stable() {
        let c = cfg("ns", "b1");
        let a = L2Key::of(&c, &key("", "GET", "/a", "x=1"));
        let hex = a.0.strip_prefix("ns:b1:p:").expect("prefix");
        assert_eq!(hex.len(), 64);
        assert!(hex.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(a, L2Key::of(&c, &key("", "GET", "/a", "x=1")));
        assert_ne!(a, L2Key::of(&c, &key("t1", "GET", "/a", "x=1")));
        assert_ne!(a, L2Key::of(&c, &key("", "GET", "/a", "x=2")));
        // The separators keep field boundaries: ("ab","") != ("a","b").
        assert_ne!(
            L2Key::of(&c, &key("", "GET", "/ab", "")),
            L2Key::of(&c, &key("", "GET", "/a", "b"))
        );
    }

    #[test]
    fn l2_page_drops_per_request_headers() {
        let names = [
            "content-type",
            "x-brust-cache",
            "content-encoding",
            "vary",
            "content-length",
            "transfer-encoding",
            "set-cookie",
            "x-app",
        ];
        let mut headers: Vec<(String, String)> =
            names.iter().map(|n| (n.to_string(), "v".into())).collect();
        headers.push(("bad name".into(), "v".into()));
        headers.push(("x-bad-value".into(), "a\nb".into()));
        let b = page_from_l2(L2Page {
            status: 200,
            headers,
            body: Bytes::from_static(b"<p>"),
        });
        let kept: Vec<&str> = b.headers.keys().map(|k| k.as_str()).collect();
        assert_eq!(kept, ["content-type", "x-app"]);
        assert_eq!(&b.html[..], b"<p>");
    }

    #[test]
    fn pairs_round_trip_order_and_repeats() {
        let mut h = HeaderMap::new();
        h.append("content-type", HeaderValue::from_static("text/html"));
        h.append("x-a", HeaderValue::from_static("1"));
        h.append("x-a", HeaderValue::from_static("2"));
        let pairs = pairs_of(&h);
        assert_eq!(
            pairs,
            [
                ("content-type".to_string(), "text/html".to_string()),
                ("x-a".into(), "1".into()),
                ("x-a".into(), "2".into())
            ]
        );
        let back = page_from_l2(L2Page {
            status: 200,
            headers: pairs,
            body: Bytes::new(),
        });
        let xa: Vec<_> = back.headers.get_all("x-a").iter().collect();
        assert_eq!(xa, ["1", "2"]);
    }

    #[test]
    fn counters_bump_by_name() {
        let c = L2Counters::default();
        assert!(c.bump("published"));
        assert!(!c.bump("nope"));
        assert_eq!(c.published.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn l2_stats_shape() {
        let c = L2Counters::default();
        assert_eq!(
            serde_json::to_string(&c.snapshot("custom")).unwrap(),
            r#"{"adapter":"custom","hits":0,"misses":0,"timeouts":0,"errors":0,"rejected_floor":0,"sets":0,"set_refused":0,"set_dropped":0,"set_oversize":0,"published":0,"publish_errors":0,"received":0,"skipped_own":0,"resets":0,"epoch_polls":0,"poll_errors":0}"#
        );
    }

    #[test]
    fn remaining_ttl_clamps() {
        let ttl = Duration::from_secs(60);
        assert_eq!(remaining_ttl(ttl, None, 5), Some(ttl));
        assert_eq!(remaining_ttl(ttl, Some(1000), 1000), Some(ttl));
        assert_eq!(remaining_ttl(ttl, Some(0), 61_000), None);
        assert_eq!(remaining_ttl(ttl, Some(0), 60_000), None);
        assert_eq!(
            remaining_ttl(ttl, Some(0), 59_500),
            Some(Duration::from_secs(1))
        );
        assert_eq!(
            remaining_ttl(ttl, Some(0), 30_000),
            Some(Duration::from_secs(30))
        );
    }

    fn tags(t: &[&str]) -> InvalidateArgs {
        InvalidateArgs {
            tags: t.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn replay_raises_tag_and_path_floors() {
        let mut f = Floor::default();
        f.raise(&tags(&["items"]), 7);
        f.raise(
            &InvalidateArgs {
                path: Some("/a".into()),
                ..Default::default()
            },
            9,
        );
        let t = ["items".to_string()];
        assert!(f.rejects(Some(6), "/x", &t));
        assert!(!f.rejects(Some(7), "/x", &t));
        assert!(f.rejects(Some(8), "/a", &[]));
        assert!(!f.rejects(Some(9), "/a", &[]));
        // A POST-path invalidation does not floor the GET page.
        f.raise(
            &InvalidateArgs {
                path: Some("/b".into()),
                method: Some("POST".into()),
                ..Default::default()
            },
            20,
        );
        assert!(!f.rejects(Some(1), "/b", &[]));
    }

    #[test]
    fn hit_below_a_tag_floor_is_rejected() {
        let mut f = Floor::default();
        f.raise(&tags(&["a", "b"]), 5);
        assert!(f.rejects(Some(4), "/p", &["x".into(), "b".into()]));
        assert!(!f.rejects(Some(4), "/p", &["x".into()]));
    }

    #[test]
    fn entry_stamp_none_is_never_rejected() {
        let mut f = Floor::default();
        f.raise(&tags(&["a"]), 5);
        f.clear_at(100);
        assert!(!f.rejects(None, "/p", &["a".into()]));
    }

    #[test]
    fn clear_same_gen_sets_global_floor() {
        let mut f = Floor::default();
        f.clear_at(10);
        assert!(f.rejects(Some(9), "/any", &[]));
        assert!(!f.rejects(Some(10), "/any", &[]));
        f.clear_at(3);
        assert!(
            f.rejects(Some(9), "/any", &[]),
            "a global floor never drops"
        );
    }

    #[test]
    fn clear_on_gen_change_resets_everything() {
        let mut f = Floor::default();
        f.raise(&tags(&["a"]), 5);
        f.clear_at(10);
        f.reset();
        assert!(!f.rejects(Some(0), "/p", &["a".into()]));
    }

    #[test]
    fn lru_evicts_oldest_name() {
        let mut f = Floor::default();
        f.raise(&tags(&["first"]), 5);
        for i in 0..FLOOR_NAMES {
            f.raise(&tags(&[&format!("t{i}")]), 5);
        }
        assert_eq!(f.names.len(), FLOOR_NAMES);
        assert!(!f.rejects(Some(1), "/p", &["first".into()]));
        assert!(f.rejects(Some(1), "/p", &[format!("t{}", FLOOR_NAMES - 1)]));
    }
}
