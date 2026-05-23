# Brust — Architecture

**B**un + **Rust** — SSR framework that bursts.

React on the server. Rust everywhere else. One Bun host process, Rust loaded as
a `.node` native module via napi-rs. Renders dispatched into Bun Worker threads;
HTML returned through per-worker SharedArrayBuffer.

---

## Why Brust

Traditional SSR frameworks make you pay three times:

1. Server renders HTML
2. Client downloads the entire framework bundle
3. Client re-runs everything to "hydrate"

Brust pays once. Server renders, client resumes only when needed.

---

## Hosting model

Bun is the host process. Rust is loaded as a `.node` native module via
napi-rs. The HTTP listener and accept loop are pure Rust; React renders are
dispatched into Bun Worker threads through napi `ThreadsafeFunction`, and
their HTML is returned through per-worker `SharedArrayBuffer`.

| Concern | Source |
|---|---|
| HTTP/1.1 listener | **Brust** (custom tokio / tokio-uring accept loop) |
| Per-thread tokio runtime | `tokio` (current_thread) on macOS, `tokio-uring` on Linux |
| TCP worker pool | **Brust** (pre-spawned async tasks over `flume::bounded` MPMC) |
| Render workers | Bun Worker threads (one V8 isolate per thread) |
| Cross-thread render dispatch | `napi-rs 3.x` `ThreadsafeFunction` |
| Zero-copy render result | per-worker `SharedArrayBuffer`, raw pointer captured at register time |
| Worker selection (least-busy) | **Brust** (~50 LOC over atomic counter per entry) |

---

## Architecture

```
Bun process (one OS process)

  Main thread (TS host)
    brust.serve({ port, workers, entry })
      ├─ napi.beginServe(...)          → spawn Rust accept thread
      ├─ for i in 0..N: new Worker(entry, env=BRUST_WORKER_ID=i)
      └─ await napi.untilReady(timeout)

  Worker threads × N  (= floor(os.availableParallelism() * 1.8))
    Each:
      const sab = new SharedArrayBuffer(256 KB)    # rooted in module scope
      brust.registerRenderer(new Uint8Array(sab), async (path) => {
        const html = renderToString(<App path={path} />)
        return encoder.encodeInto(html, sabView).written
      })

napi-rs cdylib (brust.node) — loaded into the same Bun process

  Accept thread (dedicated OS thread)
    tokio (macOS) or tokio-uring (Linux), current_thread runtime
    TcpListener → flume::bounded::<TcpStream>(1024) → N TCP worker tasks

  TCP worker tasks × N   (async, all on the accept thread; cooperative)
    Each:
      loop {
        let stream = rx.recv_async().await?;
        handle_conn(stream).await;   # keep-alive loop over requests
      }

  handle_conn (per TCP connection)
    loop {
      read_full_request → httparse
      if path == /ping → write static "pong\n", continue
      entry = pool.pick_least_busy()
      entry.tsfn.call_async(path).await   # → Bun Worker
      n = (await rendered promise)         # bytes written into SAB
      body = unsafe slice::from_raw_parts(entry.buf_ptr, n)
      write_all(build_response(200, ..., body))
    }
```

---

## Request lifecycle

```
T0   client connects (TCP)
T1   accept loop:   listener.accept() → flume.send_async(stream)
T2   TCP worker:    rx.recv_async() → handle_conn(stream)
T3   handle_conn:   read_full_request → httparse → method/path
T4   if /ping       → write static response, loop to T3
                                                            (no JS, no napi)
T5   else           → pool.pick_least_busy()   # atomic scan, N entries
                      in_flight_guard.++
T6                  → entry.tsfn.call_async(path).await
                       │
                       └→ Bun Worker thread wakes:
                            renderToString(...)
                            TextEncoder.encodeInto(html, sabView)
                            return written   # u32, bytes
T7   Rust receives  → n = await result
                       body = unsafe slice from entry.buf_ptr, len=n
                       (zero copy across "IPC" — same address space)
T8                  → bytes = build_response(200, "text/html", body)
                       s.write_all(bytes).await
T9                  → loop to T3 on the same TCP connection (keep-alive)
```

