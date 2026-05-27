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
            if rest.contains("websocket") {
                upgrade_ok = true;
            }
        } else if let Some(rest) = lc.strip_prefix("connection:") {
            if rest.contains("upgrade") {
                connection_upgrade_ok = true;
            }
        } else if lc.starts_with("sec-websocket-key:") {
            // Preserve original-case base64 value, not the lowercased one.
            let Some((_, val)) = line.split_once(':') else {
                continue;
            };
            sec_websocket_key = Some(val.trim().to_string());
        } else if let Some(rest) = lc.strip_prefix("sec-websocket-version:") {
            if rest.trim() == "13" {
                version_ok = true;
            }
        } else if lc.starts_with("sec-websocket-protocol:") {
            let Some((_, val)) = line.split_once(':') else {
                continue;
            };
            for sp in val.split(',') {
                let trimmed = sp.trim();
                if !trimmed.is_empty() {
                    subprotocols.push(trimmed.to_string());
                }
            }
        }
    }

    if !upgrade_ok {
        return Err(HandshakeError::MissingUpgrade);
    }
    if !connection_upgrade_ok {
        return Err(HandshakeError::MissingConnectionUpgrade);
    }
    if !version_ok {
        return Err(HandshakeError::BadVersion);
    }
    let key = sec_websocket_key.ok_or(HandshakeError::MissingKey)?;
    Ok(ParsedHandshake {
        sec_websocket_key: key,
        client_subprotocols: subprotocols,
    })
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
    pub subprotocol: String, // "" if no subprotocol negotiated
}

pub type WsMessageCallback = Box<dyn Fn(Vec<u8>, bool) + Send + Sync + 'static>;
pub type WsCloseCallback = Box<dyn Fn(u16, String) + Send + Sync + 'static>;

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
    pub on_message: Option<WsMessageCallback>,
    /// Called with (code: u16, reason: String) when the connection closes.
    pub on_close: Option<WsCloseCallback>,
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
    WS_PATHS.get().is_some_and(|s| s.lock().contains(path))
}

use futures::{SinkExt, StreamExt};
use std::borrow::Cow;
use std::time::{Duration, Instant};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::protocol::{Message, frame::CloseFrame},
};

