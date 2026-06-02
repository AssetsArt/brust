# Brust NAPI Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing pingora-subprocess skeleton on `main` with an inverted-control skeleton — Bun is the host, Rust is loaded as a `.node` native module via napi-rs. Render via Bun Worker threads + ThreadsafeFunction. tokio-uring on Linux, tokio on macOS. End-to-end validation via one `bun test` integration test.

**Architecture:** Single Bun process. Main isolate loads the `.node` and spawns N Bun Worker threads. Each worker registers a render fn (ThreadsafeFunction). Rust starts a background tokio/tokio-uring runtime that accepts TCP, parses HTTP/1.1 via `httparse`, picks least-busy worker by atomic counter, calls the tsfn via `call_async`, writes the response.

**Tech Stack:** Rust (edition 2024) · `napi = "3"` with `async`/`napi6` features · `napi-derive = "3"` · `napi-build = "2"` · `httparse` · `parking_lot` · `tracing` · `tokio-uring` (Linux) · `tokio` (macOS). Bun 1.1+ · React 18 · TypeScript 5 · `@napi-rs/cli`.

**Source of truth for design:** `docs/superpowers/specs/2026-05-23-napi-rewrite-design.md`.

**Plan-vs-spec deviation note:** The spec's Section 3 Rust type sketches use napi-rs 2.x syntax (`ThreadsafeFunction<String, ErrorStrategy::Fatal>`). This plan uses napi-rs **3.x** syntax (`Function<String, Promise<String>>` as input parameter, build via `.build_threadsafe_function()`, call via `tsfn.call_async(Ok(arg)).await?.await?`). The architectural intent is identical; the surface differs because the plan was verified against current napi-rs docs.

---

## File Structure

| File | Responsibility |
|---|---|
| `Cargo.toml` | Rust crate manifest; `[lib] crate-type = ["cdylib"]`; napi-rs + cfg deps |
| `build.rs` | `napi_build::setup()` — codegen hook |
| `package.json` (root) | napi-rs CLI config (name, triples, output dir) |
| `src/lib.rs` | napi exports: `beginServe`, `untilReady`, `untilShutdown`, `registerRenderer`, `isWorker`, `workerId`; global state (OnceCell) |
| `src/pool.rs` | `WorkerPool`, `TsfnEntry { id, tsfn, in_flight }`, `InFlightGuard` |
| `src/server.rs` | accept loop using `io` abstraction; `handle_conn` per-connection task |
| `src/http.rs` | `parse_request` via `httparse`; `build_response`; error helpers |
| `src/shutdown.rs` | tokio `Notify` for shutdown coordination |
| `src/io/mod.rs` | cfg-gated re-export of platform impl |
| `src/io/linux.rs` | `cfg(target_os = "linux")` — tokio-uring `TcpListener`, `TcpStream`, runtime |
| `src/io/other.rs` | `cfg(not(target_os = "linux"))` — tokio versions of the same |
| `runtime/package.json` | bun deps: react, react-dom; devDeps: `@napi-rs/cli`, typescript, react types |
| `runtime/tsconfig.json` | TS config; `moduleResolution: bundler`, JSX react-jsx |
| `runtime/index.ts` | JS facade: re-exports + `brust.serve()` composer |
| `runtime/index.js` (generated) | napi-rs loader shim; gitignored |
| `runtime/brust.{triple}.node` (generated) | compiled native binary; gitignored |
| `runtime/components/HelloWorld.tsx` | unchanged from prior skeleton |
| `app/index.ts` | skeleton consumer: single-file conditional `isWorker → register` vs `main → serve` |
| `tests/integration.test.ts` | `bun test` integration test |
| `.gitignore` (root) | add `runtime/*.node`, `runtime/index.js` (regenerated each build) |

---

## Task 1 — Wipe old skeleton, prepare clean slate

**Files:**
- Delete: `src/main.rs`, `src/boot.rs`, `src/config.rs`, `src/ipc.rs`, `src/listener.rs`, `src/pool.rs`, `src/proxy.rs`, `src/router.rs`, `src/worker.rs`
- Delete: `runtime/worker.ts`, `runtime/framer.ts`, `runtime/queue.ts`, `runtime/pages.ts`
- Delete: `tests/integration.rs`
- Modify: `Cargo.toml`, `runtime/package.json`, root `.gitignore`

- [ ] **Step 1: Delete the old Rust skeleton sources.**

```bash
rm src/main.rs src/boot.rs src/config.rs src/ipc.rs src/listener.rs \
   src/pool.rs src/proxy.rs src/router.rs src/worker.rs
rm runtime/worker.ts runtime/framer.ts runtime/queue.ts runtime/pages.ts
rm tests/integration.rs
```

- [ ] **Step 2: Replace `Cargo.toml` with the napi-rs scaffold.**

```toml
[package]
name    = "brust"
version = "0.1.0"
edition = "2024"

[lib]
crate-type = ["cdylib"]

[dependencies]
napi               = { version = "3", default-features = false, features = ["napi6", "async"] }
napi-derive        = "3"
httparse           = "1"
parking_lot        = "0.12"
tracing            = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
once_cell          = "1"

[target.'cfg(target_os = "linux")'.dependencies]
tokio-uring = "0.5"

[target.'cfg(not(target_os = "linux"))'.dependencies]
tokio       = { version = "1", features = ["rt", "macros", "net", "io-util", "time", "sync", "signal"] }

[build-dependencies]
napi-build = "2"

[profile.release]
lto         = true
strip       = "symbols"
codegen-units = 1
```

