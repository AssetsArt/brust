//! WebSocket per-connection state and handshake helpers.
//!
//! Each accepted WS connection lives in REGISTRY, keyed by a conn_id
//! shared with SSE (via `next_conn_id` from `crate::sse`). Per-conn
//! task reads outgoing frames from a JS-driven mpsc and writes them
//! to the tokio-tungstenite sink; incoming frames are dispatched to
//! JS via tsfn callbacks set up by napi_ws_register_handlers.

use base64::Engine;
use parking_lot::Mutex;
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use tokio::sync::{mpsc, oneshot};

const RFC6455_MAGIC: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// Computes Sec-WebSocket-Accept per RFC 6455 §1.3:
///   base64(SHA1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
pub fn compute_sec_accept(key: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(key.as_bytes());
    hasher.update(RFC6455_MAGIC.as_bytes());
    let digest = hasher.finalize();
    base64::engine::general_purpose::STANDARD.encode(digest)
}

/// Result of validating a WS upgrade request's headers.
#[derive(Debug)]
pub struct ParsedHandshake {
    pub sec_websocket_key: String,
    pub client_subprotocols: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum HandshakeError {
    MissingUpgrade,
    MissingConnectionUpgrade,
    MissingKey,
    BadVersion,
}

/// Parse + validate WS handshake headers. Returns the Sec-WebSocket-Key
/// (raw, base64 from the client; used to compute Sec-WebSocket-Accept)
/// and the trimmed list of client subprotocols.
pub fn parse_ws_handshake(headers: &[u8]) -> Result<ParsedHandshake, HandshakeError> {
    let text = std::str::from_utf8(headers).map_err(|_| HandshakeError::MissingKey)?;
    let mut sec_websocket_key: Option<String> = None;
    let mut version_ok = false;
    let mut upgrade_ok = false;
    let mut connection_upgrade_ok = false;
    let mut subprotocols: Vec<String> = Vec::new();

    for line in text.lines() {
        let lc = line.to_ascii_lowercase();
        if let Some(rest) = lc.strip_prefix("upgrade:") {
            if rest.contains("websocket") { upgrade_ok = true; }
        } else if let Some(rest) = lc.strip_prefix("connection:") {
            if rest.contains("upgrade") { connection_upgrade_ok = true; }
        } else if lc.starts_with("sec-websocket-key:") {
            // Preserve original-case base64 value, not the lowercased one.
            if let Some((_, val)) = line.split_once(':') {
                sec_websocket_key = Some(val.trim().to_string());
            }
        } else if let Some(rest) = lc.strip_prefix("sec-websocket-version:") {
            if rest.trim() == "13" { version_ok = true; }
        } else if lc.starts_with("sec-websocket-protocol:") {
            if let Some((_, val)) = line.split_once(':') {
                for sp in val.split(',') {
                    let trimmed = sp.trim();
                    if !trimmed.is_empty() { subprotocols.push(trimmed.to_string()); }
                }
            }
        }
    }

    if !upgrade_ok { return Err(HandshakeError::MissingUpgrade); }
    if !connection_upgrade_ok { return Err(HandshakeError::MissingConnectionUpgrade); }
    if !version_ok { return Err(HandshakeError::BadVersion); }
    let key = sec_websocket_key.ok_or(HandshakeError::MissingKey)?;
    Ok(ParsedHandshake { sec_websocket_key: key, client_subprotocols: subprotocols })
}

/// One outgoing frame from JS → Rust per-conn task.
pub enum WsFrameKind {
    Text(String),
    Binary(Vec<u8>),
    Close(u16, String),
}

pub struct WsOutgoing {
    pub frame: WsFrameKind,
    /// Resolved after the wire write completes; backpressure handle for the
    /// JS Promise returned by napi_ws_send. The per-conn task MUST discard
    /// the result of `ack.send(())` — napi_ws_close intentionally drops the
    /// receiver (fire-and-forget on Close frames, per RFC 6455 close
    /// semantics), so a `Err(())` from `send` is normal and not an error.
    /// Use `let _ = ack.send(());`, never `ack.send(()).unwrap()` or `?`.
    pub ack: oneshot::Sender<()>,
}

/// Middleware verdict + chosen subprotocol, carried back via napi_ws_signal_open.
pub struct WsOpenSignal {
    pub status: u16,
    pub body: Vec<u8>,
    pub content_type: String,
    pub subprotocol: String,   // "" if no subprotocol negotiated
}

/// Per-connection state stored in REGISTRY.
///
/// `on_message` and `on_close` are boxed closures rather than bare
/// `ThreadsafeFunction` values so that the unit-test binary links without
/// napi's native `.node` symbols (same approach as `SseConn::abort_cb`).
/// Task 4 (NAPI bridge) wraps the tsfn in a closure before storing it here.
pub struct WsConn {
    pub send_tx: mpsc::Sender<WsOutgoing>,
    pub open_tx: Option<oneshot::Sender<WsOpenSignal>>,
    /// Called with (payload: Vec<u8>, is_binary: bool) for each incoming frame.
    pub on_message: Option<Box<dyn Fn(Vec<u8>, bool) + Send + Sync + 'static>>,
    /// Called with (code: u16, reason: String) when the connection closes.
    pub on_close: Option<Box<dyn Fn(u16, String) + Send + Sync + 'static>>,
}

pub type Registry = Mutex<HashMap<u64, WsConn>>;

static REGISTRY: OnceLock<Registry> = OnceLock::new();

pub fn registry() -> &'static Registry {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// MVP: exact-match literal paths only. Parameterized routes are a
/// follow-up. Registered at boot via napi_register_ws_paths.
static WS_PATHS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

pub fn register_ws_path(path: String) {
    WS_PATHS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .insert(path);
}

pub fn path_is_ws(path: &str) -> bool {
    WS_PATHS.get().map_or(false, |s| s.lock().contains(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sec_accept_rfc6455_example() {
        // RFC 6455 §1.3 worked example: key "dGhlIHNhbXBsZSBub25jZQ=="
        // → accept "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        assert_eq!(
            compute_sec_accept("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
        );
    }

    #[test]
    fn parse_handshake_minimal_valid() {
        let raw = b"GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc==\r\nSec-WebSocket-Version: 13\r\n\r\n";
        let h = parse_ws_handshake(raw).unwrap();
        assert_eq!(h.sec_websocket_key, "abc==");
        assert!(h.client_subprotocols.is_empty());
    }

    #[test]
    fn parse_handshake_with_subprotocols() {
        let raw = b"GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: k==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: chat.v2, chat.v1\r\n\r\n";
        let h = parse_ws_handshake(raw).unwrap();
        assert_eq!(h.client_subprotocols, vec!["chat.v2".to_string(), "chat.v1".to_string()]);
    }

    #[test]
    fn parse_handshake_rejects_missing_upgrade() {
        let raw = b"GET /ws HTTP/1.1\r\nConnection: Upgrade\r\nSec-WebSocket-Key: k==\r\nSec-WebSocket-Version: 13\r\n\r\n";
        assert_eq!(parse_ws_handshake(raw).unwrap_err(), HandshakeError::MissingUpgrade);
    }

    #[test]
    fn parse_handshake_rejects_bad_version() {
        let raw = b"GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: k==\r\nSec-WebSocket-Version: 8\r\n\r\n";
        assert_eq!(parse_ws_handshake(raw).unwrap_err(), HandshakeError::BadVersion);
    }

    #[test]
    fn ws_paths_register_lookup() {
        register_ws_path("/ws/x".to_string());
        assert!(path_is_ws("/ws/x"));
        assert!(!path_is_ws("/ws/y"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn registry_insert_remove_round_trip() {
        let (send_tx, _send_rx) = mpsc::channel(32);
        let (open_tx, _open_rx) = oneshot::channel::<WsOpenSignal>();
        let id = crate::sse::next_conn_id();
        registry().lock().insert(id, WsConn {
            send_tx,
            open_tx: Some(open_tx),
            on_message: None,
            on_close: None,
        });
        assert!(registry().lock().contains_key(&id));
        let removed = registry().lock().remove(&id);
        assert!(removed.is_some());
        assert!(!registry().lock().contains_key(&id));
    }

    #[test]
    fn conn_ids_unique_across_sse_and_ws() {
        let sse_id = crate::sse::next_conn_id();
        let ws_id = crate::sse::next_conn_id();
        assert_ne!(sse_id, ws_id);
    }
}
