# WebSocket (RFC 6455) — Design

**Status:** Spec ready · execution pending plan
**Scope:** Brust gains a `Route.websocket: () => Promise<WsHandlers>` field. Rust accepts the HTTP/1.1 Upgrade, runs middleware via the existing dispatch pipeline, completes the handshake via `tokio-tungstenite`, and pumps frames over an out-of-band NAPI channel. Pub/sub broadcast is out of scope — designed jointly with SSE's deferred pub/sub.
**Tier-2 line item:** Real-time (WebSockets + SSE) — this spec completes the WebSocket half. SSE already shipped (see `2026-05-25-sse-design.md`).
**Predecessor design hints:** `architecture.md` lines 706-751 (kept informal; this spec is the formal commitment).

---

## 1. Goal & success criteria

Authors mount a WebSocket route by setting one field on a `Route`:

```ts
{
  path: '/ws/chat',
  websocket: () => import('./ws/chat'),
  wsOptions: { pingMs: 30_000, maxMessageBytes: 1024 * 1024, subprotocols: ['chat.v2'] },
}
```

The handler module exports an object with `open`/`message`/`close` callbacks plus a `WsSocket` handle for sending.

**Success criteria (must hold after the final task of the implementation plan):**

1. `websocat ws://127.0.0.1:PORT/ws/echo` round-trips a text message; conn closes when client exits.
2. Binary frame round-trip via a Bun WebSocket client — `Uint8Array([1,2,3])` arrives intact and reads as `instanceof ArrayBuffer` on the receiver.
3. Server-initiated `socket.close(4000, 'bye')` propagates to client's `onclose` with `code:4000, reason:'bye'`.
4. Middleware-gated route returns 401 + non-WS content-type when called without credentials; no 101 sent.
5. Same route with `cookie: user=alice` completes the 101 handshake and echo works.
6. Subprotocol negotiation: route declares `['chat.v2','chat.v1']`, client requests `['chat.v0','chat.v1']`, server picks `chat.v1` and reflects it in `Sec-WebSocket-Protocol`.
7. Client-side clean `ws.close()` fires server-side `on_close` with `code:1000`.
8. No regression: 200 existing tests still pass.

## 2. Architecture

Three layers; one new directory under `runtime/`; one new Rust dep.

```
Browser                         Rust (tokio)                         Worker JS (Bun)
────────                        ────────────                         ──────────────
GET /ws/chat            ───→ accept conn
Upgrade: websocket           validate (GET + Upgrade + Sec-WebSocket-Key + Version: 13)
Sec-WebSocket-Key: …         path_is_ws(&path) gate (registry from boot)
                             assign conn_id (AtomicU64; shared with SSE)
                             dispatch_ws_open(envelope, conn_id) ──→ resolve Route
                                                                     run middleware chain
                                                                     match client_subprotocols ∩ route.wsOptions.subprotocols
                             ← open verdict (oneshot) ──────────── ← napi_ws_signal_open(101|4xx, body, ct, chosen_subprotocol)
                             if 4xx → write regular HTTP error response + close
                             else → tokio_tungstenite::accept_async with manual handshake
                                    response (101 + Sec-WebSocket-Accept + chosen subprotocol)
                             spawn ws_conn_task                    ── napi_ws_register_handlers(conn_id, onMessage, onClose)
                                ↓                                      author's open(socket, ctx) fires
                             tokio::select! {
                               Some(out) = send_rx.recv() => ws_sink.send(out)
                               Some(msg) = ws_stream.next() => dispatch_msg(conn_id, msg)
                               _ = ping_tick => ws_sink.send(Ping); if pong_timeout → close
                             }
                             napi_ws_on_message(conn_id, data, is_binary) ─→ author's message(socket, data)
                             napi_ws_on_close(conn_id, code, reason)     ─→ author's close(socket, code, reason)
                             napi_ws_send(conn_id, data, is_binary)     ←── socket.send(data) — enqueues into send_tx,
                                                                              Promise resolves after TCP write ack
```

**Connection identity:** `conn_id: u64`, monotonic per server, assigned by Rust via the same `NEXT_CONN_ID` counter used by SSE (no collision risk — separate REGISTRY tables).