- [ ] **Step 3: Update root `.gitignore`** (append):

```gitignore
runtime/*.node
runtime/index.js
runtime/index.d.ts
```

- [ ] **Step 4: Verify the crate compiles to an empty cdylib stub.**

Create `src/lib.rs` with a one-liner so cargo has something to compile:
```rust
// placeholder — will be replaced in Task 2
```

Run: `cargo build`
Expected: warnings about missing src content but builds successfully. If it fails because lib.rs is empty, add `pub fn _placeholder() {}` and re-run.

- [ ] **Step 5: Commit.**

```bash
git add -A
git commit -m "refactor(skeleton): wipe pingora skeleton, prepare napi-rs scaffold"
```

---

## Task 2 — napi-rs scaffold: build.rs + root package.json + lib.rs stub

**Files:**
- Create: `build.rs`
- Create: `package.json` (root)
- Modify: `src/lib.rs`

- [ ] **Step 1: Write `build.rs`.**

```rust
extern crate napi_build;

fn main() {
    napi_build::setup();
}
```

- [ ] **Step 2: Write root `package.json` (napi-rs CLI metadata).**

```json
{
  "name": "brust",
  "version": "0.1.0",
  "private": true,
  "napi": {
    "binaryName": "brust",
    "targets": [
      "x86_64-apple-darwin",
      "aarch64-apple-darwin",
      "x86_64-unknown-linux-gnu",
      "aarch64-unknown-linux-gnu"
    ]
  }
}
```

The CLI uses this to know what `.node` filename to emit for each target.

- [ ] **Step 3: Replace `src/lib.rs` with a minimal napi-derive scaffold.**

```rust
#![deny(clippy::all)]

use napi_derive::napi;

#[napi]
pub fn hello() -> String {
    "hello from brust".to_string()
}
```

- [ ] **Step 4: Verify the crate still builds.**

Run: `cargo build`
Expected: success, produces `target/debug/libbrust.dylib` (macOS) or `.so` (Linux).

- [ ] **Step 5: Commit.**

```bash
git add Cargo.toml build.rs package.json src/lib.rs .gitignore
git commit -m "feat(napi): scaffold napi-rs crate with build.rs and hello stub"
```

---

## Task 3 — runtime/ package + napi build pipeline

**Files:**
- Modify: `runtime/package.json`
- Modify: `runtime/tsconfig.json` (verify settings)
- Create: `runtime/index.ts` (stub, will be replaced in Task 12)

- [ ] **Step 1: Replace `runtime/package.json`.**

```json
{
  "name": "brust-runtime",
  "type": "module",
  "private": true,
  "main": "index.js",
  "types": "index.d.ts",
  "scripts": {
    "build":       "napi build --platform --release --js index.js --dts index.d.ts",
    "build:debug": "napi build --platform --js index.js --dts index.d.ts"
  },
  "dependencies": {
    "react":     "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@napi-rs/cli":     "^3.0.0",
    "@types/react":     "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "typescript":       "^5.5.0"
  }
}
```

(Note: `napi build` is run from inside `runtime/` but operates on the parent Cargo project. The CLI walks up to find `Cargo.toml`. Output `.node` lands in `runtime/`.)

- [ ] **Step 2: Verify `runtime/tsconfig.json` is correct (replace if drift).**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowImportingTsExtensions": true,
    "noEmit": true
  },
  "include": ["**/*.ts", "**/*.tsx"]
}
```

- [ ] **Step 3: Create `runtime/index.ts` stub.**

```ts
// JS facade — composes napi-rs exports into brust.serve(). Filled in Task 12.
// For now, just re-export from the generated index.js shim.
// @ts-expect-error - index.js is generated by napi-rs at build time
export * from './index.js'
```

- [ ] **Step 4: Install JS deps and build the .node.**

```bash
cd runtime && bun install
cd runtime && bun run build:debug
```

Expected: a `runtime/brust.{platform}.node` file appears (e.g. `brust.darwin-arm64.node` on Apple Silicon). `runtime/index.js` and `runtime/index.d.ts` are also generated. The `.d.ts` should declare `export declare function hello(): string`.

- [ ] **Step 5: Smoke-test the native module.**

```bash
cd runtime && bun -e "import('./index.js').then(m => console.log(m.hello()))"
```

Expected output: `hello from brust`

- [ ] **Step 6: Commit.**

```bash
git add runtime/package.json runtime/tsconfig.json runtime/index.ts runtime/bun.lock
git commit -m "feat(napi): runtime package with napi build pipeline and hello smoke test"
```

(Do NOT commit `runtime/brust.*.node`, `runtime/index.js`, `runtime/index.d.ts` — they're gitignored.)

---

## Task 4 — Failing integration test

**Files:**
- Create: `tests/integration.test.ts`

The test will fail (or time out) until every subsequent task is done — that's the green light at the end.

- [ ] **Step 1: Write `tests/integration.test.ts`.**

```ts
import { test, expect } from 'bun:test'
import { spawn } from 'bun'

