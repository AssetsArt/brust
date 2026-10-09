//! The hyper accept loop, carried from brust-core `server/mod.rs:33-442` @
//! d04718f (`Tuning`, `start`, `serve_io`, `header_str`). The 0.1.x
//! `handle_request` is replaced by [`crate::pipeline::handle`].
use std::convert::Infallible;
use std::sync::atomic::{AtomicU32, AtomicU64};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use http::{Request, Response};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto;
use tokio::sync::Notify;
use tracing::{debug, error, info, warn};

use crate::cache::job_cache::JobCache;
use crate::cache::l1::L1Cache;
use crate::config::{Config, Server};
use crate::manifest::Manifest;
use crate::pool::WorkerPool;
use crate::render::Renderer;
use crate::routing::RouteTable;

pub mod body;
pub(crate) mod cors;
pub mod static_assets;
pub mod tls;

/// IO label for the boot banner (changed from the hand-rolled `tokio` loop).
const IO_NAME: &str = "hyper(tokio)";

/// Server limits, fixed at `start`. Every default matches 0.1.x.
///
/// - `max_request_bytes` (16 KB): cap on request header bytes (enforced by
///   hyper's `max_buf_size` so an oversized header line can't grow unbounded).
///   Page requests carry no body, so this also bounds the inline loader
///   request JSON.
/// - `conn_queue_cap` (1024): accept-side concurrency permit count; a slow
///   worker pool triggers TCP backpressure (accept stalls) instead of unbounded
///   memory growth.
/// - `read_buf_cap` (4096): hyper read-buffer initial sizing hint.
/// - `worker_threads` (`min(available_parallelism, 4)`, fallback 2): tokio
///   worker-thread count for the I/O runtime. This runs INSIDE Bun (which has
///   its own threads + N render workers), so we do NOT default to
///   one-thread-per-core; we cap at 4 (enough for TLS + accept + render
///   tasks) so small VMs aren't overprovisioned. Override via tuning.
#[derive(Clone, Copy, Debug)]
pub struct Tuning {
    pub max_request_bytes: usize,
    pub conn_queue_cap: usize,
    pub read_buf_cap: usize,
    /// Max time a worker call waits for a free worker before giving up with
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
            conn_queue_cap: 1024,
            read_buf_cap: 4096,
            claim_timeout_ms: 10_000,
            worker_threads: std::thread::available_parallelism()
                .map(|n| n.get().min(4))
                .unwrap_or(2),
        }
    }
}

