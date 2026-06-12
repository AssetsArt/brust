use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http::header::{CONNECTION, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_PROTOCOL, UPGRADE};
use http::{Request, Response, StatusCode};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto;
use tracing::{debug, error, info, warn};

use crate::cache::response_cache::CacheKey;
use crate::config::AppState;
use crate::routing::routes::MatchResult;
use crate::server::body::{ResponseBody, channel_body, empty_body};

pub mod body;
pub mod static_assets;
pub mod tls;

use static_assets::{
    asset_lookup_key, content_type_for, is_safe_css_filename, is_safe_island_filename,
    static_asset_response,
};

/// IO label for the boot banner (changed from the hand-rolled `tokio` loop).
const IO_NAME: &str = "hyper(tokio)";

/// Runtime-tunable server limits, set ONCE from `ServeOptions.tuning` at
/// `begin_serve` (see lib.rs). Every default matches the historical
/// compile-time constant, so an app that omits `tuning` is byte-for-byte
/// unchanged. Hot-path reads go through `tuning()`.
///
/// - `max_request_bytes` (16 KB): cap on request header bytes (enforced by
///   hyper's `max_buf_size` so an oversized header line can't grow unbounded).
///   This is ALSO the only size bound on render envelopes: render requests carry
///   no body, so their inline JSON envelope (passed through napi as a String) is
///   bounded by this header cap. Action/MCP
///   envelopes are bounded by `max_action_body_bytes` (the base64-encoded body
///   inflates ~4/3, still a hard cap).
/// - `max_action_body_bytes` (256 KB): cap on action/RPC body size. Mirrors the
///   SAB capacity so the largest body fits one SAB write; raising the SAB does
///   NOT auto-raise this — set it here too.
/// - `conn_queue_cap` (1024): accept-side concurrency permit count; a slow
///   worker pool triggers TCP backpressure (accept stalls) instead of unbounded
///   memory growth.
/// - `read_buf_cap` (4096): hyper read-buffer initial sizing hint.
/// - `worker_threads` (`min(available_parallelism, 4)`, fallback 2): tokio
///   worker-thread count for the I/O runtime. This runs INSIDE Bun (which has
///   its own threads + N render workers), so we do NOT default to
///   one-thread-per-core; we cap at 4 (enough for TLS + accept + render-adjacent
///   tasks) so small VMs aren't overprovisioned, while never being a hard
///   ceiling of 2 under concurrent load. The old hand-rolled loop was a single
///   current-thread-equivalent accept worker fanned out over async tasks.
///   Override via tuning.
#[derive(Clone, Copy)]
pub struct Tuning {
    pub max_request_bytes: usize,
    pub max_action_body_bytes: usize,
    pub conn_queue_cap: usize,
    pub read_buf_cap: usize,
    /// Max time a render dispatch waits for a free worker before giving up with
    /// 503 (see `claim_or_wait`). Bounds the AllBusy→queue wait so a wedged
    /// worker pool can't park a connection forever. Default 10_000 ms.
    pub claim_timeout_ms: u64,
    /// tokio I/O runtime worker-thread count. Default `min(available_parallelism, 4)`
    /// (see struct docs).
    pub worker_threads: usize,
}

impl Default for Tuning {
    fn default() -> Self {
        Self {
            max_request_bytes: 16 * 1024,
            max_action_body_bytes: 256 * 1024,
            conn_queue_cap: 1024,
            read_buf_cap: 4096,
            claim_timeout_ms: 10_000,
            worker_threads: std::thread::available_parallelism()
                .map(|n| n.get().min(4))
                .unwrap_or(2),
        }
    }
}

static TUNING: std::sync::OnceLock<Tuning> = std::sync::OnceLock::new();

/// Hot-path accessor. Returns the values set by `start`, or `Tuning::default()`
/// if `start` has not run yet (unit tests that exercise handlers without
/// booting the server). `Tuning` is `Copy`, so this is a cheap load.
#[inline]
fn tuning() -> Tuning {
    TUNING.get().copied().unwrap_or_default()
}

/// Start the hyper server. `conn_workers` is preserved in the signature for
/// the napi binding but no longer maps to N flume-fed conn tasks — hyper owns
/// per-connection servicing. We fold it into the accept-level concurrency cap
/// alongside `conn_queue_cap` (taking the max, so an explicit `connWorkers`
/// override still raises the ceiling), keeping the historical backpressure
/// tunable meaningful.
pub fn start(
    addr: SocketAddr,
    state: Arc<AppState>,
    conn_workers: usize,
    tuning: Tuning,
) -> Result<(), String> {
    // Set the process-wide tunables before any connection is served. `start`
    // runs once per process (re-serve is rejected in begin_serve), so a
    // best-effort set is correct; the Err arm only fires if already set.
    let _ = TUNING.set(tuning);

    // The accept-concurrency ceiling: the larger of the historical accept queue
    // depth and any explicit connWorkers override (both default-coupled to the
    // render-worker count in the binding).
    let accept_cap = tuning.conn_queue_cap.max(conn_workers).max(1);

    // Boot channel: the spawned runtime thread reports the outcome of the two
    // BOOT-time fallible steps (TCP bind + TLS-acceptor build) back here. On
    // success `start` returns Ok and the thread proceeds into the accept loop in
    // the background; on failure the operator-fixable error propagates up to the
    // napi/JS layer as a thrown error instead of `process::exit` nuking the Bun
    // host (it runs INSIDE the Bun process).
    let (boot_tx, boot_rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);

    info!(
        "Starting Tokio runtime with {} threads",
        tuning.worker_threads.max(1)
    );
    info!("Accept cap: {}", accept_cap);
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(tuning.worker_threads.max(1))
            .enable_all()
            .build()
            // If the runtime can't build, this thread panics BEFORE sending on
            // boot_tx; the dropped sender makes `boot_rx.recv()` return Err,
            // which `start` maps to a boot error.
            .expect("tokio runtime");
        rt.block_on(async move {
            let listener = match tokio::net::TcpListener::bind(addr).await {
                Ok(l) => l,
                Err(e) => {
                    error!(error = %e, %addr, "bind failed");
                    let _ = boot_tx.send(Err(format!("bind failed on {addr}: {e}")));
                    return;
                }
            };

            // Optional in-process TLS termination. Built ONCE before the accept
            // loop: a configured-but-broken cert/key is fatal at boot (mirrors
            // bind failure). `None` = plaintext, behavior unchanged.
            let acceptor: Option<tokio_rustls::TlsAcceptor> = match state.tls() {
                Some(cfg) => match tls::build_acceptor(&cfg) {
                    Ok(a) => Some(a),
                    Err(e) => {
                        error!(error = %e, "tls acceptor build failed");
                        let _ = boot_tx.send(Err(format!("tls acceptor build failed: {e}")));
                        return;
                    }
                },
                None => None,
            };

            // Bind + acceptor both succeeded: report boot success. The thread
            // keeps running below (ready gate + accept loop) in the background.
            let _ = boot_tx.send(Ok(()));

            state.ready.notified().await; // wait until all napi workers registered
            let tls_label = if acceptor.is_some() { ", tls" } else { "" };
            println!("[brust] listening on {addr} (io: {IO_NAME}{tls_label})");
            let _ = std::io::Write::flush(&mut std::io::stdout());

            let sem = Arc::new(tokio::sync::Semaphore::new(accept_cap));

            // X-Powered-By, stamped on EVERY response at the service layer (render,
            // action, static, cache HIT, SAB fast-lane, streaming, WS 101 — all return
            // through handle_request). insert-if-absent: user middleware headers win.
            // Cached framed bytes are captured pre-stamp inside dispatch, so stamping
            // HITs here can never duplicate.
            let powered_by: Option<http::HeaderValue> = state
                .generator()
                .and_then(|s| http::HeaderValue::from_str(&s).ok());

            // Graceful drain wiring. `drain_sig` (watch) tells each in-flight
            // connection to finish its current request then close (refuse new
            // keep-alive requests). `conn_token` (mpsc) is a drain barrier: every
            // connection task holds a clone, so once the accept loop drops its own
            // and the last connection finishes, `conn_token_rx.recv()` returns
            // `None` — that's "all connections drained".
            let (drain_sig_tx, drain_sig_rx) = tokio::sync::watch::channel(false);
            let (conn_token_tx, mut conn_token_rx) = tokio::sync::mpsc::channel::<()>(1);

            // Register interest on the drain signal BEFORE the accept loop so a
            // `request_drain` that races the first `select!` poll isn't lost
            // (`Notify` stores one permit).
            let drain_started = state.drain_start_notify().notified();
            tokio::pin!(drain_started);
            drain_started.as_mut().enable();

            loop {
                let accepted = tokio::select! {
                    biased;
                    _ = drain_started.as_mut() => None, // drain requested → stop accepting
                    res = listener.accept() => Some(res),
                };
                let (tcp, _peer) = match accepted {
                    None => break,
                    Some(Ok(pair)) => pair,
                    Some(Err(e)) => {
                        error!(error = %e, "accept failed");
                        // NOTE: post-boot fatal; see FU#3 scope
                        std::process::exit(1);
                    }
                };

                // Accept-level backpressure: cap in-flight connections at
                // `accept_cap`. When the pool is saturated, `acquire_owned`
                // parks here, stalling the accept loop → TCP backpressure,
                // mirroring the old bounded flume queue.
                let permit = match sem.clone().acquire_owned().await {
                    Ok(p) => p,
                    // Semaphore is never closed; treat as fatal if it somehow is.
                    Err(_) => {
                        error!("accept semaphore closed");
                        // NOTE: post-boot fatal; see FU#3 scope
                        std::process::exit(1);
                    }
                };

                let state = Arc::clone(&state);
                let powered_by = powered_by.clone();
                let read_buf_cap = tuning.read_buf_cap;
                let max_req = tuning.max_request_bytes;
                let acceptor = acceptor.clone();
                let conn_drain = drain_sig_rx.clone();
                let conn_token = conn_token_tx.clone();
                tokio::spawn(async move {
                    let _permit = permit; // released when the connection ends
                    let _conn_token = conn_token; // drain barrier — held for the conn's life
                    let powered_by = powered_by.clone();
                    let svc = service_fn(move |req| {
                        let state = Arc::clone(&state);
                        let powered_by = powered_by.clone();
                        async move {
                            let mut resp = handle_request(req, state).await?;
                            if let Some(v) = powered_by {
                                resp.headers_mut()
                                    .entry(http::header::HeaderName::from_static("x-powered-by"))
                                    .or_insert(v);
                            }
                            Ok::<_, Infallible>(resp)
                        }
                    });

                    // The two branches produce different concrete IO types
                    // (TlsStream vs plain TcpStream), so each calls the generic
                    // `serve_io` in its own arm — they can't share one variable
                    // without boxing.
                    match acceptor {
                        Some(acceptor) => {
                            // A bad client handshake is NOT fatal: log + drop.
                            // Bound the handshake so a slow client can't park
                            // here holding the accept Semaphore permit (the
                            // permit is dropped on every return below). 10s is
                            // hardcoded — generous for a real TLS handshake,
                            // tight enough to foil slowloris.
                            let tls_stream = match tokio::time::timeout(
                                Duration::from_secs(10),
                                acceptor.accept(tcp),
                            )
                            .await
                            {
                                Ok(Ok(s)) => s,
                                Ok(Err(e)) => {
                                    debug!(error = %e, "tls handshake failed");
                                    return;
                                }
                                Err(_) => {
                                    debug!("tls handshake timeout");
                                    return;
                                }
                            };
                            serve_io(
                                TokioIo::new(tls_stream),
                                svc,
                                max_req,
                                read_buf_cap,
                                conn_drain,
                            )
                            .await;
                        }
                        None => {
                            serve_io(TokioIo::new(tcp), svc, max_req, read_buf_cap, conn_drain)
                                .await;
                        }
                    }
                });
            }

            // ----- graceful drain -----
            // The accept loop broke on `drain_start`. Signal every in-flight
            // connection to graceful-shutdown (finish its current request, refuse
            // new keep-alive requests, then close), drop our own barrier token so
            // the only remaining `conn_token` senders are live connections, and
            // wait for them all to finish — bounded by the drain deadline.
            let _ = drain_sig_tx.send(true);
            drop(conn_token_tx);
            let deadline = Duration::from_millis(state.drain_timeout_ms());
            match tokio::time::timeout(deadline, conn_token_rx.recv()).await {
                Ok(_) => info!("graceful drain: all in-flight connections finished"),
                Err(_) => warn!("graceful drain: deadline elapsed; forcing remaining connections"),
            }
            state.signal_drain_done();
        });
    });

    // Block briefly until the spawned thread reports the bind+acceptor outcome.
    // Bind is fast, so this is a short wait; the thread continues into the
    // ready-gate + accept loop in the background after sending Ok.
    match boot_rx.recv() {
        Ok(Ok(())) => Ok(()),
        Ok(Err(msg)) => Err(msg),
        Err(_) => Err("server thread died before binding".into()),
    }
}

