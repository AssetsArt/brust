#![deny(clippy::all)]

mod dispatch_impl;
mod jsx_compile;

use std::cell::Cell;
use std::net::{SocketAddr, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;

use napi::Result as NapiResult;
use napi::bindgen_prelude::{BigInt, Buffer, Function, Promise, Uint8Array};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi_derive::napi;
use once_cell::sync::OnceCell;
use tracing::error;
use tracing_subscriber::EnvFilter;

use brust_core::AppState;
use brust_core::routing::action::{ActionRouter, Method};

use crate::dispatch_impl::{BufPtr, RendererTsfn, TsfnDispatch};

thread_local! {
    static WORKER_ID: Cell<Option<u32>> = const { Cell::new(None) };
}

static STATE: OnceCell<Arc<AppState>> = OnceCell::new();

/// The process-wide pure [`AppState`], owned by the napi binding. Initialized on
/// first use (also installs the tracing subscriber). Every `#[napi]` fn drives
/// the core through this handle.
pub(crate) fn state() -> &'static Arc<AppState> {
    STATE.get_or_init(|| {
        let _ = tracing_subscriber::fmt()
            .with_env_filter(
                EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("brust=info")),
            )
            .with_target(false)
            .with_writer(std::io::stderr)
            .try_init();
        Arc::new(AppState::new())
    })
}

#[napi(object)]
pub struct ServeOptions {
    /// Host to bind on — a hostname (e.g. `localhost`, resolved here) or a
    /// literal IP such as `0.0.0.0` / `127.0.0.1`.
    pub host: String,
    pub port: u16,
    pub workers: u32,
    pub entry: String,
    /// Optional performance tunables. Omit to keep framework defaults.
    pub tuning: Option<ServeTuning>,
    /// Optional action prefix override. Defaults to `/_brust/action`.
    pub action_prefix: Option<String>,
    /// `X-Powered-By` header value (e.g. `brust/0.1.48-alpha`). Single-line
    /// ASCII; omit to skip the header. The TS runtime always passes it (name
    /// mandatory, version per the build's generator.json).
    pub generator: Option<String>,
    /// Optional in-process TLS: PEM certificate (chain) path. When BOTH this and
    /// `tls_key_path` are present, the server terminates TLS itself (ALPN
    /// h2+http/1.1). Omit either to serve plaintext (unchanged default).
    pub tls_cert_path: Option<String>,
    /// Optional in-process TLS: PEM private-key path. See `tls_cert_path`.
    pub tls_key_path: Option<String>,
    /// Optional minimum TLS version: `"1.2"` (default, = rustls TLS 1.2 + 1.3
    /// safe defaults) or `"1.3"` (TLS 1.3 only, for hardened/compliance
    /// deployments). Case-insensitive, trimmed. Only meaningful when TLS is
    /// configured (cert + key present). An unrecognized value is rejected.
    pub tls_min_version: Option<String>,
}

/// Runtime-tunable server limits, all optional. Maps onto `server::Tuning`
/// (which holds the defaults). `conn_workers` is the only one NOT in
/// `server::Tuning` — it's the Rust connection-handling concurrency passed to
/// `server::start`, independent of `workers` (the Bun render-thread count).
#[napi(object)]
pub struct ServeTuning {
    /// Rust-side accept→parse→dispatch task concurrency. Independent of
    /// `workers` (Bun render threads). Default = `workers`.
    pub conn_workers: Option<u32>,
    /// Cap on request bytes before the header terminator. Default 16384.
    pub max_request_bytes: Option<u32>,
    /// Cap on action/RPC body size (mirror the SAB capacity). Default 262144.
    pub max_action_body_bytes: Option<u32>,
    /// Accept-side queue depth (TCP backpressure point). Default 1024.
    pub conn_queue_cap: Option<u32>,
    /// Initial per-connection read buffer capacity. Default 4096.
    pub read_buf_cap: Option<u32>,
    /// Max ms a render dispatch waits for a free worker before 503 (AllBusy is
    /// queued, not failed-fast). Lets `connWorkers > workers` avoid 503 storms.
    /// Default 10000.
    pub claim_timeout_ms: Option<u32>,
    /// tokio I/O runtime worker-thread count for the hyper server. Runs inside
    /// Bun (which has its own threads + render workers), so this is NOT
    /// one-per-core. Default `min(available_parallelism, 4)` (fallback 2).
    pub worker_threads: Option<u32>,
    /// Number of render slots per Bun worker (concurrent in-flight renders per
    /// isolate). Default `min(cores, 16)` (set `BRUST_RENDER_SLOTS` to exceed 16
    /// cores); slots > 1 only speed renders that await during render and are
    /// byte-identical to slots = 1. The COUNT reaches `register_renderer`
    /// via the `BRUST_RENDER_SLOTS` worker env var set in `runtime/index.ts`; it
    /// is NOT consumed by the Rust `Tuning` struct here (the pool learns it from
    /// `dispatch.slot_count()`). Carried on `ServeTuning` only so the JS layer
    /// has one tunable surface.
    pub render_slots: Option<u32>,
}

/// Resolve `host:port` to a bindable SocketAddr. Accepts literal IPs and
/// hostnames (via the system resolver). When a name resolves to both IPv4 and
/// IPv6 (e.g. `localhost` → 127.0.0.1 + ::1), prefer IPv4 to match the
/// historical 127.0.0.1 bind and avoid binding only `::1`.
fn resolve_bind_addr(host: &str, port: u16) -> NapiResult<SocketAddr> {
    let addrs: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|e| {
            napi::Error::from_reason(format!("cannot resolve bind address {host}:{port}: {e}"))
        })?
        .collect();
    addrs
        .iter()
        .copied()
        .find(SocketAddr::is_ipv4)
        .or_else(|| addrs.first().copied())
        .ok_or_else(|| napi::Error::from_reason(format!("no address resolved for {host}:{port}")))
}

