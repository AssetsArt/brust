# HTML Streaming (`renderToPipeableStream`) — Design

**Status:** Spec ready · execution pending plan
**Scope:** Replace the worker's `renderToString` render path with React 18's `renderToPipeableStream`. Auto-detect Suspense: routes that don't pause emit a byte-identical single-chunk response (today's wire shape); routes with pending Suspense boundaries stream via HTTP/1.1 `Transfer-Encoding: chunked` with shell-first, suspended-fallbacks-then-resolved-content delivery. One new NAPI function (`napiRenderChunk`). Existing renderer contract is replaced entirely — no opt-in flag, no two renderers to maintain.
**Tier-2 line item:** HTML Streaming (`renderToPipeableStream` over SAB multi-chunk signals) — `architecture.md:991`.
**Predecessor design hints:** `architecture.md:753-781` (kept informal; this spec is the formal commitment).

---

## 1. Goal & success criteria

Authors do nothing different. Routes that already render fine continue to render fine, with one wire-level change: routes whose render tree contains a Suspense boundary that pauses at SSR time now stream their HTML in chunks instead of buffering until the slowest data resolves.

```tsx
// Same Route author surface as today — no flag, no opt-in.
{ path: '/dashboard', Component: Dashboard }

// Inside Dashboard.tsx — opt INTO streaming behaviour just by using Suspense:
export default function Dashboard() {
  return (
    <Layout>
      <Suspense fallback={<Spinner />}>
        <SlowWidget />        {/* throws a Promise → server streams Spinner first, replaces later */}
      </Suspense>
    </Layout>
  )
}
```

**Success criteria (must hold after the final task of the implementation plan):**

1. **Single-chunk wire equivalence** — `GET /` on the example app emits an HTTP/1.1 response with `Content-Length` (NOT `Transfer-Encoding`). For pages with **no Suspense boundaries** in their tree, body bytes are byte-identical to today's `renderToString` output. For pages with Suspense boundaries that don't pause (all-synchronous children), body bytes are **semantically equivalent** — same final DOM, same hydration result — but may include React's hydration markers (`<!--$-->`, `<template id="B:0">`) which `renderToString` does not emit. The existing 56 integration tests all hit no-Suspense paths and must still pass byte-identically.
2. **Streaming round-trip** — a route with a Suspense boundary that resolves after 200ms emits `Transfer-Encoding: chunked`; the shell HTML arrives at the client BEFORE the suspended content; the chunked terminator (`0\r\n\r\n`) arrives only after `onAllReady` fires.
3. **Time-to-first-byte win** — for a streaming route, the shell chunk reaches the client within ~render-time of the shell (NOT render-time of the slowest Suspense boundary). Measured via integration test: TTFB on a 200ms-suspended route is under 50ms.
4. **Client mid-stream disconnect** — closing the socket mid-chunk drops the worker's in-flight slot cleanly: a subsequent request on the same worker succeeds, no zombie state, no leaked Mutex slot.
5. **Pre-shell crash** — a component that throws synchronously before `onShellReady` produces a 500 response with the `errorBoundary` HTML, single-chunk, with `Content-Length` (headers not yet committed, so 500 status is recoverable).
6. **Post-shell crash** — a Suspense child that throws after the shell ships is handled by React's own Suspense errorBoundary mechanism — the affected chunk contains the boundary's fallback; the rest of the page streams normally; response status remains 200.
7. **Islands work in streaming mode** — a streaming page that uses islands ships the importmap + bootstrap script tag in the first chunk; client hydration succeeds.
8. **No regression** — all 73 Rust unit + 92 runtime unit + 63 integration tests pass unchanged. The single-chunk wire path is byte-identical to today's `renderToString` output.

## 2. Architecture

Three layers; one new NAPI function; one new Rust module; one new TS module.

```
Browser                          Rust (tokio)                          Worker JS (Bun)
─────────                        ─────────────                         ─────────────────

GET /dashboard
     ┌──────────────────────────────────┐
     │  HTTP/1.1 200 OK                 │
     │  Transfer-Encoding: chunked      │  ◄── headers written when first chunk lands
     │                                  │
     │  <hex>\r\n<shell HTML>\r\n       │  ◄── chunk 1 (shell + Spinner fallbacks)
     │  <hex>\r\n<resolved data>\r\n    │  ◄── chunk 2 (filled-in Suspense content)
     │  0\r\n\r\n                       │  ◄── terminator
     └──────────────────────────────────┘
                ▲
                │ writes raw bytes
                │
        handle_conn (Rust)
        ┌────────────────────────────┐
        │ (chunk_tx, chunk_rx) per request
        │ Stores chunk_tx in entry.in_flight slot
        │ tsfn.call_async(envelope)  ──────────────►  renderer wrapper (makeRenderer)
        │                                              │
        │ select! loop:                                │  renderToPipeableStream(<App />, {
        │   chunk_rx.recv() → write to socket          │    onShellReady → set sink.metaPrefix
        │                  → ack via oneshot           │                  → stream.pipe(sink)
        │   render_future  → terminal cleanup          │    sink._write  → [metaPrefix?][body] → SAB
        │                                              │                  → await napi.renderChunk(len)
        │ Clears slot when Final received              │    sink._final  → await napi.renderChunk(0)
        └────────────────────────────┘                 │  })
                ▲                                      │
                │ napi.renderChunk(workerId, len)      │
                │ reads SAB[0..len], sends through     │
                │ entry.in_flight slot's chunk_tx      │
                └──────────────────────────────────────┘
```

