use std::net::SocketAddr;
use std::sync::Arc;

use tokio::sync::Notify;
use tracing::{error, warn};

use crate::http::{self, parse_request, ParseError};
use crate::io::{run_io, spawn, IO_NAME, TcpListener, TcpStream};
use crate::pool::WorkerPool;

const MAX_REQUEST_BYTES: usize = 16 * 1024;

pub fn start(addr: SocketAddr, ready: Arc<Notify>, pool: Arc<WorkerPool>) {
    run_io(move || async move {
        let listener = match TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                error!(error = %e, %addr, "bind failed");
                std::process::exit(1);
            }
        };

        ready.notified().await; // wait until all workers have registered
        println!("[brust] listening on {addr} (io: {IO_NAME})");

        loop {
            match listener.accept().await {
                Ok((stream, _peer)) => {
                    let pool = pool.clone();
                    spawn(async move {
                        handle_conn(stream, pool).await;
                    });
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
    if !read_full_request(&mut s, &mut buf).await {
        let _ = s.write_all(http::error_400()).await;
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

    let Some(entry) = pool.pick_least_busy() else {
        let _ = s.write_all(http::error_503("no workers")).await;
        return;
    };
    let _guard = entry.in_flight_guard();

    let path_arg = path.clone();
    match entry.tsfn.call_async(Ok(path_arg)).await {
        Ok(promise) => match promise.await {
            Ok(html) => {
                let bytes = http::build_response(200, "text/html; charset=utf-8", html.into_bytes());
                let _ = s.write_all(bytes).await;
            }
            Err(e) => {
                error!(worker_id = entry.id, error = %e, "render promise rejected");
                let msg = format!("render error: {e}");
                let _ = s.write_all(http::build_response(500, "text/plain", msg.into_bytes())).await;
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
        }
    }

    let _ = s.shutdown().await;
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
