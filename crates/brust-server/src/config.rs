//! Server configuration and the shared server state. The host-agnostic types (CORS, actions,
//! invalidation, stats) live in `brust_core::config` and are re-exported here.
//!
//! [`Server`] is the 0.1.x `AppState` (`config.rs:82-300`) stripped to what the
//! v2 request path needs (no island/page/action/dev/islands_dir/css_dir/public
//! state, no runtime setters: everything is fixed at `start`), plus the
//! manifest, renderer and the two caches.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tokio::sync::Notify;

use crate::cache::job_cache::JobCache;
use crate::cache::l1::L1Cache;
use crate::dispatch::RenderDispatch;
use crate::manifest::Manifest;
use crate::pool::WorkerPool;
use crate::render::Renderer;
use crate::routing::RouteTable;
use crate::server::Tuning;
pub use crate::server::tls::TlsConfig;
pub use brust_core::cache::CacheStats;
pub use brust_core::config::{
    ACTION_INLINE_BODY_BYTES, ActionsConfig, CorsConfig, CrossSite, DEFAULT_ACTION_PREFIX,
    DEFAULT_MAX_ACTION_BODY_BYTES, DEFAULT_MAX_ACTION_RESPONSE_BYTES, InvalidateArgs,
    InvalidateResult, MAX_ACTION_BYTES, Stats,
};
use brust_core::cors::ResolvedCors;

/// Everything `start` needs. Fixed for the server's lifetime.
#[derive(Clone, Debug)]
pub struct Config {
    pub addr: SocketAddr,
    /// The build output: `manifest.json`, `jinja/`, `client/`, `public/`.
    pub dist_dir: PathBuf,
    /// Workers to wait for before accepting; `0` = serve immediately.
    pub expected_workers: u32,
    pub tuning: Tuning,
    pub l1_capacity: u64,
    pub job_cache_capacity: u64,
    pub tls: Option<TlsConfig>,
    pub cors: Option<CorsConfig>,
    /// `X-Powered-By` value; `None` = header not stamped.
    pub generator: Option<String>,
    /// M3-F: the actions subtree; `None` = no actions.
    pub actions: Option<ActionsConfig>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            addr: SocketAddr::from(([127, 0, 0, 1], 1337)),
            dist_dir: PathBuf::from("dist"),
            expected_workers: 0,
            tuning: Tuning::default(),
            l1_capacity: 1000,
            job_cache_capacity: 1000,
            tls: None,
            cors: None,
            generator: None,
            actions: None,
        }
    }
}

/// Shared server state (the stripped 0.1.x `AppState`), one per `start`.
pub struct Server {
    pub(crate) pool: Arc<WorkerPool>,
    pub(crate) routes: RouteTable,
    pub(crate) manifest: Manifest,
    /// Boot-time job-planning templates of `manifest`.
    pub(crate) plans: crate::pipeline::PlanIndex,
    pub(crate) renderer: Renderer,
    pub(crate) l1: L1Cache,
    pub(crate) jobs: JobCache,
    /// The invalidation clock `l1` and `jobs` are built on (F89): one read stamp per page.
    pub(crate) clock: Arc<crate::cache::stamp::InvalClock>,
    pub(crate) dist_dir: PathBuf,
    /// M3-P P7: striped (one cache line per stripe) — bumped on every loader page.
    pub(crate) loader_calls: crate::cache::l1::StripedCounter,
    pub(crate) job_calls: AtomicU64,
    /// M3-P P7: striped, like `loader_calls`.
    pub(crate) worker_calls: crate::cache::l1::StripedCounter,
    pub(crate) timed_out_calls: AtomicU64,
    /// (component, slot) pairs already warned about as missing from a job result.
    pub(crate) missing_slots: std::sync::Mutex<std::collections::HashSet<(String, String)>>,
    /// Worker-registration barrier: the accept loop waits on it.
    pub(crate) ready: Arc<Notify>,
    pub(crate) expected_workers: AtomicU32,
    /// Graceful-drain start signal (`request_drain` → accept loop).
    pub(crate) drain_start: Arc<Notify>,
    /// Graceful-drain completion signal (accept loop → `wait_drain_done`).
    pub(crate) drain_done: Arc<Notify>,
    pub(crate) drain_timeout_ms: AtomicU64,
    pub(crate) local_addr: OnceLock<SocketAddr>,
    pub(crate) tls: Option<TlsConfig>,
    pub(crate) cors: Option<CorsConfig>,
    /// `cors` resolved into prebuilt header values once at `start` (per server,
    /// not a process global: several servers may live in one process).
    pub(crate) cors_resolved: Option<ResolvedCors>,
    pub(crate) generator: Option<String>,
    /// M3-F: the validated actions subtree; `None` = no actions.
    pub(crate) actions: Option<ActionsConfig>,
    /// A4: `<script>globalThis.__BRUST_ACTION_PREFIX__="…"</script>`, prebuilt at `start` for a
    /// non-default prefix only.
    pub(crate) action_prefix_tag: Option<Box<str>>,
    pub(crate) claim_timeout: Duration,
    pub(crate) call_timeout: Duration,
    /// Last document length per manifest route (+ slack): the capacity of the
    /// next render's buffer (M3-P P3). A size, never bytes.
    pub(crate) render_hints: Vec<AtomicUsize>,
    /// M3-P P7 (R1): per route (manifest index), consecutive planned calls whose jobs all hit;
    /// at `pipeline::OFFER_STOP` the route stops offering the plan until a miss resets it.
    pub(crate) plan_offer: Box<[AtomicU32]>,
}

