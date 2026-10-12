//! Server configuration and the shared server state.
//!
//! `CorsConfig` is verbatim from brust-core `config.rs:27-78` @ d04718f.
//! [`Server`] is the 0.1.x `AppState` (`config.rs:82-300`) stripped to what the
//! v2 request path needs (no island/page/action/dev/islands_dir/css_dir/public
//! state, no runtime setters: everything is fixed at `start`), plus the
//! manifest, renderer and the two caches.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

use crate::cache::job_cache::JobCache;
pub use crate::cache::l1::CacheStats;
use crate::cache::l1::L1Cache;
use crate::dispatch::RenderDispatch;
use crate::manifest::Manifest;
use crate::pool::WorkerPool;
use crate::render::Renderer;
use crate::routing::RouteTable;
use crate::server::Tuning;
use crate::server::cors::ResolvedCors;
pub use crate::server::tls::TlsConfig;

/// Global CORS policy, set once at boot (via `ServeOptions.cors` in the napi
/// binding). `None` (the default) = CORS disabled, byte-identical behavior.
///
/// Origin matching is an exact string match (scheme+host+port) against
/// `origins`; a list CONTAINING `"*"` is treated as wildcard (every origin
/// allowed, `Access-Control-Allow-Origin: *`), so `["*", "https://x.com"]`
/// cannot dodge the credentials+wildcard validation. No wildcard-subdomain
/// matching in v1.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CorsConfig {
    /// Allowed origins. `["*"]` (or any list containing `"*"`) = any origin.
    pub origins: Vec<String>,
    /// Preflight `Access-Control-Allow-Methods`. `None` → default
    /// `GET,POST,PUT,PATCH,DELETE,OPTIONS`.
    pub methods: Option<Vec<String>>,
    /// Preflight `Access-Control-Allow-Headers`. `None` → echo the request's
    /// `Access-Control-Request-Headers`.
    pub headers: Option<Vec<String>>,
    /// `Access-Control-Expose-Headers` on actual responses. `None` → none.
    pub expose_headers: Option<Vec<String>>,
    /// Emit `Access-Control-Allow-Credentials: true`. INVALID with a wildcard
    /// origin — [`CorsConfig::validate`] rejects the combination at boot.
    pub credentials: bool,
    /// Preflight `Access-Control-Max-Age` seconds. `None` → 600.
    pub max_age_seconds: Option<u32>,
}

impl CorsConfig {
    /// True when the configured origin list contains the literal `"*"`.
    pub fn is_wildcard(&self) -> bool {
        self.origins.iter().any(|o| o == "*")
    }

    /// Boot-time validation (the napi binding mirrors this on the TS side):
    /// `origins` must be non-empty, and `credentials` may not be combined with
    /// a wildcard origin (browsers silently reject that combination — make it
    /// loud at boot instead).
    pub fn validate(&self) -> Result<(), String> {
        if self.origins.is_empty() {
            return Err("cors.origins must be non-empty".to_string());
        }
        if self.credentials && self.is_wildcard() {
            return Err(
                "cors.credentials cannot be combined with a wildcard origin '*' \
                 (browsers reject Access-Control-Allow-Origin: * with credentials); \
                 list explicit origins instead"
                    .to_string(),
            );
        }
        Ok(())
    }
}

/// 0.1.x defaults (E1).
pub const DEFAULT_ACTION_PREFIX: &str = "/_brust/action";
pub const DEFAULT_MAX_ACTION_BODY_BYTES: usize = 262_144;
/// Paths the actions prefix may not overlap in either direction (R7).
const RESERVED: &[&str] = &["/ping", "/public", "/_brust/client", "/_brust/cache"];

/// M3-F E1/E3: the actions subtree. `None` in [`Config`] = no actions (byte-identical server).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionsConfig {
    pub prefix: String,
    pub max_body_bytes: usize,
}

impl Default for ActionsConfig {
    fn default() -> Self {
        Self {
            prefix: DEFAULT_ACTION_PREFIX.into(),
            max_body_bytes: DEFAULT_MAX_ACTION_BODY_BYTES,
        }
    }
}

/// 0.1.x `path_under_action_prefix` (brust-core config.rs:358-363): `path` is `p` or lies under it.
pub(crate) fn under(path: &str, p: &str) -> bool {
    path == p || (path.len() > p.len() && path.as_bytes()[p.len()] == b'/' && path.starts_with(p))
}

impl ActionsConfig {
    pub fn is_under(&self, path: &str) -> bool {
        under(path, &self.prefix)
    }

    pub fn is_default_prefix(&self) -> bool {
        self.prefix == DEFAULT_ACTION_PREFIX
    }

