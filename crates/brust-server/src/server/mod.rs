//! The hyper accept loop, carried from brust-core `server/mod.rs:33-442` @
//! d04718f (`Tuning`, `start`, `serve_io`; `header_str` is `brust_core::body::header_str`). The 0.1.x
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

use crate::config::{Config, Server};
use crate::core::{Core, CoreConfig};
use crate::host::NativeHost;
use crate::manifest::Manifest;
use crate::pool::WorkerPool;

pub mod body;
pub mod coarse_timer;
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
/// - `worker_threads` (`available_parallelism`, fallback 2): tokio worker-thread
///   count for the I/O runtime. 0.1.x capped this at 4 because pages rendered on
///   the Bun worker threads; in v2 every page renders HERE (minijinja on tokio),
///   so the cap capped render throughput (m2p profile: 4 threads at ~88% CPU,
///   Bun workers at ~14%). Override via tuning.
#[derive(Clone, Copy, Debug)]
pub struct Tuning {
    pub max_request_bytes: usize,
    pub conn_queue_cap: usize,
    pub read_buf_cap: usize,
    /// Max time a worker call waits for a free worker before giving up with
    /// 503 (see `claim_or_wait`). Bounds the AllBusy→queue wait so a wedged
    /// worker pool can't park a connection forever. Default 10_000 ms.
    pub claim_timeout_ms: u64,
    /// Max time a CLAIMED worker call may take to settle before the client
    /// gets 504. The slot stays claimed until JS settles. Default 30_000 ms.
    pub call_timeout_ms: u64,
    /// tokio I/O runtime worker-thread count. Default `available_parallelism`
    /// (see struct docs).
    pub worker_threads: usize,
    /// HTTP/1 header-read timeout: a connection that has not delivered a
    /// complete request head within this long is closed (slowloris guard).
    /// Default 10_000 ms.
    pub header_read_timeout_ms: u64,
}

impl Default for Tuning {
    fn default() -> Self {
        Self {
            max_request_bytes: 16 * 1024,
            conn_queue_cap: 1024,
            read_buf_cap: 4096,
            claim_timeout_ms: 10_000,
            call_timeout_ms: 30_000,
            header_read_timeout_ms: 10_000,
            worker_threads: std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(2),
        }
    }
}

impl Server {
    /// Slots whose plan cell holds something (tests: 0 when idle).
    #[doc(hidden)]
    pub fn plan_cells_in_use(&self) -> usize {
        self.core
            .host
            .pool
            .entries()
            .iter()
            .map(|e| {
                (0..e.slot_len())
                    .filter(|&i| e.slot(i).plan.lock().is_some())
                    .count()
            })
            .sum()
    }
}

/// R1: the per-request pipeline future is spawned on the multi-thread runtime, so it must be
/// `Send` — asserted here at compile time (auto traits leak through the host's RPITIT futures).
#[allow(dead_code)]
fn _pipeline_future_is_send(req: Request<Incoming>, s: &Server) {
    fn is_send<T: Send>(_: &T) {}
    let f = crate::pipeline::handle(req, s);
    is_send(&f);
}

/// `Arc<Server>`/`Weak<Server>` live in napi statics.
const _: () = {
    const fn ok<T: Send + Sync>() {}
    ok::<Server>();
};

