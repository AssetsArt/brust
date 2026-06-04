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
use tracing::{debug, error, warn};

use crate::cache::response_cache::{CacheConfig, CacheKey};
use crate::config::AppState;
use crate::routing::routes::MatchResult;
use crate::server::body::{ResponseBody, channel_body, empty_body, raw_http_to_response};

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
pub fn start(addr: SocketAddr, state: Arc<AppState>, conn_workers: usize, tuning: Tuning) {
    // Set the process-wide tunables before any connection is served. `start`
    // runs once per process (re-serve is rejected in begin_serve), so a
    // best-effort set is correct; the Err arm only fires if already set.
    let _ = TUNING.set(tuning);

    // The accept-concurrency ceiling: the larger of the historical accept queue
    // depth and any explicit connWorkers override (both default-coupled to the
    // render-worker count in the binding).
    let accept_cap = tuning.conn_queue_cap.max(conn_workers).max(1);

    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(tuning.worker_threads.max(1))
            .enable_all()
            .build()
            .expect("tokio runtime");
        rt.block_on(async move {
            let listener = match tokio::net::TcpListener::bind(addr).await {
                Ok(l) => l,
                Err(e) => {
                    error!(error = %e, %addr, "bind failed");
                    std::process::exit(1);
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
                        std::process::exit(1);
                    }
                },
                None => None,
            };

            state.ready.notified().await; // wait until all napi workers registered
            let tls_label = if acceptor.is_some() { ", tls" } else { "" };
            println!("[brust] listening on {addr} (io: {IO_NAME}{tls_label})");
            let _ = std::io::Write::flush(&mut std::io::stdout());

            let sem = Arc::new(tokio::sync::Semaphore::new(accept_cap));

            loop {
                let (tcp, _peer) = match listener.accept().await {
                    Ok(pair) => pair,
                    Err(e) => {
                        error!(error = %e, "accept failed");
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
                        std::process::exit(1);
                    }
                };

                let state = Arc::clone(&state);
                let read_buf_cap = tuning.read_buf_cap;
                let max_req = tuning.max_request_bytes;
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    let _permit = permit; // released when the connection ends
                    let svc = service_fn(move |req| handle_request(req, Arc::clone(&state)));

                    // The two branches produce different concrete IO types
                    // (TlsStream vs plain TcpStream), so each calls the generic
                    // `serve_io` in its own arm — they can't share one variable
                    // without boxing.
                    match acceptor {
                        Some(acceptor) => {
                            // A bad client handshake is NOT fatal: log + drop.
                            let tls_stream = match acceptor.accept(tcp).await {
                                Ok(s) => s,
                                Err(e) => {
                                    debug!(error = %e, "tls handshake failed");
                                    return;
                                }
                            };
                            serve_io(TokioIo::new(tls_stream), svc, max_req, read_buf_cap).await;
                        }
                        None => {
                            serve_io(TokioIo::new(tcp), svc, max_req, read_buf_cap).await;
                        }
                    }
                });
            }
        });
    });
}

/// Serve one already-accepted connection with hyper's auto (H1+H2) builder.
/// Generic over the IO type so both the plaintext (`TokioIo<TcpStream>`) and the
/// TLS (`TokioIo<TlsStream<TcpStream>>`) branches share one body — the concrete
/// `TokioIo<...>` types differ, so this is the clean way to avoid boxing.
/// `serve_connection_with_upgrades` keeps the WS-upgrade path working over TLS.
async fn serve_io<I, S, B>(io: I, svc: S, max_req: usize, read_buf_cap: usize)
where
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
    if let Err(e) = builder.serve_connection_with_upgrades(io, svc).await {
        debug!(error = %e, "connection error");
    }
}

