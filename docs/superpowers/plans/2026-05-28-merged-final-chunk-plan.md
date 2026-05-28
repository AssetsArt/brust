# Merged Final Chunk — implementation plan

**Spec:** `docs/superpowers/specs/2026-05-28-merged-final-chunk-design.md`
**Base commit:** `8fcca8f` (post spec-fixes)
**Branch:** `main` (solo dev, standing consent for push after clean commits)

## Spec → task coverage

| Spec section | Task(s) |
|---|---|
| `RenderChunk::BytesAndFinal` variant (src/pool.rs) | T2 |
| `napi_render_chunk_final` binding (src/lib.rs) | T2 |
| `BytesAndFinal` match arm — non-chunked + cache write-back (src/server.rs) | T3 |
| `BytesAndFinal` match arm — chunked fallback + WARN (src/server.rs) | T3 |
| `RenderBranchStreamingArgs.napi.renderChunkFinal` type (runtime/render/stream.ts) | T5 |
| `emitSingleChunkResponse` param type widening (runtime/routes.ts) | T5 |
| `napi` wrapper objects gain `renderChunkFinal` (runtime/routes.ts × 2) | T5 |
| 4 stream.ts buffering call-site migrations | T6 |
| 2 emitSingleChunkResponse call-site migrations | T7 |
| Rust unit test for new variant | T2 |
| TS unit test asserting `renderChunkFinal` usage | T8 |
| Bench acceptance criteria (c=1 ≥10µs save, p99 not regressed) | T9 |
| Pre-existing `cargo fmt` failure on pool.rs:404 | T1 |

All spec sections covered. No placeholders, no deferred items not already named in spec "Out-of-scope follow-ups".

## Implementation order (strict sequence)

T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9. Each task verifies before the next starts.

---

## T1. Fix pre-existing `cargo fmt` failure on `src/pool.rs:404`

**Why first:** reviewer flagged this; CI hygiene. One-char change. Unblocks `cargo fmt --check` as a verification step in subsequent tasks.

**Change:** `src/pool.rs:404` — collapse two spaces to one between `4;` and `// workers`.

**Verify:**
```bash
cargo fmt --check 2>&1
```
Expected: exits 0 with no diff output.

**BLOCKED fallback:** if `cargo fmt --check` still complains, run `cargo fmt` (no `--check`) and inspect the resulting diff. If multiple unrelated files are touched, revert all but `src/pool.rs` and commit just that fix. The other fmt drift is out of scope.

---

## T2. Add `RenderChunk::BytesAndFinal` variant + `napi_render_chunk_final` binding + Rust unit test

**Files:**
- `src/pool.rs` — extend the `RenderChunk` enum (additive, no existing variants change)
- `src/lib.rs` — add the new `#[napi]` async fn alongside `napi_render_chunk`
- `src/pool.rs` test module — extend an existing test or add a new `#[test]` asserting the variant constructs cleanly through the mpsc channel

**`src/pool.rs` enum change:**

```rust
pub enum RenderChunk {
    Bytes {
        data: Vec<u8>,
        ack: tokio::sync::oneshot::Sender<()>,
    },
    Final {
        ack: tokio::sync::oneshot::Sender<()>,
    },
    /// Combined Bytes + Final. Buffering-path callers use this to eliminate
    /// one tsfn round-trip per render. handle_conn processes this as the
    /// byte-equivalent of Bytes-then-Final consecutive sends.
    BytesAndFinal {
        data: Vec<u8>,
        ack: tokio::sync::oneshot::Sender<()>,
    },
}
```

**`src/lib.rs` new binding (paste after the existing `napi_render_chunk` at lines 510-556):**