---

## IPC: napi ThreadsafeFunction + SharedArrayBuffer

```
                                Bun side                  napi             Rust side
                                ──────────────            ────────         ─────────────────
arg (path)         encode UTF-8 → tsfn queue      → cross-thread     → String (alloc, ~50 B)
render output      renderToString  → SAB write    → -                → raw ptr deref
                   (TextEncoder.encodeInto)         (no marshal)       (slice::from_raw_parts)
signal             return u32 written            → resolve Promise  → await yields u32
```

**Copy count, /  endpoint:**

| Where | Bytes | Notes |
|---|---|---|
| path: V8 → Rust (`String`) | ~50 | unavoidable, tiny |
| html: V8 → SAB (`TextEncoder.encodeInto`) | full body | inside Worker, one pass UTF-8 |
| SAB → response `Vec<u8>` | full body | Rust local memcpy, ~10 GB/s on M1 |
| response `Vec<u8>` → kernel | full body | `write_all` syscall, unavoidable |

`build_response` still allocates one `Vec<u8>` and copies the body into it. The
final response buffer + header could be sent with `writev` to drop that copy; we
have not done it yet (see Roadmap).

---

## SharedArrayBuffer layout

```
Bun Worker (one per V8 isolate)

  module scope                                              (roots the SAB)
    const sab  = new SharedArrayBuffer(256 * 1024)
    const view = new Uint8Array(sab)                        ← passed to Rust once

Rust (at register_renderer):
    let (ptr, len) = unsafe { let s = buf.as_mut(); (s.as_mut_ptr(), s.len()) };
    pool.register(tsfn, BufPtr(ptr), len)
                                                            ← stored alongside tsfn

Render call:
    Worker writes html bytes into sab at offsets [0, written)
    Rust reads body at ptr, len = written
```

**Slot size:** 256 KB per worker. 18 workers on M1 Pro = 4.5 MB total. Comfortably in L2/L3.
**Oversize:** render > 256 KB → Worker returns 0 → Rust responds HTTP 500. No fallback path yet; future option is dynamic resize or socket-style spillover.

**Cross-thread safety:**

The SAB backing store is allocated outside V8's GC heap (V8 puts it in
PartitionAlloc-managed memory). It is process-global and stable for the
worker's lifetime as long as the Worker keeps a JS-side root reference (it
does — `sab` lives in module scope).

Rust only reads the SAB after `tsfn.call_async(..).await` resolves — meaning
the Worker has returned from the render callback. napi's tsfn provides the
happens-before edge. There is no concurrent writer.

The `BufPtr` wrapper in `src/pool.rs` carries an `unsafe impl Send + Sync` with
this exact safety argument documented inline.

---

## Slot ownership invariant

A render worker holds its SAB slot exclusively only if it processes **one
render at a time**. We get this property for free from napi's threadsafe
function: each Worker thread is a single V8 isolate, callbacks dispatched
serially per tsfn handle. Concurrent renders on the same worker are
impossible — the second tsfn call queues behind the first.

Practical consequences:

- **Per-worker concurrency = 1.** Total concurrency = N workers.
  For CPU-bound render this is optimal; adding more concurrent renders on the
  same core only adds scheduler churn and GC pressure.
- **Loader parallelism within one render.** A loader can still do
  `Promise.all([db.a(), db.b()])`. Concurrency *inside* one render is fine.
  Concurrency *across* requests on the same worker is what's serialised.
- **Loader-bound workloads.** If your app spends most of its time awaiting I/O
  rather than rendering, throughput is capped at N in-flight renders. Future
  escape hatch: "N slots per worker" with a slot id in the response framing.
  Not implemented.

---

## HTTP layer

Rust accept loop runs on a dedicated OS thread. Per-platform runtimes:

- **macOS:** `tokio::runtime::Builder::new_current_thread()` + `tokio::net::TcpListener`
- **Linux:** `tokio_uring::start(...)` + `tokio_uring::net::TcpListener`

Both are **single-threaded async** by design. The accept loop and all TCP
worker tasks are cooperatively scheduled on this one thread; there is no
multi-thread tokio runtime.

