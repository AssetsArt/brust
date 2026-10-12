//! Cache contracts shared by every host: the key-expression language, the invalidation clock,
//! and the entry/key/stats types both page and job caches speak. The caches themselves are
//! per host (native: moka + sharded fronts in `brust-server`), behind `host::{PageCache, JobStore}`.
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use bytes::Bytes;
use serde::Serialize;

pub mod key_expr;
pub mod stamp;

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

/// Stats snapshot, shared by L1 and the job cache. Serialized to JSON by the
/// /_brust/cache/stats native route.
#[derive(Debug, Clone, Serialize)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    pub len: usize,
    pub capacity: usize,
}

/// `job_key()` hex, or `"k:<componentId>/<jobId>/<user key>"` for `cache({key})`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct JobKey(pub String);

/// A hit/miss counter striped by thread. Twin of the job cache's (dedupe after m3p-d: follow-up F-2).
#[doc(hidden)]
pub struct StripedCounter([PaddedU64; COUNTER_STRIPES]);

#[repr(align(128))]
#[derive(Default)]
struct PaddedU64(AtomicU64);

const COUNTER_STRIPES: usize = 16;

impl Default for StripedCounter {
    fn default() -> Self {
        Self::new()
    }
}

impl StripedCounter {
    pub fn new() -> Self {
        Self(std::array::from_fn(|_| PaddedU64::default()))
    }

    pub fn incr(&self) {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        thread_local! {
            static SLOT: usize = NEXT.fetch_add(1, Ordering::Relaxed) % COUNTER_STRIPES;
        }
        let slot = SLOT.with(|s| *s);
        self.0[slot].0.fetch_add(1, Ordering::Relaxed);
    }

    pub fn get(&self) -> u64 {
        self.0.iter().map(|c| c.0.load(Ordering::Relaxed)).sum()
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
