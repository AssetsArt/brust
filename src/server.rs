use std::net::SocketAddr;
use std::sync::Arc;

use tokio::sync::Notify;
use tracing::{error, warn};

use crate::http::{self, parse_request, ParseError};
use crate::io::{run_io, spawn, IO_NAME, TcpListener, TcpStream};
use crate::pool::WorkerPool;

const MAX_REQUEST_BYTES: usize = 16 * 1024;
// Bound the accept-side queue so a slow worker pool triggers TCP backpressure instead of unbounded memory growth.
const CONN_CHAN_CAP: usize = 1024;

pub fn start(addr: SocketAddr, ready: Arc<Notify>, pool: Arc<WorkerPool>, workers: usize) {
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
            spawn(async move {
                while let Ok(stream) = rx.recv_async().await {
                    handle_conn(stream, pool.clone()).await;
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

async fn handle_conn(mut s: TcpStream, pool: Arc<WorkerPool>) {
    let mut buf = Vec::with_capacity(4096);
    loop {
        buf.clear();
        // EOF / read error / oversized request → silently close (client may have hung up cleanly).
        if !read_full_request(&mut s, &mut buf).await {
            return;
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
            let bytes = http::build_response(200, "text/plain", b"pong\n".to_vec());
            if s.write_all(bytes).await.is_err() {
                return;
            }
            continue;
        }

        let Some(entry) = pool.pick_least_busy() else {
            let _ = s.write_all(http::error_503("no workers")).await;
            return;
        };
        let _guard = entry.in_flight_guard();

        let path_arg = path.clone();
        match entry.tsfn.call_async(path_arg).await {
            Ok(promise) => match promise.await {
                Ok(html) => {
                    let bytes = http::build_response(200, "text/html; charset=utf-8", html.into_bytes());
                    if s.write_all(bytes).await.is_err() {
                        return;
                    }
                }
                Err(e) => {
                    error!(worker_id = entry.id, error = %e, "render promise rejected");
                    let msg = format!("render error: {e}");
                    let _ = s.write_all(http::build_response(500, "text/plain", msg.into_bytes())).await;
                    return;
                }
            },
            Err(e) => {
                error!(worker_id = entry.id, error = %e, "tsfn call_async failed");
                let _ = s.write_all(http::build_response(502, "text/plain", b"upstream call failed".to_vec())).await;
                // worker tsfn likely dead — remove from pool
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

async fn read_full_request(s: &mut TcpStream, buf: &mut Vec<u8>) -> bool {
    while buf.len() < MAX_REQUEST_BYTES {
        let n = match s.read_request(buf).await {
            Ok(n) => n,
            Err(e) => {
                warn!(error = %e, "read failed");
                return false;
            }
        };
        if n == 0 {
            return false; // EOF before complete request
        }
        // check for end-of-headers
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            return true;
        }
    }
    // request too large
    false
}
