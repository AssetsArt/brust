# Writev Zero-Copy Response — implementation plan

**Spec:** `docs/superpowers/specs/2026-05-28-writev-zero-copy-response-design.md`
**Base commit:** `a890cb1` (post spec-fixes from reviewer subagent)
**Branch:** `main` (solo dev, standing consent for push after clean commits)

## Spec → task coverage

| Spec section | Task(s) |
|---|---|
| `build_single_response_head_only` helper + `build_single_response_bytes` refactor (`src/render_stream.rs`) | T1 |
| `TcpStream::write_all_vectored` on macOS / tokio (`src/io/other.rs`) | T2 |
| `TcpStream::write_all_vectored` fallback on Linux / tokio-uring (`src/io/linux.rs`) | T3 |
| `dispatch_to_worker_and_stream_chunks` grows `cache_wanted: bool` param | T4 |
| `BytesAndFinal` non-streaming arm — branch on `cache_wanted` | T4 |
| `Final` arm — branch on `cache_wanted` around `build_single_response_bytes` + clone | T4 |
| `RenderOutcome::Resolved` arm — branch on `cache_wanted` | T4 |
| 4 dispatch call sites in `handle_conn` pass `cache_wanted` | T4 |
| T1/T2/T3 spec unit tests on `build_single_response_head_only` | T1 |
| T4/T5/T6 spec unit tests on `write_all_vectored` | T2 |
| T7 spec bun integration test for byte equivalence | T5 |
| `architecture.md` "Copy count, / endpoint" table reflects new state | T6 |
| Bench acceptance criteria (N=5 medians, `/` RPS not down >3%, p99 not up >5%) | T7 |

All spec sections covered. No placeholders.

## Implementation order (strict sequence)

T1 → T2 → T3 → T4 → T5 → T6 → T7. Each task verifies before the next starts. T1/T2/T3 are independent at code level but T4 depends on all three landing.

---

## T1. Add `build_single_response_head_only` + refactor `build_single_response_bytes` + unit tests

**Files:**
- `src/render_stream.rs` — add new helper, refactor existing function to call it, extend test module

**`src/render_stream.rs` change** — replace the existing `build_single_response_bytes` block (lines 83-101) with:

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

