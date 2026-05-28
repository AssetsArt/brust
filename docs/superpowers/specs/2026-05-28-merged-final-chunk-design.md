# Merged Final Chunk — eliminate redundant napi crossing on buffering finals

**Date:** 2026-05-28
**Author:** detoro (autonomous pipeline)
**Status:** Spec — pending review

## Goal

Eliminate the redundant second `napi_render_chunk` crossing per render on the **buffering** path (`/` SSR, server-fn responses, error responses). Profile shows the two napi crossings together account for ~90% of brust's c=1 runtime overhead on `/` (~70µs total). Merging them removes one full tsfn round-trip + channel ack cycle + JS Promise hop, expected to save **~20–35 µs per buffering render** at c=1.

## Non-goals

- **Streaming path unchanged.** Streaming responses send N body chunks then a separate close — there is nothing to merge. The new API is buffering-only.
- **Allocation cleanup (concatBuffers / injectCssLink / `.slice()` defensive copies).** Profile shows these collectively cost <3 µs/req. Out of scope; defer.
- **Single-pass SAB assembly** (write bootstrap+body+CSS directly into SAB without intermediate Uint8Array). Architectural change; defer.
- **Move CSS injection to Rust.** Sub-project of its own; defer.
- **POST `/_brust/action/*` path.** POST already uses the buffering shape (`emitSingleChunkResponse` at `runtime/routes.ts:799-800`). Its call-site updates land for free with this work; no separate scope.

## High-level architecture

### Current shape (per buffering render)

```
JS worker                    Rust handle_conn
─────────                    ────────────────
napi.renderChunk(wid, len)  ─► chunk_tx.send(Bytes { data, ack })
                                └─ parse meta, buffer body
                                └─ ack.send(())
await (resolve promise)     ◄──┘
napi.renderChunk(wid, 0)    ─► chunk_tx.send(Final { ack })
                                └─ build_single_response_bytes
                                └─ s.write_all(resp).await
                                └─ ack.send(())
await (resolve promise)     ◄──┘
```

Two tsfn round-trips, two channel sends, two ack waits, two JS Promise resolutions.

### Proposed shape (per buffering render)

```
JS worker                       Rust handle_conn
─────────                       ────────────────
napi.renderChunkFinal(wid, len) ─► chunk_tx.send(BytesAndFinal { data, ack })
                                    └─ parse meta, buffer body
                                    └─ build_single_response_bytes
                                    └─ s.write_all(resp).await
                                    └─ ack.send(())
await (resolve promise)         ◄──┘
```

One tsfn round-trip, one channel send, one ack wait, one JS Promise resolution.

### Components affected

| Component | Change |
|---|---|
| `src/pool.rs` | Add `RenderChunk::BytesAndFinal { data, ack }` variant |
| `src/lib.rs` | Add `napi_render_chunk_final(worker_id: u32, len: u32) -> NapiResult<()>` |
| `src/server.rs` | Handle `BytesAndFinal` in `dispatch_to_worker_and_stream_chunks` chunk loop (parse meta + buffer + finalize + write + ack — equivalent to receiving `Bytes` then `Final` consecutively) |
| `runtime/index.d.ts` (auto-gen) | New `napiRenderChunkFinal(workerId, len)` export |
| `runtime/render/stream.ts` | `RenderBranchStreamingArgs.napi` gains `renderChunkFinal`; buffering-path `_final` uses it; 4 call-sites collapse (success + 3 error paths) |
| `runtime/routes.ts` | `napi` wrapper objects (lines 431-432, 601-602) gain `renderChunkFinal`; `emitSingleChunkResponse` (lines 791-792, 799-800) uses it |

No changes to:
- `napi_render_chunk` binding itself — keeps its existing 2-arg signature
- Streaming path in `stream.ts` (lines 121, 141, 210, 228, 241, 258 — these all send N body chunks then a separate `napi.renderChunk(wid, 0)` close; `BytesAndFinal` does not apply)
- SSE / WS paths (different dispatch entirely — `dispatch_sse`, `dispatch_ws`)
- `check_chunk_dispatch` bounds-check (the new fn reuses it identically)