**Connection dispatch:**

- One `flume::bounded::<TcpStream>(1024)` MPMC channel
- Pre-spawned N TCP worker tasks (= `opts.workers`) clone the receiver
- Accept loop pushes; idle worker grabs. Natural work-stealing, no per-worker queue tuning.
- Bounded capacity gives healthy TCP backpressure if all workers stall.

**Per-connection behaviour:**

- HTTP/1.1 with `Connection: keep-alive`
- `handle_conn` loops over requests on the same socket until EOF or malformed input
- `read_full_request` reads until `\r\n\r\n`, capped at 16 KB
- `parse_request` uses `httparse` (zero-copy on the request buffer)

**Response:**

- `build_response(status, content_type, body)` pre-allocates `Vec::with_capacity(96 + body.len())`, writes the status line + 3 headers via `write!`, then appends the body
- Single `write_all` syscall per response

**Not implemented (deferred):**

- TLS termination
- HTTP/2
- Graceful reload + worker drain
- Daemonisation

---

## Worker pool

```
N Bun Worker threads, one per V8 isolate

  worker-0   tsfn_0   SAB_0 (256 KB)   AtomicU32 in_flight
  worker-1   tsfn_1   SAB_1 (256 KB)   AtomicU32 in_flight
  ...
  worker-{N-1}                          AtomicU32 in_flight

Brust manages:
  - registration on worker startup (Worker calls napi `register_renderer(view, fn)`)
  - least-busy selection on every render (atomic counter scan, N ≤ ~64 in practice)
  - in-flight counter (RAII guard increments on enter, decrements on drop)
  - removal on tsfn failure (worker tsfn dead → drop entry)
  - process::exit(1) if all entries die (no respawn yet)
```

Each worker pre-loads its render closure once at boot. No cold start per
request. Each worker has an isolated V8 heap; GC in one worker does not pause
others. `renderToString` is synchronous and CPU-bound; one worker per ~0.55
cores (1/1.8) gives true parallel rendering with no contention beyond the OS
scheduler.

**Why floor(availableParallelism * 1.8)?**

Empirical sweet spot on M1 Pro (10 cores: 8P + 2E). napi workers spend ~45% of
wall time in V8 GC, IPC, and thread-park; oversubscribing by 1.8× keeps CPU
saturated during those pauses. Measured: 18 workers ≈ 65k RPS React SSR; 8
workers ≈ 58k; 24 workers ≈ 65k (plateau).

---

## Designed but not built

The HTTP and dispatch layers above are real. The user-facing parts below are
roadmap.

### Routing

```tsx
// routes.tsx
export const routes = [
  { path: "/",            component: () => import("./pages/Home") },
  { path: "/blog/:slug",  component: () => import("./pages/Blog"),
    loader: async (req, { slug }) => ({ post: await db.getPost(slug) }),
    cache:  { vary: ["accept-language"], ttl_seconds: 60 },
  },
  { path: "/app", component: () => import("./pages/App"), cache: false,
    children: [
      { path: "settings", component: () => import("./pages/Settings") },
      { path: "profile",  component: () => import("./pages/Profile")  },
    ],
  },
]
```