impl Server {
    /// Register a worker; once `expected_workers` have registered the accept
    /// loop starts serving.
    pub fn register_worker(&self, d: Box<dyn RenderDispatch>) -> u32 {
        let id = self.pool.register(d);
        if self.pool.registered_count() >= self.expected_workers.load(Ordering::SeqCst) as usize {
            self.ready.notify_one();
        }
        id
    }

    /// The bound address (port 0 resolves here).
    pub fn local_addr(&self) -> SocketAddr {
        *self.local_addr.get().expect("local_addr is set by start")
    }

    /// `key` → every job entry stored under that `cache({key})` value, in any
    /// component (entries are namespaced `k:<componentId>/<jobId>/<key>`, found
    /// through the job cache's user-key index); `tags` → both caches; `path` (+
    /// `method`, default `GET`) → L1 entries for that path, any query/prefix.
    /// L1 pages built from an invalidated job value are NOT evicted by `key`.
    /// A job value computed by a call that began before the invalidation is not
    /// cached, and its page is not stored in L1 (F89).
    pub fn invalidate(&self, args: InvalidateArgs) -> InvalidateResult {
        let mut r = InvalidateResult::default();
        if let Some(k) = &args.key {
            r.job_removed += self.jobs.invalidate_user_key(k);
        }
        if !args.tags.is_empty() {
            r.l1_removed += self.l1.invalidate_tags(&args.tags);
            r.job_removed += self.jobs.invalidate_tags(&args.tags);
        }
        if let Some(p) = &args.path {
            let m = args.method.as_deref().unwrap_or("GET");
            r.l1_removed += self.l1.invalidate_path(m, p);
        }
        r
    }

    /// The configured TLS settings, if any. `None` = plaintext.
    pub fn tls(&self) -> Option<&TlsConfig> {
        self.tls.as_ref()
    }

    /// The configured CORS policy, if any. `None` = disabled.
    pub fn cors(&self) -> Option<&CorsConfig> {
        self.cors.as_ref()
    }

    pub fn stats(&self) -> Stats {
        Stats {
            l1: self.l1.stats(),
            job: self.jobs.stats(),
            loader_calls: self.loader_calls.get(),
            job_calls: self.job_calls.load(Ordering::Relaxed),
            worker_calls: self.worker_calls.get(),
            timed_out_calls: self.timed_out_calls.load(Ordering::Relaxed),
            missing_slots: self.missing_slots.lock().map_or(0, |m| m.len() as u64),
        }
    }

    // ----- graceful drain (config.rs:269-300) -----

    /// Request a graceful drain with a `timeout_ms` deadline, then fire the
    /// `drain_start` signal the accept loop is parked on.
    pub fn request_drain(&self, timeout_ms: u64) {
        self.drain_timeout_ms
            .store(timeout_ms.max(1), Ordering::Relaxed);
        self.drain_start.notify_one();
    }

    /// Resolves when the accept loop reports the drain finished.
    pub async fn wait_drain_done(&self) {
        self.drain_done.notified().await;
    }

    /// The drain deadline (ms) set by the last `request_drain`.
    pub(crate) fn drain_timeout_ms(&self) -> u64 {
        self.drain_timeout_ms.load(Ordering::Relaxed)
    }

    /// Fired by the accept loop once every in-flight connection has drained (or
    /// the deadline elapsed).
    pub(crate) fn signal_drain_done(&self) {
        self.drain_done.notify_one();
    }
}
