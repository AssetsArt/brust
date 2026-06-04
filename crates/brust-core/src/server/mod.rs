use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use tracing::{error, warn};

use crate::cache::response_cache::{CacheConfig, CacheKey};
use crate::config::AppState;
use crate::http::{self, ParseError, parse_request};
use crate::routing::routes::MatchResult;
use crate::server::transport::{IO_NAME, TcpListener, TcpStream, run_io, spawn};

pub mod transport;

/// `Cache-Control` for static assets (`/_brust/islands/*`, `/_brust/css/*`).
/// Dev → `no-store`: chunk URLs are unhashed (`Counter.js`), so a hot-reload
/// rebuild would otherwise be masked by the browser cache. Prod → cacheable.
fn asset_cache_control(dev: bool) -> &'static str {
    if dev {
        "no-store"
    } else {
        "public, max-age=3600"
    }
}

/// Build a static-asset response: negotiate gzip, set Cache-Control + Vary, and
/// Content-Encoding when compressed. `path` is the on-disk path (cache key).
fn static_asset_response(
    buf: &[u8],
    content_type: &str,
    path: &str,
    bytes: Vec<u8>,
    head: bool,
    dev: bool,
) -> Vec<u8> {
    let accept = parse_header_value(buf, "accept-encoding");
    let (body, encoding) =
        crate::http::compress::maybe_compress(accept.as_deref(), content_type, path, bytes, dev);
    let mut extra: Vec<(String, String)> = vec![(
        "Cache-Control".to_string(),
        asset_cache_control(dev).to_string(),
    )];
    // Vary only matters for compression-eligible types — a non-compressible asset
    // (png/woff2/…) never varies by Accept-Encoding, so omitting it keeps CDN/proxy
    // cache variants minimal.
    if crate::http::compress::is_compressible(content_type) {
        extra.push(("Vary".to_string(), "Accept-Encoding".to_string()));
    }
    if let Some(enc) = encoding {
        extra.push(("Content-Encoding".to_string(), enc.to_string()));
    }
    // HEAD: same headers as the GET (incl. the content-length the GET body would
    // have produced — compression already applied) but no entity body.
    if head {
        http::build_response_head(200, content_type, &extra, body.len())
    } else {
        http::build_response(200, content_type, &extra, body)
    }
}

/// Percent-decode a URL **path** for static-asset manifest lookup. Identical to
/// `percent_decode` for `%XX` escapes, but a `+` is a LITERAL plus in a path
/// (only query strings map `+`→space). Manifest keys are raw filenames, so a
/// request like `/img/a%20b.png` must decode to `/img/a b.png` to match.
fn percent_decode_path(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push(((h << 4) | l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_default()
}

/// Manifest lookup key for `path_no_query`: percent-decoded only when it actually
/// contains an escape, so the common no-escape path stays allocation-free.
fn asset_lookup_key(path_no_query: &str) -> std::borrow::Cow<'_, str> {
    if path_no_query.contains('%') {
        std::borrow::Cow::Owned(percent_decode_path(path_no_query))
    } else {
        std::borrow::Cow::Borrowed(path_no_query)
    }
}

/// Content-Type for a static public file, keyed on its file extension
/// (lowercased). Unknown/none → application/octet-stream.
fn content_type_for(file_path: &std::path::Path) -> &'static str {
    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("json") | Some("map") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml; charset=utf-8",
        Some("xml") => "application/xml; charset=utf-8",
        Some("txt") => "text/plain; charset=utf-8",
        Some("csv") => "text/csv; charset=utf-8",
        Some("ico") => "image/x-icon",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("eot") => "application/vnd.ms-fontobject",
        Some("pdf") => "application/pdf",
        Some("wasm") => "application/wasm",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        _ => "application/octet-stream",
    }
}

enum ReadOutcome {
    /// Headers complete (`\r\n\r\n` seen) — `buf` contains the full request.
    Complete,
    /// Read error or EOF before any complete headers — close silently.
    ClosedBeforeHeaders,
    /// Buffer grew past `MAX_REQUEST_BYTES` without seeing `\r\n\r\n`.
    Oversize,
}

/// Whether to continue the keep-alive loop or close the connection after a
/// worker dispatch attempt. CloseConn covers every failure path (oversized
/// envelope, invalid meta, promise reject, tsfn failure) — by the time the
/// helper returns CloseConn it has already written the error response.
enum DispatchControl {
    Continue,
    CloseConn,
}

/// Runtime-tunable server limits, set ONCE from `ServeOptions.tuning` at
/// `begin_serve` (see lib.rs). Every default matches the historical
/// compile-time constant, so an app that omits `tuning` is byte-for-byte
/// unchanged. Hot-path reads go through `tuning()`.
///
/// - `max_request_bytes` (16 KB): cap on request bytes before `\r\n\r\n`.
/// - `max_action_body_bytes` (256 KB): cap on action/RPC body size. Mirrors the
///   SAB capacity so the largest body fits one SAB write; raising the SAB does
///   NOT auto-raise this — set it here too.
/// - `conn_queue_cap` (1024): accept-side queue depth; a slow worker pool
///   triggers TCP backpressure instead of unbounded memory growth.
/// - `read_buf_cap` (4096): initial per-connection read buffer capacity.
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
}

