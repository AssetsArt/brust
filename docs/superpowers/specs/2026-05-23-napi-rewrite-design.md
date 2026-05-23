# Brust NAPI Rewrite — Design Spec

**Sub-project:** `napi-skeleton` (sub-project 2 of Brust — replaces sub-project 1's pingora skeleton)
**Date:** 2026-05-23
**Status:** approved for implementation planning
**Parent design:** `/design.md` (will need a follow-up pass to reflect NAPI direction)
**Predecessor (historical):** `docs/superpowers/specs/2026-05-23-skeleton-design.md`

---

## 1. Overview & Scope

### Goal

Re-prove the architectural intent of `design.md` (Rust handles HTTP + I/O,
Bun renders React) using the **inverted control model** — Bun is the host
process, Rust is loaded as a `.node` native module via napi-rs (pattern
borrowed from [encoredev/encore/runtimes/js](https://github.com/encoredev/encore/tree/main/runtimes/js)).
Replaces the pingora-subprocess skeleton on `main`.

### Success criterion

> Running `bun run app/index.ts` followed by `curl http://localhost:3000/`
> returns HTML rendered from `<HelloWorld/>` via one of N Bun Worker threads,
> with Rust accepting the connection through tokio-uring (Linux) or tokio
> (macOS dev).

### Concrete acceptance

```bash
$ bun run app/index.ts &
[brust] main: spawning 8 worker threads
[brust] worker 0 registered
...
[brust] all workers registered
[brust] listening on 127.0.0.1:3000 (io: tokio-uring)    # linux
[brust] listening on 127.0.0.1:3000 (io: tokio)          # macos

$ curl -s http://localhost:3000/
<h1>Hello from Brust</h1><p>worker_id=3</p>

$ bun test tests/integration.test.ts
✓ serves rendered html via worker pool (1.4s)
```

The skeleton returns the raw rendered React fragment as the HTTP body — no
`<!doctype>` wrapper. The `build_document` wrapper is deferred.

### In scope

- napi-rs Rust crate compiled to `.node` (loadable by Bun via the napi-build shim)
- Single Bun OS process; N Bun Worker threads (default `navigator.hardwareConcurrency`)
- HTTP/1.1 server hand-rolled via `httparse`, with cfg-split I/O:
  - **Linux:** `tokio-uring`
  - **macOS dev:** `tokio` (single-threaded current-thread runtime)
- JS surface: `brust.serve()`, `brust.registerRenderer()`, `brust.isWorker`, `brust.workerId`
- 1 route hardcoded inline in `app/index.ts` (no router crate)
- Least-busy worker selection via atomic in-flight counter per registered ThreadsafeFunction
- Render via napi-rs ThreadsafeFunction → async Promise resolved with HTML string
- 1 integration test via Bun's built-in test runner
- Replaces the existing pingora-based skeleton on `main` (clean slate)

### Out of scope (deferred to later sub-projects)

- Cache, multi-route, radix tree, params, islands, navigation
- Single-binary embed (`bun build --compile` + .node bundling)
- Shared memory between Rust and JS (string returns are fine for skeleton)
- Health checks, worker respawn, graceful reload
- HTTP/2, TLS, keep-alive tuning (skeleton: `Connection: close`)
- Streaming response (`renderToPipeableStream`)
- Benchmark harness vs Astro / Bun.serve
- Linux musl variant, multi-arch CI matrix

### Files removed from the existing pingora skeleton

```
src/main.rs, src/boot.rs, src/config.rs, src/ipc.rs,
src/listener.rs, src/pool.rs, src/proxy.rs, src/router.rs, src/worker.rs
runtime/worker.ts, runtime/framer.ts, runtime/queue.ts, runtime/pages.ts
tests/integration.rs
Cargo.toml deps: pingora-core, async-trait, bytes, http (re-added as napi-rs deps later)
```

### Files kept

```
design.md                                                   (architectural overview)
docs/superpowers/specs/2026-05-23-skeleton-design.md        (historical)
docs/superpowers/plans/2026-05-23-skeleton.md               (historical)
runtime/components/HelloWorld.tsx                           (unchanged React component)
runtime/tsconfig.json                                       (small adjustments expected)
runtime/.gitignore
```

### Effort estimate

~600 LOC Rust + ~80 LOC TypeScript, ~4–5 days (napi-rs setup +
cfg-split HTTP impl + Bun Worker integration + integration test).

---

## 2. Architecture (high-level)

```
┌──────────────────────────────────────────────────────────────────────┐
│ Bun process (1 OS process, multiple JS isolates)                     │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ Main isolate (app/index.ts, isWorker=false)                 │    │
│  │   import { brust } from 'brust-runtime'                     │    │
│  │   await brust.serve({ port, workers: 8, entry })            │    │
│  └──────────────────────┬──────────────────────────────────────┘    │
│                         │ napi calls                                 │
│  ┌──────────────────────▼──────────────────────────────────────┐    │
│  │ brust.{platform}.node (Rust, loaded once per isolate)       │    │
│  │   - serve(): spawn tokio runtime in BG thread, bind TCP     │    │
│  │   - registerRenderer(): store ThreadsafeFunction in pool    │    │
│  │   - State: WorkerPool { Vec<Arc<TsfnEntry>> }               │    │
│  └─────────────────────────────────────────────────────────────┘    │
│           │                                                          │
│           │ spawned via JS-side new Worker(entry, { env })           │
│           ▼                                                          │
│  ┌─────────────────┐  ┌─────────────────┐    ┌─────────────────┐    │
│  │ Worker 0        │  │ Worker 1        │... │ Worker 7        │    │
│  │ isWorker=true   │  │                 │    │                 │    │
│  │ brust.register- │  │ brust.register- │    │ brust.register- │    │
│  │   Renderer(fn0) │  │   Renderer(fn1) │    │   Renderer(fn7) │    │
│  │ renderToString  │  │ renderToString  │    │ renderToString  │    │
│  └────────▲────────┘  └────────▲────────┘    └────────▲────────┘    │
│           │                    │                       │             │
│           └──────────┬─────────┴───────────────────────┘             │
│                      │ tsfn calls (cross-isolate)                    │
│                      │                                               │
│  ┌───────────────────▼──────────────────────────────────────────┐    │
│  │ Rust I/O thread (background, owns runtime)                   │    │
│  │   Linux: tokio-uring runtime                                 │    │
│  │   macOS: tokio runtime (current-thread)                      │    │
│  │                                                              │    │
│  │   accept loop:                                               │    │
│  │     read request (httparse)                                  │    │
│  │     pool.pick_least_busy() → Arc<TsfnEntry>                  │    │
│  │     html = entry.tsfn.call_async(path).await                 │    │
│  │     write HTTP response                                      │    │
│  └──────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
                         │
                         ▼
                    TCP :3000
```

### napi-rs binding surface (Rust ↔ JS)

| Symbol | Direction | Notes |
|---|---|---|
| `brust.serve(opts)` → `Promise<void>` | JS → Rust | Main isolate only. Resolves on shutdown signal (SIGINT). |
| `brust.registerRenderer(fn)` → `void` | JS → Rust | Worker isolate only. Stores `fn` as a ThreadsafeFunction. |
| `brust.isWorker` (getter) | Rust → JS | Reads `BRUST_WORKER_ID` env var. |
| `brust.workerId` (getter) | Rust → JS | Returns the id assigned at register time, or `null` in main. |

### Rust internal layering

```
┌─────────────────────────────────────────────┐
│ lib.rs           napi-rs exports + glue     │
├─────────────────────────────────────────────┤
│ pool.rs          WorkerPool, TsfnEntry,     │
│                  pick_least_busy            │
├─────────────────────────────────────────────┤
│ server.rs        HTTP accept loop +         │
│                  per-conn dispatch          │
├─────────────────────────────────────────────┤
│ http.rs          httparse Request, build    │
│                  Response bytes             │
├─────────────────────────────────────────────┤
│ io_linux.rs      cfg(target_os="linux")     │
│                  tokio-uring TcpListener    │
│ io_other.rs      cfg(not(linux))            │
│                  tokio TcpListener          │
└─────────────────────────────────────────────┘
```

### Why this shape works

- The accept loop runs on a **background tokio thread** started by `serve()`,
  not on Bun's JS main loop — so JS isn't blocked.
- ThreadsafeFunction calls cross isolate boundaries safely; napi-rs handles
  marshalling.
- `pick_least_busy` mirrors the original skeleton's atomic-counter pattern,
  but selects between tsfn entries instead of Unix-socket workers.
- Main isolate `await brust.serve(...)` resolves only on SIGINT, keeping
  the Bun process alive while the Rust runtime serves requests.

---

## 3. Components

### Rust crate (compiled to `.node` via napi-rs)

```
brust/
├── Cargo.toml                  napi-rs metadata, [lib] crate-type=["cdylib"]
├── package.json                napi-rs build config (binary naming, target list)
├── build.rs                    napi-build helper (codegen for .node + index.js shim)
└── src/
    ├── lib.rs                  napi-rs exports: serve(), registerRenderer(),
    │                           isWorker getter, workerId getter. Module-level
    │                           OnceCell for global state.
    ├── pool.rs                 WorkerPool { entries: parking_lot::RwLock<Vec<Arc<TsfnEntry>>> }
    │                           TsfnEntry { id, tsfn, in_flight: AtomicU32 }
    │                           pick_least_busy() → Option<Arc<TsfnEntry>>
    │                           register(tsfn) → worker_id
    ├── server.rs               start(addr, ready, pool) → spawns BG runtime,
    │                           binds TCP, accept loop with read→dispatch→write
    ├── http.rs                 parse_request(&[u8]) → Request { method, path, headers }
    │                           build_response(status, content_type, body) → Vec<u8>
    │                           error_400 / error_404 / error_405 / error_503 helpers
    ├── shutdown.rs             ShutdownSignal { Notify } wired to a napi-rs
    │                           Promise; SIGINT triggers notify and resolves the
    │                           awaited promise in main isolate.
    └── io/
        ├── mod.rs              pub use platform::*; (cfg-gated re-export)
        ├── linux.rs            cfg(target_os = "linux") — tokio-uring runtime,
        │                       TcpListener, TcpStream impl HttpStream
        └── other.rs            cfg(not(target_os = "linux")) — tokio runtime,
                                TcpListener, TcpStream impl HttpStream
```

### TS-side runtime package

```
brust/runtime/
├── package.json                deps: react, react-dom; devDeps: @napi-rs/cli,
│                               typescript, type packages
├── tsconfig.json
├── index.ts                    TS facade: re-exports brust.node + types
├── index.js                    (generated by napi-rs) loader shim
├── brust.{linux-x64-gnu,darwin-arm64,...}.node    napi outputs (gitignored)
└── components/
    └── HelloWorld.tsx          (unchanged) <h1>Hello from Brust</h1>
                                <p>worker_id={N}</p>
```

### User app

```
brust/app/
└── index.ts                    single-file conditional: isWorker → register;
                                main → serve. Hardcoded route '/'.
```

### Tests

```
tests/
└── integration.test.ts         bun test: spawn `bun run app/index.ts`,
                                fetch /, assert body, SIGINT, assert exit 0
```

### Key Rust types

```rust
// pool.rs
pub struct TsfnEntry {
    pub id: u32,
    pub tsfn: ThreadsafeFunction<String, ErrorStrategy::Fatal>,
    pub in_flight: AtomicU32,
}

pub struct WorkerPool {
    pub entries: parking_lot::RwLock<Vec<Arc<TsfnEntry>>>,
}

impl WorkerPool {
    pub fn register(&self, tsfn: ThreadsafeFunction<String, ErrorStrategy::Fatal>) -> u32;
    pub fn pick_least_busy(&self) -> Option<Arc<TsfnEntry>>;
    pub fn registered_count(&self) -> usize;
    pub fn remove(&self, id: u32);
}

pub struct InFlightGuard<'a>(&'a AtomicU32);   // -- on Drop

// lib.rs — Rust-side napi exports (JS-side facade composes them into brust.serve())
#[napi]
pub fn begin_serve(opts: ServeOptions) -> napi::Result<()>;       // bind TCP, start BG I/O thread, return

#[napi]
pub async fn until_ready(timeout_ms: u32) -> napi::Result<()>;   // resolves when all N workers registered

#[napi]
pub async fn until_shutdown() -> napi::Result<()>;               // resolves on SIGINT

#[napi]
pub fn register_renderer(env: Env, f: JsFunction) -> napi::Result<u32>;

#[napi(getter)]
pub fn is_worker() -> bool;

#[napi(getter)]
pub fn worker_id() -> Option<u32>;
```

### TS API surface

```ts
// from 'brust-runtime'
export const isWorker: boolean;
export const workerId: number | null;
export const brust: {
  serve(opts: { port: number; workers: number; entry: string }): Promise<void>;
  registerRenderer(fn: (path: string) => Promise<string> | string): void;
};
```

---

## 4. Data Flow

### Boot sequence

```
T+0    Bun starts `bun run app/index.ts` (main isolate)

T+0    main isolate:
         - imports 'brust-runtime' → loads brust.{platform}.node
         - napi-rs runs once-per-process Rust init
         - isWorker = false (no BRUST_WORKER_ID env)
         - main path: await brust.serve({ port, workers: 8, entry })
           (JS facade composes: beginServe + spawn workers + untilReady + untilShutdown)

T+1ms  Inside serve() (JS facade → Rust + JS):
         - JS facade calls Rust beginServe(opts):
             - validate opts (port valid, workers > 0)
             - start tokio (or tokio-uring) runtime on a BG thread
             - bind TCP listener
             - gate the accept loop on a Notify
             - return Promise (resolved after gate set up)
         - JS facade then spawns N Bun Workers:
             for (let i = 0; i < opts.workers; i++) {
               new Worker(opts.entry, { env: { BRUST_WORKER_ID: String(i) } });
             }
         - JS facade awaits Rust's untilShutdown() Promise

T+10ms each worker isolate (parallel):
         - executes the same index.ts; isWorker = true
         - calls brust.registerRenderer(asyncFn)
         - register_renderer wraps asyncFn as ThreadsafeFunction,
           stores in pool, sets thread-local worker_id
         - worker remains alive holding the tsfn

T+~20ms when pool.registered_count() == opts.workers:
         - Rust fires the accept-loop Notify
         - accept loop starts accepting on TCP listener
         - println("[brust] listening on 127.0.0.1:3000 (io: ...)")
```

### Worker spawn detail

Bun Worker spawn (`new Worker(url)`) is a JS-only API; Rust can't invoke
it directly. The JS facade in `runtime/index.ts` orchestrates:

```ts
export async function serve(opts) {
  native.beginServe(opts);                            // sync — bind listener, gate accept
  for (let i = 0; i < opts.workers; i++) {
    new Worker(opts.entry, { env: { BRUST_WORKER_ID: String(i) } });
  }
  await native.untilReady(opts.bootTimeoutMs ?? 5000); // resolves when all workers registered
  await native.untilShutdown();                       // resolves on SIGINT
}
```

This keeps the napi-rs surface clean (no need to call into JS globals from
Rust) and avoids the worker-spawn-from-Rust complexity.

### Request flow

```
1. accept() yields a TcpStream (tokio-uring or tokio)
2. crate::io::spawn a task per connection
3. task body:
     a. read raw bytes until \r\n\r\n (or 16 KB cap)
     b. httparse::Request::parse(&buf)
     c. method != GET → 405, drop conn
     d. pool.pick_least_busy() → Arc<TsfnEntry>
     e. let _guard = entry.in_flight_guard()
     f. html = entry.tsfn.call_async(path).await
            (tsfn marshals path to the worker's JS isolate,
             worker runs renderToString, returns String)
     g. response_bytes = http::build_response(200, "text/html", html.into_bytes())
     h. stream.write_all(response_bytes).await
     i. stream.shutdown().await                 // Connection: close semantics
4. drop guard → in_flight decremented
```

### Sequence (one request)

```
client    Rust(BG thread)     Pool      Worker 3 isolate    React
  │              │              │              │              │
  │── GET ──────►│              │              │              │
  │              │── pick ─────►│              │              │
  │              │◄── w3 ───────│              │              │
  │              │── tsfn.call_async("/") ───►│              │
  │              │              │              │── render ──►│
  │              │              │              │◄── html ────│
  │              │◄────────── html string ─────│              │
  │◄── 200 ──────│              │              │              │
```

---

## 5. Platform Abstraction

The HTTP server core (`server.rs`) is platform-agnostic — written against
a thin abstraction that `io/linux.rs` and `io/other.rs` both implement.
Compile-time `cfg` switches which module is in scope.

### Abstraction surface (`io/mod.rs`)

```rust
#[cfg(target_os = "linux")]
pub use self::linux::{run_io, spawn, TcpListener, TcpStream, IO_NAME};

#[cfg(not(target_os = "linux"))]
pub use self::other::{run_io, spawn, TcpListener, TcpStream, IO_NAME};

#[cfg(target_os = "linux")] mod linux;
#[cfg(not(target_os = "linux"))] mod other;

pub trait HttpStream: Send + 'static {
    async fn read_request(&mut self, buf: &mut Vec<u8>) -> std::io::Result<usize>;
    async fn write_all(&mut self, bytes: Vec<u8>) -> std::io::Result<()>;
    async fn shutdown(&mut self) -> std::io::Result<()>;
}
```

`IO_NAME` is logged at startup so users see which path is active
(`"tokio-uring"` or `"tokio"`).

### Linux impl (`io/linux.rs`)

```rust
// cfg(target_os = "linux")
pub const IO_NAME: &str = "tokio-uring";

pub fn run_io<F, Fut>(f: F)
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()>,
{
    std::thread::spawn(move || {
        tokio_uring::start(async move { f().await });
    });
}

pub fn spawn<F: std::future::Future<Output = ()> + 'static>(f: F) {
    tokio_uring::spawn(f);
}

pub struct TcpListener(tokio_uring::net::TcpListener);
pub struct TcpStream(tokio_uring::net::TcpStream);

impl TcpListener {
    pub async fn bind(addr: SocketAddr) -> std::io::Result<Self> {
        Ok(Self(tokio_uring::net::TcpListener::bind(addr)?))
    }
    pub async fn accept(&self) -> std::io::Result<(TcpStream, SocketAddr)> {
        let (s, addr) = self.0.accept().await?;
        Ok((TcpStream(s), addr))
    }
}

impl HttpStream for TcpStream {
    async fn read_request(&mut self, buf: &mut Vec<u8>) -> std::io::Result<usize> {
        let owned = std::mem::take(buf);
        let (res, returned) = self.0.read(owned).await;
        *buf = returned;
        res
    }
    async fn write_all(&mut self, bytes: Vec<u8>) -> std::io::Result<()> {
        let (res, _) = self.0.write_all(bytes).await;
        res
    }
    async fn shutdown(&mut self) -> std::io::Result<()> {
        self.0.shutdown(std::net::Shutdown::Both)
    }
}
```

### macOS dev impl (`io/other.rs`)

```rust
// cfg(not(target_os = "linux"))
pub const IO_NAME: &str = "tokio";

pub fn run_io<F, Fut>(f: F)
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send,
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

pub fn spawn<F: std::future::Future<Output = ()> + Send + 'static>(f: F) {
    tokio::spawn(f);
}

pub struct TcpListener(tokio::net::TcpListener);
pub struct TcpStream(tokio::net::TcpStream);

impl TcpListener {
    pub async fn bind(addr: SocketAddr) -> std::io::Result<Self> {
        Ok(Self(tokio::net::TcpListener::bind(addr).await?))
    }
    pub async fn accept(&self) -> std::io::Result<(TcpStream, SocketAddr)> {
        let (s, addr) = self.0.accept().await?;
        Ok((TcpStream(s), addr))
    }
}

impl HttpStream for TcpStream {
    async fn read_request(&mut self, buf: &mut Vec<u8>) -> std::io::Result<usize> {
        use tokio::io::AsyncReadExt;
        let mut tmp = [0u8; 4096];
        let n = self.0.read(&mut tmp).await?;
        buf.extend_from_slice(&tmp[..n]);
        Ok(n)
    }
    async fn write_all(&mut self, bytes: Vec<u8>) -> std::io::Result<()> {
        use tokio::io::AsyncWriteExt;
        self.0.write_all(&bytes).await
    }
    async fn shutdown(&mut self) -> std::io::Result<()> {
        use tokio::io::AsyncWriteExt;
        self.0.shutdown().await
    }
}
```

### server.rs (platform-agnostic)

```rust
use crate::io::{run_io, spawn, TcpListener, HttpStream, IO_NAME};

pub fn start(addr: SocketAddr, ready: Arc<Notify>, pool: Arc<WorkerPool>) {
    run_io(move || async move {
        let listener = TcpListener::bind(addr).await.expect("bind");
        ready.notified().await;          // wait until all workers registered
        println!("[brust] listening on {addr} (io: {IO_NAME})");
        loop {
            let (stream, _peer) = listener.accept().await.expect("accept");
            let pool = pool.clone();
            spawn(async move { handle_conn(stream, pool).await });
        }
    });
}
```

### Trade-offs / known asymmetries

- **tokio-uring is single-threaded.** All connections served by one core.
  Skeleton-acceptable; render parallelism lives in JS Worker isolates.
- **macOS impl uses `current_thread()`** to match the single-threaded shape
  of tokio-uring. Production may want multi-threaded later — cfg-split lets
  us upgrade Linux independently.
- **`spawn` abstraction:** different join semantics across runtimes; we
  intentionally don't expose `JoinHandle` — the accept loop is fire-and-forget.
- **`httparse` is cross-platform** and doesn't care about the I/O — same parser
  on both platforms.

---

## 6. Error Handling

**Same fail-loud philosophy as the original skeleton.** No retry, no respawn,
no graceful degradation.

### Failure matrix

| Failure | Where caught | Action |
|---|---|---|
| `brust.serve()` called twice | lib.rs serve() | throw `Error("serve already running")` |
| `registerRenderer()` in main isolate | lib.rs register_renderer | throw `Error("registerRenderer only allowed in worker context")` |
| Workers fail to register within 5 s | serve() timeout | log error + `std::process::exit(1)` |
| Worker render throws | tsfn.call_async result | log "render error worker {id}", HTTP 500 with sanitized message |
| HTTP parse error (malformed) | server.rs handle_conn | respond 400, drop connection |
| Request URI > 16 KB | read loop cap | respond 414, drop |
| TCP `accept()` error | server.rs accept loop | log + `exit 1` (listener dead = fatal) |
| TCP read/write mid-response | handle_conn | log, drop, continue accepting |
| Worker tsfn becomes invalid | call_async ChannelClosed | log "worker {id} died", remove from pool; if empty pool → `exit 1` |
| SIGINT | shutdown handler | resolve `untilShutdown` promise; Bun exits cleanly |
| napi-rs panic during init | lib.rs init | panic propagates → Bun aborts (no recovery) |
| Platform mismatch (wrong .node) | napi-rs loader (index.js) | clear error from the napi-build shim |

### Rust serve / until_ready / until_shutdown shapes

```rust
#[napi]
pub fn begin_serve(opts: ServeOptions) -> napi::Result<()> {
    let state = GLOBAL_STATE.get().expect("init");
    if state.is_serving.swap(true, Ordering::SeqCst) {
        return Err(napi::Error::from_reason("serve already running"));
    }
    state.expected_workers.store(opts.workers as u32, Ordering::SeqCst);
    let pool = Arc::clone(&state.pool);
    let ready = Arc::clone(&state.ready_notify);
    server::start(opts.into_addr()?, ready, pool);
    Ok(())
}

#[napi]
pub async fn until_ready(timeout_ms: u32) -> napi::Result<()> {
    let state = GLOBAL_STATE.get().expect("init");
    let expected = state.expected_workers.load(Ordering::SeqCst) as usize;
    let pool = Arc::clone(&state.pool);
    let ready = Arc::clone(&state.ready_notify);
    let result = tokio::time::timeout(Duration::from_millis(timeout_ms as u64), async {
        while pool.registered_count() < expected {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        ready.notify_one();    // unblock the accept loop
    }).await;
    if result.is_err() {
        tracing::error!("workers failed to register in {timeout_ms}ms");
        std::process::exit(1);
    }
    Ok(())
}

#[napi]
pub async fn until_shutdown() -> napi::Result<()> {
    let state = GLOBAL_STATE.get().expect("init");
    state.shutdown_notify.notified().await;
    Ok(())
}
```

The JS-side facade composes these into the user-facing `brust.serve()`:

```ts
// runtime/index.ts (JS facade)
export const brust = {
  async serve(opts) {
    native.beginServe(opts);                          // sync — binds listener, starts BG thread
    for (let i = 0; i < opts.workers; i++) {
      new Worker(opts.entry, { env: { BRUST_WORKER_ID: String(i) } });
    }
    await native.untilReady(opts.bootTimeoutMs ?? 5000);
    await native.untilShutdown();
  },
  registerRenderer: native.registerRenderer,
};
```

### Rust `register_renderer()` shape

```rust
#[napi]
pub fn register_renderer(env: Env, f: JsFunction) -> napi::Result<u32> {
    if !is_worker_context() {
        return Err(napi::Error::from_reason(
            "registerRenderer only allowed in worker context"
        ));
    }
    let tsfn = env.create_threadsafe_function(&f, /* config */)?;
    let state = GLOBAL_STATE.get().expect("init");
    let id = state.pool.register(tsfn);
    WORKER_ID.with(|cell| cell.set(Some(id)));
    Ok(id)
}
```

### Render error path

```rust
async fn handle_conn<S: HttpStream>(mut s: S, pool: Arc<WorkerPool>) {
    let mut buf = Vec::with_capacity(4096);
    if let Err(e) = read_full_request(&mut s, &mut buf).await {
        tracing::warn!(error = %e, "read failed");
        let _ = s.write_all(http::error_400()).await;
        return;
    }

    let (method, path) = match http::parse_request(&buf) {
        Ok(r) => (r.method, r.path.to_owned()),
        Err(_) => { let _ = s.write_all(http::error_400()).await; return; }
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

    match entry.tsfn.call_async::<String>(path).await {
        Ok(html) => {
            let bytes = http::build_response(200, "text/html; charset=utf-8", html.into_bytes());
            let _ = s.write_all(bytes).await;
        }
        Err(napi_err) => {
            tracing::error!(worker_id = entry.id, error = %napi_err, "render failed");
            let msg = format!("render error: {napi_err}");
            let _ = s.write_all(http::build_response(500, "text/plain", msg.into_bytes())).await;

            if is_tsfn_dead(&napi_err) {
                pool.remove(entry.id);
                if pool.registered_count() == 0 {
                    tracing::error!("all workers died");
                    std::process::exit(1);
                }
            }
        }
    }

    let _ = s.shutdown().await;
}
```

### Logging

- `tracing` crate + `tracing-subscriber` with `EnvFilter`
- Default: `RUST_LOG=brust=info`
- Output: **stderr** (stdout reserved for the `listening on ...` line the
  integration test parses)
- Human-readable format

### Worker-side TS error handling

```ts
brust.registerRenderer(async (path) => {
  try {
    return renderToString(<HelloWorld workerId={String(brust.workerId)} />);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
});
```

The runtime layer does not wrap user errors. If the user's render function
throws, Rust surfaces the napi error to HTTP as a 500 with a sanitized message.

---

## 7. Testing

**One integration test, no unit tests.** Skeleton scope. Tool: Bun's built-in
`bun test` (not `cargo test`).

### tests/integration.test.ts

```ts
import { test, expect } from 'bun:test';
import { spawn } from 'bun';

test('serves rendered html via worker pool', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'app/index.ts'],
    env: { ...process.env, BRUST_PORT: '38123', RUST_LOG: 'brust=info' },
    stdout: 'pipe',
    stderr: 'inherit',
  });

  const port = await readPortLine(proc.stdout);
  const resp = await fetch(`http://127.0.0.1:${port}/`);
  expect(resp.status).toBe(200);

  const body = await resp.text();
  expect(body).toContain('Hello from Brust');
  expect(body).toMatch(/worker_id=\d+/);

  proc.kill('SIGINT');
  const exit = await proc.exited;
  expect(exit).toBe(0);
}, 15_000);

async function readPortLine(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let acc = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error('process closed stdout before listening log');
    acc += decoder.decode(value, { stream: true });
    const m = acc.match(/listening on 127\.0\.0\.1:(\d+)/);
    if (m) {
      reader.releaseLock();
      return parseInt(m[1], 10);
    }
  }
}
```

### What this exercises

- `bun run app/index.ts` actually starts
- napi-rs `.node` loads in main isolate
- `brust.serve()` binds TCP and triggers worker spawn
- N Bun Workers spawn, load `.node`, register tsfns
- HTTP `GET /` round-trips end-to-end: accept → parse → pick worker → call tsfn
  → `renderToString` → return bytes
- Response body contains React-rendered HTML
- SIGINT triggers clean shutdown (exit 0)

### What this does NOT cover

- Concurrent requests / load distribution
- Worker death mid-request (no respawn in skeleton)
- Cross-platform run (skeleton: macOS local only; Linux CI deferred)
- Render error / 500 path
- Race: HTTP request before workers ready (mitigated by accept gate)

### Manual smoke

```bash
bun run app/index.ts
curl -s http://localhost:3000/
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/anything

