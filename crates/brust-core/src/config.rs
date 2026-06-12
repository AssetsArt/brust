//! Pure application state for the core HTTP server.
//!
//! `AppState` holds every piece of server state that is NOT napi-shaped: the
//! route table, response/island caches, the render pool, configured asset dirs,
//! the action router + prefix, dev-mode flag, and the lifecycle Notify handles.
//! The `brust` napi binding owns the process-wide `OnceCell<Arc<AppState>>`,
//! constructs it, drives the napi `#[napi]` functions through the methods below,
//! and passes the `Arc<AppState>` into [`crate::server::start`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::time::Duration;

use parking_lot::RwLock;
use tokio::sync::Notify;

use crate::cache::island_cache::{CacheStore, CachedIsland, MokaStore};
use crate::cache::page_cache::PageCache;
use crate::cache::response_cache::{CacheStats, ResponseCache};
use crate::render::pool::WorkerPool;
use crate::routing::action::ActionRouter;
use crate::routing::routes::RouteTable;
use crate::server::tls::TlsConfig;

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

/// The pure server state. Shared as `Arc<AppState>` between the napi binding,
/// the accept loop, and every connection task.
pub struct AppState {
    /// `pub` because the binding drives the render pool directly
    /// (register / registered_count / clear / entry) from the `#[napi]` fns.
    pub pool: Arc<WorkerPool>,
    /// `pub` because the binding installs the route table
    /// (`routes.install_with_config`) and the core server reads it directly.
    pub routes: Arc<RouteTable>,
    /// `pub` because the core server snapshots the live Arc per-request
    /// (`state.cache.read()`). Wrapped in an RwLock so `reconfigure_caches`
    /// can swap in a fresh cache built at the operator-configured capacity
    /// (moka fixes capacity at construction; this runs once at boot before
    /// serving, so swapping an empty cache is safe).
    pub cache: RwLock<Arc<ResponseCache>>,
    /// Worker-registration barrier. Crate-internal: the binding reaches it via
    /// [`AppState::ready_notify`]; the core server awaits it directly.
    pub(crate) ready: Arc<Notify>,
    /// Process-shutdown park. Crate-internal: the binding parks on it via
    /// [`AppState::wait_shutdown`].
    pub(crate) shutdown: Arc<Notify>,
    /// Graceful-drain start signal (JS SIGINT handler → accept loop). When fired,
    /// the accept loop stops taking new connections and `graceful_shutdown()`s the
    /// in-flight ones (finish the current request, then close).
    pub(crate) drain_start: Arc<Notify>,
    /// Graceful-drain completion signal (accept loop → the `begin_drain` Promise).
    /// Fires once all in-flight connections have drained or the timeout elapsed.
    pub(crate) drain_done: Arc<Notify>,
    /// Drain deadline in ms, set by `begin_drain` before it fires `drain_start`.
    pub(crate) drain_timeout_ms: AtomicU64,
    /// Typed as the trait object, not concrete MokaStore, so a future RedisStore
    /// backend swaps in here with zero changes to the call sites. Crate-internal:
    /// the binding goes through the `island_cache_*` passthrough methods.
    pub(crate) island_cache: Arc<dyn CacheStore>,
    /// L2 page cache (two-layer page cache): string-keyed framed-payload store
    /// with tag invalidation. Process-global, shared across worker isolates.
    /// Crate-internal: the binding goes through the `page_cache_*` methods.
    /// Wrapped like `cache` so `reconfigure_caches` can swap in a fresh cache
    /// at the operator-configured capacity (moka fixes capacity at construction).
    pub(crate) page_cache: RwLock<Arc<PageCache>>,
    /// Crate-internal: the binding flips this via [`AppState::begin_serve`].
    pub(crate) is_serving: AtomicBool,
    /// Dev mode (set by `configure_dev_mode` from the TS dev coordinator). When
    /// true, static assets (`/_brust/islands/*`, `/_brust/css/*`) are served
    /// `Cache-Control: no-store` so an island/CSS rebuild on hot reload is never
    /// masked by the browser cache (chunk URLs are unhashed, so a stale cached
    /// copy would otherwise survive a reload). Off in production → cacheable.
    /// Crate-internal: driven via `set_dev_mode` / `is_dev_mode`.
    pub(crate) dev_mode: AtomicBool,
    /// Crate-internal: driven via `set_expected_workers` / `expected_workers`.
    pub(crate) expected_workers: AtomicU32,
    pub(crate) islands_dir: RwLock<Option<PathBuf>>,
    pub(crate) css_dir: RwLock<Option<PathBuf>>,
    /// URL path (`/favicon.ico`) → canonical absolute file path under public/.
    /// Built once at boot by the binding's `configure_public_dir`; replaced wholesale.
    pub(crate) public_assets: RwLock<HashMap<String, PathBuf>>,
    pub(crate) action_router: RwLock<ActionRouter>,
    pub(crate) action_prefix: RwLock<String>,
    /// `X-Powered-By` value (e.g. `brust/0.1.48-alpha`). None → header not
    /// stamped (embedders not using the TS runtime). Set once at begin_serve.
    pub(crate) generator: RwLock<Option<String>>,
    /// Optional in-process TLS termination config (cert + key paths). `None` =
    /// plaintext (the default, unchanged behavior). Set ONCE at boot by the
    /// binding via [`AppState::set_tls`] before `begin_serve`; the accept loop
    /// reads it via [`AppState::tls`].
    pub(crate) tls: RwLock<Option<TlsConfig>>,
    /// Optional global CORS policy. `None` = CORS disabled (the default,
    /// byte-identical behavior). Set ONCE at boot by the binding via
    /// [`AppState::set_cors`] before `begin_serve`; `server::start` resolves it
    /// into prebuilt header values before the accept loop (mirror of `tls`).
    pub(crate) cors: RwLock<Option<CorsConfig>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    /// Construct a fresh state with framework defaults (empty routes/caches, a
    /// 1000-entry island cache, default `/_brust/action` prefix).
    pub fn new() -> Self {
        AppState {
            pool: Arc::new(WorkerPool::new()),
            ready: Arc::new(Notify::new()),
            shutdown: Arc::new(Notify::new()),
            drain_start: Arc::new(Notify::new()),
            drain_done: Arc::new(Notify::new()),
            drain_timeout_ms: AtomicU64::new(10_000),
            routes: Arc::new(RouteTable::new()),
            cache: RwLock::new(Arc::new(ResponseCache::new())),
            island_cache: Arc::new(MokaStore::new(1000)) as Arc<dyn CacheStore>,
            // L1/L2 cache capacities default to 1000 and are operator-tunable via
            // `brust.toml [cache] max_entries` / `page_max_entries`, applied at boot
            // by `reconfigure_caches` (moka fixes capacity at construction).
            page_cache: RwLock::new(Arc::new(PageCache::new(1000))),
            is_serving: AtomicBool::new(false),
            dev_mode: AtomicBool::new(false),
            expected_workers: AtomicU32::new(0),
            islands_dir: RwLock::new(None),
            css_dir: RwLock::new(None),
            public_assets: RwLock::new(HashMap::new()),
            action_router: RwLock::new(ActionRouter::new()),
            action_prefix: RwLock::new("/_brust/action".to_string()),
            generator: RwLock::new(None),
            tls: RwLock::new(None),
            cors: RwLock::new(None),
        }
    }

