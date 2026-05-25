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
}