# Distribute (high-load):
for i in {1..50}; do curl -s http://localhost:3000/ & done | \
  grep -oE 'worker_id=\d+' | sort | uniq -c
```

### CI consideration (deferred)

Matrix: `ubuntu-latest` (tokio-uring) and `macos-latest` (tokio), both running
`bun test`. Not in scope for this sub-project.

---

## 8. Build & Deploy

### Prerequisites

- Rust 1.85+ (edition 2024)
- Bun 1.1+ on `$PATH`
- Linux (production) OR macOS (dev fallback)
- napi-rs CLI via `bun install` (devDep)

### Build pipeline

```
1. cargo build --release      → target/release/libbrust.{so,dylib}
                                (napi-rs sets crate-type = ["cdylib"])
2. napi-rs CLI postprocess     → rename + copy:
                                  runtime/brust.linux-x64-gnu.node     (linux)
                                  runtime/brust.darwin-arm64.node      (macos)
                                + generate runtime/index.js (loader shim)
3. bun run app/index.ts        → loads the platform-matching .node via shim
```

napi-rs's loader shim auto-detects the host platform and throws a clear
error on mismatch.

### Cargo.toml

```toml
[package]
name    = "brust"
version = "0.1.0"
edition = "2024"

[lib]
crate-type = ["cdylib"]

