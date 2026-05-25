# WebSocket (RFC 6455) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mount RFC 6455 WebSocket routes via `Route.websocket: () => Promise<WsHandlers>`, served by a new single long-lived tsfn dispatch with NAPI send/close/signal_open/register_handlers channels. tokio-tungstenite handles frames, ping/pong, and masking.

**Architecture:** Rust accepts the HTTP/1.1 Upgrade, validates handshake headers, dispatches a single tsfn call to a worker, runs middleware via the existing chain (returns either 4xx or 101 + chosen subprotocol via `napi_ws_signal_open`), then on 101 writes the handshake response, wraps the TCP stream with `tokio_tungstenite::WebSocketStream::from_raw_socket(Role::Server)`, and runs a per-conn task that selects between (a) JS-pushed sends from an mpsc, (b) incoming frames from the WS stream, and (c) a ping ticker. The author-facing `WsSocket` is a thin JS shim around four NAPI fns; many WS conns multiplex on a single worker via the JS event loop (same model as SSE).

**Tech Stack:** Rust 2024 + tokio + tokio-tungstenite 0.21 (new dep) + sha1 0.10 (new dep) + parking_lot::Mutex + napi-rs (existing), TypeScript, `bun:test`. base64 0.22 already present from Forms work.

**Spec:** `docs/superpowers/specs/2026-05-25-websocket-design.md`

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `Cargo.toml` | Modify | +`tokio-tungstenite = { version = "0.21", default-features = false }`, +`sha1 = "0.10"` |
| `src/lib.rs` | Modify | +`pub mod ws;`, +5 NAPI fns (signal_open/send/close/register_handlers/register_ws_paths) |
| `src/routes.rs` | Modify | +`WsEnvelope` struct + `build_ws_envelope` + 2 unit tests |
| `src/ws.rs` | Create | REGISTRY, `WsConn`, `WsOutgoing`, `WsOpenSignal`, `WsFrameKind`, `NEXT_CONN_ID` *(shared with SSE)*, `parse_ws_handshake`, `WS_PATHS` + `register_ws_path` + `path_is_ws`, `compute_sec_accept`, `ws_conn_task`, 8 unit tests |
| `src/server.rs` | Modify | +WS branch in handle_conn (Upgrade detect, handshake validate, dispatch, await verdict, write 101+manual handshake or 4xx) |
| `src/pool.rs` | Modify | +`dispatch_ws(entry, envelope_json, conn_id)` — Task 7 refactors the inline tsfn call from Task 6 |
| `runtime/routes.ts` | Modify | +`Route.websocket`, +`Route.wsOptions`, +`RouteCall 'ws'` variant, +`wsBranch` stub, +`defineRoutes` SSE→WS validation |
| `runtime/ws/handler.ts` | Create | Glue — middleware compose + subprotocol pick + signalOpen, `WsSocketImpl` (send/close), per-conn handler dispatch via registerHandlers |
| `runtime/ws/handler.test.ts` | Create | 6 unit tests |
| `runtime/index.ts` | Modify | +`brust.registerWsPaths(paths: string[])` |
| `example/hello-world/ws-echo.ts` | Create | `{ message(s,d){s.send(d)}, close: records globalThis.__lastWsClose }` |
| `example/hello-world/ws-server-close.ts` | Create | `{ open(s){s.close(4000,'bye')} }` |
| `example/hello-world/routes.tsx` | Modify | +`/ws/echo`, `/ws/gated`, `/ws/server-close`, `/ws/protocols` |
| `example/hello-world/actions.ts` | Modify | +`lastWsClose()` probe action |
| `example/hello-world/index.ts` | Modify | +`brust.registerWsPaths(routes.filter(.websocket).map(.fullPath))` |
| `tests/integration.test.ts` | Modify | +7 WS tests at ports 38220-38226 |
| `architecture.md` | Modify | Promote Real-time:WebSockets entry from Designed → Built |

---

## Task 1: `Cargo.toml` — add tokio-tungstenite + sha1

**Files:**
- Modify: `Cargo.toml`

- [ ] **Step 1: Add the two deps**

Open `Cargo.toml`. Find the `[dependencies]` block. Append:

```toml
tokio-tungstenite = { version = "0.21", default-features = false }
sha1              = "0.10"
```

(`base64 = "0.22"` is already present at line 23 per session-6 Forms work.)

- [ ] **Step 2: Build to confirm deps resolve**

```bash
cargo build 2>&1 | tail -5
```

Expected: clean build (1 pre-existing dead_code warning). New deps added but not yet used → no warnings about them.

- [ ] **Step 3: Commit**

```bash
git add Cargo.toml Cargo.lock
git commit -m "build(rust): +tokio-tungstenite 0.21 + sha1 0.10 for WebSocket

tokio-tungstenite (default-features=false) for RFC 6455 frame parsing,
masking, ping/pong, and fragmentation. No TLS/native-tls features
(TLS termination is out of scope per session 6 deferred list).

sha1 for Sec-WebSocket-Accept derivation: base64(SHA1(key + magic)).
base64 already present (Forms work).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Rust `WsEnvelope` + `build_ws_envelope` + 2 unit tests

**Files:**
- Modify: `src/routes.rs`

- [ ] **Step 1: Write the failing tests**

Append to `src/routes.rs#[cfg(test)] mod tests`:

```rust
    #[test]
    fn ws_envelope_serialises_kind_ws_and_conn_id() {
        let json = build_ws_envelope(
            "GET",
            "/ws/chat",
            b"GET /ws/chat HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
            42u64,
            vec!["chat.v2".to_string(), "chat.v1".to_string()],
        );
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["kind"], "ws");
        assert_eq!(parsed["conn_id"], 42);
        assert_eq!(parsed["req"]["method"], "GET");
        assert_eq!(parsed["req"]["url"], "/ws/chat");
        assert_eq!(parsed["client_subprotocols"][0], "chat.v2");
        assert_eq!(parsed["client_subprotocols"][1], "chat.v1");
    }

    #[test]
    fn ws_envelope_empty_subprotocols() {
        let json = build_ws_envelope(
            "GET",
            "/ws/echo",
            b"GET /ws/echo HTTP/1.1\r\nHost: x\r\n\r\n",
            7u64,
            vec![],
        );
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["kind"], "ws");
        assert_eq!(parsed["conn_id"], 7);
        assert!(parsed["client_subprotocols"].as_array().unwrap().is_empty());
    }
```

- [ ] **Step 2: Run and verify fail**

```bash
cargo test --lib ws_envelope 2>&1 | tail -5
```

Expected: FAIL with `build_ws_envelope` undefined.

- [ ] **Step 3: Implement struct + builder**

Append to `src/routes.rs` near the existing `SseEnvelope`:

```rust
/// WS upgrade request envelope. `kind: "ws"` discriminates from
/// render/action/mcp/sse. `conn_id` is the Rust-assigned monotonic id
/// (shared with SSE via the same NEXT_CONN_ID counter; separate
/// REGISTRY tables avoid collision). `client_subprotocols` is the
/// comma-split `Sec-WebSocket-Protocol` request value (trimmed); JS
/// picks the first match against `route.wsOptions.subprotocols` and
/// signals back via napi_ws_signal_open.
#[derive(Serialize)]
pub struct WsEnvelope {
    pub kind: &'static str,
    pub conn_id: u64,
    pub client_subprotocols: Vec<String>,
    pub req: RequestEnvelope,
}

pub fn build_ws_envelope(
    method: &str,
    full_path: &str,
    raw_request: &[u8],
    conn_id: u64,
    client_subprotocols: Vec<String>,
) -> String {
    let (_, query) = match full_path.split_once('?') {
        Some((p, q)) => (p, q),
        None => (full_path, ""),
    };
    let req = build_request_envelope(method, full_path, query, raw_request);
    let env = WsEnvelope { kind: "ws", conn_id, client_subprotocols, req };
    serde_json::to_string(&env).unwrap()
}
```

- [ ] **Step 4: Run and verify pass**

```bash
cargo test --lib ws_envelope 2>&1 | tail -5
cargo test --lib 2>&1 | tail -3
```

Expected: 2 new pass; total 65 Rust unit tests (63 prior + 2).

- [ ] **Step 5: Commit**