**Worker assignment:** WS conn pins to the worker chosen at `dispatch_ws_open` time. JS event loop multiplexes many WS conns + render + action + SSE on that worker. `pool::pick_least_busy` picks once at handshake; `in_flight_guard` releases right after the dispatch enqueue (not for the connection lifetime — same fix applied to SSE in `d389c77`).

**Open contract:** middleware can reject AFTER dispatch begins but BEFORE the 101 response is written. Single dispatch carries the verdict back through `napi_ws_signal_open` so Rust knows whether to write a 101 + handshake or a regular 4xx response. The subprotocol negotiation also flows through this signal — JS picks the chosen subprotocol from the client's list intersected with `wsOptions.subprotocols`.

## 3. Module layout

```
brust/
├── Cargo.toml             # +tokio-tungstenite = "0.21" (only new dep)
├── src/
│   ├── routes.rs          # +WsEnvelope, +build_ws_envelope, +tests
│   ├── server.rs          # +WS branch in handle_conn (Upgrade detect → ws::handshake_and_dispatch)
│   ├── ws.rs              # NEW: REGISTRY, WsConn, WsOpenSignal, WsOutgoing, ws_conn_task,
│   │                      #      parse_ws_handshake, WS_PATHS, register_ws_path, path_is_ws
│   ├── lib.rs             # +pub mod ws; +napi_ws_send/close/signal_open/register_handlers/register_ws_paths
│   └── pool.rs            # +dispatch_ws (clone of dispatch_sse — fire-and-forget tsfn call)
├── runtime/
│   ├── routes.ts          # +Route.websocket, +Route.wsOptions, +RouteCall 'ws' variant,
│   │                      #  +wsBranch, +defineRoutes validation rejecting ws + Component/loader/sse/children
│   ├── ws/
│   │   ├── handler.ts     # NEW: glue — middleware compose, subprotocol pick, signalOpen,
│   │   │                  #      WsSocket impl (send/close), per-conn handler dispatch
│   │   └── handler.test.ts # NEW: 6 unit tests
│   └── index.ts           # +brust.registerWsPaths(paths)
├── example/hello-world/
│   ├── ws-echo.ts         # NEW: { message(s, d) { s.send(d) }, close: records globalThis.__lastWsClose }
│   ├── ws-server-close.ts # NEW: { open(s) { s.close(4000, 'bye') } } — for test 3
│   ├── routes.tsx         # +/ws/echo, /ws/gated, /ws/server-close, /ws/protocols
│   ├── actions.ts         # +lastWsClose() probe action
│   └── index.ts           # +brust.registerWsPaths(routes.filter(.websocket).map(.fullPath))
├── tests/
│   └── integration.test.ts # +7 WS tests at ports 38220-38226 (BRUST_WORKERS:'1')
└── architecture.md        # promote "Real-time: WebSockets" entry from Designed → Built
```

**`Cargo.toml` additions:**
```toml
tokio-tungstenite = { version = "0.21", default-features = false }
sha1              = "0.10"
```
- `tokio-tungstenite`: no TLS / native-tls features needed (TLS termination is out of scope per session 6 deferred list). Pulls in `tungstenite` as a transitive (RFC 6455 frame parser).
- `sha1`: needed for the `Sec-WebSocket-Accept` derivation (RFC 6455 §1.3). `base64` is already present at `Cargo.toml:23` (added during Forms work).

## 4. Author API