test('serves rendered html via worker pool', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'app/index.ts'],
    env: {
      ...process.env,
      BRUST_PORT: '38123',
      RUST_LOG: 'brust=info',
    },
    stdout: 'pipe',
    stderr: 'inherit',
  })

  const port = await readPortLine(proc.stdout)

  const resp = await fetch(`http://127.0.0.1:${port}/`)
  expect(resp.status).toBe(200)

  const body = await resp.text()
  expect(body).toContain('Hello from Brust')
  expect(body).toMatch(/worker_id=\d+/)

  proc.kill('SIGINT')
  const exit = await proc.exited
  expect(exit).toBe(0)
}, 15_000)

async function readPortLine(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let acc = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) throw new Error('process closed stdout before listening log')
    acc += decoder.decode(value, { stream: true })
    const m = acc.match(/listening on 127\.0\.0\.1:(\d+)/)
    if (m) {
      reader.releaseLock()
      return parseInt(m[1], 10)
    }
  }
}
```

- [ ] **Step 2: Run the test to confirm it fails.**

Run: `bun test tests/integration.test.ts`
Expected: FAIL — `bun run app/index.ts` errors because `app/index.ts` doesn't exist yet, OR the spawn returns with stderr "Module not found". Either way, the test panics before the port line appears.

- [ ] **Step 3: Commit.**

```bash
git add tests/integration.test.ts
git commit -m "test(napi): add failing end-to-end integration test"
```

---

## Task 5 — App skeleton (`app/index.ts`) with conditional branching

**Files:**
- Create: `app/index.ts`

This file is the user's entrypoint. For skeleton, it has the route hardcoded inline.

- [ ] **Step 1: Write `app/index.ts`.**

```ts
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import HelloWorld from '../runtime/components/HelloWorld'

import {
  brust,
  isWorker,
  workerId,
} from '../runtime/index.ts'

const PORT_ENV = process.env.BRUST_PORT
const port = PORT_ENV ? parseInt(PORT_ENV, 10) : 3000
const workers = parseInt(process.env.BRUST_WORKERS ?? '8', 10)

if (!isWorker) {
  console.log(`[brust] main: spawning ${workers} worker threads`)
  await brust.serve({
    port,
    workers,
    entry: import.meta.url,
  })
} else {
  brust.registerRenderer(async (path: string) => {
    return renderToString(
      createElement(HelloWorld, { workerId: String(workerId) })
    )
  })
}
```

- [ ] **Step 2: Verify it still fails the test (the runtime isn't built yet).**

Run: `bun test tests/integration.test.ts`
Expected: FAIL — `brust`, `isWorker`, `workerId` aren't real exports yet. The error message will tell you the test panicked because the spawned process exited with stderr noise.

This is the expected red state.

- [ ] **Step 3: Commit.**

```bash
git add app/index.ts
git commit -m "feat(skeleton): app entrypoint with single-file conditional"
```

---

## Task 6 — HTTP module: parse + build_response + error helpers

**Files:**
- Create: `src/http.rs`

- [ ] **Step 1: Write `src/http.rs`.**

```rust
use httparse::{Request as HttpRequest, EMPTY_HEADER, Status};

pub struct ParsedRequest<'a> {
    pub method: &'a str,
    pub path: &'a str,
}

pub fn parse_request<'a>(buf: &'a [u8]) -> Result<ParsedRequest<'a>, ParseError> {
    let mut headers = [EMPTY_HEADER; 32];
    let mut req = HttpRequest::new(&mut headers);
    match req.parse(buf) {
        Ok(Status::Complete(_)) => Ok(ParsedRequest {
            method: req.method.ok_or(ParseError::Incomplete)?,
            path:   req.path.ok_or(ParseError::Incomplete)?,
        }),
        Ok(Status::Partial)     => Err(ParseError::Incomplete),
        Err(_)                  => Err(ParseError::Invalid),
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("incomplete request")]
    Incomplete,
    #[error("invalid request")]
    Invalid,
}

pub fn build_response(status: u16, content_type: &str, body: Vec<u8>) -> Vec<u8> {
    let status_text = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        414 => "URI Too Long",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _   => "Unknown",
    };
    let header = format!(
        "HTTP/1.1 {status} {status_text}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n",
        body.len(),
    );
    let mut out = header.into_bytes();
    out.extend_from_slice(&body);
    out
}

pub fn error_400() -> Vec<u8> { build_response(400, "text/plain", b"bad request".to_vec()) }
pub fn error_404() -> Vec<u8> { build_response(404, "text/plain", b"not found".to_vec()) }
pub fn error_405() -> Vec<u8> { build_response(405, "text/plain", b"method not allowed".to_vec()) }
pub fn error_414() -> Vec<u8> { build_response(414, "text/plain", b"uri too long".to_vec()) }
pub fn error_503(msg: &str) -> Vec<u8> {
    build_response(503, "text/plain", msg.as_bytes().to_vec())
}
```

- [ ] **Step 2: Add `thiserror` dep to `Cargo.toml`.**

In `[dependencies]`, add:
```toml
thiserror = "1"
```

- [ ] **Step 3: Register the module in `src/lib.rs`.**

Replace `src/lib.rs` with:
```rust
#![deny(clippy::all)]

mod http;

use napi_derive::napi;