/// Reconstruct a raw HTTP/1.1 request header block
/// (`<METHOD> <path> HTTP/1.1\r\n<headers>\r\n\r\n`) from a hyper request's
/// method/path/headers. The routing layer (`routes::match_path`,
/// `build_*_envelope`, the cache vary lookup, the WS handshake parser) all
/// consume raw header bytes and httparse them internally — rebuilding the byte
/// block here keeps every one of those decisions byte-for-byte unchanged
/// without touching the routing crate.
fn reconstruct_raw_headers(method: &str, path: &str, headers: &http::HeaderMap) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(method.as_bytes());
    out.push(b' ');
    out.extend_from_slice(path.as_bytes());
    out.extend_from_slice(b" HTTP/1.1\r\n");
    for (name, value) in headers.iter() {
        out.extend_from_slice(name.as_str().as_bytes());
        out.extend_from_slice(b": ");
        out.extend_from_slice(value.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b"\r\n");
    out
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
    let cache = Arc::clone(&state.cache);

    let method = req.method().as_str().to_owned();
    // path-and-query as the router expects (e.g. "/foo?a=1").
    let path = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_owned())
        .unwrap_or_else(|| req.uri().path().to_owned());
    let path_no_query = path.split('?').next().unwrap_or(&path);

    // Reconstruct the raw header block once for the routing/envelope/cache layer.
    let raw = reconstruct_raw_headers(&method, &path, req.headers());

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
            return Ok(raw_http_to_response(resp));
        }
        if !state.path_under_action_prefix(path_no_query) {
            return Ok(raw_http_to_response(crate::http::error_404()));
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
        return Ok(raw_http_to_response(crate::http::error_405()));
    }

    // ----- /ping (native, bypasses pool) -----
    if path == "/ping" {
        return Ok(raw_http_to_response(crate::http::build_response(
            200,
            "text/plain",
            &[],
            b"pong\n".to_vec(),
        )));
    }

    // ----- cache stats -----
    if path == "/_brust/cache/stats" {
        let stats = cache.stats();
        let json = serde_json::to_string(&stats).unwrap_or_else(|_| String::from("{}"));
        return Ok(raw_http_to_response(crate::http::build_response(
            200,
            "application/json",
            &[],
            json.into_bytes(),
        )));
    }

    // ----- island chunks -----
    if let Some(file) = path.strip_prefix("/_brust/islands/") {
        let file = file.split('?').next().unwrap_or(file);
        if !is_safe_island_filename(file) {
            return Ok(raw_http_to_response(crate::http::error_404()));
        }
        let Some(dir) = state.islands_dir() else {
            return Ok(raw_http_to_response(crate::http::error_404()));
        };
        let file_path = dir.join(file);
        return match tokio::fs::read(&file_path).await {
            Ok(bytes) => {
                let accept_enc = header_str(req.headers(), "accept-encoding").unwrap_or_default();
                let resp = static_asset_response(
                    &accept_enc,
                    "application/javascript; charset=utf-8",
                    &file_path.to_string_lossy(),
                    bytes,
                    false,
                    state.is_dev_mode(),
                );
                Ok(raw_http_to_response(resp))
            }
            Err(_) => Ok(raw_http_to_response(crate::http::error_404())),
        };
    }

    // ----- CSS chunks -----
    if let Some(file) = path.strip_prefix("/_brust/css/") {
        let file = file.split('?').next().unwrap_or(file);
        if !is_safe_css_filename(file) {
            return Ok(raw_http_to_response(crate::http::error_404()));
        }
        let Some(dir) = state.css_dir() else {
            return Ok(raw_http_to_response(crate::http::error_404()));
        };
        let file_path = dir.join(file);
        return match tokio::fs::read(&file_path).await {
            Ok(bytes) => {
                let accept_enc = header_str(req.headers(), "accept-encoding").unwrap_or_default();
                let resp = static_asset_response(
                    &accept_enc,
                    "text/css; charset=utf-8",
                    &file_path.to_string_lossy(),
                    bytes,
                    false,
                    state.is_dev_mode(),
                );
                Ok(raw_http_to_response(resp))
            }
            Err(_) => Ok(raw_http_to_response(crate::http::error_404())),
        };
    }

    // ----- root-mapped public assets (GET only) -----
    if method == "GET"
        && let Some(file_path) = state.public_asset(&asset_lookup_key(path_no_query))
        && let Ok(bytes) = tokio::fs::read(&file_path).await
    {
        let ct = content_type_for(&file_path);
        let accept_enc = header_str(req.headers(), "accept-encoding").unwrap_or_default();
        let resp = static_asset_response(
            &accept_enc,
            ct,
            &file_path.to_string_lossy(),
            bytes,
            false,
            state.is_dev_mode(),
        );
        return Ok(raw_http_to_response(resp));
    }

    // ----- action dispatch -----
    if under_actions {
        return handle_action(req, &state, &pool, &method, &path, path_no_query, &raw).await;
    }

    // ----- MCP -----
    if path == "/_brust/mcp" {
        return handle_mcp(req, &pool, &method, &path, &raw).await;
    }

    // ----- cache invalidate -----
    if path.starts_with("/_brust/cache/invalidate") {
        if method != "POST" {
            return Ok(raw_http_to_response(crate::http::error_405()));
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
            return Ok(raw_http_to_response(crate::http::build_response(
                400,
                "application/json",
                &[],
                br#"{"error":"missing path or all parameter"}"#.to_vec(),
            )));
        };
        let body = format!(r#"{{"removed":{removed}}}"#);
        return Ok(raw_http_to_response(crate::http::build_response(
            200,
            "application/json",
            &[],
            body.into_bytes(),
        )));
    }

    // ----- SSE -----
    if crate::realtime::sse::path_is_sse(&path) {
        return handle_sse(&pool, &method, &path, &raw).await;
    }

    // ----- WebSocket -----
    if crate::realtime::ws::path_is_ws(&path) {
        return handle_ws(&mut req, &pool, &method, &path, &raw).await;
    }

    // ----- SPA navigation interceptor -----
    if let Some(stripped) = path.strip_prefix("/_brust/page") {
        if method != "GET" {
            return Ok(raw_http_to_response(crate::http::error_405()));
        }
        let real_path = if stripped.is_empty() { "/" } else { stripped };
        let envelope = match routes.match_path(&method, real_path, &raw) {
            MatchResult::Matched { mut envelope, .. } => {
                envelope.kind = "navigation";
                envelope
            }
            MatchResult::NoMatch => {
                return Ok(raw_http_to_response(crate::http::build_response(
                    404,
                    "application/json; charset=utf-8",
                    &[],
                    br#"{"error":"not found"}"#.to_vec(),
                )));
            }
        };
        return Ok(dispatch_streaming(&pool, envelope, "navigation", None).await);
    }

    // ----- general route match -----
    let (envelope, route_id) = match routes.match_path(&method, &path, &raw) {
        MatchResult::Matched { envelope, route_id } => (envelope, route_id),
        MatchResult::NoMatch => {
            return Ok(raw_http_to_response(crate::http::error_404()));
        }
    };

    // Cache lookup.
    let cache_config = routes.cache_for(route_id);
    let cache_key = cache_config
        .as_ref()
        .map(|cfg| build_cache_key(&method, &path, cfg, &raw));
    if let Some(key) = &cache_key
        && let Some(bytes) = cache.get(key)
    {
        // Cached bytes are a complete framed HTTP/1.1 response.
        return Ok(raw_http_to_response(bytes));
    }

    // Native (jinja) routes: single-chunk fast lane, never cache.
    if routes.native_template_for(route_id).is_some() {
        return Ok(dispatch_single_chunk(&pool, envelope, "render").await);
    }

    // React render: streaming-capable. Cache write-back on the single-chunk
    // (Content-Length) shape only — Suspense streams are never cached.
    let cache_writeback = match (cache_key, cache_config) {
        (Some(key), Some(cfg)) => Some(CacheWriteback {
            cache,
            key,
            ttl: Duration::from_secs(cfg.ttl_seconds),
        }),
        _ => None,
    };
    Ok(dispatch_streaming(&pool, envelope, "render", cache_writeback).await)
}