#[napi]
pub fn begin_serve(opts: ServeOptions) -> NapiResult<()> {
    let s = state();
    if s.begin_serve() {
        return Err(napi::Error::from_reason("serve already running"));
    }
    s.set_expected_workers(opts.workers);

    // Resolve tunables: each field falls back to the server default, so an
    // omitted `tuning` (or omitted field) is byte-for-byte the old behaviour.
    // Counts/sizes are clamped to >= 1 so a 0 can never make flume::bounded(0)
    // a rendezvous channel or zero-length the read loop. `conn_workers`
    // defaults to `workers` (the historical coupling).
    let defaults = brust_core::Tuning::default();
    let t = opts.tuning.as_ref();
    let pick = |f: Option<u32>, d: usize| f.map(|v| (v as usize).max(1)).unwrap_or(d);
    let conn_workers = t
        .and_then(|x| x.conn_workers)
        .map(|v| (v as usize).max(1))
        .unwrap_or(opts.workers as usize);
    let tuning = brust_core::Tuning {
        max_request_bytes: pick(
            t.and_then(|x| x.max_request_bytes),
            defaults.max_request_bytes,
        ),
        max_action_body_bytes: pick(
            t.and_then(|x| x.max_action_body_bytes),
            defaults.max_action_body_bytes,
        ),
        conn_queue_cap: pick(t.and_then(|x| x.conn_queue_cap), defaults.conn_queue_cap),
        read_buf_cap: pick(t.and_then(|x| x.read_buf_cap), defaults.read_buf_cap),
        claim_timeout_ms: t
            .and_then(|x| x.claim_timeout_ms)
            .map(|v| (v as u64).max(1))
            .unwrap_or(defaults.claim_timeout_ms),
        worker_threads: pick(t.and_then(|x| x.worker_threads), defaults.worker_threads),
    };

    let addr: SocketAddr = resolve_bind_addr(opts.host.trim(), opts.port)?;

    if let Some(p) = &opts.action_prefix {
        if p.is_empty() || !p.starts_with('/') || p.ends_with('/') {
            return Err(napi::Error::from_reason(format!(
                "action_prefix must be non-empty, start with '/', and not end with '/': {p:?}"
            )));
        }
        state().set_action_prefix(p.clone());
    }

    if let Some(g) = &opts.generator {
        let g = g.trim();
        if g.is_empty() || !g.bytes().all(|b| b.is_ascii_graphic() || b == b' ') {
            return Err(napi::Error::from_reason(format!(
                "generator must be non-empty single-line printable ASCII: {g:?}"
            )));
        }
        state().set_generator(g.to_string());
    }

    // Optional minimum TLS version. Parsed up front so an invalid value is
    // rejected regardless of cert/key presence (never silently defaults). Only
    // applied when TLS is actually configured below.
    let min_version = match opts.tls_min_version.as_deref().map(str::trim) {
        None => brust_core::server::tls::TlsMinVersion::Tls12,
        Some(v) if v.eq_ignore_ascii_case("1.2") => brust_core::server::tls::TlsMinVersion::Tls12,
        Some(v) if v.eq_ignore_ascii_case("1.3") => brust_core::server::tls::TlsMinVersion::Tls13,
        Some(other) => {
            return Err(napi::Error::from_reason(format!(
                "tlsMinVersion must be \"1.2\" or \"1.3\": {other:?}"
            )));
        }
    };

    // Optional in-process TLS: only enabled when BOTH cert + key are supplied.
    // Additive — an app that omits them serves plaintext, byte-for-byte unchanged.
    match (&opts.tls_cert_path, &opts.tls_key_path) {
        (Some(cert), Some(key)) => {
            s.set_tls(Some(brust_core::server::tls::TlsConfig {
                cert_path: std::path::PathBuf::from(cert),
                key_path: std::path::PathBuf::from(key),
                min_version,
            }));
        }
        (None, None) => {}
        _ => {
            return Err(napi::Error::from_reason(
                "tlsCertPath and tlsKeyPath must be provided together",
            ));
        }
    }

    // Process shutdown is owned by the TS layer: runtime/index.ts installs
    // process.on('SIGINT', () => process.exit(0)). Bun intercepts SIGINT before
    // tokio::signal::ctrl_c() can fire in this process, so a Rust-side handler
    // is a no-op under Bun. until_shutdown() below parks the calling Promise
    // on s.shutdown forever; the parking ends when JS exits the process.
    brust_core::start(addr, Arc::clone(s), conn_workers, tuning)
        .map_err(napi::Error::from_reason)?;
    Ok(())
}

