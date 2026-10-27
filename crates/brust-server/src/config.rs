//! Server configuration and the shared server state. The host-agnostic types (CORS, actions,
//! invalidation, stats) live in `brust_core::config` and are re-exported here.
//!
//! [`Server`] is the 0.1.x `AppState` (`config.rs:82-300`) stripped to what the
//! v2 request path needs (no island/page/action/dev/islands_dir/css_dir/public
//! state, no runtime setters: everything is fixed at `start`), plus the
//! manifest, renderer and the two caches.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use tokio::sync::Notify;

use crate::dispatch::RenderDispatch;
use crate::host::NativeHost;
use crate::server::Tuning;
pub use crate::server::tls::TlsConfig;
pub use brust_core::cache::CacheStats;
pub use brust_core::config::{
    ACTION_INLINE_BODY_BYTES, ActionCredentials, ActionsClient, ActionsConfig, CorsConfig,
    CrossSite, DEFAULT_ACTION_PREFIX, DEFAULT_MAX_ACTION_BODY_BYTES,
    DEFAULT_MAX_ACTION_RESPONSE_BYTES, InvalidateArgs, InvalidateResult, MAX_ACTION_BYTES, Stats,
    StreamConfig, StreamRoute,
};
use brust_core::core::Core;

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
    /// L16: base URL / credentials / prefix the page tells the browser client; `None` = from `actions` alone.
    pub actions_client: Option<ActionsClient>,
    /// The cache adapter (shared second tier); `None` = none.
    pub l2: Option<brust_core::l2::L2Config>,
    /// `brust dev` only (L14): requests carrying this token get a trace header and the pages get DOM markers.
    pub dev_token: Option<String>,
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
            actions_client: None,
            l2: None,
            dev_token: None,
        }
    }
}

/// Shared server state (the stripped 0.1.x `AppState`), one per `start`: the host-agnostic
/// [`Core`] over the native host, plus the accept loop's signals.
pub struct Server {
    pub(crate) core: Core<NativeHost>,
    /// Worker-registration barrier: the accept loop waits on it.
    pub(crate) ready: Arc<Notify>,
    pub(crate) expected_workers: AtomicU32,
    /// Graceful-drain start signal (`request_drain` → accept loop).
    pub(crate) drain_start: Arc<Notify>,
    /// Graceful-drain completion signal (accept loop → `wait_drain_done`).
    pub(crate) drain_done: Arc<Notify>,
    pub(crate) drain_timeout_ms: AtomicU64,
    pub(crate) local_addr: OnceLock<SocketAddr>,
    /// Set once the `[brust] listening on` line is printed and flushed (the accept loop starts right after).
    pub(crate) announced: AtomicBool,
    pub(crate) tls: Option<TlsConfig>,
}

impl Server {
    /// Register a worker; once `expected_workers` have registered the accept
    /// loop starts serving.
    pub fn register_worker(&self, d: Box<dyn RenderDispatch>) -> u32 {
        let pool = &self.core.host.pool;
        let id = pool.register(d);
        if pool.registered_count() >= self.expected_workers.load(Ordering::SeqCst) as usize {
            self.ready.notify_one();
        }
        id
    }

    /// True once the `[brust] listening on` line is out. The server thread prints it after the workers registered, so a caller
    /// that wakes on the same registrations (`untilReady`) must wait for this before printing its own `ready` (F128).
    pub fn announced(&self) -> bool {
        self.announced.load(Ordering::SeqCst)
    }

    /// The bound address (port 0 resolves here).
    pub fn local_addr(&self) -> SocketAddr {
        *self.local_addr.get().expect("local_addr is set by start")
    }

    /// See [`Core::invalidate`].
    pub fn invalidate(&self, args: InvalidateArgs) -> InvalidateResult {
        self.core.invalidate(args)
    }

    /// See [`Core::l2_replay`]: a broadcast invalidation from another process (never re-published).
    pub fn l2_replay(&self, args: InvalidateArgs, seq: Option<u64>) -> InvalidateResult {
        self.core.l2_replay(args, seq)
    }

    /// See [`Core::l2_count`].
    pub fn l2_count(&self, name: &str) -> bool {
        self.core.l2_count(name)
    }

    /// See [`Core::clear_local`]: both tier-1 caches dropped (a broadcast gap). The L1 count.
    pub fn cache_clear(&self) -> usize {
        self.core.clear_local()
    }

    /// The configured TLS settings, if any. `None` = plaintext.
    pub fn tls(&self) -> Option<&TlsConfig> {
        self.tls.as_ref()
    }

    /// The configured CORS policy, if any. `None` = disabled.
    pub fn cors(&self) -> Option<&CorsConfig> {
        self.core.cors()
    }

    pub fn stats(&self) -> Stats {
        self.core.stats()
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
