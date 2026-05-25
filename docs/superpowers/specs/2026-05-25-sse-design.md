# Server-Sent Events (SSE) — Design

**Status:** Spec ready · execution pending plan
**Scope:** Brust gains a `sse: (req) => ReadableStream` field on `Route`, served by a new `POST /sse-route`-style HTTP path with `Content-Type: text/event-stream`. WebSockets are out of scope — separate sub-project.
**Tier-2 line item:** Real-time (WebSockets + SSE) — this spec covers SSE only.
**Predecessor design hints:** `architecture.md` lines 706-751 (kept informal; this spec is the formal commitment).

---

## 1. Goal & success criteria

Authors can mount a long-lived `text/event-stream` route by setting one field on a `Route`:

```ts
{
  path: '/events',
  sse: async (req) => new ReadableStream({
    start(controller) { /* push chunks; clean up on req.signal abort */ },
  }),
}
```

**Success criteria (must hold after Task 13 of the implementation plan):**

1. `curl -N -H 'accept: text/event-stream' http://localhost:PORT/sse-counter` streams 3 `data: N\n\n` frames in order then closes cleanly.
2. A heartbeat `: ping\n\n` line arrives within ~16 s on an idle connection.
3. Closing the curl mid-stream fires `req.signal` abort on the worker side within 1 s — observable via a probe action.
4. A middleware-gated SSE route returns 401 + `Content-Type: text/plain` (NOT `text/event-stream`) when called without credentials.
5. Same route with `cookie: user=alice` returns 200 + `text/event-stream` and frames flow.
6. POST to an SSE route returns 405.
7. No regression: existing 50 integration tests still pass, 57 Rust unit tests still pass, all runtime unit tests still pass.

## 2. Architecture

Three layers; one new directory under `runtime/`; no new Rust deps.

```
Browser                         Rust (tokio)                          Worker JS (Bun)
────────                        ────────────                          ──────────────
GET /events           ───→   accept conn
Accept: text/event-stream    validate (GET + Accept rules — see §6)
                             assign conn_id (AtomicU64)
                             dispatch_sse(envelope, conn_id) ─────→   resolve Route by path
                                                                       run middleware chain
                                                                       napi_sse_signal_open(conn_id, status, body, ct) ←
                             ← open signal received (oneshot)            (chain short-circuits 4xx OR reaches 200 terminal)
                             if 4xx → write that response + close
                             else → write 200 + SSE headers           glue: await route.sse(req) → ReadableStream
                                                                            reader loop + heartbeat
                             napi_sse_write(conn_id, bytes) ←──────   await per chunk (Promise = backpressure)
                                ↓
                             TCP socket flush
                             ────────────
Client TCP close      ───→   peek/read → Err/0
                             abort_tx dropped ───────────────────→   napi-registered callback fires
                                                                       glue: AbortController.abort()
                                                                       clearInterval(heartbeat); reader.cancel()
```

**Connection identity:** `conn_id: u64`, monotonic per server, assigned by Rust. Stored in a `parking_lot::Mutex<HashMap<u64, SseConn>>` registry (see §3 for the no-new-dep justification). Both sides carry it; all NAPI calls reference it.