[dependencies]
napi               = { version = "2", default-features = false, features = ["napi6", "async", "tokio_rt"] }
napi-derive        = "2"
httparse           = "1"
parking_lot        = "0.12"
tracing            = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
once_cell          = "1"

[target.'cfg(target_os = "linux")'.dependencies]
tokio-uring = "0.5"

[target.'cfg(not(target_os = "linux"))'.dependencies]
tokio       = { version = "1", features = ["rt", "macros", "net", "io-util", "time", "sync"] }

[build-dependencies]
napi-build = "2"
```

### runtime/package.json

```json
{
  "name": "brust-runtime",
  "type": "module",
  "private": true,
  "main": "index.js",
  "scripts": {
    "build":       "napi build --release --platform",
    "build:debug": "napi build --platform"
  },
  "dependencies": {
    "react":     "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@napi-rs/cli":     "^2.18.0",
    "@types/react":     "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "typescript":       "^5.5.0"
  }
}
```

### Dev loop

```bash
cd runtime && bun install && cd ..
cd runtime && bun run build && cd ..   # rebuild .node after any Rust change
bun run app/index.ts
bun test tests/integration.test.ts
```

### Final project layout

```
brust/
├── Cargo.toml
├── Cargo.lock
├── build.rs                                 napi-build
├── design.md                                (existing, may need a follow-up pass)
├── docs/superpowers/specs/
│   ├── 2026-05-23-skeleton-design.md        (historical — pingora skeleton)
│   └── 2026-05-23-napi-rewrite-design.md    (THIS document)
├── docs/superpowers/plans/
│   └── 2026-05-23-skeleton.md               (historical pingora plan)
├── src/
│   ├── lib.rs
│   ├── pool.rs
│   ├── server.rs
│   ├── http.rs
│   ├── shutdown.rs
│   └── io/
│       ├── mod.rs
│       ├── linux.rs
│       └── other.rs
├── runtime/
│   ├── package.json
│   ├── bun.lock
│   ├── tsconfig.json
│   ├── index.ts                             TS facade + spawn-workers logic
│   ├── index.js                             (generated)
│   ├── brust.{platform-arch}.node           (generated, gitignored)
│   └── components/
│       └── HelloWorld.tsx
├── app/
│   └── index.ts                             skeleton consumer
└── tests/
    └── integration.test.ts