/// Serve one already-accepted connection with hyper's auto (H1+H2) builder.
/// Generic over the IO type so both the plaintext (`TokioIo<TcpStream>`) and the
/// TLS (`TokioIo<TlsStream<TcpStream>>`) branches share one body — the concrete
/// `TokioIo<...>` types differ, so this is the clean way to avoid boxing.
/// `serve_connection_with_upgrades` keeps the WS-upgrade path working over TLS.
async fn serve_io<I, S, B>(
    io: I,
    svc: S,
    max_req: usize,
    read_buf_cap: usize,
    mut drain: tokio::sync::watch::Receiver<bool>,
) where
    I: hyper::rt::Read + hyper::rt::Write + Unpin + Send + 'static,
    S: hyper::service::Service<Request<Incoming>, Response = Response<B>, Error = Infallible>
        + Send
        + 'static,
    S::Future: Send + 'static,
    B: http_body::Body + Send + 'static,
    B::Data: Send,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    let mut builder = auto::Builder::new(TokioExecutor::new());
    // Mirror the old header-byte cap and read-buffer sizing.
    builder
        .http1()
        .max_buf_size(max_req.max(read_buf_cap).max(8192));
    // Pin the connection so it can be both polled to completion AND, on drain,
    // told to `graceful_shutdown()` (finish the in-flight request, then close).
    let conn = builder.serve_connection_with_upgrades(io, svc);
    tokio::pin!(conn);
    tokio::select! {
        res = conn.as_mut() => {
            if let Err(e) = res {
                debug!(error = %e, "connection error");
            }
        }
        res = drain.changed() => {
            // The drain watch only ever transitions false→true (once), so a change
            // means drain was requested: stop serving new keep-alive requests on
            // this connection, let the current one finish, then close. (If the
            // watch sender vanished, just run to completion.) `changed()` yields
            // `()`, not a `watch::Ref`, so nothing `!Send` is held across the await.
            if res.is_ok() {
                conn.as_mut().graceful_shutdown();
            }
            if let Err(e) = conn.await {
                debug!(error = %e, "connection error (post-drain)");
            }
        }
    }
}

/// Case-insensitive single-header lookup as a trimmed `String`.
fn header_str(headers: &http::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
}

