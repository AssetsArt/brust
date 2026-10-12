//! The host seam: what a host (native tokio + hyper + the Bun worker pool; Cloudflare Workers
//! later) provides to the core pipeline. Static dispatch: the pipeline is generic over `H: Host`
//! and monomorphised per host, so the native build calls these as it called its own functions
//! (no `dyn`, no boxed futures).
//!
//! `Send`: the methods return `impl Future` WITHOUT a `Send` bound — Workers futures are `!Send`.
//! Auto traits leak through a concrete impl, so the native host's futures stay `Send`; the native
//! adapter asserts it at compile time on the spawned per-request future.
use std::cell::Cell;
use std::future::Future;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use brust_jinja::ctx::Node;
use bytes::Bytes;
use http::HeaderMap;

use crate::cache::stamp::{InvalClock, ReadStamp};
use crate::cache::{CacheKey, CacheStats, JobKey, RenderedBody};
use crate::plan::{PlanSeed, PlannedCall};
use crate::protocol::{FetchResponse, JobsRequest, JobsResponse, LoaderRequest, LoaderResponse};

/// What the pipeline reads of a request's head.
pub struct RequestHead<'a> {
    pub method: &'a str,
    /// `path?query` as received (the path alone when there is no query).
    pub full: &'a str,
    pub headers: &'a HeaderMap,
    /// The URI authority (HTTP/2 `:authority`), when the request line carried one.
    pub authority: Option<&'a str>,
}

/// Why a request body could not be read whole.
#[derive(Debug, PartialEq, Eq)]
pub enum ReadErr {
    /// Over the cap: by the declared length (before any read) or while reading.
    TooLarge,
    /// The client's body failed mid-read.
    Io,
    /// The body did not arrive within the deadline (a trickled body would hold the connection and up to `cap` bytes).
    Slow,
}

/// Which static root a request names.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StaticRoot {
    /// `/_brust/<rel>` → `dist/<rel>`, restricted to `client/` chunks.
    Brust,
    /// `/public/<rel>` → `dist/public/<rel>`.
    Public,
}

/// Why a host worker call (native: `call_worker`) produced no response.
#[derive(Debug, thiserror::Error)]
pub enum CallError {
    /// No workers registered at all — none will ever appear, so 503 at once.
    #[error("no workers")]
    NoWorkers,
    /// Every worker stayed busy until the claim timeout — 503 last-resort.
    #[error("all workers busy")]
    Timeout,
    /// The bridge enqueue failed; the worker was removed from the pool.
    #[error("worker dead: {0}")]
    Enqueue(String),
    /// The worker's Promise rejected; the worker is still alive.
    #[error("worker rejected: {0}")]
    Rejected(String),
    /// A claimed call did not settle within the call deadline — 504. The
    /// detached remainder still holds the claim until the JS promise settles.
    #[error("call deadline exceeded")]
    Deadline,
    /// Request serialisation, an out-of-bounds length, or unparsable JSON.
    #[error("bad response: {0}")]
    BadResponse(String),
}

/// One action request, admitted: what the host forwards to the app.
pub struct ActionCall<'a> {
    pub method: &'a str,
    pub full: &'a str,
    pub headers: &'a HeaderMap,
    pub authority: Option<&'a str>,
    /// The whole request body; `None` for GET/HEAD and for an empty body.
    pub body: Option<Bytes>,
}

/// A monotonic clock for request timing (the `dur_ms` log field).
pub trait Clock {
    fn now_ns(&self) -> u64;
    fn now_ms(&self) -> u64 {
        self.now_ns() / 1_000_000
    }
}

/// `ms` (a JS `Date.now()`) in ns, never below the last reading in `last`: a reading that goes
/// back, is NaN or is negative returns the last one. Native-host seam, not an API.
#[doc(hidden)]
pub fn monotone_ns(last: &Cell<u64>, ms: f64) -> u64 {
    let ns = ms * 1e6;
    // NaN fails the comparison; `as u64` saturates above u64::MAX.
    if ns >= 0.0 && ns as u64 > last.get() {
        last.set(ns as u64);
    }
    last.get()
}

/// A hand-advanced clock (tests): clones share one reading. Not an API.
#[doc(hidden)]
#[derive(Clone, Debug, Default)]
pub struct ManualClock(Rc<Cell<u64>>);

impl ManualClock {
    pub fn advance(&self, d: Duration) {
        let ns = u64::try_from(d.as_nanos()).unwrap_or(u64::MAX);
        self.0.set(self.0.get().saturating_add(ns));
    }