```ts
// runtime/routes.ts — Route gains:
export interface Route {
  // existing fields unchanged
  // ...
  /** When set, this route accepts WebSocket upgrades. Cannot coexist with
   * Component, loader, sse, or children (validated at defineRoutes time).
   * The factory is invoked lazily — once per worker boot for the first
   * connection (and cached). The handler module exports WsHandlers. */
  websocket?: () => Promise<WsHandlers>
  wsOptions?: {
    /** Server-initiated ping interval in ms. Default 30000. Set 0 to disable.
     * Pong timeout = 2× pingMs; conn closes with code 1011 if no pong by then. */
    pingMs?: number
    /** Max message size in bytes. Default 1 048 576 (1 MB). Larger frames
     * close the conn with 1009 (Message Too Big). */
    maxMessageBytes?: number
    /** Subprotocols the route supports (Sec-WebSocket-Protocol). If the
     * client requests one of these, the server picks the first match in
     * the route's declared order. If the client requests subprotocols
     * and none match, the conn is rejected with 426 (Upgrade Required). */
    subprotocols?: string[]
  }
}

/** Handler module shape — what `() => Promise<WsHandlers>` resolves to.
 *  Note: open/message/close are all OPTIONAL — a no-op WebSocket
 *  (handshake only) is a valid use case (e.g. liveness probe). */
export interface WsHandlers {
  /** Called once after the 101 handshake completes. Use this to record
   * the socket in your in-memory map, send a hello frame, etc.
   * Throwing here closes the conn with 1011 (Internal Error); on_close
   * does NOT fire (we never reached steady state). */
  open?: (socket: WsSocket, ctx: { req: BrustRequest; subprotocol: string | null }) => void | Promise<void>
  /** Called per incoming message frame. data is string for Text frames,
   * Uint8Array for Binary. Throwing here is logged but the conn stays
   * open — one bad message shouldn't kill the conn; wrap in try/catch
   * for strict-close semantics. */
  message?: (socket: WsSocket, data: string | Uint8Array) => void | Promise<void>
  /** Called exactly ONCE when the conn closes EXCEPT when the author
   * called socket.close themselves. Code/reason from the RFC 6455
   * close frame; 1006 for abnormal (RST), 1011 for pong timeout,
   * 1001 for server shutdown. */
  close?: (socket: WsSocket, code: number, reason: string) => void
}

/** The only handle the author touches. */
export interface WsSocket {
  /** Send a frame. Text if data is string, Binary if Uint8Array. Returns
   * a Promise that resolves when the TCP write completes (cooperative
   * backpressure, same model as SSE napi.write). Rejects with a clear
   * error if the conn is already closed. */
  send(data: string | Uint8Array): Promise<void>
  /** Initiate close with optional code (default 1000) and reason (default
   * ''). Idempotent — second call is a no-op. on_close does NOT fire
   * after this call. */
  close(code?: number, reason?: string): void
  /** Stable per-conn identifier. Useful as a Map key in author's
   * in-memory connection registry. */
  readonly id: bigint
}
```

### Validation rules (enforced by `defineRoutes` synchronously, throws Error)

| Combination | Allowed? |
|---|---|
| `websocket` alone | ✅ |
| `websocket` + `middleware` | ✅ (middleware runs pre-upgrade) |
| `websocket` + `wsOptions` | ✅ |
| `websocket` + `Component` | ❌ throw: `"Route /ws/chat: 'websocket' cannot coexist with 'Component'"` |
| `websocket` + `loader` | ❌ |
| `websocket` + `sse` | ❌ throw: `"Route /ws/chat: 'websocket' cannot coexist with 'sse'"` |
| `websocket` + `children` | ❌ |

### Author example (single-room fan-out, no built-in pub/sub)

```ts
// app/ws/chat.ts
import type { WsHandlers, WsSocket } from 'brust/runtime'

const room = new Map<bigint, WsSocket>()

export default {
  open(socket) {
    room.set(socket.id, socket)
    void socket.send(`welcome ${socket.id}`)
  },
  async message(socket, data) {
    if (typeof data !== 'string') return socket.close(1003, 'text only')
    const payload = `${socket.id}: ${data}`
    for (const s of room.values()) {
      void s.send(payload)
    }
  },
  close(socket) {
    room.delete(socket.id)
  },
} satisfies WsHandlers
```

### Auth example — reuse existing middleware

```ts
{ path: '/ws/private', middleware: [authRequired], websocket: () => import('./ws/private') },
```

If `authRequired` returns 401, Rust writes the 401 HTTP response and never sends 101 — the client's `new WebSocket(...)` errors with "Connection failed".

## 5. Wire format & NAPI bridge

### WsEnvelope (Rust → JS, kind variant #5)

```rust
// src/routes.rs
#[derive(Serialize)]
pub struct WsEnvelope {
    pub kind: &'static str,        // "ws"
    pub conn_id: u64,              // Rust-assigned monotonic (shared NEXT_CONN_ID)
    /// Subprotocols the client requested (Sec-WebSocket-Protocol value,
    /// comma-split + trimmed). JS picks the first that matches the route's
    /// wsOptions.subprotocols and signals back via napi_ws_signal_open.
    pub client_subprotocols: Vec<String>,
    pub req: RequestEnvelope,
}
pub fn build_ws_envelope(
    method: &str, full_path: &str, raw_request: &[u8],
    conn_id: u64, client_subprotocols: Vec<String>
) -> String { ... }
```