**Why this shape:**
- **Auto-detect via React's pending-boundary count at `onShellReady`** lets us pick `Content-Length` vs chunked transfer-encoding BEFORE writing any body bytes. One bit in the meta JSON drives Rust's framing.
- **SAB reuse at offset 0** preserves zero-copy semantics for the body. Each chunk overwrites the previous because Rust drains-then-acks before the worker writes the next.
- **Single in-flight slot per worker** is sufficient because JS workers are single-threaded — only one render Promise pending at any moment, so the slot's Mutex never sees contention.
- **The dispatch tsfn now returns `Promise<()>` instead of `Promise<u32>`** — chunks flow through the side channel, the tsfn return value just signals "renderer is done."

## 3. Module layout

```
src/
├── lib.rs                          # +napi_render_chunk; register_renderer signature → Promise<()>
├── pool.rs                         # +render_slot field on TsfnEntry; RenderChunk enum; RenderSlot
├── render_stream.rs                # NEW — chunked encoding helpers + meta layout
└── server.rs                       # action+render branches use new dispatch_to_worker_and_stream_chunks
                                    #   (replaces dispatch_to_worker_and_send_meta_response)

runtime/
├── index.ts                        # RenderFn type: (env)→Promise<number> → (env)→Promise<void>
├── routes.ts                       # makeRenderer dispatches: action→actionBranchChannel,
                                    #   render→renderBranchStreaming, sse/ws→unchanged
└── render/
    └── stream.ts                   # NEW — renderBranchStreaming + buffering Writable sink
                                    #   + emitFirstChunk/emitBodyChunk helpers
```