```rust
/// Buffering-path finalizer: equivalent to `napi_render_chunk(_, len)` followed
/// by `napi_render_chunk(_, 0)` but in a single tsfn crossing. Cuts JS-side
/// per-request overhead by one full Promise+await cycle.
///
/// Streaming-path callers MUST NOT use this — they send N body chunks then a
/// separate `Final`. Calling this with `streaming=true` meta is logged at WARN
/// on the Rust side and falls back to emitting chunked headers + framed body
/// + chunked terminator (byte-equivalent to Bytes-then-Final in chunked mode).
///
/// Same error semantics as `napi_render_chunk`.
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
    // SAFETY: same as napi_render_chunk — BufPtr pinned at register time
    // (see pool.rs::BufPtr docstring), `len` is bounds-checked above.
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

**Rust unit test (add to `src/pool.rs` test module):**

```rust
#[tokio::test]
async fn bytes_and_final_round_trips_through_channel() {
    use tokio::sync::mpsc;
    let (tx, mut rx) = mpsc::channel::<RenderChunk>(1);
    let (ack_tx, ack_rx) = tokio::sync::oneshot::channel::<()>();
    let payload = b"hello world".to_vec();

    tx.send(RenderChunk::BytesAndFinal {
        data: payload.clone(),
        ack: ack_tx,
    })
    .await
    .unwrap();

    let received = rx.recv().await.expect("chunk should arrive");
    match received {
        RenderChunk::BytesAndFinal { data, ack } => {
            assert_eq!(data, payload);
            ack.send(()).expect("ack receiver should still be alive");
        }
        other => panic!("expected BytesAndFinal, got {:?}", chunk_kind(&other)),
    }
    ack_rx.await.expect("ack should resolve");
}

#[cfg(test)]
fn chunk_kind(c: &RenderChunk) -> &'static str {
    match c {
        RenderChunk::Bytes { .. } => "Bytes",
        RenderChunk::Final { .. } => "Final",
        RenderChunk::BytesAndFinal { .. } => "BytesAndFinal",
    }
}
```

If a `chunk_kind` helper or equivalent already exists, reuse it instead.

**Verify:**
```bash
cargo build --release 2>&1 | tail -10
cargo test --lib bytes_and_final 2>&1 | tail -10
cargo test --lib --release bytes_and_final 2>&1 | tail -10
```
Expected: all three exit 0; the new test name appears in pass list. `cargo build` may warn about the unused new variant if T3 hasn't landed yet — that's expected; do not silence with `#[allow]`.

**BLOCKED fallback:** if `cargo build` errors out, do NOT add `#[allow(dead_code)]` to silence the unused variant — that defeats the dead-code check for the new arm. Instead skip ahead to T3 in the same task, since the variant + binding are useless without a handler.

---

## T3. Add `BytesAndFinal` match arm in `dispatch_to_worker_and_stream_chunks`

**File:** `src/server.rs` (around line 970 — extend the `match chunk {}` block)

**Insert after the existing `RenderChunk::Final { ack }` arm (currently lines 1024-1038):**

```rust
crate::pool::RenderChunk::BytesAndFinal { data, ack } => {
    // Buffering-path single-call: parse meta, build full response,
    // write to socket, populate cache write-back, ack. Byte-equivalent
    // to Bytes-then-Final for the same `data`.
    let (meta_slice, body) = match crate::render_stream::split_meta(&data) {
        Ok(x) => x,
        Err(e) => {
            error!(worker_id = entry.id, label, error = e, "split_meta failed (BytesAndFinal)");
            let _ = s.write_all(http::error_500()).await;
            let _ = ack.send(());
            return DispatchControl::CloseConn;
        }
    };
    let parsed: crate::render_stream::ChunkMeta = match serde_json::from_slice(meta_slice) {
        Ok(m) => m,
        Err(e) => {
            error!(worker_id = entry.id, label, error = %e, "meta JSON parse failed (BytesAndFinal)");
            let _ = s.write_all(http::error_500()).await;
            let _ = ack.send(());
            return DispatchControl::CloseConn;
        }
    };

    if parsed.streaming {
        // Misuse: streaming-meta in a buffering call. Emit byte-equivalent
        // chunked headers + framed body + chunked terminator so the wire
        // output still matches Bytes-then-Final in chunked mode.
        warn!(
            worker_id = entry.id, label,
            "BytesAndFinal received in streaming mode — emitting chunked + terminator",
        );
        let head = crate::render_stream::build_chunked_response_head(&parsed);
        if s.write_all(head).await.is_err() {
            let _ = ack.send(());
            return DispatchControl::CloseConn;
        }
        let framed = crate::render_stream::format_chunk_framed(body);
        if s.write_all(framed).await.is_err() {
            let _ = ack.send(());
            return DispatchControl::CloseConn;
        }
        let term = crate::render_stream::format_chunk_framed(b"");
        let _ = s.write_all(term).await;
        // No cache write-back in chunked mode (matches existing Final arm).
    } else {
        // Canonical buffering use-case: single Content-Length response.
        let resp = crate::render_stream::build_single_response_bytes(&parsed, body);
        response_bytes_for_cache = resp.clone();
        if s.write_all(resp).await.is_err() {
            let _ = ack.send(());
            return DispatchControl::CloseConn;
        }
    }

    let _ = ack.send(());
    break;
}
```