```bash
git add src/routes.rs
git commit -m "feat(rust): WsEnvelope + build_ws_envelope

New envelope variant for WS upgrade dispatch. kind='ws' discriminates
from render/action/mcp/sse. conn_id shares the NEXT_CONN_ID counter
with SSE (separate REGISTRY tables). client_subprotocols is the
comma-split Sec-WebSocket-Protocol value — JS picks the first match
against route.wsOptions.subprotocols.

Tests: 2 — basic shape + empty subprotocols list.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Rust `src/ws.rs` skeleton — types, REGISTRY, WS_PATHS, parse_ws_handshake, compute_sec_accept + 8 unit tests

**Files:**
- Create: `src/ws.rs`
- Modify: `src/lib.rs`

- [ ] **Step 1: Create `src/ws.rs` with types + helpers + tests**

```rust
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
        } else if let Some(rest) = lc.strip_prefix("sec-websocket-key:") {
            // Preserve original-case base64 value, not the lowercased one
            if let Some((_, val)) = line.split_once(':') {
                sec_websocket_key = Some(val.trim().to_string());
            }
        } else if let Some(rest) = lc.strip_prefix("sec-websocket-version:") {
            if rest.trim() == "13" { version_ok = true; }
        } else if let Some(_) = lc.strip_prefix("sec-websocket-protocol:") {
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
    /// JS Promise returned by napi_ws_send.
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
pub struct WsConn {
    pub send_tx: mpsc::Sender<WsOutgoing>,
    pub open_tx: Option<oneshot::Sender<WsOpenSignal>>,
    pub on_message: Option<napi::threadsafe_function::ThreadsafeFunction<(Vec<u8>, bool)>>,
    pub on_close: Option<napi::threadsafe_function::ThreadsafeFunction<(u16, String)>>,
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
```

- [ ] **Step 2: Register the module**

In `src/lib.rs` find the existing `pub mod sse;` line and add `pub mod ws;` adjacent (alphabetical order — `sse` before `ws`):

```rust
pub mod sse;
mod server;
pub mod ws;
```

(If the current ordering is `sse / server`, insert `ws` after `server`. Match whatever pattern the file uses.)

- [ ] **Step 3: Build + run tests**

```bash
cargo build 2>&1 | tail -3
cargo test --lib ws:: 2>&1 | tail -8
cargo test --lib 2>&1 | tail -3
```

Expected: build clean; 8 new tests pass; total 73 Rust unit tests (65 prior + 8).

- [ ] **Step 4: Commit**

```bash
git add src/ws.rs src/lib.rs
git commit -m "feat(rust): src/ws.rs — REGISTRY, WsConn, parse_ws_handshake, compute_sec_accept

Per-connection state (WsConn) holds the JS→Rust send mpsc, the
open-signal oneshot, and tsfn handles for on_message + on_close that
napi_ws_register_handlers populates. WS_PATHS is the boot-time literal
match set (parameterized routes are a follow-up).

parse_ws_handshake validates Upgrade + Connection + Sec-WebSocket-Key +
Sec-WebSocket-Version: 13 and extracts client subprotocols. Returns
typed HandshakeError on each failure mode for clear 4xx mapping.

compute_sec_accept does the RFC 6455 §1.3 SHA1(key + magic) + base64
ritual. Validated against the spec example vector.

Tests: 8 — RFC example vector, 3 handshake parser paths, 1 invalid,
WS_PATHS round-trip, REGISTRY insert/remove, conn_id uniqueness across
SSE+WS (NEXT_CONN_ID is shared via crate::sse::next_conn_id).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: NAPI bridge — `napi_ws_signal_open` / `_send` / `_close` / `_register_handlers` / `napi_register_ws_paths` (LOAD-BEARING)

**Files:**
- Modify: `src/lib.rs`

- [ ] **Step 1: Add the 5 NAPI fns to `src/lib.rs`**

Append (alongside the existing `napi_sse_*` block) a new `// ----- WS NAPI bridge -----` section:

```rust
use crate::ws::{registry as ws_registry, WsConn, WsFrameKind, WsOpenSignal, WsOutgoing};

/// JS reports the middleware verdict + chosen subprotocol. Single-shot;
/// second call is a no-op (the Option is taken).
#[napi]
pub fn napi_ws_signal_open(
    conn_id: BigInt,
    status: u32,
    body: Buffer,
    content_type: String,
    subprotocol: String,
) -> NapiResult<()> {
    let conn_id = bigint_to_u64(&conn_id)?;
    let open_tx = {
        let mut reg = ws_registry().lock();
        reg.get_mut(&conn_id).and_then(|c| c.open_tx.take())
    };
    if let Some(tx) = open_tx {
        let _ = tx.send(WsOpenSignal {
            status: status as u16,
            body: body.to_vec(),
            content_type,
            subprotocol,
        });
    }
    Ok(())
}

/// Send one frame. is_binary=false → Text frame, true → Binary frame.
/// Returns Promise<()> resolving after the TCP write completes.
#[napi]
pub async fn napi_ws_send(conn_id: BigInt, data: Buffer, is_binary: bool) -> NapiResult<()> {
    let conn_id = bigint_to_u64(&conn_id)?;
    let send_tx = {
        let reg = ws_registry().lock();
        reg.get(&conn_id).map(|c| c.send_tx.clone())
    };
    let Some(tx) = send_tx else {
        return Err(napi::Error::from_reason(format!("ws conn {} not registered", conn_id)));
    };
    let (ack_tx, ack_rx) = tokio::sync::oneshot::channel::<()>();
    let frame = if is_binary {
        WsFrameKind::Binary(data.to_vec())
    } else {
        // Text frames carry UTF-8. JS produced bytes from a string; we trust
        // the bytes are already valid UTF-8 and route via from_utf8_unchecked
        // would be unsafe — use the safe constructor with a clear error on
        // (theoretically impossible) invalid input.
        let s = String::from_utf8(data.to_vec())
            .map_err(|_| napi::Error::from_reason(format!("ws conn {} text frame not valid utf-8", conn_id)))?;
        WsFrameKind::Text(s)
    };
    let outgoing = WsOutgoing { frame, ack: ack_tx };
    if tx.send(outgoing).await.is_err() {
        return Err(napi::Error::from_reason(format!("ws conn {} send channel closed", conn_id)));
    }
    ack_rx.await.map_err(|_| napi::Error::from_reason(
        format!("ws conn {} send ack dropped — TCP write failed or conn torn down", conn_id),
    ))?;
    Ok(())
}

/// Initiate close. code defaults applied client-side; reason capped at 123
/// bytes (RFC 6455) at the JS layer. Idempotent — enqueues a Close frame.
#[napi]
pub async fn napi_ws_close(conn_id: BigInt, code: u32, reason: String) -> NapiResult<()> {
    let conn_id = bigint_to_u64(&conn_id)?;
    let send_tx = {
        let reg = ws_registry().lock();
        reg.get(&conn_id).map(|c| c.send_tx.clone())
    };
    // Idempotent: missing conn (already torn down) is a silent no-op.
    let Some(tx) = send_tx else { return Ok(()); };
    let (ack_tx, _ack_rx) = tokio::sync::oneshot::channel::<()>();
    let frame = WsFrameKind::Close(code as u16, reason);
    // Fire-and-forget on the ack — the per-conn task drops the sender after
    // writing the Close frame, so the ack may or may not arrive depending on
    // race with peer close. The JS side doesn't await this.
    let _ = tx.send(WsOutgoing { frame, ack: ack_tx }).await;
    Ok(())
}

/// JS registers per-conn callbacks. ws_conn_task invokes these non-blocking.
/// Both must be supplied; pass an empty fn for no-op behaviors.
#[napi]
pub fn napi_ws_register_handlers(
    conn_id: BigInt,
    on_message: Function<(Buffer, bool), ()>,
    on_close: Function<(u32, String), ()>,
) -> NapiResult<()> {
    let conn_id = bigint_to_u64(&conn_id)?;
    let on_message_tsfn = on_message.build_threadsafe_function().build()?;
    let on_close_tsfn = on_close.build_threadsafe_function().build()?;
    let mut reg = ws_registry().lock();
    if let Some(conn) = reg.get_mut(&conn_id) {
        conn.on_message = Some(on_message_tsfn);
        conn.on_close = Some(on_close_tsfn);
    }
    Ok(())
}

/// Boot-time registry of literal WS paths. Mirror of napi_register_sse_paths.
#[napi]
pub fn napi_register_ws_paths(paths: Vec<String>) -> NapiResult<()> {
    for p in paths {
        crate::ws::register_ws_path(p);
    }
    Ok(())
}
```

Notes:
- `bigint_to_u64` already exists (added during SSE Task 4). Reuse.
- `napi::threadsafe_function::ThreadsafeFunction` is already imported (SSE Task 4).
- Tsfn arg shape: `(Buffer, bool)` for on_message; `(u32, String)` for on_close. Match napi-rs Function generics. If napi-rs ABI complains about tuple args, fall back to a single struct arg (e.g. `#[napi(object)] struct OnMessageArg { data: Buffer, is_binary: bool }`) — pick whichever compiles.

- [ ] **Step 2: Build**

```bash
cd runtime && bun run build:debug 2>&1 | tail -5 && cd -
```

Expected: clean (1 pre-existing dead_code warning only).

If napi-rs rejects tuple-typed `Function<(A, B), ()>` signatures, the standard fix is wrap the args in an `#[napi(object)]` struct:

```rust
#[napi(object)]
pub struct WsMessagePayload {
    pub data: Buffer,
    pub is_binary: bool,
}
#[napi(object)]
pub struct WsClosePayload {
    pub code: u32,
    pub reason: String,
}
```
And change the Function generics to `Function<WsMessagePayload, ()>` / `Function<WsClosePayload, ()>`. The `ws_conn_task` (Task 5) calls the tsfn with the struct rather than a tuple. If you take this fork, update the struct field names referenced by Task 5/9 too.

- [ ] **Step 3: Run Rust tests**

```bash
cargo test --lib 2>&1 | tail -3
```

Expected: 73 pass (no regression; no new WS-NAPI tests — those come via the live stack in Task 13).

- [ ] **Step 4: Commit**

```bash
git add src/lib.rs
git commit -m "feat(rust): NAPI bridge for WebSocket — signal_open/send/close/register_handlers/register_ws_paths

Five NAPI fns wire JS to the per-conn Rust task in ws_conn_task:
- napi_ws_signal_open: single-shot middleware verdict + chosen subprotocol
- napi_ws_send: enqueue one Text/Binary frame; Promise awaits wire ack
- napi_ws_close: enqueue Close frame (idempotent — missing conn no-op)
- napi_ws_register_handlers: store on_message + on_close tsfns per conn
- napi_register_ws_paths: boot-time literal-path registry (mirror of SSE)

conn_id crosses as BigInt; reuses bigint_to_u64 helper. Send/close return
errors as napi::Error::from_reason so JS can surface them clearly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Rust `ws_conn_task` — frame loop + ping/pong + close cleanup + 2 unit tests (LOAD-BEARING)

**Files:**
- Modify: `src/ws.rs`

- [ ] **Step 1: Add `ws_conn_task` + helpers**

Append to `src/ws.rs` (above `#[cfg(test)]`):

```rust
use bytes::Bytes;
use futures::{SinkExt, StreamExt};
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio_tungstenite::{tungstenite::protocol::CloseFrame, tungstenite::Message, WebSocketStream};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;

/// Per-connection driver loop. Owns the WebSocketStream after the 101
/// handshake completes. Selects between outgoing sends (JS-pushed),
/// incoming frames (tokio-tungstenite Stream), and a ping ticker.
///
/// on_close fires EXACTLY ONCE per connection for peer-initiated,
/// timeout, error, shutdown, and oversize closes. It does NOT fire
/// when the author calls socket.close() — that path is signalled by
/// the Close frame being enqueued via send_tx and recognized by the
/// is_close flag below.
pub async fn ws_conn_task(
    ws: WebSocketStream<TcpStream>,
    conn_id: u64,
    mut send_rx: mpsc::Receiver<WsOutgoing>,
    ping_interval_ms: u64,
    max_msg_bytes: usize,
) {
    let (mut ws_sink, mut ws_stream) = ws.split();
    // ping_interval_ms == 0 disables both pings AND pong-timeout monitoring.
    // We still create a ticker but skip its work on tick when disabled.
    let mut ping_tick = tokio::time::interval(
        Duration::from_millis(ping_interval_ms.max(1)),
    );
    let mut last_pong = Instant::now();
    let pong_timeout = Duration::from_millis(ping_interval_ms.saturating_mul(2));
    let mut close_fired = false;

    loop {
        tokio::select! {
            biased;   // give outgoing sends priority to drain the queue
            Some(out) = send_rx.recv() => {
                let msg = match out.frame {
                    WsFrameKind::Text(s) => Message::Text(s.into()),
                    WsFrameKind::Binary(b) => Message::Binary(b.into()),
                    WsFrameKind::Close(c, r) => Message::Close(Some(CloseFrame {
                        code: c.into(),
                        reason: r.into(),
                    })),
                };
                let is_close = matches!(msg, Message::Close(_));
                if ws_sink.send(msg).await.is_err() { break; }
                let _ = out.ack.send(());
                if is_close { break; }
            }
            Some(msg_result) = ws_stream.next() => {
                let msg = match msg_result {
                    Ok(m) => m,
                    Err(_) => {
                        if !close_fired {
                            fire_on_close(conn_id, 1006, "abnormal closure".to_string());
                            close_fired = true;
                        }
                        break;
                    }
                };
                match msg {
                    Message::Text(s) => {
                        if s.len() > max_msg_bytes {
                            if !close_fired {
                                fire_on_close(conn_id, 1009, "message too big".to_string());
                                close_fired = true;
                            }
                            let _ = ws_sink.send(Message::Close(Some(CloseFrame {
                                code: 1009.into(), reason: "message too big".into(),
                            }))).await;
                            break;
                        }
                        fire_on_message(conn_id, s.into_bytes(), false);
                    }
                    Message::Binary(b) => {
                        if b.len() > max_msg_bytes {
                            if !close_fired {
                                fire_on_close(conn_id, 1009, "message too big".to_string());
                                close_fired = true;
                            }
                            let _ = ws_sink.send(Message::Close(Some(CloseFrame {
                                code: 1009.into(), reason: "message too big".into(),
                            }))).await;
                            break;
                        }
                        fire_on_message(conn_id, b.to_vec(), true);
                    }
                    Message::Ping(p) => { let _ = ws_sink.send(Message::Pong(p)).await; }
                    Message::Pong(_) => { last_pong = Instant::now(); }
                    Message::Close(cf) => {
                        let code = cf.as_ref().map_or(1005u16, |c| c.code.into());
                        let reason = cf.map_or(String::new(), |c| c.reason.into_owned());
                        if !close_fired {
                            fire_on_close(conn_id, code, reason);
                            close_fired = true;
                        }
                        break;
                    }
                    Message::Frame(_) => {}
                }
            }
            _ = ping_tick.tick() => {
                if ping_interval_ms == 0 { continue; }
                if last_pong.elapsed() > pong_timeout {
                    if !close_fired {
                        fire_on_close(conn_id, 1011, "pong timeout".to_string());
                        close_fired = true;
                    }
                    let _ = ws_sink.send(Message::Close(Some(CloseFrame {
                        code: 1011.into(), reason: "pong timeout".into(),
                    }))).await;
                    break;
                }
                let _ = ws_sink.send(Message::Ping(Bytes::new())).await;
            }
        }
    }

    let _ = ws_sink.close().await;
    registry().lock().remove(&conn_id);
}

fn fire_on_message(conn_id: u64, data: Vec<u8>, is_binary: bool) {
    let tsfn = {
        let reg = registry().lock();
        reg.get(&conn_id).and_then(|c| c.on_message.as_ref().cloned())
    };
    if let Some(tsfn) = tsfn {
        tsfn.call(Ok((data, is_binary)), ThreadsafeFunctionCallMode::NonBlocking);
    }
}

fn fire_on_close(conn_id: u64, code: u16, reason: String) {
    let tsfn = {
        let reg = registry().lock();
        reg.get(&conn_id).and_then(|c| c.on_close.as_ref().cloned())
    };
    if let Some(tsfn) = tsfn {
        tsfn.call(Ok((code, reason)), ThreadsafeFunctionCallMode::NonBlocking);
    }
}
```

NOTE: `bytes` may or may not be in the dep tree explicitly. tokio-tungstenite re-exports `Bytes` from its own deps; the import `use bytes::Bytes` may need to be `use tokio_tungstenite::tungstenite::utils::Bytes` or similar. If `cargo build` errors, drop the explicit Bytes import and use `Vec::new().into()` instead of `Bytes::new()`.

ALSO: if Task 4 forked to the struct-payload form for tsfn args (`WsMessagePayload`/`WsClosePayload`), update `fire_on_message`/`fire_on_close` to construct the struct rather than the tuple.

- [ ] **Step 2: Build**

```bash
cargo build 2>&1 | tail -5
```

Expected: clean (1 pre-existing dead_code warning only).

If the build fails because `tsfn.call(...)` signature doesn't accept the `Ok(tuple)` shape, look at how the SSE NAPI fn `napi_sse_register_abort` invokes its tsfn (commit `d526e1b` lines around `tsfn.call`) — match exactly.

- [ ] **Step 3: No new tests this task**

Frame-loop testing is integration-level (Task 13). The unit-test surface is parser/registry (already done in Task 3) and JS-side glue (Task 9).

```bash
cargo test --lib 2>&1 | tail -3
```

Expected: 73 pass (no regression).

- [ ] **Step 4: Commit**

```bash
git add src/ws.rs
git commit -m "feat(rust): ws_conn_task — per-conn frame loop with ping/pong + close cleanup

tokio::select! over outgoing sends (JS-pushed via mpsc), incoming frames
(tokio-tungstenite stream), and a ping ticker. close_fired bool enforces
the on_close exactly-once contract for peer/timeout/error/oversize
closes; author-initiated socket.close skips on_close (signalled via the
is_close flag on the outgoing match).

Pong tracking + 2× pingMs timeout closes the conn with 1011. Message
size guard sends close 1009. Ping ticker is no-op when ping_interval_ms
is 0 (author opt-out). REGISTRY.remove + ws_sink.close on every exit.

fire_on_message / fire_on_close non-blocking tsfn calls keep the Rust
task free of JS round-trip latency.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Rust `server.rs` WS branch — handshake validation, dispatch, 101 writer (LOAD-BEARING)

**Files:**
- Modify: `src/server.rs`

- [ ] **Step 1: Add the WS dispatch branch in `handle_conn`**

Find the SSE branch (added in SSE Task 5). The WS branch is placed RIGHT AFTER the SSE branch (still inside the keep-alive request loop), BEFORE any generic render/404 fall-through.

```rust
// WS branch — dispatched when the matched route was registered via
// brust.registerWsPaths. Method MUST be GET; the Upgrade/Connection
// headers + Sec-WebSocket-Key + Sec-WebSocket-Version must validate
// per RFC 6455 before we accept.
if crate::ws::path_is_ws(&path) {
    if method != "GET" {
        let _ = s.write_all(http::error_405()).await;
        return;
    }
    let handshake = match crate::ws::parse_ws_handshake(&buf[..header_end]) {
        Ok(h) => h,
        Err(_) => {
            // Any header validation failure → 400 (we don't differentiate
            // missing-Upgrade vs bad-version externally; logs would suffice).
            let _ = s.write_all(http::error_400()).await;
            return;
        }
    };

    // Register conn in REGISTRY.
    let conn_id = crate::sse::next_conn_id();
    let (send_tx, send_rx) = tokio::sync::mpsc::channel::<crate::ws::WsOutgoing>(32);
    let (open_tx, open_rx) = tokio::sync::oneshot::channel::<crate::ws::WsOpenSignal>();
    crate::ws::registry().lock().insert(conn_id, crate::ws::WsConn {
        send_tx,
        open_tx: Some(open_tx),
        on_message: None,
        on_close: None,
    });

    // Pick a worker and dispatch.
    let Some(entry) = pool.pick_least_busy() else {
        let _ = s.write_all(http::error_500()).await;
        crate::ws::registry().lock().remove(&conn_id);
        return;
    };
    let envelope_json = crate::routes::build_ws_envelope(
        &method, &path, &buf[..header_end], conn_id,
        handshake.client_subprotocols.clone(),
    );

    // TODO(Task 7): replace with crate::pool::dispatch_ws(entry, envelope_json, conn_id)
    // Same pattern as SSE Task 5 — inline tsfn call now, refactor to pool helper later.
    {
        let _guard = entry.in_flight_guard();
        if let Err(e) = entry.tsfn.call_async(envelope_json).await {
            error!(worker_id = entry.id, error = %e, "ws tsfn call_async failed");
            let _ = s.write_all(http::error_500()).await;
            crate::ws::registry().lock().remove(&conn_id);
            return;
        }
    }

    // Await open verdict with 30s timeout.
    let open = match tokio::time::timeout(std::time::Duration::from_secs(30), open_rx).await {
        Ok(Ok(signal)) => signal,
        Ok(Err(_)) => {
            warn!(conn_id, "ws open_tx sender dropped before signal — JS crash?");
            let _ = s.write_all(http::error_500()).await;
            crate::ws::registry().lock().remove(&conn_id);
            return;
        }
        Err(_) => {
            warn!(conn_id, "ws open signal timeout (30s)");
            let _ = s.write_all(http::error_500()).await;
            crate::ws::registry().lock().remove(&conn_id);
            return;
        }
    };

    if open.status != 101 {
        // Middleware rejection — write a regular HTTP response.
        let body = open.body;
        let head = format!(
            "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            open.status,
            http::status_reason(open.status),
            open.content_type,
            body.len(),
        );
        let mut resp: Vec<u8> = head.into_bytes();
        resp.extend_from_slice(&body);
        let _ = s.write_all(resp).await;
        crate::ws::registry().lock().remove(&conn_id);
        return;
    }

    // 101: write handshake response then hand the socket to tokio-tungstenite.
    let accept = crate::ws::compute_sec_accept(&handshake.sec_websocket_key);
    let mut handshake_resp = String::with_capacity(256);
    handshake_resp.push_str("HTTP/1.1 101 Switching Protocols\r\n");
    handshake_resp.push_str("Upgrade: websocket\r\n");
    handshake_resp.push_str("Connection: Upgrade\r\n");
    handshake_resp.push_str(&format!("Sec-WebSocket-Accept: {}\r\n", accept));
    if !open.subprotocol.is_empty() {
        handshake_resp.push_str(&format!("Sec-WebSocket-Protocol: {}\r\n", open.subprotocol));
    }
    handshake_resp.push_str("\r\n");
    if s.write_all(handshake_resp.as_bytes()).await.is_err() {
        crate::ws::registry().lock().remove(&conn_id);
        return;
    }

    // Wrap the stream with tokio-tungstenite in Server role; the handshake is
    // already done so we use from_raw_socket. ping/max_msg come from defaults
    // for MVP — Task 8 forwards wsOptions from JS via the open signal later
    // (out of scope for MVP — hard-code defaults here).
    use tokio_tungstenite::tungstenite::protocol::Role;
    let ws_stream = tokio_tungstenite::WebSocketStream::from_raw_socket(
        s, Role::Server, None,
    ).await;
    crate::ws::ws_conn_task(
        ws_stream, conn_id, send_rx,
        30_000,            // pingMs default
        1_048_576,         // 1 MB max msg
    ).await;
    return;
}
```

NOTE: the spec discusses per-route `wsOptions.pingMs` / `maxMessageBytes`. For MVP we hard-code defaults at the Rust call site. Future task: extend `WsOpenSignal` with these fields so JS can forward them at signal_open time.

NOTE: `TcpStream` is the platform alias from `crate::io` (per SSE Task 5). `WebSocketStream::from_raw_socket` requires `AsyncRead + AsyncWrite + Unpin`. If the platform alias is tokio_uring on Linux (which doesn't impl those), this branch needs a `tokio::net::TcpStream`-specific path, OR we use the `SseIo` trait pattern (introduced in SSE Task 5) and adapt for WS. **Simplest path:** Use the underlying `tokio::net::TcpStream` directly via `s.into_inner()` if the platform alias exposes it. If not, this is a real porting hazard — report BLOCKED with the actual compile error and we'll decide whether to abstract over WebSocketStream or fall back to the SseIo-style trait.

- [ ] **Step 2: Update the outer method gate**

Find the method whitelist at the top of `handle_conn` (where POST /_brust/cache/invalidate, /_brust/action/, /_brust/mcp are whitelisted). The WS branch handles its own method check, but the outer gate must NOT block GET. Verify GET is already allowed for everything not in the POST whitelist — it is, per the existing pattern. No change needed.

- [ ] **Step 3: Build**

```bash
cargo build 2>&1 | tail -5
```

Expected: clean.

If the build fails on `WebSocketStream::from_raw_socket` not accepting the platform `TcpStream`, report BLOCKED with the actual error message — see Step 1 note above.

- [ ] **Step 4: Run Rust tests**

```bash
cargo test --lib 2>&1 | tail -3
```

Expected: 73 pass (no regression).

- [ ] **Step 5: Commit**

```bash
git add src/server.rs
git commit -m "feat(rust): WS dispatch branch in handle_conn

GET requests to registered WS paths validate handshake headers
(parse_ws_handshake), register conn in REGISTRY, dispatch a single
long-lived tsfn call to a worker, await napi_ws_signal_open with 30s
timeout. On status != 101 → regular HTTP error response; on 101 →
manual handshake response (Sec-WebSocket-Accept + optional
Sec-WebSocket-Protocol), wrap with tokio_tungstenite::WebSocketStream
in Server role using from_raw_socket (handshake already done by us),
hand to ws_conn_task with hard-coded defaults (pingMs=30000, max
msg 1MB — per-route forwarding is a follow-up).

Inline tsfn dispatch + in_flight_guard scoped to the handoff (same
pattern as SSE Task 5 before Task 6 refactored). Task 7 extracts to
pool::dispatch_ws.

MVP supports literal WS paths only — parameterized routes need a
matchit-rs follow-up.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Rust pool `dispatch_ws` — extract Task 6's inline tsfn call

**Files:**
- Modify: `src/pool.rs`
- Modify: `src/server.rs`

- [ ] **Step 1: Add `dispatch_ws` to `src/pool.rs`**

Append near `pool::dispatch_sse`:

```rust
/// Dispatch a WS envelope to the worker. Single long-lived tsfn call:
/// the JS side branches on `kind: 'ws'`, runs middleware, signals open
/// (101 or 4xx) via napi_ws_signal_open, then registers handler
/// callbacks via napi_ws_register_handlers. The Rust side holds an
/// in_flight_guard ONLY for the duration of the call_async handoff —
/// the per-conn task in src/ws.rs::ws_conn_task owns the rest of the
/// connection's lifetime independently of the worker pool.
///
/// Returns Err if the tsfn enqueue itself fails (e.g. worker dead).
/// Open-signal timeout + middleware reject handling are caller concerns.
pub async fn dispatch_ws(
    entry: Arc<TsfnEntry>,
    envelope_json: String,
) -> Result<(), napi::Error> {
    let _guard = entry.in_flight_guard();
    entry.tsfn.call_async(envelope_json).await
        .map(|_| ())
        .map_err(|e| napi::Error::from_reason(format!("ws dispatch failed: {e}")))
}
```

- [ ] **Step 2: Refactor `src/server.rs` WS branch to use `pool::dispatch_ws`**

Find the inline block in the WS branch:

```rust
{
    let _guard = entry.in_flight_guard();
    if let Err(e) = entry.tsfn.call_async(envelope_json).await {
        error!(worker_id = entry.id, error = %e, "ws tsfn call_async failed");
        let _ = s.write_all(http::error_500()).await;
        crate::ws::registry().lock().remove(&conn_id);
        return;
    }
}
```

Replace with:

```rust
if let Err(e) = crate::pool::dispatch_ws(entry.clone(), envelope_json).await {
    error!(worker_id = entry.id, error = %e, "ws dispatch failed");
    let _ = s.write_all(http::error_500()).await;
    crate::ws::registry().lock().remove(&conn_id);
    return;
}
```

- [ ] **Step 3: Build + test**

```bash
cargo build 2>&1 | tail -3
cargo test --lib 2>&1 | tail -3
```

Expected: clean; 73 pass.

- [ ] **Step 4: Commit**

```bash
git add src/pool.rs src/server.rs
git commit -m "feat(rust): pool::dispatch_ws — single long-lived tsfn helper

Extracts the inline tsfn enqueue + in_flight_guard pattern from the
WS branch in handle_conn into a documented pool helper. Symmetric to
how render/action/mcp/sse use their respective dispatch helpers.
in_flight_guard is scoped to the call_async handoff only — ws_conn_task
owns the rest of the connection lifetime independently.

No behavior change — Task 6 already had the correct lifetime semantics.
This relocates the pattern so future readers find one canonical WS
dispatch site instead of two.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: JS `Route.websocket` + `Route.wsOptions` + `RouteCall 'ws'` variant + `wsBranch` stub + `defineRoutes` validation

**Files:**
- Modify: `runtime/routes.ts`

- [ ] **Step 1: Add `Route.websocket` and `Route.wsOptions` fields**

Find the `Route` interface (currently includes `sse`/`sseOptions` from SSE Task 7). Append:

```ts
  /** When set, this route accepts WebSocket upgrades. Cannot coexist
   * with Component, loader, sse, or children (validated at defineRoutes
   * time). The factory is invoked lazily by the WS dispatch path and
   * cached per worker. The handler module exports WsHandlers. */
  websocket?: () => Promise<WsHandlers>
  wsOptions?: {
    /** Server-initiated ping interval in ms. Default 30000. Set 0 to disable.
     * Pong timeout = 2× pingMs; conn closes with code 1011 if no pong by then. */
    pingMs?: number
    /** Max message size in bytes. Default 1 048 576 (1 MB). Larger frames
     * close the conn with 1009 (Message Too Big). */
    maxMessageBytes?: number
    /** Subprotocols the route supports (Sec-WebSocket-Protocol). Client's
     * requested list is intersected with this; first match (in this declared
     * order) wins and is reflected in Sec-WebSocket-Protocol response. */
    subprotocols?: string[]
  }
```

- [ ] **Step 2: Add the `WsHandlers` and `WsSocket` interfaces**

Near the `BrustRequest` interface (top of file), append:

```ts
/** Handler module shape — what `() => Promise<WsHandlers>` resolves to. */
export interface WsHandlers {
  open?: (socket: WsSocket, ctx: { req: BrustRequest; subprotocol: string | null }) => void | Promise<void>
  message?: (socket: WsSocket, data: string | Uint8Array) => void | Promise<void>
  close?: (socket: WsSocket, code: number, reason: string) => void
}

/** Per-connection handle. send() returns a Promise that resolves when the
 * TCP write completes (cooperative backpressure). close() is idempotent;
 * default code 1000 / empty reason. */
export interface WsSocket {
  send(data: string | Uint8Array): Promise<void>
  close(code?: number, reason?: string): void
  readonly id: bigint
}
```

- [ ] **Step 3: Add the `RouteCall 'ws'` variant**

Find the `RouteCall` union (which has render/action/mcp/sse variants from earlier work). Append:

```ts
  | {
      kind: 'ws'
      conn_id: bigint
      client_subprotocols: string[]
      req: BrustRequest
    }
```

- [ ] **Step 4: Add `wsBranch` dispatch + stub**

Inside `makeRenderer`, after the existing `sse` branch dispatch (which is currently `if (call.kind === 'sse') return sseBranch(...)`), add:

```ts
if (call.kind === 'ws') {
  return wsBranch(call, view, encoder, routes)
}
```

Append a stub `wsBranch` function at file scope, near `sseBranch`:

```ts
async function wsBranch(
  call: Extract<RouteCall, { kind: 'ws' }>,
  view: Uint8Array,
  encoder: TextEncoder,
  routes: FlatRoute[],
): Promise<number> {
  // Stub — Task 12 replaces this with full middleware compose + handleWsConn.
  // Signal open with 503 so the Rust side returns a regular HTTP error
  // response (501 confused some clients in SSE smoke; 503 is clearer).
  const { native } = await import('./index.js')
  ;(native as any).napiWsSignalOpen(call.conn_id, 503, Buffer.from('ws handler not configured'), 'text/plain; charset=utf-8', '')
  return packResponse(view, encoder, {
    status: 200, body: '', contentType: 'text/plain',
  })
}
```

- [ ] **Step 5: Extend `validateRoute` for WS coexistence**

Find `validateRoute` (which already has SSE guards from SSE Task 7). Append guards for `websocket`:

```ts
  if (r.websocket) {
    const where = r.path ?? '(no path)'
    if (r.Component !== undefined) {
      throw new Error(`Route ${where}: 'websocket' cannot coexist with 'Component'`)
    }
    if (r.loader !== undefined) {
      throw new Error(`Route ${where}: 'websocket' cannot coexist with 'loader'`)
    }
    if (r.sse !== undefined) {
      throw new Error(`Route ${where}: 'websocket' cannot coexist with 'sse'`)
    }
    if (r.children !== undefined) {
      throw new Error(`Route ${where}: 'websocket' cannot have nested children`)
    }
  }
```

- [ ] **Step 6: Inject NEVER_ABORTS into ws req (mirror of SSE Task 10)**

Add to the top of `wsBranch` (BEFORE the signalOpen call):

```ts
  call.req.signal = NEVER_ABORTS
```

(Pre-emptive — once Task 12 wires the real handler, the middleware chain will need it.)

- [ ] **Step 7: Build + verify**

```bash
cd runtime && bun run build:debug 2>&1 | tail -3 && cd -
cd runtime && bunx tsc --noEmit 2>&1 | grep -E "routes\.ts|ws/" | head -10
bun test ./tests/integration.test.ts 2>&1 | tail -3
```

Expected: build clean; no new tsc errors specific to routes.ts/ws; 56 integration tests still pass.

- [ ] **Step 8: Commit**

```bash
git add runtime/routes.ts
git commit -m "feat(runtime): Route.websocket + RouteCall ws variant + validation

JS surface for WebSocket:
- Route gains websocket: () => Promise<WsHandlers> and wsOptions
- WsHandlers (open/message/close) + WsSocket (send/close/id) interfaces
  exported
- RouteCall gains 5th variant { kind: 'ws', conn_id: bigint,
  client_subprotocols: string[], req }
- defineRoutes validates websocket cannot coexist with Component,
  loader, sse, or children
- wsBranch is stubbed (Task 12 wires the real handleWsConn); stub
  signals 503 so smoke tests can distinguish unconfigured WS from a
  middleware reject
- req.signal injected with NEVER_ABORTS sentinel pre-handler so the
  middleware chain Task 12 wires doesn't crash on signal access

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: JS `runtime/ws/handler.ts` glue + `WsSocketImpl` + 6 unit tests (LOAD-BEARING)

**Files:**
- Create: `runtime/ws/handler.ts`
- Create: `runtime/ws/handler.test.ts`

- [ ] **Step 1: Write the 6 failing tests**

Create `runtime/ws/handler.test.ts`:

```ts
import { test, expect, mock } from 'bun:test'
import { handleWsConn, type WsCall, pickSubprotocol } from './handler.ts'
import type { Route, BrustRequest, WsHandlers } from '../routes.ts'

function makeNapi() {
  const sends: Array<{ conn_id: bigint, data: Uint8Array, isBinary: boolean }> = []
  let onMessage: ((data: Uint8Array, isBinary: boolean) => void) | undefined
  let onClose: ((code: number, reason: string) => void) | undefined
  return {
    sends,
    napi: {
      async send(conn_id: bigint, data: Uint8Array, isBinary: boolean) {
        sends.push({ conn_id, data, isBinary })
      },
      close: mock((_conn_id: bigint, _code: number, _reason: string) => {}),
      signalOpen: mock(() => {}),
      registerHandlers: (
        _conn_id: bigint,
        onMsg: (data: Uint8Array, isBinary: boolean) => void,
        onCls: (code: number, reason: string) => void,
      ) => { onMessage = onMsg; onClose = onCls },
    },
    fireMessage: (data: Uint8Array, isBinary: boolean) => onMessage?.(data, isBinary),
    fireClose: (code: number, reason: string) => onClose?.(code, reason),
  }
}

function makeReq(): BrustRequest {
  return {
    method: 'GET', url: '/ws/echo', headers: {}, cookies: {}, search: {},
    signal: undefined as unknown as AbortSignal,
  } as BrustRequest
}

test('pickSubprotocol: first match in route order wins', () => {
  // route order is the preference; client list is what's available
  expect(pickSubprotocol(['chat.v0', 'chat.v1'], ['chat.v2', 'chat.v1'])).toBe('chat.v1')
})

test('pickSubprotocol: no overlap returns null', () => {
  expect(pickSubprotocol(['chat.v0'], ['chat.v1', 'chat.v2'])).toBe(null)
})

test('pickSubprotocol: route declares none → null (no negotiation)', () => {
  expect(pickSubprotocol(['chat.v0'], [])).toBe(null)
  expect(pickSubprotocol(['chat.v0'], undefined)).toBe(null)
})

test('handler: signalOpen 101 + open(socket, ctx) fires + send proxies napi', async () => {
  const fx = makeNapi()
  let opened: { socket: any, ctx: any } | undefined
  const handlers: WsHandlers = {
    open(socket, ctx) { opened = { socket, ctx }; void socket.send('hi') },
  }
  const call: WsCall = { kind: 'ws', conn_id: 1n, client_subprotocols: [], req: makeReq() }
  const route: Route = { path: '/ws/x', websocket: async () => handlers } as Route
  await handleWsConn(call, route, fx.napi)
  expect(fx.napi.signalOpen).toHaveBeenCalledTimes(1)
  // Wait a microtask for the open + send to flush
  await new Promise((r) => setTimeout(r, 10))
  expect(opened).toBeDefined()
  expect(fx.sends[0]?.isBinary).toBe(false)
  expect(new TextDecoder().decode(fx.sends[0]!.data)).toBe('hi')
  fx.fireClose(1000, 'normal')   // cleanup
})

test('handler: on_message arrives as string for text, Uint8Array for binary', async () => {
  const fx = makeNapi()
  const received: Array<string | Uint8Array> = []
  const handlers: WsHandlers = {
    message(_s, data) { received.push(data) },
  }
  const call: WsCall = { kind: 'ws', conn_id: 2n, client_subprotocols: [], req: makeReq() }
  const route: Route = { path: '/ws/x', websocket: async () => handlers } as Route
  await handleWsConn(call, route, fx.napi)
  fx.fireMessage(new TextEncoder().encode('hello'), false)
  fx.fireMessage(new Uint8Array([1, 2, 3]), true)
  await new Promise((r) => setTimeout(r, 10))
  expect(received[0]).toBe('hello')
  expect(received[1]).toBeInstanceOf(Uint8Array)
  expect((received[1] as Uint8Array)[0]).toBe(1)
  fx.fireClose(1000, '')
})

test('handler: socket.close enqueues napi.close + subsequent send rejects', async () => {
  const fx = makeNapi()
  let s: any
  const handlers: WsHandlers = { open(socket) { s = socket } }
  const call: WsCall = { kind: 'ws', conn_id: 3n, client_subprotocols: [], req: makeReq() }
  const route: Route = { path: '/ws/x', websocket: async () => handlers } as Route
  await handleWsConn(call, route, fx.napi)
  await new Promise((r) => setTimeout(r, 10))
  s.close(4000, 'bye')
  expect(fx.napi.close).toHaveBeenCalledTimes(1)
  await expect(s.send('after close')).rejects.toThrow(/already closed/)
})

test('handler: message-handler throw is logged but conn stays open', async () => {
  const fx = makeNapi()
  const errs: any[] = []
  const origError = console.error
  console.error = (...a: any[]) => { errs.push(a) }
  try {
    const handlers: WsHandlers = {
      message() { throw new Error('boom') },
    }
    const call: WsCall = { kind: 'ws', conn_id: 4n, client_subprotocols: [], req: makeReq() }
    const route: Route = { path: '/ws/x', websocket: async () => handlers } as Route
    await handleWsConn(call, route, fx.napi)
    fx.fireMessage(new TextEncoder().encode('bad'), false)
    await new Promise((r) => setTimeout(r, 20))
    expect(errs.length).toBeGreaterThan(0)
    expect(fx.napi.close).not.toHaveBeenCalled()
  } finally {
    console.error = origError
  }
  fx.fireClose(1000, '')
})
```

- [ ] **Step 2: Run tests to verify fail**

```bash
cd runtime && bun test ws/handler.test.ts 2>&1 | tail -10
```

Expected: FAIL (module doesn't exist yet).

- [ ] **Step 3: Implement `runtime/ws/handler.ts`**

```ts
import type { Route, BrustRequest, RouteCall, WsHandlers, WsSocket } from '../routes.ts'

export type WsCall = Extract<RouteCall, { kind: 'ws' }>

/** NAPI surface — Rust provides these. In tests, a mock satisfies the shape. */
export interface WsNapi {
  send(conn_id: bigint, data: Uint8Array, isBinary: boolean): Promise<void>
  close(conn_id: bigint, code: number, reason: string): void
  signalOpen(conn_id: bigint, status: number, body: string, contentType: string, subprotocol: string): void
  registerHandlers(
    conn_id: bigint,
    onMessage: (data: Uint8Array, isBinary: boolean) => void,
    onClose: (code: number, reason: string) => void,
  ): void
}

/** Pick the first subprotocol from `routeList` that the client also requested.
 * Returns null when there's no overlap or routeList is empty/undefined. */
export function pickSubprotocol(
  clientList: string[],
  routeList: string[] | undefined,
): string | null {
  if (!routeList || routeList.length === 0) return null
  for (const candidate of routeList) {
    if (clientList.includes(candidate)) return candidate
  }
  return null
}

class WsSocketImpl implements WsSocket {
  constructor(
    public readonly id: bigint,
    private napi: WsNapi,
    private closed: { v: boolean },
  ) {}
  async send(data: string | Uint8Array): Promise<void> {
    if (this.closed.v) throw new Error(`ws conn ${this.id}: already closed`)
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    const isBinary = typeof data !== 'string'
    await this.napi.send(this.id, bytes, isBinary)
  }
  close(code: number = 1000, reason: string = ''): void {
    if (this.closed.v) return
    this.closed.v = true
    this.napi.close(this.id, code, reason.slice(0, 123))
  }
}

const decoder = new TextDecoder('utf-8')

/**
 * Per-connection JS driver for WebSocket routes. Caller (wsBranch) is
 * responsible for running middleware FIRST and only invoking this on a 101
 * verdict — the signalOpen call here is always 101.
 *
 * Note: the route + napi shim are dependency-injected so unit tests can use
 * a mock that captures `registerHandlers`'s callbacks and fires them
 * synchronously.
 */
export async function handleWsConn(
  call: WsCall,
  route: Route,
  napi: WsNapi,
): Promise<void> {
  // Load the handler module. Failure here is a 5xx (treated as middleware
  // reject pathway — Rust will write a regular HTTP response).
  let handlers: WsHandlers
  try {
    handlers = await route.websocket!()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    napi.signalOpen(call.conn_id, 500, `ws handler import failed: ${msg}`, 'text/plain; charset=utf-8', '')
    return
  }

  // Pick subprotocol (route declares; client requests; first match wins).
  const chosen = pickSubprotocol(call.client_subprotocols, route.wsOptions?.subprotocols)
  napi.signalOpen(call.conn_id, 101, '', '', chosen ?? '')

  // After signalOpen returns, Rust writes 101 + handshake and the conn is
  // live. Build the socket + register handlers.
  const closed = { v: false }
  const socket = new WsSocketImpl(call.conn_id, napi, closed)

  napi.registerHandlers(
    call.conn_id,
    (data, isBinary) => {
      // Convert payload + dispatch to user handler. Throws are caught +
      // logged; conn stays open (one bad message shouldn't kill the conn).
      const payload = isBinary ? data : decoder.decode(data)
      try {
        const r = handlers.message?.(socket, payload)
        if (r instanceof Promise) r.catch((err) => {
          console.error(`[brust] ws conn=${call.conn_id} message handler rejected:`, err)
        })
      } catch (err) {
        console.error(`[brust] ws conn=${call.conn_id} message handler threw:`, err)
      }
    },
    (code, reason) => {
      // on_close fires once for peer/timeout/error/oversize closes.
      closed.v = true
      try {
        handlers.close?.(socket, code, reason)
      } catch (err) {
        console.error(`[brust] ws conn=${call.conn_id} close handler threw:`, err)
      }
    },
  )

  // Fire the author's open hook. Throws here close the conn 1011.
  if (handlers.open) {
    try {
      const r = handlers.open(socket, { req: call.req, subprotocol: chosen })
      if (r instanceof Promise) {
        r.catch((err) => {
          console.error(`[brust] ws conn=${call.conn_id} open handler rejected:`, err)
          if (!closed.v) socket.close(1011, 'internal error')
        })
      }
    } catch (err) {
      console.error(`[brust] ws conn=${call.conn_id} open handler threw:`, err)
      if (!closed.v) socket.close(1011, 'internal error')
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd runtime && bun test ws/handler.test.ts 2>&1 | tail -10
```

Expected: 6 pass / 0 fail.

If test 5 ("socket.close enqueues napi.close + subsequent send rejects") flakes because the open handler's `void socket.send(...)` fires AFTER the test's `s.close(4000, 'bye')`, restructure the test to await the open hook completion before calling close.

- [ ] **Step 5: Verify integration regress**

```bash
cd .. && bun test ./tests/integration.test.ts 2>&1 | tail -3
```

Expected: 56 pass / 0 fail.

- [ ] **Step 6: Commit**

```bash
git add runtime/ws/handler.ts runtime/ws/handler.test.ts
git commit -m "feat(runtime): WS glue handleWsConn + WsSocketImpl + 6 unit tests

handleWsConn is the per-conn JS driver:
1. Lazy-loads route.websocket() — throws → 500 signalOpen + return
2. pickSubprotocol(clientList, routeList) — first match in route order
3. signalOpen 101 + chosen subprotocol — Rust writes the handshake
4. Builds WsSocketImpl + registers on_message/on_close tsfn callbacks
5. Fires open(socket, ctx) — throws close the conn 1011
6. on_message dispatch: utf-8 decode for text; Uint8Array for binary;
   handler throws are logged but conn stays open (per-message
   resilience — author wraps in try/catch for strict-close)
7. on_close: closed.v flipped so future socket.send rejects clearly

WsSocketImpl.send proxies napi.send (Promise = backpressure); close
is idempotent + caps reason at 123 bytes (RFC 6455).

Six unit tests cover: subprotocol negotiation (3), open + send proxy,
message dispatch (text + binary), close idempotency + post-close
send rejection, message-throw resilience.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: JS `defineRoutes` WS validation tests (4 new)

**Files:**
- Modify: `runtime/routes.test.ts`

- [ ] **Step 1: Append 4 tests**

```ts
test('flattenRoutes rejects websocket + Component', () => {
  expect(() =>
    flattenRoutes([
      { path: '/x', websocket: async () => ({}), Component: C },
    ] as Route[]),
  ).toThrow(/cannot coexist with 'Component'/)
})

test('flattenRoutes rejects websocket + loader', () => {
  expect(() =>
    flattenRoutes([
      { path: '/x', websocket: async () => ({}), loader: async () => ({}) },
    ] as Route[]),
  ).toThrow(/cannot coexist with 'loader'/)
})

test('flattenRoutes rejects websocket + sse', () => {
  expect(() =>
    flattenRoutes([
      { path: '/x', websocket: async () => ({}), sse: () => new ReadableStream() },
    ] as Route[]),
  ).toThrow(/cannot coexist with 'sse'/)
})

test('flattenRoutes accepts websocket + middleware', () => {
  expect(() =>
    flattenRoutes([
      { path: '/x', websocket: async () => ({}), middleware: [] },
    ] as Route[]),
  ).not.toThrow()
})
```

- [ ] **Step 2: Run + verify pass**

```bash
cd runtime && bun test routes.test.ts 2>&1 | tail -5
```

Expected: 26 pass (22 prior + 4 new).

- [ ] **Step 3: Commit**

```bash
git add runtime/routes.test.ts
git commit -m "test(runtime): 4 flattenRoutes WS coexistence validations

Locks in the websocket + Component/loader/sse/children guards added
in Task 8: those throw at defineRoutes time; websocket + middleware
is allowed.

26 routes tests total (22 prior + 4 new).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Example app — ws-echo.ts + ws-server-close.ts + routes.tsx + lastWsClose probe + registerWsPaths wiring

**Files:**
- Create: `example/hello-world/ws-echo.ts`
- Create: `example/hello-world/ws-server-close.ts`
- Modify: `example/hello-world/routes.tsx`
- Modify: `example/hello-world/actions.ts`
- Modify: `example/hello-world/index.ts`
- Modify: `runtime/index.ts`

- [ ] **Step 1: Create `ws-echo.ts`**

```ts
import type { WsHandlers } from '../../runtime/routes.ts'

/** Demo WS handler: echoes every incoming frame back unchanged.
 * Records the last close code/reason into globalThis.__lastWsClose
 * so the lastWsClose probe action can observe it. Used by integration
 * tests 1, 2, 4, 5, 6, 7. */
export default {
  message(socket, data) {
    void socket.send(data)
  },
  close(_socket, code, reason) {
    ;(globalThis as { __lastWsClose?: { code: number, reason: string } }).__lastWsClose = { code, reason }
  },
} satisfies WsHandlers
```

- [ ] **Step 2: Create `ws-server-close.ts`**

```ts
import type { WsHandlers } from '../../runtime/routes.ts'

/** Demo WS handler that closes immediately on open with a custom code.
 * Used by integration test 3 to verify server-initiated close propagates
 * to the client's onclose event. */
export default {
  open(socket) {
    socket.close(4000, 'bye')
  },
} satisfies WsHandlers
```

- [ ] **Step 3: Modify `routes.tsx`**

Import the new modules at the top:

```tsx
// (after existing imports)
import wsEcho from './ws-echo.ts'   // (these imports are unused — the lazy factory below loads them on demand; included only for type-check coverage if linter complains)
```

Append to the `defineRoutes([...])` call (after the SSE routes from SSE Task 11):

```tsx
  // WS demo routes.
  { path: '/ws/echo',          websocket: () => import('./ws-echo.ts') },
  { path: '/ws/gated',         middleware: [authRequired], websocket: () => import('./ws-echo.ts') },
  { path: '/ws/server-close',  websocket: () => import('./ws-server-close.ts') },
  { path: '/ws/protocols',     websocket: () => import('./ws-echo.ts'),
    wsOptions: { subprotocols: ['chat.v2', 'chat.v1'] } },
```

(If the unused-imports lint is silent on lazy factories, drop the top-of-file `import wsEcho` — it's not needed at runtime.)

- [ ] **Step 4: Modify `actions.ts` — add `lastWsClose` probe**

Append to `example/hello-world/actions.ts`:

```ts
/** Probe: returns the last WS close code/reason recorded by the ws-echo
 * handler. Used by integration test 7 (client clean close → on_close 1000).
 * Relies on BRUST_WORKERS=1 in the test env so the probe action lands on
 * the same JS context that ran the WS handler. */
export async function lastWsClose(_req: BrustRequest): Promise<{ code: number, reason: string }> {
  return (globalThis as { __lastWsClose?: { code: number, reason: string } }).__lastWsClose ?? { code: 0, reason: '' }
}
```

- [ ] **Step 5: Add `brust.registerWsPaths` to `runtime/index.ts`**

Find `brust.registerSsePaths` (added in SSE Task 11). Append immediately after:

```ts
  /** Register the list of literal route paths that should be dispatched as
   * WebSocket upgrades. Call from the main process after defineRoutes.
   * MVP supports only literal paths — parameterized routes (e.g.
   * `/ws/chat/{room}`) are a follow-up. */
  registerWsPaths(paths: string[]): void {
    ;(native as any).napiRegisterWsPaths(paths)
  },
```

- [ ] **Step 6: Modify `example/hello-world/index.ts` — call registerWsPaths**

Find where `brust.registerSsePaths(ssePaths)` is called (added in SSE Task 11). Add the WS equivalent right after:

```ts
const wsPaths = routes
  .filter((r) => r.chain[r.chain.length - 1].websocket !== undefined)
  .map((r) => r.fullPath)
if (wsPaths.length > 0) {
  brust.registerWsPaths(wsPaths)
  console.log(`[brust] main: registered ${wsPaths.length} ws path(s): ${wsPaths.join(', ')}`)
}
```

- [ ] **Step 7: Smoke-test boot wiring**

```bash
cd /Users/detoro/code/brust/runtime && bun run build:debug > /dev/null 2>&1 && cd -
BRUST_PORT=38995 BRUST_WORKERS=1 bun run example/hello-world/index.ts > /tmp/ws11.log 2>&1 &
PID=$!
sleep 5
grep -E "registered|ws|listening|mcp" /tmp/ws11.log | head -10
kill $PID 2>/dev/null; wait $PID 2>/dev/null
rm /tmp/ws11.log
```

Expected: boot log shows `[brust] main: registered 4 ws path(s): /ws/echo, /ws/gated, /ws/server-close, /ws/protocols` + listening line. Task 12 wires the actual handshake; until then a real WS connection attempt returns 503 from the stub.

- [ ] **Step 8: Run integration tests for regress**

```bash
bun test ./tests/integration.test.ts 2>&1 | tail -3
```

Expected: 56 pass (still — no new tests until Task 13).

- [ ] **Step 9: Commit**

```bash
git add example/hello-world/ws-echo.ts example/hello-world/ws-server-close.ts example/hello-world/routes.tsx example/hello-world/actions.ts example/hello-world/index.ts runtime/index.ts
git commit -m "feat(example): /ws/echo + /ws/gated + /ws/server-close + /ws/protocols + lastWsClose probe + registerWsPaths

ws-echo.ts: echoes every frame back, records last close into
globalThis.__lastWsClose for the probe action.

ws-server-close.ts: closes immediately with code 4000 on open
(used by integration test 3).

routes.tsx: four WS routes — open echo, gated echo (authRequired
middleware), server-close, and protocols (subprotocols negotiation
test with chat.v2 + chat.v1).

actions.ts: lastWsClose probe returns the recorded close.

runtime/index.ts: brust.registerWsPaths(paths) translates to
native.napiRegisterWsPaths (mirror of registerSsePaths).

example/index.ts: filters routes for those with leaf.websocket,
extracts fullPath, calls brust.registerWsPaths after registerSsePaths.

Boot smoke verified: 'registered 4 ws path(s)' appears in log. The
/ws/* routes will return 503 from the wsBranch stub until Task 12
wires the real handleWsConn.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Wire `wsBranch` → `handleWsConn` end-to-end (LOAD-BEARING capstone)

**Files:**
- Modify: `runtime/routes.ts`

- [ ] **Step 1: Replace the `wsBranch` stub body**

Find the stub `wsBranch` from Task 8. Replace the body entirely:

```ts
async function wsBranch(
  call: Extract<RouteCall, { kind: 'ws' }>,
  view: Uint8Array,
  encoder: TextEncoder,
  routes: FlatRoute[],
): Promise<number> {
  // Coerce conn_id from JSON.parse number → BigInt (same as sseBranch fix
  // in SSE Task 12). The native binding requires BigInt because conn_ids
  // are u64 on the Rust side.
  ;(call as any).conn_id = BigInt(call.conn_id)

  // Find the matching FlatRoute by literal fullPath (Rust gates dispatch
  // via path_is_ws — same literal-match contract as SSE).
  const pathOnly = call.req.url.split('?')[0]
  const flat = routes.find((r) => r.fullPath === pathOnly)
  const leaf = flat?.chain[flat.chain.length - 1]

  // Build the napi shim around the four napiWs* native fns. signalOpen
  // wraps the body string in a Buffer (Rust takes Buffer).
  const native = await import('./index.js')
  const napi = {
    send: (conn_id: bigint, bytes: Uint8Array, isBinary: boolean) =>
      (native as any).napiWsSend(conn_id, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), isBinary),
    close: (conn_id: bigint, code: number, reason: string) =>
      (native as any).napiWsClose(conn_id, code, reason),
    signalOpen: (conn_id: bigint, status: number, body: string, ct: string, subprotocol: string) => {
      const bodyBytes = encoder.encode(body)
      ;(native as any).napiWsSignalOpen(
        conn_id, status,
        Buffer.from(bodyBytes.buffer, bodyBytes.byteOffset, bodyBytes.byteLength),
        ct, subprotocol,
      )
    },
    registerHandlers: (
      conn_id: bigint,
      onMessage: (data: Uint8Array, isBinary: boolean) => void,
      onClose: (code: number, reason: string) => void,
    ) => {
      ;(native as any).napiWsRegisterHandlers(conn_id, onMessage, onClose)
    },
  }

  if (!flat || !leaf || !leaf.websocket) {
    // Defensive — Rust gates by path_is_ws, but be explicit.
    napi.signalOpen(call.conn_id, 404, 'not found', 'text/plain; charset=utf-8', '')
    return packResponse(view, encoder, { status: 200, body: '', contentType: 'text/plain' })
  }

  // Inject NEVER_ABORTS into req for middleware. There's no
  // per-conn AbortController for WS — handleWsConn doesn't create one
  // because lifecycle is handled by registered onMessage/onClose
  // callbacks rather than awaiting on a request signal.
  call.req.signal = NEVER_ABORTS

  // Run middleware chain with a 200 placeholder terminal that
  // represents "ready to upgrade". The terminal does NOT call
  // route.websocket — handleWsConn does that after middleware approves.
  const placeholderTerminal: () => Promise<RouteResponse> = async () => ({
    status: 101, body: '', contentType: 'application/octet-stream',
  })
  const chain = composeChain(call.req, leaf.middleware, placeholderTerminal)
  const verdict = await chain()

  if (verdict.status >= 400) {
    napi.signalOpen(
      call.conn_id, verdict.status, verdict.body,
      verdict.contentType ?? 'text/plain; charset=utf-8',
      '',
    )
    return packResponse(view, encoder, { status: 200, body: '', contentType: 'text/plain' })
  }

  // Middleware OK — invoke handleWsConn. It signals open 101 itself
  // (with the chosen subprotocol) and registers handlers.
  const { handleWsConn } = await import('./ws/handler.ts')
  const routeShim: Route = {
    path: flat.fullPath,
    websocket: leaf.websocket,
    wsOptions: leaf.wsOptions,
  }
  await handleWsConn(call, routeShim, napi)
  return packResponse(view, encoder, { status: 200, body: '', contentType: 'application/octet-stream' })
}
```

- [ ] **Step 2: End-to-end smoke test**

```bash
cd /Users/detoro/code/brust/runtime && bun run build:debug > /tmp/build12.log 2>&1 && tail -3 /tmp/build12.log && cd -

BRUST_PORT=38995 BRUST_WORKERS=1 bun run example/hello-world/index.ts > /tmp/ws12.log 2>&1 &
PID=$!
sleep 5

cat > /tmp/ws-smoke.ts <<'EOF'
const url = `ws://127.0.0.1:${process.env.PORT}/ws/echo`
const ws = new WebSocket(url)
const got: string[] = []
let closed = false
ws.onopen = () => { ws.send('hello') }
ws.onmessage = (e) => { got.push(typeof e.data === 'string' ? e.data : `[binary ${e.data.byteLength}]`); ws.close() }
ws.onclose = () => { closed = true }
await new Promise((r) => setTimeout(r, 1500))
console.log(`got=${JSON.stringify(got)} closed=${closed}`)
EOF
PORT=38995 bun run /tmp/ws-smoke.ts

# Subprotocol negotiation
cat > /tmp/ws-proto.ts <<'EOF'
const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT}/ws/protocols`, ['chat.v0', 'chat.v1'])
ws.onopen = () => { console.log(`protocol=${ws.protocol}`); ws.close() }
await new Promise((r) => setTimeout(r, 1500))
EOF
PORT=38995 bun run /tmp/ws-proto.ts

# Gated, no cookie (use fetch with Upgrade headers; expect 401)
echo "--- gated, no cookie ---"
curl -s -i -H 'Upgrade: websocket' -H 'Connection: Upgrade' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Version: 13' \
  http://127.0.0.1:38995/ws/gated | head -3

kill $PID 2>/dev/null; wait $PID 2>/dev/null
rm -f /tmp/ws12.log /tmp/ws-smoke.ts /tmp/ws-proto.ts /tmp/build12.log
```

Expected:
- echo: `got=["hello"] closed=true`
- protocols: `protocol=chat.v1` (route declares chat.v2 first; client requests chat.v1; first match in route order is chat.v2 which client didn't request; second is chat.v1 which client did → chat.v1)

  **Wait — re-read the spec.** Spec says "first match in route order wins". Route order: chat.v2, chat.v1. Client requests chat.v0, chat.v1. Iterate route order: chat.v2 not in client list → skip; chat.v1 in client list → pick. So `protocol=chat.v1`. ✓

- gated no cookie: `HTTP/1.1 401 Unauthorized`

If any check fails, STOP and diagnose. Common causes:
- WS connection hangs → signalOpen 101 path not reaching Rust (check `napiWsSignalOpen` import name)
- Echo doesn't echo → on_message not firing (check `napiWsRegisterHandlers` succeeded; check tsfn call arity)
- Subprotocol always empty → pickSubprotocol logic OR signalOpen subprotocol arg position wrong

- [ ] **Step 3: Regression test**

```bash
cargo test --lib 2>&1 | tail -3            # 73 pass
cd runtime && bun test 2>&1 | tail -3      # 87+ pass (81 SSE-era + 6 new from Task 9)
cd .. && bun test ./tests/integration.test.ts 2>&1 | tail -3   # 56 pass
```

- [ ] **Step 4: Commit**

```bash
git add runtime/routes.ts
git commit -m "feat(runtime): wire wsBranch → handleWsConn end-to-end

Replaces the Task 8 stub. wsBranch now:
1. Coerces conn_id (JSON.parse number → BigInt) — same fix as
   sseBranch Task 12; native binding requires BigInt
2. Finds matching FlatRoute by literal fullPath (Rust gates dispatch)
3. Builds napi shim around 4 napiWs* fns (send, close, signalOpen,
   registerHandlers); signalOpen wraps body in Buffer
4. Injects NEVER_ABORTS into req for middleware
5. Runs middleware chain with a 101 placeholder terminal
6. On verdict >=400: signalOpen the error + return (Rust writes a
   regular HTTP response with the body)
7. On 101: hands off to handleWsConn which signals open with the
   chosen subprotocol, registers handlers, fires open hook

Smoke verified: /ws/echo round-trips 'hello'; /ws/protocols negotiates
chat.v1 (first match in route order against client list);
/ws/gated 401s without cookie.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: 7 integration tests at ports 38220-38226 (BRUST_WORKERS=1)

**Files:**
- Modify: `tests/integration.test.ts`

- [ ] **Step 1: Append helper + 7 tests**

```ts
// ----- WS integration tests -----

function makeWsClient(port: number, path: string, subprotocols?: string[]): { ws: WebSocket, opened: Promise<void>, closed: Promise<{ code: number, reason: string }>, messages: Promise<(string | ArrayBuffer)[]> } {
  const url = `ws://127.0.0.1:${port}${path}`
  const ws = subprotocols ? new WebSocket(url, subprotocols) : new WebSocket(url)
  let resolveOpen: () => void
  let resolveClose: (v: { code: number, reason: string }) => void
  let resolveMessages: (v: (string | ArrayBuffer)[]) => void
  const opened = new Promise<void>((r) => { resolveOpen = r })
  const closed = new Promise<{ code: number, reason: string }>((r) => { resolveClose = r })
  const msgs: (string | ArrayBuffer)[] = []
  const messages = new Promise<(string | ArrayBuffer)[]>((r) => { resolveMessages = r })
  ws.binaryType = 'arraybuffer'
  ws.onopen = () => { resolveOpen() }
  ws.onmessage = (e) => { msgs.push(e.data as string | ArrayBuffer) }
  ws.onclose = (e) => { resolveMessages(msgs); resolveClose({ code: e.code, reason: e.reason }) }
  ws.onerror = () => { /* swallow; close will fire */ }
  return { ws, opened, closed, messages }
}

const WS_ENV = (port: string) => ({
  ...process.env,
  BRUST_PORT: port,
  BRUST_WORKERS: '1',         // critical — colocate handler + probe action
  RUST_LOG: 'brust=warn',
})

test('ws: handshake + echo', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: WS_ENV('38220'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const c = makeWsClient(port, '/ws/echo')
    await c.opened
    c.ws.send('hello')
    await new Promise((r) => setTimeout(r, 200))
    c.ws.close()
    const got = await c.messages
    expect(got).toContain('hello')
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('ws: binary frame round-trip', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: WS_ENV('38221'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const c = makeWsClient(port, '/ws/echo')
    await c.opened
    c.ws.send(new Uint8Array([1, 2, 3]).buffer)
    await new Promise((r) => setTimeout(r, 200))
    c.ws.close()
    const got = await c.messages
    expect(got.length).toBeGreaterThan(0)
    expect(got[0]).toBeInstanceOf(ArrayBuffer)
    const bytes = new Uint8Array(got[0] as ArrayBuffer)
    expect(Array.from(bytes)).toEqual([1, 2, 3])
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('ws: server-initiated close fires client onclose with code 4000', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: WS_ENV('38222'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const c = makeWsClient(port, '/ws/server-close')
    const closed = await c.closed
    expect(closed.code).toBe(4000)
    expect(closed.reason).toBe('bye')
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('ws: middleware reject returns 401 + no upgrade', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: WS_ENV('38223'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    // Use raw fetch with WS Upgrade headers — the WebSocket constructor
    // won't surface a 401 body, but a manual HTTP probe will.
    const resp = await fetch(`http://127.0.0.1:${port}/ws/gated`, {
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    })
    expect(resp.status).toBe(401)
    expect(resp.headers.get('content-type') ?? '').not.toContain('websocket')
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('ws: middleware pass with cookie completes handshake + echo', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: WS_ENV('38224'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    // Bun's WebSocket constructor doesn't support custom headers directly,
    // but `new WebSocket(url, { headers: ... })` works on Bun >=1.0.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/gated`, { headers: { cookie: 'user=alice' } } as any)
    const got: string[] = []
    let closed = false
    ws.onopen = () => { ws.send('hi') }
    ws.onmessage = (e) => { got.push(e.data as string); ws.close() }
    ws.onclose = () => { closed = true }
    await new Promise((r) => setTimeout(r, 1500))
    expect(got).toContain('hi')
    expect(closed).toBe(true)
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('ws: subprotocol negotiation picks first match in route order', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: WS_ENV('38225'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    // route declares ['chat.v2', 'chat.v1']
    // client requests ['chat.v0', 'chat.v1']
    // first route entry in client list is chat.v1 → server picks chat.v1
    const c = makeWsClient(port, '/ws/protocols', ['chat.v0', 'chat.v1'])
    await c.opened
    expect(c.ws.protocol).toBe('chat.v1')
    c.ws.close()
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('ws: client clean close fires server on_close with 1000', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: WS_ENV('38226'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const c = makeWsClient(port, '/ws/echo')
    await c.opened
    c.ws.close()
    await new Promise((r) => setTimeout(r, 500))

    // BRUST_WORKERS=1 ensures the probe action lands on the same JS
    // context that ran the WS handler.
    const probe = await fetch(`http://127.0.0.1:${port}/_brust/action/lastWsClose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]',
    })
    expect(probe.status).toBe(200)
    const { code, reason } = await probe.json() as { code: number, reason: string }
    expect(code).toBe(1000)
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)
```

NOTE on test 5 (gated + cookie): Bun's WebSocket constructor may or may not accept a `headers` option. If it doesn't, fall back to using `Bun.connect` for the raw TCP upgrade (same approach used by SSE heartbeat test in `6792c61`) and assert manually. The cookie injection via headers is the cleanest path if supported.

NOTE on test 7: The probe action `lastWsClose` was added in Task 11 and records `globalThis.__lastWsClose` from the ws-echo handler's `close` callback. The on_close contract (Task 5) fires once on peer close — a clean `ws.close()` from the client yields code 1000.

- [ ] **Step 2: Run the 7 new tests in isolation**

```bash
bun test ./tests/integration.test.ts --test-name-pattern "ws:" 2>&1 | tail -15
```

Expected: 7 pass / 0 fail.

- [ ] **Step 3: Run the full suite**

```bash
bun test ./tests/integration.test.ts 2>&1 | tail -3
```

Expected: 63 pass / 0 fail (56 prior + 7 new).

- [ ] **Step 4: Commit**

```bash
git add tests/integration.test.ts
git commit -m "test(integration): 7 WS tests at ports 38220-38226 (BRUST_WORKERS=1)

- handshake + echo (text round-trip)
- binary frame round-trip (Uint8Array via arraybuffer binaryType)
- server-initiated close 4000 → client onclose.code=4000, reason='bye'
- middleware reject → 401 + non-WS content-type (via raw fetch with
  WS Upgrade headers; WebSocket constructor swallows the body)
- middleware pass with cookie → handshake + echo (headers via Bun's
  WebSocket headers option)
- subprotocol negotiation: route ['chat.v2','chat.v1'] ∩ client
  ['chat.v0','chat.v1'] → server picks chat.v1 (first in route order
  that appears in client list)
- client clean close → server on_close fires with 1000 (probe via
  lastWsClose action; BRUST_WORKERS=1 colocates handler + probe)

Total integration tests: 63.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: `architecture.md` update — promote Real-time:WebSockets to Built

**Files:**
- Modify: `architecture.md`

- [ ] **Step 1: Move WebSockets to Built**

Find the "Designed, not built" entry for WebSockets:

```
- Real-time: WebSockets (per-route upgrade) — SSE shipped, see Built list above
```

Replace with:

```
- (removed — both SSE and WebSockets shipped; see Built list above)
```

OR delete the line entirely (preferred — the parenthetical above is more noise than signal once both halves ship).

Find the Built list (where SSE entry was added in SSE Task 14). Append:

```
- Real-time: WebSockets (RFC 6455) — `Route.websocket: () => Promise<WsHandlers>` serves WS upgrades. Rust validates the handshake headers, dispatches a single long-lived tsfn call to a worker, runs middleware via the existing chain (returns 4xx OR 101 + chosen subprotocol via `napiWsSignalOpen`), then on 101 writes the manual handshake response (Sec-WebSocket-Accept + optional Sec-WebSocket-Protocol) and wraps the TCP stream with `tokio_tungstenite::WebSocketStream::from_raw_socket(Role::Server)`. Per-conn task runs a `tokio::select!` over outgoing sends (JS-pushed via mpsc, ack via oneshot for backpressure), incoming frames (Text → string, Binary → Uint8Array), and a ping ticker (default 30s; 2× window pong timeout closes with 1011). Author surface: `WsHandlers { open, message, close }` + `WsSocket { send, close, id }`. `on_close` fires exactly once for peer/timeout/error/oversize closes; author-initiated `socket.close` skips it. Subprotocol negotiation picks the first route-declared protocol that appears in the client's list. Boot wiring: `brust.registerWsPaths(routes.filter(.websocket).map(.fullPath))`. Two new Rust deps: `tokio-tungstenite` 0.21 (default-features=false) for frame parsing + `sha1` for Sec-WebSocket-Accept. MVP supports literal WS paths only; parameterized routes (`/ws/chat/{room}`), pub/sub broadcast, `permessage-deflate`, client-mode WS, and TLS termination are deferred.
```

- [ ] **Step 2: Commit**

```bash
git add architecture.md
git commit -m "docs(architecture): WebSocket shipped — promote to Built list

Real-time Tier-2 feature is now complete (SSE + WS). Documents the
single long-lived tsfn dispatch shape, manual handshake response with
optional Sec-WebSocket-Protocol, tokio-tungstenite frame loop, ping/pong
defaults, on_close exactly-once contract, subprotocol negotiation, boot
wiring, and the new tokio-tungstenite + sha1 deps. MVP limitations
(literal paths only, no pub/sub, no compression, server-only, no TLS)
documented as deferred.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Spec coverage check (self-review)

| Spec § | Implementing tasks |
|---|---|
| §1 success criterion 1 (websocat echo) | 5, 9, 11, 12, 13 test 1 |
| §1 success criterion 2 (binary round-trip) | 5, 9, 12, 13 test 2 |
| §1 success criterion 3 (server close 4000) | 5, 9, 11, 12, 13 test 3 |
| §1 success criterion 4 (mw reject 401) | 6, 8, 9, 12, 13 test 4 |
| §1 success criterion 5 (mw pass + echo) | 6, 8, 9, 12, 13 test 5 |
| §1 success criterion 6 (subprotocol negotiation) | 9, 12, 13 test 6 |
| §1 success criterion 7 (client clean close → 1000) | 5, 9, 11, 12, 13 test 7 |
| §1 success criterion 8 (no regression) | every task runs full suite |
| §2 Architecture | 3, 5, 6 |
| §3 Module layout | 1-14 (file map matches) |
| §4 Author API | 8 (route + interfaces), 9 (WsSocketImpl + handlers wiring) |
| §4 validation rules | 8 (impl), 10 (tests) |
| §5 Wire format (WsEnvelope) | 2 |
| §5 NAPI fns | 4 |
| §5 Per-conn task | 5 |
| §5 Server-side dispatch | 6, 7 |
| §6 Disconnect detection matrix | 5 |
| §6 on_close exactly-once | 5 (close_fired flag), 9 (test) |
| §6 handler exceptions | 5 (Rust side), 9 (JS message-throw resilience test) |
| §6 WsSocket impl | 9 |
| §7 Limits | 5 (defaults: ping/max msg), 9 (reason cap) |
| §8 Testing (8 Rust + 6 runtime + 7 integration) | 2, 3, 9, 10, 13 |

All §1-§8 spec requirements map to at least one task.

## Type / name consistency check

| Identifier | Defined in task | Used in tasks |
|---|---|---|
| `WsEnvelope` | 2 | 6 |
| `build_ws_envelope` | 2 | 6 |
| `next_conn_id` (reused from sse) | (sse Task 2) | 3 test, 6 |
| `WsFrameKind { Text/Binary/Close }` | 3 | 4, 5 |
| `WsOutgoing { frame, ack }` | 3 | 4, 5 |
| `WsOpenSignal { status, body, content_type, subprotocol }` | 3 | 4, 5 |
| `WsConn { send_tx, open_tx, on_message, on_close }` | 3 | 4, 5, 6 |
| `parse_ws_handshake` / `HandshakeError` / `ParsedHandshake` | 3 | 6 |
| `compute_sec_accept` | 3 | 6 |
| `WS_PATHS` / `register_ws_path` / `path_is_ws` | 3 | 4, 6 |
| `ws_conn_task` | 5 | 6 |
| `fire_on_message` / `fire_on_close` | 5 | (internal to ws.rs) |
| `napi_ws_signal_open` / `_send` / `_close` / `_register_handlers` / `napi_register_ws_paths` | 4 | 6, 8, 9 |
| `dispatch_ws` | 7 | 6 (refactored from inline) |
| `Route.websocket` / `Route.wsOptions` | 8 | 9, 10, 11, 12 |
| `WsHandlers` / `WsSocket` interfaces | 8 | 9, 11, 12 |
| `RouteCall 'ws' { conn_id: bigint, client_subprotocols, req }` | 8 | 9, 12 |
| `wsBranch` | 8 (stub), 12 (real) | 9 |
| `handleWsConn` | 9 | 12 |
| `WsSocketImpl` | 9 | (private to handler.ts) |
| `pickSubprotocol(clientList, routeList)` | 9 | 12 (via handler), 13 test 6 |
| `WsNapi` interface | 9 | 12 |
| `lastWsClose` action | 11 | 13 test 7 |
| `brust.registerWsPaths` | 11 | (called from example) |

All cross-references resolved.

---

**Total: 14 tasks; ~16-18 hours engineering; 8 Rust unit + 6 runtime unit + 7 integration = 21 new tests → 221 total.**
