//! SSE per-connection state.
//!
//! Each accepted SSE connection lives in REGISTRY, keyed by a monotonic
//! conn_id. The Rust per-connection tokio task reads SseFrame values from
//! the JS-driven mpsc::Sender and writes them to the TCP socket. The
//! oneshot open channel carries the middleware verdict back from JS so
//! Rust can decide whether to write SSE headers or a regular 4xx response.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use tokio::sync::{mpsc, oneshot};

pub static NEXT_CONN_ID: AtomicU64 = AtomicU64::new(1);

pub fn next_conn_id() -> u64 {
    NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed)
}

/// One framed write request from JS glue → Rust per-conn task.
pub struct SseFrame {
    pub bytes: Vec<u8>,
    /// Resolved after Rust completes the TCP write; the JS Promise from
    /// napi_sse_write awaits this signal to provide cooperative backpressure.
    pub ack: oneshot::Sender<()>,
}

/// Middleware verdict carried back via napi_sse_signal_open.
pub struct SseOpenSignal {
    pub status: u16,
    pub body: Vec<u8>,
    pub content_type: String,
}

/// Per-connection state stored in REGISTRY.
pub struct SseConn {
    /// JS writes chunks → enqueues here. Bounded at 32 frames for backpressure.
    pub frame_tx: mpsc::Sender<SseFrame>,
    /// JS signals middleware verdict here. Single-shot.
    pub open_tx: Option<oneshot::Sender<SseOpenSignal>>,
    /// Optional JS-registered abort callback (set via napi_sse_register_abort).
    /// Fired by the per-conn task when client TCP closes.
    pub abort_cb: Option<Box<dyn FnOnce() + Send + 'static>>,
}

pub type Registry = Mutex<HashMap<u64, SseConn>>;

static REGISTRY: OnceLock<Registry> = OnceLock::new();

pub fn registry() -> &'static Registry {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

use tokio::io::{AsyncRead, AsyncReadExt};

/// Awaits the next byte from `stream` and returns when the peer has closed
/// the connection (FIN or RST). On any error (including non-existent data
/// after FIN) the future resolves. The function does NOT consume application
/// bytes — by spec, SSE clients never send body after the initial request,
/// so any read here means "the connection is going away."
///
/// This overload is used by the unit tests which pass tokio `UnixStream`.
pub async fn peek_for_close<S: AsyncRead + Unpin>(stream: &mut S) -> () {
    let mut byte = [0u8; 1];
    // read returns Ok(0) on clean FIN; Err on RST or other failures.
    let _ = stream.read(&mut byte).await;
    // Either way, we treat it as "close imminent" and return.
}

const SSE_HEADER_BLOCK: &[u8] = b"\
HTTP/1.1 200 OK\r\n\
Content-Type: text/event-stream\r\n\
Cache-Control: no-store\r\n\
Connection: keep-alive\r\n\
X-Accel-Buffering: no\r\n\
\r\n";

pub async fn write_sse_response_headers<S: crate::io::SseIo>(
    stream: &mut S,
) -> std::io::Result<()> {
    stream.write_bytes(SSE_HEADER_BLOCK.to_vec()).await
}

/// Per-connection driver loop. Owns the TCP stream after the open-signal
/// arrives + headers are written. Forwards frames to the wire, ack-ing
/// each one so JS Promises resolve. Exits on peer close OR sender drop.
pub async fn sse_conn_task<S: crate::io::SseIo>(
    mut stream: S,
    conn_id: u64,
    mut frame_rx: mpsc::Receiver<SseFrame>,
) {
    loop {
        tokio::select! {
            maybe_frame = frame_rx.recv() => {
                match maybe_frame {
                    Some(frame) => {
                        if stream.write_bytes(frame.bytes).await.is_err() { break; }
                        let _ = frame.ack.send(());
                    }
                    None => break,  // sender dropped — graceful close
                }
            }
            _ = stream.read_one_byte() => break,
        }
    }
    // Cleanup: remove from REGISTRY and fire abort callback if set.
    let conn = registry().lock().remove(&conn_id);
    if let Some(mut c) = conn {
        if let Some(cb) = c.abort_cb.take() { cb(); }
    }
    let _ = stream.shutdown_conn().await;
}

/// MVP: exact-match only. Routes like `/sse/{room}` are not supported
/// until a follow-up wires matchit-rs in front of this. Authors with
/// parameterized SSE routes should split into separate literal routes.
static SSE_PATHS: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();

pub fn register_sse_path(path: String) {
    SSE_PATHS
        .get_or_init(|| Mutex::new(std::collections::HashSet::new()))
        .lock()
        .insert(path);
}

pub fn path_is_sse(path: &str) -> bool {
    SSE_PATHS.get().map_or(false, |s| s.lock().contains(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::UnixStream;

    #[test]
    fn next_conn_id_is_monotonic_and_unique() {
        let a = next_conn_id();
        let b = next_conn_id();
        let c = next_conn_id();
        assert!(b > a);
        assert!(c > b);
        assert_ne!(a, b);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn registry_insert_remove_round_trip() {
        let (frame_tx, _frame_rx) = mpsc::channel(32);
        let (open_tx, _open_rx) = oneshot::channel::<SseOpenSignal>();
        let id = next_conn_id();
        registry().lock().insert(id, SseConn {
            frame_tx,
            open_tx: Some(open_tx),
            abort_cb: None,
        });
        assert!(registry().lock().contains_key(&id));
        let removed = registry().lock().remove(&id);
        assert!(removed.is_some());
        assert!(!registry().lock().contains_key(&id));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn peek_for_close_returns_when_peer_shuts_down() {
        let (a, b) = UnixStream::pair().expect("pair");
        // Spawn the peek future on the `a` end.
        let peek = tokio::spawn(async move {
            let mut a = a;
            peek_for_close(&mut a).await
        });
        // Peer cleanly closes `b` end.
        drop(b);
        // Should resolve quickly.
        let timed = tokio::time::timeout(std::time::Duration::from_secs(1), peek).await;
        assert!(timed.is_ok(), "peek_for_close should resolve on peer shutdown");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn peek_for_close_does_not_resolve_while_peer_alive() {
        let (a, b) = UnixStream::pair().expect("pair");
        let peek = tokio::spawn(async move {
            let mut a = a;
            peek_for_close(&mut a).await
        });
        // Peer is still alive — peek should NOT resolve within a short window.
        let timed = tokio::time::timeout(std::time::Duration::from_millis(150), peek).await;
        assert!(timed.is_err(), "peek_for_close should still be pending");
        drop(b);
    }
}
