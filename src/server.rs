use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Notify;
use tracing::{error, warn};

use crate::cache::{CacheConfig, CacheKey, LruCache};
use crate::http::{self, parse_request, ParseError};
use crate::io::{run_io, spawn, IO_NAME, TcpListener, TcpStream};
use crate::pool::WorkerPool;
use crate::routes::{MatchResult, RouteTable};

use serde::Deserialize;

fn current_islands_dir() -> Option<std::path::PathBuf> {
    crate::state().islands_dir.read().clone()
}

#[derive(Debug, Deserialize)]
struct ResponseMeta {
    status: u16,
    #[serde(default)]
    headers: std::collections::HashMap<String, String>,
    /// JS-side override for the Content-Type header. Used by the action path
    /// (sets 'application/json') and by middleware short-circuits returning
    /// text. Absent on the render path → Rust uses the default.
    #[serde(default, rename = "contentType")]
    content_type: Option<String>,
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

const MAX_REQUEST_BYTES: usize = 16 * 1024;
/// Cap on action body size. Mirrors the SAB capacity (256 KB default) so
/// the largest action call fits in one SAB write. If the SAB is reconfigured
/// larger by the user, this bound stays — action bodies don't get to grow
/// past the renderer's working buffer.
const MAX_ACTION_BODY_BYTES: usize = 256 * 1024;
// Bound the accept-side queue so a slow worker pool triggers TCP backpressure instead of unbounded memory growth.
const CONN_CHAN_CAP: usize = 1024;

pub fn start(
    addr: SocketAddr,
    ready: Arc<Notify>,
    pool: Arc<WorkerPool>,
    routes: Arc<RouteTable>,
    cache: Arc<LruCache>,
    workers: usize,
) {
    run_io(move || async move {
        let listener = match TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                error!(error = %e, %addr, "bind failed");
                std::process::exit(1);
            }
        };

        let (tx, rx) = flume::bounded::<TcpStream>(CONN_CHAN_CAP);

        // Workers exit only when all Senders drop (i.e. accept loop has exited).
        for _ in 0..workers {
            let rx = rx.clone();
            let pool = pool.clone();
            let routes = routes.clone();
            let cache = cache.clone();
            spawn(async move {
                while let Ok(stream) = rx.recv_async().await {
                    handle_conn(stream, pool.clone(), routes.clone(), cache.clone()).await;
                }
            });
        }
        // Drop the original Receiver. Only the worker clones remain; if all
        // workers exit, tx.send_async() will return Err(Disconnected) and the
        // defensive guard below will fire. Without this drop, the original rx
        // here keeps the channel "connected" forever, masking worker death.
        drop(rx);

        ready.notified().await; // wait until all napi workers have registered
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

async fn handle_conn(
    mut s: TcpStream,
    pool: Arc<WorkerPool>,
    routes: Arc<RouteTable>,
    cache: Arc<LruCache>,
) {
    let mut buf = Vec::with_capacity(4096);
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

        // POST is only legal for /_brust/cache/invalidate, /_brust/action/*,
        // and /_brust/mcp; everything else requires GET. For action paths, 405
        // means "POST is the only allowed method here" — body must already have
        // been consumed (or absent). The fixed `Connection: keep-alive` header
        // in error_405 is correct because we haven't read a body yet.
        if method != "GET"
            && !(method == "POST" && path.starts_with("/_brust/cache/invalidate"))
            && !(method == "POST" && path.starts_with("/_brust/action/"))
            && !(method == "POST" && path == "/_brust/mcp")
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
            let dir = match current_islands_dir() {
                Some(d) => d,
                None => {
                    let _ = s.write_all(http::error_404()).await;
                    continue;
                }
            };
            let file_path = dir.join(file);
            match tokio::fs::read(&file_path).await {
                Ok(bytes) => {
                    let extra = [(
                        "Cache-Control".to_string(),
                        "public, max-age=3600".to_string(),
                    )];
                    let resp = http::build_response(
                        200,
                        "application/javascript; charset=utf-8",
                        &extra,
                        bytes,
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

        // Native-only route: server-function dispatch.
        //   POST /_brust/action/<id>
        // Body: JSON array of args. Worker decodes the array and calls fn(req, ...args).
        // Status codes:
        //   404 — id charset invalid or not in registry
        //   405 — non-POST method (covered by outer method gate, but keep belt+suspenders)
        //   411 — Content-Length missing
        //   413 — Content-Length > SAB capacity
        //   400 — body not valid UTF-8
        // 5xx — fn throws / middleware throws (handled by the JS side via meta envelope)
        if let Some(after) = path.strip_prefix("/_brust/action/") {
            // The outer method gate has already rejected non-POST; the duplicate check
            // here covers future refactors that might split the gate.
            if method != "POST" {
                let _ = s.write_all(http::error_405()).await;
                return;
            }
            // Strip any query string from the id (action calls may add ?dryRun=1
            // — the request still has the query string in req.search, but the id
            // itself must be the bare segment).
            let id = after.split('?').next().unwrap_or(after);
            if !is_safe_action_id(id) {
                let _ = s.write_all(http::error_404()).await;
                continue;
            }
            if !crate::action_id_registered(id) {
                let _ = s.write_all(http::error_404()).await;
                continue;
            }

            // Locate the body in `buf`. parse_request only gave us method+path; we
            // need to find \r\n\r\n to skip the headers, then read Content-Length bytes.
            let header_end = match buf.windows(4).position(|w| w == b"\r\n\r\n") {
                Some(p) => p + 4,
                None => {
                    let _ = s.write_all(http::error_400()).await;
                    return;
                }
            };
            let content_length = match parse_content_length(&buf[..header_end]) {
                Some(n) => n,
                None => {
                    let _ = s.write_all(http::error_411()).await;
                    return;
                }
            };
            if content_length > MAX_ACTION_BODY_BYTES {
                let _ = s.write_all(http::error_413()).await;
                return;
            }

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
                // Text body — UTF-8 validated.
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

            let envelope_json = crate::routes::build_action_envelope(
                &method,
                &path,
                id,
                &content_type,
                body_text_string.as_deref(),
                body_b64_string.as_deref(),
                &buf[..header_end],
            );

            // Action endpoint never caches, so on_success is a no-op. Content-Type
            // is taken from meta if present (JS sets 'application/json' for normal
            // returns and 'text/plain' for middleware string short-circuits).
            match dispatch_to_worker_and_send_meta_response(
                &mut s,
                &pool,
                envelope_json,
                "action",
                "application/json; charset=utf-8",
                true,
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
                None => { let _ = s.write_all(http::error_400()).await; return; }
            };
            let content_type = parse_content_type(&buf[..header_end]).unwrap_or_default();
            if !content_type.to_ascii_lowercase().starts_with("application/json") {
                let _ = s.write_all(http::error_415()).await;
                return;
            }
            let content_length = match parse_content_length(&buf[..header_end]) {
                Some(n) => n,
                None => { let _ = s.write_all(http::error_411()).await; return; }
            };
            // Same cap as action — single global body envelope limit (SAB capacity).
            if content_length > MAX_ACTION_BODY_BYTES {
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
                        Err(_) => { let _ = s.write_all(http::error_400()).await; return; }
                    };
                    if n == 0 { let _ = s.write_all(http::error_400()).await; return; }
                    read_so_far += n;
                }
            }
            let body_slice = &buf[header_end..header_end + content_length];
            let body_str = match std::str::from_utf8(body_slice) {
                Ok(s) => s,
                Err(_) => { let _ = s.write_all(http::error_400()).await; continue; }
            };

            let envelope_json = crate::routes::build_mcp_envelope(
                &method, &path, body_str, &buf[..header_end],
            );

            match dispatch_to_worker_and_send_meta_response(
                &mut s,
                &pool,
                envelope_json,
                "mcp",
                "application/json; charset=utf-8",
                true,
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
            if method != "POST" {
                let _ = s.write_all(http::error_405()).await;
                return;
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
        if crate::sse::path_is_sse(&path) {
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
            let conn_id = crate::sse::next_conn_id();
            let (frame_tx, frame_rx) = tokio::sync::mpsc::channel::<crate::sse::SseFrame>(32);
            let (open_tx, open_rx) = tokio::sync::oneshot::channel::<crate::sse::SseOpenSignal>();
            crate::sse::registry().lock().insert(conn_id, crate::sse::SseConn {
                frame_tx,
                open_tx: Some(open_tx),
                abort_cb: None,
            });

            // Pick a worker and dispatch.
            let Some(entry) = pool.pick_least_busy() else {
                let _ = s.write_all(http::error_500()).await;
                crate::sse::registry().lock().remove(&conn_id);
                return;
            };
            let envelope_json = crate::routes::build_sse_envelope(
                &method, &path, &buf[..header_end], conn_id,
            );

            // TODO(Task 6): replace with crate::pool::dispatch_sse(entry, envelope_json, conn_id)
            // For now, fire the tsfn call directly. The JS side branches on kind: 'sse' and
            // runs the entire lifecycle there. call_async mirrors how render/action/mcp dispatch.
            //
            // in_flight_guard counts only the dispatch enqueue, not the entire SSE lifetime —
            // a long-lived stream must not make `pick_least_busy` see this worker as busy for
            // all subsequent HTTP requests. Drop the guard the moment the tsfn handoff completes.
            {
                let _guard = entry.in_flight_guard();
                if let Err(e) = entry.tsfn.call_async(envelope_json).await {
                    error!(worker_id = entry.id, error = %e, "sse tsfn call_async failed");
                    let _ = s.write_all(http::error_500()).await;
                    crate::sse::registry().lock().remove(&conn_id);
                    return;
                }
            }

            // Await the open signal with timeout. Distinguish sender-dropped (JS crash)
            // from timeout (genuinely slow middleware) in the logs so Task 13 smoke
            // failures are diagnosable.
            let open = match tokio::time::timeout(std::time::Duration::from_secs(30), open_rx).await {
                Ok(Ok(signal)) => signal,
                Ok(Err(_)) => {
                    warn!(conn_id, "sse open_tx sender dropped before signal — JS crash?");
                    let _ = s.write_all(http::error_500()).await;
                    crate::sse::registry().lock().remove(&conn_id);
                    return;
                }
                Err(_) => {
                    warn!(conn_id, "sse open signal timeout (30s)");
                    let _ = s.write_all(http::error_500()).await;
                    crate::sse::registry().lock().remove(&conn_id);
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
                crate::sse::registry().lock().remove(&conn_id);
                return;
            }

            // Open OK — write SSE headers, hand the socket to the per-conn task.
            if crate::sse::write_sse_response_headers(&mut s).await.is_err() {
                crate::sse::registry().lock().remove(&conn_id);
                return;
            }
            crate::sse::sse_conn_task(s, conn_id, frame_rx).await;
            return;
        }

        let (envelope_json, route_id) = match routes.match_path(&method, &path, &buf) {
            MatchResult::Matched { envelope_json, route_id } => (envelope_json, route_id),
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

        // Render path still hardcodes text/html (prefer_meta_content_type=false).
        // The cache.insert hook receives the final response bytes; clone-into-vec
        // only happens when a cache key was actually built.
        let cache_for_closure = cache.clone();
        match dispatch_to_worker_and_send_meta_response(
            &mut s,
            &pool,
            envelope_json,
            "render",
            "text/html; charset=utf-8",
            false,
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

/// Shared dispatch for both the action and render branches: pick a worker,
/// hold the in-flight guard, call the tsfn, decode the SAB-encoded envelope,
/// build the HTTP response, and write it to the stream. Every failure path
/// writes its own error response before returning CloseConn.
///
/// `prefer_meta_content_type = true` lets the worker override Content-Type via
/// `ResponseMeta.contentType` (used by the action path; render path keeps the
/// MVP behavior of hardcoded `text/html`). `on_success` runs synchronously on
/// the final response bytes immediately before write — used by the render path
/// for cache.insert. Returning a value from on_success is not supported because
/// the helper owns the bytes from here on.
async fn dispatch_to_worker_and_send_meta_response<F>(
    s: &mut TcpStream,
    pool: &Arc<crate::pool::WorkerPool>,
    envelope_json: String,
    label: &'static str,
    default_content_type: &'static str,
    prefer_meta_content_type: bool,
    on_success: F,
) -> DispatchControl
where
    F: FnOnce(&[u8]),
{
    let Some(entry) = pool.pick_least_busy() else {
        let _ = s.write_all(http::error_503("no workers")).await;
        return DispatchControl::CloseConn;
    };
    let _guard = entry.in_flight_guard();

    match entry.tsfn.call_async(envelope_json).await {
        Ok(promise) => match promise.await {
            Ok(n) => {
                let n = n as usize;
                // Envelope layout: [meta_len: u16 BE][meta JSON UTF-8][body bytes].
                // Minimum valid frame: 2 bytes meta_len + smallest JSON object
                // {"status":200} (14 bytes) + 0 body bytes = 16. Empty bodies are
                // legal (action returning undefined, status 204/304, render of
                // components returning null) and must not 500.
                if n < 16 || n > entry.buf_len {
                    error!(worker_id = entry.id, written = n, capacity = entry.buf_len, "{label} oversized");
                    let _ = s
                        .write_all(http::build_response(
                            500,
                            "text/plain",
                            &[],
                            format!("{label} oversized").into_bytes(),
                        ))
                        .await;
                    return DispatchControl::CloseConn;
                }
                // SAFETY: see pool.rs BufPtr safety argument.
                let raw: Vec<u8> =
                    unsafe { std::slice::from_raw_parts(entry.buf_ptr.0, n).to_vec() };
                let meta_len = u16::from_be_bytes([raw[0], raw[1]]) as usize;
                if meta_len + 2 > n {
                    error!(worker_id = entry.id, meta_len, total = n, "{label} meta_len out of range");
                    let _ = s
                        .write_all(http::build_response(
                            500,
                            "text/plain",
                            &[],
                            format!("invalid {label} envelope").into_bytes(),
                        ))
                        .await;
                    return DispatchControl::CloseConn;
                }
                let meta_bytes = &raw[2..2 + meta_len];
                let meta: ResponseMeta = match serde_json::from_slice(meta_bytes) {
                    Ok(m) => m,
                    Err(e) => {
                        error!(worker_id = entry.id, error = %e, "{label} meta JSON parse failed");
                        let _ = s
                            .write_all(http::build_response(
                                500,
                                "text/plain",
                                &[],
                                format!("invalid {label} envelope").into_bytes(),
                            ))
                            .await;
                        return DispatchControl::CloseConn;
                    }
                };
                let body = raw[2 + meta_len..].to_vec();
                let extra: Vec<(String, String)> = meta.headers.into_iter().collect();
                let ct: &str = if prefer_meta_content_type {
                    meta.content_type.as_deref().unwrap_or(default_content_type)
                } else {
                    default_content_type
                };
                let bytes = http::build_response(meta.status, ct, &extra, body);
                on_success(&bytes);
                if s.write_all(bytes).await.is_err() {
                    return DispatchControl::CloseConn;
                }
                DispatchControl::Continue
            }
            Err(e) => {
                error!(worker_id = entry.id, error = %e, "{label} promise rejected");
                let msg = format!("{label} error: {e}");
                let _ = s
                    .write_all(http::build_response(500, "text/plain", &[], msg.into_bytes()))
                    .await;
                DispatchControl::CloseConn
            }
        },
        Err(e) => {
            error!(worker_id = entry.id, error = %e, "{label} tsfn call_async failed");
            let _ = s
                .write_all(http::build_response(
                    502,
                    "text/plain",
                    &[],
                    b"upstream call failed".to_vec(),
                ))
                .await;
            pool.remove(entry.id);
            if pool.registered_count() == 0 {
                error!("all workers died");
                std::process::exit(1);
            }
            DispatchControl::CloseConn
        }
    }
}

fn build_cache_key(method: &str, full_path: &str, cfg: &CacheConfig, request_buf: &[u8]) -> CacheKey {
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
    while buf.len() < MAX_REQUEST_BYTES {
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
    name
        .bytes()
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
            return std::str::from_utf8(h.value).ok().map(|s| s.trim().to_string());
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
            return std::str::from_utf8(h.value).ok().map(|s| s.trim().to_string());
        }
    }
    None
}

/// Mirrors src/lib.rs::is_safe_action_id. Belt-and-suspenders: the dispatch
/// check that happens here is the only sanitization between the URL path and
/// the action registry lookup.
fn is_safe_action_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 128 {
        return false;
    }
    id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn server_action_id_matches_lib_helper() {
        // Sanity: server.rs and lib.rs both define is_safe_action_id. They must
        // agree on every input — drifting between the two is a 404 / 200 split
        // depending on call order, which is a security smell.
        let cases = [
            ("createNote", true),
            ("a_b-c", true),
            ("X", true),
            ("", false),
            ("a.b", false),
            ("a/b", false),
            ("..", false),
            ("évil", false),
            ("a b", false),
        ];
        for (input, expected) in cases {
            assert_eq!(is_safe_action_id(input), expected, "input={input:?}");
        }
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
    fn parse_content_type_finds_header() {
        let raw = b"POST /x HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n\r\n";
        assert_eq!(parse_content_type(raw), Some("application/json".to_string()));
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
        assert_eq!(parse_content_type(raw), Some("application/json".to_string()));
    }

    #[test]
    fn parse_content_type_missing_returns_none() {
        let raw = b"POST /x HTTP/1.1\r\nHost: x\r\n\r\n";
        assert_eq!(parse_content_type(raw), None);
    }
}