    // ----- TLS -----

    /// Configure in-process TLS termination. Pass `None` to keep plaintext.
    /// Set once at boot before `begin_serve`.
    pub fn set_tls(&self, cfg: Option<TlsConfig>) {
        *self.tls.write() = cfg;
    }

    /// The configured TLS settings, if any. `None` = plaintext.
    /// Boot-only: called once before the accept loop. Clones the (tiny) config; do not call per-connection.
    pub fn tls(&self) -> Option<TlsConfig> {
        self.tls.read().clone()
    }

    // ----- CORS -----

    /// Configure the global CORS policy. Pass `None` to keep CORS disabled.
    /// Set once at boot before `begin_serve` (mirror of [`AppState::set_tls`]).
    pub fn set_cors(&self, cfg: Option<CorsConfig>) {
        *self.cors.write() = cfg;
    }

    /// The configured CORS policy, if any. `None` = disabled. Boot-only: called
    /// once by `server::start` before the accept loop (clones the tiny config);
    /// do not call per-request.
    pub fn cors(&self) -> Option<CorsConfig> {
        self.cors.read().clone()
    }

    // ----- dev mode -----

    /// Whether dev mode is active.
    #[inline]
    pub fn is_dev_mode(&self) -> bool {
        self.dev_mode.load(Ordering::Relaxed)
    }

    /// Enable/disable dev mode (flips static-asset caching to `no-store`).
    pub fn set_dev_mode(&self, enabled: bool) {
        self.dev_mode.store(enabled, Ordering::Relaxed);
    }

    // ----- serve lifecycle -----

    /// Atomically transition into the serving state. Returns `true` if a serve
    /// was ALREADY running (caller should reject the duplicate `begin_serve`),
    /// `false` if this call won the transition.
    pub fn begin_serve(&self) -> bool {
        self.is_serving.swap(true, Ordering::SeqCst)
    }

