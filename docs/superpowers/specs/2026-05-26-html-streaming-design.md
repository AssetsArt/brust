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

1. **Single-chunk bytes-identical to today** — `GET /` on the example app emits an HTTP/1.1 response with `Content-Length` (NOT `Transfer-Encoding`), and the body bytes match what `renderToString` would emit (modulo islands bootstrap injection, which is unchanged).
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
├── lib.rs                          # +napi_render_chunk, signature change on register_renderer
├── pool.rs                         # +InFlightSlot field on TsfnEntry, slot accessors
├── render_stream.rs                # NEW — chunked encoding helpers + meta layout
└── server.rs                       # render branch in handle_conn refactored to chunk loop

runtime/
├── index.ts                        # Renderer type changes from (env)→Promise<number> to (env)→Promise<void>
├── routes.ts                       # makeRenderer dispatches to renderBranchStreaming
└── render/
    └── stream.ts                   # NEW — renderBranchStreaming + sink adapter for React's pipe
```

One new Rust module (`render_stream.rs`), one new TS module (`runtime/render/stream.ts`). No new dependencies (React 18's `renderToPipeableStream` is already in `react-dom/server`).

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

**Renderer registration signature change** (`src/lib.rs::register_renderer`):

```rust
// OLD: tsfn returns Promise<u32> (byte length packed into SAB)
type RendererTsfn = ThreadsafeFunction<String, ErrorStrategy::CalleeHandled, String, false, true, 0>;
// where Output = u32

// NEW: tsfn returns Promise<()> — chunks delivered via napi_render_chunk side channel
type RendererTsfn = ThreadsafeFunction<String, (), ErrorStrategy::CalleeHandled, String, false, true, 0>;
```

**One new NAPI function** (replaces the implicit "return byte length" contract):

```rust
#[napi]
pub async fn napi_render_chunk(worker_id: u32, len: u32) -> NapiResult<()>
```

**Contract:**
- `len > 0` → Rust reads SAB[0..len] from the worker's pre-registered buffer, sends `RenderChunk::Bytes { data, ack }` through `entry.in_flight`'s `chunk_tx`, awaits `ack_rx`. Resolves after the chunk lands on the socket → worker proceeds to the next chunk.
- `len == 0` → Final signal. Sends `RenderChunk::Final { ack }`, awaits ack. Rust writes chunked terminator (if streaming) OR flushes the buffered single-chunk response (if `streaming: false`), then resolves the Promise immediately.
- Worker MUST call `napi.renderChunk(0)` exactly once per request — even single-chunk responses — to close the channel and let `handle_conn` proceed to the next request.

**Per-worker in-flight slot** (new field on `TsfnEntry`):

```rust
pub struct TsfnEntry {
    pub id: u32,
    pub tsfn: RendererTsfn,
    pub buf_ptr: BufPtr,
    pub buf_len: usize,
    pub in_flight: parking_lot::Mutex<Option<InFlightSlot>>,  // NEW
    // ... existing fields unchanged
}

pub struct InFlightSlot {
    pub chunk_tx: tokio::sync::mpsc::Sender<RenderChunk>,
}