One new Rust module (`render_stream.rs`), one new TS module (`runtime/render/stream.ts`). No new dependencies (React 18's `renderToPipeableStream` is already in `react-dom/server`).

**Replaced helper:** `dispatch_to_worker_and_send_meta_response` at `src/server.rs:798-910` is the load-bearing function that today owns the `tsfn.call_async → Promise<u32> → read SAB → write response` flow for BOTH render and action branches (action calls it at the `/_brust/action/` handler, render calls it at `src/server.rs:762`). It's replaced wholesale by `dispatch_to_worker_and_stream_chunks` with the same call sites and the same `DispatchControl::{Continue, CloseConn}` return enum (§7.1). The `entry.in_flight_guard()` busy-counter call is preserved (unchanged behaviour for `pick_least_busy`); a separate `RenderSlot` (`render_slot` field) carries the chunk channel.

**Divergence from SSE/WS pattern (intentional):** SSE and WebSocket's dispatch tsfn resolves immediately after `signalOpen` — the rest of the per-conn lifetime lives on independent channels (`sse_conn_task`, `ws_conn_task`). The render tsfn instead resolves after the FINAL chunk because render is request-scoped (a render is one request, not a long-lived connection). Both patterns coexist in the worker pool; future maintainers should not try to unify them.

## 4. Wire protocol

**SAB layout per chunk** (one SAB per worker, reused at offset 0):

```
First chunk (always carries meta):
  [meta_len: u16 BE][meta JSON UTF-8][shell HTML bytes]

Subsequent chunks (body-only, no meta):
  [chunk body bytes]

Final signal:
  napi.renderChunk(workerId, 0)    — no SAB read; just closes the channel
```

**Meta JSON shape:**

```jsonc
{
  "status": 200,
  "contentType": "text/html; charset=utf-8",
  "headers": { "x-render-ms": "12" },
  "streaming": true   // true iff multi-chunk expected (Suspense pending at onShellReady)
}
```

**Transfer-encoding decision:**
- `streaming: false` → Rust buffers the lone chunk, waits for Final, writes one HTTP/1.1 response with `Content-Length`. **Bytes-identical to today's `renderToString` wire path.**
- `streaming: true` → Rust writes headers with `Transfer-Encoding: chunked` AS SOON AS the first chunk arrives. Each subsequent chunk is wrapped as `<hex_len>\r\n<bytes>\r\n`. Final signal writes `0\r\n\r\n` terminator.

**Backward compat:** existing wire format (single `[meta_len][meta][body]` block) is preserved verbatim for non-streaming responses — same byte layout on the socket, just routed through the chunk channel instead of returned as the tsfn result.

**Chunk size cap:** a single chunk MUST fit in the SAB (currently 256 KB). React's emitted chunks are normally far smaller; if React ever emits a chunk larger than the SAB, the sink adapter splits it across multiple `napi.renderChunk` calls. `napi_render_chunk` returns Err if `len > buf_len` — defensive bounds check.

## 5. NAPI surface

### 5.1 Renderer contract cascade (all sites that change)

The existing renderer tsfn returns `Promise<u32>` (byte length packed into SAB). The new contract returns `Promise<()>` and delivers all bytes via the `napi_render_chunk` side channel. **Six concrete sites** change in lock-step:

| Site | Today | After |
|---|---|---|
| `src/pool.rs:11` | `pub type RendererTsfn = ThreadsafeFunction<String, Promise<u32>, String, napi::Status, false>;` | `pub type RendererTsfn = ThreadsafeFunction<String, Promise<()>, String, napi::Status, false>;` |
| `src/lib.rs:139-156` `register_renderer` | `f: Function<String, Promise<u32>>` | `f: Function<String, Promise<()>>` |
| `src/pool.rs:98-130` `dispatch_sse`, `dispatch_ws` | `.map(|_| ())` discards the `Promise<u32>` | Already discards the return value; **no change** |
| `src/server.rs:798+` `dispatch_to_worker_and_send_meta_response` | Reads `Promise<u32>` length, slices SAB[0..n], decodes meta+body, writes response | **Replaced** by `dispatch_to_worker_and_stream_chunks` (see §5.3) |
| `runtime/index.ts:29` `RenderFn` type | `(envelope: string) => Promise<number>` | `(envelope: string) => Promise<void>` |
| `runtime/routes.ts:400-452` `makeRenderer` + branch returns | Each branch (`actionBranch`, `renderBranch`, `sseBranch`, `wsBranch`) returns `Promise<number>` (SAB length); makeRenderer returns the length | Each branch returns `Promise<void>`; chunks travel through `napi.renderChunk` (action+render) or per-conn helpers (sse+ws — unchanged) |

The `dispatch_sse` / `dispatch_ws` Rust helpers in `pool.rs` already `.map(|_| ())` — Rust-side dispatch surface for SSE/WS is unchanged. Only the JS-side branch return types shift to `void`.

### 5.2 New NAPI function

```rust
#[napi]
pub async fn napi_render_chunk(worker_id: u32, len: u32) -> NapiResult<()>
```

**Contract:**
- `len > 0` → Rust reads SAB[0..len] from the worker's pre-registered buffer, sends `RenderChunk::Bytes { data, ack }` through the worker's `render_slot`'s `chunk_tx`, awaits `ack_rx`. Resolves after the chunk lands on the socket → worker proceeds to the next chunk.
- `len == 0` → Final signal. Sends `RenderChunk::Final { ack }`, awaits ack. Rust writes chunked terminator (if `streaming: true`) OR flushes the buffered single-chunk response (if `streaming: false`), then resolves the Promise immediately.
- Worker MUST call `napi.renderChunk(0)` exactly once per request — even single-chunk responses — to close the channel and let `handle_conn` proceed.
- **`ack_rx` failure path:** if the oneshot sender is dropped before `send` (handle_conn torn down mid-stream), `ack_rx.await` returns `Err(RecvError)` — `napi_render_chunk` MUST translate this to `NapiResult::Err`, NOT stall. The worker sees a rejected Promise and propagates through the sink's error path (§6).

### 5.3 Per-worker render slot

**Field name `render_slot`** (NOT `in_flight` — would shadow the existing `in_flight: AtomicU32` busy-counter at `pool.rs:30` used by `pick_least_busy`):

```rust
pub struct TsfnEntry {
    pub id: u32,
    pub tsfn: RendererTsfn,
    pub buf_ptr: BufPtr,
    pub buf_len: usize,
    pub in_flight: AtomicU32,                                    // EXISTING — busy counter
    pub render_slot: parking_lot::Mutex<Option<RenderSlot>>,     // NEW — chunk channel
}

pub struct RenderSlot {
    pub chunk_tx: tokio::sync::mpsc::Sender<RenderChunk>,
}

pub enum RenderChunk {
    Bytes { data: Vec<u8>, ack: tokio::sync::oneshot::Sender<()> },
    Final { ack: tokio::sync::oneshot::Sender<()> },
}
```

**Lifecycle (RAII — important):** `handle_conn` MUST acquire the slot via a guard struct whose `Drop` impl clears it:

```rust
struct RenderSlotGuard<'e> { entry: &'e Arc<TsfnEntry> }
impl Drop for RenderSlotGuard<'_> {
    fn drop(&mut self) { self.entry.render_slot.lock().take(); }
}
```

Without the Drop guard, a tokio cancellation between `*slot = Some(...)` and the manual `take()` would leak the sender → next request on this worker would `debug_assert` (in dev) or silently overwrite the slot (in release).

Slot collision (two `call_async` racing on one worker) is impossible — JS thread is single-threaded → one render Promise pending at a time. A `debug_assert!(slot.is_none(), ...)` documents the invariant.

## 6. JS-side renderer wrapper

**`makeRenderer` (in `runtime/routes.ts`) becomes chunk-channel-native.** The wrapper owns the SAB + TextEncoder + the `napi.renderChunk` calls; per-route author code stays untouched.

```typescript
function makeRenderer(routes, view, opts): (envelope: string) => Promise<void> {
  return async (envelope_json) => {
    const call = JSON.parse(envelope_json) as RouteCall
    if (call.kind === 'action') return actionBranchChannel(call, ..., view, encoder)
    if (call.kind === 'sse')    return sseBranch(call, ...)         // unchanged; doesn't use renderChunk
    if (call.kind === 'ws')     return wsBranch(call, ...)          // unchanged; doesn't use renderChunk
    return renderBranchStreaming(call, ..., view, encoder)
  }
}
```

**Branch dispatch rationale:**
- **action**: routed through the chunk channel as ONE chunk + final signal. The 2x NAPI round-trip cost vs today's `Promise<u32>` return is ~50μs — negligible vs the action body itself. The benefit is a single dispatch model (no second `Promise<u32>` tsfn type to maintain). Implementation: `actionBranchChannel` calls the existing `actionBranch` logic to pack the response into the SAB, then emits `napi.renderChunk(len)` + `napi.renderChunk(0)`. Wire shape on the socket is unchanged (single chunk, `Content-Length`, identical bytes).
- **render**: full streaming logic (below).
- **sse / ws**: bypass the chunk channel entirely. Their tsfn Promises resolve after `signalOpen` (not after the conn closes); per-conn lifetime is owned by their own per-conn helpers (`sse_conn_task`, `ws_conn_task`) which use independent channels. They never touch `render_slot`.

**The streaming render branch** (`runtime/render/stream.ts`):

```typescript
async function renderBranchStreaming(call, routes, view, encoder, ctx): Promise<void> {
  // [path match + middleware compose + chain run + build <App /> element — same as today]

  return new Promise<void>(async (resolve, reject) => {
    // Single guaranteed-fire path for the Final signal — wrapped so that error paths
    // can still close the channel and unblock handle_conn without duplicating the call.
    const sendFinal = async () => {
      try { await napi.renderChunk(workerId, 0); resolve() }
      catch (e) { reject(e) }
    }

    // Buffering sink: holds chunks in memory until we know whether to commit
    // chunked (Suspense pending at onShellReady) or wait for onAllReady (no
    // pending Suspense — single-chunk Content-Length path with islands flag
    // checked at the end).
    const buffer: Uint8Array[] = []
    let mode: 'buffering' | 'streaming' | 'done' = 'buffering'

    const sink = new (require('node:stream').Writable)({
      async write(chunk: Uint8Array, _enc: string, cb: (e?: Error) => void) {
        try {
          if (mode === 'buffering') {
            buffer.push(chunk); cb(); return
          }
          if (mode === 'streaming') {
            await emitBodyChunk(view, chunk)       // SAB[0..len] → napi.renderChunk(len)
          }
          cb()
        } catch (e) { cb(e as Error) }              // C8: propagate, do NOT cb()
      },
      async final(cb: (e?: Error) => void) {
        try {
          if (mode === 'buffering') {
            // No Suspense path: assemble single chunk now, check islands flag,
            // emit meta+body in one renderChunk(len) + renderChunk(0).
            const islandsUsed = consumeIslandUsedFlag()
            const body = islandsUsed
              ? concatWithBootstrap(buffer)         // prepend ISLANDS_IMPORTMAP_AND_BOOTSTRAP
              : concat(buffer)
            const meta = makeMeta({ status: 200, streaming: false })
            await emitFirstChunk(view, meta, body)  // SAB[0..meta_len+body_len] → napi.renderChunk(len)
            await sendFinal()
            mode = 'done'
          } else if (mode === 'streaming') {
            await sendFinal()
            mode = 'done'
          }
          cb()
        } catch (e) { cb(e as Error) }
      },
    })
    sink.on('error', reject)                        // C8: surfaces any cb(err) above

    const stream = renderToPipeableStream(element, {
      onShellReady() {
        // B4: feature-detect via explicit typeof — property access doesn't throw,
        // so a missing property must NOT silently fall to streaming:false.
        const pending = (stream as any).pendingSuspenseBoundaries
        const hasPendingSuspense = typeof pending === 'number' ? pending > 0 : true

        if (!hasPendingSuspense) {
          // Stay in 'buffering' mode — let onAllReady (which fires synchronously
          // after onShellReady when nothing is pending) trigger single-chunk emit
          // via _final. Pipe runs synchronously; sink._write keeps appending to
          // buffer; sink._final assembles + emits.
          stream.pipe(sink)
          return
        }

        // B3: streaming path always includes islands bootstrap (we must commit
        // headers before all islands have rendered — late islands inside pending
        // Suspense boundaries would otherwise leak a bootstrap-less first chunk).
        // ~500 bytes overhead per streaming response that doesn't use islands.
        mode = 'streaming'
        const meta = makeMeta({ status: 200, streaming: true })
        const flushBuffered = concatWithBootstrap(buffer)
        buffer.length = 0
        emitFirstChunk(view, meta, flushBuffered)
          .then(() => stream.pipe(sink))            // subsequent chunks via _write
          .catch(reject)
      },
      onShellError(err) {
        // B6: wrap the whole branch in try/catch — if ErrorBoundary itself
        // throws, we must reject (NOT hang the Promise).
        try {
          const html = renderToString(<ErrorBoundary error={err} />)
          const bodyBytes = encoder.encode(html)
          const meta = makeMeta({ status: 500, streaming: false })
          mode = 'done'                              // sink._final must no-op
          emitFirstChunk(view, meta, bodyBytes)
            .then(sendFinal, reject)
        } catch (e2) {
          // ErrorBoundary itself crashed — emit a hardcoded plain-text 500
          // (must still call sendFinal so handle_conn unblocks).
          console.error('[brust] errorBoundary threw during shell error:', e2)
          const fallback = encoder.encode('Internal Server Error')
          const meta = makeMeta({ status: 500, contentType: 'text/plain', streaming: false })
          mode = 'done'
          emitFirstChunk(view, meta, fallback).then(sendFinal, reject)
        }
      },
      onError(err) {
        // B6: post-shell crash. React's Suspense errorBoundary renders a fallback
        // into the affected chunk; rest of the page streams normally; response
        // stays 200. Log only. The sink's _final will still fire when React
        // finishes the pipe — we do NOT manually invoke sendFinal here, because
        // double-fire would hang on the second `napi.renderChunk(0)` await.
        console.error('[brust] render onError (post-shell):', err)
      },
    })
  })
}
```

**Helpers used above:**
- `emitFirstChunk(view, meta, body)` — encode `[meta_len:u16 BE][meta UTF-8][body]` into SAB, await `napi.renderChunk(workerId, totalLen)`. Splits across multiple `renderChunk` calls if `totalLen > SAB capacity` (defensive — React's emitted chunks are small).
- `emitBodyChunk(view, chunk)` — encode `[chunk]` into SAB, await `napi.renderChunk(workerId, chunk.length)`.
- `makeMeta({status, streaming, contentType?})` — JSON-stringify `{ status, contentType: contentType ?? 'text/html; charset=utf-8', headers: {}, streaming }`.
- `concatWithBootstrap(buffers)` — prepend `ISLANDS_IMPORTMAP_AND_BOOTSTRAP` bytes to the concatenation of `buffers`.
- `consumeIslandUsedFlag()` — existing module-global flag from `runtime/islands/island.tsx`. **Only meaningful when called AFTER all shell rendering completes** — which is `_final` time in the buffering path. Streaming path can't use it (late islands inside pending Suspense haven't rendered yet at `onShellReady`), so streaming always includes bootstrap.

**Backpressure:** the sink awaits `napi.renderChunk` BEFORE calling `cb()`, so only ONE chunk is in flight from JS to Rust at any time. React's pipe naturally stalls when the sink doesn't call `cb()` — matching socket back-pressure. The mpsc buffer in Rust (size 1, per §7) reflects this — one chunk in transit, no head-of-line latency hiding.

**Islands integration:** since auto-detect uses streaming-protocol always, `wrapWithIslandsBootstrap` becomes "prepend importmap + bootstrap script tags to the first chunk's body BEFORE encoding into the SAB." The script tags work fine at the top of the HTML, before any body bytes. ~500 bytes of always-included overhead per HTML response, which is acceptable — most non-trivial pages use islands, and the dead-code DCE for island-less pages is a future optimisation (out of scope here).

## 7. Rust-side chunk routing (`handle_conn` render + action branches)

### 7.1 Replacement of `dispatch_to_worker_and_send_meta_response`

The existing helper at `src/server.rs:798+` owns the Promise<u32>-then-read-SAB-then-write-response flow for BOTH the action and render branches (called from `src/server.rs:762` for render and from the action branch earlier in `handle_conn`). It also holds `entry.in_flight_guard()` for the busy-counter accounting.

**This helper is replaced by a new helper `dispatch_to_worker_and_stream_chunks`** with the same call sites. The new helper:
1. Acquires `entry.in_flight_guard()` (same busy-counter accounting — `pick_least_busy` keeps working).
2. Installs a `RenderSlot` via the RAII `RenderSlotGuard` (§5.3).
3. Spawns the tsfn call.
4. Loops the chunk channel.
5. Returns the same `DispatchControl::{Continue, CloseConn}` enum as today — call sites at the action and render branches are unchanged.

### 7.2 Implementation

```rust
async fn dispatch_to_worker_and_stream_chunks(
    s: &mut TcpStream,
    pool: &Arc<crate::pool::WorkerPool>,
    envelope_json: String,
    label: &'static str,
    on_success: impl FnOnce(&[u8]),
) -> DispatchControl {
    let Some(entry) = pool.pick_least_busy() else {
        let _ = s.write_all(http::error_503("no workers")).await;
        return DispatchControl::CloseConn;
    };
    let _busy_guard = entry.in_flight_guard();                  // busy counter (unchanged)

    let (chunk_tx, mut chunk_rx) = tokio::sync::mpsc::channel::<RenderChunk>(1);  // buffer=1, see §7.4
    {
        let mut slot = entry.render_slot.lock();
        debug_assert!(slot.is_none(), "worker {} double-dispatch", entry.id);
        *slot = Some(RenderSlot { chunk_tx });
    }
    let _slot_guard = RenderSlotGuard { entry: &entry };        // RAII clear on drop

    let render_future = entry.tsfn.call_async(envelope_json);
    tokio::pin!(render_future);

    let mut headers_written = false;
    let mut chunked = false;
    let mut buffered_first: Option<(u16, Vec<(String, String)>, String, Vec<u8>)> = None;
    let mut response_bytes_for_cache: Vec<u8> = Vec::new();     // captures bytes for on_success

    loop {
        tokio::select! {
            biased;
            Some(chunk) = chunk_rx.recv() => {
                match chunk {
                    RenderChunk::Bytes { data, ack } => {
                        if !headers_written {
                            let (meta_slice, body) = split_meta(&data)?;
                            let parsed: ChunkMeta = serde_json::from_slice(meta_slice)
                                .map_err(|_| /* 500 */)?;
                            chunked = parsed.streaming;
                            if chunked {
                                write_headers_chunked(&mut s, &parsed).await?;
                                write_chunk_framed(&mut s, body).await?;
                                // Cache is incompatible with chunked responses (cache stores
                                // the full byte stream — chunked output makes that ambiguous).
                                // Cache only the single-chunk path.
                            } else {
                                buffered_first = Some((parsed.status, parsed.headers.clone(),
                                                       parsed.content_type.clone(), body.to_vec()));
                            }
                            headers_written = true;
                        } else if chunked {
                            write_chunk_framed(&mut s, &data).await?;
                        } else {
                            // Contract violation: worker said streaming:false but sent >1 chunk.
                            warn!(worker_id = entry.id, label,
                                  "non-streaming worker emitted extra chunk; appending");
                            if let Some((_, _, _, ref mut buf)) = buffered_first {
                                buf.extend_from_slice(&data);
                            }
                        }
                        let _ = ack.send(());                    // worker proceeds; OK to drop
                    }
                    RenderChunk::Final { ack } => {
                        if chunked {
                            write_chunked_terminator(&mut s).await?;
                        } else if let Some((status, headers, ct, body)) = buffered_first.take() {
                            let resp = build_single_response_bytes(status, &headers, &ct, &body);
                            response_bytes_for_cache = resp.clone();
                            s.write_all(resp).await?;
                        }
                        let _ = ack.send(());
                        break;
                    }
                }
            }
            result = &mut render_future => {
                match result {
                    Ok(_promise_result) => {
                        // Worker's tsfn Promise<()> resolved BEFORE we saw Final on the channel.
                        // C5: if streaming, we must still emit the chunked terminator —
                        // browser otherwise sees ERR_INCOMPLETE_CHUNKED_ENCODING even though
                        // the render itself succeeded.
                        let dropped = chunk_rx.len();             // C7: log queued chunks
                        if dropped > 0 {
                            warn!(worker_id = entry.id, label, dropped,
                                  "worker returned without Final signal; queued chunks dropped");
                        } else {
                            warn!(worker_id = entry.id, label,
                                  "worker returned without Final signal");
                        }
                        if chunked {
                            let _ = write_chunked_terminator(&mut s).await;
                        } else if let Some((status, headers, ct, body)) = buffered_first.take() {
                            let resp = build_single_response_bytes(status, &headers, &ct, &body);
                            response_bytes_for_cache = resp.clone();
                            let _ = s.write_all(resp).await;
                        }
                        break;
                    }
                    Err(e) => {
                        error!(worker_id = entry.id, label, error = %e,
                               "render tsfn rejected");
                        if !headers_written {
                            let _ = s.write_all(http::error_500()).await;
                        }
                        // Mid-stream rejection: connection already committed; hang up.
                        // Client sees truncated chunked stream → ERR_INCOMPLETE_CHUNKED_ENCODING.
                        break;
                    }
                }
            }
        }
    }

    if !response_bytes_for_cache.is_empty() {
        on_success(&response_bytes_for_cache);                   // cache.insert (single-chunk only)
    }
    DispatchControl::Continue                                    // _slot_guard's Drop clears render_slot
}
```

### 7.3 Key invariants

- **Single-chunk path** (`streaming: false`): Rust buffers the lone chunk, waits for Final, emits ONE `HTTP/1.1 200 OK\r\nContent-Length: N\r\n...\r\n\r\n<body>` via `write_all`. Bytes-on-wire identical to today's `renderToString` output for pages with no Suspense in the tree (per §1 criterion #1).
- **Multi-chunk path** (`streaming: true`): HTTP/1.1 chunked transfer-encoding — headers ship as soon as the first chunk arrives (the TTFB win).
- **C5 chunked-terminator guarantee:** the `Ok(...)` arm of the `select!` race ALWAYS emits `0\r\n\r\n` if `chunked && headers_written` — covers the "worker forgot `renderChunk(0)`" path so the browser doesn't see a truncated stream on an otherwise-successful render.
- **C7 dropped-chunks visibility:** `chunk_rx.len()` is logged with the warn so post-incident debugging sees both the worker_id and the queue depth.
- **Slot lifecycle:** `_slot_guard: RenderSlotGuard` is `Drop`-cleared, surviving panic, cancellation, and early returns.
- **Cache compatibility:** only the single-chunk path populates `response_bytes_for_cache` → `on_success` cache.insert. Chunked responses are never cached (cache layer stores full byte streams; chunked framing is ambiguous post-decode).

### 7.4 mpsc buffer sizing

Buffer is **1** (not 4 — agent feedback C4). The sink in JS awaits `napi.renderChunk` BEFORE calling `cb()`, so only ONE chunk is ever in flight from JS to Rust. A larger buffer would mask socket back-pressure for N-1 chunks of latency without any throughput benefit.

## 8. Error matrix

| Failure point | Detection | Client outcome | Server log |
|---|---|---|---|
| `renderToPipeableStream` throws synchronously | try/catch in `renderBranchStreaming` body | 500 + plain-text fallback (no errorBoundary because React itself failed) | `error!` log |
| Pre-shell render crash | `onShellError(err)` callback | 500 + errorBoundary HTML, single-chunk (headers not yet written) | `error!` log w/ stack |
| `ErrorBoundary` itself throws inside `onShellError` (B6) | Inner try/catch in `onShellError` | 500 + plain-text "Internal Server Error", single-chunk — `sendFinal` still fires so handle_conn unblocks | `error!` log: "errorBoundary threw during shell error" |
| Post-shell render crash | `onError(err)` callback | React's Suspense errorBoundary renders the affected chunk; rest streams normally; response stays 200. `_final` STILL fires when React closes the pipe (B6 — onError is logging-only by design) | `error!` log |
| React aborts the stream post-shell (rare, e.g. internal pipe error) | sink's `_final` never invoked → handle_conn would hang | The sink emits `'error'` if React calls `sink.destroy(err)`; `sink.on('error', reject)` rejects the renderer Promise → `render_future` Err arm in `select!` → loop exits, slot cleared via Drop guard | `error!` log |
| Worker JS crash (renderer Promise rejects) | `render_future` Err arm in `select!` | If pre-headers: `error_500()`; if mid-stream: hang up (truncated chunked stream → browser shows `ERR_INCOMPLETE_CHUNKED_ENCODING`) | `error!` log w/ worker_id + label |
| `napi_render_chunk` ack drop (client disconnected mid-stream) | `ack_rx.await` returns `Err(RecvError)` in `napi_render_chunk` | `napi_render_chunk` returns `NapiResult::Err` (NOT hang) → worker's `renderChunk` Promise rejects → sink's `_write` calls `cb(err)` (C8) → sink emits `'error'` → renderer Promise rejects → loop exits cleanly, slot cleared via Drop guard | `info!` log |
| Single chunk exceeds SAB capacity | `len > buf_len` bounds check in `napi_render_chunk` | Returns `NapiResult::Err` to worker → worker's sink propagates → renderer Promise rejects → 500 plain-text via Err arm | `error!` log w/ requested len + capacity |
| Worker returns without `renderChunk(0)` | `render_future` Ok arm while loop still running | C5: emit chunked terminator if streaming, OR flush buffered single-chunk if not. C7: log includes worker_id, label, and `chunk_rx.len()` (dropped-but-queued count) | `warn!` log |
| Client disconnects mid-chunk | `s.write_all` returns Err inside `write_chunk_framed` | The `?` propagates the error out of the chunk arm → loop exits with `?` propagated up. `_slot_guard` Drop clears slot. Worker sees ack drop on its next `napi.renderChunk` call → cascades through sink C8 path | `info!` log |
| `sink._write` rejection propagation (C8) | `napi.renderChunk` throws OR rejects inside sink's `_write` | The await is inside try/catch; on rejection, `cb(err)` (NOT `cb()`) — sink emits `'error'` → `sink.on('error', reject)` rejects the outer Promise → renderer tsfn rejects → Rust's `render_future` Err arm fires | `error!` log JS-side |

**Wire-level safety:** chunked stream truncation is RFC 9112 §7.1-compliant — a missing `0\r\n\r\n` terminator is interpreted by browsers as `ERR_INCOMPLETE_CHUNKED_ENCODING` and by `fetch`'s stream reader as `TypeError: network error`. Acceptable for the truncation cases above.

**`handle_conn` hang prevention guarantee:** every error path above EITHER triggers the Final signal (worker emits `napi.renderChunk(0)` via `sendFinal` in `onShellError` / sink's `_final`) OR rejects the renderer Promise (which fires `render_future` Err arm in the `select!`). There is no documented path that leaves handle_conn waiting indefinitely. Spec-level test in §9 runtime-unit #4 covers the post-shell crash case explicitly.

## 9. Testing

**9 new Rust unit tests** (`src/render_stream.rs::tests` + `src/pool.rs::tests`):

1. `meta_parse_with_streaming_true` — meta layout round-trip
2. `meta_parse_with_streaming_false` — Content-Length path meta
3. `chunked_hex_prefix_format` — `<hex>\r\n<bytes>\r\n` formatting at boundary sizes (1 byte, 4 KB, 256 KB)
4. `chunked_terminator_format` — `0\r\n\r\n` exact bytes
5. `render_slot_set_clear` — `TsfnEntry::render_slot` lifecycle under Mutex (NOT the existing `in_flight: AtomicU32` busy counter)
6. `render_slot_guard_drop_clears_slot` — `RenderSlotGuard`'s `Drop` impl unconditionally clears `render_slot` on panic / early return / cancellation
7. `chunk_channel_send_recv` — `RenderChunk` enum ack round-trip; ack drop returns `Err(RecvError)` not hang
8. `len_bounds_check_rejects_oversize` — `napi_render_chunk` returns Err when `len > buf_len`
9. `single_chunk_buffer_to_content_length` — buffered first-chunk → HTTP/1.1 response w/ exact `Content-Length`

**6 new runtime unit tests** (`runtime/render/stream.test.ts`):

1. `renderBranchStreaming` w/ no Suspense → ONE `renderChunk(len)` + `renderChunk(0)`, `streaming: false` in meta, bootstrap injected iff `<Island>` rendered (islands flag conditional preserved on buffering path)
2. `renderBranchStreaming` w/ pending Suspense → multiple `renderChunk(len)` calls, `streaming: true` in meta, bootstrap ALWAYS injected (B3 streaming-path policy), eventually `renderChunk(0)`
3. `renderBranchStreaming` w/ pre-shell crash → ONE chunk w/ 500 + errorBoundary HTML, `streaming: false`, `renderChunk(0)` fires
4. `renderBranchStreaming` w/ post-shell crash → React's Suspense boundary handles it; `onError` logged; sink's `_final` STILL fires `renderChunk(0)` so no hang (B6 guarantee)
5. `renderBranchStreaming` w/ ErrorBoundary that throws inside `onShellError` → emits 500 plain-text fallback, `renderChunk(0)` fires (B6 inner try/catch)
6. `pendingSuspenseBoundaries` feature-detect → when property is `undefined`, defaults to `streaming: true` (B4 typeof-check fallback test)

**3 new integration tests** (`tests/integration.test.ts`, ports 38230-38232):

1. **Single-chunk regression** — `GET /` (no Suspense in tree) → 200 + `Content-Length` header (NOT `Transfer-Encoding`) + body bytes match today's renderToString output byte-for-byte. The existing `serves rendered html via worker pool` test continues passing unchanged + a new explicit assertion on `Content-Length` presence and `Transfer-Encoding` absence.
2. **Streaming round-trip** — `GET /slow-suspense` → asserts `Transfer-Encoding: chunked`, asserts shell HTML received before suspended-content, asserts terminator `0\r\n\r\n` at end. TTFB measured under 50ms despite suspended content resolving at 200ms.
3. **Mid-stream disconnect + slot recovery** — Open chunked response, close socket mid-chunk, then issue a SECOND request to the same worker. The second request MUST succeed (proves `_slot_guard` Drop cleared the leaked slot; without the Drop guard, the second request would `debug_assert` in dev or silently overwrite the slot in release). Probe: send back-to-back requests with `BRUST_WORKERS=1` and disconnect the first mid-stream via `socket.destroy()` from the client side.

**Example app changes** (`example/hello-world/`):
- New route `/slow-suspense` with `<Suspense fallback={<Spinner />}><SlowData /></Suspense>` where `SlowData` throws a Promise that resolves after 200ms.
- One new component file (`components/SlowSuspense.tsx`).
- `routes.tsx` entry.

**Baseline preservation:** all 73 Rust + 92 runtime + 63 integration tests must pass UNCHANGED. The single-chunk wire path is byte-identical to today's `renderToString` output for pages with no Suspense boundaries (covered explicitly by integration test #1). Pages WITH Suspense boundaries that don't pause are semantically equivalent but may include React hydration markers — the example app's existing routes contain no Suspense, so all 63 integration tests stay on the byte-identical path.

## 10. Limits & deferred

**Current limits (MVP):**
- One in-flight render per worker (matches today's single-threaded JS model)
- Chunk size capped at SAB capacity (256 KB) — sink adapter splits oversized React chunks
- No HTTP/2 support — chunked transfer-encoding is HTTP/1.1-only (matches today's server)
- No `Accept-Encoding: gzip` for streaming responses — chunks ship uncompressed (gzip-while-streaming would need streaming gzip, deferred)

**Deferred (out of scope for this spec):**
- Removing the islands bootstrap overhead for island-less pages (DCE based on a static flag in the route)
- Custom `bootstrapScripts` / `bootstrapModules` passthrough for fine-grained client hydration control
- Per-route streaming opt-out (if a future use case wants `Content-Length` even with Suspense — likely unnecessary)
- HTTP/2 server push for the bootstrap/importmap chunks
- Concurrent renders per worker (would require multi-slot — currently impossible since JS thread serialises)
