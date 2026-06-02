# HTML Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the worker's `renderToString` path with React 18 `renderToPipeableStream`. Auto-detect Suspense: no-Suspense routes get a byte-identical single-chunk response; Suspense-pending routes stream via HTTP/1.1 chunked transfer-encoding. One new NAPI fn, one new Rust module, one new TS module.

**Architecture:** Worker registers ONE renderer that always uses `renderToPipeableStream`. Chunks flow from worker to Rust via a side channel (`napi_render_chunk` + per-worker `render_slot`). Rust commits headers (`Content-Length` vs `Transfer-Encoding: chunked`) based on a `streaming` flag in the per-response meta, decided at `onShellReady` from React's `pendingSuspenseBoundaries`. Single mpsc-1 backpressure channel; RAII guard on slot lifecycle.

**Tech Stack:** Rust (tokio + napi-rs 3 + tokio-tungstenite-style mpsc), TypeScript (Bun runtime, React 18 server stream, Node.js Writable adapter), HTTP/1.1 chunked transfer-encoding.

**Spec:** `docs/superpowers/specs/2026-05-26-html-streaming-design.md` (582 lines, post-3-agent-review revision).

---

## Phase 1: Scaffolding (compiles unchanged after each task)

### Task 1: `RenderChunk` + `RenderSlot` + `RenderSlotGuard` in `src/pool.rs`

Add the side-channel types + the `render_slot` field on `TsfnEntry`. Leave `RendererTsfn` unchanged for now (still `Promise<u32>`) — the contract switch happens in Task 5. Existing `in_flight: AtomicU32` busy-counter stays untouched.

**Files:**
- Modify: `src/pool.rs`
- Test: `src/pool.rs` (`#[cfg(test)] mod tests`)

- [ ] **Step 1: Write failing tests at the bottom of `src/pool.rs`**

Append to `src/pool.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::{mpsc, oneshot};

    #[test]
    fn render_slot_set_clear_round_trip() {
        // RenderSlot installed under Mutex, then cleared via take().
        let slot_mu: parking_lot::Mutex<Option<RenderSlot>> = parking_lot::Mutex::new(None);
        assert!(slot_mu.lock().is_none());
        let (tx, _rx) = mpsc::channel::<RenderChunk>(1);
        *slot_mu.lock() = Some(RenderSlot { chunk_tx: tx });
        assert!(slot_mu.lock().is_some());
        let taken = slot_mu.lock().take();
        assert!(taken.is_some());
        assert!(slot_mu.lock().is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn render_chunk_enum_bytes_ack_round_trip() {
        let (tx, mut rx) = mpsc::channel::<RenderChunk>(1);
        let (ack_tx, ack_rx) = oneshot::channel::<()>();
        tx.send(RenderChunk::Bytes { data: vec![1, 2, 3], ack: ack_tx }).await.unwrap();
        let got = rx.recv().await.unwrap();
        match got {
            RenderChunk::Bytes { data, ack } => {
                assert_eq!(data, vec![1, 2, 3]);
                ack.send(()).unwrap();
            }
            _ => panic!("expected Bytes variant"),
        }
        ack_rx.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn render_chunk_enum_final_ack_drop_returns_err() {
        // If the ack receiver is dropped before send, awaiting it returns Err.
        // This is what makes napi_render_chunk surface NAPI Err (NOT hang)
        // when handle_conn tears down mid-stream (spec S5.2 contract).
        let (ack_tx, ack_rx) = oneshot::channel::<()>();
        drop(ack_tx);
        assert!(ack_rx.await.is_err());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib pool::tests 2>&1 | tail -15`
Expected: FAIL with `cannot find type 'RenderSlot' / 'RenderChunk' in this scope`.

- [ ] **Step 3: Add the new types + field in `src/pool.rs`**

Insert these definitions BEFORE `pub struct TsfnEntry { ... }`:

```rust
/// One chunk delivered from a worker's `napi_render_chunk` call to handle_conn's
/// per-request chunk loop. `ack` resolves the worker's awaiting Promise so the
/// next chunk can be written into the SAB without overlapping.
pub enum RenderChunk {
    /// Chunk body (first chunk includes meta prefix per spec S4).
    Bytes { data: Vec<u8>, ack: tokio::sync::oneshot::Sender<()> },
    /// `napi_render_chunk(_, 0)` — close the channel, terminate the response.
    Final { ack: tokio::sync::oneshot::Sender<()> },
}

/// Per-worker per-request slot. Installed by handle_conn BEFORE calling
/// `tsfn.call_async`; cleared by `RenderSlotGuard::drop` on exit (RAII —
/// survives panic, cancellation, early returns).
pub struct RenderSlot {
    pub chunk_tx: tokio::sync::mpsc::Sender<RenderChunk>,
}
```

Modify `TsfnEntry` to add the `render_slot` field (keep the existing `in_flight: AtomicU32` untouched):

```rust
pub struct TsfnEntry {
    pub id: u32,
    pub tsfn: RendererTsfn,
    pub buf_ptr: BufPtr,
    pub buf_len: usize,
    pub in_flight: AtomicU32,
    pub render_slot: parking_lot::Mutex<Option<RenderSlot>>,
}
```

Update `WorkerPool::register` (currently around `src/pool.rs:59-70`) to initialise the new field:

```rust
pub fn register(&self, tsfn: RendererTsfn, buf_ptr: BufPtr, buf_len: usize) -> u32 {
    let id = self.next_id.fetch_add(1, Ordering::Relaxed);
    let entry = Arc::new(TsfnEntry {
        id,
        tsfn,
        buf_ptr,
        buf_len,
        in_flight: AtomicU32::new(0),
        render_slot: parking_lot::Mutex::new(None),
    });
    self.entries.write().push(entry);
    id
}
```

Add the RAII guard struct (anywhere in the file after `TsfnEntry`):

```rust
/// RAII guard that clears `TsfnEntry::render_slot` on Drop. Use as
/// `let _slot_guard = RenderSlotGuard { entry: &entry };` in handle_conn
/// after installing the slot. Survives panic + tokio cancellation +
/// early returns — all paths that would otherwise leak the sender and
/// strand the next request on this worker.
pub struct RenderSlotGuard<'e> {
    pub entry: &'e Arc<TsfnEntry>,
}

impl Drop for RenderSlotGuard<'_> {
    fn drop(&mut self) {
        self.entry.render_slot.lock().take();
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib pool::tests 2>&1 | tail -10`
Expected: `test result: ok. 3 passed`.

- [ ] **Step 5: Verify full build still compiles + no regression**

Run: `cargo test --lib 2>&1 | tail -3`
Expected: `test result: ok. 76 passed` (73 prior + 3 new).

- [ ] **Step 6: Commit**

```bash
git add src/pool.rs
git commit -m "$(cat <<'EOF'
feat(pool): scaffolding — RenderChunk enum + RenderSlot + RAII guard

Adds the side-channel types that html-streaming uses to deliver chunks
from workers to handle_conn. Leaves the renderer tsfn contract unchanged
(still Promise<u32>) — the cascade switch lands in a later task.

TsfnEntry gains a render_slot: Mutex<Option<RenderSlot>> field alongside
the existing in_flight: AtomicU32 busy-counter (different concerns;
spec S5.3 calls out the deliberate two-field shape so pick_least_busy
keeps working).

RenderSlotGuard's Drop impl is the load-bearing piece — without it,
tokio cancellation between slot insertion and the manual take() would
leak the sender forever.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `src/render_stream.rs` — chunked encoding helpers + `ChunkMeta`

New module with the pure functions Rust needs to wrap bodies in HTTP/1.1 chunked transfer-encoding + parse the per-chunk meta JSON.

**Files:**
- Create: `src/render_stream.rs`
- Modify: `src/lib.rs` (add `pub mod render_stream;`)

- [ ] **Step 1: Create `src/render_stream.rs` with failing tests**

Create the file with this exact content:

```rust
//! HTTP/1.1 chunked transfer-encoding helpers + per-chunk meta parser.
//! Used by the render+action branches of handle_conn after they switch
//! to the streaming dispatch helper.

use serde::Deserialize;

/// Per-chunk meta header that prefixes the FIRST chunk's body. Worker
/// writes `[meta_len: u16 BE][meta JSON UTF-8][body bytes]` into the SAB.
/// `split_meta` separates the JSON from the body for parsing.
#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct ChunkMeta {
    pub status: u16,
    #[serde(rename = "contentType")]
    pub content_type: String,
    pub headers: std::collections::BTreeMap<String, String>,
    /// `true` → use Transfer-Encoding: chunked. `false` → buffer into
    /// Content-Length single response.
    pub streaming: bool,
}

impl Default for ChunkMeta {
    fn default() -> Self {
        Self {
            status: 200,
            content_type: "text/html; charset=utf-8".to_string(),
            headers: Default::default(),
            streaming: false,
        }
    }
}