#[napi]
pub async fn until_ready(timeout_ms: u32) -> NapiResult<()> {
    let s = state();
    let expected = s.expected_workers() as usize;
    let pool = Arc::clone(&s.pool);
    let ready = Arc::clone(s.ready_notify());
    let result = tokio::time::timeout(Duration::from_millis(timeout_ms as u64), async {
        while pool.registered_count() < expected {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        ready.notify_one();
    })
    .await;
    if result.is_err() {
        error!(timeout_ms, "workers failed to register");
        std::process::exit(1);
    }
    Ok(())
}

#[napi]
pub async fn until_shutdown() -> NapiResult<()> {
    state().wait_shutdown().await;
    Ok(())
}

/// Graceful drain: stop accepting new connections, tell every in-flight one to
/// finish its current request then close, and resolve once they've all drained
/// (or `timeout_ms` elapses). The TS SIGINT handler awaits this before
/// `process.exit` so an in-flight render/stream isn't cut off mid-response (the
/// teardown that produced spurious `split_meta` errors under load). Idempotent-ish:
/// the accept loop only drains once; a second call just re-resolves.
#[napi]
pub async fn begin_drain(timeout_ms: u32) -> NapiResult<()> {
    let s = state();
    s.request_drain(timeout_ms as u64);
    s.wait_drain_done().await;
    Ok(())
}

#[napi]
pub fn register_renderer(
    mut buf: Uint8Array,
    slots: u32,
    f: Function<napi::bindgen_prelude::FnArgs<(String, u32)>, Promise<u32>>,
) -> NapiResult<u32> {
    // NOTE: is_worker() reads std::env::var which is not patched by Bun's Worker
    // env option (Bun Workers share the OS process).  The TS layer is responsible
    // for only calling registerRenderer from a worker context; we skip the guard.
    //
    // Capture the SAB backing-store pointer + length here. The Bun Worker keeps the
    // SAB rooted in its module scope, so the backing store outlives every render call.
    // `buf_len` is the WHOLE buffer; `buf_slot` derives the disjoint per-slot
    // sub-regions from it.
    let (buf_ptr, buf_len) = unsafe {
        let slice = buf.as_mut();
        (BufPtr(slice.as_mut_ptr()), slice.len())
    };
    let tsfn: RendererTsfn = f.build_threadsafe_function().build()?;
    let dispatch = Box::new(TsfnDispatch {
        tsfn: std::sync::Arc::new(tsfn),
        buf_ptr,
        buf_len,
        slots: (slots.max(1)) as usize,
    });
    let id = state().pool.register(dispatch);
    WORKER_ID.with(|cell| cell.set(Some(id)));
    Ok(id)
}

#[napi]
pub fn register_routes(configs: Vec<String>) -> NapiResult<u32> {
    let parsed: Vec<brust_core::routing::routes::RouteConfig> = configs
        .iter()
        .map(|s| serde_json::from_str(s))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| napi::Error::from_reason(format!("invalid route config: {e}")))?;
    state()
        .routes
        .install_with_config(&parsed)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn configure_cache(max_entries: u32, page_max_entries: u32) -> NapiResult<()> {
    state().reconfigure_caches(max_entries.max(1) as u64, page_max_entries.max(1) as u64);
    Ok(())
}

#[napi]
pub fn is_worker() -> bool {
    std::env::var("BRUST_WORKER_ID").is_ok()
}

#[napi]
pub fn worker_id() -> Option<u32> {
    WORKER_ID.with(|cell| cell.get())
}

/// Drop every registered worker entry from the render pool, returning how many
/// were dropped. Dev-mode hot reload calls this from the MAIN thread right
/// BEFORE terminating the current worker generation (see `WorkerPool::clear`):
/// the stale entries hold raw `buf_ptr`s into SharedArrayBuffers that
/// `Worker.terminate()` frees, so any post-reload dispatch that picked one
/// would write the render envelope into freed memory (use-after-free → segfault).
/// No-op in production, where workers are registered once and never replaced.
#[napi]
pub fn reset_worker_pool() -> u32 {
    let s = state();
    let n = s.pool.registered_count() as u32;
    s.pool.clear();
    n
}

/// Number of workers currently registered in the render pool. Exposed for
/// dev-mode observability: after a hot reload the count must return to the
/// configured worker count, not accumulate stale generations.
#[napi]
pub fn worker_pool_size() -> u32 {
    state().pool.registered_count() as u32
}

#[napi]
pub fn configure_islands_dir(path: String) -> NapiResult<()> {
    let abs = std::path::PathBuf::from(&path);
    if !abs.is_absolute() {
        return Err(napi::Error::from_reason(format!(
            "islands_dir must be an absolute path (got {path:?})"
        )));
    }
    state().set_islands_dir(Some(abs));
    Ok(())
}

/// Derive the served URL key for a file path relative to the public root.
/// Normalizes the OS separator to `/` and prefixes `/`. Returns None for keys
/// in the reserved `/_brust/` namespace (those would shadow framework handlers
/// that run after the public serve block — MCP, /_brust/page, cache-invalidate,
/// dev WS). Pure — unit tested.
fn public_url_key(rel: &std::path::Path) -> Option<String> {
    let mut key = String::from("/");
    let mut first = true;
    for comp in rel.components() {
        let std::path::Component::Normal(os) = comp else {
            return None; // no `..`, root, prefix, curdir components
        };
        let part = os.to_str()?;
        if !first {
            key.push('/');
        }
        key.push_str(part);
        first = false;
    }
    if first {
        return None; // empty relative path
    }
    if key == "/_brust" || key.starts_with("/_brust/") {
        return None;
    }
    Some(key)
}

/// Walk `root` recursively and build the URL→file map. Skips files whose
/// canonical path escapes `root` (symlink guard) and reserved `/_brust/` keys.
fn build_public_manifest(
    root: &std::path::Path,
) -> std::collections::HashMap<String, std::path::PathBuf> {
    let mut map = std::collections::HashMap::new();
    let canon_root = match root.canonicalize() {
        Ok(r) => r,
        Err(_) => return map,
    };
    let mut stack = vec![canon_root.clone()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!("public: cannot read dir {dir:?} ({e}) — skipping its assets");
                continue;
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.is_dir() {
                stack.push(path);
                continue;
            }
            let canon = match path.canonicalize() {
                Ok(c) => c,
                Err(_) => continue,
            };
            if !canon.starts_with(&canon_root) {
                tracing::warn!("public: skipping {canon:?} (escapes public root)");
                continue;
            }
            let Ok(rel) = canon.strip_prefix(&canon_root) else {
                continue;
            };
            match public_url_key(rel) {
                Some(key) => {
                    // Request paths arrive percent-encoded; manifest keys are raw
                    // filenames. A name with a space or non-ASCII byte will never
                    // match an incoming request (it'd be `%20`/`%C3%A9`). Warn so
                    // the author isn't silently surprised; still register it.
                    if key.bytes().any(|b| b == b' ' || b >= 0x80) {
                        tracing::warn!(
                            "public: {key:?} has a space or non-ASCII char — requests are \
                             percent-encoded and will not match; rename to a URL-safe name"
                        );
                    }
                    map.insert(key, canon);
                }
                None => {
                    tracing::warn!("public: skipping reserved/invalid key for {rel:?}");
                }
            }
        }
    }
    map
}

/// Tell Rust where to read root-mapped static assets from (`<project>/public`
/// in dev, `<dist>/public` prebuilt). Walks the dir once and caches the
/// URL→file manifest. Path must be absolute.
#[napi]
pub fn configure_public_dir(path: String) -> NapiResult<()> {
    let abs = std::path::PathBuf::from(&path);
    if !abs.is_absolute() {
        return Err(napi::Error::from_reason(format!(
            "public_dir must be an absolute path (got {path:?})"
        )));
    }
    let manifest = build_public_manifest(&abs);
    tracing::info!("public: {} asset(s) from {abs:?}", manifest.len());
    state().set_public_assets(manifest);
    Ok(())
}

/// Enable/disable dev mode. Called by the TS dev coordinator (`brust.run` when
/// `dev` is on). Flips static-asset caching to `no-store` so hot-reloaded island
/// /CSS chunks (unhashed URLs) are never served stale from the browser cache.
#[napi]
pub fn configure_dev_mode(enabled: bool) {
    state().set_dev_mode(enabled);
}

#[napi(object)]
pub struct CachedIslandJs {
    pub html: String,
    pub props: String,
}