### Why `BytesAndFinal` and not `Final { data: Option<Vec<u8>> }`

Cleaner. `RenderChunk` is two existing variants; a third with explicit semantics avoids a constructor that admits a "Final with no data" case that already has a variant (`Final {}`). Pattern-matching at the dispatch site stays exhaustive without needing `data: None` to mean the same thing as `Final`.

### Why a new napi fn and not an arg-flag on the existing fn

`napi_render_chunk(worker_id, len)` is the streaming-path workhorse — called once per body chunk. Adding a `final: bool` arg means every streaming call now passes `false`, polluting the hot path. A separate `napi_render_chunk_final` keeps the streaming call-site unchanged and gives the buffering call-site a 1:1 replacement.

## File changes

### `src/pool.rs` (additive)

Add to the `RenderChunk` enum:

```rust
pub enum RenderChunk {
    Bytes { data: Vec<u8>, ack: tokio::sync::oneshot::Sender<()> },
    Final { ack: tokio::sync::oneshot::Sender<()> },
    /// Combined Bytes + Final. Used by buffering-path callers (single-chunk
    /// responses) to eliminate one tsfn round-trip per render. handle_conn
    /// must process this as if it received Bytes-then-Final consecutively.
    BytesAndFinal { data: Vec<u8>, ack: tokio::sync::oneshot::Sender<()> },
}
```

### `src/lib.rs` (additive)

```rust
/// Buffering-path finalizer: equivalent to `napi_render_chunk(_, len)` followed
/// by `napi_render_chunk(_, 0)` but in a single tsfn crossing. Cuts JS-side
/// per-request overhead by one full Promise+await cycle. Streaming-path callers
/// must NOT use this — they send N body chunks then a separate `Final`.
///
/// Same error semantics as `napi_render_chunk`: bounds check, slot lookup,
/// ack-receiver-dropped → NAPI Err (not hang).
#[napi]
pub async fn napi_render_chunk_final(worker_id: u32, len: u32) -> NapiResult<()> {
    let entry = state()
        .pool
        .entry(worker_id)
        .ok_or_else(|| napi::Error::from_reason(format!("worker {} not registered", worker_id)))?;
    let chunk_tx =
        crate::render_stream::check_chunk_dispatch(&entry.render_slot, len, entry.buf_len)
            .map_err(napi::Error::from_reason)?;

    let (ack_tx, ack_rx) = tokio::sync::oneshot::channel::<()>();
    // SAFETY: same as napi_render_chunk — BufPtr pinned at register time, len bounds-checked.
    let data = unsafe { std::slice::from_raw_parts(entry.buf_ptr.0, len as usize) }.to_vec();
    chunk_tx
        .send(crate::pool::RenderChunk::BytesAndFinal { data, ack: ack_tx })
        .await
        .map_err(|_| napi::Error::from_reason("render chunk channel closed (handle_conn gone)"))?;
    ack_rx
        .await
        .map_err(|_| napi::Error::from_reason("ack dropped — handle_conn torn down mid-chunk"))?;
    Ok(())
}
```

The `len == 0` case is degenerate (buffering finalize with no content) but legal — produces an empty body response. Not specifically guarded; existing `check_chunk_dispatch` allows `len = 0`.

### `src/server.rs` (additive match arm)

In `dispatch_to_worker_and_stream_chunks`'s chunk loop (around line 970), add a third match arm for `BytesAndFinal`. Body matches the existing `Bytes` path's buffering branch (parse meta, buffer body, `headers_written = true`) followed by the existing `Final` path's non-chunked branch (`build_single_response_bytes` + `write_all` + ack + break).

This is the "buffering" use-case only — the arm must reject the `chunked == true` case explicitly (a chunked-mode worker sending `BytesAndFinal` is a misuse; warn and proceed as if it sent Bytes-then-Final).

Test coverage for the new arm lives at the Rust unit-test layer (existing `src/pool.rs` tests + a new test exercising the variant) and at the integration layer (existing buffering-path tests pass unchanged because the response wire format is identical).

### `runtime/render/stream.ts`

`RenderBranchStreamingArgs.napi` gains `renderChunkFinal`:

```ts
napi: {
  renderChunk:      (workerId: bigint, len: number, sabBytes: Uint8Array) => Promise<void>
  renderChunkFinal: (workerId: bigint, len: number, sabBytes: Uint8Array) => Promise<void>
}
```

Four call-sites change inside `renderBranchStreaming`:

1. Buffering success (`_final`, currently lines 136–137):
   - Before: `await napi.renderChunk(workerId, len, view); await sendFinal()`
   - After: `await napi.renderChunkFinal(workerId, len, view); finalSent = true; resolve()`

2. `onShellError` 500 path (currently lines 226–228):
   - Before: `await napi.renderChunk(workerId, len, view); await sendFinal()`
   - After: `await napi.renderChunkFinal(workerId, len, view); resolve()`

3. `onShellError` errorBoundary-threw path (currently lines 238–241):
   - Same as (2).

4. Outer catch (currently lines 255–258):
   - Same as (2).

`sendFinal()` stays — the streaming-path `_final` branch (line 141) still uses it after the last body chunk.

### `runtime/routes.ts`

Two `napi` wrapper objects (lines 431-432 and 601-602) gain `renderChunkFinal`:

```ts
napi: {
  renderChunk: async (workerId, len, _view) => {
    await (native as any).napiRenderChunk(Number(workerId), len)
  },
  renderChunkFinal: async (workerId, len, _view) => {
    await (native as any).napiRenderChunkFinal(Number(workerId), len)
  },
}
```

`emitSingleChunkResponse` (lines 759-801) replaces both pairs of `renderChunk + renderChunk(_, 0)` calls (error path 791-792, content path 799-800) with single `renderChunkFinal` calls.

## Behavior / concurrency invariants

- **Equivalence.** `renderChunkFinal(w, n)` produces a byte-identical HTTP response to `renderChunk(w, n)` followed by `renderChunk(w, 0)` for the same SAB content. Wire format unchanged.
- **Ordering.** The single ack from `BytesAndFinal` arrives exactly once, after the socket write completes. Worker awaits on it; same lifecycle as the old `Final` ack.
- **Error path.** If the socket write fails inside `BytesAndFinal`, the handler returns `DispatchControl::CloseConn` (matching the existing `Final` error semantics) and the ack is still sent so the JS Promise resolves rather than hanging.
- **Streaming compat.** A streaming-path render that mistakenly calls `renderChunkFinal` after sending N body chunks is a misuse — `BytesAndFinal` arriving while `chunked == true` is logged at WARN and processed as Bytes-then-Final to preserve forward progress (matches the existing tolerance in `dispatch_to_worker_and_stream_chunks` for unexpected chunks after `headers_written` in non-chunked mode).
- **`render_slot` lifecycle unchanged.** The slot is cleared by `RenderClaim::drop` exactly as before; `BytesAndFinal` is just a different chunk variant, not a different slot lifecycle.

## CLI / API surface

- New public napi binding: `napiRenderChunkFinal(workerId: number, len: number): Promise<NapiResult<undefined>>`. Generated automatically by `@napi-rs/cli` into `runtime/index.js` and `runtime/index.d.ts`.
- New TS contract: `RenderBranchStreamingArgs.napi.renderChunkFinal` (required field). All four existing call-sites (`runtime/routes.ts` × 2, `runtime/render/stream.ts` injected via two paths) supply it.

No breaking changes — `napi_render_chunk` stays as-is. Streaming-path callers and other consumers untouched.

## Tests

### Existing (must continue to pass)

- `bun test runtime/` — 188 tests, the renderer + routes + stream paths covered
- `cargo test --lib` — 106 tests, the pool + render_stream + atomic-claim coverage
- `cargo test --lib --release` — same 106, includes T7 two-barrier race regression
- Integration smoke: `oha -c 200 -z 5s http://127.0.0.1:38201/` returns 200 with no panics

### New tests

1. **`src/pool.rs` (or a new `src/pool_chunks.rs`)** — unit test asserting `RenderChunk::BytesAndFinal` round-trips through an `mpsc` channel cleanly (Send + Sync bounds, ack semantics). Mirror existing `RenderChunk::Bytes` / `RenderChunk::Final` coverage shape.