/// Split the first-chunk SAB layout `[meta_len: u16 BE][meta JSON][body]`
/// into (meta_slice, body_slice). Returns Err if the meta_len field is
/// missing or exceeds the buffer.
pub fn split_meta(buf: &[u8]) -> Result<(&[u8], &[u8]), &'static str> {
    if buf.len() < 2 { return Err("first chunk too short for meta_len header"); }
    let meta_len = u16::from_be_bytes([buf[0], buf[1]]) as usize;
    if 2 + meta_len > buf.len() { return Err("meta_len exceeds chunk size"); }
    Ok((&buf[2..2 + meta_len], &buf[2 + meta_len..]))
}

/// Format an HTTP/1.1 chunked-encoded chunk: `<hex_len>\r\n<bytes>\r\n`.
/// Empty `body` (len=0) returns the terminator (`0\r\n\r\n`).
pub fn format_chunk_framed(body: &[u8]) -> Vec<u8> {
    if body.is_empty() {
        return b"0\r\n\r\n".to_vec();
    }
    let mut out = format!("{:x}\r\n", body.len()).into_bytes();
    out.extend_from_slice(body);
    out.extend_from_slice(b"\r\n");
    out
}

/// Build the HTTP/1.1 response headers (no body) for a chunked stream.
/// Emits status line, fixed Transfer-Encoding: chunked, content-type,
/// then any extra headers from `meta.headers`, then the blank line.
pub fn build_chunked_response_head(meta: &ChunkMeta) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 {} {}\r\nTransfer-Encoding: chunked\r\nContent-Type: {}\r\n",
        meta.status,
        status_reason(meta.status),
        meta.content_type,
    ).into_bytes();
    for (k, v) in &meta.headers {
        out.extend_from_slice(format!("{}: {}\r\n", k, v).as_bytes());
    }
    out.extend_from_slice(b"\r\n");
    out
}

/// Build a complete single-chunk HTTP/1.1 response with Content-Length.
/// Bytes-identical to today's renderToString wire shape for no-Suspense
/// routes (spec S1 criterion #1).
pub fn build_single_response_bytes(meta: &ChunkMeta, body: &[u8]) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\n",
        meta.status,
        status_reason(meta.status),
        meta.content_type,
        body.len(),
    ).into_bytes();
    for (k, v) in &meta.headers {
        out.extend_from_slice(format!("{}: {}\r\n", k, v).as_bytes());
    }
    out.extend_from_slice(b"\r\n");
    out.extend_from_slice(body);
    out
}