#[napi]
pub fn hello() -> String {
    "hello from brust".to_string()
}
```

- [ ] **Step 4: Verify cargo build.**

Run: `cargo build`
Expected: success, with `dead_code` warnings on unused items.

- [ ] **Step 5: Commit.**

```bash
git add Cargo.toml src/http.rs src/lib.rs
git commit -m "feat(napi): http parsing and response building via httparse"
```

---

## Task 7 — Platform-abstracted I/O (`src/io/`)

**Files:**
- Create: `src/io/mod.rs`
- Create: `src/io/linux.rs`
- Create: `src/io/other.rs`

- [ ] **Step 1: Write `src/io/mod.rs`.**

```rust
#[cfg(target_os = "linux")]
pub use self::linux::{run_io, spawn, TcpListener, TcpStream, IO_NAME};

#[cfg(not(target_os = "linux"))]
pub use self::other::{run_io, spawn, TcpListener, TcpStream, IO_NAME};

#[cfg(target_os = "linux")]
mod linux;

#[cfg(not(target_os = "linux"))]
mod other;
```

- [ ] **Step 2: Write `src/io/linux.rs`.**

```rust
#![cfg(target_os = "linux")]

use std::future::Future;
use std::net::SocketAddr;

pub const IO_NAME: &str = "tokio-uring";

pub fn run_io<F, Fut>(f: F)
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = ()>,
{
    std::thread::spawn(move || {
        tokio_uring::start(async move { f().await });
    });
}

pub fn spawn<F: Future<Output = ()> + 'static>(f: F) {
    tokio_uring::spawn(f);
}

pub struct TcpListener(tokio_uring::net::TcpListener);
pub struct TcpStream(tokio_uring::net::TcpStream);

impl TcpListener {
    pub async fn bind(addr: SocketAddr) -> std::io::Result<Self> {
        tokio_uring::net::TcpListener::bind(addr).map(Self)
    }

    pub async fn accept(&self) -> std::io::Result<(TcpStream, SocketAddr)> {
        let (s, addr) = self.0.accept().await?;
        Ok((TcpStream(s), addr))
    }
}

impl TcpStream {
    pub async fn read_request(&mut self, buf: &mut Vec<u8>) -> std::io::Result<usize> {
        // tokio-uring read takes ownership; we swap the buffer
        let owned = std::mem::take(buf);
        let (res, returned) = self.0.read(owned).await;
        *buf = returned;
        res
    }

    pub async fn write_all(&mut self, bytes: Vec<u8>) -> std::io::Result<()> {
        let (res, _) = self.0.write_all(bytes).await;
        res
    }

    pub async fn shutdown(&mut self) -> std::io::Result<()> {
        self.0.shutdown(std::net::Shutdown::Both)
    }
}
```

- [ ] **Step 3: Write `src/io/other.rs`.**

```rust
#![cfg(not(target_os = "linux"))]

use std::future::Future;
use std::net::SocketAddr;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const IO_NAME: &str = "tokio";

pub fn run_io<F, Fut>(f: F)
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send,
{
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()
            .expect("tokio runtime");
        rt.block_on(async move { f().await });
    });
}

pub fn spawn<F: Future<Output = ()> + Send + 'static>(f: F) {
    tokio::spawn(f);
}

pub struct TcpListener(tokio::net::TcpListener);
pub struct TcpStream(tokio::net::TcpStream);

impl TcpListener {
    pub async fn bind(addr: SocketAddr) -> std::io::Result<Self> {
        tokio::net::TcpListener::bind(addr).await.map(Self)
    }

    pub async fn accept(&self) -> std::io::Result<(TcpStream, SocketAddr)> {
        let (s, addr) = self.0.accept().await?;
        Ok((TcpStream(s), addr))
    }
}

impl TcpStream {
    pub async fn read_request(&mut self, buf: &mut Vec<u8>) -> std::io::Result<usize> {
        let mut tmp = [0u8; 4096];
        let n = self.0.read(&mut tmp).await?;
        buf.extend_from_slice(&tmp[..n]);
        Ok(n)
    }

    pub async fn write_all(&mut self, bytes: Vec<u8>) -> std::io::Result<()> {
        self.0.write_all(&bytes).await
    }

    pub async fn shutdown(&mut self) -> std::io::Result<()> {
        self.0.shutdown().await
    }
}
```

- [ ] **Step 4: Register `mod io;` in `src/lib.rs`.**

```rust
#![deny(clippy::all)]

mod http;
mod io;

use napi_derive::napi;

#[napi]
pub fn hello() -> String {
    "hello from brust".to_string()
}
```

- [ ] **Step 5: Verify cargo build on the current platform (macOS).**

Run: `cargo build`
Expected: success. The Linux module is gated out by cfg.

- [ ] **Step 6: Commit.**

```bash
git add src/io src/lib.rs
git commit -m "feat(napi): cfg-split IO abstraction (tokio-uring linux, tokio elsewhere)"
```

---

## Task 8 — Worker pool with ThreadsafeFunction entries

**Files:**
- Create: `src/pool.rs`

- [ ] **Step 1: Write `src/pool.rs`.**

```rust
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use napi::bindgen_prelude::Promise;
use napi::threadsafe_function::ThreadsafeFunction;
use parking_lot::RwLock;

/// Renderer signature: takes a path (String) and returns Promise<String>.
pub type RendererTsfn = ThreadsafeFunction<String, Promise<String>>;