2. **Rust integration-style test** for the new `dispatch_to_worker_and_stream_chunks` match arm — feed one `BytesAndFinal` directly into a test `chunk_rx`, assert the receiver sees the same response bytes as the Bytes-then-Final sequence. Lives in `src/server.rs` `#[cfg(test)] mod tests` or a new test file.

3. **`runtime/render/stream.test.ts`** — extend the existing buffering-path test to assert `renderChunkFinal` is called exactly once (not `renderChunk` + `renderChunk(0)`) for a single-chunk render. Use a fake napi shape that tracks call sequence.

4. **`runtime/routes.test.ts`** (or whichever file covers `emitSingleChunkResponse`) — same assertion at the routes layer: success path → `renderChunkFinal` once; error path → `renderChunkFinal` once.

### Bench validation (Phase 6, not unit-test)

After the impl lands, re-run the profile (the same `performance.now()` instrumentation used in Phase 1) and the standard `bun run bench`:

- c=1 `/` p50 should drop from ~148µs to ~115-128µs (20-35µs save).
- c=120 `/` p50 should drop proportionally; RPS may improve 5-15% (workers spend less time blocked on the extra crossing).
- c=120 `/` p99 must NOT regress (the fix touches the hot path only; if p99 widens we have a tail bug to investigate).
- POST `/_brust/action/createNote` should also benefit (same buffering shape).

## Acceptance criteria

1. `cargo test --lib` and `cargo test --lib --release` green.
2. `bun test runtime/` green (188 → 189+ with the new tests added).
3. `bun run bench` shows c=1 `/` latency drop ≥ 15µs (the conservative lower bound of the expected range).
4. `bun run bench` p99 on `/` does not regress beyond ±10% of the post-fix baseline (2.42ms).
5. The HTTP response bytes for a `/` request are byte-identical before and after (smoke: `curl -s http://127.0.0.1:38201/ | wc -c` returns the same length pre- and post-fix).
6. Streaming routes (`/slow-suspense`) still complete successfully (smoke: `curl -N` shows progressive output).
7. No new `napi_render_chunk` call-sites added in the streaming or SSE/WS paths.

## Known limitations

- The save is **buffering-only**. Streaming-path responses pay no different cost than before — they were already paying for separate close-signal round-trips by design. Routes that use Suspense (e.g., `/slow-suspense` in the example) see no improvement from this work.
- The new binding is M1-Pro-host-measured. Cross-platform savings expected to scale proportionally (the cost being eliminated is napi+tokio overhead, not platform-specific), but not retested on Linux/x86_64 in this scope.
- `len == 0` is permitted by the new binding but never used by current callers. The match arm in server.rs handles it (empty body → response with `Content-Length: 0`); no special test added since no caller exercises it.

## Open questions (resolved at plan-time)

- **Q: Should we also migrate streaming-path's final close to a separate `napi_render_chunk_close` binding?** A: No. Streaming finals already have nothing to merge with — the last body chunk's `napi.renderChunk(wid, len)` completes before the close. A separate binding for the close would be a no-op rename. Out of scope.
- **Q: Risk of the new binding regressing `/ping` or POST atomic-claim numbers?** A: `/ping` doesn't touch worker pool — unaffected. POST uses `emitSingleChunkResponse` (lines 799-800) which migrates to `renderChunkFinal` and should improve, not regress.
- **Q: Should the spec lock in the expected µs save?** A: No, just the floor (≥ 15µs in acceptance criterion 3). Profile is host-dependent; the contract is the architectural change, not the specific number.

## Out-of-scope follow-ups (tracked, not blocking)

- Add a CI bench gate (`/` p99 < 5ms) per the 2026-05-28 post-mortem action items.
- Add `runtime/config.test.ts` covering the worker default loader.
- Allocation cleanup (concatBuffers + injectCssLink single-pass) — sub-2µs win each but worth doing if perf work continues.
- Move CSS injection into Rust — would let the renderer ship pre-injected bodies straight to socket without any JS-side splicing. Bigger architectural change.