JS RouteCall union gains:
```ts
| {
    kind: 'ws'
    conn_id: bigint
    client_subprotocols: string[]
    req: BrustRequest
  }
```

### NAPI fns (5 new, all in `src/lib.rs` alongside `napi_sse_*`)

```rust
/// JS reports middleware verdict + chosen subprotocol. Single-shot;
/// second call is no-op.
napi_ws_signal_open(
    conn_id: BigInt, status: u32,
    body: Buffer, content_type: String,
    subprotocol: String,       // "" if no subprotocol negotiated
)

/// Send one frame. is_binary=false → Text frame, true → Binary.
/// Returns Promise<()> that resolves when the TCP write completes.
napi_ws_send(conn_id: BigInt, data: Buffer, is_binary: bool) -> Promise<()>

/// Initiate close. code defaults to 1000; reason capped at 123 bytes (RFC 6455).
/// Idempotent. Triggers a Close frame send; ws_conn_task exits after wire write.
napi_ws_close(conn_id: BigInt, code: u32, reason: String)

/// JS registers per-conn callbacks. Each is a tsfn that ws_conn_task
/// invokes. Single-shot registration (second call replaces).
napi_ws_register_handlers(
    conn_id: BigInt,
    on_message: Function<(Buffer, bool), ()>,  // (data, is_binary)
    on_close: Function<(u32, String), ()>,     // (code, reason)
)

/// Boot-time registry of literal WS paths. Same pattern as napi_register_sse_paths.
napi_register_ws_paths(paths: Vec<String>) -> ()
```

### Rust per-connection bookkeeping (`src/ws.rs`)

```rust
pub struct WsConn {
    /// JS → Rust send queue. Bounded at 32 frames for backpressure.
    pub send_tx: mpsc::Sender<WsOutgoing>,
    /// Middleware verdict + subprotocol. Single-shot.
    pub open_tx: Option<oneshot::Sender<WsOpenSignal>>,
    /// Handler tsfns set by napi_ws_register_handlers.
    pub on_message: Option<ThreadsafeFunction<(Vec<u8>, bool)>>,
    pub on_close: Option<ThreadsafeFunction<(u16, String)>>,
}

pub enum WsFrameKind {
    Text(String),
    Binary(Vec<u8>),
    Close(u16, String),
}

pub struct WsOutgoing {
    pub frame: WsFrameKind,
    pub ack: oneshot::Sender<()>,
}

pub struct WsOpenSignal {
    pub status: u16,
    pub body: Vec<u8>,           // 4xx body for rejection; empty on 101
    pub content_type: String,    // for 4xx response
    pub subprotocol: String,     // for 101 response; "" if none
}

pub type Registry = Mutex<HashMap<u64, WsConn>>;
static REGISTRY: OnceLock<Registry> = OnceLock::new();
pub fn registry() -> &'static Registry { REGISTRY.get_or_init(...) }

static WS_PATHS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
pub fn register_ws_path(p: String) { ... }
pub fn path_is_ws(p: &str) -> bool { ... }
```

### Per-conn task loop (`ws_conn_task`)