#[napi]
pub fn island_cache_get(key: String) -> Option<CachedIslandJs> {
    state().island_cache_get(&key).map(|v| CachedIslandJs {
        html: v.html,
        props: v.props,
    })
}

#[napi]
pub fn island_cache_set(
    key: String,
    tags: Vec<String>,
    ttl_ms: Option<u32>,
    html: String,
    props: String,
) {
    let ttl = ttl_ms.map(|ms| std::time::Duration::from_millis(ms as u64));
    state().island_cache_set(&key, &tags, ttl, html, props);
}

#[napi]
pub fn island_cache_invalidate(key: Option<String>, tags: Option<Vec<String>>) {
    let s = state();
    if let Some(k) = key {
        s.island_cache_invalidate_key(&k);
    }
    if let Some(t) = tags {
        s.island_cache_invalidate_tags(&t);
    }
}

#[napi]
pub fn response_cache_invalidate(
    tags: Option<Vec<String>>,
    path: Option<String>,
    method: Option<String>,
) {
    let s = state();
    if let Some(t) = tags {
        s.response_cache_invalidate_tags(&t);
    }
    if let Some(p) = path {
        s.response_cache_invalidate_path(method.as_deref().unwrap_or("GET"), &p);
    }
}

#[napi]
pub fn island_cache_clear() {
    state().island_cache_clear();
}

#[napi]
pub fn page_cache_get(key: String) -> Option<Buffer> {
    state().page_cache_get(&key).map(Buffer::from)
}

#[napi]
pub fn page_cache_set(key: String, tags: Vec<String>, ttl_ms: Option<u32>, payload: Buffer) {
    let ttl = ttl_ms.map(|ms| std::time::Duration::from_millis(ms as u64));
    state().page_cache_set(&key, &tags, ttl, payload.to_vec());
}

#[napi]
pub fn page_cache_invalidate(key: Option<String>, tags: Option<Vec<String>>) {
    let s = state();
    if let Some(k) = key {
        s.page_cache_invalidate_key(&k);
    }
    if let Some(t) = tags {
        s.page_cache_invalidate_tags(&t);
    }
}

#[napi]
pub fn page_cache_clear() {
    state().page_cache_clear();
}

#[napi]
pub fn configure_css_dir(path: String) -> NapiResult<()> {
    let abs = std::path::PathBuf::from(&path);
    if !abs.is_absolute() {
        return Err(napi::Error::from_reason(format!(
            "css_dir must be an absolute path (got {path:?})"
        )));
    }
    state().set_css_dir(Some(abs));
    Ok(())
}

/// Per-endpoint registration descriptor passed to `register_actions`.
#[napi(object)]
pub struct EndpointReg {
    pub method: String,
    pub path: String,
}

/// Register action endpoints. Replaces any previous router state.
/// Returns the number of endpoints registered.
#[napi]
pub fn register_actions(endpoints: Vec<EndpointReg>) -> NapiResult<u32> {
    let mut router = ActionRouter::new();
    for (i, reg) in endpoints.iter().enumerate() {
        let method = Method::from_http(&reg.method)
            .ok_or_else(|| napi::Error::from_reason(format!("unknown method {:?}", reg.method)))?;
        router
            .insert(method, &reg.path, i as u32)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    }
    let n = endpoints.len() as u32;
    state().set_action_router(router);
    Ok(n)
}

#[cfg(test)]
mod prefix_tests {
    use super::*;

    #[test]
    fn path_under_action_prefix_matches_prefix_and_subpaths() {
        // default prefix is "/_brust/action"
        let s = state();
        assert!(s.path_under_action_prefix("/_brust/action"));
        assert!(s.path_under_action_prefix("/_brust/action/notes"));
        assert!(s.path_under_action_prefix("/_brust/action/notes/5"));
        // sibling that merely shares the prefix bytes must NOT match
        assert!(!s.path_under_action_prefix("/_brust/actionXYZ"));
        assert!(!s.path_under_action_prefix("/_brust/act"));
        assert!(!s.path_under_action_prefix("/other"));
    }
}

// ----- SSE NAPI bridge -----

/// Enqueue one SSE frame for the given connection. Returns a Promise that
/// resolves when the Rust-side per-conn task has finished the TCP write —
/// cooperative backpressure for the JS reader loop.
#[napi]
pub async fn napi_sse_write(conn_id: BigInt, bytes: Buffer) -> NapiResult<()> {
    let conn_id = bigint_to_u64(&conn_id)?;
    let frame_tx = {
        let reg = brust_core::realtime::sse::registry().lock();
        reg.get(&conn_id).map(|c| c.frame_tx.clone())
    };
    let Some(tx) = frame_tx else {
        return Err(napi::Error::from_reason(format!(
            "conn {} not registered",
            conn_id
        )));
    };
    let (ack_tx, ack_rx) = tokio::sync::oneshot::channel::<()>();
    let frame = brust_core::realtime::sse::SseFrame {
        bytes: bytes.to_vec(),
        ack: ack_tx,
    };
    if tx.send(frame).await.is_err() {
        return Err(napi::Error::from_reason(format!(
            "conn {} channel closed",
            conn_id
        )));
    }
    // Propagate ack errors so the JS reader loop aborts immediately instead
    // of enqueuing more frames into a torn-down conn (the next tx.send would
    // catch it eventually but several frames could be lost in the meantime).
    ack_rx.await.map_err(|_| {
        napi::Error::from_reason(format!(
            "conn {} ack dropped — TCP write failed or conn torn down",
            conn_id
        ))
    })?;
    Ok(())
}

/// Drop the connection's sender, which signals the per-conn task to exit
/// and close the TCP socket. Idempotent — a missing conn is a no-op.
#[napi]
pub fn napi_sse_close(conn_id: BigInt) -> NapiResult<()> {
    let conn_id = bigint_to_u64(&conn_id)?;
    let _ = brust_core::realtime::sse::registry()
        .lock()
        .remove(&conn_id);
    Ok(())
}

/// JS provides a callback that fires once when Rust detects client disconnect.
/// Stored as a thread-safe wrapper on the SseConn.
#[napi]
pub fn napi_sse_register_abort(conn_id: BigInt, cb: Function<(), ()>) -> NapiResult<()> {
    let conn_id = bigint_to_u64(&conn_id)?;
    let tsfn = cb.build_threadsafe_function().build()?;
    let mut reg = brust_core::realtime::sse::registry().lock();
    if let Some(conn) = reg.get_mut(&conn_id) {
        conn.abort_cb = Some(Box::new(move || {
            // Fire-and-forget — non-blocking call into JS.
            let _ = tsfn.call((), ThreadsafeFunctionCallMode::NonBlocking);
        }));
    }
    Ok(())
}