/// The hyper request handler: ports the historical `handle_conn` decision tree.
/// Returns `Infallible` error so the service never short-circuits the
/// connection — every failure is mapped to an HTTP response.
async fn handle_request(
    mut req: Request<Incoming>,
    state: Arc<AppState>,
) -> Result<Response<ResponseBody>, Infallible> {
    let pool = Arc::clone(&state.pool);
    let routes = Arc::clone(&state.routes);
    let cache = Arc::clone(&*state.cache.read());

    let method = req.method().as_str().to_owned();
    // path-and-query as the router expects (e.g. "/foo?a=1").
    let path = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_owned())
        .unwrap_or_else(|| req.uri().path().to_owned());
    let path_no_query = path.split('?').next().unwrap_or(&path);

    // ----- HEAD: static public assets only -----
    if method == "HEAD" {
        if let Some(file_path) = state.public_asset(&asset_lookup_key(path_no_query))
            && let Ok(bytes) = tokio::fs::read(&file_path).await
        {
            let ct = content_type_for(&file_path);
            let accept_enc = header_str(req.headers(), "accept-encoding").unwrap_or_default();
            let resp = static_asset_response(
                &accept_enc,
                ct,
                &file_path.to_string_lossy(),
                bytes,
                true,
                state.is_dev_mode(),
            );
            return Ok(resp);
        }
        if !state.path_under_action_prefix(path_no_query) {
            return Ok(body::error_404());
        }
        // else: fall through to action handling below.
    }

    // ----- method gate -----
    let under_actions = state.path_under_action_prefix(path_no_query);
    if !(method == "GET"
        || under_actions
        || method == "POST" && path_no_query.starts_with("/_brust/cache/invalidate")
        || method == "POST" && path_no_query == "/_brust/mcp")
    {
        return Ok(body::error_405());
    }

    // ----- /ping (native, bypasses pool) -----
    if path == "/ping" {
        return Ok(body::resp(200, "text/plain", &[], b"pong\n".to_vec()));
    }

    // ----- cache stats -----
    if path == "/_brust/cache/stats" {
        let stats = cache.stats();
        let json = serde_json::to_string(&stats).unwrap_or_else(|_| String::from("{}"));
        return Ok(body::resp(200, "application/json", &[], json.into_bytes()));
    }

    // ----- island chunks -----
    if let Some(file) = path.strip_prefix("/_brust/islands/") {
        let file = file.split('?').next().unwrap_or(file);
        if !is_safe_island_filename(file) {
            return Ok(body::error_404());
        }
        let Some(dir) = state.islands_dir() else {
            return Ok(body::error_404());
        };
        let file_path = dir.join(file);
        return match tokio::fs::read(&file_path).await {
            Ok(bytes) => {
                let accept_enc = header_str(req.headers(), "accept-encoding").unwrap_or_default();
                Ok(static_asset_response(
                    &accept_enc,
                    "application/javascript; charset=utf-8",
                    &file_path.to_string_lossy(),
                    bytes,
                    false,
                    state.is_dev_mode(),
                ))
            }
            Err(_) => Ok(body::error_404()),
        };
    }

    // ----- CSS chunks -----
    if let Some(file) = path.strip_prefix("/_brust/css/") {
        let file = file.split('?').next().unwrap_or(file);
        let Some(dir) = state.css_dir() else {
            return Ok(body::error_404());
        };
        // Component-CSS chunks live one level down in `components/<hash>.css`.
        // Allow exactly that subdir; the basename still goes through the
        // traversal-safe filename check (which rejects `/`, `\`, `..`).
        let file_path = if let Some(chunk) = file.strip_prefix("components/") {
            if !is_safe_css_filename(chunk) {
                return Ok(body::error_404());
            }
            dir.join("components").join(chunk)
        } else {
            if !is_safe_css_filename(file) {
                return Ok(body::error_404());
            }
            dir.join(file)
        };
        return match tokio::fs::read(&file_path).await {
            Ok(bytes) => {
                let accept_enc = header_str(req.headers(), "accept-encoding").unwrap_or_default();
                Ok(static_asset_response(
                    &accept_enc,
                    "text/css; charset=utf-8",
                    &file_path.to_string_lossy(),
                    bytes,
                    false,
                    state.is_dev_mode(),
                ))
            }
            Err(_) => Ok(body::error_404()),
        };
    }

    // ----- root-mapped public assets (GET only) -----
    if method == "GET"
        && let Some(file_path) = state.public_asset(&asset_lookup_key(path_no_query))
        && let Ok(bytes) = tokio::fs::read(&file_path).await
    {
        let ct = content_type_for(&file_path);
        let accept_enc = header_str(req.headers(), "accept-encoding").unwrap_or_default();
        return Ok(static_asset_response(
            &accept_enc,
            ct,
            &file_path.to_string_lossy(),
            bytes,
            false,
            state.is_dev_mode(),
        ));
    }

    // ----- action dispatch -----
    if under_actions {
        return handle_action(req, &state, &pool, &method, &path, path_no_query).await;
    }

    // ----- MCP -----
    if path == "/_brust/mcp" {
        return handle_mcp(req, &pool, &method, &path).await;
    }

    // ----- cache invalidate -----
    if path.starts_with("/_brust/cache/invalidate") {
        if method != "POST" {
            return Ok(body::error_405());
        }
        let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
        let mut target_path: Option<String> = None;
        let mut clear_all = false;
        for pair in query.split('&') {
            if pair.is_empty() {
                continue;
            }
            match pair.split_once('=') {
                Some(("path", v)) => target_path = Some(percent_decode(v)),
                Some(("all", v)) if v == "1" || v == "true" => clear_all = true,
                _ => {}
            }
        }
        let removed = if clear_all {
            cache.clear()
        } else if let Some(p) = target_path {
            cache.invalidate_path("GET", &p)
        } else {
            return Ok(body::resp(
                400,
                "application/json",
                &[],
                br#"{"error":"missing path or all parameter"}"#.to_vec(),
            ));
        };
        let body_json = format!(r#"{{"removed":{removed}}}"#);
        return Ok(body::resp(
            200,
            "application/json",
            &[],
            body_json.into_bytes(),
        ));
    }

    // ----- SSE -----
    if crate::realtime::sse::path_is_sse(&path) {
        return handle_sse(&pool, &method, &path, req.headers()).await;
    }

    // ----- WebSocket -----
    if crate::realtime::ws::path_is_ws(&path) {
        return handle_ws(&mut req, &pool, &method, &path).await;
    }

    // ----- SPA navigation interceptor -----
    if let Some(stripped) = path.strip_prefix("/_brust/page") {
        if method != "GET" {
            return Ok(body::error_405());
        }
        let real_path = if stripped.is_empty() { "/" } else { stripped };
        let envelope = match routes.match_path(&method, real_path, req.headers()) {
            MatchResult::Matched { mut envelope, .. } => {
                envelope.kind = "navigation";
                envelope
            }
            MatchResult::NoMatch => {
                return Ok(body::resp(
                    404,
                    "application/json; charset=utf-8",
                    &[],
                    br#"{"error":"not found"}"#.to_vec(),
                ));
            }
        };
        return Ok(dispatch_streaming(&pool, envelope, "navigation", None).await);
    }

    // ----- general route match -----
    let (mut envelope, route_id) = match routes.match_path(&method, &path, req.headers()) {
        MatchResult::Matched { envelope, route_id } => (envelope, route_id),
        MatchResult::NoMatch => {
            return Ok(body::error_404());
        }
    };

    // ----- L1 cache decision: bypass (route to L2) vs prefix (L1 key) -----
    // Assemble borrowed request data for the expression evaluator. The slices
    // must outlive the eval, so build them here (before any await).
    let cache_config = routes.cache_for(route_id);
    let compiled = routes.compiled_cache_for(route_id);

    let mut bypassed = false;
    let cache_key = match (&cache_config, &compiled) {
        (Some(_cfg), Some(cc)) if cc.prefix.is_some() || cc.bypass.is_some() => {
            // Header pairs (HeaderName is lowercase) + all cookies across every
            // Cookie header (reuse build_request_envelope's parsing semantics).
            let mut header_pairs: Vec<(&str, &str)> = Vec::new();
            let mut cookie_pairs: Vec<(&str, &str)> = Vec::new();
            let mut host = "";
            for (name, value) in req.headers().iter() {
                let n = name.as_str();
                if n.is_empty() {
                    continue;
                }
                let v = std::str::from_utf8(value.as_bytes()).unwrap_or("");
                if name == http::header::COOKIE {
                    for pair in v.split(';') {
                        let trimmed = pair.trim();
                        if let Some((k, val)) = trimmed.split_once('=') {
                            cookie_pairs.push((k.trim(), val.trim()));
                        }
                    }
                }
                if name == http::header::HOST {
                    host = v;
                }
                header_pairs.push((n, v));
            }
            // Query pairs (undecoded key=value; mirrors the L1 sorted_query).
            let raw_query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
            let mut query_pairs: Vec<(&str, &str)> = Vec::new();
            for pair in raw_query.split('&') {
                if pair.is_empty() {
                    continue;
                }
                match pair.split_once('=') {
                    Some((k, v)) => query_pairs.push((k, v)),
                    None => query_pairs.push((pair, "")),
                }
            }
            let scheme = if state.tls().is_some() {
                "https"
            } else {
                "http"
            };
            // Matched path params come straight off the envelope match_path
            // already produced, so `param(id)` keys an L1 cache per route param.
            let bare_path = path.split('?').next().unwrap_or(&path);
            let param_pairs: Vec<(&str, &str)> = envelope
                .params
                .iter()
                .map(|(k, v)| (k.as_ref(), *v))
                .collect();
            let ctx = crate::cache::key_expr::EvalCtx {
                headers: &header_pairs,
                cookies: &cookie_pairs,
                query: &query_pairs,
                params: &param_pairs,
                method: &method,
                host,
                scheme,
                path: bare_path,
            };

            let bypass_hit = match &cc.bypass {
                None => false,
                Some(None) => true, // always
                Some(Some(expr)) => !expr.eval(&ctx).is_empty(),
            };
            if bypass_hit {
                bypassed = true;
                None // skip L1 read AND write
            } else {
                let prefix = cc.prefix.as_ref().map(|e| e.eval(&ctx)).unwrap_or_default();
                Some(build_cache_key(&method, &path, prefix))
            }
        }
        // cache configured but no prefix/bypass exprs → default L1 key (no prefix).
        (Some(_cfg), _) => Some(build_cache_key(&method, &path, String::new())),
        _ => None,
    };

    if let Some(key) = &cache_key
        && let Some(bytes) = cache.get(key)
    {
        // Cached bytes are a complete framed HTTP/1.1 response. Stamp the L1 hit
        // so clients/CDNs can observe cache behaviour (`X-Brust-Cache: HIT`).
        let mut resp = body::response_from_framed_bytes(bytes);
        resp.headers_mut().insert(
            http::header::HeaderName::from_static("x-brust-cache"),
            http::HeaderValue::from_static("HIT"),
        );
        return Ok(resp);
    }

    // Propagate the bypass decision to the worker (L2 capture/replay runs there).
    envelope.bypassed = bypassed;

    // Build the L1 write-back (single-chunk shape only). Shared between the
    // native fast-lane and the React streaming path.
    let cache_writeback = match (&cache_key, &cache_config) {
        (Some(key), Some(cfg)) => Some(CacheWriteback {
            cache: Arc::clone(&cache),
            key: key.clone(),
            ttl: Duration::from_secs(cfg.ttl_seconds),
            tags: cfg.tags.clone().unwrap_or_default(),
        }),
        _ => None,
    };

    // Native (jinja) routes: single-chunk fast lane. Now L1-cacheable.
    if routes.native_template_for(route_id).is_some() {
        return Ok(dispatch_single_chunk(&pool, envelope, "render", cache_writeback).await);
    }

    // React render: streaming-capable. Cache write-back on the single-chunk
    // (Content-Length) shape only — Suspense streams are never cached.
    Ok(dispatch_streaming(&pool, envelope, "render", cache_writeback).await)
}