pub enum RenderChunk {
    Bytes { data: Vec<u8>, ack: tokio::sync::oneshot::Sender<()> },
    Final { ack: tokio::sync::oneshot::Sender<()> },
}
```

- `handle_conn` writes the slot BEFORE `tsfn.call_async`, clears it after the chunk loop exits.
- Slot collision (two `call_async` racing on one worker) is impossible — JS thread is single-threaded → only one render Promise pending at a time. A `debug_assert!(slot.is_none(), ...)` documents the invariant.

## 6. JS-side renderer wrapper

**`makeRenderer` (in `runtime/routes.ts`) becomes streaming-native.** The wrapper owns the SAB + TextEncoder + the `napi.renderChunk` calls; per-route author code stays untouched.

```typescript
function makeRenderer(routes, view, opts): (envelope: string) => Promise<void> {
  return async (envelope_json) => {
    const call = JSON.parse(envelope_json) as RouteCall
    if (call.kind === 'action') return actionBranchStreaming(call, ..., view, encoder)
    if (call.kind === 'sse')    return sseBranch(call, ...)         // unchanged; doesn't use renderChunk
    if (call.kind === 'ws')     return wsBranch(call, ...)          // unchanged; doesn't use renderChunk
    return renderBranchStreaming(call, ..., view, encoder)
  }
}
```

**Action/SSE/WS branches:** action becomes single-shot-via-stream (one `renderChunk(len)` + `renderChunk(0)`); SSE and WS bypass the chunk channel entirely (their dispatch tsfn returns after `signalOpen`, NOT after the conn closes — Rust's `handle_conn` for those branches uses its own per-conn channel set up before the tsfn call, and never reads from `entry.in_flight`).

**The streaming render branch** (`runtime/render/stream.ts`):

```typescript
async function renderBranchStreaming(call, routes, view, encoder, ctx): Promise<void> {
  // [path match + middleware compose + chain run + build <App /> element — same as today]

  return new Promise<void>((resolve, reject) => {
    const sink = makeSinkWritable({
      view, encoder, workerId,
      onFinal: () => napi.renderChunk(workerId, 0),
    })

    const stream = renderToPipeableStream(element, {
      onShellReady() {
        // Decide chunked vs Content-Length BEFORE pipe starts emitting.
        // pendingSuspenseBoundaries is a stable React 18 internal; if it goes
        // missing in a future minor, the catch-clause defaults to streaming:true
        // (correct, just slightly less efficient — chunked instead of CL).
        let streaming: boolean
        try { streaming = (stream as any).pendingSuspenseBoundaries > 0 }
        catch { streaming = true }

        const meta = JSON.stringify({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          headers: {},
          streaming,
        })
        // Sink prepends [meta_len:u16 BE][meta] to the first chunk's body on its
        // first _write. Subsequent _writes are body-only.
        sink.armMetaPrefix(meta)
        sink.on('finish', () => resolve())   // _final already invoked renderChunk(0)
        sink.on('error', reject)
        stream.pipe(sink)
      },
      onShellError(err) {
        // Pre-shell crash → 500 + errorBoundary HTML, single-chunk, Content-Length.
        const html = renderToString(<ErrorBoundary error={err} />)
        const bodyBytes = encoder.encode(html)
        const meta = JSON.stringify({
          status: 500, contentType: 'text/html; charset=utf-8', headers: {}, streaming: false,
        })
        // Bypass the sink entirely — emit one synthesised chunk + final.
        writeFirstChunkDirect(view, meta, bodyBytes)
          .then(() => napi.renderChunk(workerId, 0))
          .then(resolve, reject)
      },
      onError(err) {
        // Post-shell crash → React's Suspense errorBoundary handles user-facing HTML.
        // Server-side: log only; response stays 200.
        console.error('[brust] render onError (post-shell):', err)
      },
    })
  })
}
```

**The sink (`makeSinkWritable`)** is a Node.js `Writable` adapter:
- **`armMetaPrefix(meta)`** — call once before piping; sets the `[meta_len:u16 BE][meta]` prefix that will be prepended to the very first `_write` call.
- **`_write(chunk, enc, cb)`** — if armed: encode `[metaPrefix, chunk]` into SAB[0..len], clear the arm. Else: encode `[chunk]` into SAB[0..len]. If `len > SAB capacity`: split into multiple `napi.renderChunk` calls. Await `napi.renderChunk(workerId, len)`, then `cb()` to release backpressure.
- **`_final(cb)`** — invoke `onFinal()` (→ `napi.renderChunk(workerId, 0)`), then `cb()`.

This inherits React's backpressure automatically — the pipe stalls if Rust's socket is slow.

**Islands integration:** since auto-detect uses streaming-protocol always, `wrapWithIslandsBootstrap` becomes "prepend importmap + bootstrap script tags to the first chunk's body BEFORE encoding into the SAB." The script tags work fine at the top of the HTML, before any body bytes. ~500 bytes of always-included overhead per HTML response, which is acceptable — most non-trivial pages use islands, and the dead-code DCE for island-less pages is a future optimisation (out of scope here).

## 7. Rust-side chunk routing (`handle_conn` render branch)

```rust
// Replace the existing tsfn-call-async-returning-bytelength block with:

let (chunk_tx, mut chunk_rx) = tokio::sync::mpsc::channel::<RenderChunk>(4);
{
    let mut slot = entry.in_flight.lock();
    debug_assert!(slot.is_none(), "worker {} double-dispatch (JS thread should serialise)", entry.id);
    *slot = Some(InFlightSlot { chunk_tx });
}

let render_future = entry.tsfn.call_async(envelope_json);
tokio::pin!(render_future);

let mut headers_written = false;
let mut chunked = false;
let mut buffered_first: Option<(u16, Vec<(String, String)>, String, Vec<u8>)> = None;

loop {
    tokio::select! {
        biased;
        Some(chunk) = chunk_rx.recv() => {
            match chunk {
                RenderChunk::Bytes { data, ack } => {
                    if !headers_written {
                        let (meta, body) = split_meta(&data);
                        let parsed: ChunkMeta = serde_json::from_slice(meta).map_err(|_| /* 500 */)?;
                        chunked = parsed.streaming;
                        if chunked {
                            write_headers_chunked(&mut s, &parsed).await?;
                            write_chunk_framed(&mut s, body).await?;
                        } else {
                            buffered_first = Some((parsed.status, parsed.headers, parsed.content_type, body.to_vec()));
                        }
                        headers_written = true;
                    } else {
                        if chunked {
                            write_chunk_framed(&mut s, &data).await?;
                        } else {
                            warn!("non-streaming worker emitted second chunk; appending");
                            if let Some((_, _, _, ref mut buf)) = buffered_first { buf.extend_from_slice(&data); }
                        }
                    }
                    let _ = ack.send(());
                }
                RenderChunk::Final { ack } => {
                    if chunked {
                        write_chunked_terminator(&mut s).await?;
                    } else if let Some((status, headers, ct, body)) = buffered_first.take() {
                        write_single_response(&mut s, status, &headers, &ct, body).await?;
                    }
                    let _ = ack.send(());
                    break;
                }
            }
        }
        result = &mut render_future => {
            match result {
                Ok(()) => {
                    // Worker returned without Final — flush buffered single-chunk if present.
                    if headers_written && !chunked {
                        if let Some((status, headers, ct, body)) = buffered_first.take() {
                            warn!("worker returned without Final signal — flushing");
                            write_single_response(&mut s, status, &headers, &ct, body).await?;
                        }
                    }
                    break;
                }
                Err(e) => {
                    error!("render tsfn failed: {e}");
                    if !headers_written {
                        let _ = s.write_all(http::error_500()).await;
                    }
                    break;
                }
            }
        }
    }
}