```rust
async fn ws_conn_task(
    ws: WebSocketStream<TcpStream>,
    conn_id: u64,
    mut send_rx: mpsc::Receiver<WsOutgoing>,
    ping_interval_ms: u64,
    max_msg_bytes: usize,
) {
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{Message, protocol::CloseFrame};

    let (mut ws_sink, mut ws_stream) = ws.split();
    let mut ping_tick = tokio::time::interval(Duration::from_millis(ping_interval_ms.max(1)));
    let mut last_pong = Instant::now();
    let pong_timeout = Duration::from_millis(ping_interval_ms.saturating_mul(2));
    let mut close_fired = false;

    loop {
        tokio::select! {
            Some(out) = send_rx.recv() => {
                let msg = match out.frame {
                    WsFrameKind::Text(s) => Message::Text(s.into()),
                    WsFrameKind::Binary(b) => Message::Binary(b.into()),
                    WsFrameKind::Close(c, r) => Message::Close(Some(CloseFrame {
                        code: c.into(), reason: r.into()
                    })),
                };
                let is_close = matches!(msg, Message::Close(_));
                if ws_sink.send(msg).await.is_err() { break; }
                let _ = out.ack.send(());
                if is_close { break; }   // Author-initiated close; on_close skipped
            }
            Some(msg) = ws_stream.next() => {
                let msg = match msg {
                    Ok(m) => m,
                    Err(_) => {
                        if !close_fired { fire_on_close(conn_id, 1006, "abnormal closure".into()); close_fired = true; }
                        break;
                    }
                };
                match msg {
                    Message::Text(s) => {
                        if s.len() > max_msg_bytes {
                            send_close_and_break(&mut ws_sink, 1009, "message too big").await;
                            if !close_fired { fire_on_close(conn_id, 1009, "message too big".into()); }
                            break;
                        }
                        fire_on_message(conn_id, s.into_bytes(), false);
                    }
                    Message::Binary(b) => {
                        if b.len() > max_msg_bytes {
                            send_close_and_break(&mut ws_sink, 1009, "message too big").await;
                            if !close_fired { fire_on_close(conn_id, 1009, "message too big".into()); }
                            break;
                        }
                        fire_on_message(conn_id, b.into(), true);
                    }
                    Message::Ping(p) => { let _ = ws_sink.send(Message::Pong(p)).await; }
                    Message::Pong(_) => { last_pong = Instant::now(); }
                    Message::Close(cf) => {
                        let code = cf.as_ref().map_or(1005, |c| c.code.into());
                        let reason = cf.map_or(String::new(), |c| c.reason.into_owned());
                        if !close_fired { fire_on_close(conn_id, code, reason); close_fired = true; }
                        break;
                    }
                    _ => {}   // continuation frames assembled by tungstenite
                }
            }
            _ = ping_tick.tick() => {
                if ping_interval_ms > 0 && last_pong.elapsed() > pong_timeout {
                    if !close_fired { fire_on_close(conn_id, 1011, "pong timeout".into()); close_fired = true; }
                    let _ = ws_sink.send(Message::Close(Some(CloseFrame {
                        code: 1011.into(), reason: "pong timeout".into(),
                    }))).await;
                    break;
                }
                if ping_interval_ms > 0 {
                    let _ = ws_sink.send(Message::Ping(Bytes::new())).await;
                }
            }
        }
    }

    let _ = ws_sink.close().await;
    registry().lock().remove(&conn_id);
}
```

`fire_on_message` / `fire_on_close` look up `REGISTRY[conn_id].on_message` / `on_close` and invoke the tsfn (non-blocking).

### Server-side dispatch flow

1. Rust accepts TCP, parses request headers.
2. `path_is_ws(&path)` → enter WS branch (placed BEFORE render dispatch in `handle_conn`, after `/_brust/*` and SSE branches).
3. Validate: method == GET; `Upgrade` header contains `websocket`; `Connection` contains `Upgrade`; `Sec-WebSocket-Key` present; `Sec-WebSocket-Version == 13`. Wrong → 400 / 426.
4. Extract `client_subprotocols` from `Sec-WebSocket-Protocol` (comma-split, trim).
5. Assign `conn_id = next_conn_id()`, create `mpsc::channel(32)` + `oneshot::channel`, register `WsConn` in REGISTRY.
6. `crate::pool::dispatch_ws(entry, envelope_json, conn_id)` — fire-and-forget tsfn call.
7. Await `open_rx` with 30 s timeout. Distinguish `Ok(Err(_))` (JS crashed) from `Err(_)` (timeout); both → 500 + close, but logged differently.
8. If `verdict.status >= 400`: write regular HTTP response with body/content_type/Connection:close. Drop conn.
9. If `verdict.status == 101`: build handshake response (`HTTP/1.1 101 Switching Protocols`, `Upgrade: websocket`, `Connection: Upgrade`, `Sec-WebSocket-Accept: <base64 sha1>`, `Sec-WebSocket-Protocol: <chosen>` if non-empty). Write headers, wrap stream with `tokio_tungstenite::WebSocketStream::from_raw_socket(stream, Role::Server, None)`, spawn `ws_conn_task`.
10. JS glue calls `napi_ws_register_handlers(conn_id, onMessage, onClose)`. Author's `open(socket, ctx)` fires.