/// Cache write-back parameters threaded into the streaming dispatch.
struct CacheWriteback {
    cache: Arc<crate::cache::response_cache::ResponseCache>,
    key: CacheKey,
    ttl: Duration,
    /// Static route-level L1 tags (from `CacheConfig::tags`), carried into the
    /// L1 entry so `cache.invalidate({ tags })` can evict it. Empty for routes
    /// that declare no tags.
    tags: Vec<String>,
}

/// Action dispatch branch (single-chunk fast lane; never caches).
async fn handle_action(
    req: Request<Incoming>,
    state: &Arc<AppState>,
    pool: &Arc<crate::render::pool::WorkerPool>,
    method: &str,
    path: &str,
    path_no_query: &str,
) -> Result<Response<ResponseBody>, Infallible> {
    let rel_owned = state.with_action_prefix(|p| {
        let rel = &path_no_query[p.len()..];
        if rel.is_empty() {
            "/".to_string()
        } else {
            rel.to_string()
        }
    });
    let rel = rel_owned.as_str();
    let m = match crate::routing::action::Method::from_http(method) {
        Some(m) => m,
        None => return Ok(body::error_405()),
    };
    let outcome = state.with_action_router(|r| r.at(m, rel));
    use crate::routing::action::MatchOutcome;
    let (endpoint_id, owned_params) = match outcome {
        MatchOutcome::Found {
            endpoint_id,
            params,
        } => (endpoint_id, params),
        MatchOutcome::MethodNotAllowed => {
            return Ok(body::error_405());
        }
        MatchOutcome::NotFound => return Ok(body::error_404()),
    };

    // Body handling. RFC 7230 §3.3.3: absent CL and TE means no body. With hyper
    // we read the collected body; Transfer-Encoding/chunked is decoded by hyper
    // itself, so the historical 411 only applies to a request that explicitly
    // signalled chunked WITHOUT us being able to size it — hyper has already
    // de-chunked here, so we size by the collected length and cap it.
    let headers = req.headers().clone();
    let content_type = header_str(&headers, "content-type").unwrap_or_default();
    let ct_lower = content_type.to_ascii_lowercase();

    // Reject an oversized body from its declared Content-Length BEFORE reading it
    // (preserves the historical fast 413 — don't buffer 300 KB just to reject it).
    if let Some(cl) = header_str(&headers, "content-length").and_then(|s| s.parse::<usize>().ok())
        && cl > tuning().max_action_body_bytes
    {
        return Ok(body::error_413());
    }

    let body_bytes = match http_body_util::BodyExt::collect(req.into_body()).await {
        Ok(c) => c.to_bytes(),
        Err(_) => return Ok(body::error_400()),
    };
    if body_bytes.len() > tuning().max_action_body_bytes {
        return Ok(body::error_413());
    }

    let body_text_string: Option<String>;
    let body_b64_string: Option<String>;
    if ct_lower.is_empty()
        || ct_lower.starts_with("application/json")
        || ct_lower.starts_with("application/x-www-form-urlencoded")
    {
        match std::str::from_utf8(&body_bytes) {
            Ok(s) => {
                body_text_string = Some(s.to_string());
                body_b64_string = None;
            }
            Err(_) => return Ok(body::error_400()),
        }
    } else if ct_lower.starts_with("multipart/form-data") {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&body_bytes);
        body_text_string = None;
        body_b64_string = Some(b64);
    } else {
        return Ok(body::error_415());
    }

    let id_str = endpoint_id.to_string();
    let params_ref: Vec<(std::borrow::Cow<str>, &str)> = owned_params
        .iter()
        .map(|(k, v)| (std::borrow::Cow::Borrowed(k.as_str()), v.as_str()))
        .collect();
    let envelope = crate::routing::routes::build_action_envelope(
        method,
        path,
        &id_str,
        params_ref,
        &content_type,
        body_text_string.as_deref(),
        body_b64_string.as_deref(),
        &headers,
    );

    Ok(dispatch_single_chunk(pool, envelope, "action", None).await)
}

/// MCP JSON-RPC branch.
async fn handle_mcp(
    req: Request<Incoming>,
    pool: &Arc<crate::render::pool::WorkerPool>,
    method: &str,
    path: &str,
) -> Result<Response<ResponseBody>, Infallible> {
    if method != "POST" {
        return Ok(body::error_405());
    }
    let headers = req.headers().clone();
    let content_type = header_str(&headers, "content-type").unwrap_or_default();
    if !content_type
        .to_ascii_lowercase()
        .starts_with("application/json")
    {
        return Ok(body::error_415());
    }
    // Preserve the historical 411 (Content-Length required) semantics: an MCP
    // POST must carry an explicit Content-Length.
    if header_str(&headers, "content-length").is_none() {
        return Ok(body::error_411());
    }
    if let Some(cl) = header_str(&headers, "content-length").and_then(|s| s.parse::<usize>().ok())
        && cl > tuning().max_action_body_bytes
    {
        return Ok(body::error_413());
    }

    let body_bytes = match http_body_util::BodyExt::collect(req.into_body()).await {
        Ok(c) => c.to_bytes(),
        Err(_) => return Ok(body::error_400()),
    };
    if body_bytes.len() > tuning().max_action_body_bytes {
        return Ok(body::error_413());
    }
    let body_str = match std::str::from_utf8(&body_bytes) {
        Ok(s) => s,
        Err(_) => return Ok(body::error_400()),
    };

    let envelope = crate::routing::routes::build_mcp_envelope(method, path, body_str, &headers);
    Ok(dispatch_streaming(pool, envelope, "mcp", None).await)
}