```

### Deferred deploy concerns

- **Single-binary deploy.** `bun build --compile app/index.ts` needs to embed the
  `.node` addon. Defer.
- **Multi-platform CI matrix.** Defer.
- **Docker / glibc-vs-musl variants.** napi-rs supports it via target suffix;
  defer the actual matrix.

### What gets removed from the existing skeleton

```
DELETE:
  src/main.rs, src/boot.rs, src/config.rs, src/ipc.rs,
  src/listener.rs, src/pool.rs, src/proxy.rs, src/router.rs, src/worker.rs
  runtime/worker.ts, runtime/framer.ts, runtime/queue.ts, runtime/pages.ts
  tests/integration.rs

KEEP:
  design.md                                                 (follow-up update later)
  docs/superpowers/specs/2026-05-23-skeleton-design.md      (historical)
  docs/superpowers/plans/2026-05-23-skeleton.md             (historical)
  runtime/components/HelloWorld.tsx
  runtime/package.json                       (deps shift, structure kept)
  runtime/tsconfig.json                      (small adjustments expected)
  runtime/.gitignore
  runtime/bun.lock                           (regenerated from new deps)

MODIFY:
  Cargo.toml                                 (drop pingora et al., add napi-rs + cfg deps)
  Cargo.lock                                 (regenerate)
  .gitignore root                            (add runtime/*.node)
```

---

## Appendix — Decisions log (from brainstorming)

1. **Skeleton lifecycle: A — clean slate on main.** Replace the pingora skeleton; git history preserves the predecessor.
2. **Scope: A — like-for-like skeleton swap.** Same success criterion as sub-project 1 (one route, render `<HelloWorld/>`, integration test passes).
3. **Parallelism: B — single Bun process + Worker API + napi-rs ThreadsafeFunction.** Risk: Bun + N-API + Worker integration is less proven than the subprocess model; fallback to single-process is documented if a blocker appears mid-implementation.
4. **macOS fallback: A — cfg-based dual implementation.** `tokio-uring` on Linux, `tokio` on macOS; both speak the same `HttpStream` trait so `server.rs` is platform-agnostic.
5. **TS API surface: A — single-file conditional.** `if (!isWorker) serve() else registerRenderer()` in one entry file; `import.meta.url` is passed as the spawn entry.
6. **HTTP layer: Shape α — hand-rolled HTTP/1.1 + cfg-gated I/O.** `httparse` for parsing; hand-written response bytes; no hyper.

### Open questions deferred

- Whether tokio-uring's single-threaded executor is the right long-term Linux
  choice, or whether to move to `tokio` with `io_uring` reactor (when stable)
  to enable multi-threaded accept.
- Whether the `.node` addon shape constrains future single-binary embedding
  (likely manageable via `bun build --compile`'s native-module support).
- Whether to keep `parking_lot` over `std::sync` for `WorkerPool` (preference
  for now: `parking_lot` is faster for read-mostly access).