    /// Record the worker count the serve is waiting on before it reports ready.
    pub fn set_expected_workers(&self, n: u32) {
        self.expected_workers.store(n, Ordering::SeqCst);
    }

    /// The worker count the serve is waiting on (see `set_expected_workers`).
    pub fn expected_workers(&self) -> u32 {
        self.expected_workers.load(Ordering::SeqCst)
    }

    /// The worker-registration barrier. The binding clones this to signal
    /// readiness once every napi worker has registered.
    pub fn ready_notify(&self) -> &Arc<Notify> {
        &self.ready
    }

    /// Park until the process-shutdown signal fires. Under Bun, the TS layer
    /// owns process exit, so this future stays parked for the process lifetime.
    pub async fn wait_shutdown(&self) {
        self.shutdown.notified().await;
    }

    // ----- graceful drain -----

    /// Request a graceful drain with a `timeout_ms` deadline, then fire the
    /// `drain_start` signal the accept loop is parked on. Called by the napi
    /// `begin_drain` before it awaits [`AppState::wait_drain_done`].
    pub fn request_drain(&self, timeout_ms: u64) {
        self.drain_timeout_ms
            .store(timeout_ms.max(1), Ordering::Relaxed);
        self.drain_start.notify_one();
    }

    /// The drain deadline (ms) set by the last `request_drain`.
    pub fn drain_timeout_ms(&self) -> u64 {
        self.drain_timeout_ms.load(Ordering::Relaxed)
    }

    /// Accept loop awaits this to learn a drain was requested. Registered BEFORE
    /// the loop's `select!` so a `request_drain` that races the first poll isn't
    /// lost (the Notify stores one permit).
    pub fn drain_start_notify(&self) -> &Arc<Notify> {
        &self.drain_start
    }

    /// Fired by the accept loop once every in-flight connection has drained (or
    /// the deadline elapsed). Wakes the `begin_drain` Promise.
    pub fn signal_drain_done(&self) {
        self.drain_done.notify_one();
    }

    /// The napi `begin_drain` awaits this; resolves when the accept loop reports
    /// the drain finished.
    pub async fn wait_drain_done(&self) {
        self.drain_done.notified().await;
    }

    // ----- configured dirs -----

    pub fn set_islands_dir(&self, dir: Option<PathBuf>) {
        *self.islands_dir.write() = dir;
    }

    pub fn islands_dir(&self) -> Option<PathBuf> {
        self.islands_dir.read().clone()
    }

    pub fn set_css_dir(&self, dir: Option<PathBuf>) {
        *self.css_dir.write() = dir;
    }

    pub fn css_dir(&self) -> Option<PathBuf> {
        self.css_dir.read().clone()
    }

    pub fn set_public_assets(&self, manifest: HashMap<String, PathBuf>) {
        *self.public_assets.write() = manifest;
    }

    pub fn public_asset(&self, url_path: &str) -> Option<PathBuf> {
        self.public_assets.read().get(url_path).cloned()
    }

    // ----- action router / prefix -----

    /// Replace the action router wholesale.
    pub fn set_action_router(&self, router: ActionRouter) {
        *self.action_router.write() = router;
    }

    pub fn with_action_router<R>(&self, f: impl FnOnce(&ActionRouter) -> R) -> R {
        f(&self.action_router.read())
    }

    /// Replace the configured action prefix.
    pub fn set_action_prefix(&self, prefix: String) {
        *self.action_prefix.write() = prefix;
    }

    /// Run `f` with the configured action prefix borrowed — no clone.
    pub fn with_action_prefix<R>(&self, f: impl FnOnce(&str) -> R) -> R {
        f(&self.action_prefix.read())
    }

    /// Set the `X-Powered-By` value, stamped on every response. Set once at boot.
    pub fn set_generator(&self, value: String) {
        *self.generator.write() = Some(value);
    }

    /// The configured `X-Powered-By` value, if any. `None` = header not stamped.
    pub fn generator(&self) -> Option<String> {
        self.generator.read().clone()
    }

    /// True if `path` (caller MUST have stripped the query string already) is the
    /// action prefix itself or a path under it. Allocation-free.
    pub fn path_under_action_prefix(&self, path: &str) -> bool {
        let p = self.action_prefix.read();
        let p = p.as_str();
        path == p
            || (path.len() > p.len() && path.as_bytes()[p.len()] == b'/' && path.starts_with(p))
    }

    // ----- island cache passthrough -----

    pub fn island_cache_get(&self, key: &str) -> Option<CachedIsland> {
        self.island_cache.get(key)
    }