/// SSE branch: validate, dispatch, await the open signal, then return a
/// streaming body fed by the per-connection SSE task.
async fn handle_sse(
    pool: &Arc<crate::render::pool::WorkerPool>,
    method: &str,
    path: &str,
    headers: &http::HeaderMap,
) -> Result<Response<ResponseBody>, Infallible> {
    if method != "GET" {
        return Ok(body::error_405());
    }
    let accept = header_str(headers, "accept").unwrap_or_default();
    let accept_lower = accept.to_ascii_lowercase();
    let accept_ok = accept_lower.is_empty()
        || accept_lower.contains("text/event-stream")
        || accept_lower.trim() == "*/*";
    if !accept_ok {
        return Ok(body::resp(
            406,
            "text/plain",
            &[],
            b"406 Not Acceptable".to_vec(),
        ));
    }

    let conn_id = crate::realtime::sse::next_conn_id();
    let (frame_tx, frame_rx) = tokio::sync::mpsc::channel::<crate::realtime::sse::SseFrame>(32);
    let (open_tx, open_rx) = tokio::sync::oneshot::channel::<crate::realtime::sse::SseOpenSignal>();
    crate::realtime::sse::registry().lock().insert(
        conn_id,
        crate::realtime::sse::SseConn {
            frame_tx,
            open_tx: Some(open_tx),
            abort_cb: None,
        },
    );

    let Some(entry) = pool.pick_least_busy() else {
        crate::realtime::sse::registry().lock().remove(&conn_id);
        return Ok(body::error_500());
    };
    let envelope = crate::routing::routes::build_sse_envelope(method, path, headers, conn_id);
    let envelope_json = match serde_json::to_string(&envelope) {
        Ok(json) => json,
        Err(e) => {
            error!(conn_id, error = %e, "sse envelope serialize failed");
            crate::realtime::sse::registry().lock().remove(&conn_id);
            return Ok(body::error_500());
        }
    };

    // The SSE dispatch Promise resolves only at STREAM END (the JS handler runs
    // the full reader loop before returning). So we must NOT await it here —
    // doing so would block this hyper service future for the whole stream and
    // wedge the body channel. Instead we run the dispatch as a detached task
    // (holding the in_flight_guard for its lifetime) and await only the open
    // signal, which the JS handler fires early via napi_sse_signal_open. The
    // per-conn SSE task drains frames + acks concurrently.
    let dispatch_entry = Arc::clone(&entry);
    tokio::spawn(async move {
        let _guard = dispatch_entry.in_flight_guard();
        // SSE owns the socket via the napiSse* registry and never reads or writes
        // the SAB response, so slot 0 is fine (no RenderClaim here — in_flight_guard
        // only). LOAD-BEARING for K>1: because SSE/WS hold no per-slot RenderClaim,
        // a concurrent HTTP render CAN hold slot 0 simultaneously. That is safe ONLY
        // as long as this JS handler never touches the SAB. Before render_slots>1 is
        // made safe (the K>1-enablement task), SSE/WS need a no-SAB dispatch variant
        // (or must assert they never write the SAB); do NOT let this path write the
        // slot-0 sub-region. See the Phase B plan, B-BLK / SSE-WS note.
        if let Err(e) = dispatch_entry
            .dispatch
            .call(envelope_json, 0)
            .await
            .map(|_| ())
        {
            error!(worker_id = dispatch_entry.id, error = %e, "sse tsfn call_async failed");
        }
    });

    let open = match tokio::time::timeout(Duration::from_secs(30), open_rx).await {
        Ok(Ok(signal)) => signal,
        Ok(Err(_)) => {
            warn!(
                conn_id,
                "sse open_tx sender dropped before signal — JS crash?"
            );
            crate::realtime::sse::registry().lock().remove(&conn_id);
            return Ok(body::error_500());
        }
        Err(_) => {
            warn!(conn_id, "sse open signal timeout (30s)");
            crate::realtime::sse::registry().lock().remove(&conn_id);
            return Ok(body::error_500());
        }
    };

    if open.status >= 400 {
        // Middleware rejection — a regular HTTP response with the body.
        crate::realtime::sse::registry().lock().remove(&conn_id);
        return Ok(body::resp(open.status, &open.content_type, &[], open.body));
    }

    // Open OK — return SSE headers + streaming body. The per-conn SSE task
    // pushes event frames into `tx`; client disconnect is detected via
    // `tx.closed()` (the body's receiver drops when hyper tears the conn down).
    debug!(conn_id, "sse open ok — returning streaming response");
    let (tx, rx) = tokio::sync::mpsc::channel::<Bytes>(32);
    crate::realtime::sse::spawn_sse_conn_task(tx, conn_id, frame_rx);

    let resp = Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-store")
        .header("x-accel-buffering", "no")
        .body(channel_body(rx))
        .unwrap_or_else(|_| body::error_500());
    Ok(resp)
}

/// WebSocket branch: validate handshake, dispatch for the middleware verdict,
/// then accept the upgrade via `hyper::upgrade::on` (3-step) and run the
/// existing ws driver loop on the upgraded stream.
async fn handle_ws(
    req: &mut Request<Incoming>,
    pool: &Arc<crate::render::pool::WorkerPool>,
    method: &str,
    path: &str,
) -> Result<Response<ResponseBody>, Infallible> {
    if method != "GET" {
        return Ok(body::error_405());
    }
    // Clone the request headers so the immutable handshake/envelope reads don't
    // conflict with the later `&mut req` borrow taken by `hyper::upgrade::on`.
    let headers = req.headers().clone();
    let handshake = match crate::realtime::ws::parse_ws_handshake(&headers) {
        Ok(h) => h,
        Err(_) => return Ok(body::error_400()),
    };

    let conn_id = crate::realtime::sse::next_conn_id();
    let (send_tx, send_rx) = tokio::sync::mpsc::channel::<crate::realtime::ws::WsOutgoing>(32);
    let (open_tx, open_rx) = tokio::sync::oneshot::channel::<crate::realtime::ws::WsOpenSignal>();
    crate::realtime::ws::registry().lock().insert(
        conn_id,
        crate::realtime::ws::WsConn {
            send_tx,
            open_tx: Some(open_tx),
            on_message: None,
            on_close: None,
        },
    );

    let crate::realtime::ws::ParsedHandshake {
        sec_websocket_key,
        client_subprotocols,
    } = handshake;

    let open = if path == "/_brust/dev" {
        crate::realtime::ws::dev_client_add(conn_id);
        crate::realtime::ws::WsOpenSignal {
            status: 101,
            body: Vec::new(),
            content_type: String::new(),
            subprotocol: String::new(),
        }
    } else {
        let Some(entry) = pool.pick_least_busy() else {
            crate::realtime::ws::registry().lock().remove(&conn_id);
            return Ok(body::error_500());
        };
        let envelope = crate::routing::routes::build_ws_envelope(
            method,
            path,
            &headers,
            conn_id,
            client_subprotocols,
        );
        let envelope_json = match serde_json::to_string(&envelope) {
            Ok(json) => json,
            Err(e) => {
                error!(conn_id, error = %e, "ws envelope serialize failed");
                crate::realtime::ws::registry().lock().remove(&conn_id);
                return Ok(body::error_500());
            }
        };
        {
            let _guard = entry.in_flight_guard();
            // WS owns the socket via the napiWs* registry and never reads or writes
            // the SAB response, so slot 0 is fine (no RenderClaim here —
            // in_flight_guard only). LOAD-BEARING for K>1: see the matching SSE note
            // above — SSE/WS hold no per-slot claim, so a concurrent render can own
            // slot 0; safe only while this handler never touches the SAB. Needs a
            // no-SAB dispatch variant before render_slots>1 is enabled.
            if let Err(e) = entry.dispatch.call(envelope_json, 0).await.map(|_| ()) {
                error!(worker_id = entry.id, error = %e, "ws dispatch failed");
                crate::realtime::ws::registry().lock().remove(&conn_id);
                return Ok(body::error_500());
            }
        }
        match tokio::time::timeout(Duration::from_secs(30), open_rx).await {
            Ok(Ok(signal)) => signal,
            Ok(Err(_)) => {
                warn!(
                    conn_id,
                    "ws open_tx sender dropped before signal — JS crash?"
                );
                crate::realtime::ws::registry().lock().remove(&conn_id);
                return Ok(body::error_500());
            }
            Err(_) => {
                warn!(conn_id, "ws open signal timeout (30s)");
                crate::realtime::ws::registry().lock().remove(&conn_id);
                return Ok(body::error_500());
            }
        }
    };

    if open.status != 101 {
        crate::realtime::ws::registry().lock().remove(&conn_id);
        return Ok(body::resp(open.status, &open.content_type, &[], open.body));
    }

    // 101 happy path: take the upgrade future BEFORE building the response.
    let on_upg = hyper::upgrade::on(&mut *req);
    let accept = crate::realtime::ws::compute_sec_accept(&sec_websocket_key);

    let mut builder = Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(UPGRADE, "websocket")
        .header(CONNECTION, "Upgrade")
        .header(SEC_WEBSOCKET_ACCEPT, accept);
    if !open.subprotocol.is_empty()
        && let Ok(v) = http::HeaderValue::from_str(&open.subprotocol)
    {
        builder = builder.header(SEC_WEBSOCKET_PROTOCOL, v);
    }
    let resp = builder
        .body(empty_body())
        .unwrap_or_else(|_| body::error_500());

    // Drive the upgrade + ws loop once hyper completes the 101.
    tokio::spawn(async move {
        match on_upg.await {
            Ok(upgraded) => {
                use tokio_tungstenite::tungstenite::protocol::Role;
                let io = TokioIo::new(upgraded);
                let ws_stream =
                    tokio_tungstenite::WebSocketStream::from_raw_socket(io, Role::Server, None)
                        .await;
                crate::realtime::ws::ws_conn_task(ws_stream, conn_id, send_rx, 30_000, 1_048_576)
                    .await;
            }
            Err(e) => {
                debug!(conn_id, error = %e, "ws upgrade failed");
                crate::realtime::ws::registry().lock().remove(&conn_id);
                crate::realtime::ws::dev_client_remove(conn_id);
            }
        }
    });

    Ok(resp)
}

/// Why `claim_or_wait` gave up without a worker.
enum ClaimWaitErr {
    /// No workers registered at all — none will ever appear, so 503 at once.
    NoWorkers,
    /// Every worker stayed busy until `claim_timeout_ms` — 503 last-resort.
    Timeout,
}

/// Claim a render worker, AWAITING a free one (up to `claim_timeout_ms`) on
/// AllBusy instead of failing fast with 503. `PoolEmpty` is never waited on.
async fn claim_or_wait(
    pool: &crate::render::pool::WorkerPool,
    mut try_claim: impl FnMut() -> crate::render::pool::ClaimResult,
) -> Result<crate::render::pool::RenderClaim, ClaimWaitErr> {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(tuning().claim_timeout_ms);
    loop {
        let notified = pool.idle_notify().notified();
        tokio::pin!(notified);
        notified.as_mut().enable();

        match try_claim() {
            crate::render::pool::ClaimResult::Claimed(c) => return Ok(c),
            crate::render::pool::ClaimResult::PoolEmpty => return Err(ClaimWaitErr::NoWorkers),
            crate::render::pool::ClaimResult::AllBusy => {}
        }

        tokio::select! {
            _ = &mut notified => {}
            _ = tokio::time::sleep_until(deadline) => return Err(ClaimWaitErr::Timeout),
        }
    }
}