**`Sec-WebSocket-Accept` derivation:** `base64(SHA1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))` per RFC 6455 §1.3. `base64` is at `Cargo.toml:23`; `sha1` is added by this work (see §3 Cargo.toml additions above).

## 6. Lifecycle & error paths

### Disconnect detection matrix

| Trigger | Detection point | Cleanup chain |
|---|---|---|
| Peer Close frame | `ws_stream` yields `Message::Close(cf)` | `fire_on_close(code, reason)` → break loop → `ws_sink.close()` → REGISTRY.remove → drop send_rx → in-flight `napi_ws_send` Promises reject |
| Peer TCP RST | `ws_stream` yields `Err` | `fire_on_close(1006, "abnormal closure")` → same chain |
| Pong timeout (last_pong.elapsed() > 2× pingMs) | `ping_tick` arm | `fire_on_close(1011, "pong timeout")` → send Close frame → break |
| Server initiated (`socket.close(code, reason)`) | JS → `napi_ws_close` → enqueues Close into send_tx → ws_sink writes | `is_close` flag breaks loop → REGISTRY.remove. **`on_close` NOT fired** (author initiated) |
| Message > maxMessageBytes | size check in incoming arm | `fire_on_close(1009, "message too big")` → send Close → break |
| Server graceful shutdown (SIGINT) | Brust shutdown drops REGISTRY entries OR a `shutdown` signal cascades into each task | each task: `fire_on_close(1001, "going away")` + send Close + exit |
| Send queue full (32 frames buffered) | JS-side: `napi_ws_send` Promise blocks until `mpsc::Sender::send` accepts | Cooperative backpressure — author's `await socket.send(...)` waits |

### `on_close` exactly-once guarantee

Tracked by `close_fired: bool` in `ws_conn_task`. First eligible trigger sets it true; subsequent eligible triggers skip the fire but still proceed with cleanup. Author-initiated close NEVER sets close_fired (it skips the on_close call entirely).

### Handler-thrown exceptions

- `open` throws → log + send Close(1011, "internal error") → REGISTRY.remove. `on_close` NOT fired (never reached steady state).
- `message` throws → log + continue. Conn stays open. (Strict-close semantics: author wraps in try/catch.)
- `close` throws → log; cleanup proceeds. No retry.

### `WsSocket` impl in JS glue

```ts
class WsSocketImpl implements WsSocket {
  constructor(public readonly id: bigint, private napi: WsNapi, private closed: { v: boolean }) {}
  async send(data: string | Uint8Array): Promise<void> {
    if (this.closed.v) throw new Error(`ws conn ${this.id}: already closed`)
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    const isBinary = typeof data !== 'string'
    await this.napi.send(this.id, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), isBinary)
  }
  close(code: number = 1000, reason: string = ''): void {
    if (this.closed.v) return
    this.closed.v = true
    this.napi.close(this.id, code, reason.slice(0, 123))   // RFC 6455 reason cap
  }
}
```

The `closed: { v: boolean }` box is mutated by the glue when `on_close` fires (so subsequent send calls reject cleanly).

## 7. Limits & out-of-scope

| Limit | Default | Configurable | Notes |
|---|---|---|---|
| Max concurrent WS conns per server | none | — | OS fd limit + reverse proxy gate |
| Per-conn send queue depth | 32 frames | hard-coded MVP | Backpressure via `napi_ws_send` Promise |
| Ping interval | 30 000 ms | `wsOptions.pingMs` per route | 0 disables (no pong-timeout detection) |
| Pong timeout | 2× pingMs | derived | Hard multiplier; 1011 + close if exceeded |
| Max message bytes | 1 048 576 (1 MB) | `wsOptions.maxMessageBytes` per route | Larger → 1009 + close |
| Subprotocols | none (empty) | `wsOptions.subprotocols` per route | First-match wins |
| Close reason byte cap | 123 (RFC 6455) | hard | Author-provided reason truncated silently |
| Open signal timeout | 30 000 ms | hard | Same as SSE; distinguishes sender-dropped vs timeout in logs |
| tsfn handles for handler callbacks | 2 per conn (on_message + on_close) | — | Bun pool cap untested at 10k+ conns |

**Out of scope for MVP** (documented as limitations):