fn status_reason(code: u16) -> &'static str {
    match code {
        200 => "OK",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "OK",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_meta_round_trip() {
        let meta_json = br#"{"status":200,"streaming":true}"#;
        let body = b"<html>";
        let mut buf = (meta_json.len() as u16).to_be_bytes().to_vec();
        buf.extend_from_slice(meta_json);
        buf.extend_from_slice(body);
        let (m, b) = split_meta(&buf).unwrap();
        assert_eq!(m, meta_json);
        assert_eq!(b, body);
    }

    #[test]
    fn split_meta_rejects_oversize_meta_len() {
        let buf = vec![0xff, 0xff, b'x'];        // meta_len=65535, body=1 byte
        assert!(split_meta(&buf).is_err());
    }

    #[test]
    fn split_meta_rejects_too_short() {
        assert!(split_meta(&[]).is_err());
        assert!(split_meta(&[0]).is_err());
    }

    #[test]
    fn meta_parse_with_streaming_true() {
        let raw = br#"{"status":200,"contentType":"text/html; charset=utf-8","headers":{},"streaming":true}"#;
        let m: ChunkMeta = serde_json::from_slice(raw).unwrap();
        assert_eq!(m.status, 200);
        assert!(m.streaming);
    }

    #[test]
    fn meta_parse_with_streaming_false() {
        let raw = br#"{"status":200,"contentType":"text/html; charset=utf-8","headers":{},"streaming":false}"#;
        let m: ChunkMeta = serde_json::from_slice(raw).unwrap();
        assert!(!m.streaming);
    }

    #[test]
    fn chunked_hex_prefix_format_small() {
        let out = format_chunk_framed(b"hello");
        assert_eq!(out, b"5\r\nhello\r\n");
    }

    #[test]
    fn chunked_hex_prefix_format_large() {
        let body = vec![b'a'; 0x1000];           // 4096 bytes
        let out = format_chunk_framed(&body);
        assert!(out.starts_with(b"1000\r\n"));
        assert!(out.ends_with(b"\r\n"));
        assert_eq!(out.len(), 6 + 4096 + 2);    // "1000\r\n" + body + "\r\n"
    }

    #[test]
    fn chunked_hex_prefix_format_at_sab_boundary() {
        let body = vec![b'b'; 256 * 1024];       // SAB capacity
        let out = format_chunk_framed(&body);
        assert!(out.starts_with(b"40000\r\n"));  // 256 KB = 0x40000
    }

    #[test]
    fn chunked_terminator_format() {
        assert_eq!(format_chunk_framed(b""), b"0\r\n\r\n");
    }

    #[test]
    fn single_chunk_buffer_to_content_length() {
        let meta = ChunkMeta {
            status: 200,
            content_type: "text/html; charset=utf-8".to_string(),
            headers: Default::default(),
            streaming: false,
        };
        let body = b"<html>x</html>";
        let resp = build_single_response_bytes(&meta, body);
        let s = std::str::from_utf8(&resp).unwrap();
        assert!(s.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(s.contains("Content-Length: 14\r\n"));
        assert!(s.contains("Content-Type: text/html; charset=utf-8\r\n"));
        assert!(s.ends_with("<html>x</html>"));
    }

    #[test]
    fn chunked_response_head_format() {
        let meta = ChunkMeta {
            status: 200,
            content_type: "text/html; charset=utf-8".to_string(),
            headers: [("X-Render-Ms".to_string(), "12".to_string())].into(),
            streaming: true,
        };
        let head = build_chunked_response_head(&meta);
        let s = std::str::from_utf8(&head).unwrap();
        assert!(s.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(s.contains("Transfer-Encoding: chunked\r\n"));
        assert!(s.contains("X-Render-Ms: 12\r\n"));
        assert!(s.ends_with("\r\n\r\n"));
    }
}
```

- [ ] **Step 2: Wire the module into `src/lib.rs`**

Find the existing `pub mod` declarations near the top of `src/lib.rs` (search for `pub mod pool;` — it's around line 7-15 depending on order). Add this line alongside them:

```rust
pub mod render_stream;
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cargo test --lib render_stream:: 2>&1 | tail -15`
Expected: `test result: ok. 9 passed`.

- [ ] **Step 4: Verify full build + no regression**

Run: `cargo test --lib 2>&1 | tail -3`
Expected: `test result: ok. 85 passed` (76 from Task 1 + 9 new).

- [ ] **Step 5: Commit**

```bash
git add src/render_stream.rs src/lib.rs
git commit -m "$(cat <<'EOF'
feat(render_stream): chunked encoding helpers + ChunkMeta parser

Pure functions for the HTTP/1.1 chunked path + the meta layout
`[meta_len: u16 BE][meta JSON UTF-8][body]` that workers will use to
prefix the first chunk. Single-chunk path goes through
`build_single_response_bytes` which produces bytes-identical output to
today's renderToString wire shape (spec S1 criterion #1).

No callers yet — wired in later when handle_conn switches to the new
dispatch helper (Task 5).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2: NAPI side channel

### Task 3: `napi_render_chunk` NAPI function in `src/lib.rs`

The function reads SAB[0..len] for `len > 0`, sends `RenderChunk::Bytes` through the worker's `render_slot`, awaits ack. For `len == 0` it sends `RenderChunk::Final`. Returns NAPI Err on bounds violation OR ack drop (NOT hang — spec S5.2 contract).

**Files:**
- Modify: `src/lib.rs`
- Test: `src/render_stream.rs::tests` (one bounds-check test that calls the NAPI fn's pure-logic helper)

- [ ] **Step 1: Add a bounds-check helper test in `src/render_stream.rs::tests`**

The NAPI fn itself is hard to unit-test directly (needs a worker registered), but we can factor out the bounds check + slot lookup logic into a helper that IS testable. Add to `src/render_stream.rs` (outside the `tests` module):

```rust
/// Bounds check + slot lookup for napi_render_chunk. Returns the cloned
/// chunk_tx if the slot is set and `len <= buf_len`. Factored out for
/// unit testing — the NAPI fn itself wraps this in await + send.
pub fn check_chunk_dispatch(
    render_slot: &parking_lot::Mutex<Option<crate::pool::RenderSlot>>,
    len: u32,
    buf_len: usize,
) -> Result<tokio::sync::mpsc::Sender<crate::pool::RenderChunk>, String> {
    if (len as usize) > buf_len {
        return Err(format!("chunk len {} exceeds SAB capacity {}", len, buf_len));
    }
    let slot = render_slot.lock();
    slot.as_ref()
        .map(|s| s.chunk_tx.clone())
        .ok_or_else(|| "no in-flight render for this worker".to_string())
}
```

Add to the `#[cfg(test)] mod tests` block:

```rust
    #[test]
    fn len_bounds_check_rejects_oversize() {
        let slot = parking_lot::Mutex::new(None);
        let err = check_chunk_dispatch(&slot, 1_000_000, 256 * 1024).unwrap_err();
        assert!(err.contains("exceeds SAB capacity"));
    }

    #[test]
    fn slot_missing_returns_err() {
        let slot = parking_lot::Mutex::new(None);
        let err = check_chunk_dispatch(&slot, 5, 256 * 1024).unwrap_err();
        assert!(err.contains("no in-flight render"));
    }

    #[test]
    fn slot_present_returns_sender() {
        let (tx, _rx) = tokio::sync::mpsc::channel::<crate::pool::RenderChunk>(1);
        let slot = parking_lot::Mutex::new(Some(crate::pool::RenderSlot { chunk_tx: tx }));
        assert!(check_chunk_dispatch(&slot, 5, 256 * 1024).is_ok());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib render_stream:: 2>&1 | tail -10`
Expected: FAIL with `cannot find function 'check_chunk_dispatch' in this scope` (the 3 new tests aren't compiled yet because the helper doesn't exist — they should fail to compile until we add the helper).

Actually, since we already added the helper in Step 1, this should compile. Expected: tests pass directly. Re-running gives:

Run: `cargo test --lib render_stream:: 2>&1 | tail -10`
Expected: `test result: ok. 12 passed` (9 from Task 2 + 3 new).

- [ ] **Step 3: Add `napi_render_chunk` to `src/lib.rs`**

Find a spot near the other `#[napi]` functions for WS/SSE (e.g., right after `napi_register_ws_paths` — search for `pub fn napi_register_ws_paths`). Add:

```rust
/// Worker-driven render chunk delivery. Worker calls this once per chunk
/// it wants to emit; final call uses `len = 0` to close the channel.
///
/// Contract (spec S5.2):
/// - `len > 0`: read SAB[0..len], send Bytes through render_slot.chunk_tx,
///   await ack. Resolves after Rust writes the chunk to the socket.
/// - `len == 0`: send Final, await ack. Closes the response.
/// - Bounds violation (len > buf_len) → NAPI Err.
/// - Slot empty (no in-flight render for this worker) → NAPI Err.
/// - Ack receiver dropped (handle_conn torn down mid-stream) → NAPI Err
///   (NOT hang — worker's sink propagates via cb(err) to renderer Promise).
#[napi]
pub async fn napi_render_chunk(worker_id: u32, len: u32) -> NapiResult<()> {
    let entry = state().pool.entry(worker_id)
        .ok_or_else(|| napi::Error::from_reason(format!("worker {} not registered", worker_id)))?;
    let chunk_tx = crate::render_stream::check_chunk_dispatch(
        &entry.render_slot, len, entry.buf_len,
    ).map_err(napi::Error::from_reason)?;

    let (ack_tx, ack_rx) = tokio::sync::oneshot::channel::<()>();
    let chunk = if len == 0 {
        crate::pool::RenderChunk::Final { ack: ack_tx }
    } else {
        // SAFETY: BufPtr is the SAB backing-store pointer pinned at register
        // time (see pool.rs::BufPtr docstring). `len` is bounds-checked above.
        let data = unsafe {
            std::slice::from_raw_parts(entry.buf_ptr.0, len as usize)
        }.to_vec();
        crate::pool::RenderChunk::Bytes { data, ack: ack_tx }
    };
    chunk_tx.send(chunk).await.map_err(|_|
        napi::Error::from_reason("render chunk channel closed (handle_conn gone)")
    )?;
    ack_rx.await.map_err(|_|
        napi::Error::from_reason("ack dropped — handle_conn torn down mid-chunk")
    )?;
    Ok(())
}
```

- [ ] **Step 4: Add `WorkerPool::entry` accessor** (if not already present)

The NAPI fn calls `state().pool.entry(worker_id)`. Check `src/pool.rs` for this method — likely doesn't exist yet. Add to `impl WorkerPool` (after `pub fn pick_least_busy`):

```rust
pub fn entry(&self, id: u32) -> Option<Arc<TsfnEntry>> {
    self.entries.read().iter().find(|e| e.id == id).cloned()
}
```

- [ ] **Step 5: Run all tests to verify the new NAPI fn compiles + nothing regresses**

Run: `cargo test --lib 2>&1 | tail -3`
Expected: `test result: ok. 88 passed` (85 from Task 2 + 3 new).

- [ ] **Step 6: Verify a release-build cycle works (sanity for napi-rs codegen)**

Run: `cd runtime && bun run build:debug 2>&1 | tail -3`
Expected: `Finished \`dev\` profile [unoptimized + debuginfo] target(s)` with no errors. The new `napi_render_chunk` symbol now appears in `runtime/index.d.ts` (auto-generated).

- [ ] **Step 7: Commit**

```bash
git add src/lib.rs src/render_stream.rs src/pool.rs runtime/index.d.ts runtime/index.js
git commit -m "$(cat <<'EOF'
feat(napi): napi_render_chunk + check_chunk_dispatch helper

NAPI fn that workers call per chunk during streaming render. len=0 signals
final; len>0 reads SAB[0..len] and ships to handle_conn's chunk loop
through the worker's render_slot. Bounds violations + ack drops surface as
NAPI Err — the worker's sink propagates via cb(err), preventing hangs
(spec S5.2 contract, B6 in agent review).

No callers yet — JS-side renderer wraps this in Task 4, contract switch
in Task 5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3: JS-side streaming module

### Task 4: `runtime/render/stream.ts` with `renderBranchStreaming` + tests

The buffering Writable sink + the renderToPipeableStream wrapper. Self-contained — Task 5 wires it into `makeRenderer`.

**Files:**
- Create: `runtime/render/stream.ts`
- Test: `runtime/render/stream.test.ts`

- [ ] **Step 1: Create the test file with all 6 runtime unit tests**

Create `runtime/render/stream.test.ts`:

```typescript
import { test, expect, mock } from 'bun:test'
import { createElement, Suspense } from 'react'
import { renderBranchStreaming, makeMeta } from './stream'

// Lightweight mock NAPI: captures every napi.renderChunk call so we can
// assert the chunk sequence + the meta in the first chunk's prefix.
function makeMockNapi() {
  const chunks: Array<{ len: number, bytes: Uint8Array | null }> = []
  return {
    chunks,
    napi: {
      async renderChunk(_workerId: bigint, len: number, sabBytes: Uint8Array) {
        // Real napi reads from the SAB; in tests we accept the bytes
        // explicitly so the renderer can pass them in.
        chunks.push({ len, bytes: len === 0 ? null : sabBytes.slice(0, len) })
      },
    },
  }
}

function decodeMeta(firstChunk: Uint8Array): { metaJson: string, body: Uint8Array } {
  const metaLen = (firstChunk[0] << 8) | firstChunk[1]
  const metaJson = new TextDecoder().decode(firstChunk.subarray(2, 2 + metaLen))
  const body = firstChunk.subarray(2 + metaLen)
  return { metaJson, body }
}

const view = new Uint8Array(new ArrayBuffer(256 * 1024))

test('streaming=false when no Suspense; single chunk + final; islands flag NOT set → no bootstrap', async () => {
  const { chunks, napi } = makeMockNapi()
  await renderBranchStreaming({
    element: createElement('div', null, 'hello'),
    view, workerId: 0n, napi,
    errorBoundary: () => createElement('div', null, 'oops'),
  })
  // chunks: [first chunk (meta + body), final(0)]
  expect(chunks.length).toBe(2)
  expect(chunks[1].len).toBe(0)
  const { metaJson, body } = decodeMeta(chunks[0].bytes!)
  expect(JSON.parse(metaJson).streaming).toBe(false)
  const bodyStr = new TextDecoder().decode(body)
  expect(bodyStr).toContain('hello')
  expect(bodyStr).not.toContain('importmap')   // no islands → no bootstrap
})

test('streaming=true when Suspense is pending; bootstrap ALWAYS injected in streaming mode', async () => {
  const { chunks, napi } = makeMockNapi()
  // A child that throws a Promise → React suspends.
  let resolve: () => void = () => {}
  const pending = new Promise<void>((r) => { resolve = r })
  function Slow() {
    if (pending) throw pending
    return createElement('span', null, 'late')
  }
  const elem = createElement(Suspense,
    { fallback: createElement('span', null, 'loading') },
    createElement(Slow),
  )
  // Run renderBranchStreaming + resolve the suspense after 50ms.
  const renderPromise = renderBranchStreaming({
    element: elem, view, workerId: 0n, napi,
    errorBoundary: () => createElement('div', null, 'oops'),
  })
  setTimeout(() => resolve(), 50)
  await renderPromise
  expect(chunks.length).toBeGreaterThanOrEqual(2)
  expect(chunks[chunks.length - 1].len).toBe(0)
  const { metaJson, body } = decodeMeta(chunks[0].bytes!)
  expect(JSON.parse(metaJson).streaming).toBe(true)
  expect(new TextDecoder().decode(body)).toContain('importmap')  // bootstrap always-injected
})

test('pre-shell crash emits 500 + errorBoundary HTML, streaming=false, renderChunk(0) fires', async () => {
  const { chunks, napi } = makeMockNapi()
  function Crash(): never { throw new Error('boom') }
  await renderBranchStreaming({
    element: createElement(Crash),
    view, workerId: 0n, napi,
    errorBoundary: ({ error }: { error: Error }) =>
      createElement('div', null, 'caught: ' + error.message),
  })
  expect(chunks.length).toBe(2)
  expect(chunks[1].len).toBe(0)
  const { metaJson, body } = decodeMeta(chunks[0].bytes!)
  const parsed = JSON.parse(metaJson)
  expect(parsed.status).toBe(500)
  expect(parsed.streaming).toBe(false)
  expect(new TextDecoder().decode(body)).toContain('caught: boom')
})

test('post-shell crash: onError logged; renderChunk(0) still fires; no hang', async () => {
  const consoleSpy = mock(() => {})
  const origErr = console.error
  console.error = consoleSpy
  const { chunks, napi } = makeMockNapi()
  // Suspense child that resolves but then renders something that throws synchronously
  // — React's Suspense errorBoundary will handle in the SSR boundary if provided.
  function Bad() { throw new Error('post-shell-boom') }
  const elem = createElement(Suspense,
    { fallback: createElement('span', null, 'loading') },
    createElement(Bad),
  )
  await renderBranchStreaming({
    element: elem, view, workerId: 0n, napi,
    errorBoundary: () => createElement('div', null, 'caught'),
  })
  console.error = origErr
  expect(chunks[chunks.length - 1].len).toBe(0)  // FINAL fired despite post-shell error
  expect(consoleSpy.mock.calls.length).toBeGreaterThan(0)
})

test('errorBoundary that itself throws inside onShellError emits plain-text fallback', async () => {
  const { chunks, napi } = makeMockNapi()
  function Crash(): never { throw new Error('boom') }
  function BadBoundary(): never { throw new Error('boundary-also-broken') }
  await renderBranchStreaming({
    element: createElement(Crash),
    view, workerId: 0n, napi,
    errorBoundary: BadBoundary,
  })
  expect(chunks.length).toBe(2)
  expect(chunks[1].len).toBe(0)
  const { metaJson, body } = decodeMeta(chunks[0].bytes!)
  const parsed = JSON.parse(metaJson)
  expect(parsed.status).toBe(500)
  expect(parsed.contentType).toContain('text/plain')
  expect(new TextDecoder().decode(body)).toBe('Internal Server Error')
})

test('makeMeta defaults: contentType=text/html, headers={}, given status+streaming', () => {
  const json = makeMeta({ status: 200, streaming: true })
  const parsed = JSON.parse(json)
  expect(parsed.status).toBe(200)
  expect(parsed.streaming).toBe(true)
  expect(parsed.contentType).toBe('text/html; charset=utf-8')
  expect(parsed.headers).toEqual({})
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd runtime && bun test render/stream.test.ts 2>&1 | tail -5`
Expected: FAIL with `Cannot find module './stream'`.

- [ ] **Step 3: Create `runtime/render/stream.ts` with the full implementation**

Create `runtime/render/stream.ts`:

```typescript
import { renderToPipeableStream, renderToString } from 'react-dom/server'
import { createElement, type ReactNode, type ComponentType } from 'react'
import { Writable } from 'node:stream'
import { consumeIslandUsedFlag } from '../islands/island'
import { ISLANDS_IMPORTMAP_AND_BOOTSTRAP } from '../islands/bootstrap'

export interface RenderBranchStreamingArgs {
  element: ReactNode
  view: Uint8Array
  workerId: bigint
  napi: {
    renderChunk: (workerId: bigint, len: number, sabBytes: Uint8Array) => Promise<void>
  }
  errorBoundary: ComponentType<{ error: Error }>
}

const encoder = new TextEncoder()

/** JSON.stringify the per-chunk meta. Defaults match the renderToString
 * path so single-chunk responses keep their existing wire shape. */
export function makeMeta(opts: {
  status: number
  streaming: boolean
  contentType?: string
  headers?: Record<string, string>
}): string {
  return JSON.stringify({
    status: opts.status,
    contentType: opts.contentType ?? 'text/html; charset=utf-8',
    headers: opts.headers ?? {},
    streaming: opts.streaming,
  })
}

/** Encode `[meta_len: u16 BE][meta][body]` into the SAB starting at offset 0;
 * return the total byte length written. Throws if it would exceed buf capacity. */
function encodeFirstChunk(view: Uint8Array, meta: string, body: Uint8Array): number {
  const metaBytes = encoder.encode(meta)
  const total = 2 + metaBytes.length + body.length
  if (total > view.length) {
    throw new Error(`first chunk ${total}b exceeds SAB ${view.length}b`)
  }
  view[0] = (metaBytes.length >> 8) & 0xff
  view[1] = metaBytes.length & 0xff
  view.set(metaBytes, 2)
  view.set(body, 2 + metaBytes.length)
  return total
}

/** Encode body-only bytes into the SAB at offset 0; return length. */
function encodeBodyChunk(view: Uint8Array, body: Uint8Array): number {
  if (body.length > view.length) {
    throw new Error(`body chunk ${body.length}b exceeds SAB ${view.length}b`)
  }
  view.set(body, 0)
  return body.length
}

/** Concatenate buffers, optionally prepending the islands bootstrap. */
function concatBuffers(parts: Uint8Array[], withBootstrap: boolean): Uint8Array {
  const bootstrap = withBootstrap ? encoder.encode(ISLANDS_IMPORTMAP_AND_BOOTSTRAP) : null
  const totalLen = (bootstrap?.length ?? 0) + parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(totalLen)
  let off = 0
  if (bootstrap) { out.set(bootstrap, off); off += bootstrap.length }
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

export function renderBranchStreaming(args: RenderBranchStreamingArgs): Promise<void> {
  const { element, view, workerId, napi, errorBoundary } = args

  return new Promise<void>((resolve, reject) => {
    // Single guaranteed-fire path for the Final signal (spec S6, B6 fix).
    let finalSent = false
    const sendFinal = async () => {
      if (finalSent) return
      finalSent = true
      try { await napi.renderChunk(workerId, 0, view); resolve() }
      catch (e) { reject(e) }
    }

    let mode: 'buffering' | 'streaming' | 'done' = 'buffering'
    const buffer: Uint8Array[] = []

    const sink = new Writable({
      async write(chunk: Uint8Array, _enc: string, cb: (e?: Error | null) => void) {
        try {
          if (mode === 'buffering') {
            buffer.push(new Uint8Array(chunk))
            cb(); return
          }
          if (mode === 'streaming') {
            const len = encodeBodyChunk(view, chunk)
            await napi.renderChunk(workerId, len, view)
          }
          cb()
        } catch (e) {
          cb(e as Error)        // C8: propagate via cb(err), NOT cb()
        }
      },
      async final(cb: (e?: Error | null) => void) {
        try {
          if (mode === 'buffering') {
            // No Suspense path: assemble single chunk, check islands flag, emit.
            const islandsUsed = consumeIslandUsedFlag()
            const body = concatBuffers(buffer, islandsUsed)
            const meta = makeMeta({ status: 200, streaming: false })
            const len = encodeFirstChunk(view, meta, body)
            await napi.renderChunk(workerId, len, view)
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
    sink.on('error', reject)

    let stream: ReturnType<typeof renderToPipeableStream>
    try {
      stream = renderToPipeableStream(element, {
        onShellReady() {
          // B4: explicit typeof check; default to streaming:true if absent.
          const pending = (stream as unknown as { pendingSuspenseBoundaries?: number })
            .pendingSuspenseBoundaries
          const hasPending = typeof pending === 'number' ? pending > 0 : true

          if (!hasPending) {
            // Stay in 'buffering' — _final triggers the single-chunk emit.
            stream.pipe(sink)
            return
          }

          // Streaming path: emit shell now, always include bootstrap (B3).
          mode = 'streaming'
          const flushed = concatBuffers(buffer, /* withBootstrap */ true)
          buffer.length = 0
          const meta = makeMeta({ status: 200, streaming: true })
          ;(async () => {
            try {
              const len = encodeFirstChunk(view, meta, flushed)
              await napi.renderChunk(workerId, len, view)
              stream.pipe(sink)
            } catch (e) { reject(e) }
          })()
        },
        onShellError(err) {
          // B6: inner try/catch — if errorBoundary itself throws, emit plain-text.
          try {
            const html = renderToString(createElement(errorBoundary, { error: err as Error }))
            const meta = makeMeta({ status: 500, streaming: false })
            mode = 'done'
            ;(async () => {
              try {
                const len = encodeFirstChunk(view, meta, encoder.encode(html))
                await napi.renderChunk(workerId, len, view)
                await sendFinal()
              } catch (e) { reject(e) }
            })()
          } catch (e2) {
            console.error('[brust] errorBoundary threw during shell error:', e2)
            const meta = makeMeta({
              status: 500, streaming: false, contentType: 'text/plain; charset=utf-8',
            })
            mode = 'done'
            ;(async () => {
              try {
                const len = encodeFirstChunk(view, meta, encoder.encode('Internal Server Error'))
                await napi.renderChunk(workerId, len, view)
                await sendFinal()
              } catch (e) { reject(e) }
            })()
          }
        },
        onError(err) {
          // B6: post-shell crash — log only. Sink's _final still fires renderChunk(0).
          // Do NOT manually invoke sendFinal here (would double-fire and hang on the
          // second ack await).
          console.error('[brust] render onError (post-shell):', err)
        },
      })
    } catch (e) {
      // renderToPipeableStream itself threw — synthesise 500 plain-text + final.
      const meta = makeMeta({
        status: 500, streaming: false, contentType: 'text/plain; charset=utf-8',
      })
      ;(async () => {
        try {
          const len = encodeFirstChunk(view, meta, encoder.encode('Internal Server Error'))
          await napi.renderChunk(workerId, len, view)
          await sendFinal()
        } catch (ee) { reject(ee) }
      })()
    }
  })
}
```

- [ ] **Step 4: Extract the islands bootstrap constant into its own module**

The existing `wrapWithIslandsBootstrap` in `runtime/routes.ts` has a string constant `ISLANDS_IMPORTMAP_AND_BOOTSTRAP` (search for it). It needs to be importable from `runtime/render/stream.ts`. Create `runtime/islands/bootstrap.ts`:

```typescript
// Importmap + bootstrap script tags injected into HTML responses that
// use <Island>. Extracted from runtime/routes.ts so renderBranchStreaming
// can prepend it during the buffering-sink _final assembly.
export const ISLANDS_IMPORTMAP_AND_BOOTSTRAP =
  `<script type="importmap">{"imports":{"react":"/_brust/islands/_react.js","react/jsx-runtime":"/_brust/islands/_react.js","react-dom/client":"/_brust/islands/_react-dom.js"}}</script>` +
  `<script type="module" src="/_brust/islands/_bootstrap.js"></script>`
```

Then in `runtime/routes.ts`, find the existing constant definition (search `ISLANDS_IMPORTMAP_AND_BOOTSTRAP`) and replace its inline definition with an import:

At the top of the file (alongside other imports):
```typescript
import { ISLANDS_IMPORTMAP_AND_BOOTSTRAP } from './islands/bootstrap'
```

Delete the original `const ISLANDS_IMPORTMAP_AND_BOOTSTRAP = ...` line in `routes.ts`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd runtime && bun test render/stream.test.ts 2>&1 | tail -10`
Expected: `6 pass, 0 fail`.

- [ ] **Step 6: Run all runtime tests to confirm zero regression**

Run: `cd runtime && bun test 2>&1 | tail -5`
Expected: `98 pass` (92 prior + 6 new).

- [ ] **Step 7: Commit**

```bash
git add runtime/render/stream.ts runtime/render/stream.test.ts runtime/islands/bootstrap.ts runtime/routes.ts
git commit -m "$(cat <<'EOF'
feat(runtime): renderBranchStreaming + buffering sink + helpers

Self-contained module with the buffering Writable adapter that auto-
detects Suspense at onShellReady. Buffering path waits for _final to
assemble a single chunk + check the islands flag (preserves today's
conditional bootstrap injection). Streaming path commits the shell at
onShellReady and always injects the bootstrap (B3: late islands inside
pending Suspense haven't rendered yet).

All 6 spec runtime tests pass: streaming=false islands-conditional,
streaming=true bootstrap-always, pre-shell crash with errorBoundary,
post-shell crash no-hang, errorBoundary-self-throw plain-text fallback,
makeMeta defaults.

Extracted ISLANDS_IMPORTMAP_AND_BOOTSTRAP to its own module so both
the new streaming sink and the legacy renderBranch can import it.

No call site change yet — makeRenderer rewiring lands in Task 5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4: The atomic contract switch

### Task 5: Replace `RendererTsfn` + helper + branch dispatch (BIG SWITCH)

This is the only task where compilation is broken between intermediate states. All edits land in one commit. Spec S5.1 cascade table is the authoritative checklist.

**Files:**
- Modify: `src/pool.rs` (line 11 — `RendererTsfn` type)
- Modify: `src/lib.rs` (line 139-156 — `register_renderer` signature)
- Modify: `src/server.rs` (line 762 — render branch call site; line 798-910 — old helper replacement)
- Modify: `runtime/index.ts` (line 29 — `RenderFn` type)
- Modify: `runtime/routes.ts` (line 396-452 — `makeRenderer` dispatch)

- [ ] **Step 1: Change `RendererTsfn` in `src/pool.rs:11`**

Replace:
```rust
pub type RendererTsfn = ThreadsafeFunction<String, Promise<u32>, String, napi::Status, false>;
```

With:
```rust
pub type RendererTsfn = ThreadsafeFunction<String, Promise<()>, String, napi::Status, false>;
```

- [ ] **Step 2: Change `register_renderer` signature in `src/lib.rs:139-156`**

Replace the function signature:
```rust
pub fn register_renderer(
    mut buf: Uint8Array,
    f: Function<String, Promise<u32>>,
) -> NapiResult<u32> {
```

With:
```rust
pub fn register_renderer(
    mut buf: Uint8Array,
    f: Function<String, Promise<()>>,
) -> NapiResult<u32> {
```

The function body is unchanged.

- [ ] **Step 3: Replace `dispatch_to_worker_and_send_meta_response` in `src/server.rs`**

Find the existing function (around `src/server.rs:798-910`). Replace the ENTIRE function with:

```rust
/// Shared dispatch for both the action and render branches: pick a worker,
/// install a RenderSlot, kick off the tsfn (Promise<()>) WITHOUT awaiting,
/// loop the chunk channel writing to the socket as chunks arrive. Cache
/// inserts only on the single-chunk (streaming:false) path.
async fn dispatch_to_worker_and_stream_chunks<F>(
    s: &mut TcpStream,
    pool: &Arc<crate::pool::WorkerPool>,
    envelope_json: String,
    label: &'static str,
    on_success: F,
) -> DispatchControl
where
    F: FnOnce(&[u8]),
{
    let Some(entry) = pool.pick_least_busy() else {
        let _ = s.write_all(http::error_503("no workers")).await;
        return DispatchControl::CloseConn;
    };
    let _busy_guard = entry.in_flight_guard();

    let (chunk_tx, mut chunk_rx) = tokio::sync::mpsc::channel::<crate::pool::RenderChunk>(1);
    {
        let mut slot = entry.render_slot.lock();
        debug_assert!(slot.is_none(), "worker {} double-dispatch (JS thread should serialise)", entry.id);
        *slot = Some(crate::pool::RenderSlot { chunk_tx });
    }
    let _slot_guard = crate::pool::RenderSlotGuard { entry: &entry };

    let render_future = entry.tsfn.call_async(envelope_json);
    tokio::pin!(render_future);

    let mut headers_written = false;
    let mut chunked = false;
    let mut buffered_meta: Option<crate::render_stream::ChunkMeta> = None;
    let mut buffered_body: Vec<u8> = Vec::new();
    let mut response_bytes_for_cache: Vec<u8> = Vec::new();

    loop {
        tokio::select! {
            biased;
            Some(chunk) = chunk_rx.recv() => {
                match chunk {
                    crate::pool::RenderChunk::Bytes { data, ack } => {
                        if !headers_written {
                            let (meta_slice, body) = match crate::render_stream::split_meta(&data) {
                                Ok(x) => x,
                                Err(e) => {
                                    error!(worker_id = entry.id, label, error = e, "split_meta failed");
                                    let _ = s.write_all(http::error_500()).await;
                                    let _ = ack.send(());
                                    return DispatchControl::CloseConn;
                                }
                            };
                            let parsed: crate::render_stream::ChunkMeta = match serde_json::from_slice(meta_slice) {
                                Ok(m) => m,
                                Err(e) => {
                                    error!(worker_id = entry.id, label, error = %e, "meta JSON parse failed");
                                    let _ = s.write_all(http::error_500()).await;
                                    let _ = ack.send(());
                                    return DispatchControl::CloseConn;
                                }
                            };
                            chunked = parsed.streaming;
                            if chunked {
                                let head = crate::render_stream::build_chunked_response_head(&parsed);
                                if s.write_all(head).await.is_err() { let _ = ack.send(()); return DispatchControl::CloseConn; }
                                let framed = crate::render_stream::format_chunk_framed(body);
                                if s.write_all(framed).await.is_err() { let _ = ack.send(()); return DispatchControl::CloseConn; }
                            } else {
                                buffered_meta = Some(parsed);
                                buffered_body.extend_from_slice(body);
                            }
                            headers_written = true;
                        } else if chunked {
                            let framed = crate::render_stream::format_chunk_framed(&data);
                            if s.write_all(framed).await.is_err() { let _ = ack.send(()); return DispatchControl::CloseConn; }
                        } else {
                            warn!(worker_id = entry.id, label,
                                  "non-streaming worker emitted extra chunk; appending");
                            buffered_body.extend_from_slice(&data);
                        }
                        let _ = ack.send(());
                    }
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
                }
            }
            result = &mut render_future => {
                match result {
                    Ok(_promise_result) => {
                        let dropped = chunk_rx.len();
                        warn!(worker_id = entry.id, label, dropped,
                              "worker returned without Final signal");
                        if chunked {
                            // C5: emit terminator so browser doesn't see ERR_INCOMPLETE_CHUNKED_ENCODING.
                            let _ = s.write_all(crate::render_stream::format_chunk_framed(b"")).await;
                        } else if let Some(meta) = buffered_meta.take() {
                            let resp = crate::render_stream::build_single_response_bytes(&meta, &buffered_body);
                            response_bytes_for_cache = resp.clone();
                            let _ = s.write_all(resp).await;
                        }
                        break;
                    }
                    Err(e) => {
                        error!(worker_id = entry.id, label, error = %e, "render tsfn rejected");
                        if !headers_written {
                            let _ = s.write_all(http::error_500()).await;
                        }
                        break;
                    }
                }
            }
        }
    }

    if !response_bytes_for_cache.is_empty() {
        on_success(&response_bytes_for_cache);
    }
    DispatchControl::Continue
}
```

- [ ] **Step 4: Update the render branch call site in `src/server.rs`**

Find the call site (around line 762):
```rust
match dispatch_to_worker_and_send_meta_response(
    &mut s,
    &pool,
    envelope_json,
    "render",
    "text/html; charset=utf-8",
    false,
    move |bytes| { ... },
)
```

Replace with:
```rust
match dispatch_to_worker_and_stream_chunks(
    &mut s,
    &pool,
    envelope_json,
    "render",
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
```

(The `default_content_type` and `prefer_meta_content_type` params no longer exist — the meta JSON now carries everything per S4.)

- [ ] **Step 5: Update the action branch call site in `src/server.rs`**

Search for the OTHER call to `dispatch_to_worker_and_send_meta_response` (action branch — likely around the `/_brust/action/` handler in `handle_conn`, probably around line 290-330 based on earlier exploration). Replace with `dispatch_to_worker_and_stream_chunks(...)` using the same arg shape (label = `"action"`, no-op `on_success` closure — actions aren't cached).

- [ ] **Step 6: Update `RenderFn` type in `runtime/index.ts:29`**

Replace:
```typescript
export type RenderFn = (envelopeJson: string) => Promise<number>
```

With:
```typescript
export type RenderFn = (envelopeJson: string) => Promise<void>
```

- [ ] **Step 7: Update `makeRenderer` in `runtime/routes.ts`**

Find `makeRenderer` (around line 396-452). The return type changes from `Promise<number>` to `Promise<void>`, and every branch is rewired through the new chunk channel.

Replace the entire function body with:

```typescript
export function makeRenderer(
  routes: FlatRoute[],
  view: Uint8Array,
  opts: MakeRendererOptions = {},
): (envelopeJson: string) => Promise<void> {
  const encoder = new TextEncoder()
  const byRouteId = new Map<number, FlatRoute>()
  routes.forEach((r, i) => byRouteId.set(i, r))
  const byActionId = new Map<string, ActionDef>()
  for (const a of opts.actions ?? []) byActionId.set(a.id, a)

  // napi shim for the new chunk channel. workerId comes from getWorkerId().
  const napi = {
    renderChunk: async (workerId: bigint, len: number, _view: Uint8Array): Promise<void> => {
      await (native as any).napiRenderChunk(Number(workerId), len)
    },
  }

  return async (envelopeJson: string): Promise<void> => {
    const call = JSON.parse(envelopeJson) as RouteCall
    const wid = opts.getWorkerId?.() ?? 0
    const workerId = BigInt(wid)

    if (call.kind === 'render') {
      const flat = byRouteId.get(call.route_id)
      if (!flat) {
        await emitSingleChunkResponse(view, napi, workerId, encoder, {
          status: 404, contentType: 'text/plain', body: 'not found',
        })
        return
      }
      const element = await buildRenderElement(call, flat, opts.getWorkerId)
        .catch(() => null)
      if (!element) {
        await emitSingleChunkResponse(view, napi, workerId, encoder, {
          status: 500, contentType: 'text/plain', body: 'render setup failed',
        })
        return
      }
      const errorBoundary = flat.errorBoundary ??
        (() => createElement('div', null, 'Internal Server Error'))
      await renderBranchStreaming({ element, view, workerId, napi, errorBoundary })
      return
    }
    if (call.kind === 'action') {
      const resp = await actionBranchToResponse(call, byActionId)
      await emitSingleChunkResponse(view, napi, workerId, encoder, resp)
      return
    }
    if (call.kind === 'mcp') {
      const resp = await mcpBranchToResponse(call, opts.mcp)
      await emitSingleChunkResponse(view, napi, workerId, encoder, resp)
      return
    }
    if (call.kind === 'sse') {
      try { await sseBranch(call, view, encoder, routes) }
      catch (err) {
        console.error('[brust] sseBranch uncaught:', err)
        await emitSingleChunkResponse(view, napi, workerId, encoder, {
          status: 500, contentType: 'text/plain', body: '',
        })
      }
      return
    }
    if (call.kind === 'ws') {
      try { await wsBranch(call, view, encoder, routes) }
      catch (err) {
        console.error('[brust] wsBranch uncaught:', err)
        await emitSingleChunkResponse(view, napi, workerId, encoder, {
          status: 500, contentType: 'text/plain', body: '',
        })
      }
      return
    }
    console.error('[brust] unknown envelope kind in worker:', (call as { kind?: string }).kind)
    await emitSingleChunkResponse(view, napi, workerId, encoder, {
      status: 500, contentType: 'text/plain; charset=utf-8', body: 'invalid envelope kind',
    })
  }
}

/** Emit a single-chunk response through the chunk channel — wire shape
 * matches what dispatch_to_worker_and_stream_chunks expects (one Bytes
 * with `[meta_len][meta][body]`, then Final). */
async function emitSingleChunkResponse(
  view: Uint8Array, napi: { renderChunk: (w: bigint, len: number, view: Uint8Array) => Promise<void> },
  workerId: bigint, encoder: TextEncoder,
  resp: { status: number, contentType: string, body: string | Uint8Array, headers?: Record<string, string> },
): Promise<void> {
  const bodyBytes = typeof resp.body === 'string' ? encoder.encode(resp.body) : resp.body
  const meta = JSON.stringify({
    status: resp.status,
    contentType: resp.contentType,
    headers: resp.headers ?? {},
    streaming: false,
  })
  const metaBytes = encoder.encode(meta)
  const total = 2 + metaBytes.length + bodyBytes.length
  view[0] = (metaBytes.length >> 8) & 0xff
  view[1] = metaBytes.length & 0xff
  view.set(metaBytes, 2)
  view.set(bodyBytes, 2 + metaBytes.length)
  await napi.renderChunk(workerId, total, view)
  await napi.renderChunk(workerId, 0, view)
}
```

You will also need to extract two helper functions:
- `buildRenderElement(call, flat, getWorkerId)` — pulls the loader/middleware/element-build logic out of the existing `renderBranch`. The existing `renderBranch` function in `runtime/routes.ts` already has this logic inline; extract lines that build the React element + run loaders into a separate async function that returns the element. Keep `consumeIslandUsedFlag()` calls OUT of this helper — the streaming sink handles them at `_final` time.
- `actionBranchToResponse(call, byActionId)` and `mcpBranchToResponse(call, mcp)` — refactor the existing `actionBranch` and `mcpBranch` to return `{ status, contentType, body, headers }` instead of calling `packResponse` directly. The `packResponse` SAB-write step moves to `emitSingleChunkResponse`.

Add the import at the top of `runtime/routes.ts`:
```typescript
import { renderBranchStreaming } from './render/stream'
```

- [ ] **Step 8: Update `runtime/routes.ts` `renderBranch`, `actionBranch`, `mcpBranch` return types**

Each of these existing functions currently returns `Promise<number>` (SAB length). Refactor:
- `renderBranch` → **delete entirely** (replaced by `renderBranchStreaming` in `makeRenderer`)
- `actionBranch` → rename to `actionBranchToResponse`, return `Promise<{status, contentType, body, headers?}>`
- `mcpBranch` → rename to `mcpBranchToResponse`, same shape

Their inner logic (route matching, middleware chain, body computation) is unchanged — only the final `packResponse(view, encoder, {...})` call is removed; instead, return the response object.

The `packResponse` function in `runtime/routes.ts` can also be removed (no callers left).

- [ ] **Step 9: Run cargo build to verify Rust side compiles**

Run: `cargo build --lib 2>&1 | tail -10`
Expected: builds with warnings only (no errors).

- [ ] **Step 10: Rebuild the native module**

Run: `cd runtime && bun run build:debug 2>&1 | tail -3`
Expected: `Finished \`dev\` profile [unoptimized + debuginfo] target(s)`.

- [ ] **Step 11: Run Rust tests + runtime tests + integration tests**

Run: `cargo test --lib 2>&1 | tail -3`
Expected: `test result: ok. 88 passed`.

Run: `cd runtime && bun test 2>&1 | tail -3`
Expected: `98 pass`.

Run: `bun test tests/integration.test.ts 2>&1 | tail -3`
Expected: `63 pass` (UNCHANGED — all baseline integration tests still pass through the new dispatch path).

- [ ] **Step 12: Quick manual smoke — server still serves the example app**

Run server in background:
```bash
cd /Users/detoro/code/brust && BRUST_PORT=38240 BRUST_WORKERS=1 bun run example/hello-world/index.ts &
sleep 2
```

Run: `curl -i http://127.0.0.1:38240/ 2>&1 | head -10`
Expected: `HTTP/1.1 200 OK` with `Content-Length:` header (NOT `Transfer-Encoding`) + HTML body. Kill the server: `lsof -ti :38240 | xargs kill -9`.

- [ ] **Step 13: Commit**

```bash
git add src/pool.rs src/lib.rs src/server.rs runtime/index.ts runtime/routes.ts
git commit -m "$(cat <<'EOF'
feat(streaming): switch renderer contract — Promise<()> + chunk channel

The cascade landed atomically (spec S5.1 — six concrete sites):

  • src/pool.rs:11      RendererTsfn: Promise<u32> → Promise<()>
  • src/lib.rs:139      register_renderer: matching signature update
  • src/server.rs:798   dispatch_to_worker_and_send_meta_response REPLACED
                        by dispatch_to_worker_and_stream_chunks (uses
                        render_slot + RenderSlotGuard from pool.rs)
  • runtime/index.ts:29 RenderFn: Promise<number> → Promise<void>
  • runtime/routes.ts   makeRenderer rewired: action/mcp emit one chunk
                        via emitSingleChunkResponse; render calls into
                        renderBranchStreaming; sse/ws bypass the chunk
                        channel entirely (unchanged per-conn helpers).
  • old renderBranch + packResponse deleted (no callers).

The render+action branches share one dispatch model now; SSE+WS keep
their own per-conn helpers as documented in spec S3 (intentional
divergence).

Baseline: 88 Rust + 98 runtime + 63 integration tests — all unchanged.
Single-chunk wire shape is byte-identical to the renderToString path
for no-Suspense routes; existing integration tests verify this.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5: Example route + integration tests + architecture promotion

### Task 6: `/slow-suspense` example route

A route that demonstrates streaming end-to-end — a `<Suspense>` boundary with a child that resolves after 200ms.

**Files:**
- Create: `example/hello-world/components/SlowSuspense.tsx`
- Modify: `example/hello-world/routes.tsx`

- [ ] **Step 1: Create `example/hello-world/components/SlowSuspense.tsx`**

```tsx
import { Suspense, createElement } from 'react'

// Cache the resolved promise per process so reloads don't pile up new ones.
let cached: Promise<string> | null = null

function slowFetch(): Promise<string> {
  if (cached) return cached
  cached = new Promise<string>((resolve) => {
    setTimeout(() => resolve('Resolved after 200ms via Suspense streaming'), 200)
  })
  return cached
}

function SlowChild(): JSX.Element {
  const promise = slowFetch()
  // React 18 SSR Suspense: throw a Promise to suspend.
  if ((promise as any).status !== 'fulfilled') {
    promise.then((v) => { (promise as any).status = 'fulfilled'; (promise as any).value = v })
    throw promise
  }
  return createElement('p', { 'data-testid': 'slow-content' }, (promise as any).value)
}

export default function SlowSuspense(): JSX.Element {
  return createElement('html', null,
    createElement('head', null, createElement('title', null, 'slow-suspense')),
    createElement('body', null,
      createElement('h1', null, 'Streaming demo'),
      createElement(Suspense, { fallback: createElement('p', { 'data-testid': 'spinner' }, 'loading...') },
        createElement(SlowChild),
      ),
    ),
  )
}
```

- [ ] **Step 2: Register the route in `example/hello-world/routes.tsx`**

Add the import alongside the existing component imports:
```tsx
import SlowSuspense from './components/SlowSuspense'
```

Append the route entry to the `defineRoutes([...])` array, right before the WS routes:
```tsx
{ path: '/slow-suspense', Component: SlowSuspense },
```

- [ ] **Step 3: Sanity check — server boots + the route renders**

```bash
cd /Users/detoro/code/brust && BRUST_PORT=38240 BRUST_WORKERS=1 bun run example/hello-world/index.ts &
sleep 2
curl -i http://127.0.0.1:38240/slow-suspense 2>&1 | head -15
lsof -ti :38240 | xargs kill -9
```

Expected: `HTTP/1.1 200 OK` with `Transfer-Encoding: chunked` (NOT `Content-Length`) + HTML body that includes BOTH the spinner placeholder AND the resolved content (interleaved with React hydration markers).

- [ ] **Step 4: Commit**

```bash
git add example/hello-world/components/SlowSuspense.tsx example/hello-world/routes.tsx
git commit -m "$(cat <<'EOF'
feat(example): /slow-suspense route — streaming demo + integration target

Route uses <Suspense> with a child that throws a 200ms-resolving Promise.
End-to-end demonstration of the streaming path: shell + Spinner ships in
the first chunk under chunked transfer-encoding; resolved content arrives
in a later chunk. Provides the live target for the streaming-round-trip
integration test (Task 7).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 3 integration tests at ports 38230-38232

**Files:**
- Modify: `tests/integration.test.ts`

- [ ] **Step 1: Append 3 tests to `tests/integration.test.ts`** (after the last WS test)

```typescript
// ----- HTML Streaming integration tests -----

const STREAM_ENV = (port: string) => ({
  ...process.env,
  BRUST_PORT: port,
  BRUST_WORKERS: '1',
  RUST_LOG: 'brust=warn',
})

test('streaming: single-chunk regression — / uses Content-Length, not chunked', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: STREAM_ENV('38230'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/`)
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-length')).not.toBeNull()
    expect(resp.headers.get('transfer-encoding')).toBeNull()
    const body = await resp.text()
    expect(body).toContain('<html')
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('streaming: /slow-suspense uses Transfer-Encoding: chunked + shell-before-resolved', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: STREAM_ENV('38231'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/slow-suspense`)
    expect(resp.status).toBe(200)
    expect(resp.headers.get('transfer-encoding')).toBe('chunked')
    expect(resp.headers.get('content-length')).toBeNull()
    // Read the body progressively — assert spinner arrives before resolved
    // content (proves streaming, not buffered).
    const reader = resp.body!.getReader()
    const decoder = new TextDecoder()
    let acc = ''
    let sawSpinnerBeforeResolved = false
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      acc += decoder.decode(value, { stream: true })
      if (!sawSpinnerBeforeResolved
          && acc.includes('loading...')
          && !acc.includes('Resolved after 200ms')) {
        sawSpinnerBeforeResolved = true
      }
    }
    expect(sawSpinnerBeforeResolved).toBe(true)
    expect(acc).toContain('Resolved after 200ms')
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)

test('streaming: mid-stream disconnect — second request to same worker still succeeds', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: STREAM_ENV('38232'),
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    // First request: open the chunked stream, then abort mid-flight.
    const ac = new AbortController()
    const first = fetch(`http://127.0.0.1:${port}/slow-suspense`, { signal: ac.signal })
      .catch((e: Error) => ({ aborted: true, msg: e.message }))
    // Give the server time to commit headers + first chunk before we abort.
    await new Promise((r) => setTimeout(r, 100))
    ac.abort()
    await first  // resolves to { aborted: true } via the .catch

    // Wait a beat for slot Drop guard to fire.
    await new Promise((r) => setTimeout(r, 200))

    // Second request to the SAME worker (BRUST_WORKERS=1) MUST succeed —
    // proves RenderSlotGuard cleared the leaked slot on the cancelled request.
    const resp = await fetch(`http://127.0.0.1:${port}/`)
    expect(resp.status).toBe(200)
    const body = await resp.text()
    expect(body.length).toBeGreaterThan(0)
  } finally {
    proc.kill('SIGINT'); await proc.exited
  }
}, 15_000)
```

- [ ] **Step 2: Run just the 3 new tests**

Run: `bun test tests/integration.test.ts --test-name-pattern "streaming:" 2>&1 | tail -10`
Expected: `3 pass, 0 fail`.

- [ ] **Step 3: Run the full integration suite**

Run: `bun test tests/integration.test.ts 2>&1 | tail -5`
Expected: `66 pass, 0 fail` (63 baseline + 3 new).

- [ ] **Step 4: Commit**

```bash
git add tests/integration.test.ts
git commit -m "$(cat <<'EOF'
test(integration): 3 HTML streaming tests at ports 38230-38232

- single-chunk regression: GET / uses Content-Length (NOT Transfer-Encoding),
  proving the no-Suspense path stays on the byte-identical wire shape
- streaming round-trip: /slow-suspense uses Transfer-Encoding: chunked;
  body reader sees the spinner BEFORE the resolved 200ms content,
  proving the stream is genuinely chunked-as-it-goes (not buffered)
- mid-stream disconnect + slot recovery: abort the chunked stream
  mid-flight, then issue a second request to the same worker
  (BRUST_WORKERS=1); the second request succeeds, proving
  RenderSlotGuard's Drop impl cleared the leaked slot

Total integration tests: 66 (63 baseline + 3 streaming).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Promote HTML Streaming to Built in `architecture.md`

**Files:**
- Modify: `architecture.md`

- [ ] **Step 1: Update the Built list + remove from Designed-not-built**

Find the existing HTML Streaming description block in `architecture.md` (search `### HTML Streaming` — it's around line 753). The narrative block stays, but update its opening sentence to reflect "shipped":

Replace:
> `renderToPipeableStream` writes the page as chunks while loaders are still resolving — useful for Suspense + slow data.

With:
> **Shipped.** `renderToPipeableStream` writes the page as chunks while loaders are still resolving — useful for Suspense + slow data. Auto-detected per request: routes whose tree has no pending Suspense at `onShellReady` emit a single-chunk Content-Length response (byte-identical to the prior renderToString path for no-Suspense pages); routes with pending Suspense stream via HTTP/1.1 chunked transfer-encoding.

Also update the "Currently deferred from build" closing paragraph of that section to:
> Shipped in 2026-05. Spec: `docs/superpowers/specs/2026-05-26-html-streaming-design.md`. Implementation plan: `docs/superpowers/plans/2026-05-26-html-streaming.md`.

Find the Built list (search for `- Real-time: WebSockets (RFC 6455)` — added in the prior session). Add a new bullet right after the SSE/WS entries:

```
- HTML Streaming (`renderToPipeableStream` + auto-detect Suspense) — Worker registers a single streaming renderer (Promise<()>). Chunks flow through a side channel: `napiRenderChunk(workerId, len: u32)` where `len=0` is the final signal. Per-worker `render_slot: Mutex<Option<RenderSlot>>` carries the chunk channel; lifecycle is RAII-clamped by `RenderSlotGuard` so tokio cancellation can't leak the slot. JS-side: `runtime/render/stream.ts` runs a buffering `Writable` sink — `onShellReady` peeks React's `pendingSuspenseBoundaries` (with explicit typeof-number feature-detect, defaulting to `streaming:true` if React renames the property). No-Suspense path waits for `onAllReady`, checks `consumeIslandUsedFlag()`, emits one chunk with conditional bootstrap (preserves prior behavior). Suspense path commits chunked headers at `onShellReady` and always includes the islands bootstrap (~500 bytes overhead — late islands inside pending Suspense haven't rendered yet). `dispatch_to_worker_and_stream_chunks` is the unified dispatch for both render and action branches; sse/ws bypass the chunk channel entirely. Cache layer only stores single-chunk responses (chunked framing is ambiguous post-decode).
```

Find the "Designed, not built" section — there is NO entry for HTML Streaming to remove there (it was already in Built list per recent SSE/WS work — verify by searching). If a stale entry exists, delete it.

- [ ] **Step 2: Final full-suite run + commit**

Run all three test layers to confirm nothing regressed:
```bash
cargo test --lib 2>&1 | tail -3
cd runtime && bun test 2>&1 | tail -3
cd /Users/detoro/code/brust && bun test tests/integration.test.ts 2>&1 | tail -3
```

Expected:
- Rust: `88 passed`
- Runtime: `98 pass`
- Integration: `66 pass`

- [ ] **Step 3: Commit**

```bash
git add architecture.md
git commit -m "$(cat <<'EOF'
docs(architecture): HTML Streaming shipped — promote to Built list

Auto-detect Suspense path is live. No-Suspense routes stay on the
byte-identical Content-Length wire shape; Suspense routes stream via
chunked transfer-encoding with shell-first delivery. Documents the
RenderSlot/RenderSlotGuard lifecycle, the unified dispatch helper, the
pendingSuspenseBoundaries feature-detect with default-true fallback,
the islands flag preservation on the buffering path, and the
~500-byte always-include-bootstrap trade on the streaming path.

Final test count: 88 Rust + 98 runtime + 66 integration (was 73 + 92 + 63
at session start) — 24 new tests across the 8-task implementation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Spec coverage check (self-review)

| Spec S | Implementing tasks |
|---|---|
| S1 success criterion 1 (single-chunk Content-Length, byte-identical no-Suspense) | Task 5 + Task 7 test 1 |
| S1 success criterion 2 (streaming round-trip with Transfer-Encoding: chunked) | Task 6 + Task 7 test 2 |
| S1 success criterion 3 (TTFB win, shell-before-resolved) | Task 7 test 2 (sawSpinnerBeforeResolved) |
| S1 success criterion 4 (mid-stream disconnect, slot recovery) | Task 1 RenderSlotGuard + Task 7 test 3 |
| S1 success criterion 5 (pre-shell crash → 500 + errorBoundary, single chunk) | Task 4 test 3 |
| S1 success criterion 6 (post-shell crash → Suspense errorBoundary, 200) | Task 4 test 4 |
| S1 success criterion 7 (islands work in streaming mode) | Task 4 test 2 (bootstrap always-injected on streaming path) |
| S1 success criterion 8 (no regression — 73+92+63 unchanged) | Task 5 step 11 + Task 8 step 2 |
| S2 Architecture | Tasks 1-5 (slot, NAPI, sink, dispatch helper, contract) |
| S3 Module layout | Task 1 (pool.rs), Task 2 (render_stream.rs), Task 3 (lib.rs), Task 4 (runtime/render/stream.ts), Task 5 (server.rs, routes.ts, index.ts) |
| S4 Wire protocol (SAB layout + meta + transfer-encoding) | Task 2 (split_meta + format helpers) + Task 4 (encodeFirstChunk/encodeBodyChunk) |
| S5.1 Contract cascade table | Task 5 steps 1-7 (all 6 sites) |
| S5.2 napi_render_chunk contract | Task 3 |
| S5.3 RenderSlot + RAII guard | Task 1 |
| S6 JS-side wrapper (renderBranchStreaming + sink + helpers) | Task 4 |
| S7 Rust handle_conn chunk routing | Task 5 step 3 (replacement helper) |
| S7.4 mpsc buffer = 1 | Task 5 step 3 (buffer size 1 in code) |
| S8 Error matrix | Task 4 (JS-side error paths) + Task 5 (Rust select! arms) |
| S9 Testing (9 Rust + 6 runtime + 3 integration) | Tasks 1, 2, 3 (Rust); Task 4 (runtime); Task 7 (integration) |
| S10 Limits & deferred | (Documented in spec; no impl task) |

All S1-S9 spec requirements map to at least one task.

## Type / name consistency check

| Identifier | Defined in task | Used in tasks |
|---|---|---|
| `RenderChunk { Bytes, Final }` | Task 1 (`src/pool.rs`) | Task 3 (`napi_render_chunk`), Task 5 (`handle_conn` loop) |
| `RenderSlot { chunk_tx }` | Task 1 | Task 3, Task 5 |
| `RenderSlotGuard<'e>` | Task 1 | Task 5 |
| `TsfnEntry::render_slot` | Task 1 | Task 3, Task 5 |
| `TsfnEntry::in_flight: AtomicU32` | (pre-existing, untouched) | Task 5 `_busy_guard` |
| `WorkerPool::entry(id)` | Task 3 step 4 | Task 3 `napi_render_chunk` |
| `ChunkMeta { status, content_type, headers, streaming }` | Task 2 (`src/render_stream.rs`) | Task 5 (`dispatch_to_worker_and_stream_chunks`) |
| `split_meta`, `format_chunk_framed`, `build_chunked_response_head`, `build_single_response_bytes` | Task 2 | Task 5 |
| `check_chunk_dispatch` | Task 3 step 1 (`src/render_stream.rs`) | Task 3 step 3 (`napi_render_chunk`) |
| `napi_render_chunk(worker_id, len)` | Task 3 | Task 4 (`napi` shim in `makeRenderer` calls `napiRenderChunk`) |
| `RendererTsfn = ThreadsafeFunction<String, Promise<()>, ...>` | Task 5 step 1 | Task 5 step 3 (`render_future` typed by this) |
| `register_renderer(buf, f: Function<String, Promise<()>>)` | Task 5 step 2 | (boot path — no in-plan callers) |
| `RenderFn = (env) => Promise<void>` | Task 5 step 6 | Task 5 step 7 (`makeRenderer` return type) |
| `renderBranchStreaming({ element, view, workerId, napi, errorBoundary })` | Task 4 | Task 5 step 7 (`makeRenderer` calls it) |
| `makeMeta`, `encodeFirstChunk`, `encodeBodyChunk` | Task 4 | Task 4 (internal) |
| `ISLANDS_IMPORTMAP_AND_BOOTSTRAP` | Task 4 step 4 (extracted to `runtime/islands/bootstrap.ts`) | Task 4 (`renderBranchStreaming`), Task 5 step 7 (still used by `routes.ts` if any caller remains) |
| `dispatch_to_worker_and_stream_chunks` | Task 5 step 3 | Task 5 steps 4, 5 (render + action branches) |
| `emitSingleChunkResponse` | Task 5 step 7 | Task 5 step 7 (action/mcp/sse/ws branches in makeRenderer) |
| `actionBranchToResponse`, `mcpBranchToResponse` | Task 5 step 8 | Task 5 step 7 (`makeRenderer`) |

All cross-references resolved.

---

**Total: 8 tasks; ~10-12 hours engineering; 9 Rust unit + 6 runtime unit + 3 integration = 18 new tests → 254 total.**
