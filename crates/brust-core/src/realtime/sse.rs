//! SSE per-connection state.
//!
//! Each accepted SSE connection lives in REGISTRY, keyed by a monotonic
//! conn_id. The Rust per-connection tokio task reads SseFrame values from
//! the JS-driven mpsc::Sender and writes them to the TCP socket. The
//! oneshot open channel carries the middleware verdict back from JS so
//! Rust can decide whether to write SSE headers or a regular 4xx response.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
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

use bytes::Bytes;

/// Spawn the per-connection SSE driver. Under hyper the response body is a
/// streaming `BoxBody` fed by `body_tx: Sender<Bytes>` (the headers — status
/// 200, `Content-Type: text/event-stream`, `Cache-Control: no-store`,
/// `X-Accel-Buffering: no` — are set on the `Response` by the server's SSE
/// branch). The task forwards JS-pushed `SseFrame`s into `body_tx`, ack-ing
/// each so the JS `napi_sse_write` Promise resolves (cooperative backpressure).
///
/// Client-disconnect detection: instead of peeking the raw socket for FIN/RST
/// (no longer reachable through hyper), we await `body_tx.closed()`, which
/// resolves when the body receiver drops — hyper drops it when the connection
/// is torn down. The abort callback + registry cleanup fire exactly as before.
pub fn spawn_sse_conn_task(
    body_tx: mpsc::Sender<Bytes>,
    conn_id: u64,
    mut frame_rx: mpsc::Receiver<SseFrame>,
) {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                maybe_frame = frame_rx.recv() => {
                    match maybe_frame {
                        Some(frame) => {
                            if body_tx.send(Bytes::from(frame.bytes)).await.is_err() {
                                // Body receiver dropped — client gone.
                                break;
                            }
                            let _ = frame.ack.send(());
                        }
                        None => break, // JS sender dropped — graceful close
                    }
                }
                _ = body_tx.closed() => break, // client disconnected
            }
        }
        // Cleanup: remove from REGISTRY and fire abort callback if set.
        if let Some(cb) = registry()
            .lock()
            .remove(&conn_id)
            .and_then(|mut c| c.abort_cb.take())
        {
            cb();
        }
        // body_tx drops here → body completes.
    });
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
    SSE_PATHS.get().is_some_and(|s| s.lock().contains(path))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        registry().lock().insert(
            id,
            SseConn {
                frame_tx,
                open_tx: Some(open_tx),
                abort_cb: None,
            },
        );
        assert!(registry().lock().contains_key(&id));
        let removed = registry().lock().remove(&id);
        assert!(removed.is_some());
        assert!(!registry().lock().contains_key(&id));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn body_tx_closed_resolves_when_receiver_drops() {
        // Disconnect detection now rides on the body channel: dropping the
        // receiver (what hyper does on connection teardown) resolves
        // `tx.closed()`. This is the SSE task's client-gone signal.
        let (tx, rx) = mpsc::channel::<Bytes>(4);
        let closed = tokio::spawn(async move { tx.closed().await });
        drop(rx);
        let timed = tokio::time::timeout(std::time::Duration::from_secs(1), closed).await;
        assert!(timed.is_ok(), "tx.closed() should resolve when rx drops");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn body_tx_closed_pending_while_receiver_alive() {
        let (tx, rx) = mpsc::channel::<Bytes>(4);
        let closed = tokio::spawn(async move { tx.closed().await });
        let timed = tokio::time::timeout(std::time::Duration::from_millis(150), closed).await;
        assert!(timed.is_err(), "tx.closed() should still be pending");
        drop(rx);
    }
}