/// Load the manifest, build the route table and renderer, bind, and run the
/// accept loop on its own runtime thread. Returns once the bind (and TLS
/// acceptor build) succeeded; the loop waits for `expected_workers`
/// registrations before accepting. Every boot failure is an `Err` (no partial
/// boot): `"manifest: …"`, `"routes: …"`, `"render: …"`, `"cors: …"`,
/// `"bind failed on {addr}: …"`, `"tls acceptor build failed: …"`.
pub fn start(cfg: Config) -> Result<Arc<Server>, String> {
    let loaded = Manifest::load(&cfg.dist_dir).map_err(|e| format!("manifest: {e}"))?;
    let routes = RouteTable::from_manifest(&loaded.manifest).map_err(|e| format!("routes: {e}"))?;
    let renderer =
        Renderer::from_templates(&loaded.templates).map_err(|e| format!("render: {e}"))?;
    if let Some(c) = &cfg.cors {
        c.validate().map_err(|e| format!("cors: {e}"))?;
    }
    let tuning = cfg.tuning;
    let state = Arc::new(Server {
        pool: Arc::new(WorkerPool::new()),
        routes,
        manifest: loaded.manifest,
        renderer,
        l1: L1Cache::with_capacity(cfg.l1_capacity),
        jobs: JobCache::new(cfg.job_cache_capacity),
        dist_dir: cfg.dist_dir.clone(),
        loader_calls: AtomicU64::new(0),
        job_calls: AtomicU64::new(0),
        ready: Arc::new(Notify::new()),
        expected_workers: AtomicU32::new(cfg.expected_workers),
        drain_start: Arc::new(Notify::new()),
        drain_done: Arc::new(Notify::new()),
        drain_timeout_ms: AtomicU64::new(10_000),
        local_addr: OnceLock::new(),
        cors_resolved: cfg.cors.as_ref().map(cors::ResolvedCors::from_config),
        tls: cfg.tls,
        cors: cfg.cors,
        generator: cfg.generator,
        claim_timeout: Duration::from_millis(tuning.claim_timeout_ms),
    });

    // The accept-concurrency ceiling (0.1.x also folded `conn_workers` in; v2
    // has no such knob).
    let accept_cap = tuning.conn_queue_cap.max(1);
    let addr = cfg.addr;

    // Boot channel: the spawned runtime thread reports the outcome of the two
    // BOOT-time fallible steps (TCP bind + TLS-acceptor build) back here. On
    // success `start` returns Ok and the thread proceeds into the accept loop in
    // the background; on failure the operator-fixable error propagates up to the
    // caller instead of `process::exit` nuking the Bun host (it runs INSIDE the
    // Bun process).
    let (boot_tx, boot_rx) =
        std::sync::mpsc::sync_channel::<Result<std::net::SocketAddr, String>>(1);

    info!(
        "Starting Tokio runtime with {} threads",
        tuning.worker_threads.max(1)
    );
    info!("Accept cap: {}", accept_cap);
    let thread_state = Arc::clone(&state);
    std::thread::spawn(move || {
        let state = thread_state;
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
            let local = match listener.local_addr() {
                Ok(a) => a,
                Err(e) => {
                    let _ = boot_tx.send(Err(format!("bind failed on {addr}: {e}")));
                    return;
                }
            };

            // Optional in-process TLS termination. Built ONCE before the accept
            // loop: a configured-but-broken cert/key is fatal at boot (mirrors
            // bind failure). `None` = plaintext, behavior unchanged.
            let acceptor: Option<tokio_rustls::TlsAcceptor> = match state.tls() {
                Some(cfg) => match tls::build_acceptor(cfg) {
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
            let _ = boot_tx.send(Ok(local));

            if state.expected_workers.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                state.ready.notify_one();
            }
            state.ready.notified().await; // wait until all workers registered
            let tls_label = if acceptor.is_some() { ", tls" } else { "" };
            println!("[brust] listening on {local} (io: {IO_NAME}{tls_label})");
            let _ = std::io::Write::flush(&mut std::io::stdout());

            let sem = Arc::new(tokio::sync::Semaphore::new(accept_cap));

            // X-Powered-By, stamped on EVERY response at the service layer.
            // insert-if-absent: headers the pipeline set win. L1 holds JSON
            // context, never a response, so stamping a HIT can never duplicate.
            let powered_by: Option<http::HeaderValue> =
                state.generator.as_deref().and_then(|s| {
                    match http::HeaderValue::from_str(s) {
                        Ok(v) => Some(v),
                        Err(e) => {
                            warn!(value = %s, error = %e, "generator string rejected by HeaderValue — X-Powered-By disabled");
                            None
                        }
                    }
                });

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
            let drain_started = state.drain_start.notified();
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
                // parks here, stalling the accept loop → TCP backpressure.
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
                    let svc = service_fn(move |req| {
                        let state = Arc::clone(&state);
                        let powered_by = powered_by.clone();
                        async move {
                            // CORS stamping happens HERE and ONLY here — the single
                            // chokepoint that sees every response path (static
                            // assets, error helpers, L1 HITs, rendered pages). Clone
                            // the Origin header BEFORE `req` moves into the pipeline.
                            let origin = if state.cors_resolved.is_some() {
                                req.headers().get(http::header::ORIGIN).cloned()
                            } else {
                                None
                            };
                            let mut resp = crate::pipeline::handle(req, Arc::clone(&state)).await;
                            if let Some(v) = powered_by {
                                resp.headers_mut()
                                    .entry(http::header::HeaderName::from_static("x-powered-by"))
                                    .or_insert(v);
                            }
                            if let Some(c) = &state.cors_resolved {
                                c.stamp_response(resp.headers_mut(), origin.as_ref());
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
        Ok(Ok(local)) => {
            let _ = state.local_addr.set(local);
            Ok(state)
        }
        Ok(Err(msg)) => Err(msg),
        Err(_) => Err("server thread died before binding".into()),
    }
}

/// Serve one already-accepted connection with hyper's auto (H1+H2) builder.
/// Generic over the IO type so both the plaintext (`TokioIo<TcpStream>`) and the
/// TLS (`TokioIo<TlsStream<TcpStream>>`) branches share one body — the concrete
/// `TokioIo<...>` types differ, so this is the clean way to avoid boxing.
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
            // watch sender vanished, just run to completion.)
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
pub(crate) fn header_str(headers: &http::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
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

        let res = start(Config {
            addr,
            dist_dir: std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/dist"),
            ..Default::default()
        });

        let Err(msg) = res else {
            panic!("start should return Err on bind failure");
        };
        assert!(
            msg.contains("bind failed"),
            "unexpected error message: {msg}"
        );
    }
}
