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
Accept: text/event-stream    validate (GET + Accept text/event-stream)
                             assign conn_id (AtomicU64)
                             dispatch_sse_open(envelope) ─────────→   resolve Route by path
                                                                       run middleware chain
                             ← Promise<{status, body, contentType}>    → return open verdict
                             if 4xx → write that response + close
                             else → write 200 + SSE headers
                             dispatch_sse_stream(envelope, conn_id) →   route.sse(req) → ReadableStream
                                                                       glue: reader loop + heartbeat
                             napi.write(conn_id, bytes) ←──────────   await per chunk (Promise = backpressure)
                                ↓
                             TCP socket flush
                             ────────────
Client TCP close      ───→   peek/read → Err/0
                             drop sender, signal abort_rx ─────────→   glue: AbortController.abort()
                                                                       clearInterval(heartbeat); reader.cancel()
```

**Connection identity:** `conn_id: u64`, monotonic per server, assigned by Rust. Stored in `DashMap<u64, SseConn>` registry. Both sides carry it; all NAPI calls reference it.

**Worker assignment:** stream pinned to the worker that opened it. No migration. Pool dispatch is round-robin at `dispatch_sse_open` time.

**Open contract (the awkward bit):** middleware can reject. Headers are sent ONLY after middleware approves. Two-phase dispatch:
1. `dispatch_sse_open` — sync response; middleware runs here; returns `{status, body}` like a regular request.
2. If status 200 → Rust writes SSE headers, then `dispatch_sse_stream` opens the persistent stream.

This costs one extra tsfn roundtrip per SSE conn (~hundreds of µs at most) for honest HTTP semantics.

## 3. Module layout

```
brust/
├── src/
│   ├── routes.rs         # +SseEnvelope, +build_sse_envelope, +tests
│   ├── server.rs         # +route /sse-* paths, +write_sse_response_headers helper
│   ├── sse.rs            # NEW: REGISTRY, SseConn, sse_conn_task, peek_for_close
│   ├── napi.rs           # +napi_sse_write, +napi_sse_close, +napi_sse_register_abort
│   └── pool.rs           # +dispatch_sse_open, +dispatch_sse_stream (new tsfn shape)
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

No `Cargo.toml` change (tokio's `mpsc`, `oneshot`, and `DashMap` are already in the dep tree from existing infra; if `dashmap` is not present, use `parking_lot::RwLock<HashMap>` — same complexity, no new dep).

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

**`req.signal` is new on `BrustRequest`.** SSE-only in MVP — populated from the JS glue side using a per-connection `AbortController`. Non-SSE routes (action, render) get `req.signal` as a pre-aborted no-op `AbortSignal` so the field is always present and never throws on access, but only SSE actually fires it on disconnect. Extending real disconnect detection to render/action is a follow-up.

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

### Two-phase tsfn dispatch

The existing `dispatch_to_worker_and_send_meta_response` doesn't fit. New paths:

```rust
// src/pool.rs (or src/sse.rs)
pub struct SseOpenResult {
    pub status: u16,
    pub body: Vec<u8>,
    pub content_type: String,   // e.g. "text/plain" for 401 body
}
pub async fn dispatch_sse_open(pool, envelope_json) -> SseOpenResult
pub fn dispatch_sse_stream(pool, envelope_json, conn_id) -> impl Future<Output=()>
// fire-and-forget; worker holds the stream
```

Both run on the same worker — `pool.acquire_sticky()` pins a worker for the duration of `dispatch_sse_open`'s response → `dispatch_sse_stream` invocation, so middleware-side state (e.g. a Map<sessionId, user> populated by login middleware) can carry into the stream handler without serialization. The sticky binding is released when `dispatch_sse_stream` finishes (i.e. stream ends).

**Important: middleware must NOT invoke `route.sse(req)` in its terminal.** The composed chain's terminal returns a 200 placeholder; the actual stream handler runs in `handleSseStream` (separate worker entry) only after middleware approves. This keeps middleware semantics identical to action/render and prevents double-invocation of `route.sse`.

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
5. If matched route has `sse` field but `Accept` header doesn't contain `text/event-stream` → 406. (Document this as strict; some apps may want to relax — defer.)
6. Assign `conn_id` from `NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed)`.
7. `dispatch_sse_open(envelope_json)` → middleware runs, returns `{status, body, contentType}`.
8. If `status >= 400`: write a regular HTTP response with body/contentType, close. **No SSE headers sent.**
9. If status 200: write SSE response headers, spawn `sse_conn_task`, register in REGISTRY, `dispatch_sse_stream(envelope_json, conn_id)`.

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

The middleware composition happens in `dispatch_sse_open` (separate worker entry), not here — `handleSseStream` runs only AFTER middleware has approved.

## 7. Limits & out-of-scope

| Limit | Default | Configurable | Notes |
|---|---|---|---|
| Max concurrent SSE conns per server | none | — | Rely on OS fd limit + reverse proxy |
| Per-conn mpsc queue depth | 32 frames | hard-coded | Backpressure beyond 32 = JS glue awaits `napi.write` Promise |
| Heartbeat interval | 15 000 ms | `sseOptions.heartbeatMs` per route | 0 disables |
| Chunk size cap | none | — | Large chunks (>1 MB) work but waste memory in queue |
| Connection idle timeout | none | — | Rely on heartbeat + client/proxy timeouts |

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
4. NAPI `napi_sse_write`/`close`/`register_abort` (~1.5 h) — **load-bearing**
5. Rust `server.rs` route dispatch — accept GET + SSE Accept; write headers; spawn task (~1.5 h) — **load-bearing**
6. Pool — `dispatch_sse_open` + `dispatch_sse_stream` (new tsfn shape) (~2 h) — **load-bearing**
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