- Per-IP rate limiting on WS connection counts
- `permessage-deflate` compression extension (proxy-fragile; defer)
- Built-in pub/sub broadcast — author builds via socket map (see §4 example). Will be designed jointly with the future SSE+WS shared pub/sub primitive.
- Cross-process / cross-instance fan-out (Redis adapter etc.)
- Fragmented message frames > 16 MB (tungstenite default cap; raising requires explicit config)
- Client-mode WebSocket (outbound conns from Brust as a client) — server only
- Per-route metrics endpoint (`GET /_brust/ws/stats`) — easy follow-up
- TLS termination — out of scope per session 6 deferred list

## 8. Testing

| Layer | Coverage | Count | Location |
|---|---|---|---|
| Rust unit | `WsEnvelope` serde + `build_ws_envelope`; REGISTRY insert/remove; conn_id shared with SSE (verify no collision) | 3 | `src/routes.rs`, `src/ws.rs` `#[cfg(test)]` |
| Rust unit | `parse_ws_handshake` — extracts Sec-WebSocket-Key, version, subprotocols; rejects missing/bad headers | 4 | `src/ws.rs` |
| Rust unit | `WS_PATHS` register/lookup | 1 | `src/ws.rs` |
| Runtime unit | Glue — middleware compose + signalOpen, open/message/close handler dispatch, subprotocol negotiation, socket.send proxies napi, socket.close enqueues close frame, message-handler-throws logged not rethrown | 6 | `runtime/ws/handler.test.ts` |
| Integration | 7 tests at ports 38220-38226, all `BRUST_WORKERS: '1'` | 7 | `tests/integration.test.ts` |

**Integration test worker setup (important):** every WS integration test MUST spawn with `BRUST_WORKERS: '1'`. The `lastWsClose` probe action lands on the same JS context as the WS handler only when `pool.pick_least_busy` has one choice. Same convention as SSE Task 13.

### Seven integration tests

1. `ws: handshake + echo` — connect `/ws/echo`, send "hello", receive "hello".
2. `ws: binary frame round-trip` — send `Uint8Array([1,2,3])`, receive same bytes.
3. `ws: server-initiated close 4000` — open `/ws/server-close`, client receives `code:4000, reason:'bye'`.
4. `ws: middleware reject returns 401 + no upgrade` — probe `/ws/gated` with HTTP `Upgrade: websocket` headers via `fetch`; expect 401, non-WS content-type.
5. `ws: middleware pass with cookie completes handshake + echo` — same route with `cookie: user=alice`; WebSocket opens; echo works.
6. `ws: subprotocol negotiation picks first match` — route declares `['chat.v2','chat.v1']`; client requests `['chat.v0','chat.v1']`; `WebSocket.protocol === 'chat.v1'`.
7. `ws: client clean close fires on_close with 1000` — open, `ws.close()` cleanly, wait 500 ms, probe `lastWsClose` action returns `code:1000`.

**Heartbeat is unit-tested only** (pingMs=50 in a runtime test) — same rationale as SSE: 30 s wait per test inflates CI.

**Test totals after ship:** 71 Rust unit (63 + 8) + 87 runtime unit (81 + 6) + 63 integration (56 + 7) = **221 tests** (vs. 200 today).

### Example app additions

```ts
// example/hello-world/ws-echo.ts (new)
import type { WsHandlers } from '../../runtime/routes.ts'

export default {
  message(socket, data) {
    void socket.send(data)
  },
  close(_socket, code, reason) {
    ;(globalThis as { __lastWsClose?: { code: number, reason: string } }).__lastWsClose = { code, reason }
  },
} satisfies WsHandlers
```

```ts
// example/hello-world/ws-server-close.ts (new)
import type { WsHandlers } from '../../runtime/routes.ts'

export default {
  open(socket) {
    socket.close(4000, 'bye')
  },
} satisfies WsHandlers
```

```ts
// example/hello-world/routes.tsx — append
{ path: '/ws/echo',          websocket: () => import('./ws-echo.ts') },
{ path: '/ws/gated',         middleware: [authRequired], websocket: () => import('./ws-echo.ts') },
{ path: '/ws/server-close',  websocket: () => import('./ws-server-close.ts') },
{ path: '/ws/protocols',     websocket: () => import('./ws-echo.ts'),
  wsOptions: { subprotocols: ['chat.v2', 'chat.v1'] } },
```