**Verify:**
```bash
cargo build --release 2>&1 | tail -10
cargo test --lib 2>&1 | tail -5
cargo test --lib --release 2>&1 | tail -5
```
Expected: 107 tests pass (106 existing + T2's new test). No dead-code warnings — the variant is now consumed in the match.

**BLOCKED fallback:** if a streaming integration test (e.g., `/slow-suspense`) regresses, the chunked-mode fallback is wrong. Compare the wire output of the existing Bytes-then-Final path against the new arm with `curl -v http://127.0.0.1:38201/slow-suspense | xxd` before vs after. If the bytes differ, fix the arm. Do NOT change the streaming Bytes/Final arms.

---

## T4. Rebuild napi addon + integration smoke

**Why a dedicated task:** the new TS-side bindings (T5-T7) need the `.node` artifact to contain `napiRenderChunkFinal`. Rebuilding here separates "Rust compiles" from "Rust + JS link up".

**Commands:**
```bash
cd runtime && bun run build 2>&1 | tail -5
```
Expected: napi build completes, `runtime/index.darwin-arm64.node` mtime updated. `runtime/index.d.ts` and `runtime/index.js` regenerated and contain the new `napiRenderChunkFinal` export.

**Verify the binding is exported:**
```bash
grep -n "napiRenderChunkFinal" runtime/index.d.ts runtime/index.js
```
Expected: at least one match in each file (declaration + module.exports re-export).

**Smoke that nothing broke:**
```bash
BRUST_PORT=38401 BRUST_WORKERS=1 bun run example/hello-world/index.ts > /tmp/brust-t4.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do
  if curl -sf -o /dev/null http://127.0.0.1:38401/ping; then break; fi
  sleep 0.5
done
curl -s http://127.0.0.1:38401/ | head -c 80   # any output = pre-migration buffering path still works
kill -INT $SERVER_PID 2>/dev/null; kill -9 $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null || true
```
Expected: `<!DOCTYPE html>` or the start of the rendered page. The TS-side hasn't migrated yet so it's still using the old `napi.renderChunk + renderChunk(0)` path — that must still work.

**BLOCKED fallback:** if `bun run build` errors with a napi-rs CLI issue, check the napi-rs version pin in `runtime/package.json` (`@napi-rs/cli`). Don't bump the dependency in this PR; document the build error and stop.

---

## T5. Add `renderChunkFinal` type fields (no caller migration yet)

**Files:**
- `runtime/render/stream.ts` (line 15-17)
- `runtime/routes.ts` (lines 431-432, 601-602, 759-762)

**`runtime/render/stream.ts` — extend `RenderBranchStreamingArgs.napi`:**

Before (lines 15-17):
```ts
napi: {
  renderChunk: (workerId: bigint, len: number, sabBytes: Uint8Array) => Promise<void>
}
```

After:
```ts
napi: {
  renderChunk:      (workerId: bigint, len: number, sabBytes: Uint8Array) => Promise<void>
  renderChunkFinal: (workerId: bigint, len: number, sabBytes: Uint8Array) => Promise<void>
}
```

**`runtime/routes.ts` lines 431-432 (and equivalent 601-602)** — extend each `napi` wrapper literal:

Before:
```ts
napi: {
  renderChunk: async (workerId: bigint, len: number, _sabBytes: Uint8Array): Promise<void> => {
    await (native as any).napiRenderChunk(Number(workerId), len)
  },
},
```

After:
```ts
napi: {
  renderChunk: async (workerId: bigint, len: number, _sabBytes: Uint8Array): Promise<void> => {
    await (native as any).napiRenderChunk(Number(workerId), len)
  },
  renderChunkFinal: async (workerId: bigint, len: number, _sabBytes: Uint8Array): Promise<void> => {
    await (native as any).napiRenderChunkFinal(Number(workerId), len)
  },
},
```

Apply the same change at lines 601-602.

**`runtime/routes.ts` — `emitSingleChunkResponse` parameter type (line 759):**

Before:
```ts
napi: { renderChunk: (w: bigint, len: number, view: Uint8Array) => Promise<void> },
```

After:
```ts
napi: {
  renderChunk:      (w: bigint, len: number, view: Uint8Array) => Promise<void>
  renderChunkFinal: (w: bigint, len: number, view: Uint8Array) => Promise<void>
},
```

**Verify (no behavior change yet — types only):**
```bash
bun test runtime/ 2>&1 | tail -5
```
Expected: 188 tests still pass — all existing call-sites still use `renderChunk`, so behavior is identical.

**BLOCKED fallback:** if `bun test` errors with a type mismatch elsewhere (some other file passes a `napi` object literal missing `renderChunkFinal`), grep for `renderChunk:` in `runtime/` and `tests/` to find every callsite; widen each one. Do NOT make `renderChunkFinal` optional with `?` — every legitimate caller must supply it explicitly.

---

## T6. Migrate 4 buffering-path call-sites in `stream.ts`

**File:** `runtime/render/stream.ts`

**Call-site 1 — buffering success (lines 136-137):**

Before:
```ts
await napi.renderChunk(workerId, len, view)
await sendFinal()
```

After:
```ts
await napi.renderChunkFinal(workerId, len, view)
finalSent = true
resolve()
```

**Call-site 2 — `onShellError` 500 path (lines 226-228):**

Before:
```ts
const len = encodeFirstChunk(view, meta, encoder.encode(html))
await napi.renderChunk(workerId, len, view)
await sendFinal()
```

After:
```ts
const len = encodeFirstChunk(view, meta, encoder.encode(html))
await napi.renderChunkFinal(workerId, len, view)
finalSent = true
resolve()
```

**Call-site 3 — `onShellError` errorBoundary-threw path (lines 239-241):**

Before:
```ts
const len = encodeFirstChunk(view, meta, encoder.encode('Internal Server Error'))
await napi.renderChunk(workerId, len, view)
await sendFinal()
```

After:
```ts
const len = encodeFirstChunk(view, meta, encoder.encode('Internal Server Error'))
await napi.renderChunkFinal(workerId, len, view)
finalSent = true
resolve()
```

**Call-site 4 — outer catch (lines 256-258):**

Before:
```ts
const len = encodeFirstChunk(view, meta, encoder.encode('Internal Server Error'))
await napi.renderChunk(workerId, len, view)
await sendFinal()
```

After:
```ts
const len = encodeFirstChunk(view, meta, encoder.encode('Internal Server Error'))
await napi.renderChunkFinal(workerId, len, view)
finalSent = true
resolve()
```

`sendFinal()` and `finalSent` stay in scope — the streaming-path `_final` branch (line 141) still uses them.

**Verify:**
```bash
bun test runtime/render/ 2>&1 | tail -5
bun test runtime/ 2>&1 | tail -5
```
Expected: all tests pass. Specifically `runtime/render/stream.test.ts` must still pass — the buffering-path tests there don't currently assert which napi method is called, only that the response is correct.

**Smoke:**
```bash
BRUST_PORT=38401 BRUST_WORKERS=1 bun run example/hello-world/index.ts > /tmp/brust-t6.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do
  if curl -sf -o /dev/null http://127.0.0.1:38401/ping; then break; fi
  sleep 0.5
done
curl -s http://127.0.0.1:38401/ | wc -c   # response should be non-zero
curl -s http://127.0.0.1:38401/ | head -c 30   # should start with <!DOCTYPE html>
kill -INT $SERVER_PID 2>/dev/null; kill -9 $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null || true
```
Expected: byte count matches the pre-migration response length (within Tailwind-build noise); response starts with `<!DOCTYPE html>` or React's equivalent.

**BLOCKED fallback:** if the smoke shows zero bytes or a hung curl, the merged arm in T3 is dropping the response. Bisect: temporarily revert call-site 1 only, re-test. If revert fixes it, the issue is in server.rs's `BytesAndFinal` non-chunked branch — recheck the `response_bytes_for_cache` assignment and `s.write_all(resp)` ordering against the spec.

---

## T7. Migrate 2 `emitSingleChunkResponse` call-sites in `routes.ts`

**File:** `runtime/routes.ts`

**Call-site 1 — error path (lines 791-792):**

Before:
```ts
await napi.renderChunk(workerId, errTotal, view)
await napi.renderChunk(workerId, 0, view)
return
```

After:
```ts
await napi.renderChunkFinal(workerId, errTotal, view)
return
```

**Call-site 2 — content path (lines 799-800):**

Before:
```ts
await napi.renderChunk(workerId, total, view)
await napi.renderChunk(workerId, 0, view)
```

After:
```ts
await napi.renderChunkFinal(workerId, total, view)
```

**Verify:**
```bash
bun test runtime/ 2>&1 | tail -5
```
Expected: all tests pass.

**Smoke POST through the buffering path:**
```bash
BRUST_PORT=38401 BRUST_WORKERS=1 bun run example/hello-world/index.ts > /tmp/brust-t7.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do
  if curl -sf -o /dev/null http://127.0.0.1:38401/ping; then break; fi
  sleep 0.5
done
curl -s -X POST -H 'content-type: application/json' -d '["hi"]' \
  http://127.0.0.1:38401/_brust/action/createNote
echo ""
kill -INT $SERVER_PID 2>/dev/null; kill -9 $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null || true
```
Expected: a JSON response (the createNote action returns the saved note). Should not hang or return 500.

**BLOCKED fallback:** same as T6 — if POST hangs or 500s, bisect with the routes.ts call-sites; if the issue persists with both reverted, re-check T3's match arm.

---

## T8. Add bun test asserting `renderChunkFinal` used on buffering path

**File:** `runtime/render/stream.test.ts` (extend the existing buffering-path test; if no test currently asserts napi call sequence, add a new one near the existing buffering tests)

**Test outline:**

```ts
import { test, expect } from 'bun:test'
import { renderBranchStreaming } from './stream'
import { createElement } from 'react'

test('buffering path calls renderChunkFinal exactly once (not renderChunk + renderChunk(0))', async () => {
  const calls: Array<{ method: 'renderChunk' | 'renderChunkFinal'; len: number }> = []
  const view = new Uint8Array(64 * 1024)
  const napi = {
    renderChunk: async (_w: bigint, len: number, _v: Uint8Array) => {
      calls.push({ method: 'renderChunk', len })
    },
    renderChunkFinal: async (_w: bigint, len: number, _v: Uint8Array) => {
      calls.push({ method: 'renderChunkFinal', len })
    },
  }
  const errorBoundary = ({ error }: { error: Error }) =>
    createElement('div', null, `error: ${error.message}`)

  await renderBranchStreaming({
    element: createElement('html', null, createElement('body', null, 'hi')),
    view,
    workerId: 1n,
    napi,
    errorBoundary,
  })

  expect(calls.length).toBe(1)
  expect(calls[0].method).toBe('renderChunkFinal')
  expect(calls[0].len).toBeGreaterThan(0)
})
```

Adjust the test setup to match how existing `stream.test.ts` tests construct fake `napi` shapes (the existing tests already exercise this path; copy their helper if one exists).

**Verify:**
```bash
bun test runtime/render/stream.test.ts 2>&1 | tail -10
```
Expected: new test passes; existing tests still pass; total count = previous + 1 (or however many tests already existed).

**BLOCKED fallback:** if `renderBranchStreaming`'s buffering path is harder to invoke in a test than the snippet suggests (e.g., requires a specific React tree to take the non-Suspense path), look at how the existing `stream.test.ts` tests trigger the buffering branch and copy that scaffolding exactly. Do not modify `renderBranchStreaming`'s shape to make it test-friendlier.

---

## T9. Re-bench + validate acceptance criteria

**Commands:**
```bash
bun run bench 2>&1 | grep -E "rps=|→" | tail -15
```
Capture the numbers. Repeat once more for variance check.

**Acceptance gates (from spec):**

- [ ] `/` c=1 baseline test: capture by spawning brust at `BRUST_WORKERS=1` and running `oha -c 1 -n 1500` against `/` then comparing p50 against the pre-fix 148µs baseline. Need p50 ≤ 138µs (≥10µs save).
- [ ] `/` c=120 p99 ≤ 2.66ms (within ±10% of post-worker-default-fix p99 of 2.42ms — allow some upward noise but flag a regression).
- [ ] `cargo test --lib --release` 107 pass (106 prior + T2).
- [ ] `bun test runtime/` 189 pass (188 prior + T8).
- [ ] Byte equivalence of `/`: `curl -s http://127.0.0.1:38401/ | wc -c` returns the same length as the pre-fix response within ±50 bytes (Tailwind class generation can vary slightly between rebuilds).

**c=1 measurement (the actual perf win check):**
```bash
BRUST_PORT=38401 BRUST_WORKERS=1 bun run example/hello-world/index.ts > /tmp/brust-c1.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do
  if curl -sf -o /dev/null http://127.0.0.1:38401/ping; then break; fi
  sleep 0.5
done
oha -c 1 -z 5s --no-tui --output-format json http://127.0.0.1:38401/ > /tmp/oha-c1-post.json
kill -INT $SERVER_PID 2>/dev/null; kill -9 $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null || true
echo "c=1 / p50: $(jq -r '.latencyPercentiles.p50' /tmp/oha-c1-post.json) sec"
echo "c=1 / p99: $(jq -r '.latencyPercentiles.p99' /tmp/oha-c1-post.json) sec"
echo "c=1 / rps: $(jq -r '.summary.requestsPerSec // .summary.requestPerSec' /tmp/oha-c1-post.json)"
```

Expected: c=1 `/` p50 around 113-128µs (down from 148µs pre-fix), p99 tight (under 300µs).

**Update `bench/RESULTS.md`** with the new numbers (drop into the existing table; bench script writes it automatically).

**Update `README.md` and `architecture.md` headline numbers** with the new values.

**BLOCKED fallback:** if c=1 p50 does NOT improve by ≥10µs:
1. Re-run the profile instrumentation from Phase 1 (instrument `napi1` and `napi2` separately in `stream.ts` `_final` buffering path). If only `napi1` registers (single call) and the absolute µs cost is ~70µs, the merge happened but the per-crossing cost was higher than expected — the win is real but the host is bottlenecked elsewhere. Document and call advisor.
2. If `napi2` still registers (two calls), the migration in T6/T7 missed a call-site — re-grep `napi.renderChunk(.*, *0,` in `runtime/` and fix any leftover.

---

## Post-impl

- Commit each task as a separate commit (or bundle T5-T7 if they land cleanly together — judge by review-ability).
- After T9 passes, write Phase 7 wrap-up. Post-mortem only if T3 or T6 required a real pivot (per debug-mantra discipline). A clean run = compact wrap-up only.
- Push when all green per standing consent.