/// Cache write-back parameters threaded into the streaming dispatch.
struct CacheWriteback {
    cache: Arc<crate::cache::response_cache::ResponseCache>,
    key: CacheKey,
    ttl: Duration,
}

/// Action dispatch branch (single-chunk fast lane; never caches).
async fn handle_action(
    req: Request<Incoming>,
    state: &Arc<AppState>,
    pool: &Arc<crate::render::pool::WorkerPool>,
    method: &str,
    path: &str,
    path_no_query: &str,
    raw: &[u8],
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
        None => return Ok(raw_http_to_response(crate::http::error_405())),
    };
    let outcome = state.with_action_router(|r| r.at(m, rel));
    use crate::routing::action::MatchOutcome;
    let (endpoint_id, owned_params) = match outcome {
        MatchOutcome::Found {
            endpoint_id,
            params,
        } => (endpoint_id, params),
        MatchOutcome::MethodNotAllowed => {
            return Ok(raw_http_to_response(crate::http::error_405()));
        }
        MatchOutcome::NotFound => return Ok(raw_http_to_response(crate::http::error_404())),
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
        return Ok(raw_http_to_response(crate::http::error_413()));
    }

    let body_bytes = match http_body_util::BodyExt::collect(req.into_body()).await {
        Ok(c) => c.to_bytes(),
        Err(_) => return Ok(raw_http_to_response(crate::http::error_400())),
    };
    if body_bytes.len() > tuning().max_action_body_bytes {
        return Ok(raw_http_to_response(crate::http::error_413()));
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
            Err(_) => return Ok(raw_http_to_response(crate::http::error_400())),
        }
    } else if ct_lower.starts_with("multipart/form-data") {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&body_bytes);
        body_text_string = None;
        body_b64_string = Some(b64);
    } else {
        return Ok(raw_http_to_response(crate::http::error_415()));
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
        raw,
    );

    Ok(dispatch_single_chunk(pool, envelope, "action").await)
}