/// JS reports the middleware open verdict. Single-shot — a second call is
/// dropped (open_tx is taken on first use).
#[napi]
pub fn napi_sse_signal_open(
    conn_id: BigInt,
    status: u32,
    body: Buffer,
    content_type: String,
) -> NapiResult<()> {
    let conn_id = bigint_to_u64(&conn_id)?;
    let open_tx = {
        let mut reg = brust_core::realtime::sse::registry().lock();
        reg.get_mut(&conn_id).and_then(|c| c.open_tx.take())
    };
    if let Some(tx) = open_tx {
        let _ = tx.send(brust_core::realtime::sse::SseOpenSignal {
            status: status as u16,
            body: body.to_vec(),
            content_type,
        });
    }
    Ok(())
}

/// Register literal SSE paths. Rust's accept loop will match incoming GET
/// requests against this set; matched requests enter the SSE dispatch branch
/// instead of the normal render path. Call once at boot before begin_serve.
/// Only exact-match (literal) paths are supported — parameterized routes
/// (e.g. `/sse/{room}`) require a matchit-rs follow-up.
#[napi]
pub fn napi_register_sse_paths(paths: Vec<String>) -> NapiResult<()> {
    for p in paths {
        brust_core::realtime::sse::register_sse_path(p);
    }
    Ok(())
}

// ----- WS NAPI bridge -----

/// Argument struct for the JS on_message callback. napi-rs does not accept
/// tuple type parameters for Function<(A, B), R> so we use an object payload
/// instead. Task 5 + Task 9 must construct a matching TS type.
#[napi(object)]
pub struct WsMessageArg {
    pub data: Buffer,
    pub is_binary: bool,
}

/// Argument struct for the JS on_close callback.
#[napi(object)]
pub struct WsCloseArg {
    pub code: u32,
    pub reason: String,
}

/// JS reports the middleware verdict + chosen subprotocol. Single-shot;
/// second call is a no-op (the Option is taken).
#[napi]
pub fn napi_ws_signal_open(
    conn_id: BigInt,
    status: u32,
    body: Buffer,
    content_type: String,
    subprotocol: String,
) -> NapiResult<()> {
    let conn_id = bigint_to_u64(&conn_id)?;
    let open_tx = {
        let mut reg = brust_core::realtime::ws::registry().lock();
        reg.get_mut(&conn_id).and_then(|c| c.open_tx.take())
    };
    if let Some(tx) = open_tx {
        let _ = tx.send(brust_core::realtime::ws::WsOpenSignal {
            status: status as u16,
            body: body.to_vec(),
            content_type,
            subprotocol,
        });
    }
    Ok(())
}

/// Send one frame. is_binary=false → Text frame (UTF-8 validated before
/// enqueue), true → Binary frame. Returns Promise<()> resolving after the
/// TCP write completes — cooperative backpressure, mirrors napi_sse_write.
#[napi]
pub async fn napi_ws_send(conn_id: BigInt, data: Buffer, is_binary: bool) -> NapiResult<()> {
    let conn_id = bigint_to_u64(&conn_id)?;
    let send_tx = {
        let reg = brust_core::realtime::ws::registry().lock();
        reg.get(&conn_id).map(|c| c.send_tx.clone())
    };
    let Some(tx) = send_tx else {
        return Err(napi::Error::from_reason(format!(
            "ws conn {} not registered",
            conn_id
        )));
    };
    let (ack_tx, ack_rx) = tokio::sync::oneshot::channel::<()>();
    let frame = if is_binary {
        brust_core::realtime::ws::WsFrameKind::Binary(data.to_vec())
    } else {
        let s = String::from_utf8(data.to_vec()).map_err(|_| {
            napi::Error::from_reason(format!("ws conn {} text frame not valid utf-8", conn_id))
        })?;
        brust_core::realtime::ws::WsFrameKind::Text(s)
    };
    let outgoing = brust_core::realtime::ws::WsOutgoing { frame, ack: ack_tx };
    if tx.send(outgoing).await.is_err() {
        return Err(napi::Error::from_reason(format!(
            "ws conn {} send channel closed",
            conn_id
        )));
    }
    // Propagate ack errors so JS sees TCP write failures immediately (same fix
    // as SSE Task 4 polish — commit a78ce75).
    ack_rx.await.map_err(|_| {
        napi::Error::from_reason(format!(
            "ws conn {} send ack dropped — TCP write failed or conn torn down",
            conn_id
        ))
    })?;
    Ok(())
}

/// Initiate close. code defaults applied client-side (default 1000);
/// reason capped at 123 bytes (RFC 6455) at the JS layer.
/// Idempotent — missing conn is a silent no-op.
#[napi]
pub async fn napi_ws_close(conn_id: BigInt, code: u32, reason: String) -> NapiResult<()> {
    let conn_id = bigint_to_u64(&conn_id)?;
    let send_tx = {
        let reg = brust_core::realtime::ws::registry().lock();
        reg.get(&conn_id).map(|c| c.send_tx.clone())
    };
    let Some(tx) = send_tx else {
        return Ok(());
    };
    let (ack_tx, _ack_rx) = tokio::sync::oneshot::channel::<()>();
    let frame = brust_core::realtime::ws::WsFrameKind::Close(code as u16, reason);
    // Fire-and-forget on the ack — per-conn task drops the sender after
    // writing the Close frame; the ack may not arrive depending on race.
    let _ = tx
        .send(brust_core::realtime::ws::WsOutgoing { frame, ack: ack_tx })
        .await;
    Ok(())
}