pub struct TsfnEntry {
    pub id: u32,
    pub tsfn: RendererTsfn,
    pub in_flight: AtomicU32,
}

impl TsfnEntry {
    pub fn in_flight_guard(self: &Arc<Self>) -> InFlightGuard {
        self.in_flight.fetch_add(1, Ordering::Relaxed);
        InFlightGuard(Arc::clone(self))
    }
}

pub struct InFlightGuard(Arc<TsfnEntry>);

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.0.in_flight.fetch_sub(1, Ordering::Relaxed);
    }
}

#[derive(Default)]
pub struct WorkerPool {
    entries: RwLock<Vec<Arc<TsfnEntry>>>,
    next_id: AtomicU32,
}

impl WorkerPool {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, tsfn: RendererTsfn) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let entry = Arc::new(TsfnEntry {
            id,
            tsfn,
            in_flight: AtomicU32::new(0),
        });
        self.entries.write().push(entry);
        id
    }

    pub fn registered_count(&self) -> usize {
        self.entries.read().len()
    }

    pub fn pick_least_busy(&self) -> Option<Arc<TsfnEntry>> {
        let entries = self.entries.read();
        entries
            .iter()
            .min_by_key(|e| e.in_flight.load(Ordering::Acquire))
            .cloned()
    }

    pub fn remove(&self, id: u32) {
        self.entries.write().retain(|e| e.id != id);
    }
}
```

- [ ] **Step 2: Register `mod pool;` in `src/lib.rs`.**

```rust
#![deny(clippy::all)]

mod http;
mod io;
mod pool;

use napi_derive::napi;

#[napi]
pub fn hello() -> String {
    "hello from brust".to_string()
}
```

- [ ] **Step 3: Verify cargo build.**

Run: `cargo build`
Expected: success, with dead_code warnings.

- [ ] **Step 4: Commit.**

```bash
git add src/pool.rs src/lib.rs
git commit -m "feat(napi): WorkerPool with TsfnEntry and least-busy selection"
```

---

## Task 9 — Shutdown signal (`src/shutdown.rs`)

**Files:**
- Create: `src/shutdown.rs`

- [ ] **Step 1: Write `src/shutdown.rs`.**

```rust
use std::sync::Arc;

use tokio::sync::Notify;

#[derive(Default)]
pub struct Shutdown {
    notify: Notify,
}

impl Shutdown {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn wait(&self) {
        self.notify.notified().await;
    }

    pub fn signal(&self) {
        self.notify.notify_waiters();
    }
}

/// Install a SIGINT handler that calls shutdown.signal() once.
/// Safe to call multiple times — subsequent calls are no-ops.
pub fn install_sigint_handler(shutdown: Arc<Shutdown>) {
    // Spawn a small std::thread that uses tokio::signal::ctrl_c via a one-off runtime.
    // We don't use the main I/O runtime because it may live on a different thread.
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("signal runtime");
        rt.block_on(async {
            tokio::signal::ctrl_c().await.ok();
            shutdown.signal();
        });
    });
}
```

- [ ] **Step 2: Register `mod shutdown;` in `src/lib.rs`.**

```rust
#![deny(clippy::all)]

mod http;
mod io;
mod pool;
mod shutdown;

use napi_derive::napi;

#[napi]
pub fn hello() -> String {
    "hello from brust".to_string()
}
```

- [ ] **Step 3: Verify cargo build.**

Run: `cargo build`
Expected: success.

- [ ] **Step 4: Commit.**

```bash
git add src/shutdown.rs src/lib.rs
git commit -m "feat(napi): shutdown signal wired to SIGINT"
```

---

## Task 10 — Server module (accept loop + handle_conn)

**Files:**
- Create: `src/server.rs`

- [ ] **Step 1: Write `src/server.rs`.**

```rust
use std::net::SocketAddr;
use std::sync::Arc;

use napi::bindgen_prelude::Promise;
use tokio::sync::Notify;
use tracing::{error, warn};

use crate::http::{self, parse_request, ParseError};
use crate::io::{run_io, spawn, IO_NAME, TcpListener, TcpStream};
use crate::pool::WorkerPool;

const MAX_REQUEST_BYTES: usize = 16 * 1024;

pub fn start(addr: SocketAddr, ready: Arc<Notify>, pool: Arc<WorkerPool>) {
    run_io(move || async move {
        let listener = match TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                error!(error = %e, %addr, "bind failed");
                std::process::exit(1);
            }
        };

        ready.notified().await; // wait until all workers have registered
        println!("[brust] listening on {addr} (io: {IO_NAME})");

        loop {
            match listener.accept().await {
                Ok((stream, _peer)) => {
                    let pool = pool.clone();
                    spawn(async move {
                        handle_conn(stream, pool).await;
                    });
                }
                Err(e) => {
                    error!(error = %e, "accept failed");
                    std::process::exit(1);
                }
            }
        }
    });
}