/// Decode a fast-lane SAB framed response `[meta_len][meta][body]` into the
/// parsed `ChunkMeta` + owned body bytes. Callers build the typed Response (and
/// the cache's framed bytes when caching) from these parts.
fn decode_fast_lane(
    buf: &[u8],
) -> Result<(crate::render::stream::ChunkMeta, Vec<u8>), &'static str> {
    crate::render::stream::split_meta(buf).and_then(|(meta_slice, body)| {
        serde_json::from_slice::<crate::render::stream::ChunkMeta>(meta_slice)
            .map(|meta| (meta, body.to_vec()))
            .map_err(|_| "fast-lane meta JSON parse failed")
    })
}

/// Maximally-stripped dispatch for guaranteed-single-chunk requests (actions +
/// native renders). The worker MUST take the fast lane (write
/// `[meta_len][meta][body]` into the SAB and resolve with its byte length).
async fn dispatch_single_chunk<E>(
    pool: &Arc<crate::render::pool::WorkerPool>,
    envelope: E,
    label: &'static str,
    writeback: Option<CacheWriteback>,
) -> Response<ResponseBody>
where
    E: serde::Serialize,
{
    let claim = match claim_or_wait(pool, || pool.try_claim_render_lockfree()).await {
        Ok(c) => c,
        Err(ClaimWaitErr::NoWorkers) => {
            return body::error_503("no workers");
        }
        Err(ClaimWaitErr::Timeout) => {
            return body::error_503("all workers busy");
        }
    };
    let entry = Arc::clone(claim.entry());
    let slot = claim.slot();

    // FIX: pass the request envelope INLINE (see dispatch_streaming) — the SAB
    // request write was not reliably visible to the worker under the multi-thread
    // runtime. The SAB is still used for the worker's RESPONSE.
    let envelope_json = match serde_json::to_string(&envelope) {
        Ok(s) => s,
        Err(e) => {
            error!(worker_id = entry.id, label, error = %e, "envelope serialization failed");
            return body::error_500();
        }
    };

    let resp_len = match entry.dispatch.call(envelope_json, slot).await {
        Ok(len) => len,
        Err(e @ crate::render::RenderError::EnqueueFailed(_)) => {
            error!(worker_id = entry.id, label, error = %e,
                   "render tsfn enqueue failed — worker dead, removing from pool");
            pool.remove(entry.id);
            if pool.registered_count() == 0 {
                error!("no workers left after enqueue failure — terminating process");
                std::process::exit(1);
            }
            return body::resp(502, "text/plain", &[], b"bad gateway".to_vec());
        }
        Err(e @ crate::render::RenderError::PromiseRejected(_)) => {
            error!(worker_id = entry.id, label, error = %e,
                   "render tsfn JS Promise rejected — worker still alive");
            return body::error_500();
        }
    };

    if resp_len == 0 || (resp_len as usize) > entry.dispatch.buf_slot(slot).1 {
        error!(
            worker_id = entry.id,
            label,
            resp_len,
            buf_len = entry.dispatch.buf_slot(slot).1,
            "single-chunk dispatch got invalid resp_len (0 = worker used chunk channel)"
        );
        return body::error_500();
    }

    // SAFETY: render Promise resolved (happens-before via napi tsfn.await), JS
    // done writing the slot's SAB sub-region; resp_len bounds-checked above.
    let (buf_ptr, _cap) = entry.dispatch.buf_slot(slot);
    let buf = unsafe { std::slice::from_raw_parts(buf_ptr, resp_len as usize) };
    match decode_fast_lane(buf) {
        Ok((meta, body_bytes)) => {
            // L1 write-back: single-chunk only (always true here), skip when the
            // response sets a cookie (per-client — never cache).
            if let Some(wb) = writeback {
                if !meta_cacheable(&meta) {
                    tracing::warn!(
                        label,
                        "skipping cache write-back: response not cacheable (non-200 or Set-Cookie)"
                    );
                } else {
                    let framed =
                        crate::render::stream::build_single_response_bytes(&meta, &body_bytes);
                    wb.cache.insert(wb.key, framed, wb.ttl, &wb.tags);
                }
            }
            crate::render::stream::response_from_meta(&meta, body_bytes)
        }
        Err(e) => {
            error!(
                worker_id = entry.id,
                label,
                error = e,
                "single-chunk response decode failed"
            );
            body::error_500()
        }
    }
}