/// JS registers per-conn callbacks. Each Function arg is converted to a tsfn
/// then wrapped in a Box<dyn Fn> closure, matching the field shape Task 3
/// chose to keep cargo test --lib happy without napi linker symbols.
///
/// Uses struct-payload form (WsMessageArg / WsCloseArg) because napi-rs
/// does not accept tuple type parameters for Function<(A, B), R>.
/// Task 5 + Task 9 must use matching TS object shapes.
///
/// Single-shot registration; a second call replaces both handlers.
#[napi]
pub fn napi_ws_register_handlers(
    conn_id: BigInt,
    on_message: Function<WsMessageArg, ()>,
    on_close: Function<WsCloseArg, ()>,
) -> NapiResult<()> {
    let conn_id = bigint_to_u64(&conn_id)?;
    let on_message_tsfn = on_message.build_threadsafe_function().build()?;
    let on_close_tsfn = on_close.build_threadsafe_function().build()?;
    let on_message_box: brust_core::realtime::ws::WsMessageCallback =
        Box::new(move |bytes, is_binary| {
            let arg = WsMessageArg {
                data: Buffer::from(bytes),
                is_binary,
            };
            on_message_tsfn.call(arg, ThreadsafeFunctionCallMode::NonBlocking);
        });
    let on_close_box: brust_core::realtime::ws::WsCloseCallback = Box::new(move |code, reason| {
        let arg = WsCloseArg {
            code: code as u32,
            reason,
        };
        on_close_tsfn.call(arg, ThreadsafeFunctionCallMode::NonBlocking);
    });
    let mut reg = brust_core::realtime::ws::registry().lock();
    if let Some(conn) = reg.get_mut(&conn_id) {
        conn.on_message = Some(on_message_box);
        conn.on_close = Some(on_close_box);
    } else {
        // Silent miss would leave JS thinking handlers are installed while
        // Rust dropped them — a black hole. Warn so timing races between
        // registration and teardown are diagnosable in integration smoke.
        tracing::warn!(conn_id, "napi_ws_register_handlers: conn not in registry");
    }
    Ok(())
}

/// Boot-time registry of literal WS paths. Mirror of napi_register_sse_paths.
/// Call once before begin_serve; exact-match only (parameterized routes are a
/// follow-up).
#[napi]
pub fn napi_register_ws_paths(paths: Vec<String>) -> NapiResult<()> {
    for p in paths {
        brust_core::realtime::ws::register_ws_path(p);
    }
    Ok(())
}

/// Dev-mode: broadcast one JSON control frame (building / reload / css-update /
/// error / ok) to every connected `/_brust/dev` client. Called from the main
/// thread by the dev coordinator. A no-op when no dev client is connected.
///
/// Delivery goes straight through each connection's Rust-owned `send_tx`, so it
/// survives a hot reload's worker restart — unlike the old worker-relay path,
/// which lost the `reload` frame because the terminated worker took the client
/// registration with it.
#[napi]
pub fn napi_dev_broadcast(json: String) {
    brust_core::realtime::ws::dev_broadcast(&json);
}

/// Worker-driven render chunk delivery. Worker calls this once per chunk
/// it wants to emit; final call uses `len = 0` to close the channel.
///
/// Contract (spec S5.2):
/// - `len > 0`: read SAB[0..len], send Bytes through render_slot.chunk_tx,
///   await ack. Resolves after Rust writes the chunk to the socket.
/// - `len == 0`: send Final, await ack. Closes the response.
/// - Bounds violation (len > buf_len) → NAPI Err.
/// - Slot empty (no in-flight render for this worker) → NAPI Err.
/// - Ack receiver dropped (handle_conn torn down mid-stream) → NAPI Err
///   (NOT hang — worker's sink propagates via cb(err) to renderer Promise).
#[napi]
pub async fn napi_render_chunk(worker_id: u32, slot: u32, len: u32) -> NapiResult<()> {
    let entry = state()
        .pool
        .entry(worker_id)
        .ok_or_else(|| napi::Error::from_reason(format!("worker {} not registered", worker_id)))?;
    let render_slot = entry.render_slot_for(slot).ok_or_else(|| {
        napi::Error::from_reason(format!("worker {} has no slot {}", worker_id, slot))
    })?;
    let chunk_tx = brust_core::render::stream::check_chunk_dispatch(
        render_slot,
        len,
        entry.dispatch.buf_slot(slot).1,
    )
    .map_err(napi::Error::from_reason)?;

    let (ack_tx, ack_rx) = tokio::sync::oneshot::channel::<()>();
    let chunk = if len == 0 {
        brust_core::render::pool::RenderChunk::Final { ack: ack_tx }
    } else {
        // SAFETY: BufPtr is the SAB backing-store pointer pinned at register
        // time (see dispatch_impl.rs::BufPtr docstring); `buf_slot` offsets it to
        // this slot's disjoint sub-region. `len` is bounds-checked above.
        let (ptr, _cap) = entry.dispatch.buf_slot(slot);
        let data = unsafe { std::slice::from_raw_parts(ptr, len as usize) }.to_vec();
        brust_core::render::pool::RenderChunk::Bytes { data, ack: ack_tx }
    };
    chunk_tx
        .send(chunk)
        .await
        .map_err(|_| napi::Error::from_reason("render chunk channel closed (handle_conn gone)"))?;
    ack_rx
        .await
        .map_err(|_| napi::Error::from_reason("ack dropped — handle_conn torn down mid-chunk"))?;
    Ok(())
}

/// Buffering-path finalizer: equivalent to `napi_render_chunk(_, len)` followed
/// by `napi_render_chunk(_, 0)` but in a single tsfn crossing. Cuts JS-side
/// per-request overhead by one full Promise+await cycle.
///
/// Streaming-path callers MUST NOT use this — they send N body chunks then a
/// separate `Final`. Calling this with `streaming=true` meta is logged at WARN
/// on the Rust side and falls back to emitting chunked headers + framed body
/// + chunked terminator (byte-equivalent to Bytes-then-Final in chunked mode).
///
/// Same error semantics as `napi_render_chunk`.
#[napi]
pub async fn napi_render_chunk_final(worker_id: u32, slot: u32, len: u32) -> NapiResult<()> {
    let entry = state()
        .pool
        .entry(worker_id)
        .ok_or_else(|| napi::Error::from_reason(format!("worker {} not registered", worker_id)))?;
    let render_slot = entry.render_slot_for(slot).ok_or_else(|| {
        napi::Error::from_reason(format!("worker {} has no slot {}", worker_id, slot))
    })?;
    let chunk_tx = brust_core::render::stream::check_chunk_dispatch(
        render_slot,
        len,
        entry.dispatch.buf_slot(slot).1,
    )
    .map_err(napi::Error::from_reason)?;

    let (ack_tx, ack_rx) = tokio::sync::oneshot::channel::<()>();
    // SAFETY: same as napi_render_chunk — BufPtr pinned at register time
    // (see dispatch_impl.rs::BufPtr docstring); `buf_slot` offsets it to this
    // slot's disjoint sub-region. `len` is bounds-checked above.
    let (ptr, _cap) = entry.dispatch.buf_slot(slot);
    let data = unsafe { std::slice::from_raw_parts(ptr, len as usize) }.to_vec();
    chunk_tx
        .send(brust_core::render::pool::RenderChunk::BytesAndFinal { data, ack: ack_tx })
        .await
        .map_err(|_| napi::Error::from_reason("render chunk channel closed (handle_conn gone)"))?;
    ack_rx
        .await
        .map_err(|_| napi::Error::from_reason("ack dropped — handle_conn torn down mid-chunk"))?;
    Ok(())
}