entry.in_flight.lock().take();
```

**Key invariants:**
- Single-chunk path is bytes-identical to today: Rust buffers the only chunk, waits for Final, emits one `HTTP/1.1 200 OK\r\nContent-Length: N\r\n...\r\n\r\n<body>` in one `write_all`.
- Multi-chunk path uses HTTP/1.1 chunked transfer-encoding — headers go out as soon as the first chunk arrives (the TTFB win).
- The `select!` race between chunks and renderer-future completion handles worker-crash-mid-stream cleanly — the future-arm fires the moment the Promise rejects.
- Slot collision is a `debug_assert` — JS thread serialisation makes it logically impossible, but cheap to verify in dev builds.

## 8. Error matrix

| Failure point | Detection | Client outcome | Server log |
|---|---|---|---|
| `renderToPipeableStream` throws synchronously | try/catch in `renderBranchStreaming` | 500 + errorBoundary HTML, single-chunk | `error!` log |
| Pre-shell render crash | `onShellError(err)` callback | 500 + errorBoundary HTML, single-chunk (headers not yet written) | `error!` log w/ stack |
| Post-shell render crash | `onError(err)` callback | React's Suspense errorBoundary renders the affected chunk; rest streams normally | `error!` log; response stays 200 |
| Worker JS crash (renderer rejects) | `render_future` Err arm in `select!` | If pre-headers: `error_500()`; if mid-stream: hang up (client sees truncated chunked stream) | `error!` log |
| `napi_render_chunk` ack drop (client disconnected mid-stream) | `ack_rx.await` Err in `napi_render_chunk` | Worker's `renderChunk` rejects → renderer Promise rejects → `select!` future-arm fires → loop exits cleanly, slot cleared | `warn!` log w/ disconnect reason |
| Single chunk exceeds SAB capacity | `len > buf_len` bounds check in `napi_render_chunk` | Returns NAPI Err to worker → worker emits 500 errorBoundary | `error!` log |
| Worker returns without `renderChunk(0)` | `render_future` Ok arm while loop still running | Flush any buffered single-chunk, then exit loop with `warn!` | `warn!` log |
| Client disconnects mid-chunk | `s.write_all` returns Err in `write_chunk_framed` | Drop ack → worker's `renderChunk` rejects → React aborts the pipe via the sink's `destroy` callback | `info!` log |

**Wire-level safety:** chunked stream truncation is RFC 9112 §7.1-compliant — a missing `0\r\n\r\n` terminator is interpreted by browsers as `ERR_INCOMPLETE_CHUNKED_ENCODING` and by `fetch`'s stream reader as `TypeError: network error`. Acceptable for the truncation cases above.

## 9. Testing

**8 new Rust unit tests** (`src/render_stream.rs::tests`):

1. `meta_parse_with_streaming_true` — meta layout round-trip
2. `meta_parse_with_streaming_false` — Content-Length path meta
3. `chunked_hex_prefix_format` — `<hex>\r\n<bytes>\r\n` formatting at boundary sizes (1 byte, 4 KB, 256 KB)
4. `chunked_terminator_format` — `0\r\n\r\n` exact bytes
5. `in_flight_slot_set_clear` — `TsfnEntry::in_flight` lifecycle under Mutex
6. `chunk_channel_send_recv` — `RenderChunk` enum ack round-trip
7. `len_bounds_check_rejects_oversize` — `napi_render_chunk` returns Err when `len > buf_len`
8. `single_chunk_buffer_to_content_length` — buffered first-chunk → HTTP/1.1 response w/ exact `Content-Length`

**4 new runtime unit tests** (`runtime/render/stream.test.ts`):

1. `renderBranchStreaming` w/ no Suspense → ONE `renderChunk(len)` + `renderChunk(0)`, `streaming: false` in meta
2. `renderBranchStreaming` w/ pending Suspense → multiple `renderChunk(len)` calls, `streaming: true` in meta, eventually `renderChunk(0)`
3. `renderBranchStreaming` w/ pre-shell crash → ONE chunk w/ 500 + errorBoundary, `streaming: false`
4. `renderBranchStreaming` w/ post-shell crash → React's Suspense boundary handles it; test asserts `onError` logged but `renderChunk(0)` still fires (no hang)

**3 new integration tests** (`tests/integration.test.ts`, ports 38230-38232):

1. **Single-chunk regression** — `GET /` (no Suspense) → 200 + `Content-Length` header (NOT `Transfer-Encoding`) + body bytes match today's renderToString output (the existing `serves rendered html via worker pool` test should still pass unchanged + a new explicit assertion on `Content-Length` presence)
2. **Streaming round-trip** — `GET /slow-suspense` → asserts `Transfer-Encoding: chunked`, asserts shell HTML received before suspended-content, asserts terminator at end. TTFB measured to be < 50ms despite suspended content resolving at 200ms.
3. **Mid-stream disconnect** — Open chunked response, close socket mid-chunk, assert server logs the disconnect AND a subsequent request to the same worker succeeds (probe via a second request after the disconnect — if the slot leaked, the second request would either hang OR `debug_assert` would fire in dev builds).

**Example app changes** (`example/hello-world/`):
- New route `/slow-suspense` with `<Suspense fallback={<Spinner />}><SlowData /></Suspense>` where `SlowData` throws a Promise that resolves after 200ms.
- One new component file (`components/SlowSuspense.tsx`).
- `routes.tsx` entry.

**Baseline preservation:** all 73 Rust + 92 runtime + 63 integration tests must pass UNCHANGED — the single-chunk wire path is byte-identical to today's `renderToString` output (integration test #1 above verifies the wire shape explicitly).

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
