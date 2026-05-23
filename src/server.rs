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

#[derive(Debug, Deserialize)]
struct ResponseMeta {
    status: u16,
    #[serde(default)]
    headers: std::collections::HashMap<String, String>,
}

enum ReadOutcome {
    /// Headers complete (`\r\n\r\n` seen) — `buf` contains the full request.
    Complete,
    /// Read error or EOF before any complete headers — close silently.
    ClosedBeforeHeaders,
    /// Buffer grew past `MAX_REQUEST_BYTES` without seeing `\r\n\r\n`.
    Oversize,
}

const MAX_REQUEST_BYTES: usize = 16 * 1024;
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

        if method != "GET" {
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
        if let Some(key) = &cache_key {
            if let Some(bytes) = cache.get(key) {
                if s.write_all(bytes).await.is_err() {
                    return;
                }
                continue;
            }
        }

        let Some(entry) = pool.pick_least_busy() else {
            let _ = s.write_all(http::error_503("no workers")).await;
            return;
        };
        let _guard = entry.in_flight_guard();

        match entry.tsfn.call_async(envelope_json).await {
            Ok(promise) => match promise.await {
                Ok(n) => {
                    let n = n as usize;
                    // Envelope layout: [meta_len: u16 BE][meta JSON UTF-8][body bytes].
                    // Minimum valid frame: 2 bytes meta_len + at least the smallest
                    // JSON object {"status":200} (15 bytes). Tighten the check to >= 17.
                    if n < 17 || n > entry.buf_len {
                        error!(worker_id = entry.id, written = n, capacity = entry.buf_len, "render oversized or empty");
                        let _ = s.write_all(http::build_response(500, "text/plain", &[], b"render oversized".to_vec())).await;
                        return;
                    }
                    // SAFETY: see pool.rs BufPtr safety argument.
                    let raw: Vec<u8> = unsafe {
                        std::slice::from_raw_parts(entry.buf_ptr.0, n).to_vec()
                    };
                    let meta_len = u16::from_be_bytes([raw[0], raw[1]]) as usize;
                    if meta_len + 2 > n {
                        error!(worker_id = entry.id, meta_len, total = n, "meta_len out of range");
                        let _ = s.write_all(http::build_response(500, "text/plain", &[], b"invalid render envelope".to_vec())).await;
                        return;
                    }
                    let meta_bytes = &raw[2..2 + meta_len];
                    let meta: ResponseMeta = match serde_json::from_slice(meta_bytes) {
                        Ok(m) => m,
                        Err(e) => {
                            error!(worker_id = entry.id, error = %e, "meta JSON parse failed");
                            let _ = s.write_all(http::build_response(500, "text/plain", &[], b"invalid render envelope".to_vec())).await;
                            return;
                        }
                    };
                    let body = raw[2 + meta_len..].to_vec();
                    let extra: Vec<(String, String)> = meta
                        .headers
                        .into_iter()
                        .collect();
                    let bytes = http::build_response(meta.status, "text/html; charset=utf-8", &extra, body);
                    if let (Some(key), Some(cfg)) = (cache_key, cache_config.as_ref()) {
                        cache.insert(key, bytes.clone(), Duration::from_secs(cfg.ttl_seconds));
                    }
                    if s.write_all(bytes).await.is_err() {
                        return;
                    }
                }
                Err(e) => {
                    error!(worker_id = entry.id, error = %e, "render promise rejected");
                    let msg = format!("render error: {e}");
                    let _ = s.write_all(http::build_response(500, "text/plain", &[], msg.into_bytes())).await;
                    return;
                }
            },
            Err(e) => {
                error!(worker_id = entry.id, error = %e, "tsfn call_async failed");
                let _ = s.write_all(http::build_response(502, "text/plain", &[], b"upstream call failed".to_vec())).await;
                pool.remove(entry.id);
                if pool.registered_count() == 0 {
                    error!("all workers died");
                    std::process::exit(1);
                }
                return;
            }
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