Routes declare only routing + data + cache. Islands are declared at point of
use in JSX (see [Islands](#islands-on-demand-hydration)) — no per-route islands
manifest to keep in sync.

At boot, Bun parses `routes.tsx` and sends route patterns to Rust over a
dedicated napi call. Rust builds a radix tree. URL matching happens in Rust;
loader + component dispatch in Bun.

### Cache

LRU keyed on `method + path + sorted query + vary_headers`. Per-route opt-out
(`cache: false`) for authed/personalised pages. Programmatic invalidation via
control socket (`brust-cli invalidate /path`). TTL-based eviction.

Default key cannot capture session/cookie-dependent content unless declared in
`vary`. Routes without `cache:` opt in at their own risk.

### Islands (on-demand hydration)

Astro-style: islands are declared at point of use, in JSX. The component file
opts in to "I can be an island" with a `"use island"` directive; the parent
chooses **whether** and **when** to hydrate by passing a `hydrate` prop.

```tsx
// components/Counter.tsx
"use island"

export default function Counter({ start = 0 }: { start?: number }) {
  const [n, setN] = useState(start)
  return <button onClick={() => setN(n + 1)}>{n}</button>
}
```

```tsx
// pages/Blog.tsx
import Counter  from '../components/Counter'
import Comments from '../components/Comments'
import ShareBtn from '../components/ShareBtn'

export default function Blog({ post }: Props) {
  return (
    <article>
      <h1>{post.title}</h1>
      <ShareBtn hydrate="visible" />          {/* hydrates when scrolled into view */}
      <p>{post.content}</p>
      <Counter start={0} hydrate="interaction" />  {/* hydrates on first pointerdown */}
      <Comments postId={post.id} />           {/* no hydrate → server-rendered static */}
    </article>
  )
}
```

Behaviour:

- **No `hydrate` prop** → component renders to HTML on the server and stays
  static on the client. Even islands work this way by default; you pay for
  hydration only where you ask for it.
- **With `hydrate` prop** → server renders as static HTML *and* injects a
  marker (`<div data-component="Counter" data-props='{"start":0}' data-hydrate="interaction">...</div>`). The bootstrap script attaches the trigger; on fire, the
  component chunk (+ React runtime, first time) is imported and `hydrateRoot`
  resumes from `data-props`.

Build-time: a TypeScript transformer scans component files for the
`"use island"` directive and registers a chunk per island. Pages that import
an island get the marker-wrapping at the call site automatically; non-island
components are inlined as static HTML with no wrapper.

Hydration triggers (`hydrate` prop values):

| Value | Activates when |
|---|---|
| `"load"`        | as soon as the bootstrap script runs |
| `"idle"`        | browser reports idle (`requestIdleCallback`) |
| `"visible"`     | element enters the viewport (`IntersectionObserver`) |
| `"interaction"` | first `pointerdown` on the element |

The `hydrate` prop name is reserved by Brust on island components. If you need
a user-facing prop called `hydrate`, rename it or wrap the island in another
component.

### Client JS budget (target)

| Scenario | JS sent to client |
|---|---|
| Page with no islands | **~1 KB** bootstrap only |
| Page with islands, none yet triggered | **~1 KB** bootstrap |
| First island activates | **~45 KB** React runtime (one-time, cached) + island chunk |
| Subsequent islands | **2–10 KB** per chunk, fetched on demand |
| Next.js full hydration (for context) | 80–200 KB up-front |

### Navigation

```
User clicks <Link to="/blog/next">
  → intercept click
  → GET /_brust/page/blog/next      JSON: { html, islands, head }
  → swap <div id="root">; update <title>/<meta>
  → re-wire island hydration triggers on the new DOM
  → pushState
```

### Single-binary deploy

```
bun build --compile example/hello-world/index.ts → ./brust
```

Open question: does `bun build --compile` bundle native `.node` modules
correctly? The build needs to embed the cdylib alongside the user bundle.

### Configuration

Today, env-only:

- `BRUST_PORT` — default 3000
- `BRUST_WORKERS` — default `floor(os.availableParallelism() * 1.8)`
- `BRUST_WORKER_ID` — set per Worker; do not set manually

Roadmap: `brust.toml` with `[server]`, `[workers]`, `[cache]`, `[build]` sections.

### Streaming SSR

`renderToString` produces a complete HTML blob — fits the SAB-write-once
model. React 18's `renderToPipeableStream` would need a multi-write protocol
(repeated SAB writes with intermediate signals, or socket-style streaming).
Deferred; latency win on content-heavy pages is small relative to render time.

### Retry / health / error path

Not implemented:

- Retry on tsfn failure → currently we just remove the dead entry and 502 the request
- PING/PONG health checks → not present; tsfn dispatch failure is the only signal
- Render error (loader exception) → currently bubbles up via the rejected Promise → HTTP 500 with `render error: {message}`

---

## Crate structure

One crate, `cdylib`:

```
brust/
├── Cargo.toml                     edition 2024, napi 3.x, flume 0.11,
│                                   parking_lot, httparse, tracing,
│                                   tokio (mac) / tokio-uring (linux)
├── src/lib.rs                     napi exports: beginServe, untilReady,
│                                   untilShutdown, registerRenderer,
│                                   isWorker, workerId
├── src/pool.rs                    WorkerPool, TsfnEntry, BufPtr (Send+Sync)
├── src/server.rs                  accept loop, handle_conn, read_full_request,
│                                   keep-alive request loop
├── src/http.rs                    parse_request (httparse), build_response,
│                                   error_400/404/405/414/500/502/503
├── src/io/{linux,other,mod}.rs    tokio-uring vs tokio TcpListener/TcpStream
│                                   wrappers (current_thread runtimes on both)
└── src/shutdown.rs                Notify-based shutdown handle (currently
                                    dead code under Bun — Bun intercepts SIGINT
                                    before Rust's ctrl_c() handler fires;
                                    actual exit happens via JS process.exit(0))
```

Future splits when the API stabilises (e.g. `brust-cli` if/when one exists).

---

## Performance

All numbers measured. Hardware: M1 Pro (10 cores: 8P + 2E), 16 GB RAM, Bun 1.3,
release build, `oha -c 120 -z 10s`.

| Endpoint | Setup | RPS | p99 |
|---|---|---|---|
| `/ping` (Rust-native) | `BRUST_WORKERS=18` | **107 k** | <0.1 ms |
| `/` (React SSR via SAB) | `BRUST_WORKERS=18` | **72 k** | 0.1 ms |
| `/ping` (axum baseline, same box) | — | 100 k+ | — |
| `/`, `/ping` (Bun.serve baseline) | — | *TBD* | — |

Bun.serve baseline comparator: `example/bun-serve-baseline/index.ts`.

---

## Comparison

| | Next.js | Astro | Bun + react-router | **Brust** |
|---|---|---|---|---|
| HTTP layer | Node.js | Node.js | Bun | **Rust cdylib loaded into Bun** |
| Render workers | single process | single process | single process | **N Bun Worker threads in one process** |
| Render IPC | — | — | — | **napi tsfn + per-worker `SharedArrayBuffer`** |
| Cache | JS (GC) | JS (GC) | none built-in | **Rust LRU (roadmap)** |
| HTML processing | JS | JS | JS | **Rust** |
| Hydration | full page | islands | full page | **on-demand islands (roadmap)** |
| Client JS (baseline) | 80–200 KB | 0–10 KB | 80–200 KB | **~1 KB + 45 KB on first hydrate** (roadmap) |
| Deploy | directory | directory | single binary | **bun build --compile (roadmap)** |

---

## Status

**Built:**

- HTTP/1.1 accept loop with keep-alive, custom Rust (`src/server.rs`)
- Pre-spawned TCP worker pool over `flume::bounded(1024)` MPMC channel
- napi `ThreadsafeFunction` render dispatch
- Per-worker `SharedArrayBuffer` (256 KB) zero-copy render result
- TS facade: `brust.serve`, `brust.registerRenderer`, `isWorker`, `workerId`
- `/ping` static native route for benchmarks
- Auto-tuned worker count: `floor(os.availableParallelism() * 1.8)`
- Integration test + 100-burst manual smoke check
- Bun.serve baseline comparator (`example/bun-serve-baseline/`)

**Designed, not built:**

- Cache (LRU, vary headers, TTL, control-socket invalidation)
- Routing (`routes.tsx` + radix tree + per-route cache config)
- Islands hydration (`"use island"`, lazy bootstrap, hydration triggers)
- Single-binary deploy (`bun build --compile`)
- TOML configuration
- Retry on tsfn failure, PING/PONG health checks

**Deferred (no design yet):**

- Streaming SSR (`renderToPipeableStream`)
- Multi-thread tokio runtime (Brust is single-thread Rust today)
- N slots per worker for loader-bound workloads
- HTTP/2
- TLS termination
- Hot reload (dev mode)
- Graceful shutdown / drain (SIGINT handled JS-side via `process.exit`)

---

*Brust — Built to burst.*