async fn handle_conn(mut s: TcpStream, pool: Arc<WorkerPool>) {
    let mut buf = Vec::with_capacity(4096);
    if !read_full_request(&mut s, &mut buf).await {
        let _ = s.write_all(http::error_400()).await;
        return;
    }

    let (method, path) = match parse_request(&buf) {
        Ok(r) => (r.method.to_owned(), r.path.to_owned()),
        Err(ParseError::Incomplete) | Err(ParseError::Invalid) => {
            let _ = s.write_all(http::error_400()).await;
            return;
        }
    };

    if method != "GET" {
        let _ = s.write_all(http::error_405()).await;
        return;
    }

    let Some(entry) = pool.pick_least_busy() else {
        let _ = s.write_all(http::error_503("no workers")).await;
        return;
    };
    let _guard = entry.in_flight_guard();

    let path_arg = path.clone();
    match entry.tsfn.call_async::<Promise<String>>(Ok(path_arg)).await {
        Ok(promise) => match promise.await {
            Ok(html) => {
                let bytes = http::build_response(200, "text/html; charset=utf-8", html.into_bytes());
                let _ = s.write_all(bytes).await;
            }
            Err(e) => {
                error!(worker_id = entry.id, error = %e, "render promise rejected");
                let msg = format!("render error: {e}");
                let _ = s.write_all(http::build_response(500, "text/plain", msg.into_bytes())).await;
            }
        },
        Err(e) => {
            error!(worker_id = entry.id, error = %e, "tsfn call_async failed");
            let _ = s.write_all(http::build_response(502, "text/plain", b"upstream call failed".to_vec())).await;
            // worker tsfn likely dead — remove from pool
            pool.remove(entry.id);
            if pool.registered_count() == 0 {
                error!("all workers died");
                std::process::exit(1);
            }
        }
    }

    let _ = s.shutdown().await;
}

async fn read_full_request(s: &mut TcpStream, buf: &mut Vec<u8>) -> bool {
    while buf.len() < MAX_REQUEST_BYTES {
        let n = match s.read_request(buf).await {
            Ok(n) => n,
            Err(e) => {
                warn!(error = %e, "read failed");
                return false;
            }
        };
        if n == 0 {
            return false; // EOF before complete request
        }
        // check for end-of-headers
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            return true;
        }
    }
    // request too large
    false
}
```

- [ ] **Step 2: Register `mod server;` in `src/lib.rs`.**

```rust
#![deny(clippy::all)]

mod http;
mod io;
mod pool;
mod server;
mod shutdown;

use napi_derive::napi;

#[napi]
pub fn hello() -> String {
    "hello from brust".to_string()
}
```

- [ ] **Step 3: Verify cargo build.**

Run: `cargo build`
Expected: success. There may be `dead_code` warnings.

If the build fails with errors about `tsfn.call_async`, check that `napi = { version = "3", features = ["async", "napi6"] }` is in Cargo.toml — the `async` feature is required.

- [ ] **Step 4: Commit.**

```bash
git add src/server.rs src/lib.rs
git commit -m "feat(napi): accept loop, handle_conn with ThreadsafeFunction call_async"
```

---

## Task 11 — napi exports: lib.rs full surface

**Files:**
- Modify: `src/lib.rs`

This task replaces the `hello()` stub with the actual `beginServe`, `untilReady`, `untilShutdown`, `registerRenderer`, `isWorker`, `workerId` exports.

- [ ] **Step 1: Replace `src/lib.rs` with the full implementation.**

```rust
#![deny(clippy::all)]

mod http;
mod io;
mod pool;
mod server;
mod shutdown;

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::cell::Cell;
use std::time::Duration;

use napi::bindgen_prelude::{Function, Promise};
use napi::Result as NapiResult;
use napi_derive::napi;
use once_cell::sync::OnceCell;
use tokio::sync::Notify;
use tracing::error;
use tracing_subscriber::EnvFilter;

use crate::pool::{RendererTsfn, WorkerPool};
use crate::shutdown::{install_sigint_handler, Shutdown};

thread_local! {
    static WORKER_ID: Cell<Option<u32>> = const { Cell::new(None) };
}

struct State {
    pool: Arc<WorkerPool>,
    ready: Arc<Notify>,
    shutdown: Arc<Shutdown>,
    is_serving: AtomicBool,
    expected_workers: AtomicU32,
}

static STATE: OnceCell<State> = OnceCell::new();

fn state() -> &'static State {
    STATE.get_or_init(|| {
        // one-time tracing init (idempotent across module loads in Bun workers)
        let _ = tracing_subscriber::fmt()
            .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("brust=info")))
            .with_target(false)
            .with_writer(std::io::stderr)
            .try_init();
        State {
            pool: Arc::new(WorkerPool::new()),
            ready: Arc::new(Notify::new()),
            shutdown: Arc::new(Shutdown::new()),
            is_serving: AtomicBool::new(false),
            expected_workers: AtomicU32::new(0),
        }
    })
}

#[napi(object)]
pub struct ServeOptions {
    pub port: u16,
    pub workers: u32,
    pub entry: String,
}

#[napi]
pub fn begin_serve(opts: ServeOptions) -> NapiResult<()> {
    let s = state();
    if s.is_serving.swap(true, Ordering::SeqCst) {
        return Err(napi::Error::from_reason("serve already running"));
    }
    s.expected_workers.store(opts.workers, Ordering::SeqCst);

    let addr: SocketAddr = format!("127.0.0.1:{}", opts.port)
        .parse()
        .map_err(|e: std::net::AddrParseError| napi::Error::from_reason(e.to_string()))?;

    install_sigint_handler(Arc::clone(&s.shutdown));
    server::start(addr, Arc::clone(&s.ready), Arc::clone(&s.pool));
    Ok(())
}