    pub fn island_cache_set(
        &self,
        key: &str,
        tags: &[String],
        ttl: Option<Duration>,
        html: String,
        props: String,
    ) {
        self.island_cache.set(key, tags, ttl, html, props);
    }

    pub fn island_cache_invalidate_key(&self, key: &str) {
        self.island_cache.invalidate_key(key);
    }

    pub fn island_cache_invalidate_tags(&self, tags: &[String]) {
        self.island_cache.invalidate_tags(tags);
    }

    pub fn island_cache_clear(&self) {
        self.island_cache.clear();
    }

    // ----- response cache (L1) invalidation passthrough -----

    pub fn response_cache_invalidate_tags(&self, tags: &[String]) {
        let c = self.cache.read().clone();
        c.invalidate_tags(tags);
    }

    pub fn response_cache_invalidate_path(&self, method: &str, path: &str) {
        let c = self.cache.read().clone();
        c.invalidate_path(method, path);
    }

    // ----- page cache (L2) passthrough -----

    pub fn page_cache_get(&self, key: &str) -> Option<Vec<u8>> {
        let pc = self.page_cache.read().clone();
        pc.get(key)
    }

    pub fn page_cache_set(
        &self,
        key: &str,
        tags: &[String],
        ttl: Option<Duration>,
        payload: Vec<u8>,
    ) {
        let pc = self.page_cache.read().clone();
        pc.set(key, tags, ttl, payload);
    }

    pub fn page_cache_invalidate_key(&self, key: &str) {
        let pc = self.page_cache.read().clone();
        pc.invalidate_key(key);
    }

    pub fn page_cache_invalidate_tags(&self, tags: &[String]) {
        let pc = self.page_cache.read().clone();
        pc.invalidate_tags(tags);
    }

    pub fn page_cache_clear(&self) {
        let pc = self.page_cache.read().clone();
        pc.clear();
    }

    // ----- response cache -----

    pub fn cache_stats(&self) -> CacheStats {
        self.cache.read().stats()
    }

    /// Rebuild both caches at the operator-configured capacities and swap them
    /// in. moka fixes capacity at construction, so the only way to honor the
    /// `brust.toml [cache]` knobs is to reconstruct. Called once at boot (via the
    /// napi `configure_cache`) before serving begins, so swapping an empty cache
    /// is safe.
    pub fn reconfigure_caches(&self, response_max: u64, page_max: u64) {
        *self.cache.write() = Arc::new(ResponseCache::with_capacity(response_max));
        *self.page_cache.write() = Arc::new(PageCache::new(page_max));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generator_default_none_set_get() {
        let s = AppState::new();
        assert_eq!(s.generator(), None);
        s.set_generator("brust/1.2.3".to_string());
        assert_eq!(s.generator(), Some("brust/1.2.3".to_string()));
    }

    fn cors_cfg(origins: &[&str], credentials: bool) -> CorsConfig {
        CorsConfig {
            origins: origins.iter().map(|s| s.to_string()).collect(),
            methods: None,
            headers: None,
            expose_headers: None,
            credentials,
            max_age_seconds: None,
        }
    }

    #[test]
    fn cors_default_none_set_get() {
        let s = AppState::new();
        assert_eq!(s.cors(), None);
        let cfg = cors_cfg(&["https://a.example"], false);
        s.set_cors(Some(cfg.clone()));
        assert_eq!(s.cors(), Some(cfg));
        s.set_cors(None);
        assert_eq!(s.cors(), None);
    }

    #[test]
    fn cors_validate_rejects_empty_origins() {
        let err = cors_cfg(&[], false).validate().unwrap_err();
        assert!(err.contains("non-empty"), "unexpected error: {err}");
    }

    #[test]
    fn cors_validate_rejects_credentials_with_wildcard() {
        let err = cors_cfg(&["*"], true).validate().unwrap_err();
        assert!(err.contains("wildcard"), "unexpected error: {err}");
    }

    #[test]
    fn cors_validate_rejects_credentials_with_wildcard_in_mixed_list() {
        // A list CONTAINING '*' is wildcard — `['*', 'https://x.com']` cannot
        // dodge the credentials check.
        let err = cors_cfg(&["https://x.com", "*"], true)
            .validate()
            .unwrap_err();
        assert!(err.contains("wildcard"), "unexpected error: {err}");
    }

    #[test]
    fn cors_validate_accepts_explicit_origins_with_credentials_and_bare_wildcard() {
        assert!(cors_cfg(&["https://a.example"], true).validate().is_ok());
        assert!(cors_cfg(&["*"], false).validate().is_ok());
    }
}