    pub fn set_ns(&self, ns: u64) {
        self.0.set(ns);
    }
}

impl Clock for ManualClock {
    fn now_ns(&self) -> u64 {
        self.0.get()
    }
}

/// The Workers clock (R5): `js_sys::Date::now()` through [`monotone_ns`]. On Workers
/// `Date.now()` (like `performance.now()`) only advances after I/O
/// (<https://developers.cloudflare.com/workers/runtime-apis/performance/>), so a TTL is coarse
/// within one request; `Instant::now` panics on wasm32-unknown-unknown.
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
#[derive(Debug, Default)]
pub struct JsClock {
    last: Cell<u64>,
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
impl Clock for JsClock {
    fn now_ns(&self) -> u64 {
        monotone_ns(&self.last, js_sys::Date::now())
    }
}

/// The page (L1) cache contract: the native `L1Cache`'s API, read stamps included (F86).
pub trait PageCache {
    fn with_clock(capacity: u64, clock: Arc<InvalClock>) -> Self
    where
        Self: Sized;
    fn get_with<R>(&self, key: &CacheKey, f: impl FnOnce(&Arc<RenderedBody>) -> R) -> Option<R>;
    fn insert(
        &self,
        key: CacheKey,
        body: Arc<RenderedBody>,
        ttl: Duration,
        tags: &[String],
        since: ReadStamp,
    ) -> bool;
    fn read_stamp(&self) -> ReadStamp;
    fn invalidate_tags(&self, tags: &[String]) -> usize;
    fn invalidate_path(&self, method: &str, path: &str) -> usize;
    fn stats(&self) -> CacheStats;
}

/// The job cache contract: the native `JobCache`'s API, read stamps included (F89).
pub trait JobStore {
    fn with_clock(capacity: u64, clock: Arc<InvalClock>) -> Self
    where
        Self: Sized;
    fn get(&self, k: &JobKey) -> Option<Arc<Node>>;
    fn insert(
        &self,
        k: JobKey,
        v: Arc<Node>,
        ttl: Option<Duration>,
        tags: &[String],
        user_key: Option<&str>,
        since: ReadStamp,
    ) -> bool;
    fn read_stamp(&self) -> ReadStamp;
    fn invalidate_tags(&self, tags: &[String]) -> usize;
    fn invalidate_user_key(&self, user_key: &str) -> usize;
    fn stats(&self) -> CacheStats;
}

/// Everything a host provides. No `Send` bound (see the module docs).
pub trait Host: Clock {
    /// The request body type (native: hyper `Incoming`).
    type Body;
    type L1: PageCache;
    type Jobs: JobStore;
    /// Whether the loader call may be offered the job plan (M3-P P6): native `true`.
    const PLAN_OFFER: bool;

    /// The loader call. `offer`: plan the jobs inside the call; a planned call returns the plan.
    fn loader(
        &self,
        req: &LoaderRequest<'_>,
        offer: Option<PlanSeed>,
    ) -> impl Future<Output = Result<(LoaderResponse, Option<PlannedCall>), CallError>>;
    /// The one batched jobs call for a page's misses.
    fn jobs(&self, req: &JobsRequest<'_>) -> impl Future<Output = Result<JobsResponse, CallError>>;
    /// The whole body, at most `cap` bytes.
    fn read_body(
        &self,
        body: Self::Body,
        cap: usize,
    ) -> impl Future<Output = Result<Bytes, ReadErr>>;
    /// One action request → the app's answer.
    fn action(
        &self,
        call: ActionCall<'_>,
    ) -> impl Future<Output = Result<FetchResponse, CallError>>;
    /// A static file under `root`; `rel` already passed `static_rules::safe_rel`. `None` = 404.
    fn static_file(
        &self,
        root: StaticRoot,
        rel: &str,
        headers: &HeaderMap,
        head: bool,
    ) -> impl Future<Output = Option<http::Response<Bytes>>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monotone_never_goes_back() {
        let last = Cell::new(0);
        assert_eq!(monotone_ns(&last, 5.0), 5_000_000);
        assert_eq!(monotone_ns(&last, 3.0), 5_000_000);
        assert_eq!(monotone_ns(&last, f64::NAN), 5_000_000);
        assert_eq!(monotone_ns(&last, -1.0), 5_000_000);
        assert_eq!(monotone_ns(&last, 7.5), 7_500_000);
    }

    #[test]
    fn manual_clock_is_shared_by_clones() {
        let a = ManualClock::default();
        let b = a.clone();
        b.advance(Duration::from_secs(2));
        assert_eq!(a.now_ns(), 2_000_000_000);
    }
}