/// Streaming-capable dispatch (render/navigation/mcp). Claims a worker, kicks
/// off the render Promise WITHOUT awaiting, then resolves the FIRST chunk (or a
/// fast-lane SAB resolution) to learn the response shape. Buffered
/// (Content-Length) responses are returned whole (with cache write-back);
/// chunked (Suspense) responses return a streaming `BoxBody` whose remaining
/// frames a spawned task pumps in. Hyper owns Transfer-Encoding framing, so the
/// body channel carries RAW payload bytes (never HTTP/1.1 chunk markers).
async fn dispatch_streaming<E>(
    pool: &Arc<crate::render::pool::WorkerPool>,
    envelope: E,
    label: &'static str,
    cache_writeback: Option<CacheWriteback>,
) -> Response<ResponseBody>
where
    E: serde::Serialize,
{
    let (chunk_tx, mut chunk_rx) =
        tokio::sync::mpsc::channel::<crate::render::pool::RenderChunk>(1);

    let claim = match claim_or_wait(pool, || pool.try_claim_render(chunk_tx.clone())).await {
        Ok(c) => c,
        Err(ClaimWaitErr::NoWorkers) => {
            return body::error_503("no workers");
        }
        Err(ClaimWaitErr::Timeout) => {
            return body::error_503("all workers busy");
        }
    };
    let entry = Arc::clone(claim.entry());
    // Read the slot before `claim` is moved into spawn_chunk_pump (it's `u32` Copy).
    let slot = claim.slot();

    // FIX: pass the request envelope INLINE (marshaled as a String through
    // napi) instead of via the worker's SAB. The streaming/chunk path's SAB
    // request write was not reliably visible to the worker under the multi-thread
    // runtime (worker read a stale prior response). Inline avoids the shared-mem
    // visibility dependency; the SAB is still used for the RESPONSE chunks.
    let envelope_json = match serde_json::to_string(&envelope) {
        Ok(s) => s,
        Err(e) => {
            error!(worker_id = entry.id, label, error = %e, "envelope serialization failed");
            return body::error_500();
        }
    };

    // The render future is `'static`, so it can be moved into the chunk-pump task
    // on the chunked path. `claim` (the RAII slot/in-flight guard) is moved
    // alongside it so the worker stays reserved for the entire stream — on the
    // buffered path it is dropped when this fn returns, exactly like the old
    // RAII lifetime.
    let entry_for_future = Arc::clone(&entry);
    let render_future = async move {
        match entry_for_future.dispatch.call(envelope_json, slot).await {
            Ok(len) => RenderOutcome::Resolved(len),
            Err(e @ crate::render::RenderError::EnqueueFailed(_)) => {
                RenderOutcome::EnqueueFailed(e)
            }
            Err(e @ crate::render::RenderError::PromiseRejected(_)) => {
                RenderOutcome::PromiseRejected(e)
            }
        }
    };
    let mut render_future = Box::pin(render_future);

    let pool = Arc::clone(pool);

    // Phase 1: learn the response shape from the first chunk or fast-lane.
    // The `loop` guards the refutable `Some(chunk) = chunk_rx.recv()` select
    // arm (a closed channel would otherwise fall through with no branch); every
    // reachable arm `return`s, so it executes at most once.
    #[allow(clippy::never_loop)]
    loop {
        tokio::select! {
            biased;
            Some(chunk) = chunk_rx.recv() => {
                let (data, ack, is_final) = match chunk {
                    crate::render::pool::RenderChunk::Bytes { data, ack } => (data, ack, false),
                    crate::render::pool::RenderChunk::BytesAndFinal { data, ack } => (data, ack, true),
                    crate::render::pool::RenderChunk::Final { ack } => {
                        let _ = ack.send(());
                        let meta = crate::render::stream::ChunkMeta::default();
                        return crate::render::stream::response_from_meta(&meta, Vec::new());
                    }
                };
                let (meta, body_off) = match parse_chunk_meta(&data, &entry, label) {
                    Ok(p) => p,
                    Err(resp) => { let _ = ack.send(()); return *resp; }
                };
                let body = data[body_off..].to_vec();

                if meta.streaming {
                    // Chunked (Suspense). Build the head response (hyper adds
                    // Transfer-Encoding). Feed chunk #0's raw payload to the body
                    // channel, then hand the rest to a pump task.
                    let (tx, rx) = tokio::sync::mpsc::channel::<Bytes>(4);
                    if !body.is_empty() && tx.send(Bytes::from(body)).await.is_err() {
                        // Client already gone before the opening chunk landed.
                        // We must NOT drop the claim while the render future is
                        // still in-flight (the worker may still be writing the
                        // SAB). ACK chunk #0, then hand off to the pump to DRAIN
                        // the worker to completion holding the claim — the pump
                        // sees the dead `tx` immediately and discards bytes while
                        // ACKing until the render settles / a Final arrives.
                        // EXCEPTION: a BytesAndFinal chunk #0 means the worker is
                        // already done — nothing left to drain — so drop directly.
                        let _ = ack.send(());
                        if !is_final {
                            spawn_chunk_pump(render_future, chunk_rx, tx, entry, pool, label, claim);
                        } else {
                            drop(claim);
                        }
                        // The rx is dead, but hyper still gets a Response (it
                        // discards the body).
                        return chunked_response_from_meta(&meta, rx);
                    }
                    let _ = ack.send(());
                    if !is_final {
                        spawn_chunk_pump(render_future, chunk_rx, tx, entry, pool, label, claim);
                    } else {
                        drop(claim);
                    }
                    return chunked_response_from_meta(&meta, rx);
                }

                // Buffered (Content-Length).
                let _ = ack.send(());
                if is_final {
                    if let Some(wb) = cache_writeback {
                        if !meta_cacheable(&meta) {
                            tracing::warn!(
                                label,
                                "skipping cache write-back: response not cacheable (non-200 or Set-Cookie)"
                            );
                        } else {
                            let framed =
                                crate::render::stream::build_single_response_bytes(&meta, &body);
                            wb.cache.insert(wb.key, framed, wb.ttl, &wb.tags);
                        }
                    }
                    return crate::render::stream::response_from_meta(&meta, body);
                }
                // Keep draining until Final / render resolution.
                let mut buffered = body;
                loop {
                    tokio::select! {
                        biased;
                        Some(next) = chunk_rx.recv() => {
                            match next {
                                crate::render::pool::RenderChunk::Bytes { data, ack } => {
                                    buffered.extend_from_slice(&data);
                                    let _ = ack.send(());
                                }
                                crate::render::pool::RenderChunk::BytesAndFinal { data, ack } => {
                                    buffered.extend_from_slice(&data);
                                    let _ = ack.send(());
                                    break;
                                }
                                crate::render::pool::RenderChunk::Final { ack } => {
                                    let _ = ack.send(());
                                    break;
                                }
                            }
                        }
                        outcome = &mut render_future => {
                            if let RenderOutcome::EnqueueFailed(e) = &outcome {
                                error!(worker_id = entry.id, label, error = %e,
                                       "render tsfn enqueue failed mid-buffer — removing worker");
                                pool.remove(entry.id);
                                if pool.registered_count() == 0 { std::process::exit(1); }
                            }
                            break;
                        }
                    }
                }
                if let Some(wb) = cache_writeback {
                    if !meta_cacheable(&meta) {
                        tracing::warn!(
                            label,
                            "skipping cache write-back: response not cacheable (non-200 or Set-Cookie)"
                        );
                    } else {
                        let framed =
                            crate::render::stream::build_single_response_bytes(&meta, &buffered);
                        wb.cache.insert(wb.key, framed, wb.ttl, &wb.tags);
                    }
                }
                return crate::render::stream::response_from_meta(&meta, buffered);
            }
            outcome = &mut render_future => {
                match outcome {
                    RenderOutcome::Resolved(resp_len) => {
                        if resp_len > 0 {
                            let len = resp_len as usize;
                            if len > entry.dispatch.buf_slot(slot).1 {
                                error!(worker_id = entry.id, label, len,
                                       buf_len = entry.dispatch.buf_slot(slot).1,
                                       "fast-lane resp_len exceeds SAB capacity");
                                return body::error_500();
                            }
                            let (buf_ptr, _cap) = entry.dispatch.buf_slot(slot);
                            let buf = unsafe { std::slice::from_raw_parts(buf_ptr, len) };
                            match decode_fast_lane(buf) {
                                Ok((meta, body_bytes)) => {
                                    if let Some(wb) = cache_writeback {
                                        if !meta_cacheable(&meta) {
                                            tracing::warn!(
                                                label,
                                                "skipping cache write-back: response not cacheable (non-200 or Set-Cookie)"
                                            );
                                        } else {
                                            let framed = crate::render::stream::build_single_response_bytes(&meta, &body_bytes);
                                            wb.cache.insert(wb.key, framed, wb.ttl, &wb.tags);
                                        }
                                    }
                                    return crate::render::stream::response_from_meta(&meta, body_bytes);
                                }
                                Err(e) => {
                                    error!(worker_id = entry.id, label, error = e,
                                           "fast-lane response decode failed");
                                    return body::error_500();
                                }
                            }
                        }
                        let meta = crate::render::stream::ChunkMeta::default();
                        return crate::render::stream::response_from_meta(&meta, Vec::new());
                    }
                    RenderOutcome::PromiseRejected(e) => {
                        error!(worker_id = entry.id, label, error = %e,
                               "render tsfn JS Promise rejected — worker still alive");
                        return body::error_500();
                    }
                    RenderOutcome::EnqueueFailed(e) => {
                        error!(worker_id = entry.id, label, error = %e,
                               "render tsfn enqueue failed — worker dead, removing from pool");
                        pool.remove(entry.id);
                        if pool.registered_count() == 0 {
                            error!("no workers left after enqueue failure — terminating process");
                            std::process::exit(1);
                        }
                        return body::resp(502, "text/plain", &[], b"bad gateway".to_vec());
                    }
                }
            }
        }
    }
}

/// The render-Promise resolution outcome. Lives at module scope so the chunk
/// pump task (which the render future is moved into) names the same type.
enum RenderOutcome {
    EnqueueFailed(crate::render::RenderError),
    PromiseRejected(crate::render::RenderError),
    Resolved(u32),
}

/// Parse the first-chunk meta, returning (meta, body_offset_in_data).
fn parse_chunk_meta(
    data: &[u8],
    entry: &crate::render::pool::WorkerEntry,
    label: &'static str,
) -> Result<(crate::render::stream::ChunkMeta, usize), Box<Response<ResponseBody>>> {
    let (meta_slice, body) = match crate::render::stream::split_meta(data) {
        Ok(x) => x,
        Err(e) => {
            error!(worker_id = entry.id, label, error = e, "split_meta failed");
            return Err(Box::new(body::error_500()));
        }
    };
    let parsed: crate::render::stream::ChunkMeta = match serde_json::from_slice(meta_slice) {
        Ok(m) => m,
        Err(e) => {
            error!(worker_id = entry.id, label, error = %e, "meta JSON parse failed");
            return Err(Box::new(body::error_500()));
        }
    };
    let body_off = data.len() - body.len();
    Ok((parsed, body_off))
}

/// Build the chunked-mode streaming Response: status + headers from the meta
/// (Content-Type, extra headers; NO Transfer-Encoding — hyper adds it), body =
/// the raw-payload channel.
fn chunked_response_from_meta(
    meta: &crate::render::stream::ChunkMeta,
    rx: tokio::sync::mpsc::Receiver<Bytes>,
) -> Response<ResponseBody> {
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(meta.status).unwrap_or(StatusCode::OK))
        .header("content-type", meta.content_type.clone());
    for (k, v) in &meta.headers {
        if k.eq_ignore_ascii_case("content-length")
            || k.eq_ignore_ascii_case("transfer-encoding")
            || k.eq_ignore_ascii_case("connection")
            || k.eq_ignore_ascii_case("content-type")
        {
            continue;
        }
        if let (Ok(name), Ok(val)) = (
            http::header::HeaderName::from_bytes(k.as_bytes()),
            http::HeaderValue::from_str(v),
        ) {
            builder = builder.header(name, val);
        }
    }
    builder
        .body(channel_body(rx))
        .unwrap_or_else(|_| body::error_500())
}