```ts
// example/hello-world/actions.ts — append (probe for test 7)
export async function lastWsClose() {
  return (globalThis as { __lastWsClose?: { code: number, reason: string } }).__lastWsClose ?? { code: 0, reason: '' }
}
```

### Manual smoke (gate for the final implementation task)

```bash
BRUST_PORT=38990 BRUST_WORKERS=1 bun run example/hello-world/index.ts &
sleep 5
echo 'hello' | websocat ws://127.0.0.1:38990/ws/echo
# Expected: 'hello' echoed back, conn closes when websocat exits
kill %1
```

### Stretch (not gating)

- 1000-conn capacity stress (`bench/ws-capacity.ts` follow-up)
- Cross-worker fairness once pub/sub lands

## 9. Open questions resolved during brainstorming

- Frame parser → `tokio-tungstenite` (battle-tested, integrates with tokio, RFC 6455 complete)
- Worker model → pin per conn at handshake; multiplex across conns within worker via JS event loop (same as SSE)
- Pub/sub → out of scope; designed jointly with SSE's deferred pub/sub
- Authentication → middleware runs pre-upgrade; 4xx blocks the 101
- Binary frames → supported; passed as `Uint8Array` to handler
- Backpressure → `socket.send` returns `Promise<void>` resolving on TCP write ack
- Subprotocols → supported; route declares, JS picks first match from client list
- Ping/pong → server-initiated every 30 s by default; 2× window for pong; 1011 + close on timeout

## 10. Implementation plan size estimate

14-16 tasks, similar shape to SSE plan:

1. Add `tokio-tungstenite` to Cargo.toml + `pub mod ws;` (~15 min)
2. Rust `WsEnvelope` + builder + tests (~30 min)
3. Rust `src/ws.rs` skeleton — REGISTRY, types, WS_PATHS, parse_ws_handshake + tests (~1.5 h)
4. NAPI bridge — 5 fns (~2 h) — **load-bearing**
5. Rust `ws_conn_task` — frame loop + ping/pong + close cleanup + tests (~2 h) — **load-bearing**
6. Rust `server.rs` WS branch — handshake validation, sha1+base64 accept, inline `entry.tsfn.call_async` dispatch (same pattern as SSE Task 5 before Task 6 refactored), await open verdict, manual 101 response writer (~2 h) — **load-bearing**
7. Pool `dispatch_ws` — extract the inline tsfn call from Task 6 into a documented helper (mirror of `pool::dispatch_sse` from SSE commit `3091010`); update server.rs call site to use it (~30 min)
8. JS `RouteCall 'ws'` variant + Route.websocket field + Route.wsOptions + defineRoutes validation + wsBranch stub (~1 h)
9. JS `runtime/ws/handler.ts` glue + WsSocket impl + 6 unit tests (~2.5 h) — **load-bearing**
10. JS `defineRoutes` ws validation tests (~30 min)
11. Example app — ws-echo.ts + ws-server-close.ts + routes.tsx + lastWsClose probe + registerWsPaths wiring (~45 min)
12. Wire wsBranch → handleWsConn end-to-end + smoke (~1.5 h) — **load-bearing capstone**
13. 7 integration tests at ports 38220-38226 (~1.5 h)
14. `architecture.md` update (~15 min)

**Total estimate:** ~16-18 hours (slightly more than SSE because of the handshake + frame loop complexity).

---

## Spec coverage check

| §1 success criterion | Implementing tasks |
|---|---|
| 1. websocat echo | 5, 9, 11, 12, 13 test 1 |
| 2. binary round-trip | 5, 9, 12, 13 test 2 |
| 3. server close 4000 | 5, 9, 11, 12, 13 test 3 |
| 4. middleware reject 401 | 5, 6, 8, 9, 12, 13 test 4 |
| 5. middleware pass + echo | 5, 6, 8, 9, 12, 13 test 5 |
| 6. subprotocol negotiation | 5, 6, 9, 12, 13 test 6 |
| 7. client close → 1000 | 5, 9, 11, 12, 13 test 7 |
| 8. no regression | every task ends with cargo test + bun test |

All §1-§9 spec requirements map to at least one task.