/// Sub-project J — render via minijinja using SAB-side-channeled loader data.
///
/// SAB convention (spec S6 last paragraph): per-napi-call. `napi_render_jinja`
/// treats SAB[0..data_len] as INBOUND raw JSON written by the JS worker. It
/// renders the template Rust-side, assembles a `[meta_len: u16 BE][meta JSON]
/// [body]` payload, writes it back into the SAB, and returns its byte length —
/// the FAST LANE. The JS native branch returns this length up to the tsfn, and
/// the dispatch loop's fast-lane arm reads the framed bytes directly from the
/// SAB and ships them via `build_single_response_bytes`. No chunk channel, no
/// per-chunk ack round-trip.
///
/// The render reads the inbound JSON into an owned `Vec` first, so overwriting
/// the SAB with the assembled response afterward is safe (no aliasing).
///
/// SYNCHRONOUS napi fn (not `async`): the body is pure CPU work (jinja render +
/// SAB memcpy) with no `.await`, so it's a direct FFI call from the worker
/// thread — no Promise, no microtask round-trip. This is what lets native
/// routes reach the same crossing floor as actions: the only Rust↔JS hops left
/// are the tsfn call and the render-Promise resolution.
///
/// Errors:
/// - worker id not registered → NAPI Err
/// - `data_len > buf_len` → NAPI Err (caller should have written ≤ buf_len)
/// - assembled response > buf_len → writes a small framed 500 that fits and
///   returns ITS length, so the client gets a response instead of hanging.
/// - `jinja::render` failure → writes a framed 500 into the SAB and returns its
///   length (the protocol error is converted to an HTTP 500 on the wire).
#[napi]
pub fn napi_render_jinja(
    worker_id: u32,
    slot: u32,
    data_len: u32,
    template_name: String,
    status: Option<u32>,
) -> NapiResult<u32> {
    let entry = state()
        .pool
        .entry(worker_id)
        .ok_or_else(|| napi::Error::from_reason(format!("worker {} not registered", worker_id)))?;

    // Bounds-check the JS-supplied slot BEFORE any `buf_slot(slot)` call. Unlike
    // the chunk paths (gated by `render_slot_for(slot)`), this fast-lane fn reads
    // the slot directly; an out-of-range slot must produce a clean Err here rather
    // than reaching `buf_slot`'s pointer math. (`buf_slot` clamps defensively too,
    // but a bad slot returning a zero-cap region would otherwise panic on the
    // assembled-response write below.)
    if slot as usize >= entry.dispatch.slot_count() {
        return Err(napi::Error::from_reason(format!(
            "worker {} has no slot {}",
            worker_id, slot
        )));
    }

    // SAFETY: BufPtr is the SAB backing-store pointer pinned at register time
    // (see dispatch_impl.rs::BufPtr docstring); `buf_slot` offsets it to this slot's
    // disjoint sub-region. `slot` is bounds-checked above, so `slot_cap` is the real
    // per-slot capacity. Read once and reused for the whole fn (the geometry is
    // invariant for this call).
    let (slot_ptr, slot_cap) = entry.dispatch.buf_slot(slot);

    if data_len as usize > slot_cap {
        return Err(napi::Error::from_reason(format!(
            "data_len {} exceeds SAB len {}",
            data_len, slot_cap
        )));
    }

    // SAFETY: `data_len <= slot_cap` (checked above). Copied to an owned Vec so the
    // SAB can be overwritten with the assembled response below.
    let data_json = unsafe { std::slice::from_raw_parts(slot_ptr, data_len as usize) }.to_vec();

    let (meta_json, body): (Vec<u8>, Vec<u8>) =
        match brust_core::template::jinja::render(&template_name, &data_json) {
            Ok(html) => {
                let meta = serde_json::json!({
                    "status": status.unwrap_or(200),
                    "contentType": "text/html; charset=utf-8",
                    "headers": {},
                    "streaming": false,
                });
                (
                    serde_json::to_vec(&meta).expect("meta serialize"),
                    html.into_bytes(),
                )
            }
            Err(e) => {
                tracing::error!(
                    template = %template_name,
                    error = %e,
                    "jinja render failed",
                );
                let meta = serde_json::json!({
                    "status": 500,
                    "contentType": "text/plain; charset=utf-8",
                    "headers": {},
                    "streaming": false,
                });
                (
                    serde_json::to_vec(&meta).expect("meta serialize"),
                    b"internal error".to_vec(),
                )
            }
        };

    if meta_json.len() > u16::MAX as usize {
        return Err(napi::Error::from_reason(format!(
            "meta JSON length {} exceeds u16::MAX",
            meta_json.len()
        )));
    }
    let meta_len: u16 = meta_json.len() as u16;
    let mut assembled = Vec::with_capacity(2 + meta_json.len() + body.len());
    assembled.extend_from_slice(&meta_len.to_be_bytes());
    assembled.extend_from_slice(&meta_json);
    assembled.extend_from_slice(&body);

    // Overflow: assembled response can't fit in the SAB. Replace with a small
    // framed 500 that always fits, so the client gets a response (HTTP 500)
    // instead of hanging on a truncated body.
    if assembled.len() > slot_cap {
        tracing::error!(
            template = %template_name,
            assembled_len = assembled.len(),
            buf_len = slot_cap,
            "jinja response exceeds SAB capacity — emitting 500",
        );
        let meta = br#"{"status":500,"contentType":"text/plain; charset=utf-8","headers":{},"streaming":false}"#;
        let body = b"response body too large";
        assembled.clear();
        assembled.extend_from_slice(&(meta.len() as u16).to_be_bytes());
        assembled.extend_from_slice(meta);
        assembled.extend_from_slice(body);
    }

    // SAFETY: same slot sub-region (`slot_ptr`/`slot_cap` from above); the in-flight
    // render owns it exclusively and the inbound JSON was already copied out above.
    // `assembled.len() <= slot_cap` (the overflow branch above guarantees it).
    let sab = unsafe { std::slice::from_raw_parts_mut(slot_ptr, slot_cap) };
    sab[..assembled.len()].copy_from_slice(&assembled);
    Ok(assembled.len() as u32)
}