/// Pump remaining chunks of a chunked (Suspense) stream into the body channel.
/// Owns the render future + claim so the worker stays reserved until the stream
/// ends. Raw payloads only — hyper frames them as Transfer-Encoding: chunked.
fn spawn_chunk_pump(
    mut render_future: std::pin::Pin<Box<dyn std::future::Future<Output = RenderOutcome> + Send>>,
    mut chunk_rx: tokio::sync::mpsc::Receiver<crate::render::pool::RenderChunk>,
    tx: tokio::sync::mpsc::Sender<Bytes>,
    entry: Arc<crate::render::pool::WorkerEntry>,
    pool: Arc<crate::render::pool::WorkerPool>,
    label: &'static str,
    claim: crate::render::pool::RenderClaim,
) {
    tokio::spawn(async move {
        // Keep the claim alive for the stream lifetime. INVARIANT: this claim is
        // NOT released until the worker's render future settles or a
        // Final/BytesAndFinal arrives. On client disconnect we DRAIN (keep
        // receiving + ACKing chunks so the worker proceeds, discarding the bytes)
        // rather than breaking early — breaking would free the worker while its
        // JS render is still writing the SAB, letting a new request claim and
        // corrupt it.
        let _claim = claim;
        let mut client_gone = false;
        loop {
            tokio::select! {
                biased;
                Some(chunk) = chunk_rx.recv() => {
                    match chunk {
                        crate::render::pool::RenderChunk::Bytes { data, ack } => {
                            // Once the client is gone, stop forwarding; just keep
                            // ACKing so the worker drains to completion.
                            if !client_gone && tx.send(Bytes::from(data)).await.is_err() {
                                client_gone = true;
                            }
                            let _ = ack.send(());
                        }
                        crate::render::pool::RenderChunk::BytesAndFinal { data, ack } => {
                            if !client_gone {
                                let _ = tx.send(Bytes::from(data)).await;
                            }
                            let _ = ack.send(());
                            break;
                        }
                        crate::render::pool::RenderChunk::Final { ack } => {
                            let _ = ack.send(());
                            break;
                        }
                    }
                }
                outcome = &mut render_future => {
                    match outcome {
                        RenderOutcome::Resolved(_) => break,
                        RenderOutcome::PromiseRejected(e) => {
                            error!(worker_id = entry.id, label, error = %e,
                                   "stream tsfn rejected mid-stream");
                            break;
                        }
                        RenderOutcome::EnqueueFailed(e) => {
                            error!(worker_id = entry.id, label, error = %e,
                                   "stream tsfn enqueue failed mid-stream — removing worker");
                            pool.remove(entry.id);
                            if pool.registered_count() == 0 { std::process::exit(1); }
                            break;
                        }
                    }
                }
            }
        }
        // tx drops here → body completes → hyper writes the chunked terminator.
    });
}

fn build_cache_key(method: &str, full_path: &str, prefix: String) -> CacheKey {
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

/// True if the response meta carries a `Set-Cookie` header (case-insensitive).
/// A response may enter the shared L1 cache only as a plain 200 WITHOUT
/// Set-Cookie. The status gate is load-bearing: a transient loader/render
/// failure arrives as a framed 500 through the SAME fast-lane length return as
/// a success (`napi_render_jinja` converts errors to framed 500s instead of
/// throwing; JS catch paths pack 500/413 the same way), so without it one
/// flaky render would poison the cache for the full ttl_seconds. A Set-Cookie
/// response is per-client and would leak a session cookie to the next
/// requester.
fn meta_cacheable(meta: &crate::render::stream::ChunkMeta) -> bool {
    meta.status == 200
        && !meta
            .headers
            .keys()
            .any(|h| h.eq_ignore_ascii_case("set-cookie"))
}

fn sort_query(query: &str) -> String {
    if query.is_empty() {
        return String::new();
    }
    let mut pairs: Vec<&str> = query.split('&').filter(|p| !p.is_empty()).collect();
    pairs.sort_unstable();
    pairs.join("&")
}

/// Minimal percent-decode for query-string values in native endpoints.
/// Handles `%xx` and `+` → space; unrecognised escapes pass through.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                match (hi, lo) {
                    (Some(h), Some(l)) => {
                        out.push(((h << 4) | l) as u8);
                        i += 3;
                    }
                    _ => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Boot-error propagation: binding `start` to an address already held by a
    /// live `TcpListener` must return `Err(..)` (a normal value the napi layer
    /// maps to a thrown JS error), NOT call `process::exit` and kill the host.
    #[test]
    fn start_returns_err_when_addr_already_bound() {
        // Hold an ephemeral port for the duration of the test.
        let occupied = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = occupied.local_addr().unwrap();

        let state = Arc::new(AppState::new());
        let res = start(addr, state, 1, Tuning::default());

        assert!(
            res.is_err(),
            "start should return Err on bind failure, got {res:?}"
        );
        let msg = res.unwrap_err();
        assert!(
            msg.contains("bind failed"),
            "unexpected error message: {msg}"
        );
    }

    #[test]
    fn build_cache_key_sorts_query_and_applies_prefix() {
        let k = build_cache_key("GET", "/p?b=2&a=1", "tenant-acme".to_string());
        assert_eq!(k.prefix, "tenant-acme");
        assert_eq!(k.path, "/p");
        assert_eq!(k.sorted_query, "a=1&b=2");
    }

    /// Regression: RenderClaim early-drop race on mid-stream client disconnect.
    ///
    /// When a client disconnects mid-Suspense-stream, `spawn_chunk_pump` MUST
    /// keep holding the worker's `RenderClaim` (draining + ACKing chunks so the
    /// worker proceeds, discarding bytes) until the render future settles or a
    /// `Final`/`BytesAndFinal` arrives. If it released the claim on the first
    /// failed `tx.send` (the old bug), the worker's `idle` flag flips back to
    /// `true` and a DIFFERENT request could claim it WHILE the old JS render is
    /// still writing the worker's SAB → corruption / UAF.
    ///
    /// This drives `spawn_chunk_pump` at its narrowest seam: a real
    /// `WorkerPool`-issued claim (so `idle`/`in_flight` are observable), a
    /// render future we hold pending via a oneshot (modelling the in-flight JS
    /// Promise), and a body `tx` whose `rx` we drop to simulate the dead client.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn disconnect_mid_stream_holds_claim_until_render_settles() {
        use crate::render::dispatch::MockDispatch;
        use crate::render::pool::{ClaimResult, RenderChunk, WorkerPool};
        use std::sync::atomic::Ordering;
        use tokio::sync::{mpsc, oneshot};

        let pool = Arc::new(WorkerPool::new());
        let id = pool.register(Box::new(MockDispatch::new()));
        let entry = pool.entry(id).expect("registered worker");

        // Claim the worker exactly as dispatch_streaming does.
        let (chunk_tx, chunk_rx) = mpsc::channel::<RenderChunk>(1);
        let claim = match pool.try_claim_render(chunk_tx.clone()) {
            ClaimResult::Claimed(c) => c,
            _ => panic!("expected Claimed"),
        };
        assert!(!entry.slot(0).is_idle(), "worker claimed → not idle");

        // Render future modelling the in-flight JS Promise: pending until we
        // fire `render_done`. While pending, the worker's SAB is still "owned"
        // by this render, so the claim MUST NOT be released.
        let (render_done, render_done_rx) = oneshot::channel::<()>();
        let render_future: std::pin::Pin<
            Box<dyn std::future::Future<Output = RenderOutcome> + Send>,
        > = Box::pin(async move {
            let _ = render_done_rx.await;
            RenderOutcome::Resolved(0)
        });

        // Body channel; drop the receiver → client is gone, so the pump's first
        // `tx.send` errors.
        let (tx, rx) = mpsc::channel::<Bytes>(4);
        drop(rx);

        spawn_chunk_pump(
            render_future,
            chunk_rx,
            tx,
            Arc::clone(&entry),
            Arc::clone(&pool),
            "test",
            claim,
        );

        // Send a mid-stream Bytes chunk: client is gone (tx.send fails), but the
        // render future is STILL pending. The pump must DRAIN (ack so the worker
        // proceeds) and KEEP the claim.
        let (ack_tx, ack_rx) = oneshot::channel::<()>();
        chunk_tx
            .send(RenderChunk::Bytes {
                data: vec![1, 2, 3],
                ack: ack_tx,
            })
            .await
            .expect("pump should still be receiving");
        // The worker must be ACKed (it keeps producing) ...
        ack_rx
            .await
            .expect("pump must ack drained chunk so worker proceeds");
        // ... and let the pump task run to its next await (loop back to recv).
        tokio::task::yield_now().await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        tokio::task::yield_now().await;

        // INVARIANT: claim still held — render future has NOT settled. The buggy
        // pump `break`s on the failed tx.send, dropping the claim here.
        assert!(
            !entry.slot(0).is_idle(),
            "claim must be held while render future is pending (worker mid-write)",
        );
        assert!(
            matches!(
                pool.try_claim_render(chunk_tx.clone()),
                ClaimResult::AllBusy
            ),
            "worker must NOT be re-claimable while its render is in-flight",
        );

        // Now the render settles → claim may be released.
        let _ = render_done.send(());
        // Let the pump observe the resolved future and drop the claim.
        for _ in 0..8 {
            tokio::task::yield_now().await;
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            entry.slot(0).is_idle(),
            "claim must be released once the render future settles",
        );
        assert_eq!(
            entry.in_flight.load(Ordering::Relaxed),
            0,
            "in_flight must drain after release",
        );
    }
}