/// MCP JSON-RPC branch.
async fn handle_mcp(
    req: Request<Incoming>,
    pool: &Arc<crate::render::pool::WorkerPool>,
    method: &str,
    path: &str,
    raw: &[u8],
) -> Result<Response<ResponseBody>, Infallible> {
    if method != "POST" {
        return Ok(raw_http_to_response(crate::http::error_405()));
    }
    let headers = req.headers().clone();
    let content_type = header_str(&headers, "content-type").unwrap_or_default();
    if !content_type
        .to_ascii_lowercase()
        .starts_with("application/json")
    {
        return Ok(raw_http_to_response(crate::http::error_415()));
    }
    // Preserve the historical 411 (Content-Length required) semantics: an MCP
    // POST must carry an explicit Content-Length.
    if header_str(&headers, "content-length").is_none() {
        return Ok(raw_http_to_response(crate::http::error_411()));
    }
    if let Some(cl) = header_str(&headers, "content-length").and_then(|s| s.parse::<usize>().ok())
        && cl > tuning().max_action_body_bytes
    {
        return Ok(raw_http_to_response(crate::http::error_413()));
    }

    let body_bytes = match http_body_util::BodyExt::collect(req.into_body()).await {
        Ok(c) => c.to_bytes(),
        Err(_) => return Ok(raw_http_to_response(crate::http::error_400())),
    };
    if body_bytes.len() > tuning().max_action_body_bytes {
        return Ok(raw_http_to_response(crate::http::error_413()));
    }
    let body_str = match std::str::from_utf8(&body_bytes) {
        Ok(s) => s,
        Err(_) => return Ok(raw_http_to_response(crate::http::error_400())),
    };

    let envelope = crate::routing::routes::build_mcp_envelope(method, path, body_str, raw);
    Ok(dispatch_streaming(pool, envelope, "mcp", None).await)
}