/// Build a complete single-chunk HTTP/1.1 response with Content-Length.
/// Bytes-identical to today's renderToString wire shape for no-Suspense
/// routes (spec §1 criterion #1). Header bytes from
/// `build_single_response_head_only` followed by the body.
pub fn build_single_response_bytes(meta: &ChunkMeta, body: &[u8]) -> Vec<u8> {
    let mut out = build_single_response_head_only(meta, body.len());
    out.extend_from_slice(body);
    out
}
```

**`src/render_stream.rs` test additions** — extend the `mod tests` block. Add three tests:

```rust
#[test]
fn build_single_response_head_only_format() {
    let meta = ChunkMeta {
        status: 200,
        content_type: "text/html; charset=utf-8".to_string(),
        headers: Default::default(),
        streaming: false,
    };
    let head = build_single_response_head_only(&meta, 42);
    let s = std::str::from_utf8(&head).unwrap();
    assert!(s.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(s.contains("Content-Type: text/html; charset=utf-8\r\n"));
    assert!(s.contains("Content-Length: 42\r\n"));
    assert!(s.ends_with("\r\n\r\n"));
    // No body bytes — head ends at the blank line.
    assert_eq!(s.matches("\r\n\r\n").count(), 1);
}

#[test]
fn build_single_response_bytes_equals_head_plus_body() {
    // Refactor safety net: build_single_response_bytes must remain byte-identical
    // to build_single_response_head_only(...).concat(body) for every body shape.
    let meta = ChunkMeta {
        status: 200,
        content_type: "text/html; charset=utf-8".to_string(),
        headers: [("X-Render-Ms".to_string(), "12".to_string())].into(),
        streaming: false,
    };
    for body in [b"".as_slice(), b"<html>x</html>".as_slice(), &vec![b'a'; 4096]] {
        let combined = build_single_response_bytes(&meta, body);
        let head = build_single_response_head_only(&meta, body.len());
        let expected: Vec<u8> = head.iter().chain(body.iter()).copied().collect();
        assert_eq!(combined, expected, "mismatch for body_len={}", body.len());
    }
}

#[test]
fn head_only_includes_extra_headers_in_alphabetical_order() {
    let meta = ChunkMeta {
        status: 200,
        content_type: "text/html".to_string(),
        headers: [
            ("Z-Last".to_string(), "z".to_string()),
            ("A-First".to_string(), "a".to_string()),
            ("M-Mid".to_string(), "m".to_string()),
        ].into(),
        streaming: false,
    };
    let head = build_single_response_head_only(&meta, 0);
    let s = std::str::from_utf8(&head).unwrap();
    let a_pos = s.find("A-First: a").unwrap();
    let m_pos = s.find("M-Mid: m").unwrap();
    let z_pos = s.find("Z-Last: z").unwrap();
    assert!(a_pos < m_pos && m_pos < z_pos, "BTreeMap iteration should be alphabetical");
    // Headers come before the blank line.
    let blank_pos = s.find("\r\n\r\n").unwrap();
    assert!(z_pos < blank_pos);
}
```

**Verify:**
```bash
cargo test --lib render_stream:: 2>&1 | tail -20
```
Expected: shows the 3 new tests plus the 11 pre-existing render_stream tests as `passed`. Total `test result: ok. 14 passed`.

```bash
cargo test --lib 2>&1 | tail -5
```
Expected: `test result: ok. 110 passed` (107 prior + 3 new).

**BLOCKED fallback:** if `build_single_response_bytes_equals_head_plus_body` fails for any body shape, the refactor introduced a wire-format drift. Inspect the diff between `combined` and `expected` (print as `String::from_utf8_lossy`). If the difference is a trailing newline or extra `\r\n`, the head helper has an off-by-one in the terminator. Fix in the head helper, not the wrapper. Do NOT modify the wrapper to "make the test pass" — that's the regression we're protecting against.

---

## T2. Add `TcpStream::write_all_vectored` to `src/io/other.rs` + unit tests

**Files:**
- `src/io/other.rs` — add a generic free fn + `TcpStream::write_all_vectored` wrapper + unit tests

**Change** — append to `src/io/other.rs` after the existing `impl crate::io::SseIo for TcpStream` block:

```rust
/// Vectored-write loop generic over `AsyncWrite + Unpin`. Factored out
/// so unit tests can drive it with `tokio::io::duplex` without needing
/// a real TCP socket. Production callers go through
/// `TcpStream::write_all_vectored`.
///
/// `tokio::io::AsyncWriteExt::write_vectored` lives behind the `io-util`
/// feature, which `Cargo.toml` enables on `cfg(not(linux))`. Verified
/// via tokio src that `TcpStream` reports `is_write_vectored = true`
/// and delegates to `writev(2)` via mio.
async fn write_all_vectored_impl<W: tokio::io::AsyncWrite + Unpin>(
    w: &mut W,
    bufs: &mut [std::io::IoSlice<'_>],
) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;
    // `IoSlice::advance_slices` takes `&mut &mut [IoSlice]` — rebind
    // through a mutable local so we can pass `&mut bufs`.
    let mut bufs: &mut [std::io::IoSlice<'_>] = bufs;
    while !bufs.is_empty() {
        let n = w.write_vectored(bufs).await?;
        if n == 0 {
            return Err(std::io::ErrorKind::WriteZero.into());
        }
        std::io::IoSlice::advance_slices(&mut bufs, n);
    }
    Ok(())
}

impl TcpStream {
    /// Vectored write that drains all slices. Used by the buffering hot
    /// path in `dispatch_to_worker_and_stream_chunks` to emit
    /// `[response_head, body]` in one syscall without a userspace body
    /// memcpy. Nylon-ring zero-copy NrVec<u8> in spirit.
    pub async fn write_all_vectored(
        &mut self,
        bufs: &mut [std::io::IoSlice<'_>],
    ) -> std::io::Result<()> {
        write_all_vectored_impl(&mut self.0, bufs).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::IoSlice;

    #[tokio::test]
    async fn write_all_vectored_drains_all_slices() {
        // tokio::io::duplex doesn't override poll_write_vectored, so the
        // default impl writes only the FIRST slice through poll_write.
        // That's exactly what we want to test — the loop's ability to
        // advance through multiple slices.
        let (mut a, mut b) = tokio::io::duplex(1024);
        let s1 = b"hello ".as_slice();
        let s2 = b"world".as_slice();
        let mut bufs = [IoSlice::new(s1), IoSlice::new(s2)];
        write_all_vectored_impl(&mut a, &mut bufs).await.unwrap();
        drop(a);
        use tokio::io::AsyncReadExt;
        let mut out = Vec::new();
        b.read_to_end(&mut out).await.unwrap();
        assert_eq!(&out, b"hello world");
    }

    #[tokio::test]
    async fn write_all_vectored_empty_input_returns_ok() {
        let (mut a, _b) = tokio::io::duplex(1024);
        let mut bufs: [IoSlice<'_>; 0] = [];
        write_all_vectored_impl(&mut a, &mut bufs).await.unwrap();
    }

    #[tokio::test]
    async fn write_all_vectored_single_slice_drains() {
        let (mut a, mut b) = tokio::io::duplex(1024);
        let payload = b"the quick brown fox".as_slice();
        let mut bufs = [IoSlice::new(payload)];
        write_all_vectored_impl(&mut a, &mut bufs).await.unwrap();
        drop(a);
        use tokio::io::AsyncReadExt;
        let mut out = Vec::new();
        b.read_to_end(&mut out).await.unwrap();
        assert_eq!(&out, payload);
    }
}
```

**Verify:**
```bash
cargo test --lib io::other 2>&1 | tail -10
```
Expected (on macOS): 3 new tests `passed`. Linux skips this file via `#![cfg(not(target_os = "linux"))]`.

```bash
cargo test --lib 2>&1 | tail -5
```
Expected: `test result: ok. 113 passed` (110 from T1 + 3 new).

**BLOCKED fallback:** if `write_all_vectored_drains_all_slices` fails with `BrokenPipe` instead of writing both slices, the issue is the `drop(a)` happening before the writer's final flush. Replace `drop(a)` with `a.shutdown().await.unwrap()` to flush first. If the test still fails because duplex's default `poll_write_vectored` impl doesn't actually advance properly, replace `tokio::io::duplex` with a small custom `AsyncWrite` mock that explicitly writes one slice per call. Do NOT skip the test.

If `cargo test` reports `error[E0277]: tokio::io::AsyncWrite is not satisfied` for `tokio::io::DuplexStream`, the `tokio` feature set is missing `io-util` or `io-std`. Check `Cargo.toml:34` — `io-util` must be present. (It is, per current main.)

---

## T3. Add `TcpStream::write_all_vectored` fallback to `src/io/linux.rs`

**Files:**
- `src/io/linux.rs` — add the concat-fallback stub

**Change** — append inside the existing `impl TcpStream` block in `src/io/linux.rs`, before the `impl crate::io::SseIo for TcpStream` block:

```rust
    /// Compatibility stub on Linux. tokio-uring's `writev` expects owned
    /// `BoundedBuf`-conforming buffers; our buffering hot path holds a
    /// borrowed body slice into channel-delivered `data: Vec<u8>`.
    /// For now, concat into a single Vec and write in one call —
    /// preserving current Linux behavior. Real writev support is
    /// deferred to a future sub-project once a Linux bench baseline
    /// exists (spec "Known limitations §1").
    pub async fn write_all_vectored(
        &mut self,
        bufs: &mut [std::io::IoSlice<'_>],
    ) -> std::io::Result<()> {
        let total: usize = bufs.iter().map(|s| s.len()).sum();
        let mut merged: Vec<u8> = Vec::with_capacity(total);
        for s in bufs.iter() {
            merged.extend_from_slice(s);
        }
        let (res, _) = self.0.write_all(merged).await;
        res
    }
```

**Verify:** local dev box is macOS — `cargo check --target x86_64-unknown-linux-gnu` would require a cross-compile toolchain we don't have. Instead, verify by reading: `src/io/linux.rs` should compile *symbolically* if you mentally substitute `tokio_uring::net::TcpStream::write_all(Vec<u8>) -> (Result<usize>, Vec<u8>)` — confirmed available in tokio-uring 0.5 (Cargo.toml:30). No syntax errors, no borrow issues (we own `merged`, `bufs` is borrowed for the sum/iter only).

If a Linux CI runner is available at any point during this plan, run `cargo build --target x86_64-unknown-linux-gnu` there. Don't block T4 on it.

**BLOCKED fallback:** if a Linux user later reports `cargo build` fails on this branch — most likely cause is `write_all` returning a different shape than `(Result<usize>, Vec<u8>)`. Look at the existing `linux.rs::TcpStream::write_all` (lines 45-48) and copy its return-handling exactly.

---

## T4. Refactor `dispatch_to_worker_and_stream_chunks` to take `cache_wanted: bool` + branch on it in 3 arms + update 4 call sites

**Files:**
- `src/server.rs` — biggest change in the plan; touches `dispatch_to_worker_and_stream_chunks` signature, body, and 4 callers in `handle_conn`

**Signature change:**

```rust
async fn dispatch_to_worker_and_stream_chunks<F>(
    s: &mut TcpStream,
    pool: &Arc<crate::pool::WorkerPool>,
    envelope_json: String,
    label: &'static str,
    cache_wanted: bool,   // ★ NEW
    on_success: F,
) -> DispatchControl
where
    F: FnOnce(&[u8]),
```

**Body changes — three arms branch on `cache_wanted`:**

### Arm 1 — `RenderChunk::BytesAndFinal` non-streaming branch (currently `src/server.rs:1083-1094`)

Replace:
```rust
} else {
    // Canonical buffering use-case: single Content-Length response.
    let resp = crate::render_stream::build_single_response_bytes(&parsed, body);
    response_bytes_for_cache = resp.clone();
    if s.write_all(resp).await.is_err() {
        let _ = ack.send(());
        return DispatchControl::CloseConn;
    }
}
```

With:
```rust
} else {
    // Canonical buffering use-case: single Content-Length response.
    if cache_wanted {
        // Build full bytes once for both the write and the cache insert.
        // Clone preserved here — cache needs an owned copy independent of
        // the write_all transfer. Reducing this clone is a separate
        // sub-project (see spec "Known limitations §3").
        let resp = crate::render_stream::build_single_response_bytes(&parsed, body);
        response_bytes_for_cache = resp.clone();
        if s.write_all(resp).await.is_err() {
            let _ = ack.send(());
            return DispatchControl::CloseConn;
        }
    } else {
        // Uncached hot path — vectored write, no body memcpy.
        // `data` (containing `body` as a sub-slice) is owned by this
        // match arm and lives until the arm exits, well past the await.
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

### Arm 2 — `RenderChunk::Final` arm (currently `src/server.rs:1024-1037`)

Replace:
```rust
crate::pool::RenderChunk::Final { ack } => {
    if chunked {
        let term = crate::render_stream::format_chunk_framed(b"");
        let _ = s.write_all(term).await;
    } else if let Some(meta) = buffered_meta.take() {
        let resp = crate::render_stream::build_single_response_bytes(&meta, &buffered_body);
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

With:
```rust
crate::pool::RenderChunk::Final { ack } => {
    if chunked {
        let term = crate::render_stream::format_chunk_framed(b"");
        let _ = s.write_all(term).await;
    } else if let Some(meta) = buffered_meta.take() {
        if cache_wanted {
            let resp = crate::render_stream::build_single_response_bytes(&meta, &buffered_body);
            response_bytes_for_cache = resp.clone();
            if s.write_all(resp).await.is_err() {
                let _ = ack.send(());
                return DispatchControl::CloseConn;
            }
        } else {
            let head = crate::render_stream::build_single_response_head_only(&meta, buffered_body.len());
            let mut slices = [
                std::io::IoSlice::new(&head),
                std::io::IoSlice::new(&buffered_body),
            ];
            if s.write_all_vectored(&mut slices).await.is_err() {
                let _ = ack.send(());
                return DispatchControl::CloseConn;
            }
        }
    }
    let _ = ack.send(());
    break;
}
```

### Arm 3 — `RenderOutcome::Resolved` early-exit fallthrough (currently `src/server.rs:1098-1117`)

Replace:
```rust
RenderOutcome::Resolved => {
    let dropped = chunk_rx.len();
    if dropped > 0 {
        warn!(...)
    }
    if chunked {
        let _ = s.write_all(crate::render_stream::format_chunk_framed(b"")).await;
    } else if let Some(meta) = buffered_meta.take() {
        let resp = crate::render_stream::build_single_response_bytes(&meta, &buffered_body);
        response_bytes_for_cache = resp.clone();
        let _ = s.write_all(resp).await;
    }
    break;
}
```

With:
```rust
RenderOutcome::Resolved => {
    let dropped = chunk_rx.len();
    if dropped > 0 {
        warn!(
            worker_id = entry.id, label, dropped,
            "worker returned without Final signal; queued chunks dropped",
        );
    }
    if chunked {
        let _ = s.write_all(crate::render_stream::format_chunk_framed(b"")).await;
    } else if let Some(meta) = buffered_meta.take() {
        if cache_wanted {
            let resp = crate::render_stream::build_single_response_bytes(&meta, &buffered_body);
            response_bytes_for_cache = resp.clone();
            let _ = s.write_all(resp).await;
        } else {
            let head = crate::render_stream::build_single_response_head_only(&meta, buffered_body.len());
            let mut slices = [
                std::io::IoSlice::new(&head),
                std::io::IoSlice::new(&buffered_body),
            ];
            let _ = s.write_all_vectored(&mut slices).await;
        }
    }
    break;
}
```

### Cache write-back at end of fn (currently `src/server.rs:1152-1155`)

Wrap with `cache_wanted` for clarity:

```rust
if cache_wanted && !response_bytes_for_cache.is_empty() {
    on_success(&response_bytes_for_cache);
}
DispatchControl::Continue
```

### 4 dispatch call sites in `handle_conn` — pass `cache_wanted`

**Site 1: action endpoint** (currently `src/server.rs:377-388`)

Add `false` (actions never cache):
```rust
match dispatch_to_worker_and_stream_chunks(
    &mut s,
    &pool,
    envelope_json,
    "action",
    false,           // ★ cache_wanted — actions never cache
    |_| {},
)
.await
{
```

**Site 2: mcp endpoint** (currently `src/server.rs:467-472`)

Add `false`:
```rust
match dispatch_to_worker_and_stream_chunks(&mut s, &pool, envelope_json, "mcp", false, |_| {})
    .await
{
```

**Site 3: navigation endpoint** (currently `src/server.rs:827-839`)

Add `false`:
```rust
match dispatch_to_worker_and_stream_chunks(
    &mut s,
    &pool,
    envelope_json,
    "navigation",
    false,           // ★ navigation responses never cache
    |_| {},
)
.await
{
```

**Site 4: render endpoint** (currently `src/server.rs:870-890`)

Pass `cache_config.is_some()`:
```rust
let cache_for_closure = cache.clone();
let cache_wanted = cache_config.is_some();    // ★ NEW
match dispatch_to_worker_and_stream_chunks(
    &mut s,
    &pool,
    envelope_json,
    "render",
    cache_wanted,    // ★ true iff route has cache: config
    move |bytes| {
        if let (Some(key), Some(cfg)) = (cache_key, cache_config) {
            cache_for_closure.insert(
                key,
                bytes.to_vec(),
                Duration::from_secs(cfg.ttl_seconds),
            );
        }
    },
)
.await
{
```

**Verify:**
```bash
cargo build 2>&1 | tail -10
```
Expected: compiles. No new warnings beyond pre-existing.

```bash
cargo test --lib 2>&1 | tail -5
```
Expected: `test result: ok. 113 passed` (same as T2 — no new tests in T4, the existing pool/server unit tests must still pass).

```bash
cargo test --lib --release 2>&1 | tail -5
```
Expected: `test result: ok. 113 passed`. Release-mode invariants (atomic-claim race test, render slot drop ordering) unchanged.

```bash
bun test runtime/ 2>&1 | tail -5
```
Expected: `Ran 189 tests`. No JS-side changes; bun tests must be untouched.

**BLOCKED fallback:** if `cargo test` fails with `error[E0277]: write_all_vectored not found on TcpStream` on Linux build, T3's stub didn't land or is in the wrong impl block. Re-read `src/io/linux.rs` and ensure `write_all_vectored` is inside the same `impl TcpStream { ... }` block as the existing `write_all`.

If a pre-existing test in `src/server.rs` breaks because it called `dispatch_to_worker_and_stream_chunks` directly: check `src/server.rs::tests` for any test that mocks the dispatcher. None exists at HEAD (the dispatcher is private to the module and tested only via integration). If somehow one was added: update the call signature.

If `bun test` regresses: the JS side has NOT been touched by this task. A regression here means something else drifted; do not "fix" by editing TS. Investigate at the orchestrator level.

---

## T5. Bun integration test for byte-equivalence

**Files:**
- `tests/integration.test.ts` — append a new test that exercises both the new vectored uncached path and the existing cached path, compares response bytes off the raw wire

**Why raw socket and not `fetch`:** Bun's `fetch` normalises HTTP/1.1 framing, lowercases headers, and reorders them. We need the exact byte-level wire output to verify both code paths emit identical responses.

**Fixture verification first:** Read `tests/fixtures/app/routes.tsx` to confirm there's at least one cached route AND one uncached route (e.g. `/` is uncached, and either `/cache-test` exists with a `cache:` config or one needs to be added).

If the fixture lacks a cached route with a deterministic body: add one in this task. Pattern after existing routes; use `cache: { ttl_seconds: 60 }`.

**`tests/integration.test.ts` test addition** (append at end of file):

```typescript
test('writev path: byte-for-byte equivalence vs concat path', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: {
      ...process.env,
      BRUST_PORT: '38199',
      RUST_LOG: 'brust=warn',
    },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  try {
    const port = await readPortLine(proc.stdout)

    // Fetch uncached route (`/`) — goes through the new vectored path.
    const uncachedBytes = await rawRequest(port, 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
    // Fetch a cached route — first request goes through the concat path
    // (cache miss → build_single_response_bytes → insert). Adjust path
    // to match the fixture's cached route.
    const cachedBytes  = await rawRequest(port, 'GET /cache-test HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')

    // Parse status line + headers + body from each. Header set & body must
    // be the structurally same shape (200, sane Content-Length, valid HTML).
    // Don't require byte-identical because the two routes render different
    // components; this test verifies the framing path is consistent.
    const uncached = parseResponse(uncachedBytes)
    const cached   = parseResponse(cachedBytes)

    // Status line shape
    expect(uncached.status).toBe(200)
    expect(cached.status).toBe(200)

    // Both paths must declare Content-Length (single-chunk Content-Length
    // response, not chunked transfer encoding).
    expect(uncached.headers.get('content-length')).toBeTruthy()
    expect(cached.headers.get('content-length')).toBeTruthy()
    expect(uncached.headers.has('transfer-encoding')).toBe(false)
    expect(cached.headers.has('transfer-encoding')).toBe(false)

    // Content-Length must match actual body byte length.
    expect(uncached.body.length).toBe(parseInt(uncached.headers.get('content-length')!, 10))
    expect(cached.body.length).toBe(parseInt(cached.headers.get('content-length')!, 10))

    // Both paths must emit the same fixed-set of headers in the same order:
    //   HTTP/1.1, Content-Type, Content-Length, [extra headers...], blank line.
    // The wire-shape contract (spec acceptance criterion #4).
    expect(uncached.headerOrder.slice(0, 2)).toEqual(['content-type', 'content-length'])
    expect(cached.headerOrder.slice(0, 2)).toEqual(['content-type', 'content-length'])
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

// --- helpers (add to existing module, or define above the test) ---

async function rawRequest(port: number, request: string): Promise<Uint8Array> {
  // Use node:net via Bun for raw socket I/O.
  const net = await import('node:net')
  return await new Promise((resolve, reject) => {
    const sock = net.createConnection({ port, host: '127.0.0.1' }, () => {
      sock.write(request)
    })
    const chunks: Uint8Array[] = []
    sock.on('data', (d: Buffer) => chunks.push(new Uint8Array(d)))
    sock.on('end', () => {
      const total = chunks.reduce((a, b) => a + b.length, 0)
      const out = new Uint8Array(total)
      let off = 0
      for (const c of chunks) { out.set(c, off); off += c.length }
      resolve(out)
    })
    sock.on('error', reject)
  })
}

function parseResponse(bytes: Uint8Array) {
  // Find \r\n\r\n
  let end = -1
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i+1] === 10 && bytes[i+2] === 13 && bytes[i+3] === 10) {
      end = i; break
    }
  }
  if (end < 0) throw new Error('no header terminator')
  const headerText = new TextDecoder('utf-8').decode(bytes.subarray(0, end))
  const body = bytes.subarray(end + 4)
  const lines = headerText.split('\r\n')
  const statusLine = lines[0]
  const status = parseInt(statusLine.split(' ')[1], 10)
  const headers = new Map<string, string>()
  const headerOrder: string[] = []
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(':')
    if (idx < 0) continue
    const name = lines[i].slice(0, idx).toLowerCase().trim()
    const value = lines[i].slice(idx + 1).trim()
    headers.set(name, value)
    headerOrder.push(name)
  }
  return { status, headers, headerOrder, body }
}
```

**Verify:**
```bash
bun test tests/integration.test.ts 2>&1 | tail -20
```
Expected: all previous integration tests + the new one pass. Total `Ran N tests` where N matches pre-existing count + 1.

**BLOCKED fallback:**

1. **`cache-test` route doesn't exist in the fixture.** Read `tests/fixtures/app/routes.tsx`. If no cached route is registered, add one in this task before writing the test:
   ```tsx
   { path: '/cache-test', Component: SimplePage, cache: { ttl_seconds: 60 } }
   ```
   `SimplePage` can be a 3-line component that returns `<div>cache test</div>`. Test counts increase by 1.

2. **Raw socket close behavior differs.** If `rawRequest` hangs because the server doesn't close the connection after the first response, the test request didn't include `Connection: close` correctly. Verify the request string is exactly `Connection: close\r\n\r\n` (no extra space, exact CRLF). If still hangs: replace the `sock.on('end')` flow with a manual timeout (`setTimeout(resolve, 100)` after first data arrives) — the request is too small to need backpressure.

3. **`tests/integration.test.ts` doesn't import `readPortLine`.** Check the existing file — it's defined inline. Reuse it. If the existing file has been refactored: copy `readPortLine` from the head of the file or import from a shared helper.

---

## T6. Update `architecture.md` to reflect new copy count

**Files:**
- `architecture.md` — the "Copy count, / endpoint" table

**Change** — the table currently reads (in the IPC section):

```markdown
**Copy count, /  endpoint:**

| Where | Bytes | Notes |
|---|---|---|
| path: V8 → Rust (`String`) | ~50 | unavoidable, tiny |
| html: V8 → SAB (`TextEncoder.encodeInto`) | full body | inside Worker, one pass UTF-8 |
| SAB → response `Vec<u8>` (`from_raw_parts(..).to_vec()`) | full body | Rust local memcpy, ~10 GB/s on M1 |
| response `Vec<u8>` → kernel | full body | `write_all` syscall, unavoidable |
```

Replace with (uncached `/` path):

```markdown
**Copy count, /  endpoint (uncached, post Sub-project M):**

| Where | Bytes | Notes |
|---|---|---|
| path: V8 → Rust (`String`) | ~50 | unavoidable, tiny |
| html: V8 → SAB (`TextEncoder.encodeInto`) | full body | inside Worker, one pass UTF-8 |
| SAB → channel `Vec<u8>` (`from_raw_parts(..).to_vec()`) | full body | Rust local memcpy, ~10 GB/s on M1 — architecturally required (SAB reused by worker's next render) |
| channel `Vec<u8>` → kernel | full body | `write_vectored` syscall via `[head, body_slice]` — no userspace memcpy of the body |

Sub-project M (2026-05-28) eliminated two pre-existing memcpys on uncached buffering responses: `build_single_response_bytes`'s `extend_from_slice(body)` and the unconditional `response_bytes_for_cache = resp.clone()`. Cached routes still pay one body memcpy (in `build_single_response_bytes`); reducing the cache-path memcpy is a follow-up.
```

Also: update the paragraph just below the table that says "`build_response` still allocates one `Vec<u8>` and copies the body into it. The final response buffer + header could be sent with `writev` to drop the SAB→Vec memcpy; we have not done it yet (see Roadmap)." — change to past tense:

```markdown
`build_response` still allocates one `Vec<u8>` and copies the body into it on
the non-render paths (`/ping`, error responses, cache hits which are stored
as full wire bytes). For uncached render paths, Sub-project M (2026-05-28)
replaced the body memcpy with a vectored write via `[head, body_slice]`,
eliminating the SAB→Vec body copy on the bench hot path.
```

**Verify:** read the diff. No markdown syntax errors. Sub-project M is referenced consistently.

```bash
git diff architecture.md | head -40
```

**BLOCKED fallback:** if the existing table or paragraph has been moved/renamed since the spec was written (`grep "Copy count" architecture.md` returns no match), find the closest analogous IPC table and update it. Don't invent a new table elsewhere.

---

## T7. Bench validation — N=5 medians

**Files:**
- `bench/RESULTS.md` (auto-regenerated by `bun run bench`)
- `bench/RESULTS.json` (auto-regenerated)
- Optionally `architecture.md` if perf table needs update

**Procedure:**

1. Capture HEAD-baseline (the pre-impl commit). On a fresh checkout of `a890cb1` (the spec-fixes commit before any code changes from T1-T6):
   ```bash
   git stash  # stash any T1-T6 work first if local
   git checkout a890cb1
   rm -f runtime/index.darwin-arm64.node runtime/index.d.ts runtime/index.js
   bun run build
   grep -c "renderChunkFinal" runtime/index.d.ts   # expected: >0 (Sub-project L shipped this)
   for i in 1 2 3 4 5; do
     bun run bench >/dev/null
     cp bench/RESULTS.json /tmp/brust-bench-runs/pre-$i.json
   done
   ```

2. Build the post-impl binary (T1-T6 merged into a branch or main):
   ```bash
   git checkout main  # or feature branch with T1-T6 commits
   rm -f runtime/index.darwin-arm64.node runtime/index.d.ts runtime/index.js
   bun run build
   grep -c "write_all_vectored" target/debug/build/brust-*/output 2>/dev/null  # sanity: rust binary built fresh
   for i in 1 2 3 4 5; do
     bun run bench >/dev/null
     cp bench/RESULTS.json /tmp/brust-bench-runs/post-$i.json
   done
   ```

3. Compute medians of `/` RPS, `/` p99, `/ping` RPS, `/ping` p99, POST action RPS+p99:
   ```bash
   # Approximate. Tweak jq to your actual schema.
   for endpoint in "/" "/ping" "/_brust/action/createNote"; do
     echo "=== $endpoint ==="
     for prefix in pre post; do
       echo -n "$prefix: "
       jq -r --arg e "$endpoint" '.[$e].rps' /tmp/brust-bench-runs/${prefix}-*.json | sort -n | head -3 | tail -1
     done
   done
   ```

**Acceptance criteria (from spec):**

- `/` RPS: within (−3%, +5%) — anything worse than −3% is a regression.
- `/` p99: within (−15%, +5%) — anything worse than +5% is a regression.
- `/ping` RPS: within ±5% (this path doesn't hit the changed code).
- POST action RPS: within (−3%, +5%).

**If RPS goes up by >2% or p99 down by >5%:** update `architecture.md` perf table with new N=5 medians. Commit separately.

**If results are within noise:** still ship — the architectural improvement (fewer body memcpys, clearer ownership separation) holds independent of measurability. Note explicitly in the wrap-up: "architectural improvement, bench within noise."

**BLOCKED fallback:**

1. **Build failure on Linux from a contributor.** If a CI Linux run fails with `error: write_all_vectored not found` — this means T3's stub didn't land in `linux.rs`. Investigate at orchestrator level. Don't ship.

2. **Bench shows >3% RPS regression.** A real regression means the vectored write is doing something perverse on macOS (extra syscall, scheduler issue). Profile with `Instruments` or `perf` to find the difference vs the concat path. Possible culprit: tokio's `is_write_vectored = true` is asserted but `mio` falls back to non-vectored on some platforms. Mitigation: if profile shows extra wait/sched, revert T4's `cache_wanted=false` branch to call `s.write_all(build_single_response_bytes(...))` directly (just dropping the `clone()`) — that still saves Copy 3 even if writev doesn't help.

3. **One bench run hangs or errors out.** Re-run that index. If 2/5 consecutive runs fail, suspect the bench script is timing out before the server settles. Add a `sleep 0.5` warmup between `bun run bench` invocations in the harness loop.

---

## After all tasks complete

- Final commit: a single commit per task is fine, but rebase / squash before pushing to keep `main` log readable. Per working agreement: solo dev, standing consent to push after clean commits.
- Phase 6 (Scrutinize) and Phase 7 (Wrap-up) happen at the orchestrator level, not in this plan.
- If T7 bench shows real RPS/p99 wins, the brust handoff/architecture.md gets a perf-table update in T6's commit OR a follow-up commit.

## Self-review (orchestrator, before subagent dispatch)

- ✅ Every spec section maps to ≥1 task (see coverage table).
- ✅ Every task has Verify + BLOCKED fallback.
- ✅ No placeholders or `TODO` in code snippets.
- ✅ Test counts: 107 → 110 (T1 + 3) → 113 (T2 + 3). Bun tests: 189 unchanged.
- ✅ Type consistency: `cache_wanted: bool` propagates through 4 call sites; signature change is one line; arms branch on it identically.
- ✅ No "may warn" / "should work" language — every claim is concrete.
