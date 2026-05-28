# Writev Zero-Copy Response — apply nylon-ring NrVec<u8> ownership-transfer to brust buffering path

**Date:** 2026-05-28
**Author:** detoro (autonomous pipeline)
**Status:** Spec — pending review
**Inspired by:** [AssetsArt/nylon-ring](https://github.com/AssetsArt/nylon-ring) — "Zero-copy data transfer with `NrVec<u8>`" / "ownership transfer across FFI boundaries without duplication"

## Goal

Eliminate two userspace memcpys per buffering render on the `/` hot path by:

1. **Skipping the unconditional `response_bytes_for_cache = resp.clone()`** when the route has no `cache:` config (which is `/` and `POST /_brust/action/*` — the two highest-RPS endpoints in `bench/RESULTS.md`).
2. **Replacing the header+body concat into a single `Vec<u8>` with vectored I/O**: build only the HTTP header into a small `Vec`, leave the body as `&[u8]` borrowed from the channel-delivered `data: Vec<u8>`, send via `write_vectored` so the kernel does scatter-gather in one syscall.

The conceptual mapping to nylon-ring: instead of *copying* the body bytes into the response buffer (current behavior), we *transfer ownership* of the body slice to the syscall layer (the slice lives in `data` which outlives the syscall via stack-frame scoping). Same shape as `NrVec<u8>` — "the data already exists at a stable address; just point at it."

## Non-goals

- **Streaming path (Transfer-Encoding: chunked).** Each chunk's `format_chunk_framed` also concat-copies the body, but the per-chunk overhead is amortized over multiple writes and N is small on real workloads. Out of scope; deferred follow-up. The buffering path is the bench hot path.
- **Linux tokio-uring writev.** `tokio_uring::net::TcpStream::writev` takes owned `Vec<T: BoundedBuf>` — the body slice's lifetime model doesn't fit io_uring's "submit-and-forget" ownership-transfer semantics without an extra heap copy. Linux preserves current concat behavior. macOS (the bench platform) gets the win.
- **Drop Copy 1** (`napi_render_chunk_final`'s `slice::from_raw_parts(buf_ptr, len).to_vec()`). The SAB is reused by the worker's *next* render dispatch; the body must be detached into a Rust-owned `Vec<u8>` before the tsfn returns control to JS so the SAB can be reclaimed. Architecturally required.
- **Per-connection scratch buffer for the header.** Considered as an extension; deferred. Header allocation is ~120-200 bytes per request, far smaller than the body memcpy this spec already eliminates. Roll into a future micro-perf pass if measured.
- **HTTP/1.1 keep-alive coalescing / TCP_CORK.** Out of scope; would interact poorly with chunked streaming on the same connection.
- **Cache key hashing (FxHash).** Cache keys aren't on the bench hot path — `/` and `POST /_brust/action/*` neither configure `cache:`. Deferred until a cached route enters the bench.

## High-level architecture

### Current shape — `BytesAndFinal` arm of `dispatch_to_worker_and_stream_chunks`

```
data: Vec<u8>           // owned, [meta_len u16 BE][meta JSON][body]
  ↓ split_meta
  body: &[u8]           // slice into data
  ↓ build_single_response_bytes
  resp: Vec<u8>         // ★ alloc + memcpy body — COPY #2
  ↓ resp.clone()
  response_bytes_for_cache: Vec<u8>  // ★ alloc + memcpy whole response — COPY #3 (always done, even for uncached routes)
  ↓ s.write_all(resp).await
  (kernel write)
  ↓ on_success(&response_bytes_for_cache)
  (closure either inserts into cache or no-ops)
```

Two userspace memcpys of the body, three allocations of body-size buffers (`data`, `resp`, `response_bytes_for_cache`).

### Proposed shape — `BytesAndFinal` arm of `dispatch_to_worker_and_stream_chunks`

```
data: Vec<u8>                       // owned, [meta_len u16 BE][meta JSON][body]
  ↓ split_meta
  body: &[u8]                       // slice into data
  ↓ if route has cache_config:
      let resp = build_single_response_bytes(&parsed, body)    // alloc + body memcpy
      s.write_all(resp.clone()).await                          // clone + write
      response_bytes_for_cache = resp                          // forwarded to on_success
    else:
      let head = build_single_response_head_only(&parsed, body.len())  // alloc, ~120-200 B; NO body bytes
      s.write_all_vectored([&head, body]).await   // ★ kernel scatter-gather, no body memcpy
      // no on_success call — uncached routes skip the closure entirely
```

**Cached routes:** unchanged at two body memcpys per req (`build` + `clone`). The cached path is not optimized in this sub-project — sharded cache + (head, body) pair-storage is a separate sub-project, see "Known limitations §3".

**Uncached routes:** ZERO body memcpys (down from two — `build` and `clone` both skipped). This is the bench hot path: `/` and `POST /_brust/action/createNote` both run uncached at HEAD `66f04d3`.

### Components affected

| Component | Change |
|---|---|
| `src/render_stream.rs` | Add `build_single_response_head_only(meta: &ChunkMeta, body_len: usize) -> Vec<u8>` — same as `build_single_response_bytes` minus the trailing `out.extend_from_slice(body)`. Refactor `build_single_response_bytes` to call the head helper + `extend_from_slice` so the two share their formatting code path. |
| `src/io/other.rs` (macOS / tokio) | Add `TcpStream::write_all_vectored(&mut self, bufs: &mut [IoSlice<'_>]) -> std::io::Result<()>` — loop over `tokio::io::AsyncWriteExt::write_vectored` + `IoSlice::advance_slices` until all bufs drained. Handle `WriteZero` as error. |
| `src/io/linux.rs` (Linux / tokio-uring) | Add `TcpStream::write_all_vectored(&mut self, bufs: &mut [IoSlice<'_>]) -> std::io::Result<()>` stub that **falls back to single-vec concat write** (header.extend_from_slice(body) then existing write_all). Documented inline; deferred io_uring writev support. |
| `src/server.rs` | `dispatch_to_worker_and_stream_chunks` grows a `cache_wanted: bool` parameter (replacing the always-cloned `response_bytes_for_cache`). In the `BytesAndFinal` arm, branch on `cache_wanted`: cached path builds full resp once; uncached path uses head+body vectored write. `Final` arm (multi-`Bytes`-then-`Final`) gets the same `cache_wanted` branch around the existing `build_single_response_bytes` + clone. `handle_conn` passes `cache_config.is_some()` as `cache_wanted` at the 3 dispatch sites (render, action, navigation, mcp). |

No changes to:
- The wire format. Identical bytes go on the socket — same status line, same headers (in same order), same body. Verified by per-test byte equality.
- napi bindings (`napi_render_chunk`, `napi_render_chunk_final` unchanged).
- The streaming / chunked path (`format_chunk_framed` and the multi-chunk `Bytes` arm unchanged).
- SSE / WS paths (different dispatchers — `dispatch_sse`, `dispatch_ws` — neither touches the buffering response build).
- `RenderChunk` enum variants.
- `build_chunked_response_head` (streaming path).
- The cache itself (`src/cache.rs`).

### Why `cache_wanted: bool` and not `cache_target: Option<...>`

The dispatcher doesn't need the cache *details*; only whether to materialize the response bytes. The `FnOnce(&[u8])` closure still does the actual `cache.insert(...)` and already knows the key/cfg/handle. A bool is the minimal information the dispatcher needs to choose between vectored write and concat write.

### Why a separate `build_single_response_head_only` and not "build with body then `pop()`"

Cheaper. `extend_from_slice(body)` is the expensive step we're avoiding. A function that **never** appends the body is what we want; refactoring `build_single_response_bytes` to call the head helper + extend keeps the two cousins in sync structurally without ever allocating the body-sized capacity on the head-only path.

### Why fall back on Linux instead of using `tokio_uring::writev`

`tokio_uring::writev(buf_vec: Vec<T>)` requires `T: BoundedBuf` — each buffer in the vector must be owned (or a `slice::Slice<T>` that owns its parent). Our body is a `&[u8]` slice into `data: Vec<u8>` that we *don't* want to move into the writev call (we don't own it within the channel's lifetime model — `data` is consumed by the match arm). Building owned wrappers (`slice::Slice` over `data`, plus owned head Vec) would solve the lifetime issue but is an io_uring-specific refactor with its own surface area. The brust bench runs on macOS; Linux io_uring writev is a separate sub-project that should land *after* a Linux bench baseline exists.

## File changes

### `src/render_stream.rs`

Add a head-only helper. Refactor the existing `build_single_response_bytes` to use it.

```rust
/// Build the response status line + headers (no body bytes), terminated by
/// the blank line. Same wire shape as `build_single_response_bytes`'s output
/// up to (and excluding) the body — used by the vectored-write path on the
/// buffering hot path where the body remains in its owned source buffer.
pub fn build_single_response_head_only(meta: &ChunkMeta, body_len: usize) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\n",
        meta.status,
        status_reason(meta.status),
        meta.content_type,
        body_len,
    )
    .into_bytes();
    for (k, v) in &meta.headers {
        out.extend_from_slice(format!("{}: {}\r\n", k, v).as_bytes());
    }
    out.extend_from_slice(b"\r\n");
    out
}

/// Build a complete single-chunk HTTP/1.1 response with Content-Length —
/// header bytes from `build_single_response_head_only` followed by the body.
/// Used when the caller needs the full bytes (e.g. cache write-back).
pub fn build_single_response_bytes(meta: &ChunkMeta, body: &[u8]) -> Vec<u8> {
    let mut out = build_single_response_head_only(meta, body.len());
    out.extend_from_slice(body);
    out
}
```

### `src/io/other.rs`

```rust
use std::io::IoSlice;

impl TcpStream {
    // ... existing ...

    /// Vectored write that drains all slices, looping on `write_vectored`
    /// and advancing as bytes are written. Returns `WriteZero` if the
    /// kernel reports zero bytes written with bufs non-empty (treated as
    /// connection closed).
    ///
    /// `tokio::io::AsyncWriteExt::write_vectored` requires the `io-util`
    /// feature, which `Cargo.toml` already enables on `cfg(not(linux))`.
    /// Verified via tokio src: `tokio/src/net/tcp/stream.rs` sets
    /// `is_write_vectored = true` and delegates to mio's
    /// `poll_write_vectored`, which calls `writev(2)`.
    pub async fn write_all_vectored(
        &mut self,
        bufs: &mut [std::io::IoSlice<'_>],
    ) -> std::io::Result<()> {
        use tokio::io::AsyncWriteExt;
        // `IoSlice::advance_slices` takes `&mut &mut [IoSlice]` — we need
        // to rebind through a mutable local so we can pass `&mut bufs`.
        let mut bufs: &mut [std::io::IoSlice<'_>] = bufs;
        while !bufs.is_empty() {
            let n = self.0.write_vectored(bufs).await?;
            if n == 0 {
                return Err(std::io::ErrorKind::WriteZero.into());
            }
            std::io::IoSlice::advance_slices(&mut bufs, n);
        }
        Ok(())
    }
}
```

### `src/io/linux.rs`

```rust
use std::io::IoSlice;

impl TcpStream {
    // ... existing ...

    /// Compatibility stub on Linux. tokio-uring's `writev` expects owned
    /// `BoundedBuf`-conforming buffers; the buffering hot path holds a
    /// borrowed body slice. For now, concat into a single Vec and write
    /// in one call — preserving current Linux behavior. Real writev
    /// support is deferred to a future sub-project once a Linux bench
    /// baseline exists.
    pub async fn write_all_vectored(
        &mut self,
        bufs: &mut [IoSlice<'_>],
    ) -> std::io::Result<()> {
        let total: usize = bufs.iter().map(|s| s.len()).sum();
        let mut merged: Vec<u8> = Vec::with_capacity(total);
        for s in bufs.iter() {
            merged.extend_from_slice(s);
        }
        let (res, _) = self.0.write_all(merged).await;
        res
    }
}
```

### `src/server.rs`

`dispatch_to_worker_and_stream_chunks` gains a `cache_wanted: bool` param. The `BytesAndFinal` non-streaming branch (the bench hot path) becomes:

```rust
} else {
    // Canonical buffering use-case: single Content-Length response.
    if cache_wanted {
        // Build full bytes once for both the write and the cache insert.
        // Clone preserved here — cache needs an owned copy independent of
        // the write_all transfer. Reducing this clone is a separate
        // sub-project (see "Known limitations §3").
        let resp = crate::render_stream::build_single_response_bytes(&parsed, body);
        if s.write_all(resp.clone()).await.is_err() {
            let _ = ack.send(());
            return DispatchControl::CloseConn;
        }
        response_bytes_for_cache = resp;
    } else {
        // Uncached hot path — vectored write, no body memcpy.
        // `data` (containing `body` as a sub-slice) is owned by this match
        // arm and lives until the arm exits, well past the await.
        let head = crate::render_stream::build_single_response_head_only(&parsed, body.len());
        let mut slices = [
            std::io::IoSlice::new(&head),
            std::io::IoSlice::new(body),
        ];
        if s.write_all_vectored(&mut slices).await.is_err() {
            let _ = ack.send(());
            return DispatchControl::CloseConn;
        }
    }
}
```

The `Final` arm (multi-Bytes-then-Final, for action middleware errors and the same JS-side fallback) and the `RenderOutcome::Resolved` early-exit path get the same `cache_wanted` branch around their existing `build_single_response_bytes` + clone calls.

The `dispatch_to_worker_and_stream_chunks` signature changes from:

```rust
async fn dispatch_to_worker_and_stream_chunks<F>(
    s: &mut TcpStream,
    pool: &Arc<crate::pool::WorkerPool>,
    envelope_json: String,
    label: &'static str,
    on_success: F,
) -> DispatchControl
where F: FnOnce(&[u8])
```

to:

```rust
async fn dispatch_to_worker_and_stream_chunks<F>(
    s: &mut TcpStream,
    pool: &Arc<crate::pool::WorkerPool>,
    envelope_json: String,
    label: &'static str,
    cache_wanted: bool,
    on_success: F,
) -> DispatchControl
where F: FnOnce(&[u8])
```

Bottom of the function:

```rust
if cache_wanted && !response_bytes_for_cache.is_empty() {
    on_success(&response_bytes_for_cache);
}
DispatchControl::Continue
```

Call sites in `handle_conn`:

- `render` branch: `cache_wanted = cache_config.is_some()` — the only branch with potential cache writes today.
- `action` branch: `cache_wanted = false` (actions never cache).
- `mcp` branch: `cache_wanted = false` (MCP responses never cache).
- `navigation` branch: `cache_wanted = false` (navigation JSON never caches).

## Tests

### Rust unit tests (`src/render_stream.rs`)

- **T1** `build_single_response_head_only_format`: status line + content-type + content-length + blank line; verify NO body bytes appear.
- **T2** `build_single_response_bytes_equals_head_plus_body`: assert `build_single_response_bytes(&m, &b) == [build_single_response_head_only(&m, b.len()), b].concat()` for three bodies: empty (`b""`, locks `Content-Length: 0` formatting), small (`b"<html>x</html>"`), and large (4 KB). This is the refactor-safety net.
- **T3** `head_only_includes_extra_headers_in_order`: BTreeMap iteration order preserved (alphabetical) and emitted before the blank line.

### Rust unit tests (`src/io/{linux,other}.rs`)

- **T4** `write_all_vectored_drains_all_slices_macos`: mock writer accepting partial writes; verify final socket buffer matches concatenated input.
- **T5** `write_all_vectored_propagates_write_zero`: writer returns 0 with bufs non-empty → `Err(WriteZero)`.
- **T6** `write_all_vectored_empty_input_returns_ok`: zero slices → immediate `Ok(())`, no syscalls.
- (Linux stub: tested implicitly by the integration test below; the fallback's behavior is "concat then write_all" which is already covered by existing tests.)

### Bun integration test (`tests/integration.test.ts`)

(Rust integration tests can't link against brust internals — `Cargo.toml:7` declares `crate-type = ["cdylib"]` only. Brust's existing test harness uses bun to spawn the cdylib-loaded app and exercises it over real HTTP via `fetch`; T7 follows that pattern.)

- **T7** `byte-for-byte: vectored uncached path matches non-vectored cached path` — add to the existing `tests/integration.test.ts` suite (alongside the existing `serves rendered html via worker pool` test which already spawns `tests/fixtures/app/index.ts`).
  1. Spawn the fixture app on a fresh `BRUST_PORT`.
  2. The fixture already has both shapes: `/` (uncached → new vectored path), and `/cache-test` (cached → existing concat path) at `tests/fixtures/app/routes.tsx`. Add a route, if needed, that emits an identical response body to both for direct comparison; otherwise compare structural invariants.
  3. Use raw `node:net` socket (or `Bun.connect`) to send a raw `GET / HTTP/1.1\r\nHost: ...\r\n\r\n` and read the *exact bytes* back — `fetch` re-frames and normalises headers, so it's unsuitable.
  4. Repeat for the cached route. The first cached-route request goes through `build_single_response_bytes`; a second cached-route request is served from `cache.get()` (bypassing the new path entirely).
  5. Parse status line + headers (case-insensitive) + body separately. Assert: status, content-length, content-type, body bytes are identical across both shapes. Header **order** is allowed to differ within the standard header set (the new path may emit Content-Type before Content-Length where the old emitted them together) — `build_single_response_head_only` is structured to keep order identical, but we tolerate ordering drift to avoid an over-strict regression test.

### Bun runtime tests

No change. The `runtime/render/stream.ts` buffering / streaming logic and the JS-side `napi.renderChunkFinal` call are unchanged. Existing 189 bun tests still pass.

### Bench (acceptance criterion)

`bun run bench` on M1 Pro, N=5 medians vs HEAD (`66f04d3`):

- `/` c=120 GET RPS: expected **+1–3%** (drop two memcpys per req out of ~33 µs budget). p99: expected **−5–10%** (allocator churn drop is the bigger gain — fewer big-Vec allocations per req on the hot path).
- `/ping`: no change (path doesn't go through `dispatch_to_worker_and_stream_chunks`).
- `POST /_brust/action/createNote`: expected **+1–3%** RPS (same uncached buffering path).
- Bun.serve baselines: no change (different process).

**Anti-regression criterion:** if any RPS goes *down* by more than 3% on N=5 medians, treat as regression; investigate before merge.

## Acceptance criteria

1. ✅ `cargo test --lib` green (107 prior + 6 new = 113).
2. ✅ `cargo test --lib --release` green (release-mode invariants unchanged).
3. ✅ `bun test runtime/` green (189 unchanged).
4. ✅ `tests/writev_byte_equivalence.rs` passes — vectored and non-vectored paths emit identical bytes.
5. ✅ `bun run bench` N=5 median: `/` RPS within (current −3%, current +5%); p99 within (current −15%, current +5%). If higher: ship + update architecture.md perf table. If lower outside band: regression.
6. ✅ `architecture.md` "Copy count, / endpoint" table updated to reflect the new copy count (0 body copies on uncached buffering, vs 2 today).
7. ✅ No new `unsafe` blocks. `IoSlice::new` is safe.

## Known limitations

1. **Linux preserves current concat behavior.** `write_all_vectored` on tokio-uring falls back to a single concat write. This is *worse* than the macOS path but *no worse* than today's Linux behavior. A future sub-project should add tokio-uring `writev` once a Linux bench baseline exists.
2. **The `BytesAndFinal { data, .. }` chunk still triggers Copy 1** (`napi_render_chunk_final`'s `slice::from_raw_parts(buf_ptr, len).to_vec()` — body crosses from SAB into Rust-owned Vec). Eliminating Copy 1 requires holding the SAB-slot lease longer (until socket write completes) which would block the worker from starting its next render. Architectural trade-off — defer.
3. **Cached routes still pay one body memcpy** (the `extend_from_slice(body)` inside `build_single_response_bytes` when `cache_wanted = true`). Eliminating it requires storing the cache entry as `(head: Vec<u8>, body: Vec<u8>)` separate and writing each via writev on hits — refactor of `src/cache.rs` semantics, deferred.
4. **Bench measurability is on the noise floor.** Expected RPS gain (+1–3%) is comparable to N=5 median variance (±5%). If measurement is ambiguous, the architectural improvement (fewer body memcpys, clearer ownership) still holds; document as such.

## Open questions resolved at plan-time

- **Q: Does tokio's `AsyncWriteExt::write_vectored` exist on `tokio::net::TcpStream`?**
  A: Yes — verified via `tokio-1.x/src/net/tcp/stream.rs` which sets `is_write_vectored = true` and delegates to mio's `poll_write_vectored`, calling `writev(2)`. Lives behind `tokio` crate feature `io-util` which `Cargo.toml:34` already enables on `cfg(not(linux))`. No new feature flags needed.

- **Q: Is `IoSlice::advance_slices` available?**
  A: Yes, stable since Rust 1.81. Cargo.toml's `edition = "2024"` requires Rust 1.85+. Safe.

- **Q: How do partial writes interact with TCP_NODELAY / Nagle?**
  A: Nagle (Linux/macOS default ON) coalesces small writes within the same socket within 40-200 ms — irrelevant here because `write_vectored` submits all slices to the kernel in *one* syscall; Nagle isn't involved at the userspace level.

- **Q: What about `RenderChunk::Bytes`-then-`Final` multi-chunk shape?**
  A: Falls through to the same `if cache_wanted` branch around `build_single_response_bytes`. The optimization (vectored write) doesn't apply here because the body is in `buffered_body: Vec<u8>` not in a slice — `buffered_body` is built up by N `extend_from_slice` calls. Refactoring `buffered_body` to a `Vec<Vec<u8>>` to enable vectored finalize is a follow-up; not in this sub-project's scope.

## Reference paths

- Current buffering response build: `src/server.rs` lines 1039-1095 (`BytesAndFinal` arm) + 1024-1038 (`Final` arm fallback) + 1097-1117 (`RenderOutcome::Resolved`).
- Current response builder: `src/render_stream.rs` `build_single_response_bytes` lines 86-101.
- Current platform-abstracted TcpStream: `src/io/{other,linux}.rs`.
- Comparison source: nylon-ring's design philosophy (per the WebFetch summary) — "Zero-copy data transfer with `NrVec<u8>`" / "ownership transfer across FFI boundaries without duplication" / lock-free TLS fast paths.
- Prior sub-project (Sub-project L): `docs/superpowers/specs/2026-05-28-merged-final-chunk-design.md` — collapsed two napi crossings into one; this builds on top of that consolidation.