impl Default for Tuning {
    fn default() -> Self {
        Self {
            max_request_bytes: 16 * 1024,
            max_action_body_bytes: 256 * 1024,
            conn_queue_cap: 1024,
            read_buf_cap: 4096,
            claim_timeout_ms: 10_000,
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

pub fn start(addr: SocketAddr, state: Arc<AppState>, conn_workers: usize, tuning: Tuning) {
    // Set the process-wide tunables before any connection is served. `start`
    // runs once per process (re-serve is rejected in begin_serve), so a
    // best-effort set is correct; the Err arm only fires if already set.
    let _ = TUNING.set(tuning);
    run_io(move || async move {
        let listener = match TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                error!(error = %e, %addr, "bind failed");
                std::process::exit(1);
            }
        };

        let (tx, rx) = flume::bounded::<TcpStream>(tuning.conn_queue_cap);

        // Conn-workers exit only when all Senders drop (i.e. accept loop has
        // exited). This count is independent of the Bun render-worker count
        // (`expected_workers`): these are lightweight async tasks doing
        // accept→parse→dispatch, not OS render threads.
        for _ in 0..conn_workers {
            let rx = rx.clone();
            let state = Arc::clone(&state);
            spawn(async move {
                while let Ok(stream) = rx.recv_async().await {
                    handle_conn(stream, Arc::clone(&state)).await;
                }
            });
        }
        // Drop the original Receiver. Only the worker clones remain; if all
        // workers exit, tx.send_async() will return Err(Disconnected) and the
        // defensive guard below will fire. Without this drop, the original rx
        // here keeps the channel "connected" forever, masking worker death.
        drop(rx);

        state.ready.notified().await; // wait until all napi workers have registered
        println!("[brust] listening on {addr} (io: {IO_NAME})");
        let _ = std::io::Write::flush(&mut std::io::stdout());

        loop {
            match listener.accept().await {
                Ok((stream, _peer)) => {
                    if tx.send_async(stream).await.is_err() {
                        error!("all conn workers died");
                        std::process::exit(1);
                    }
                }
                Err(e) => {
                    error!(error = %e, "accept failed");
                    std::process::exit(1);
                }
            }
        }
    });
}

async fn handle_conn(mut s: TcpStream, state: Arc<AppState>) {
    // Cheap Arc clones so the existing per-branch call sites (which pass
    // `&pool`/`pool.clone()` and move owned Arcs into spawned SSE/WS tasks)
    // keep their original `Arc<…>` shapes. The atomic bumps are off the hot
    // page-render path's allocation budget (one per connection, not per request).
    let pool = Arc::clone(&state.pool);
    let routes = Arc::clone(&state.routes);
    let cache = Arc::clone(&state.cache);
    let mut buf = Vec::with_capacity(tuning().read_buf_cap);
    loop {
        buf.clear();
        match read_full_request(&mut s, &mut buf).await {
            ReadOutcome::Complete => {}
            ReadOutcome::ClosedBeforeHeaders => return,
            ReadOutcome::Oversize => {
                // Don't keep-alive: client's read cursor is mid-headers; the next
                // bytes on the wire would be misparsed as a new request. error_414()
                // emits Connection: close so the client knows not to reuse the socket.
                let _ = s.write_all(http::error_414()).await;
                return;
            }
        }

        let (method, path) = match parse_request(&buf) {
            Ok(r) => (r.method.to_owned(), r.path.to_owned()),
            Err(ParseError::Incomplete) | Err(ParseError::Invalid) => {
                let _ = s.write_all(http::error_400()).await;
                return;
            }
        };

        // Strip the query string once; reused by the gate and the action branch.
        let path_no_query = path.split('?').next().unwrap_or(&path);

        // HEAD is supported for static public assets (identical headers to the
        // GET — incl. Content-Length — but no body; the canonical CDN/cache
        // existence+metadata probe). Resolved BEFORE the GET-only method gate and
        // the body-producing page handlers. Action paths keep their own method
        // handling (the gate's action-prefix exception → action dispatch), so a
        // HEAD under the action prefix falls through; any other non-asset HEAD is
        // a probe for a resource we don't serve via HEAD → 404.
        if method == "HEAD" {
            if let Some(file_path) = state.public_asset(&asset_lookup_key(path_no_query))
                && let Ok(bytes) = tokio::fs::read(&file_path).await
            {
                let ct = content_type_for(&file_path);
                let resp = static_asset_response(
                    &buf,
                    ct,
                    &file_path.to_string_lossy(),
                    bytes,
                    true,
                    state.is_dev_mode(),
                );
                if s.write_all(resp).await.is_err() {
                    return;
                }
                continue;
            }
            if !state.path_under_action_prefix(path_no_query) {
                let _ = s.write_all(http::error_404()).await;
                continue;
            }
            // else: fall through to the action-path handling below.
        }

        // Only GET is allowed on general routes. Action paths (under the
        // configured prefix), cache-invalidate, and MCP each allow POST (or
        // any method for action paths, which are router-gated). The prefix
        // check is allocation-free — it runs on every request.
        let under_actions = state.path_under_action_prefix(path_no_query);
        if !(method == "GET"
            || under_actions
            || method == "POST" && path_no_query.starts_with("/_brust/cache/invalidate")
            || method == "POST" && path_no_query == "/_brust/mcp")
        {
            let _ = s.write_all(http::error_405()).await;
            return;
        }

        // Native-only route: bypass napi pool so benchmarks can isolate TCP+HTTP cost from React SSR cost.
        if path == "/ping" {
            let bytes = http::build_response(200, "text/plain", &[], b"pong\n".to_vec());
            if s.write_all(bytes).await.is_err() {
                return;
            }
            continue;
        }

        // Native-only route: cache observability. JSON of hits/misses/len/capacity.
        if path == "/_brust/cache/stats" {
            let stats = cache.stats();
            let json = serde_json::to_string(&stats).unwrap_or_else(|_| String::from("{}"));
            let bytes = http::build_response(200, "application/json", &[], json.into_bytes());
            if s.write_all(bytes).await.is_err() {
                return;
            }
            continue;
        }

        // Native-only route: serve built island chunks from .brust/islands/.
        // Strict path-traversal protection: filename must match ^[A-Za-z0-9_.-]+\.js$
        // and is joined to the configured islands_dir (no .. allowed).
        if let Some(file) = path.strip_prefix("/_brust/islands/") {
            // Strip any query string (chunks aren't parameterized, but be defensive).
            let file = file.split('?').next().unwrap_or(file);
            if !is_safe_island_filename(file) {
                let _ = s.write_all(http::error_404()).await;
                continue;
            }
            let dir = match state.islands_dir() {
                Some(d) => d,
                None => {
                    let _ = s.write_all(http::error_404()).await;
                    continue;
                }
            };
            let file_path = dir.join(file);
            match tokio::fs::read(&file_path).await {
                Ok(bytes) => {
                    let resp = static_asset_response(
                        &buf,
                        "application/javascript; charset=utf-8",
                        &file_path.to_string_lossy(),
                        bytes,
                        false,
                        state.is_dev_mode(),
                    );
                    if s.write_all(resp).await.is_err() {
                        return;
                    }
                    continue;
                }
                Err(_) => {
                    let _ = s.write_all(http::error_404()).await;
                    continue;
                }
            }
        }

        // Native-only route: serve pre-built CSS chunks from the configured
        // css_dir. Strict path-traversal protection mirrors the islands route.
        if let Some(file) = path.strip_prefix("/_brust/css/") {
            let file = file.split('?').next().unwrap_or(file);
            if !is_safe_css_filename(file) {
                let _ = s.write_all(http::error_404()).await;
                continue;
            }
            let dir = match state.css_dir() {
                Some(d) => d,
                None => {
                    let _ = s.write_all(http::error_404()).await;
                    continue;
                }
            };
            let file_path = dir.join(file);
            match tokio::fs::read(&file_path).await {
                Ok(bytes) => {
                    let resp = static_asset_response(
                        &buf,
                        "text/css; charset=utf-8",
                        &file_path.to_string_lossy(),
                        bytes,
                        false,
                        state.is_dev_mode(),
                    );
                    if s.write_all(resp).await.is_err() {
                        return;
                    }
                    continue;
                }
                Err(_) => {
                    let _ = s.write_all(http::error_404()).await;
                    continue;
                }
            }
        }

        // Root-mapped static assets from the configured public/ dir. Boot-time
        // manifest (URL→file); static wins over app routes, but every /_brust/*
        // handler above already `continue`d. GET-only (the method gate above
        // already 405s non-GET general paths). `path_no_query` is used purely as
        // a map key — never joined to a path — so traversal is impossible here.
        if method == "GET"
            && let Some(file_path) = state.public_asset(&asset_lookup_key(path_no_query))
        {
            // read error (file removed after boot) → fall through to routing
            if let Ok(bytes) = tokio::fs::read(&file_path).await {
                let ct = content_type_for(&file_path);
                let resp = static_asset_response(
                    &buf,
                    ct,
                    &file_path.to_string_lossy(),
                    bytes,
                    false,
                    state.is_dev_mode(),
                );
                if s.write_all(resp).await.is_err() {
                    return;
                }
                continue;
            }
        }

        // Native-only route: server-function dispatch.
        //   <METHOD> <action_prefix>/<rel>
        // Body: JSON array of args. Worker decodes the array and calls fn(req, ...args).
        // Status codes:
        //   404 — path not in action router
        //   405 — method not allowed for this endpoint
        //   411 — Transfer-Encoding/chunked body (unsupported; ask for Content-Length)
        //   413 — Content-Length > SAB capacity
        //   400 — body not valid UTF-8
        // 5xx — fn throws / middleware throws (handled by the JS side via meta envelope)
        if under_actions {
            // Compute the prefix-relative path without cloning the prefix on the
            // hot path; only action requests reach here (rare vs page loads).
            let rel_owned = state.with_action_prefix(|p| {
                let rel = &path_no_query[p.len()..];
                if rel.is_empty() {
                    "/".to_string()
                } else {
                    rel.to_string()
                }
            });
            let rel = rel_owned.as_str();
            let m = match crate::routing::action::Method::from_http(&method) {
                Some(m) => m,
                None => {
                    let _ = s.write_all(http::error_405()).await;
                    continue;
                }
            };
            let outcome = state.with_action_router(|r| r.at(m, rel));
            use crate::routing::action::MatchOutcome;
            let (endpoint_id, owned_params) = match outcome {
                MatchOutcome::Found {
                    endpoint_id,
                    params,
                } => (endpoint_id, params),
                MatchOutcome::MethodNotAllowed => {
                    let _ = s.write_all(http::error_405()).await;
                    continue;
                }
                MatchOutcome::NotFound => {
                    let _ = s.write_all(http::error_404()).await;
                    continue;
                }
            };

            // Locate the body in `buf`. parse_request only gave us method+path; we
            // need to find \r\n\r\n to skip the headers, then read Content-Length bytes.
            let header_end = match buf.windows(4).position(|w| w == b"\r\n\r\n") {
                Some(p) => p + 4,
                None => {
                    let _ = s.write_all(http::error_400()).await;
                    return;
                }
            };

            // RFC 7230 §3.3.3: absent Content-Length and Transfer-Encoding means
            // no body (length 0) — a bodyless DELETE/POST must not get 411.
            let content_length = match classify_request_body(&buf[..header_end]) {
                // We don't decode chunked bodies — ask the client for a Content-Length.
                BodyClass::Chunked => {
                    let _ = s.write_all(http::error_411()).await;
                    return;
                }
                BodyClass::Sized(n) if n > tuning().max_action_body_bytes => {
                    let _ = s.write_all(http::error_413()).await;
                    return;
                }
                BodyClass::Sized(n) => n,
                BodyClass::Empty => 0,
            };

            // Body bytes already in buf? read_full_request only loops until headers
            // complete; the body may be partially or fully buffered after \r\n\r\n.
            let body_buffered = buf.len().saturating_sub(header_end);
            // KNOWN LIMITATION: read_request appends all kernel bytes into buf, so if
            // a client pipelines a second request after the body the extra bytes get
            // dropped by the next buf.clear(). Acceptable for MVP — browsers don't
            // pipeline. Revisit when introducing a bounded read_exact API.
            if body_buffered < content_length {
                // Read the rest of the body. Bound by content_length so we don't
                // over-read into the next request on a keep-alive connection.
                let need = content_length - body_buffered;
                let mut read_so_far = 0usize;
                while read_so_far < need {
                    let n = match s.read_request(&mut buf).await {
                        Ok(n) => n,
                        Err(_) => {
                            let _ = s.write_all(http::error_400()).await;
                            return;
                        }
                    };
                    if n == 0 {
                        let _ = s.write_all(http::error_400()).await;
                        return;
                    }
                    read_so_far += n;
                }
            }
            let body_slice = &buf[header_end..header_end + content_length];

            // Detect Content-Type and route to the right body-encoding path.
            // ct_lower is ASCII-lowercased so 'application/JSON; charset=UTF-8'
            // (legal per RFC 7231) is accepted on the JSON branch.
            let content_type = parse_content_type(&buf[..header_end]).unwrap_or_default();
            let ct_lower = content_type.to_ascii_lowercase();

            let body_text_string: Option<String>;
            let body_b64_string: Option<String>;

            if ct_lower.is_empty()
                || ct_lower.starts_with("application/json")
                || ct_lower.starts_with("application/x-www-form-urlencoded")
            {
                // Text body — UTF-8 validated. Empty slice (GET/HEAD) yields Some("").
                match std::str::from_utf8(body_slice) {
                    Ok(s) => {
                        body_text_string = Some(s.to_string());
                        body_b64_string = None;
                    }
                    Err(_) => {
                        let _ = s.write_all(http::error_400()).await;
                        continue;
                    }
                }
            } else if ct_lower.starts_with("multipart/form-data") {
                // Binary body. base64-encode for transport through the JSON envelope.
                use base64::Engine as _;
                let b64 = base64::engine::general_purpose::STANDARD.encode(body_slice);
                body_text_string = None;
                body_b64_string = Some(b64);
            } else {
                // Unsupported Content-Type — close the connection because the
                // body may have been partially read.
                let _ = s.write_all(http::error_415()).await;
                return;
            }

            let id_str = endpoint_id.to_string();
            let params_ref: Vec<(std::borrow::Cow<str>, &str)> = owned_params
                .iter()
                .map(|(k, v)| (std::borrow::Cow::Borrowed(k.as_str()), v.as_str()))
                .collect();
            let envelope = crate::routing::routes::build_action_envelope(
                &method,
                &path,
                &id_str,
                params_ref,
                &content_type,
                body_text_string.as_deref(),
                body_b64_string.as_deref(),
                &buf[..header_end],
            );

            // Action endpoint never caches — no-op on_success closure. Content-Type
            // is carried in the per-chunk meta JSON (JS sets 'application/json' for
            // normal returns and 'text/plain' for middleware string short-circuits).
            // Single-chunk by nature → maximally-stripped lock-free dispatch
            // (no mpsc channel, no mutex, no select loop).
            match dispatch_single_chunk(
                &mut s,
                &pool,
                envelope,
                "action",
                false, // cache_wanted — actions never cache
                |_| {},
            )
            .await
            {
                DispatchControl::Continue => continue,
                DispatchControl::CloseConn => return,
            }
        }

        // Native-only route: MCP JSON-RPC server.
        //   POST /_brust/mcp
        // Body: JSON-RPC request. Worker dispatches by method.
        // Status codes (in execution order):
        //   405 — non-POST method
        //   415 — Content-Type not application/json
        //   411 — Content-Length missing
        //   413 — Content-Length > SAB capacity
        //   400 — malformed headers / body read failure / body not valid UTF-8
        //   200 — JSON-RPC response (errors carried inside the body)
        if path == "/_brust/mcp" {
            // The outer method gate already rejects non-POST; the duplicate check here
            // covers future refactors that might split the gate.
            if method != "POST" {
                let _ = s.write_all(http::error_405()).await;
                return;
            }
            let header_end = match buf.windows(4).position(|w| w == b"\r\n\r\n") {
                Some(p) => p + 4,
                None => {
                    let _ = s.write_all(http::error_400()).await;
                    return;
                }
            };
            let content_type = parse_content_type(&buf[..header_end]).unwrap_or_default();
            if !content_type
                .to_ascii_lowercase()
                .starts_with("application/json")
            {
                let _ = s.write_all(http::error_415()).await;
                return;
            }
            let content_length = match parse_content_length(&buf[..header_end]) {
                Some(n) => n,
                None => {
                    let _ = s.write_all(http::error_411()).await;
                    return;
                }
            };
            // Same cap as action — single global body envelope limit (SAB capacity).
            if content_length > tuning().max_action_body_bytes {
                let _ = s.write_all(http::error_413()).await;
                return;
            }
            let body_buffered = buf.len().saturating_sub(header_end);
            // Same pipeline caveat as the action branch — see comment near line 276.
            if body_buffered < content_length {
                let need = content_length - body_buffered;
                let mut read_so_far = 0usize;
                while read_so_far < need {
                    let n = match s.read_request(&mut buf).await {
                        Ok(n) => n,
                        Err(_) => {
                            let _ = s.write_all(http::error_400()).await;
                            return;
                        }
                    };
                    if n == 0 {
                        let _ = s.write_all(http::error_400()).await;
                        return;
                    }
                    read_so_far += n;
                }
            }
            let body_slice = &buf[header_end..header_end + content_length];
            let body_str = match std::str::from_utf8(body_slice) {
                Ok(s) => s,
                Err(_) => {
                    let _ = s.write_all(http::error_400()).await;
                    continue;
                }
            };

            let envelope = crate::routing::routes::build_mcp_envelope(
                &method,
                &path,
                body_str,
                &buf[..header_end],
            );

            match dispatch_to_worker_and_stream_chunks(
                &mut s,
                &pool,
                envelope,
                "mcp",
                false,
                |_| {},
            )
            .await
            {
                DispatchControl::Continue => continue,
                DispatchControl::CloseConn => return,
            }
        }

        // Native-only route: cache invalidation.
        //   POST /_brust/cache/invalidate?path=/foo  → purge by (GET, /foo)
        //   POST /_brust/cache/invalidate?all=1      → clear all entries
        // Response: 200 application/json {"removed": N}. Path mismatch on
        // ?path= is not an error; returns {"removed":0}.
        if path.starts_with("/_brust/cache/invalidate") {
            // Endpoint is POST-only. The outer method gate already rejects
            // methods other than GET and POST; here we further reject GET.
            // `continue`, not `return`: error_405() sends `Connection: keep-alive`
            // (build_response default) and a GET has no body to leave unread, so
            // the socket is in a clean state for the next request. Returning here
            // would CLOSE a socket we just told the client to keep — a keep-alive
            // client (Bun fetch's connection pool) then reuses the pooled-but-
            // closed connection and the next request fails with "socket closed
            // unexpectedly" (the intermittent CI flake). Matches the POST success
            // branches below, which `continue`.
            if method != "POST" {
                let _ = s.write_all(http::error_405()).await;
                continue;
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
                // Invalidate the GET variant; this server doesn't cache POST.
                cache.invalidate_path("GET", &p)
            } else {
                let bytes = http::build_response(
                    400,
                    "application/json",
                    &[],
                    br#"{"error":"missing path or all parameter"}"#.to_vec(),
                );
                if s.write_all(bytes).await.is_err() {
                    return;
                }
                continue;
            };
            let body = format!(r#"{{"removed":{removed}}}"#);
            let bytes = http::build_response(200, "application/json", &[], body.into_bytes());
            if s.write_all(bytes).await.is_err() {
                return;
            }
            continue;
        }

        // SSE branch — dispatched when the matched route was registered as an SSE
        // path via brust.registerSsePaths. Method MUST be GET; Accept must allow
        // text/event-stream (default-curl `*/*` is accepted for dev ergonomics).
        if crate::realtime::sse::path_is_sse(&path) {
            if method != "GET" {
                let _ = s.write_all(http::error_405()).await;
                return;
            }
            let header_end = match buf.windows(4).position(|w| w == b"\r\n\r\n") {
                Some(p) => p + 4,
                None => {
                    let _ = s.write_all(http::error_400()).await;
                    return;
                }
            };
            let accept = parse_header_value(&buf[..header_end], "accept").unwrap_or_default();
            let accept_lower = accept.to_ascii_lowercase();
            let accept_ok = accept_lower.is_empty()
                || accept_lower.contains("text/event-stream")
                || accept_lower.trim() == "*/*";
            if !accept_ok {
                // 406 Not Acceptable — build as Vec<u8> to match TcpStream::write_all signature.
                let body = b"406 Not Acceptable";
                let head = format!(
                    "HTTP/1.1 406 Not Acceptable\r\nContent-Length: {}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n",
                    body.len(),
                );
                let mut resp: Vec<u8> = head.into_bytes();
                resp.extend_from_slice(body);
                let _ = s.write_all(resp).await;
                return;
            }

            // Register conn in REGISTRY.
            let conn_id = crate::realtime::sse::next_conn_id();
            let (frame_tx, frame_rx) =
                tokio::sync::mpsc::channel::<crate::realtime::sse::SseFrame>(32);
            let (open_tx, open_rx) =
                tokio::sync::oneshot::channel::<crate::realtime::sse::SseOpenSignal>();
            crate::realtime::sse::registry().lock().insert(
                conn_id,
                crate::realtime::sse::SseConn {
                    frame_tx,
                    open_tx: Some(open_tx),
                    abort_cb: None,
                },
            );

            // Pick a worker and dispatch.
            let Some(entry) = pool.pick_least_busy() else {
                let _ = s.write_all(http::error_500()).await;
                crate::realtime::sse::registry().lock().remove(&conn_id);
                return;
            };
            let envelope = crate::routing::routes::build_sse_envelope(
                &method,
                &path,
                &buf[..header_end],
                conn_id,
            );
            let envelope_json = serde_json::to_string(&envelope).unwrap();

            // Single long-lived dispatch: the JS side branches on `kind: 'sse'`,
            // runs middleware, signals open via napi_sse_signal_open, then enters
            // the reader loop. Hold an in_flight_guard ONLY for the dispatch
            // handoff — sse_conn_task owns the rest of the connection lifetime.
            {
                let _guard = entry.in_flight_guard();
                if let Err(e) = entry
                    .dispatch
                    .call(crate::render::RenderEnvelope::Inline(envelope_json))
                    .await
                    .map(|_| ())
                {
                    error!(worker_id = entry.id, error = %e, "sse tsfn call_async failed");
                    let _ = s.write_all(http::error_500()).await;
                    crate::realtime::sse::registry().lock().remove(&conn_id);
                    return;
                }
            }

            // Await the open signal with timeout. Distinguish sender-dropped (JS crash)
            // from timeout (genuinely slow middleware) in the logs so Task 13 smoke
            // failures are diagnosable.
            let open = match tokio::time::timeout(std::time::Duration::from_secs(30), open_rx).await
            {
                Ok(Ok(signal)) => signal,
                Ok(Err(_)) => {
                    warn!(
                        conn_id,
                        "sse open_tx sender dropped before signal — JS crash?"
                    );
                    let _ = s.write_all(http::error_500()).await;
                    crate::realtime::sse::registry().lock().remove(&conn_id);
                    return;
                }
                Err(_) => {
                    warn!(conn_id, "sse open signal timeout (30s)");
                    let _ = s.write_all(http::error_500()).await;
                    crate::realtime::sse::registry().lock().remove(&conn_id);
                    return;
                }
            };

            if open.status >= 400 {
                // Middleware rejection — write a regular HTTP response with the body.
                let body = open.body;
                let head = format!(
                    "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    open.status,
                    http::status_reason(open.status),
                    open.content_type,
                    body.len(),
                );
                let mut resp: Vec<u8> = head.into_bytes();
                resp.extend_from_slice(&body);
                let _ = s.write_all(resp).await;
                crate::realtime::sse::registry().lock().remove(&conn_id);
                return;
            }

            // Open OK — write SSE headers, hand the socket to the per-conn task.
            if crate::realtime::sse::write_sse_response_headers(&mut s)
                .await
                .is_err()
            {
                crate::realtime::sse::registry().lock().remove(&conn_id);
                return;
            }
            crate::realtime::sse::sse_conn_task(s, conn_id, frame_rx).await;
            return;
        }

        // WS branch — dispatched when the matched route was registered via
        // brust.registerWsPaths. Method MUST be GET; the Upgrade/Connection
        // headers + Sec-WebSocket-Key + Sec-WebSocket-Version must validate
        // per RFC 6455 before we accept the upgrade.
        if crate::realtime::ws::path_is_ws(&path) {
            if method != "GET" {
                let _ = s.write_all(http::error_405()).await;
                return;
            }
            let header_end = match buf.windows(4).position(|w| w == b"\r\n\r\n") {
                Some(p) => p + 4,
                None => {
                    let _ = s.write_all(http::error_400()).await;
                    return;
                }
            };
            let handshake = match crate::realtime::ws::parse_ws_handshake(&buf[..header_end]) {
                Ok(h) => h,
                Err(_) => {
                    // Any header validation failure → 400 (we don't externally
                    // differentiate missing-Upgrade vs bad-version; logs would).
                    let _ = s.write_all(http::error_400()).await;
                    return;
                }
            };

            // Register conn in REGISTRY.
            let conn_id = crate::realtime::sse::next_conn_id();
            let (send_tx, send_rx) =
                tokio::sync::mpsc::channel::<crate::realtime::ws::WsOutgoing>(32);
            let (open_tx, open_rx) =
                tokio::sync::oneshot::channel::<crate::realtime::ws::WsOpenSignal>();
            crate::realtime::ws::registry().lock().insert(
                conn_id,
                crate::realtime::ws::WsConn {
                    send_tx,
                    open_tx: Some(open_tx),
                    on_message: None,
                    on_close: None,
                },
            );

            // Destructure so client_subprotocols moves into the envelope
            // and sec_websocket_key is still available for compute_sec_accept
            // on the 101 happy path. Avoids an unnecessary Vec<String> clone.
            let crate::realtime::ws::ParsedHandshake {
                sec_websocket_key,
                client_subprotocols,
            } = handshake;

            // `/_brust/dev` is the dev-mode control channel: Rust-owned, never
            // dispatched to a worker. It must survive worker hot-reloads, so the
            // conn keeps `on_close`/`on_message` = None (no worker tsfn to
            // dangle → no UAF) and is tracked in the dev-client set so
            // napi_dev_broadcast can push reload frames straight through its
            // send_tx. We accept the upgrade directly (101) rather than asking a
            // worker for a middleware verdict — there is no app middleware on
            // this internal path.
            let open = if path == "/_brust/dev" {
                crate::realtime::ws::dev_client_add(conn_id);
                crate::realtime::ws::WsOpenSignal {
                    status: 101,
                    body: Vec::new(),
                    content_type: String::new(),
                    subprotocol: String::new(),
                }
            } else {
                // Pick a worker and dispatch.
                let Some(entry) = pool.pick_least_busy() else {
                    let _ = s.write_all(http::error_500()).await;
                    crate::realtime::ws::registry().lock().remove(&conn_id);
                    return;
                };
                let envelope = crate::routing::routes::build_ws_envelope(
                    &method,
                    &path,
                    &buf[..header_end],
                    conn_id,
                    client_subprotocols,
                );
                let envelope_json = serde_json::to_string(&envelope).unwrap();

                // Single long-lived dispatch: the JS side branches on `kind:
                // 'ws'`, runs middleware, signals open (101 or 4xx), registers
                // handler callbacks. Hold an in_flight_guard ONLY for the
                // dispatch handoff — ws_conn_task owns the rest of the lifetime.
                {
                    let _guard = entry.in_flight_guard();
                    if let Err(e) = entry
                        .dispatch
                        .call(crate::render::RenderEnvelope::Inline(envelope_json))
                        .await
                        .map(|_| ())
                    {
                        error!(worker_id = entry.id, error = %e, "ws dispatch failed");
                        let _ = s.write_all(http::error_500()).await;
                        crate::realtime::ws::registry().lock().remove(&conn_id);
                        return;
                    }
                }

                // Await open verdict with 30s timeout. Distinguish sender-drop
                // (JS crash) from timeout for diagnosability.
                match tokio::time::timeout(std::time::Duration::from_secs(30), open_rx).await {
                    Ok(Ok(signal)) => signal,
                    Ok(Err(_)) => {
                        warn!(
                            conn_id,
                            "ws open_tx sender dropped before signal — JS crash?"
                        );
                        let _ = s.write_all(http::error_500()).await;
                        crate::realtime::ws::registry().lock().remove(&conn_id);
                        return;
                    }
                    Err(_) => {
                        warn!(conn_id, "ws open signal timeout (30s)");
                        let _ = s.write_all(http::error_500()).await;
                        crate::realtime::ws::registry().lock().remove(&conn_id);
                        return;
                    }
                }
            };

            if open.status != 101 {
                // Middleware rejection — write a regular HTTP response.
                let body = open.body;
                let head = format!(
                    "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    open.status,
                    http::status_reason(open.status),
                    open.content_type,
                    body.len(),
                );
                let mut resp: Vec<u8> = head.into_bytes();
                resp.extend_from_slice(&body);
                let _ = s.write_all(resp).await;
                crate::realtime::ws::registry().lock().remove(&conn_id);
                return;
            }

            // 101: write manual handshake response then wrap with tungstenite.
            let accept = crate::realtime::ws::compute_sec_accept(&sec_websocket_key);
            let mut handshake_resp = String::with_capacity(256);
            handshake_resp.push_str("HTTP/1.1 101 Switching Protocols\r\n");
            handshake_resp.push_str("Upgrade: websocket\r\n");
            handshake_resp.push_str("Connection: Upgrade\r\n");
            handshake_resp.push_str(&format!("Sec-WebSocket-Accept: {}\r\n", accept));
            if !open.subprotocol.is_empty() {
                handshake_resp
                    .push_str(&format!("Sec-WebSocket-Protocol: {}\r\n", open.subprotocol));
            }
            handshake_resp.push_str("\r\n");
            if s.write_all(handshake_resp.into_bytes()).await.is_err() {
                crate::realtime::ws::registry().lock().remove(&conn_id);
                return;
            }

            // Wrap the stream with tokio-tungstenite in Server role. The handshake
            // is already done so we use from_raw_socket (skips the built-in
            // handshake which would otherwise expect to read the request line).
            //
            // WebSocketStream<S> requires S: AsyncRead + AsyncWrite + Unpin.
            // `io::TcpStream::into_inner()` yields the inner tokio::net::TcpStream
            // which satisfies that.
            use tokio_tungstenite::tungstenite::protocol::Role;
            let inner = s.into_inner();
            let ws_stream =
                tokio_tungstenite::WebSocketStream::from_raw_socket(inner, Role::Server, None)
                    .await;
            // Spawn ws_conn_task as a detached task so handle_conn returns and
            // the accept-worker can take other connections. The per-conn task
            // owns the WebSocketStream + sends to TCP independently.
            crate::server::transport::spawn(async move {
                crate::realtime::ws::ws_conn_task(
                    ws_stream, conn_id, send_rx,
                    30_000,    // pingMs default — per-route forwarding is a follow-up
                    1_048_576, // 1 MB max msg — per-route forwarding is a follow-up
                )
                .await;
            });
            return;
        }

        // Navigation interceptor: client-side SPA navigation fetches arrive at
        // /_brust/page/{real_path} and want a JSON {html, title} envelope back
        // (the JS-side `navigationBranch` handles the serialisation). We strip
        // the prefix, resolve the underlying route, and re-discriminate the
        // envelope's `kind` so the same dispatch_to_worker_and_stream_chunks
        // helper carries the request through to the worker.
        if let Some(stripped) = path.strip_prefix("/_brust/page") {
            if method != "GET" {
                let _ = s.write_all(http::error_405()).await;
                continue;
            }
            let real_path = if stripped.is_empty() { "/" } else { stripped };
            let (envelope, _route_id) = match routes.match_path(&method, real_path, &buf) {
                MatchResult::Matched {
                    mut envelope,
                    route_id,
                } => {
                    envelope.kind = "navigation";
                    (envelope, route_id)
                }
                MatchResult::NoMatch => {
                    let body = br#"{"error":"not found"}"#.to_vec();
                    let _ = s
                        .write_all(http::build_response(
                            404,
                            "application/json; charset=utf-8",
                            &[],
                            body,
                        ))
                        .await;
                    continue;
                }
            };
            match dispatch_to_worker_and_stream_chunks(
                &mut s,
                &pool,
                envelope,
                "navigation",
                false, // cache_wanted — navigation responses never cache
                |_| {},
            )
            .await
            {
                DispatchControl::Continue => continue,
                DispatchControl::CloseConn => return,
            }
        }

        let (envelope, route_id) = match routes.match_path(&method, &path, &buf) {
            MatchResult::Matched { envelope, route_id } => (envelope, route_id),
            MatchResult::NoMatch => {
                let _ = s.write_all(http::error_404()).await;
                continue;
            }
        };

        let cache_config = routes.cache_for(route_id);
        let cache_key = cache_config
            .as_ref()
            .map(|cfg| build_cache_key(&method, &path, cfg, &buf));
        if let Some(key) = &cache_key
            && let Some(bytes) = cache.get(key)
        {
            if s.write_all(bytes).await.is_err() {
                return;
            }
            continue;
        }

        // Native (jinja) routes are guaranteed single-chunk: the worker always
        // takes the fast lane (Rust-side render → framed bytes in the SAB).
        // Route them through the channel-free, lock-free dispatch_single_chunk.
        // Native routes never cache (validated at defineRoutes time), so no
        // cache write-back is needed here.
        if routes.native_template_for(route_id).is_some() {
            match dispatch_single_chunk(&mut s, &pool, envelope, "render", false, |_| {}).await {
                DispatchControl::Continue => continue,
                DispatchControl::CloseConn => return,
            }
        }

        // React render path receives the final response bytes via on_success
        // when the response collapsed to a single Content-Length chunk (the
        // only shape we cache — Suspense streams are never cached). The cache
        // key and config move into the closure, so they're only inserted when a
        // cache key was actually built for this request.
        let cache_for_closure = cache.clone();
        let cache_wanted = cache_config.is_some();
        match dispatch_to_worker_and_stream_chunks(
            &mut s,
            &pool,
            envelope,
            "render",
            cache_wanted,
            move |bytes| {
                if let (Some(key), Some(cfg)) = (cache_key, cache_config) {
                    cache_for_closure.insert(
                        key,
                        bytes.to_vec(),
                        Duration::from_secs(cfg.ttl_seconds),
                    );
                }
            },
        )
        .await
        {
            DispatchControl::Continue => continue,
            DispatchControl::CloseConn => return,
        }
    }
}

/// Shared dispatch for the action, mcp, and render branches: pick a worker,
/// install a RenderSlot, kick off the tsfn (Promise<()>) WITHOUT awaiting,
/// loop the chunk channel writing to the socket as chunks arrive. Cache
/// inserts only on the single-chunk (streaming:false) path because Suspense
/// streams are inherently un-cacheable as a whole-response shape.
///
/// The helper races `render_future` against `chunk_rx.recv()` in a `biased`
/// select so chunks (the load-bearing path) always win when both are ready.
/// Both terminal paths drain the necessary cleanup: chunked → emit terminator,
/// content-length → flush buffered single response.
///
/// NOTE (pre-existing latent race — see RenderClaim::drop INVARIANT): the
/// mid-stream `write_all`-error arms below `return CloseConn` while the worker's
/// JS may still be running. That drops the RenderClaim early, recycling the
/// worker before its Promise settles. A stray `napi_render_chunk` from the old
/// render can then land in a new streaming claim's channel, or a new claim can
/// write the SAB concurrently with the old JS. Streaming-only and not currently
/// reachable via fast-lane paths; fixing it needs generation tracking or gating
/// worker release on Promise settlement. Tracked, not addressed here.
/// Why `claim_or_wait` gave up without a worker.
enum ClaimWaitErr {
    /// No workers registered at all — none will ever appear, so 503 at once.
    NoWorkers,
    /// Every worker stayed busy until `claim_timeout_ms` — 503 last-resort.
    Timeout,
}

/// Claim a render worker, AWAITING a free one (up to `claim_timeout_ms`) on
/// AllBusy instead of failing fast with 503. This is what lets `connWorkers`
/// exceed `workers` without a 503 storm: excess conn-tasks park on the pool's
/// `idle_notify` until a render finishes (`RenderClaim::drop`), then re-claim.
///
/// `PoolEmpty` is never waited on. `try_claim` is re-invoked each iteration —
/// the streaming caller must hand a closure that clones a FRESH chunk_tx per
/// call, since a successful claim consumes one.
async fn claim_or_wait(
    pool: &crate::render::pool::WorkerPool,
    mut try_claim: impl FnMut() -> crate::render::pool::ClaimResult,
) -> Result<crate::render::pool::RenderClaim, ClaimWaitErr> {
    let deadline =
        tokio::time::Instant::now() + std::time::Duration::from_millis(tuning().claim_timeout_ms);
    loop {
        // Register interest BEFORE the claim attempt: a worker freed between a
        // failed `try_claim` and the `.await` stores a permit on the Notify
        // rather than being a lost wakeup. Combined with re-claiming every
        // iteration, this can't deadlock with idle workers available.
        let notified = pool.idle_notify().notified();
        tokio::pin!(notified);
        notified.as_mut().enable();

        match try_claim() {
            crate::render::pool::ClaimResult::Claimed(c) => return Ok(c),
            crate::render::pool::ClaimResult::PoolEmpty => return Err(ClaimWaitErr::NoWorkers),
            crate::render::pool::ClaimResult::AllBusy => {}
        }

        tokio::select! {
            _ = &mut notified => { /* a worker freed — loop and re-claim */ }
            _ = tokio::time::sleep_until(deadline) => return Err(ClaimWaitErr::Timeout),
        }
    }
}

async fn dispatch_to_worker_and_stream_chunks<E, F>(
    s: &mut TcpStream,
    pool: &Arc<crate::render::pool::WorkerPool>,
    envelope: E,
    label: &'static str,
    cache_wanted: bool,
    on_success: F,
) -> DispatchControl
where
    E: serde::Serialize,
    F: FnOnce(&[u8]),
{
    let (chunk_tx, mut chunk_rx) =
        tokio::sync::mpsc::channel::<crate::render::pool::RenderChunk>(1);

    let claim = match claim_or_wait(pool, || pool.try_claim_render(chunk_tx.clone())).await {
        Ok(c) => c,
        Err(ClaimWaitErr::NoWorkers) => {
            let _ = s.write_all(http::error_503("no workers")).await;
            return DispatchControl::CloseConn;
        }
        Err(ClaimWaitErr::Timeout) => {
            let _ = s.write_all(http::error_503("all workers busy")).await;
            return DispatchControl::CloseConn;
        }
    };
    let entry = std::sync::Arc::clone(claim.entry());
    // `claim` holds slot + in_flight until the function returns (RAII).

    // Distinguish the two failure layers so we can react differently:
    // - EnqueueFailed → napi bridge dead, remove worker from pool.
    // - PromiseRejected → JS-level error, worker still alive.
    enum RenderOutcome {
        /// bridge enqueue failed — worker is dead, remove it.
        EnqueueFailed(crate::render::RenderError),
        /// JS Promise rejected — JS-level error, worker is still alive.
        PromiseRejected(crate::render::RenderError),
        /// JS Promise resolved with a framed-response length. `len > 0` →
        /// fast lane: the worker wrote `[meta_len][meta][body]` into the SAB
        /// instead of using the chunk channel; read it directly. `len == 0` →
        /// the worker used the chunk channel (streaming/sse/ws) and the chunk
        /// arm already handled the socket writes.
        Resolved(u32),
    }

    let envelope_len = {
        let (buf_ptr, buf_cap) = entry.dispatch.buf();
        let mut cursor =
            std::io::Cursor::new(unsafe { std::slice::from_raw_parts_mut(buf_ptr, buf_cap) });
        if let Err(e) = serde_json::to_writer(&mut cursor, &envelope) {
            if e.is_io() {
                let _ = s.write_all(http::error_413()).await;
                return DispatchControl::CloseConn;
            }
            error!(worker_id = entry.id, label, error = %e, "envelope serialization failed");
            let _ = s.write_all(http::error_500()).await;
            return DispatchControl::CloseConn;
        }
        cursor.position() as u32
    };

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
    tokio::pin!(render_future);

    let mut headers_written = false;
    let mut chunked = false;
    let mut buffered_meta: Option<crate::render::stream::ChunkMeta> = None;
    let mut buffered_body: Vec<u8> = Vec::new();
    let mut response_bytes_for_cache: Vec<u8> = Vec::new();

    loop {
        tokio::select! {
            biased;
            Some(chunk) = chunk_rx.recv() => {
                match chunk {
                    crate::render::pool::RenderChunk::Bytes { data, ack } => {
                        if !headers_written {
                            let (meta_slice, body) = match crate::render::stream::split_meta(&data) {
                                Ok(x) => x,
                                Err(e) => {
                                    error!(worker_id = entry.id, label, error = e, "split_meta failed");
                                    let _ = s.write_all(http::error_500()).await;
                                    let _ = ack.send(());
                                    return DispatchControl::CloseConn;
                                }
                            };
                            let parsed: crate::render::stream::ChunkMeta =
                                match serde_json::from_slice(meta_slice) {
                                    Ok(m) => m,
                                    Err(e) => {
                                        error!(worker_id = entry.id, label, error = %e, "meta JSON parse failed");
                                        let _ = s.write_all(http::error_500()).await;
                                        let _ = ack.send(());
                                        return DispatchControl::CloseConn;
                                    }
                                };
                            chunked = parsed.streaming;
                            if chunked {
                                let head = crate::render::stream::build_chunked_response_head(&parsed);
                                if s.write_all(head).await.is_err() {
                                    let _ = ack.send(());
                                    return DispatchControl::CloseConn;
                                }
                                let framed = crate::render::stream::format_chunk_framed(body);
                                if s.write_all(framed).await.is_err() {
                                    let _ = ack.send(());
                                    return DispatchControl::CloseConn;
                                }
                            } else {
                                buffered_meta = Some(parsed);
                                buffered_body.extend_from_slice(body);
                            }
                            headers_written = true;
                        } else if chunked {
                            let framed = crate::render::stream::format_chunk_framed(&data);
                            if s.write_all(framed).await.is_err() {
                                let _ = ack.send(());
                                return DispatchControl::CloseConn;
                            }
                        } else {
                            warn!(
                                worker_id = entry.id, label,
                                "non-streaming worker emitted extra chunk; appending",
                            );
                            buffered_body.extend_from_slice(&data);
                        }
                        let _ = ack.send(());
                    }
                    crate::render::pool::RenderChunk::Final { ack } => {
                        if chunked {
                            let term = crate::render::stream::format_chunk_framed(b"");
                            let _ = s.write_all(term).await;
                        } else if let Some(meta) = buffered_meta.take() {
                            let resp = crate::render::stream::build_single_response_bytes(&meta, &buffered_body);
                            if cache_wanted {
                                response_bytes_for_cache = resp.clone();
                            }
                            if s.write_all(resp).await.is_err() {
                                let _ = ack.send(());
                                return DispatchControl::CloseConn;
                            }
                        }
                        let _ = ack.send(());
                        break;
                    }
                    crate::render::pool::RenderChunk::BytesAndFinal { data, ack } => {
                        // Buffering-path single-call: parse meta, build full response,
                        // write to socket, populate cache write-back, ack. Byte-equivalent
                        // to Bytes-then-Final for the same `data`.
                        let (meta_slice, body) = match crate::render::stream::split_meta(&data) {
                            Ok(x) => x,
                            Err(e) => {
                                error!(worker_id = entry.id, label, error = e, "split_meta failed (BytesAndFinal)");
                                let _ = s.write_all(http::error_500()).await;
                                let _ = ack.send(());
                                return DispatchControl::CloseConn;
                            }
                        };
                        let parsed: crate::render::stream::ChunkMeta = match serde_json::from_slice(meta_slice) {
                            Ok(m) => m,
                            Err(e) => {
                                error!(worker_id = entry.id, label, error = %e, "meta JSON parse failed (BytesAndFinal)");
                                let _ = s.write_all(http::error_500()).await;
                                let _ = ack.send(());
                                return DispatchControl::CloseConn;
                            }
                        };

                        if parsed.streaming {
                            // Misuse: streaming-meta in a buffering call. Emit byte-equivalent
                            // chunked headers + framed body + chunked terminator so the wire
                            // output still matches Bytes-then-Final in chunked mode.
                            warn!(
                                worker_id = entry.id, label,
                                "BytesAndFinal received in streaming mode — emitting chunked + terminator",
                            );
                            let head = crate::render::stream::build_chunked_response_head(&parsed);
                            if s.write_all(head).await.is_err() {
                                let _ = ack.send(());
                                return DispatchControl::CloseConn;
                            }
                            let framed = crate::render::stream::format_chunk_framed(body);
                            if s.write_all(framed).await.is_err() {
                                let _ = ack.send(());
                                return DispatchControl::CloseConn;
                            }
                            let term = crate::render::stream::format_chunk_framed(b"");
                            let _ = s.write_all(term).await;
                            // No cache write-back in chunked mode (matches existing Final arm).
                        } else {
                            // Canonical buffering use-case: single Content-Length response.
                            // Build the response bytes once; clone only when the cache needs
                            // an owned copy independent of the write_all transfer. The plan's
                            // original writev path was measured slower on macOS (per
                            // 2026-05-28 N=5 medians — see plan T7 BLOCKED #2 mitigation),
                            // so we keep the concat write but preserve the cache-clone skip
                            // for the uncached hot path.
                            let resp = crate::render::stream::build_single_response_bytes(&parsed, body);
                            if cache_wanted {
                                response_bytes_for_cache = resp.clone();
                            }
                            if s.write_all(resp).await.is_err() {
                                let _ = ack.send(());
                                return DispatchControl::CloseConn;
                            }
                        }

                        let _ = ack.send(());
                        break;
                    }
                }
            }
            outcome = &mut render_future => {
                match outcome {
                    RenderOutcome::Resolved(resp_len) => {
                        // Fast lane: the worker wrote a complete framed response
                        // `[meta_len][meta][body]` into the SAB and resolved with
                        // its length, bypassing the chunk channel (no mpsc send,
                        // no per-chunk ack round-trip, no second napi call). Read
                        // it directly. Guarded by !headers_written so a worker that
                        // (mis)used both paths still falls through to the
                        // chunk-channel logic below.
                        if !headers_written && resp_len > 0 {
                            let len = resp_len as usize;
                            if len > entry.dispatch.buf_len() {
                                error!(
                                    worker_id = entry.id, label, len, buf_len = entry.dispatch.buf_len(),
                                    "fast-lane resp_len exceeds SAB capacity",
                                );
                                let _ = s.write_all(http::error_500()).await;
                                break;
                            }
                            // SAFETY: the worker's render Promise has resolved
                            // (happens-before via napi tsfn.await), so JS is done
                            // writing the SAB and won't touch it until the next
                            // claim. `len <= buf_len` bounds the read.
                            let (buf_ptr, _cap) = entry.dispatch.buf();
                            let buf = unsafe { std::slice::from_raw_parts(buf_ptr, len) };
                            match crate::render::stream::split_meta(buf)
                                .and_then(|(meta_slice, body)| {
                                    serde_json::from_slice::<crate::render::stream::ChunkMeta>(meta_slice)
                                        .map(|meta| (meta, body))
                                        .map_err(|_| "fast-lane meta JSON parse failed")
                                }) {
                                Ok((meta, body)) => {
                                    let resp = crate::render::stream::build_single_response_bytes(&meta, body);
                                    if cache_wanted {
                                        response_bytes_for_cache = resp.clone();
                                    }
                                    let _ = s.write_all(resp).await;
                                }
                                Err(e) => {
                                    error!(worker_id = entry.id, label, error = e, "fast-lane response decode failed");
                                    let _ = s.write_all(http::error_500()).await;
                                }
                            }
                            break;
                        }
                        let dropped = chunk_rx.len();
                        if dropped > 0 {
                            warn!(
                                worker_id = entry.id, label, dropped,
                                "worker returned without Final signal; queued chunks dropped",
                            );
                        }
                        if chunked {
                            // C5: emit terminator so browser doesn't see
                            // ERR_INCOMPLETE_CHUNKED_ENCODING.
                            let _ = s.write_all(crate::render::stream::format_chunk_framed(b"")).await;
                        } else if let Some(meta) = buffered_meta.take() {
                            let resp = crate::render::stream::build_single_response_bytes(&meta, &buffered_body);
                            if cache_wanted {
                                response_bytes_for_cache = resp.clone();
                            }
                            let _ = s.write_all(resp).await;
                        }
                        break;
                    }
                    RenderOutcome::PromiseRejected(e) => {
                        error!(worker_id = entry.id, label, error = %e,
                               "render tsfn JS Promise rejected — worker still alive");
                        if !headers_written {
                            let _ = s.write_all(http::error_500()).await;
                        }
                        // Mid-stream: hang up; client sees ERR_INCOMPLETE_CHUNKED_ENCODING.
                        // Worker stays in pool.
                        break;
                    }
                    RenderOutcome::EnqueueFailed(e) => {
                        error!(worker_id = entry.id, label, error = %e,
                               "render tsfn enqueue failed — worker dead, removing from pool");
                        pool.remove(entry.id);
                        if pool.registered_count() == 0 {
                            error!("no workers left after enqueue failure — terminating process");
                            std::process::exit(1);
                        }
                        if !headers_written {
                            let _ = s.write_all(http::build_response(
                                502,
                                "text/plain",
                                &[],
                                b"bad gateway".to_vec(),
                            )).await;
                        }
                        return DispatchControl::CloseConn;
                    }
                }
            }
        }
    }

    if cache_wanted && !response_bytes_for_cache.is_empty() {
        on_success(&response_bytes_for_cache);
    }
    DispatchControl::Continue
}

/// Maximally-stripped dispatch for guaranteed-single-chunk requests (actions).
/// vs `dispatch_to_worker_and_stream_chunks`: NO mpsc channel allocation, NO
/// per-entry mutex (lock-free `idle` CAS claim), NO `tokio::select!` loop. The
/// worker MUST take the fast lane — write `[meta_len][meta][body]` into the SAB
/// and resolve with its byte length. We claim, serialize, await the Promise,
/// read the SAB, write. A resolve of 0 (worker used the chunk channel) is a
/// contract violation here → 500.
async fn dispatch_single_chunk<E, F>(
    s: &mut TcpStream,
    pool: &Arc<crate::render::pool::WorkerPool>,
    envelope: E,
    label: &'static str,
    cache_wanted: bool,
    on_success: F,
) -> DispatchControl
where
    E: serde::Serialize,
    F: FnOnce(&[u8]),
{
    let claim = match claim_or_wait(pool, || pool.try_claim_render_lockfree()).await {
        Ok(c) => c,
        Err(ClaimWaitErr::NoWorkers) => {
            let _ = s.write_all(http::error_503("no workers")).await;
            return DispatchControl::CloseConn;
        }
        Err(ClaimWaitErr::Timeout) => {
            let _ = s.write_all(http::error_503("all workers busy")).await;
            return DispatchControl::CloseConn;
        }
    };
    let entry = std::sync::Arc::clone(claim.entry());

    let envelope_len = {
        let (buf_ptr, buf_cap) = entry.dispatch.buf();
        let mut cursor =
            std::io::Cursor::new(unsafe { std::slice::from_raw_parts_mut(buf_ptr, buf_cap) });
        if let Err(e) = serde_json::to_writer(&mut cursor, &envelope) {
            if e.is_io() {
                let _ = s.write_all(http::error_413()).await;
                return DispatchControl::CloseConn;
            }
            error!(worker_id = entry.id, label, error = %e, "envelope serialization failed");
            let _ = s.write_all(http::error_500()).await;
            return DispatchControl::CloseConn;
        }
        cursor.position() as u32
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
            let _ = s
                .write_all(http::build_response(
                    502,
                    "text/plain",
                    &[],
                    b"bad gateway".to_vec(),
                ))
                .await;
            return DispatchControl::CloseConn;
        }
        Err(e @ crate::render::RenderError::PromiseRejected(_)) => {
            error!(worker_id = entry.id, label, error = %e,
                   "render tsfn JS Promise rejected — worker still alive");
            let _ = s.write_all(http::error_500()).await;
            return DispatchControl::CloseConn;
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
        let _ = s.write_all(http::error_500()).await;
        return DispatchControl::CloseConn;
    }

    // SAFETY: render Promise resolved (happens-before via napi tsfn.await), JS
    // done writing the SAB; resp_len bounds-checked above.
    let (buf_ptr, _cap) = entry.dispatch.buf();
    let buf = unsafe { std::slice::from_raw_parts(buf_ptr, resp_len as usize) };
    match crate::render::stream::split_meta(buf).and_then(|(meta_slice, body)| {
        serde_json::from_slice::<crate::render::stream::ChunkMeta>(meta_slice)
            .map(|meta| (meta, body))
            .map_err(|_| "single-chunk meta JSON parse failed")
    }) {
        Ok((meta, body)) => {
            let resp = crate::render::stream::build_single_response_bytes(&meta, body);
            if cache_wanted {
                on_success(&resp);
            }
            let _ = s.write_all(resp).await;
        }
        Err(e) => {
            error!(
                worker_id = entry.id,
                label,
                error = e,
                "single-chunk response decode failed"
            );
            let _ = s.write_all(http::error_500()).await;
            return DispatchControl::CloseConn;
        }
    }
    DispatchControl::Continue
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
    // 64-header ceiling: enough for Apache-default-shaped requests; a vary header
    // beyond this is silently treated as missing, which would cause a cache key
    // collision across variants. Bump if real traffic ever hits the cap.
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

async fn read_full_request(s: &mut TcpStream, buf: &mut Vec<u8>) -> ReadOutcome {
    while buf.len() < tuning().max_request_bytes {
        let n = match s.read_request(buf).await {
            Ok(n) => n,
            Err(e) => {
                warn!(error = %e, "read failed");
                return ReadOutcome::ClosedBeforeHeaders;
            }
        };
        if n == 0 {
            return ReadOutcome::ClosedBeforeHeaders;
        }
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            return ReadOutcome::Complete;
        }
    }
    ReadOutcome::Oversize
}

/// Reject filenames containing path separators, leading dots, or anything
/// outside `[A-Za-z0-9_.-]`. The filename MUST end in `.js`. This is the
/// only sanitization between the request line and `tokio::fs::read`.
fn is_safe_island_filename(name: &str) -> bool {
    if !name.ends_with(".js") {
        return false;
    }
    // Drop leading-dot files (.env.js, etc).
    if name.starts_with('.') {
        return false;
    }
    // `..` substring also rejects names like `a..b.js` — intentional belt
    // and suspenders against any traversal-shaped input.
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return false;
    }
    name.bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// Mirrors `is_safe_island_filename` but accepts `.css` extension. Keep the
/// two functions structurally identical — anything that's safe as an island
/// chunk filename is also safe as a CSS asset filename, modulo extension.
fn is_safe_css_filename(name: &str) -> bool {
    if !name.ends_with(".css") {
        return false;
    }
    if name.starts_with('.') {
        return false;
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return false;
    }
    name.bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// Extract `Content-Length` from a buffered HTTP request's headers. Returns
/// None if the header is missing or unparseable. Caller has already ensured
/// `\r\n\r\n` is present in `buf`.
fn parse_content_length(buf: &[u8]) -> Option<usize> {
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut req = httparse::Request::new(&mut headers);
    let _ = req.parse(buf);
    for h in req.headers.iter() {
        if h.name.eq_ignore_ascii_case("content-length") {
            let s = std::str::from_utf8(h.value).ok()?;
            return s.trim().parse::<usize>().ok();
        }
    }
    None
}

#[derive(Debug)]
enum BodyClass {
    Empty,
    Sized(usize),
    Chunked,
}

/// Classify a request body per RFC 7230 §3.3.3 in a SINGLE header pass:
/// Transfer-Encoding (any value) wins over Content-Length and is surfaced as
/// `Chunked` for the caller to reject (we don't decode it); a parseable
/// `Content-Length` → `Sized`; neither → `Empty` (no body). On a header parse
/// error we conservatively report `Empty` so a Content-Length we couldn't fully
/// validate is never trusted to bound a body read.
///
/// One pass (vs. delegating to `parse_content_length` + a second walk) keeps the
/// action hot path to a single httparse parse, and makes TE-wins-over-CL hold
/// regardless of header order: any Transfer-Encoding seen short-circuits to
/// `Chunked` before a Content-Length is honoured.
fn classify_request_body(header: &[u8]) -> BodyClass {
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut req = httparse::Request::new(&mut headers);
    if req.parse(header).is_err() {
        return BodyClass::Empty;
    }
    let mut content_length: Option<usize> = None;
    for h in req.headers.iter() {
        if h.name.eq_ignore_ascii_case("transfer-encoding") {
            return BodyClass::Chunked;
        }
        if h.name.eq_ignore_ascii_case("content-length") {
            content_length = std::str::from_utf8(h.value)
                .ok()
                .and_then(|s| s.trim().parse::<usize>().ok());
        }
    }
    match content_length {
        Some(n) => BodyClass::Sized(n),
        None => BodyClass::Empty,
    }
}

/// Extract `Content-Type` from a buffered HTTP request's headers. Returns
/// None if the header is missing. Whitespace-trimmed. Preserves the
/// parameter part (e.g. `; boundary=...`) since the JS side needs it
/// to parse multipart bodies. Caller has already ensured `\r\n\r\n` is
/// present in `buf`.
fn parse_content_type(buf: &[u8]) -> Option<String> {
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut req = httparse::Request::new(&mut headers);
    let _ = req.parse(buf);
    for h in req.headers.iter() {
        if h.name.eq_ignore_ascii_case("content-type") {
            return std::str::from_utf8(h.value)
                .ok()
                .map(|s| s.trim().to_string());
        }
    }
    None
}

/// Parse a header value by name (case-insensitive). Returns the trimmed value
/// if present. Used for Accept-header validation in the SSE branch.
fn parse_header_value(buf: &[u8], name: &str) -> Option<String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_assets_are_no_store_prod_cacheable() {
        // Dev hot reload rebuilds unhashed chunk URLs (Counter.js); a cacheable
        // header would mask the rebuild in the browser. Dev must be no-store.
        assert_eq!(asset_cache_control(true), "no-store");
        assert_eq!(asset_cache_control(false), "public, max-age=3600");
    }

    #[test]
    fn percent_decode_path_decodes_escapes_but_keeps_plus_literal() {
        // Static-asset path lookup: %XX → byte; but unlike query strings, a '+'
        // in a PATH is a literal '+', NOT a space. The manifest key is the raw
        // filename, so "/img/a%20b.png" must resolve to "/img/a b.png".
        assert_eq!(percent_decode_path("/img/a%20b.png"), "/img/a b.png");
        assert_eq!(percent_decode_path("/a+b.png"), "/a+b.png");
        // Lowercase hex + a non-ASCII byte sequence (é = C3 A9) round-trips.
        assert_eq!(percent_decode_path("/caf%c3%a9.png"), "/café.png");
        // A malformed escape is left verbatim (no panic, no data loss).
        assert_eq!(percent_decode_path("/a%2.png"), "/a%2.png");
        assert_eq!(percent_decode_path("/plain/path.css"), "/plain/path.css");
    }

    #[test]
    fn content_type_for_common_extensions() {
        use std::path::Path;
        assert_eq!(
            content_type_for(Path::new("/p/favicon.ico")),
            "image/x-icon"
        );
        assert_eq!(content_type_for(Path::new("/p/a.png")), "image/png");
        assert_eq!(
            content_type_for(Path::new("/p/a.svg")),
            "image/svg+xml; charset=utf-8"
        );
        assert_eq!(content_type_for(Path::new("/p/a.PNG")), "image/png");
        assert_eq!(content_type_for(Path::new("/p/a.woff2")), "font/woff2");
        assert_eq!(
            content_type_for(Path::new("/p/noext")),
            "application/octet-stream"
        );
        assert_eq!(
            content_type_for(Path::new("/p/a.weird")),
            "application/octet-stream"
        );
    }

    #[test]
    fn safe_filenames_pass() {
        assert!(is_safe_island_filename("Counter.js"));
        assert!(is_safe_island_filename("_react.js"));
        assert!(is_safe_island_filename("_jsx-runtime.js"));
        assert!(is_safe_island_filename("a.b.c.js"));
        assert!(is_safe_island_filename("Foo-Bar_123.js"));
    }

    #[test]
    fn unsafe_empty_rejected() {
        assert!(!is_safe_island_filename(""));
    }

    #[test]
    fn unsafe_no_extension_rejected() {
        assert!(!is_safe_island_filename("Counter"));
        assert!(!is_safe_island_filename("Counter.ts"));
    }

    #[test]
    fn unsafe_dot_prefix_rejected() {
        assert!(!is_safe_island_filename(".env.js"));
    }

    #[test]
    fn unsafe_traversal_rejected() {
        assert!(!is_safe_island_filename("../etc/passwd.js"));
        assert!(!is_safe_island_filename("..passwd.js"));
    }

    #[test]
    fn unsafe_separators_rejected() {
        assert!(!is_safe_island_filename("sub/file.js"));
        assert!(!is_safe_island_filename("sub\\file.js"));
    }

    #[test]
    fn unsafe_spaces_rejected() {
        assert!(!is_safe_island_filename("file with space.js"));
    }

    #[test]
    fn unsafe_percent_rejected() {
        assert!(!is_safe_island_filename("file%20.js"));
    }

    #[test]
    fn unsafe_non_ascii_rejected() {
        assert!(!is_safe_island_filename("évil.js"));
    }

    #[test]
    fn parse_content_length_finds_header() {
        let raw = b"POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: 42\r\n\r\n";
        assert_eq!(parse_content_length(raw), Some(42));
    }

    #[test]
    fn parse_content_length_case_insensitive() {
        let raw = b"POST /x HTTP/1.1\r\nHost: x\r\ncontent-length: 7\r\n\r\n";
        assert_eq!(parse_content_length(raw), Some(7));
    }

    #[test]
    fn parse_content_length_missing_returns_none() {
        let raw = b"POST /x HTTP/1.1\r\nHost: x\r\n\r\n";
        assert_eq!(parse_content_length(raw), None);
    }

    #[test]
    fn parse_content_length_garbage_returns_none() {
        let raw = b"POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: NaN\r\n\r\n";
        assert_eq!(parse_content_length(raw), None);
    }

    #[test]
    fn classify_body_missing_cl_is_empty() {
        let raw = b"DELETE /x HTTP/1.1\r\nHost: x\r\n\r\n";
        assert!(matches!(classify_request_body(raw), BodyClass::Empty));
    }
    #[test]
    fn classify_body_with_cl_is_sized() {
        let raw = b"POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: 7\r\n\r\n";
        assert!(matches!(classify_request_body(raw), BodyClass::Sized(7)));
    }
    #[test]
    fn classify_body_transfer_encoding_is_chunked() {
        let raw = b"POST /x HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n";
        assert!(matches!(classify_request_body(raw), BodyClass::Chunked));
    }
    #[test]
    fn classify_body_te_wins_over_cl() {
        let raw = b"POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n";
        assert!(matches!(classify_request_body(raw), BodyClass::Chunked));
    }
    #[test]
    fn classify_body_te_case_insensitive() {
        let raw = b"POST /x HTTP/1.1\r\nHost: x\r\ntransfer-encoding: Chunked\r\n\r\n";
        assert!(matches!(classify_request_body(raw), BodyClass::Chunked));
    }

    #[test]
    fn parse_content_type_finds_header() {
        let raw = b"POST /x HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n\r\n";
        assert_eq!(
            parse_content_type(raw),
            Some("application/json".to_string())
        );
    }

    #[test]
    fn parse_content_type_case_insensitive_name() {
        let raw = b"POST /x HTTP/1.1\r\nHost: x\r\ncontent-type: text/plain\r\n\r\n";
        assert_eq!(parse_content_type(raw), Some("text/plain".to_string()));
    }

    #[test]
    fn parse_content_type_preserves_parameters() {
        let raw = b"POST /x HTTP/1.1\r\nHost: x\r\nContent-Type: multipart/form-data; boundary=abc123\r\n\r\n";
        assert_eq!(
            parse_content_type(raw),
            Some("multipart/form-data; boundary=abc123".to_string()),
        );
    }

    #[test]
    fn parse_content_type_trims_whitespace() {
        let raw = b"POST /x HTTP/1.1\r\nHost: x\r\nContent-Type:   application/json  \r\n\r\n";
        assert_eq!(
            parse_content_type(raw),
            Some("application/json".to_string())
        );
    }

    #[test]
    fn parse_content_type_missing_returns_none() {
        let raw = b"POST /x HTTP/1.1\r\nHost: x\r\n\r\n";
        assert_eq!(parse_content_type(raw), None);
    }

    #[test]
    fn safe_css_filenames_pass() {
        assert!(is_safe_css_filename("app.css"));
        assert!(is_safe_css_filename("_a.css"));
        assert!(is_safe_css_filename("Foo-Bar_123.css"));
        assert!(is_safe_css_filename("a.b.css"));
    }

    #[test]
    fn unsafe_css_empty_rejected() {
        assert!(!is_safe_css_filename(""));
    }

    #[test]
    fn unsafe_css_wrong_ext_rejected() {
        assert!(!is_safe_css_filename("app.js"));
        assert!(!is_safe_css_filename("app"));
    }

    #[test]
    fn unsafe_css_dot_prefix_rejected() {
        assert!(!is_safe_css_filename(".env.css"));
    }

    #[test]
    fn unsafe_css_traversal_rejected() {
        assert!(!is_safe_css_filename("../etc/passwd.css"));
        assert!(!is_safe_css_filename("..passwd.css"));
    }

    #[test]
    fn unsafe_css_separators_rejected() {
        assert!(!is_safe_css_filename("sub/app.css"));
        assert!(!is_safe_css_filename("sub\\app.css"));
    }
}