/// Load the manifest, build the route table and renderer, bind, and run the
/// accept loop on its own runtime thread. Returns once the bind (and TLS
/// acceptor build) succeeded; the loop waits for `expected_workers`
/// registrations before accepting. Every boot failure is an `Err` (no partial
/// boot): `"manifest: …"`, `"routes: …"`, `"render: …"`, `"cors: …"`, `"actions: …"`,
/// `"bind failed on {addr}: …"`, `"tls acceptor build failed: …"`.
pub fn start(cfg: Config) -> Result<Arc<Server>, String> {
    let loaded = Manifest::load(&cfg.dist_dir).map_err(|e| format!("manifest: {e}"))?;
    let tuning = cfg.tuning;
    let host = NativeHost {
        pool: Arc::new(WorkerPool::new()),
        dist_dir: cfg.dist_dir.clone(),
        claim_timeout: Duration::from_millis(tuning.claim_timeout_ms),
        call_timeout: Duration::from_millis(tuning.call_timeout_ms),
    };
    let core = Core::new(
        host,
        loaded,
        CoreConfig {
            l1_capacity: cfg.l1_capacity,
            job_cache_capacity: cfg.job_cache_capacity,
            cors: cfg.cors,
            generator: cfg.generator,
            actions: cfg.actions,
            https: cfg.tls.is_some(),
        },
    )?;
    let state = Arc::new(Server {
        core,
        ready: Arc::new(Notify::new()),
        expected_workers: AtomicU32::new(cfg.expected_workers),
        drain_start: Arc::new(Notify::new()),
        drain_done: Arc::new(Notify::new()),
        drain_timeout_ms: AtomicU64::new(10_000),
        local_addr: OnceLock::new(),
        tls: cfg.tls,
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

            if state
                .expected_workers
                .load(std::sync::atomic::Ordering::SeqCst)
                == 0
            {
                state.ready.notify_one();
            }
            state.ready.notified().await; // wait until all workers registered
            let tls_label = if acceptor.is_some() { ", tls" } else { "" };
            println!("[brust] listening on {local} (io: {IO_NAME}{tls_label})");
            let _ = std::io::Write::flush(&mut std::io::stdout());

            let sem = Arc::new(tokio::sync::Semaphore::new(accept_cap));

            // M3-P P7 (R2): hyper's header-read timeout runs on our coarse sharded timer, not on
            // tokio's wheel (one global lock per register and per clear, on every request).
            let header_timer = coarse_timer::CoarseTimer::new(coarse_timer::TICK);
            let header_ticker = header_timer.spawn_ticker();

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
                let read_buf_cap = tuning.read_buf_cap;
                let max_req = tuning.max_request_bytes;
                let header_timeout = Duration::from_millis(tuning.header_read_timeout_ms.max(1));
                let header_timer = header_timer.clone();
                let acceptor = acceptor.clone();
                let conn_drain = drain_sig_rx.clone();
                let conn_token = conn_token_tx.clone();
                tokio::spawn(async move {
                    let _permit = permit; // released when the connection ends
                    let _conn_token = conn_token; // drain barrier — held for the conn's life
                    let svc = service_fn(move |req: Request<Incoming>| {
                        // M3-P P7: one `Arc<Server>` clone per request (the pipeline borrows it).
                        let state = Arc::clone(&state);
                        async move {
                            // `Core::finish` is the single chokepoint that sees every response
                            // path (static assets, error helpers, L1 HITs, rendered pages, actions).
                            // Clone the Origin header BEFORE `req` moves into the pipeline.
                            let origin = state
                                .core
                                .cors_enabled()
                                .then(|| req.headers().get(http::header::ORIGIN).cloned())
                                .flatten();
                            let mut resp = crate::pipeline::handle(req, &state).await;
                            state.core.finish(origin.as_ref(), resp.headers_mut());
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
                                header_timeout,
                                header_timer,
                                conn_drain,
                            )
                            .await;
                        }
                        None => {
                            serve_io(
                                TokioIo::new(tcp),
                                svc,
                                max_req,
                                read_buf_cap,
                                header_timeout,
                                header_timer,
                                conn_drain,
                            )
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
            header_ticker.abort();
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
    header_timeout: Duration,
    header_timer: coarse_timer::CoarseTimer,
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
        .max_buf_size(max_req.max(read_buf_cap).max(8192))
        .timer(header_timer)
        .header_read_timeout(header_timeout);
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

    #[test]
    fn start_rejects_bad_actions_and_bad_cors() {
        let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/dist");
        let Err(msg) = start(Config {
            addr: "127.0.0.1:0".parse().unwrap(),
            dist_dir: dist.clone(),
            actions: Some(crate::config::ActionsConfig {
                prefix: "/_brust".into(),
                ..Default::default()
            }),
            ..Default::default()
        }) else {
            panic!("start should refuse the prefix /_brust");
        };
        assert!(msg.starts_with("actions: "), "{msg}");

        let Err(msg) = start(Config {
            addr: "127.0.0.1:0".parse().unwrap(),
            dist_dir: dist,
            cors: Some(crate::config::CorsConfig {
                origins: vec!["*".into()],
                methods: None,
                headers: None,
                expose_headers: None,
                credentials: true,
                max_age_seconds: None,
            }),
            ..Default::default()
        }) else {
            panic!("start should refuse credentials with a wildcard origin");
        };
        assert!(
            msg.starts_with("cors: ") && msg.contains("wildcard"),
            "{msg}"
        );
    }

    #[test]
    fn io_runtime_defaults_to_one_thread_per_core() {
        // v2 renders on this runtime, so the 0.1.x cap of 4 would cap render throughput (m2p).
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(2);
        assert_eq!(super::Tuning::default().worker_threads, cores);
    }
}