**Worker assignment:** stream stays on the worker chosen at `dispatch_sse` time. No migration. `pool.pick_least_busy()` picks once; its `in_flight_guard` stays alive for the entire connection (the tsfn call doesn't return until the stream ends), so that worker's `in_flight` counter reflects the open stream.

**Open contract:** middleware can reject AFTER the dispatch has started but BEFORE any HTTP response has been written. The single dispatch carries an open signal back through `napi_sse_signal_open` so Rust knows whether to write SSE headers or a regular error response. See §5 for the full mechanics. No second dispatch, no sticky pool primitive.

## 3. Module layout

```
brust/
├── src/
│   ├── routes.rs         # +SseEnvelope, +build_sse_envelope, +tests
│   ├── server.rs         # +route /sse-* paths, +write_sse_response_headers helper
│   ├── sse.rs            # NEW: REGISTRY, SseConn, sse_conn_task, peek_for_close
│   ├── napi.rs           # +napi_sse_write, +napi_sse_close, +napi_sse_register_abort, +napi_sse_signal_open
│   └── pool.rs           # +dispatch_sse (single long-lived tsfn call per conn)
├── runtime/
│   ├── routes.ts         # +Route.sse, +Route.sseOptions, +RouteCall 'sse' variant,
│   │                     #   +sseBranch, +defineRoutes validation rejecting sse+Component/loader
│   └── sse/
│       ├── handler.ts    # NEW: glue — reader loop, heartbeat, abort plumbing
│       └── handler.test.ts # NEW: 5 unit tests
├── example/hello-world/
│   ├── sse-counter.ts    # NEW: counterStream(req) helper
│   ├── routes.tsx        # +/sse-counter, +/sse-gated entries
│   └── actions.ts        # +lastSseAbort() probe action
├── tests/
│   └── integration.test.ts # +6 SSE tests at ports 38210-38215
└── architecture.md       # promote "Real-time: SSE" entry from Designed→Built
```

No `Cargo.toml` change. REGISTRY uses `parking_lot::Mutex<HashMap<u64, SseConn>>` (parking_lot is already at `Cargo.toml:13`). `tokio::sync::{mpsc, oneshot}` are already enabled via the `sync` feature on the existing `tokio` dep. `DashMap` was considered for finer-grained locking but is not justified at MVP scale — revisit if benchmarks show contention.

No `runtime/package.json` change.

## 4. Author API

```ts
// runtime/routes.ts — Route gains:
export interface Route {
  // existing fields unchanged
  // ...
  sse?: (req: BrustRequest) => ReadableStream<Uint8Array | string> | Promise<ReadableStream<Uint8Array | string>>
  sseOptions?: {
    /** Auto-emit `: heartbeat\n\n` every N ms. Default 15000. Set 0 to disable. */
    heartbeatMs?: number
  }
}
```

**Validation rules** (enforced by `defineRoutes` synchronously when called, throws `Error` before any route registration happens — boot fails loudly):

| Combination | Allowed? |
|---|---|
| `sse` alone | ✅ |
| `sse` + `middleware` | ✅ (middleware runs once pre-open) |
| `sse` + `Component` | ❌ throw: `"Route /events: 'sse' cannot coexist with 'Component' or 'loader'"` |
| `sse` + `loader` | ❌ same throw |
| `sse` + `children` | ❌ throw: `"Route /events: 'sse' cannot have nested children"` |

**Chunk types accepted by glue:**

- `Uint8Array` — sent verbatim
- `string` — UTF-8 encoded then sent (convenience; SSE spec is text)

**What the framework handles vs. what the author owns:**

| Concern | Framework | Author |
|---|---|---|
| `Content-Type: text/event-stream` | ✅ auto | — |
| `Cache-Control: no-store` | ✅ auto | — |
| `Connection: keep-alive` | ✅ auto | — |
| `X-Accel-Buffering: no` (nginx) | ✅ auto | — |
| Heartbeat `: ping\n\n` every 15 s | ✅ auto (opt-out via sseOptions) | — |
| SSE message framing (`data:`, `event:`, `id:`) | ❌ | Author writes formatted chunks |
| `Last-Event-ID` request header | ❌ | Author reads `req.headers['last-event-id']` |
| Disconnect detection | ✅ via `req.signal` AbortSignal | Author wires cleanup in abort listener |

**`req.signal` is new on `BrustRequest`.** SSE-only in MVP — populated from the JS glue side using a per-connection `AbortController`. Non-SSE routes (action, render) receive a **permanently-unaborted** shared sentinel signal so the field is always present (`req.signal.aborted === false`, listeners never fire) but disconnect detection is not actually wired for those paths. Extending real disconnect detection to render/action is a follow-up.

Implementation: `runtime/routes.ts` exports `const NEVER_ABORTS = new AbortController().signal` (module constant — the controller is held in scope but never `.abort()`-ed, keeping the signal alive in the unaborted state). Action and render envelope handlers set `req.signal = NEVER_ABORTS` before invoking middleware. **Do not** use `AbortSignal.abort()` — that creates an already-aborted signal which would fire any `addEventListener('abort', ...)` listener synchronously, breaking defensive cleanup code.

## 5. Wire format

### SseEnvelope (Rust → JS, kind variant #4)

```rust
// src/routes.rs
#[derive(Serialize)]
pub struct SseEnvelope<'a> {
    pub kind: &'static str,        // "sse"
    pub conn_id: u64,              // Rust-assigned, monotonic
    pub req: RequestEnvelope,
}
pub fn build_sse_envelope(
    method: &str, full_path: &str, raw_request: &[u8], conn_id: u64
) -> String { ... }
```

JS RouteCall union gains:

```ts
| { kind: 'sse'; conn_id: number; req: BrustRequest }
```

### NAPI fns (new)

```rust
napi_sse_write(env, conn_id: u64, bytes: Buffer) -> Promise<()>
napi_sse_close(env, conn_id: u64) -> ()
napi_sse_register_abort(env, conn_id: u64, cb: JsFunction) -> ()
```

- `napi_sse_write` — enqueues into the Rust `mpsc::Sender<SseFrame>` for `conn_id`. Returns a Promise that resolves when the receiver-side task acknowledges TCP write completion. Cooperative backpressure.
- `napi_sse_close` — removes from REGISTRY, drops sender. Rust task notices on next select-loop iteration and closes TCP.
- `napi_sse_register_abort` — JS calls this with a callback. When Rust detects client disconnect, it invokes the callback (via tsfn). The callback fires the JS-side `AbortController.abort()`.

### Single-dispatch tsfn with reverse-direction "open signal"

The existing `dispatch_to_worker_and_send_meta_response` doesn't fit (it expects a synchronous SAB-buffered response). SSE uses **one** tsfn dispatch per connection — middleware verdict comes back through a NAPI callback BEFORE Rust writes any response headers.

```rust
// src/sse.rs
pub struct SseOpenSignal {
    pub status: u16,
    pub body: Vec<u8>,
    pub content_type: String,   // e.g. "text/plain" for 401 body
}

pub fn dispatch_sse(pool, envelope_json, conn_id, open_tx: oneshot::Sender<SseOpenSignal>)
    -> impl Future<Output=()>
// One tsfn call for the entire SSE lifetime.
// Worker first runs middleware, then calls napi_sse_signal_open(conn_id, status, body, ct)
// which the Rust side routes to open_tx. Rust waits on open_tx; if status 200 it writes
// SSE response headers and continues to feed bytes; if >=400 it writes a regular HTTP
// response and closes. Worker, after signaling open, continues into the reader loop on
// the SAME tsfn call.
```

```rust
// src/napi.rs
napi_sse_signal_open(env, conn_id: u64, status: u32, body: Buffer, content_type: String) -> ()
// Routes into REGISTRY[conn_id].open_tx (replaces the abort_tx union OR sits alongside
// — implementer's call). Single-shot; second call is a no-op.
```

**Why single dispatch over two-phase:**
- No new pool sticky-binding primitive needed (current `pool.pick_least_busy()` returns one `Arc<TsfnEntry>`; we call its tsfn exactly once and the JS side stays on that worker for the connection's lifetime).
- No envelope re-serialization.
- Middleware state lives in the same JS closure as the stream handler — no cross-call carry needed.
- Symmetric: action/render also use one tsfn call per request; SSE is just "longer-lived" one.

**Middleware semantics inside the single dispatch.** The composed chain's terminal returns a 200 placeholder `{status:200, body:'', contentType:'text/event-stream'}`. The glue:
1. Runs the composed middleware chain. If it short-circuits with 4xx (no terminal call), the glue invokes `napi.signalOpen(conn_id, status, body, contentType)` and returns. Rust writes the error response and closes.
2. If middleware passes through to the terminal (200), the glue invokes `napi.signalOpen(conn_id, 200, EMPTY, 'text/event-stream')`, then `await route.sse!(req)`, then enters the reader loop. Author's `route.sse` runs *once*, after middleware approves.

### HTTP response headers (Rust auto-writes after middleware passes)

```
HTTP/1.1 200 OK\r\n
Content-Type: text/event-stream\r\n
Cache-Control: no-store\r\n
Connection: keep-alive\r\n
X-Accel-Buffering: no\r\n
\r\n
```

Then chunk bytes flow.

## 6. Lifecycle & error paths

### Open path

1. Rust accepts TCP, parses request line + headers.
2. If method != GET → write `error_405`, close.
3. If path doesn't match any route → fall through to existing 404 logic.
4. If matched route has no `sse` field → existing action/render dispatch (unchanged).
5. If matched route has `sse` field, validate `Accept`: accept the request if the header is missing, contains `text/event-stream`, OR equals `*/*` (default curl). Reject with 406 only when an explicit Accept lists a specific non-SSE type. Rationale: default `curl URL` (no `-H 'accept:'` flag) sends `Accept: */*`; rejecting that hurts dev ergonomics for no real benefit. Browsers' `EventSource` always sets `Accept: text/event-stream` so production behavior is unchanged.
6. Assign `conn_id` from `NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed)`.
7. Spawn `sse_conn_task` (per-conn tokio task), register in REGISTRY with an `open_tx: oneshot::Sender<SseOpenSignal>`.
8. `dispatch_sse(envelope_json, conn_id)` — one tsfn call that lives for the connection's lifetime. Worker runs middleware first, then calls `napi_sse_signal_open(conn_id, status, body, ct)` which routes into `open_tx`.
9. Rust task awaits `open_rx`:
   - If `status >= 400`: write a regular HTTP response with body/contentType, close TCP. **No SSE headers sent.**
   - If status 200: write SSE response headers; worker proceeds (on the same tsfn call) into the reader loop.

### `sse_conn_task` (per-connection tokio task)

```rust
async fn sse_conn_task(mut stream: TcpStream, conn_id: u64) {
    let (tx, mut rx) = mpsc::channel::<SseFrame>(32);
    let (abort_tx, abort_rx) = oneshot::channel::<()>();
    REGISTRY.insert(conn_id, SseConn { tx, abort_tx });

    loop {
        tokio::select! {
            Some(frame) = rx.recv() => {
                if stream.write_all(&frame.bytes).await.is_err() { break }
                let _ = frame.ack.send(());     // resolves JS Promise
            }
            _ = peek_for_close(&mut stream) => break,   // client TCP close
        }
    }
    REGISTRY.remove(&conn_id);
    // abort_tx is dropped on remove; if JS registered a callback,
    // the napi-side adapter sees the drop and fires the JS callback.
}
```

`peek_for_close` = non-blocking 1-byte peek; FIN/RST → returns immediately, loop breaks.

### Disconnect detection matrix

| Trigger | Detection point | Cleanup chain |
|---|---|---|
| Client TCP FIN | `peek_for_close` → 0 bytes | Task exits → REGISTRY.remove → `abort_tx` dropped (oneshot dropped, treated as "fired") → NAPI abort-watcher task invokes JS callback registered via `napi_sse_register_abort` → glue calls `AbortController.abort()` → `req.signal.aborted = true` → author's listener fires; in parallel, the next `napi.write` Promise rejects → glue's reader loop exits via catch → final cleanup |
| Client TCP RST | `stream.write_all` → Err | Same chain |
| Handler `controller.close()` | `reader.read()` → `{done:true}` | Glue exits loop → `napi.close(conn_id)` → task notices empty channel + no senders → closes TCP. **No `req.signal` abort fires** (server-initiated close is not an abort) |
| Handler throws inside ReadableStream | `reader.read()` throws | Glue catches → logs → `napi.close(conn_id)` → same chain as `controller.close()`. **No `req.signal` abort** |
| Server graceful shutdown (SIGINT) | Brust shutdown drops REGISTRY entries | All tasks exit; for each conn, `abort_tx` drop fires the JS callback → `req.signal.abort()` → author cleanup runs; then TCP closes |

### `req.signal` contract

- AbortSignal fires for ALL disconnect causes EXCEPT server-initiated close (`controller.close()` → `done:true` path).
- Fires exactly once per connection.
- Authors should treat it as the only cleanup hook needed.

### Glue (`runtime/sse/handler.ts`) sketch

```ts
import { composeChain } from '../routes.ts'

export async function handleSseStream(call: SseCall, route: Route, napi: SseNapi) {
  const controller = new AbortController()
  ;(call.req as Mutable<BrustRequest>).signal = controller.signal
  napi.registerAbort(call.conn_id, () => controller.abort())

  let stream: ReadableStream
  try {
    stream = await route.sse!(call.req)
  } catch (err) {
    console.error(`[brust] sse handler threw on open conn=${call.conn_id}:`, err)
    napi.close(call.conn_id)
    return
  }

  const reader = stream.getReader()
  const heartbeatMs = route.sseOptions?.heartbeatMs ?? 15_000
  const heartbeatId = heartbeatMs > 0
    ? setInterval(() => { void napi.write(call.conn_id, PING_FRAME) }, heartbeatMs)
    : null

  // Force-cancel the reader on abort so a stuck `await reader.read()`
  // unwinds even if the author's stream doesn't listen to req.signal.
  controller.signal.addEventListener('abort', () => { void reader.cancel() })

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const bytes = typeof value === 'string' ? encoder.encode(value) : value
      await napi.write(call.conn_id, bytes)
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error(`[brust] sse stream error conn=${call.conn_id}:`, err)
    }
  } finally {
    if (heartbeatId !== null) clearInterval(heartbeatId)
    napi.close(call.conn_id)
    try { reader.releaseLock() } catch {}
  }
}

const encoder = new TextEncoder()
const PING_FRAME = encoder.encode(': ping\n\n')
```

The middleware composition runs at the top of `handleSseStream` itself (one entry point per dispatch). After the chain resolves, the glue signals open via `napi.signalOpen(conn_id, status, body, contentType)` and — on status 200 — falls through into `await route.sse(req)` and the reader loop on the same tsfn call.

## 7. Limits & out-of-scope

| Limit | Default | Configurable | Notes |
|---|---|---|---|
| Max concurrent SSE conns per server | none | — | Rely on OS fd limit + reverse proxy |
| Per-conn mpsc queue depth | 32 frames | hard-coded | Backpressure beyond 32 = JS glue awaits `napi.write` Promise |
| Heartbeat interval | 15 000 ms | `sseOptions.heartbeatMs` per route | 0 disables |
| Chunk size cap | none | — | Large chunks (>1 MB) work but waste memory in queue |
| Connection idle timeout | none | — | Rely on heartbeat + client/proxy timeouts |
| Heartbeat timer count | N (one `setInterval` per SSE conn in worker JS) | — | Centralization to a single Rust ticker walking REGISTRY is a follow-up perf option; saves N timers at the cost of one Rust→JS dispatch per tick per conn |
| tsfn handles for abort callbacks | N (one tsfn per SSE conn from `napi_sse_register_abort`) | — | Bun's tsfn pool doesn't document a hard cap; at ~10k conns the V8/napi handle footprint is real (few MB). Follow-up: replace with a single demux tsfn that takes `conn_id` and routes to a JS-side `Map<conn_id, AbortController>` — one tsfn total |

**Out of scope for MVP** (documented as limitations, not bugs):

- Per-IP rate limiting on SSE connection counts
- Resume via `Last-Event-ID` (author can read header; framework does not auto-replay)
- Compression on SSE responses (intentional — proxies stall gzip flush)
- App-level "slow consumer" backpressure beyond TCP
- Metrics endpoint (`GET /_brust/sse/stats`) — easy follow-up
- Cross-process / cross-instance fan-out (pub/sub deferred per scope decision)
- WebSocket — separate sub-project after SSE ships

## 8. Testing

| Layer | Coverage | Count | Location |
|---|---|---|---|
| Rust unit | `SseEnvelope` serde, `build_sse_envelope`, REGISTRY insert/remove, conn_id monotonic | 4 | `src/routes.rs`, `src/sse.rs` `#[cfg(test)]` |
| Rust unit | `peek_for_close` on paired UnixStream (FIN, RST) | 2 | `src/sse.rs` `#[cfg(test)]` |
| Runtime unit | Glue — chunks forwarded, heartbeat fires, abort cancels reader + clears interval, error path closes, heartbeatMs=0 disables interval | 5 | `runtime/sse/handler.test.ts` |
| Integration | 6 tests at ports 38210-38215 (see §1 success criteria 1-6) | 6 | `tests/integration.test.ts` |

**Integration test worker setup (important):** every SSE integration test MUST spawn the example app with `env: { ...process.env, BRUST_PORT: '...', BRUST_WORKERS: '1', RUST_LOG: 'brust=warn' }`. Default `BRUST_WORKERS=18` spawns 18 separate Bun Worker contexts with isolated JS state — the SSE handler runs on one worker, but a follow-up probe action (e.g. `lastSseAbort()` in success criterion 3) gets dispatched by `pool.pick_least_busy()` to whichever worker is least loaded, almost certainly NOT the SSE worker. Probe reads a fresh (zeroed) module global and the test silently passes-or-fails. Single-worker mode aligns the SSE handler and the probe action onto the same JS context.

**Test totals after ship:** 63 Rust unit + 77 runtime unit + 56 integration = **196 tests** (vs. 179 today).

**Example app additions** used by integration tests:

```ts
// example/hello-world/sse-counter.ts (new)
import type { BrustRequest } from 'brust/runtime'

export function counterStream(req: BrustRequest): ReadableStream {
  return new ReadableStream({
    start(controller) {
      let n = 0
      const id = setInterval(() => {
        controller.enqueue(`data: ${++n}\n\n`)
        if (n >= 3) {
          clearInterval(id)
          controller.close()
        }
      }, 50)
      req.signal.addEventListener('abort', () => {
        clearInterval(id)
        ;(globalThis as { __lastSseAbort?: number }).__lastSseAbort = Date.now()
      })
    },
  })
}
```

```ts
// example/hello-world/routes.tsx — append
{ path: '/sse-counter', sse: (req) => counterStream(req) },
{ path: '/sse-gated', middleware: [requireLogin], sse: (req) => counterStream(req) },
```

```ts
// example/hello-world/actions.ts — append (probe for test 3)
export async function lastSseAbort() {
  return { ts: (globalThis as { __lastSseAbort?: number }).__lastSseAbort ?? 0 }
}
```

**Manual smoke test (gate for the implementation plan's Task 13):**

```bash
BRUST_PORT=38990 bun run example/hello-world/index.ts &
sleep 5
curl -N -H 'accept: text/event-stream' http://127.0.0.1:38990/sse-counter
# Expected: 3 data frames then connection closes
kill %1
```

**Stretch (not gating):** 1000-conn capacity stress test as a `bench/sse-capacity.ts` probe — deferred to a follow-up sprint.

## 9. Open questions resolved during brainstorming

- API shape → `Route.sse` field (matches existing pattern)
- Heartbeat → framework default-on 15 s, opt-out via `sseOptions.heartbeatMs`
- Connection model → multiplex (many per worker) via out-of-band NAPI channel
- Broadcast / pub-sub → out of scope for SSE MVP; will be designed jointly with WebSockets
- Mixed Component/loader/sse → boot-time validation throws

## 10. Implementation plan size estimate

13-15 tasks, similar shape to the MCP plan:

1. Rust `SseEnvelope` + builder + unit tests (~30 min)
2. Rust `sse.rs` skeleton — REGISTRY, conn_id counter, SseConn struct, unit tests (~1 h)
3. Rust `peek_for_close` helper + tests (~30 min)
4. NAPI `napi_sse_write` / `_close` / `_register_abort` / `_signal_open` (~2 h) — **load-bearing**
5. Rust `server.rs` route dispatch — accept GET + SSE Accept; write headers; spawn task (~1.5 h) — **load-bearing**
6. Pool — single `dispatch_sse` long-lived tsfn call per conn + Rust-side oneshot for open signal routing (~1.5 h) — **load-bearing**
7. JS `RouteCall 'sse'` variant + sseBranch stub (~30 min)
8. JS `runtime/sse/handler.ts` glue + 5 unit tests (~2 h) — **load-bearing**
9. JS `defineRoutes` validation for sse+Component/loader/children (~30 min)
10. JS `BrustRequest.signal` field + propagation (~1 h)
11. Example app — sse-counter.ts + routes.tsx + lastSseAbort probe (~30 min)
12. Wire `sseBranch` to `handleSseStream`, end-to-end smoke (~1 h)
13. Integration tests — 6 tests (~1 h)
14. `architecture.md` update — promote Real-time:SSE entry to Built (~15 min)

**Total estimate:** ~13-15 hours (faster than MCP because no TS compiler API).

---

## Spec coverage check

| Requirement (§1 success criteria) | Tasks |
|---|---|
| 1. 3-frame stream + close | 7, 8, 11, 13 |
| 2. Heartbeat within 16s | 8, 13 |
| 3. Client disconnect → req.signal abort | 4, 5, 8, 10, 11, 13 |
| 4. Middleware reject → 401 + no SSE headers | 5, 6, 13 |
| 5. Middleware pass → 200 + frames | 5, 6, 13 |
| 6. POST → 405 | 5, 13 |
| 7. No regression | every task ends with full suite pass |

All criteria mapped; no dangling.
