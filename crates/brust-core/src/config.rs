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
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

use parking_lot::RwLock;
use tokio::sync::Notify;

use crate::cache::island_cache::{CacheStore, CachedIsland, MokaStore};
use crate::cache::response_cache::{CacheStats, ResponseCache};
use crate::render::pool::WorkerPool;
use crate::routing::action::ActionRouter;
use crate::routing::routes::RouteTable;

/// The pure server state. Shared as `Arc<AppState>` between the napi binding,
/// the accept loop, and every connection task.
pub struct AppState {
    /// `pub` because the binding drives the render pool directly
    /// (register / registered_count / clear / entry) from the `#[napi]` fns.
    pub pool: Arc<WorkerPool>,
    /// `pub` because the binding installs the route table
    /// (`routes.install_with_config`) and the core server reads it directly.
    pub routes: Arc<RouteTable>,
    /// `pub` because the binding resizes the response cache (`cache.resize`)
    /// and the core server reads it directly.
    pub cache: Arc<ResponseCache>,
    /// Worker-registration barrier. Crate-internal: the binding reaches it via
    /// [`AppState::ready_notify`]; the core server awaits it directly.
    pub(crate) ready: Arc<Notify>,
    /// Process-shutdown park. Crate-internal: the binding parks on it via
    /// [`AppState::wait_shutdown`].
    pub(crate) shutdown: Arc<Notify>,
    /// Typed as the trait object, not concrete MokaStore, so a future RedisStore
    /// backend swaps in here with zero changes to the call sites. Crate-internal:
    /// the binding goes through the `island_cache_*` passthrough methods.
    pub(crate) island_cache: Arc<dyn CacheStore>,
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
            routes: Arc::new(RouteTable::new()),
            cache: Arc::new(ResponseCache::new()),
            island_cache: Arc::new(MokaStore::new(1000)) as Arc<dyn CacheStore>,
            is_serving: AtomicBool::new(false),
            dev_mode: AtomicBool::new(false),
            expected_workers: AtomicU32::new(0),
            islands_dir: RwLock::new(None),
            css_dir: RwLock::new(None),
            public_assets: RwLock::new(HashMap::new()),
            action_router: RwLock::new(ActionRouter::new()),
            action_prefix: RwLock::new("/_brust/action".to_string()),
        }
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

    // ----- response cache -----

    pub fn cache_stats(&self) -> CacheStats {
        self.cache.stats()
    }
}