/// SSE branch: validate, dispatch, await the open signal, then return a
/// streaming body fed by the per-connection SSE task.
async fn handle_sse(
    pool: &Arc<crate::render::pool::WorkerPool>,
    method: &str,
    path: &str,
    raw: &[u8],
) -> Result<Response<ResponseBody>, Infallible> {
    if method != "GET" {
        return Ok(raw_http_to_response(crate::http::error_405()));
    }
    let accept = crate::server::header_from_raw(raw, "accept").unwrap_or_default();
    let accept_lower = accept.to_ascii_lowercase();
    let accept_ok = accept_lower.is_empty()
        || accept_lower.contains("text/event-stream")
        || accept_lower.trim() == "*/*";
    if !accept_ok {
        return Ok(raw_http_to_response(crate::http::build_response(
            406,
            "text/plain",
            &[],
            b"406 Not Acceptable".to_vec(),
        )));
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
        return Ok(raw_http_to_response(crate::http::error_500()));
    };
    let envelope = crate::routing::routes::build_sse_envelope(method, path, raw, conn_id);
    let envelope_json = match serde_json::to_string(&envelope) {
        Ok(json) => json,
        Err(e) => {
            error!(conn_id, error = %e, "sse envelope serialize failed");
            crate::realtime::sse::registry().lock().remove(&conn_id);
            return Ok(raw_http_to_response(crate::http::error_500()));
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
        if let Err(e) = dispatch_entry
            .dispatch
            .call(crate::render::RenderEnvelope::Inline(envelope_json))
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
            return Ok(raw_http_to_response(crate::http::error_500()));
        }
        Err(_) => {
            warn!(conn_id, "sse open signal timeout (30s)");
            crate::realtime::sse::registry().lock().remove(&conn_id);
            return Ok(raw_http_to_response(crate::http::error_500()));
        }
    };

    if open.status >= 400 {
        // Middleware rejection — a regular HTTP response with the body.
        crate::realtime::sse::registry().lock().remove(&conn_id);
        let resp = crate::http::build_response(open.status, &open.content_type, &[], open.body);
        return Ok(raw_http_to_response(resp));
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
        .unwrap_or_else(|_| raw_http_to_response(crate::http::error_500()));
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
    raw: &[u8],
) -> Result<Response<ResponseBody>, Infallible> {
    if method != "GET" {
        return Ok(raw_http_to_response(crate::http::error_405()));
    }
    let handshake = match crate::realtime::ws::parse_ws_handshake(raw) {
        Ok(h) => h,
        Err(_) => return Ok(raw_http_to_response(crate::http::error_400())),
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
            return Ok(raw_http_to_response(crate::http::error_500()));
        };
        let envelope = crate::routing::routes::build_ws_envelope(
            method,
            path,
            raw,
            conn_id,
            client_subprotocols,
        );
        let envelope_json = match serde_json::to_string(&envelope) {
            Ok(json) => json,
            Err(e) => {
                error!(conn_id, error = %e, "ws envelope serialize failed");
                crate::realtime::ws::registry().lock().remove(&conn_id);
                return Ok(raw_http_to_response(crate::http::error_500()));
            }
        };
        {
            let _guard = entry.in_flight_guard();
            if let Err(e) = entry
                .dispatch
                .call(crate::render::RenderEnvelope::Inline(envelope_json))
                .await
                .map(|_| ())
            {
                error!(worker_id = entry.id, error = %e, "ws dispatch failed");
                crate::realtime::ws::registry().lock().remove(&conn_id);
                return Ok(raw_http_to_response(crate::http::error_500()));
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
                return Ok(raw_http_to_response(crate::http::error_500()));
            }
            Err(_) => {
                warn!(conn_id, "ws open signal timeout (30s)");
                crate::realtime::ws::registry().lock().remove(&conn_id);
                return Ok(raw_http_to_response(crate::http::error_500()));
            }
        }
    };

    if open.status != 101 {
        crate::realtime::ws::registry().lock().remove(&conn_id);
        let resp = crate::http::build_response(open.status, &open.content_type, &[], open.body);
        return Ok(raw_http_to_response(resp));
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
        .unwrap_or_else(|_| raw_http_to_response(crate::http::error_500()));

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

/// Case-insensitive header lookup against a reconstructed raw header block.
/// Mirrors the old `parse_header_value` for the few branches that still read
/// from the raw buffer rather than the hyper `HeaderMap`.
fn header_from_raw(buf: &[u8], name: &str) -> Option<String> {
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut req = httparse::Request::new(&mut headers);
    let _ = req.parse(buf);
    for h in req.headers.iter() {
        if h.name.eq_ignore_ascii_case(name) {
            return std::str::from_utf8(h.value)
                .ok()
                .map(|s| s.trim().to_string());
        }
    }
    None
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

/// Serialize `envelope` into the worker's SAB; returns the byte length or a
/// pre-built error response.
fn serialize_envelope<E: serde::Serialize>(
    entry: &crate::render::pool::WorkerEntry,
    envelope: &E,
    label: &'static str,
) -> Result<u32, Box<Response<ResponseBody>>> {
    let (buf_ptr, buf_cap) = entry.dispatch.buf();
    let mut cursor =
        std::io::Cursor::new(unsafe { std::slice::from_raw_parts_mut(buf_ptr, buf_cap) });
    if let Err(e) = serde_json::to_writer(&mut cursor, envelope) {
        if e.is_io() {
            return Err(Box::new(raw_http_to_response(crate::http::error_413())));
        }
        error!(worker_id = entry.id, label, error = %e, "envelope serialization failed");
        return Err(Box::new(raw_http_to_response(crate::http::error_500())));
    }
    // Saturate rather than truncate: an over-4GB length becomes u32::MAX, which
    // the caller's existing size/is_io() 413 check then rejects, instead of
    // wrapping into a valid-looking wrong length.
    Ok(u32::try_from(cursor.position()).unwrap_or(u32::MAX))
}

/// Decode a fast-lane SAB framed response `[meta_len][meta][body]` into the
/// final HTTP/1.1 response bytes. Returns the bytes (for cache + body).
fn decode_fast_lane(buf: &[u8]) -> Result<Vec<u8>, &'static str> {
    crate::render::stream::split_meta(buf).and_then(|(meta_slice, body)| {
        serde_json::from_slice::<crate::render::stream::ChunkMeta>(meta_slice)
            .map(|meta| crate::render::stream::build_single_response_bytes(&meta, body))
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
) -> Response<ResponseBody>
where
    E: serde::Serialize,
{
    let claim = match claim_or_wait(pool, || pool.try_claim_render_lockfree()).await {
        Ok(c) => c,
        Err(ClaimWaitErr::NoWorkers) => {
            return raw_http_to_response(crate::http::error_503("no workers"));
        }
        Err(ClaimWaitErr::Timeout) => {
            return raw_http_to_response(crate::http::error_503("all workers busy"));
        }
    };
    let entry = Arc::clone(claim.entry());

    let envelope_len = match serialize_envelope(&entry, &envelope, label) {
        Ok(n) => n,
        Err(resp) => return *resp,
    };

    let resp_len = match entry
        .dispatch
        .call(crate::render::RenderEnvelope::Sab(envelope_len))
        .await
    {
        Ok(len) => len,
        Err(e @ crate::render::RenderError::EnqueueFailed(_)) => {
            error!(worker_id = entry.id, label, error = %e,
                   "render tsfn enqueue failed — worker dead, removing from pool");
            pool.remove(entry.id);
            if pool.registered_count() == 0 {
                error!("no workers left after enqueue failure — terminating process");
                std::process::exit(1);
            }
            return raw_http_to_response(crate::http::build_response(
                502,
                "text/plain",
                &[],
                b"bad gateway".to_vec(),
            ));
        }
        Err(e @ crate::render::RenderError::PromiseRejected(_)) => {
            error!(worker_id = entry.id, label, error = %e,
                   "render tsfn JS Promise rejected — worker still alive");
            return raw_http_to_response(crate::http::error_500());
        }
    };

    if resp_len == 0 || (resp_len as usize) > entry.dispatch.buf_len() {
        error!(
            worker_id = entry.id,
            label,
            resp_len,
            buf_len = entry.dispatch.buf_len(),
            "single-chunk dispatch got invalid resp_len (0 = worker used chunk channel)"
        );
        return raw_http_to_response(crate::http::error_500());
    }

    // SAFETY: render Promise resolved (happens-before via napi tsfn.await), JS
    // done writing the SAB; resp_len bounds-checked above.
    let (buf_ptr, _cap) = entry.dispatch.buf();
    let buf = unsafe { std::slice::from_raw_parts(buf_ptr, resp_len as usize) };
    match decode_fast_lane(buf) {
        Ok(resp) => raw_http_to_response(resp),
        Err(e) => {
            error!(
                worker_id = entry.id,
                label,
                error = e,
                "single-chunk response decode failed"
            );
            raw_http_to_response(crate::http::error_500())
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
            return raw_http_to_response(crate::http::error_503("no workers"));
        }
        Err(ClaimWaitErr::Timeout) => {
            return raw_http_to_response(crate::http::error_503("all workers busy"));
        }
    };
    let entry = Arc::clone(claim.entry());

    let envelope_len = match serialize_envelope(&entry, &envelope, label) {
        Ok(n) => n,
        Err(resp) => return *resp,
    };

    // The render future is `'static` (holds only an Arc + u32), so it can be
    // moved into the chunk-pump task on the chunked path. `claim` (the RAII
    // slot/in-flight guard) is moved alongside it so the worker stays reserved
    // for the entire stream — on the buffered path it is dropped when this fn
    // returns, exactly like the old RAII lifetime.
    let entry_for_future = Arc::clone(&entry);
    let render_future = async move {
        match entry_for_future
            .dispatch
            .call(crate::render::RenderEnvelope::Sab(envelope_len))
            .await
        {
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
                        let resp = crate::render::stream::build_single_response_bytes(&meta, b"");
                        return raw_http_to_response(resp);
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
                        // Client already gone before the opening chunk landed:
                        // drop the claim and return early (mirrors the
                        // disconnect handling in spawn_chunk_pump). The body
                        // receiver is dead, so no pump is started.
                        let _ = ack.send(());
                        drop(claim);
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
                    let resp = crate::render::stream::build_single_response_bytes(&meta, &body);
                    if let Some(wb) = cache_writeback {
                        wb.cache.insert(wb.key, resp.clone(), wb.ttl);
                    }
                    return raw_http_to_response(resp);
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
                let resp = crate::render::stream::build_single_response_bytes(&meta, &buffered);
                if let Some(wb) = cache_writeback {
                    wb.cache.insert(wb.key, resp.clone(), wb.ttl);
                }
                return raw_http_to_response(resp);
            }
            outcome = &mut render_future => {
                match outcome {
                    RenderOutcome::Resolved(resp_len) => {
                        if resp_len > 0 {
                            let len = resp_len as usize;
                            if len > entry.dispatch.buf_len() {
                                error!(worker_id = entry.id, label, len,
                                       buf_len = entry.dispatch.buf_len(),
                                       "fast-lane resp_len exceeds SAB capacity");
                                return raw_http_to_response(crate::http::error_500());
                            }
                            let (buf_ptr, _cap) = entry.dispatch.buf();
                            let buf = unsafe { std::slice::from_raw_parts(buf_ptr, len) };
                            match decode_fast_lane(buf) {
                                Ok(resp) => {
                                    if let Some(wb) = cache_writeback {
                                        wb.cache.insert(wb.key, resp.clone(), wb.ttl);
                                    }
                                    return raw_http_to_response(resp);
                                }
                                Err(e) => {
                                    error!(worker_id = entry.id, label, error = e,
                                           "fast-lane response decode failed");
                                    return raw_http_to_response(crate::http::error_500());
                                }
                            }
                        }
                        let meta = crate::render::stream::ChunkMeta::default();
                        let resp = crate::render::stream::build_single_response_bytes(&meta, b"");
                        return raw_http_to_response(resp);
                    }
                    RenderOutcome::PromiseRejected(e) => {
                        error!(worker_id = entry.id, label, error = %e,
                               "render tsfn JS Promise rejected — worker still alive");
                        return raw_http_to_response(crate::http::error_500());
                    }
                    RenderOutcome::EnqueueFailed(e) => {
                        error!(worker_id = entry.id, label, error = %e,
                               "render tsfn enqueue failed — worker dead, removing from pool");
                        pool.remove(entry.id);
                        if pool.registered_count() == 0 {
                            error!("no workers left after enqueue failure — terminating process");
                            std::process::exit(1);
                        }
                        return raw_http_to_response(crate::http::build_response(
                            502, "text/plain", &[], b"bad gateway".to_vec(),
                        ));
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
            return Err(Box::new(raw_http_to_response(crate::http::error_500())));
        }
    };
    let parsed: crate::render::stream::ChunkMeta = match serde_json::from_slice(meta_slice) {
        Ok(m) => m,
        Err(e) => {
            error!(worker_id = entry.id, label, error = %e, "meta JSON parse failed");
            return Err(Box::new(raw_http_to_response(crate::http::error_500())));
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
        .unwrap_or_else(|_| raw_http_to_response(crate::http::error_500()))
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
        // Keep the claim alive for the stream lifetime.
        let _claim = claim;
        loop {
            tokio::select! {
                biased;
                Some(chunk) = chunk_rx.recv() => {
                    match chunk {
                        crate::render::pool::RenderChunk::Bytes { data, ack } => {
                            if tx.send(Bytes::from(data)).await.is_err() {
                                // Client disconnected.
                                let _ = ack.send(());
                                break;
                            }
                            let _ = ack.send(());
                        }
                        crate::render::pool::RenderChunk::BytesAndFinal { data, ack } => {
                            let _ = tx.send(Bytes::from(data)).await;
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

fn build_cache_key(
    method: &str,
    full_path: &str,
    cfg: &CacheConfig,
    request_buf: &[u8],
) -> CacheKey {
    let (path_only, query) = match full_path.split_once('?') {
        Some((p, q)) => (p, q),
        None => (full_path, ""),
    };
    let sorted_query = sort_query(query);
    let vary_values = lookup_vary_headers(request_buf, &cfg.vary);
    CacheKey {
        method: method.to_string(),
        path: path_only.to_string(),
        sorted_query,
        vary_values,
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

fn lookup_vary_headers(request_buf: &[u8], vary: &[String]) -> Vec<String> {
    if vary.is_empty() {
        return Vec::new();
    }
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut req = httparse::Request::new(&mut headers);
    let _ = req.parse(request_buf);
    vary.iter()
        .map(|name| {
            req.headers
                .iter()
                .find(|h| h.name.eq_ignore_ascii_case(name))
                .and_then(|h| std::str::from_utf8(h.value).ok())
                .unwrap_or("")
                .to_string()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconstruct_raw_headers_round_trips_through_httparse() {
        let mut hm = http::HeaderMap::new();
        hm.insert("host", "x".parse().unwrap());
        hm.insert("accept", "text/event-stream".parse().unwrap());
        let raw = reconstruct_raw_headers("GET", "/sse?a=1", &hm);
        assert_eq!(
            header_from_raw(&raw, "accept").as_deref(),
            Some("text/event-stream")
        );
        assert_eq!(header_from_raw(&raw, "host").as_deref(), Some("x"));
        let mut headers = [httparse::EMPTY_HEADER; 16];
        let mut req = httparse::Request::new(&mut headers);
        assert!(req.parse(&raw).unwrap().is_complete());
        assert_eq!(req.method, Some("GET"));
        assert_eq!(req.path, Some("/sse?a=1"));
    }

    #[test]
    fn vary_lookup_reads_reconstructed_headers() {
        let mut hm = http::HeaderMap::new();
        hm.insert("accept-language", "en".parse().unwrap());
        let raw = reconstruct_raw_headers("GET", "/", &hm);
        let v = lookup_vary_headers(&raw, &["Accept-Language".to_string()]);
        assert_eq!(v, vec!["en".to_string()]);
    }

    #[test]
    fn build_cache_key_sorts_query_and_uses_vary() {
        let cfg = CacheConfig {
            ttl_seconds: 60,
            vary: vec!["Accept-Encoding".to_string()],
        };
        let mut hm = http::HeaderMap::new();
        hm.insert("accept-encoding", "gzip".parse().unwrap());
        let raw = reconstruct_raw_headers("GET", "/p?b=2&a=1", &hm);
        let key = build_cache_key("GET", "/p?b=2&a=1", &cfg, &raw);
        assert_eq!(key.path, "/p");
        assert_eq!(key.sorted_query, "a=1&b=2");
        assert_eq!(key.vary_values, vec!["gzip".to_string()]);
    }
}