    /// R7; `start` prefixes the message with `actions: `.
    pub fn validate(&self, m: &Manifest) -> Result<(), String> {
        let p = self.prefix.as_str();
        let seg_ok = |s: &str| {
            !s.is_empty()
                && s != "."
                && s != ".."
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'-'))
        };
        if !p.starts_with('/') || p.len() < 2 || p.ends_with('/') || !p[1..].split('/').all(seg_ok)
        {
            return Err(format!(
                "prefix must start with '/', must not end with '/', and each segment must be \
                 [A-Za-z0-9._~-] (not '.' or '..'): {p:?}"
            ));
        }
        if let Some(r) = RESERVED.iter().find(|r| under(p, r) || under(r, p)) {
            return Err(format!("prefix {p:?} overlaps the reserved path {r:?}"));
        }
        if let Some(rt) = m.routes.iter().find(|rt| {
            let head = rt.pattern.split('{').next().unwrap_or("");
            under(head.trim_end_matches('/'), p) || under(head, p)
        }) {
            return Err(format!("prefix {p:?} shadows route {:?}", rt.pattern));
        }
        if self.max_body_bytes == 0 {
            return Err("maxBodyBytes must be at least 1".into());
        }
        Ok(())
    }
}

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

/// `cache.invalidate({ key?, tags?, path?, method? })` (spec §5).
#[derive(Debug, Default, Deserialize)]
pub struct InvalidateArgs {
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub method: Option<String>,
}

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
pub struct InvalidateResult {
    pub l1_removed: usize,
    pub job_removed: usize,
}

/// `/_brust/cache/stats` (spec §7).
#[derive(Debug, Serialize)]
pub struct Stats {
    pub l1: CacheStats,
    pub job: CacheStats,
    pub loader_calls: u64,
    /// Job batches the worker ran: a `jobs` call, or the misses of a planned loader call (M3-P P6).
    pub job_calls: u64,
    /// Worker round trips (M3-P P6): the sum of every request's `bun_calls`.
    pub worker_calls: u64,
    /// Worker calls answered 504 by the call deadline.
    pub timed_out_calls: u64,
    /// Distinct (component, slot) pairs whose job result lacked a declared output (an older
    /// `dist/jobs.js`); the slot renders empty and is warned once.
    pub missing_slots: u64,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_manifest() -> Manifest {
        let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/dist");
        Manifest::load(&dist).expect("fixture manifest").manifest
    }

    fn with_prefix(p: &str) -> ActionsConfig {
        ActionsConfig {
            prefix: p.into(),
            ..Default::default()
        }
    }

    /// 0.1.x brust `lib.rs:645-655`, extended.
    #[test]
    fn prefix_match_is_segment_safe() {
        let a = ActionsConfig::default();
        for p in [
            "/_brust/action",
            "/_brust/action/notes",
            "/_brust/action/notes/5",
        ] {
            assert!(a.is_under(p), "{p} should be under the prefix");
        }
        for p in [
            "/_brust/actionXYZ",
            "/_brust/act",
            "/other",
            "/_brust/action2/x",
        ] {
            assert!(!a.is_under(p), "{p} should not be under the prefix");
        }
    }

    #[test]
    fn actions_validation_table() {
        let m = fixture_manifest();
        for p in ["/_brust/action", "/api", "/api/v1", "/a.b~c-d_e"] {
            assert_eq!(with_prefix(p).validate(&m), Ok(()), "{p:?}");
        }
        for p in [
            "", "api", "/", "/api/", "/a//b", "/a/./b", "/a/../b", "/a b", "/a?x", "/a%2Fb",
        ] {
            let e = with_prefix(p).validate(&m).expect_err(p);
            assert!(e.contains(&format!("{p:?}")), "{p:?}: {e}");
        }
        for p in [
            "/ping",
            "/public",
            "/public/x",
            "/_brust",
            "/_brust/client",
            "/_brust/client/x",
            "/_brust/cache",
            "/_brust/cache/stats",
        ] {
            let e = with_prefix(p).validate(&m).expect_err(p);
            assert!(e.contains("reserved"), "{p:?}: {e}");
        }
        let zero = ActionsConfig {
            max_body_bytes: 0,
            ..Default::default()
        };
        assert!(zero.validate(&m).is_err());
    }

    #[test]
    fn actions_prefix_may_not_shadow_a_route() {
        let m = fixture_manifest();
        let e = with_prefix("/pokemon").validate(&m).unwrap_err();
        assert!(e.contains(r#"shadows route "/pokemon/{name}""#), "{e}");
        assert_eq!(with_prefix("/poke").validate(&m), Ok(()));
    }
}