/// Sub-project J — boot-time listing of registered minijinja templates.
/// JS dispatcher uses this to validate every `native: true` route's
/// `Component.name` is present (warns on mismatch per Reviewer Fix 1).
#[napi]
pub fn napi_list_native_templates() -> Vec<String> {
    brust_core::template::jinja::registered_templates()
}

/// Sub-project J — boot-time loader for `.brust/jinja/*.jinja` templates.
/// Returns the list of template names registered (each `<Name>.jinja` file
/// stem becomes the lookup key). Lenient on missing/non-directory `dir`.
#[napi]
pub fn napi_load_jinja_templates(dir: String) -> Vec<String> {
    brust_core::template::jinja::load_from(std::path::Path::new(&dir))
}

/// Convert a NAPI BigInt to u64, rejecting negative values.
/// conn_ids cross the JS/Rust boundary as BigInt because JS Number tops out
/// at 2^53 while conn_ids are monotonic u64 from an AtomicU64.
fn bigint_to_u64(b: &BigInt) -> NapiResult<u64> {
    let (signed, value, lossless) = b.get_u64();
    if signed {
        return Err(napi::Error::from_reason("conn_id must be non-negative"));
    }
    if !lossless {
        return Err(napi::Error::from_reason("conn_id overflows u64"));
    }
    Ok(value)
}

/// Test-only stub for napi runtime symbols that `ThreadsafeFunction::Drop`
/// references. The crate is `cdylib` so the napi C runtime symbols are
/// resolved by the host (Bun) at load time — they aren't linked into the
/// test binary. Test code registers workers with `MockDispatch` (which holds
/// no `ThreadsafeFunction` at all — only `TsfnDispatch`, never constructed in
/// test builds, owns one), so `ThreadsafeFunction::drop` is unreachable from
/// tests; this stub exists purely to satisfy the static linker.
///
/// If a test ever ends up invoking this stub, that's a test-design bug —
/// dispatch paths that would call `_napi_release_threadsafe_function`
/// should never be reachable from test code.
#[cfg(test)]
#[unsafe(no_mangle)]
unsafe extern "C" fn napi_release_threadsafe_function(
    _func: *mut std::ffi::c_void,
    _mode: i32,
) -> i32 {
    0
}

#[cfg(test)]
#[unsafe(no_mangle)]
unsafe extern "C" fn napi_delete_reference(
    _env: *mut std::ffi::c_void,
    _ref_: *mut std::ffi::c_void,
) -> i32 {
    0
}

#[cfg(test)]
#[unsafe(no_mangle)]
unsafe extern "C" fn napi_reference_unref(
    _env: *mut std::ffi::c_void,
    _ref_: *mut std::ffi::c_void,
    _result: *mut u32,
) -> i32 {
    0
}

#[cfg(test)]
mod action_router_tests {
    use super::*;

    #[test]
    fn register_and_match_actions() {
        register_actions(vec![
            EndpointReg {
                method: "POST".into(),
                path: "/notes".into(),
            },
            EndpointReg {
                method: "GET".into(),
                path: "/notes/{id}".into(),
            },
        ])
        .unwrap();
        use brust_core::routing::action::{MatchOutcome, Method};
        assert!(matches!(
            state().with_action_router(|r| r.at(Method::Get, "/notes/42")),
            MatchOutcome::Found { endpoint_id: 1, .. }
        ));
        assert!(matches!(
            state().with_action_router(|r| r.at(Method::Put, "/notes/42")),
            MatchOutcome::MethodNotAllowed
        ));
        assert!(matches!(
            state().with_action_router(|r| r.at(Method::Get, "/nope")),
            MatchOutcome::NotFound
        ));
    }

    #[test]
    fn register_actions_rejects_unknown_method() {
        assert!(
            register_actions(vec![EndpointReg {
                method: "FOO".into(),
                path: "/x".into()
            }])
            .is_err()
        );
    }
}

#[cfg(test)]
mod island_cache_napi_tests {
    use super::*;
    #[test]
    fn get_set_invalidate_roundtrip_through_state() {
        island_cache_set(
            "napi:k1".into(),
            vec!["napi:t".into()],
            Some(60_000),
            "<i>x</i>".into(),
            "{}".into(),
        );
        let got = island_cache_get("napi:k1".into()).expect("hit");
        assert_eq!(got.html, "<i>x</i>");
        island_cache_invalidate(None, Some(vec!["napi:t".into()]));
        state().island_cache_clear();
        assert!(island_cache_get("napi:k1".into()).is_none());
    }

    #[test]
    fn public_url_key_derivation() {
        use std::path::Path;
        assert_eq!(
            public_url_key(Path::new("favicon.ico")).as_deref(),
            Some("/favicon.ico")
        );
        assert_eq!(
            public_url_key(Path::new("img/logo.png")).as_deref(),
            Some("/img/logo.png")
        );
        assert_eq!(
            public_url_key(Path::new("a/b/c.txt")).as_deref(),
            Some("/a/b/c.txt")
        );
        assert_eq!(public_url_key(Path::new("_brust/mcp")), None);
        assert_eq!(public_url_key(Path::new("_brust")), None);
        assert_eq!(public_url_key(Path::new("../etc/passwd")), None);
        assert_eq!(public_url_key(Path::new(".")), None);
        assert_eq!(public_url_key(Path::new("")), None);
        // `_brust` prefix WITHOUT a trailing slash is not reserved (no false positive).
        assert_eq!(
            public_url_key(Path::new("_brust_extra.txt")).as_deref(),
            Some("/_brust_extra.txt")
        );
    }
}