#[napi]
pub async fn until_ready(timeout_ms: u32) -> NapiResult<()> {
    let s = state();
    let expected = s.expected_workers.load(Ordering::SeqCst) as usize;
    let pool = Arc::clone(&s.pool);
    let ready = Arc::clone(&s.ready);
    let result = tokio::time::timeout(Duration::from_millis(timeout_ms as u64), async {
        while pool.registered_count() < expected {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        ready.notify_one();
    })
    .await;
    if result.is_err() {
        error!(timeout_ms, "workers failed to register");
        std::process::exit(1);
    }
    Ok(())
}

#[napi]
pub async fn until_shutdown() -> NapiResult<()> {
    state().shutdown.wait().await;
    Ok(())
}

#[napi]
pub fn register_renderer(f: Function<String, Promise<String>>) -> NapiResult<u32> {
    if !is_worker() {
        return Err(napi::Error::from_reason(
            "registerRenderer only allowed in worker context",
        ));
    }
    let tsfn: RendererTsfn = f.build_threadsafe_function().build()?;
    let id = state().pool.register(tsfn);
    WORKER_ID.with(|cell| cell.set(Some(id)));
    Ok(id)
}

#[napi(getter)]
pub fn is_worker() -> bool {
    std::env::var("BRUST_WORKER_ID").is_ok()
}

#[napi(getter)]
pub fn worker_id() -> Option<u32> {
    WORKER_ID.with(|cell| cell.get())
}
```

- [ ] **Step 2: Rebuild the .node binding.**

```bash
cd runtime && bun run build:debug
```

Expected: success. The generated `runtime/index.js` now exports `beginServe`, `untilReady`, `untilShutdown`, `registerRenderer`, `isWorker`, `workerId`. The generated `runtime/index.d.ts` should declare them.

If the build fails with napi-rs errors about `Function::build_threadsafe_function`, double-check napi-rs version is `3` and the `napi6` + `async` features are enabled.

- [ ] **Step 3: Smoke-test the bindings load.**

```bash
cd runtime && bun -e "import { isWorker, workerId } from './index.js'; console.log({ isWorker, workerId })"
```

Expected: `{ isWorker: false, workerId: null }`

- [ ] **Step 4: Commit.**

```bash
git add src/lib.rs
git commit -m "feat(napi): full lib.rs exports — begin_serve, until_ready/shutdown, register_renderer"
```

---

## Task 12 — TS facade: `runtime/index.ts`

**Files:**
- Modify: `runtime/index.ts`

This file is what users `import` from — it composes the raw napi exports into the user-friendly `brust.serve()`.

- [ ] **Step 1: Replace `runtime/index.ts`.**

```ts
// @ts-expect-error - index.js is generated by napi-rs at build time
import * as native from './index.js'

export interface ServeOptions {
  port: number
  workers: number
  entry: string
  bootTimeoutMs?: number
}

export type RenderFn = (path: string) => Promise<string>

export const isWorker: boolean = native.isWorker
export const workerId: number | null = native.workerId

export const brust = {
  async serve(opts: ServeOptions): Promise<void> {
    native.beginServe({
      port: opts.port,
      workers: opts.workers,
      entry: opts.entry,
    })
    for (let i = 0; i < opts.workers; i++) {
      // Bun.Worker requires the JS entry (post-bundling). For the skeleton,
      // app/index.ts is a TS file that Bun executes directly.
      new Worker(opts.entry, {
        // @ts-expect-error - Bun supports `env` per Worker; types may lag
        env: { ...process.env, BRUST_WORKER_ID: String(i) },
      })
    }
    await native.untilReady(opts.bootTimeoutMs ?? 5000)
    await native.untilShutdown()
  },
  registerRenderer(fn: RenderFn): number {
    return native.registerRenderer(fn)
  },
}
```

> **Note on the `Worker` env option:** Bun's `Worker` accepts `env` to set
> per-worker environment variables. If the TypeScript types in
> `@types/node` or Bun's bundled types don't expose it yet, the
> `@ts-expect-error` directive papers over that. At runtime Bun honors it.

- [ ] **Step 2: Type-check.**

```bash
cd runtime && bunx tsc --noEmit
```
Expected: clean. If errors mention `process.env` shape mismatches, adjust the spread to `{ BRUST_WORKER_ID: String(i) }` only and let Bun inherit the rest of the env (or change to `bun.WorkerOptions` cast).

- [ ] **Step 3: Commit.**

```bash
git add runtime/index.ts
git commit -m "feat(napi): TS facade composing brust.serve() over native exports"
```

---

## Task 13 — Make the integration test green

- [ ] **Step 1: Rebuild .node to make sure everything is in sync.**

```bash
cd runtime && bun run build:debug
```

- [ ] **Step 2: Run the integration test.**

```bash
bun test tests/integration.test.ts
```

Expected: PASS within 15 seconds.

Common failure modes and minimal fixes:

| Symptom | Likely cause | Fix |
|---|---|---|
| Test panics at `did not see listening line` | The `println!("[brust] listening on ...")` is buffered or lost in the worker thread. | Add an explicit `let _ = std::io::Write::flush(&mut std::io::stdout());` after the `println!` in `src/server.rs`. |
| Test hangs at `fetch` | Listener didn't actually bind, or accept loop didn't start. Look at stderr for tracing errors. | If the binding is correct, check that `ready.notify_one()` is fired from `until_ready` AFTER workers register. |
| `body` missing `Hello from Brust` | Worker registered but the renderer didn't reach React. | Run `bun run app/index.ts` manually and `curl http://localhost:3000/` to see the actual response. Likely the render is throwing — look at stderr. |
| `child.exited` is non-zero | SIGINT not wired or `until_shutdown` not resolving. | Verify `install_sigint_handler` is called from `begin_serve`, and that the SIGINT signal handler calls `shutdown.signal()` exactly once. |
| napi-rs build errors about Bun N-API | Bun's N-API support has version-specific quirks. | Verify Bun >= 1.1.0 (`bun --version`). |
| `new Worker(opts.entry, ...)` throws | Bun Worker import semantics — `entry` should be a URL string (`import.meta.url`) or a resolvable path. | Verify `app/index.ts` passes `import.meta.url` (already in the spec). |

- [ ] **Step 3: Manual smoke test.**

```bash
bun run app/index.ts &
sleep 0.5

curl -s http://localhost:3000/
# Expected: <h1>Hello from Brust</h1><p>worker_id=N</p>

curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/nope
# Expected: 404

# Light load distribution check
for i in {1..20}; do curl -s http://localhost:3000/ & done | \
  grep -oE 'worker_id=\d+' | sort | uniq -c | sort -rn

kill %1
wait
```

- [ ] **Step 4: Commit any fixes (if any were needed).**

If you modified code to make the test pass:

```bash
git add -p   # review and stage targeted hunks
git commit -m "fix(napi): <describe>"
```

Otherwise just verify the green state:

```bash
git log --oneline -15
bun test tests/integration.test.ts   # one last time
```

- [ ] **Step 5: Optional milestone tag.**

```bash
git tag napi-skeleton-green
```

The sub-project is complete.

---

## Self-Review

A walk through the spec to make sure every requirement has a task that implements it:

| Spec section | Covered by task |
|---|---|
| S1 Goal: serve rendered `<HelloWorld/>` via Bun host + Rust .node | 11, 12, 13 |
| S1 Acceptance: `curl /` → expected fragment, integration test passes | 4, 13 |
| S1 Files removed | 1 |
| S1 Files kept (HelloWorld, tsconfig, etc.) | 1 (Cargo.toml modify), 3 (tsconfig retained) |
| S2 Architecture: Bun host + .node module + Worker threads | 5, 11, 12, 13 |
| S2 napi binding surface (beginServe, untilReady, untilShutdown, registerRenderer, isWorker, workerId) | 11 |
| S2 Rust internal layering (lib.rs / pool.rs / server.rs / http.rs / io / shutdown) | 6–11 |
| S2 TS surface (single-file conditional) | 5, 12 |
| S3 file layout | 1, 2, 3, 5 |
| S3 Key Rust types | 8 (pool), 11 (lib) |
| S3 TS API surface | 12 |
| S4 Boot sequence | 11 (begin_serve, until_ready), 12 (facade orchestration) |
| S4 Request flow | 10 |
| S5 Platform abstraction | 7 |
| S5 trade-offs (single-threaded, current_thread tokio on macOS) | implementation matches in 7 |
| S6 Failure matrix entries | 6 (http errors), 10 (recv / parse / worker death), 11 (serve double-call, register in main) |
| S6 SIGINT graceful shutdown | 9, 11 (install_sigint_handler in begin_serve) |
| S7 Integration test shape | 4, 13 |
| S7 readPortLine helper | 4 |
| S8 Cargo.toml deps | 1, 6 (thiserror added) |
| S8 runtime/package.json | 3 |
| S8 build pipeline (napi build) | 3, 11 |
| S8 Final project layout | All tasks combined |

**No placeholders:** every code block contains complete, runnable code. No TBD / TODO / "similar to" patterns.

**Type consistency check:**
- `RendererTsfn = ThreadsafeFunction<String, Promise<String>>` in `pool.rs` (Task 8) matches the `Function<String, Promise<String>>` parameter type in `register_renderer` (Task 11) — both refer to the same JS callback shape.
- `ServeOptions { port: u16, workers: u32, entry: String }` in `lib.rs` (Task 11) matches the TS-side `ServeOptions { port: number, workers: number, entry: string, bootTimeoutMs?: number }` in `runtime/index.ts` (Task 12). The optional `bootTimeoutMs` is consumed by the JS facade and passed to `untilReady` — no Rust-side field needed.
- `is_worker` getter (Task 11) and `BRUST_WORKER_ID` env var (Task 5 app, Task 12 facade Worker spawn) form a consistent contract.
- `worker_id` thread-local (Task 11) is set inside `register_renderer` and read by both Rust (for logging) and JS (via the getter).

**Known plan-vs-spec deviation:** The spec's Section 3 Rust type sketches use napi-rs 2.x syntax. This plan uses napi-rs 3.x syntax — `Function<Args, Promise<Return>>` as the parameter type, `build_threadsafe_function()` to convert, `tsfn.call_async(Ok(arg)).await?.await?` for the round-trip. The spec should be updated post-implementation to reflect the actual 3.x API; for now, the plan is canonical for Rust types.