/// Per-connection driver loop. Owns the WebSocketStream after the 101
/// handshake completes. Selects between outgoing sends (JS-pushed),
/// incoming frames (tokio-tungstenite Stream), and a ping ticker.
///
/// on_close fires EXACTLY ONCE per connection for peer-initiated,
/// timeout, error, shutdown, and oversize closes. It does NOT fire
/// when the author calls socket.close() — that path is signalled by
/// the Close frame being enqueued via send_tx and recognized by the
/// is_close flag below.
///
/// The S generic is the underlying transport — typically TcpStream on
/// non-Linux, but the trait bound (AsyncRead + AsyncWrite + Unpin) is
/// what tokio-tungstenite's WebSocketStream<S> requires.
pub async fn ws_conn_task<S>(
    ws: WebSocketStream<S>,
    conn_id: u64,
    mut send_rx: mpsc::Receiver<WsOutgoing>,
    ping_interval_ms: u64,
    max_msg_bytes: usize,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut ws_sink, mut ws_stream) = ws.split();
    let mut ping_tick = tokio::time::interval(Duration::from_millis(ping_interval_ms.max(1)));
    let mut last_pong = Instant::now();
    let pong_timeout = Duration::from_millis(ping_interval_ms.saturating_mul(2));

    loop {
        tokio::select! {
            biased;   // give outgoing sends priority to drain the queue
            Some(out) = send_rx.recv() => {
                let msg = match out.frame {
                    WsFrameKind::Text(s) => Message::Text(s),
                    WsFrameKind::Binary(b) => Message::Binary(b),
                    WsFrameKind::Close(c, r) => Message::Close(Some(CloseFrame {
                        code: c.into(),
                        reason: Cow::Owned(r),
                    })),
                };
                let is_close = matches!(msg, Message::Close(_));
                if ws_sink.send(msg).await.is_err() { break; }
                // ack.send may Err if napi_ws_close dropped the receiver
                // (RFC 6455 close is fire-and-forget from the initiator);
                // discard per the WsOutgoing.ack contract.
                let _ = out.ack.send(());
                if is_close { break; }
            }
            next = ws_stream.next() => {
                // Detect clean stream end (None) explicitly. Without this,
                // the Some(...) pattern would silently skip and the task
                // would spin on the ping_tick arm forever, attempting to
                // send Ping frames into a closed stream.
                let msg = match next {
                    Some(Ok(m)) => m,
                    Some(Err(_)) | None => {
                        fire_on_close(conn_id, 1006, "abnormal closure".to_string());
                        break;
                    }
                };
                match msg {
                    Message::Text(s) => {
                        if s.len() > max_msg_bytes {
                            fire_on_close(conn_id, 1009, "message too big".to_string());
                            let _ = ws_sink.send(Message::Close(Some(CloseFrame {
                                code: 1009.into(),
                                reason: Cow::Borrowed("message too big"),
                            }))).await;
                            break;
                        }
                        fire_on_message(conn_id, s.into_bytes(), false);
                    }
                    Message::Binary(b) => {
                        if b.len() > max_msg_bytes {
                            fire_on_close(conn_id, 1009, "message too big".to_string());
                            let _ = ws_sink.send(Message::Close(Some(CloseFrame {
                                code: 1009.into(),
                                reason: Cow::Borrowed("message too big"),
                            }))).await;
                            break;
                        }
                        fire_on_message(conn_id, b, true);
                    }
                    Message::Ping(p) => { let _ = ws_sink.send(Message::Pong(p)).await; }
                    Message::Pong(_) => { last_pong = Instant::now(); }
                    Message::Close(cf) => {
                        let code = cf.as_ref().map_or(1005u16, |c| u16::from(c.code));
                        let reason = cf.map_or(String::new(), |c| c.reason.into_owned());
                        fire_on_close(conn_id, code, reason);
                        break;
                    }
                    Message::Frame(_) => {}
                }
            }
            _ = ping_tick.tick() => {
                if ping_interval_ms == 0 { continue; }
                if last_pong.elapsed() > pong_timeout {
                    fire_on_close(conn_id, 1011, "pong timeout".to_string());
                    let _ = ws_sink.send(Message::Close(Some(CloseFrame {
                        code: 1011.into(),
                        reason: Cow::Borrowed("pong timeout"),
                    }))).await;
                    break;
                }
                // Match the send arm — break on send error so we don't loop
                // sending Pings to a dead socket.
                if ws_sink.send(Message::Ping(Vec::new())).await.is_err() { break; }
            }
        }
    }

    let _ = ws_sink.close().await;
    registry().lock().remove(&conn_id);
}

fn fire_on_message(conn_id: u64, data: Vec<u8>, is_binary: bool) {
    // Take the closure reference under the lock and invoke it while the lock
    // is held. This is acceptable because the closure just enqueues a JS
    // event via a NonBlocking tsfn call (see napi_ws_register_handlers) —
    // no JS code runs under the lock.
    let reg = registry().lock();
    if let Some(cb) = reg.get(&conn_id).and_then(|c| c.on_message.as_ref()) {
        cb(data, is_binary);
    }
}

fn fire_on_close(conn_id: u64, code: u16, reason: String) {
    let reg = registry().lock();
    if let Some(cb) = reg.get(&conn_id).and_then(|c| c.on_close.as_ref()) {
        cb(code, reason);
    }
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
        assert_eq!(
            h.client_subprotocols,
            vec!["chat.v2".to_string(), "chat.v1".to_string()]
        );
    }

    #[test]
    fn parse_handshake_rejects_missing_upgrade() {
        let raw = b"GET /ws HTTP/1.1\r\nConnection: Upgrade\r\nSec-WebSocket-Key: k==\r\nSec-WebSocket-Version: 13\r\n\r\n";
        assert_eq!(
            parse_ws_handshake(raw).unwrap_err(),
            HandshakeError::MissingUpgrade
        );
    }

    #[test]
    fn parse_handshake_rejects_bad_version() {
        let raw = b"GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: k==\r\nSec-WebSocket-Version: 8\r\n\r\n";
        assert_eq!(
            parse_ws_handshake(raw).unwrap_err(),
            HandshakeError::BadVersion
        );
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
        registry().lock().insert(
            id,
            WsConn {
                send_tx,
                open_tx: Some(open_tx),
                on_message: None,
                on_close: None,
            },
        );
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
