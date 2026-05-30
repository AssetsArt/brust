# Brust — Architecture

**B**un + **Rust** — SSR framework that bursts.

React on the server. Rust everywhere else. One Bun host process, Rust loaded as
a `.node` native module via napi-rs. Renders dispatched into Bun Worker threads;
HTML returned through per-worker SharedArrayBuffer.

Designed agent-first: routes are designed to ship machine-readable schemas
(server fns as tools, loaders as resources) so AI agents can drive the app
without scraping the DOM. The framework already has the structural knowledge —
loader types, server-fn signatures, island markers — that a schema extractor
needs. **This shipped:** a boot-time extractor (`runtime/mcp/extractor.ts`) and
a Model Context Protocol server at `POST /_brust/mcp` expose server fns as tools
and route loaders as resources (see [Agentic surface](#agentic-surface-mcp)).

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
      └─ await napi.untilReady(timeout)   # all workers registered, or exit(1)

  Worker threads × N  (= os.availableParallelism(), override via BRUST_WORKERS / [workers].count)
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
T6                  → entry.tsfn.call_async(path).await   # → Promise<u32>
                       │     tsfn dispatch failure here → 502 + pool.remove(id)
                       │
                       └→ Bun Worker thread wakes:
                            renderToString(...)
                            TextEncoder.encodeInto(html, sabView)
                            return written            # u32, bytes
T7   Rust            → .await on Promise → n
                       Promise rejection here → 500 ("render error: {msg}");
                       worker stays in pool
T8                  → if n outside (0, buf_len] → 500 ("render oversized")
                       else body = unsafe { from_raw_parts(buf_ptr, n).to_vec() }
                       (no V8 marshal; one Rust-local memcpy to detach body)
T9                  → bytes = build_response(200, "text/html", body)
                       s.write_all(bytes).await
T10                 → loop to T3 on the same TCP connection (keep-alive)
```

---

## IPC: napi ThreadsafeFunction + SharedArrayBuffer

```
                                Bun side                  napi             Rust side
                                ──────────────            ────────         ─────────────────
arg (path)         encode UTF-8 → tsfn queue      → cross-thread     → String (alloc, ~50 B)
render output      renderToString  → SAB write    → -                → raw ptr deref
                   (TextEncoder.encodeInto)         (no V8 marshal)    (slice::from_raw_parts)
signal             return u32 written            → resolve Promise  → await yields u32
```

The "no V8 marshal" row means napi doesn't re-encode or copy the rendered HTML
when crossing the JS→Rust boundary — the bytes already sit in shared memory
that Rust reads via the pointer captured at register time. It does *not* mean
the whole `/` path is zero-copy end to end; the table below counts every copy
that still happens.

**Copy count, /  endpoint:**

| Where | Bytes | Notes |
|---|---|---|
| path: V8 → Rust (`String`) | ~50 | unavoidable, tiny |
| html: V8 → SAB (`TextEncoder.encodeInto`) | full body | inside Worker, one pass UTF-8 |
| SAB → response `Vec<u8>` (`from_raw_parts(..).to_vec()`) | full body | Rust local memcpy, ~10 GB/s on M1 |
| response `Vec<u8>` → kernel | full body | `write_all` syscall |

`build_response` still allocates one `Vec<u8>` and copies the body into it. Sub-project M (2026-05-28, [post-mortem](docs/superpowers/post-mortems/2026-05-28-writev-zero-copy-response.md)) attempted to replace this memcpy with `writev` (inspired by [nylon-ring](https://github.com/AssetsArt/nylon-ring)'s `NrVec<u8>` zero-copy ownership-transfer philosophy); macOS bench measured +8 % p99 regression so the writev path was reverted. The kept architectural improvement: `cache_wanted: bool` plumbing in `dispatch_to_worker_and_stream_chunks` that skips an unconditional `response_bytes_for_cache.clone()` on uncached routes — bench-neutral but cleaner.

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

**Slot size:** 256 KB per worker. 10 workers on M1 Pro = 2.5 MB total. Comfortably in L2/L3.
**Oversize:** Worker resolves with `0` (its self-reported "too big" sentinel) or with any value outside `(0, slot_size]` → Rust responds HTTP 500. No fallback path yet; future option is dynamic resize or a separate socket-style spillover frame.

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

> **Linux deployment — io_uring requires permitted syscalls (seccomp).** The
> Linux runtime calls `io_uring_setup`/`io_uring_enter`/`io_uring_register`.
> These are **not** in the default seccomp allowlist of most container runtimes
> (Docker, podman ≤ current, restrictive k8s `seccompProfile`s) — io_uring has a
> container-escape history, so default profiles deny it. Under a default profile
> `tokio_uring::start` panics at boot with `ENOSYS` ("Function not implemented",
> errno 38) and the worker thread dies → no listener → connections refused.
> Run with `--security-opt seccomp=unconfined` (podman/Docker) or a custom
> profile that allows the three `io_uring_*` syscalls; on k8s, set a
> `seccompProfile` that permits them. This applies to **both** glibc and musl
> builds — it is a property of the io_uring architecture, not the libc. Bare-metal
> and VM deploys are unaffected. Verified on aarch64 / kernel 5.10 (2026-05): same
> build boots to `listening (io: tokio-uring)` with `seccomp=unconfined`,
> ENOSYS-panics under the default profile.

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
  - atomic claim on every render (`try_claim_render` — picks first idle worker,
    installs render_slot, increments in_flight under one per-entry mutex)
  - least-busy selection for SSE/WS dispatch (atomic counter scan; renders
    don't use this path — claim is exclusive, not load-balanced)
  - in-flight counter (RAII guard increments on enter, decrements on drop)
  - removal on tsfn failure (worker tsfn dead → drop entry)
  - process::exit(1) if all entries die (no respawn yet)
```

**Render dispatch is atomic-claim.** `WorkerPool::try_claim_render` picks the first
worker whose `render_slot` is `None` under a per-entry `parking_lot::Mutex`,
installs the chunk sender, and increments `in_flight` in one critical section.
The returned `RenderClaim` is an RAII guard whose `Drop` clears the slot then
decrements `in_flight` (order is load-bearing — preserves the invariant
`in_flight ≥ render_slot_count` at every observable point). Two concurrent
renders cannot claim the same worker because the per-entry mutex serializes
the check-and-install. Returns `ClaimResult::PoolEmpty` (no workers registered)
or `ClaimResult::AllBusy` (every worker mid-render) — distinct 503 bodies so
operators can tell misconfiguration from overload. SSE/WS dispatch continues to
use `pick_least_busy` because their per-conn task model doesn't share the SAB
chunk channel. The earlier `pick_least_busy + slot install` sequence allowed a
TOCTOU race (two pickers both observing `in_flight=0` and `slot=None` on the
same entry, the second overwriting the first's `chunk_tx` silently in release);
the atomic-claim refactor closes it. Regression test: `try_claim_render_race_no_concurrent_double_claim` in `src/pool.rs` runs 16 contender tasks against 4 workers under a multi-thread tokio runtime + two-phase barrier and verifies exactly 4 distinct concurrent claims.

Each worker pre-loads its render closure once at boot. No cold start per
request. Each worker has an isolated V8 heap; GC in one worker does not pause
others. `renderToString` is synchronous and CPU-bound; one worker per CPU
gives true parallel rendering with no contention beyond the OS scheduler.

**Why `availableParallelism()`?**

CPU-bound React renders saturate one core per worker. Oversubscribing the
scheduler (the previous `* 1.8` default → 18 workers on a 10-core M1 Pro)
worked when components were tiny and most worker time was V8 GC / IPC /
thread-park — pure I/O wait. Once per-render work grew to ~150 µs (heavier
component, more DOM), the extra workers competed for the same 8 perf cores
and amplified p99 ~6× under load (`/` p99 17.85 ms → 2.42 ms after dropping
the multiplier; see [post-mortem 2026-05-28](./docs/superpowers/post-mortems/2026-05-28-slash-route-p99-regression.md)).
Users with Suspense-heavy or await-heavy renders can override via
`BRUST_WORKERS` or `workers.count` in `brust.toml`.

---

## Application & feature layer

The HTTP and dispatch layers above are the foundation. The feature sections
below were originally roadmap; **most have since shipped** — each subsection
carries its own status (✅ shipped / partial / designed-not-built), and the
authoritative per-feature ledger is the [Status](#status) section near the end.
Where a subsection still shows an aspirational "vision" snippet, the shipped
reality is called out inline.

### Routing, state, errors

```tsx
// routes.tsx
import { defineRoutes } from 'brust/runtime'
import HelloWorld    from './components/HelloWorld'
import BlogPost      from './components/BlogPost'
import Crash         from './components/Crash'
import CrashBoundary from './components/CrashBoundary'

export const routes = defineRoutes([
  { path: '/',             Component: HelloWorld },
  { path: '/blog/{slug}',  Component: BlogPost },
  { path: '/crash',        Component: Crash, errorBoundary: CrashBoundary },
])
```

Pattern syntax is **matchit 0.8** (`/blog/{slug}`, not Express-style `:slug`).
`defineRoutes` pins the array's element type and flattens any nested
`children: [...]` into the flat list Rust sees (Rust's route table is
unchanged — nesting is a JS-side authoring convenience).

Bun parses `routes.tsx` at boot and ships the pattern array to Rust via
`brust.registerRoutes(...)`; Rust builds a `matchit::Router<u32>` keyed by
array-index = route id (`src/routes.rs`). URL matching happens entirely in
Rust — `handle_conn` calls `routes.match_path(&method, &path, &request_buf)`
which embeds a structured `req` (parsed once via httparse) in the envelope:
`{ route_id, path, params, req: { method, url, headers, cookies, search } }`.
Headers are lower-cased; cookies parsed from the `Cookie` header; search
params decoded from the query string (`+` → space, `%xx` percent-decode).
On no-match, Rust responds 404 without consuming worker capacity. The tsfn
type signature `Function<String, Promise<u32>>` is **unchanged**; only the
`String` content is now an envelope instead of a raw path.

Worker-side dispatcher in `runtime/routes.ts::makeRenderer` parses the
envelope, composes the per-route middleware chain around the terminal
(loader + render), and writes `[meta_len u16 BE][meta JSON][body]` into the
SAB. Component props include `req: BrustRequest`.

**Per-route error recovery.** A route can declare
`errorBoundary: ComponentType<{ error: Error }>`. When the component or loader
throws, the worker catches the exception, renders the `errorBoundary` in its
place, and sets `meta.status = 500` — clients see a real 500 response.
Uncaught middleware errors collapse to a plain text/plain 500 via the
chain's outer try/catch.

**Designed but not yet built** (each gets its own plan):

- `cache` ✅ shipped (per-route, opt-in, TTL + vary).
- `middleware: [...]` ✅ shipped (per-route chain, short-circuit, header mutation).
- `loader` receiving full `req` ✅ shipped.
- `children: [...]` ✅ shipped (nested routes with `<Outlet />`, index routes, layout-only parents).
- Client-side navigation (`/_brust/page/*`) ✅ shipped (see [Navigation](#navigation)).
- `native: true` routes (jinja-compiled, Rust-rendered) ✅ shipped (see [Sub-project J](#sub-project-j--native-dynamic-routes-via-minijinja-2026-05-29)).
- Global `app/_404.tsx` / `app/_500.tsx` overrides — Middleware follow-up.
- Global `app/middleware.ts` — Middleware follow-up.

### Cache

Bounded LRU (1000 entries by default) keyed on
`method + path + sorted_query + selected_vary_values`. **Opt-in per route** —
omit the `cache:` field and the route bypasses the cache entirely. This trades
performance for correctness: authed/personalised pages don't accidentally serve
another user's HTML.

```tsx
{ path: '/blog/{slug}', Component: BlogPost,
  cache: { ttl_seconds: 60, vary: ['accept-language'] } }
```

- **TTL** evicts entries lazily on read.
- **`vary`** declares request headers that affect content. Each appears in the
  cache key, so `accept-language: en` and `accept-language: th` cache separately.
- **Hits** respond entirely from Rust — no napi tsfn call, no Bun Worker wakeup.
- **Misses** call the worker as usual, then store the full response bytes
  (status line + headers + body) so the next hit is one `write_all` away.

Implementation: `src/cache.rs` wraps `lru::LruCache` behind
`parking_lot::Mutex`; lookup + insert sit in `handle_conn` between
`routes.match_path` and `pool.pick_least_busy`.

**Observability:** `GET /_brust/cache/stats` returns `{hits, misses, len, capacity}` as JSON (native route, bypasses worker pool).

**Capacity:** configurable via `[cache] max_entries = N` in `brust.toml` (default 1000). Plumbed through `BrustConfig.cacheMaxEntries` → `brust.configureCache({ maxEntries })`.

**Invalidation.** Two native endpoints purge cached entries:

- `POST /_brust/cache/invalidate?path=/foo` — drops every entry whose key has `(method=GET, path=/foo)`, regardless of query string or vary values. Returns `{"removed": N}`.
- `POST /_brust/cache/invalidate?all=1` — clears the entire cache. Returns `{"removed": N}`.

`GET` returns 405; POST without `path` or `all` returns 400. Both calls preserve hits/misses counters (they're lifetime totals). The endpoint is *unauthenticated* by design — apps running Brust in untrusted environments should reverse-proxy and gate the `/_brust/*` prefix externally, or wrap their own auth middleware on the surrounding deploy.

**Not yet implemented:**

- `brust-cli invalidate` — project tooling, separate from the native endpoint above.
- Default TTL fallback in `[cache]` — semantics deferred; no current consumer.

### Islands (on-demand hydration)

> **Original vision below; shipped reality differs.** The `"use island"`
> directive + auto-wrapping transformer described in this subsection was the
> initial design. What actually shipped is the explicit `<Island component={…}>`
> wrapper with **component-addressed** chunking and `data-brust-*` markers —
> see **[Status (shipped)](#status-mvp-shipped)** immediately below for the
> accurate mechanism. The vision is kept for context on where the API may head.

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
  marker. *(Shipped form: `<div data-brust-island="Counter" data-brust-props='{"start":0}' data-brust-hydrate="interaction">…</div>` — see the Status block for the real attribute names.)* The bootstrap script attaches the trigger; on
  fire, the component chunk (+ React runtime, first time) is imported and
  `hydrateRoot` resumes from the props attribute.

Build-time *(vision)*: a TypeScript transformer scans component files for the
`"use island"` directive and auto-wraps island call sites. *(Shipped instead:
`scanIslandChunks` walks page sources for explicit `<Island component={X}>`
JSX and builds one chunk per referenced component — no directive, no
auto-wrapping. See the Status block.)*

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

#### Status (MVP shipped)

- `<Island component props hydrate? ssr?>` runtime component (from `runtime/islands/island.tsx`) embeds the SSR HTML inside a `data-brust-island` marker (value = the component name) and flips a module-scope flag. Islands are **component-addressed**: no `id` attribute, no config — the chunk is keyed by the `component={X}` identifier, and multiple `<Island>` may reuse one component (each occurrence gets a distinct source-order *instance* for its `island_<instance>_props/_html` context slot).
- `makeRenderer` auto-injects an importmap + `<script type="module" src="/_brust/islands/_bootstrap.js" defer>` when any island rendered. Pages without islands ship zero JS.
- `scanIslandChunks(routes.tsx)` (from `runtime/islands/build.ts`) walks the routes' page sources for `<Island component={X}>`, resolving each `X` to its source via the page's own imports → `Map<componentName, sourcePath>`. `buildIslands(map)` then runs `Bun.build` 3+N times: 1 combined chunk for `react`+`react/jsx-runtime` (`_react.js`, ~7 KB minified), 1 `react-dom/client` chunk (`_react-dom.js`, ~136 KB minified, externalises `react`), N island chunks (all 3 runtime modules external), 1 bootstrap. Output lands in `.brust/islands/`. All builds use `minify: true` + `define: process.env.NODE_ENV = "production"`.
- Rust native route `GET /_brust/islands/<file>` serves chunks with `Cache-Control: public, max-age=3600`. Strict filename-safety check rejects path-traversal, hidden files, non-JS, and anything outside `[A-Za-z0-9_.-]+\.js`.
- 4 hydration triggers shipped: `load` / `idle` / `visible` / `interaction`.

**MVP-scope simplifications (vs the architecture vision above):**

- `<Island>` is a manual wrapper. The `"use island"` directive + auto-detection at JSX call sites is deferred — users explicitly wrap.
- Islands are addressed by `component={X}` — no registry. The component identifier IS the chunk key, so **island component names must be unique across the app** (two different files with same-named island components → a clear build-time collision error).
- Filenames are predictable (`<ComponentName>.js`), not content-hashed. Production deployments should fingerprint or wrap with a CDN.
- React + react/jsx-runtime live in one chunk (`_react.js`); the importmap maps both bare specifiers to that URL. `react-dom/client` is its own chunk. Per-island bundle = component + its imports only.
- No CSS extraction, no `"use server"` auto-rewrite (separate plan), no nested islands, no hot reload.
- `runtime/package.json` uses `peerDependencies` for `react` + `react-dom` so the root app's single copy is the only one Bun installs (avoids dispatcher-null SSR crash when two physical React copies coexist).

### Server functions

Functions that exist only on the server but can be called from a client-side
island as if they were local. Same Rust/TS types on both sides, no separate
API schema to maintain. Similar to Dioxus `#[server]`, TanStack Start
`serverFn`, Next.js Server Actions.

```tsx
// actions/posts.ts
"use server"

import { db } from '../db'

export async function createComment(postId: string, body: string): Promise<Comment> {
  return await db.comments.insert({ postId, body })
}
```

```tsx
// components/CommentForm.tsx
"use island"
import { createComment } from '../actions/posts'

export default function CommentForm({ postId }: { postId: string }) {
  const [body, setBody] = useState('')
  return (
    <form onSubmit={async (e) => {
      e.preventDefault()
      await createComment(postId, body)    // auto RPC, same types
      setBody('')
    }}>
      <textarea value={body} onChange={e => setBody(e.target.value)} />
      <button>Post</button>
    </form>
  )
}
```

How it works:

1. Build-time scanner finds files with `"use server"`. Each exported async
   function gets a deterministic id from `hash(file_path + fn_name)`.
2. **Server bundle:** the implementation is registered behind
   `/_brust/action/<id>`. Args come in as JSON; return value goes out as JSON.
3. **Client bundle:** the import is rewritten to an RPC stub —
   ```ts
   export const createComment = (...args) =>
     fetch('/_brust/action/<id>', { method: 'POST', body: JSON.stringify(args) })
       .then(r => r.json())
   ```
   The original function body is removed; DB drivers and secrets never ship
   to the client.
4. The HTTP round-trip uses the same Brust accept loop + worker pool as page
   rendering — no separate transport, no API gateway in front.

Trade-offs:

- ✅ End-to-end type safety without a duplicate schema
- ✅ Server-only code (DB, secrets) literally not in the client bundle
- ✅ Same request context as a page render — any middleware applied to the
  matched route applies to the server-fn call too
- ⚠️ Each call = one HTTP round-trip. Not for hot loops; batch on the client.
- ⚠️ Args/return must be JSON-serialisable (richer encoder for `Date`/`Map`/
  `bigint` is a roadmap item). `FormData` is a special case, see
  [Forms & multipart](#forms--multipart).
- ⚠️ Distinct from `loader:` on routes. Loaders fire on page render; server
  fns fire on client interaction.

**MVP scope simplifications (documented inline in plan + spec):**
- `"use server"` directive + boot-time scanner discovers actions; `withMiddleware([...], fn)` attaches per-action middleware. No build-time client-side auto-rewrite yet — islands call actions via the `action<F>(id)` helper from `runtime/client`.
- JSON-only — `FormData`/multipart is the Forms plan's job
- Action-specific middleware (no route-middleware inheritance via `X-Brust-Route`)
- Errors return `{ "error": { "message", "name" } }` JSON envelope on non-2xx; no stack-trace mode
- `runtime/client/action<F>(id)` helper bundled into each island chunk (~1 KB); shared chunk is a future optimisation

**Designed, not built (follow-ups):**
- Build-time client-side auto-rewrite: `import { fn } from './actions'` on the client rewritten to an RPC stub, removing the need for the `action<F>(id)` helper
- Per-route middleware inheritance via X-Brust-Route header (defer until proven need)
- Stack trace in error envelope via `BRUST_DEBUG_ERRORS=1`
- Shared `runtime/client` chunk via importmap (today every island bundles its own ~1 KB copy)

### Agentic surface (MCP)

**Shipped — see the Built list at the bottom of this document.** Brust mounts
a Model Context Protocol 2025-06-18 server at `POST /_brust/mcp` so any MCP
client (Claude desktop, Cursor, custom agents) can discover and call into a
Brust app without bespoke integration. Each Brust app effectively *is* an
MCP server.

The framework already knows everything an agent needs:

- the route tree (paths, params) → exposed as MCP **resources**
- per-route loader types (what data the page consumes) → resource shape
- the server fns the app imports (the tools the page can invoke) → MCP **tools**

A boot-time extractor (`runtime/mcp/extractor.ts`) uses the TypeScript
compiler API to walk every `'use server'` file and the routes module, then
caches the result at `.brust/mcp-manifest.json`. Apps don't write the schema
by hand.

**Endpoints:**

- `POST /_brust/mcp` — JSON-RPC 2.0. Capabilities declared on initialize:
  `tools`, `resources`, `prompts` (empty), `logging`. Transport is POST-only
  for MVP; the SSE leg for streaming notifications is deferred.

**Invoking actions** flows through the existing action runtime — the same
middleware chain that protects `/_brust/action/<id>` protects `tools/call`.
Middleware rejections surface as `isError: true` on the MCP response.

**Resource URIs:** `brust://<route-fullPath>` — e.g. `brust:///blog/{slug}`.
`resources/read` extracts `{param}` captures and invokes the leaf loader.

**Trade-offs:**

- ✅ AI-first design — no DOM scraping; agents get typed, stable contracts
- ✅ Schema co-evolves with code (TS compiler API extraction at boot, not
  hand-maintained)
- ✅ Reuses existing types from server fns & loaders
- ✅ Agents inherit the user's full request context (cookies, headers, any
  middleware-applied auth or rate-limits) — no separate agent-only ACL
  surface; the same middleware that protects users protects agents
- ⚠️ Schema is a public API surface — versioning matters; breaking changes
  to a server-fn signature break agents the same way they break clients
- ⚠️ Agent-specific concerns (per-agent rate limits, audit logging, consent
  prompts before destructive actions) are middleware territory; the
  framework doesn't impose a policy
- ⚠️ FormData params on tool inputSchemas expand to the full DOM FormData
  shape; agents see a verbose-but-functional schema. Future: a class-name
  blocklist in the schema converter.

### Middleware

Per-route interceptors that wrap loader + render. Each is `async (req, next) =>
Promise<RouteResponse>` and runs in declaration order — entry `[0]` is the
outermost layer, wrapping `[1]`, ..., wrapping the terminal (loader + render).
A middleware may short-circuit by returning a `RouteResponse` without calling
`next()`, or call `next()` and mutate the returned response (status, headers).

```tsx
import { defineRoutes, type Middleware } from 'brust'

const authRequired: Middleware = async (req, next) => {
  if (!req.cookies['user']) {
    return {
      status: 401,
      body: 'unauthorised',
      headers: { 'WWW-Authenticate': 'Cookie' },
    }
  }
  return next()
}

const timeIt: Middleware = async (_req, next) => {
  const t0 = Date.now()
  const res = await next()
  res.headers = { ...(res.headers ?? {}), 'x-render-ms': String(Date.now() - t0) }
  return res
}

export const routes = defineRoutes([
  { path: '/protected',   Component: Secret, middleware: [authRequired] },
  { path: '/with-header', Component: Page,   middleware: [timeIt] },
])
```

Brust does not ship a session/auth primitive — apps wire their own middleware
(cookie parsing, session store, OAuth providers, etc.). `RouteResponse` is a
plain object `{ status, body, headers? }`; `BrustRequest` carries
`{ method, url, headers, cookies, search }` parsed once in Rust.

**Mechanism (shipped):** SAB layout is `[meta_len: u16 BE][meta JSON][body]`
where `meta = {status, headers?}`. Rust deserializes the meta JSON, then
builds the wire response via `build_response(meta.status, ..., extra_headers,
body)`. The `extra_headers` slice drops CRLF-injected entries and skips
collisions against the fixed `Content-Type` / `Content-Length` /
`Connection` lines. Cached responses store the full wire bytes built after
meta parsing — so middleware-mutated headers cache correctly.

**Cache + middleware interaction:** cache lookup happens *before* middleware
runs. A route that combines `cache: {...}` with personalising middleware
(e.g. `x-request-id`, per-user headers) replays the *first* renderer's
headers on every hit. Combine route caching only with deterministic middleware.

**Designed, not built (follow-ups):**
- Global `app/middleware.ts` array (currently per-route only).
- Header *deletion* (current channel is set/override only — no way to drop a fixed header).
- `req` extensions: file uploads / streaming bodies, parsed `Accept-Language`, etc.

### Forms & multipart

Form posts decode automatically. `multipart/form-data` exposes file streams
without buffering whole uploads in memory.

```tsx
// actions/upload.ts
"use server"

export async function uploadAvatar(form: FormData): Promise<{ url: string }> {
  const file = form.get('avatar') as File
  const buf  = await file.arrayBuffer()         // or stream via .stream()
  const url  = await storage.put(file.name, buf)
  return { url }
}
```

```tsx
// components/AvatarUpload.tsx — "use island"
<form
  onSubmit={async (e) => {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    const { url } = await uploadAvatar(data)
    setAvatar(url)
  }}
  encType="multipart/form-data"
>
  <input type="file" name="avatar" accept="image/*" />
  <button>Upload</button>
</form>
```

Form actions declare `(req: BrustRequest, fd: FormData) => R` and the
client calls them via `formAction<F>(id)` from `runtime/client`, which
mirrors `action<F>(id)` but sends the body as `multipart/form-data` or
`application/x-www-form-urlencoded` instead of JSON. JSON args continue
to use the path described in [Server functions](#server-functions); the
two paths share the same `/_brust/action/<id>` endpoint, differentiated
by `Content-Type`. Wire-level, the action envelope carries
`content_type` + `body_text` / `body_b64` (multipart payloads are
base64-encoded through the JSON envelope), with the same 256 KB body
cap as JSON actions. Streaming uploads remain a roadmap item.

### Real-time: WebSockets, SSE, streams

Three primitives, one accept loop:

```tsx
// routes.tsx
{
  path: "/ws/chat/:room",
  websocket: () => import("./ws/chat"),      // upgrade-only route
},
{
  path: "/events",
  sse: async (req) => {
    return new ReadableStream({
      start(controller) {
        const id = setInterval(() => {
          controller.enqueue(`data: ${JSON.stringify({ now: Date.now() })}\n\n`)
        }, 1000)
        req.signal.addEventListener('abort', () => clearInterval(id))
      },
    })
  },
},
```

```tsx
// ws/chat.ts
export default {
  async open(socket, { room }) { socket.subscribe(`room:${room}`) },
  async message(socket, data) { socket.publish(`room:${socket.room}`, data) },
  async close(socket)         { /* cleanup */ },
}
```

- **WebSocket:** Rust handles the HTTP/1.1 upgrade and the post-upgrade frame
  loop on its own thread; messages are dispatched into the worker via a new
  tsfn variant (`Function<WsMessage, Promise<WsReply>>`), not by handing the
  raw TCP fd into V8. One ws connection pins to one worker for the
  connection's lifetime (no migration mid-session). The exact wire shape for
  binary frames is still open; UTF-8 text messages can ride the same SAB +
  signal trick used for renders.
- **SSE / streaming responses:** route returns a `ReadableStream`. Rust pipes
  chunks to the client with `Content-Type: text/event-stream` (or whatever the
  route sets); backpressure handled by the underlying TCP write.
- **No pub/sub bus built in** — apps can wire Redis pub/sub, NATS, or in-memory
  channels behind the per-route handlers.

### HTML Streaming

**Shipped.** `renderToPipeableStream` writes the page as chunks while loaders are still
resolving — useful for Suspense + slow data. Auto-detected per request: routes whose tree has no pending Suspense at `onShellReady` emit a single-chunk Content-Length response (byte-identical to the prior renderToString path for no-Suspense pages); routes with pending Suspense stream via HTTP/1.1 chunked transfer-encoding.

The integration shape:

1. Worker calls `renderToPipeableStream(<App />, { onShellReady, onAllReady })`.
2. Each chunk is encoded into the SAB at **offset 0** (the SAB is reused
   per chunk; no growing cursor).
3. Worker signals the chunk length via a new tsfn variant —
   `Function<u32, Promise<()>>`, invoked multiple times — instead of the
   `Function<String, Promise<u32>>` used for `renderToString`. The Promise
   on each call is what gives the Worker an explicit ack channel. The
   streaming renderer is registered through a separate entry point so both
   contracts coexist.
4. Rust drains the SAB into the socket (chunked transfer-encoding) **before**
   acknowledging the signal; only after the chunk is on the wire does the
   Worker write the next one.
5. Final signal `0` closes the response.

Ordering relies on napi's tsfn FIFO guarantee for calls from the same JS
context. Backpressure is implicit: the Worker can't enqueue the next signal
until the current one's `await` resumes after the Rust write.

Shipped in 2026-05. Spec: `docs/superpowers/specs/2026-05-26-html-streaming-design.md`. Implementation plan: `docs/superpowers/plans/2026-05-26-html-streaming.md`.

### Client JS budget (target)

| Scenario | JS sent to client |
|---|---|
| Page with no islands | **~1 KB** bootstrap only |
| Page with islands, none yet triggered | **~1 KB** bootstrap |
| First island activates | **~45 KB** React runtime (one-time, cached) + island chunk |
| Subsequent islands | **2–10 KB** per chunk, fetched on demand |
| Next.js full hydration (for context) | 80–200 KB up-front |

### Navigation

**Shipped.** Plain `<a href>` clicks are intercepted by the bootstrap
chunk; internal same-origin navigations fetch
`GET /_brust/page/{path}` for a JSON `{ html, title }` envelope and
swap the `<main>` element's children in place, update `document.title`,
re-hydrate any new islands, and `history.pushState` the URL.
Back/forward buttons reuse the same swap path via `popstate`. Any
failure (network error, non-2xx response, missing `<main>`, malformed
JSON) silently falls back to `location.href = url`, so the user always
navigates. External links, `target="_blank"`, modifier-clicks,
same-page anchors, `/_brust/*` framework paths, and links with
`data-brust-no-intercept` all use default browser behaviour. Shipped
in 2026-05.

Spec: `docs/superpowers/specs/2026-05-26-navigation-interceptor-design.md`.
Implementation plan: `docs/superpowers/plans/2026-05-26-navigation-interceptor.md`.

### Single-binary deploy

**Shipped: a self-contained `dist/` directory.** `brust build` emits
`dist/{index.js, islands/*, mcp-manifest.json, native/index.<triple>.node,
.brust/jinja/*}` and `bun run dist/index.js` boots with no further build work
(see the Built list). The single-**binary** `bun build --compile` form remains
an open question — does it bundle native `.node` modules correctly? It needs to
embed the cdylib alongside the user bundle. Untested, deferred.

```
bun build --compile dist/index.js → ./brust   # aspirational; .node bundling unverified
```

### Configuration

Layered, low → high precedence:

1. **Built-in defaults.** Port `3000`, workers `os.availableParallelism()`.
2. **`brust.toml` at the project root.** Optional. Schema (extends as subsystems land):

   ```toml
   [server]
   port = 3000

   [workers]
   count = 10

   [cache]
   max_entries = 5000   # default 1000
   ```

   See `example/hello-world/brust.example.toml`.

3. **Environment variables.** Override TOML and defaults.
   - `BRUST_PORT` — TCP port.
   - `BRUST_WORKERS` — Bun Worker count.
   - `BRUST_WORKER_ID` — set per Worker by the framework; do not set manually.

The loader is in `runtime/config.ts` and exposes `loadConfig(cwd?)` plus the
`BrustConfig` type for app code that wants to read the merged config directly.

Roadmap sections: `[build]` (build pipeline plan when the CLI lands).

### Project tooling

A small CLI ships with the framework:

| Command | Does | Status |
|---|---|---|
| `brust new <name>` | Scaffold a starter project from `templates/minimal/` (entry, `routes.tsx`, sample island page, `brust.toml`, `package.json`, `tsconfig.json`) | ✅ (scaffold; end-to-end run blocked on a workspace restructure — see Built-list limitation) |
| `brust dev`        | Dev server with hot reload (CSS hot-swap, native-template + island chunk emit, dev WS overlay) | ✅ partial (CSS workflows usable; TS/HTML reload needs a Rust `napi_clear_pool` — deferred) |
| `brust build`      | Production build → self-contained `dist/` (`Bun.build` server bundle + island chunks + `mcp-manifest.json` + native `.node` + jinja templates). Not `bun build --compile`. | ✅ |

The three subcommands actually registered are `new` / `dev` / `build`
(`runtime/cli/index.ts`). Cache invalidation is a **native HTTP endpoint**
(`POST /_brust/cache/invalidate`), not a CLI command — a `brust invalidate`
wrapper is still roadmap. The CLI is itself a Bun script; no separate Rust
binary beyond the cdylib.

### Native clients

React components written for Brust target the web by default. Two paths to
non-browser clients on the roadmap:

- **Desktop:** wrap Brust's HTTP layer in a Tauri or Electron shell; the
  React tree is the same code. No new framework primitives needed.
- **Mobile:** React Native compat is **not** automatic — RN uses a different
  renderer (`react-native` package, not `react-dom`). Apps that want shared
  code must split UI primitives behind a platform-agnostic abstraction
  (the project chooses; Brust does not impose one).

This is an option, not a feature. We don't plan to invest framework effort
beyond making sure the server side stays usable from any HTTP client.

### Retry / health / error path

Not implemented:

- Retry on tsfn failure → currently we just remove the dead entry and 502 the request
- PING/PONG health checks → not present; tsfn dispatch failure is the only signal
- Render error (loader exception) → currently bubbles up via the rejected Promise → HTTP 500 with `render error: {message}`

---

## Crate structure

A Cargo **workspace** (`Cargo.toml` at root, `resolver = "2"`) with two member
crates. All Rust source lives under `crates/`; references elsewhere in this doc
to `src/<file>.rs` mean `crates/brust/src/<file>.rs`.

```
Cargo.toml                          [workspace] members = crates/brust, crates/jsx-rust-compiler
                                    shared [profile.release]: lto, strip, codegen-units=1

crates/brust/                       the napi cdylib (brust.node)
├── Cargo.toml                      edition 2024, napi 3.x, flume 0.11,
│                                   parking_lot, httparse, thiserror, tracing,
│                                   once_cell, minijinja, tokio-tungstenite, sha1,
│                                   tokio (mac) / tokio-uring (linux)
├── src/lib.rs                      napi exports: beginServe, untilReady,
│                                   registerRenderer, registerRoutes/Actions,
│                                   register{Sse,Ws}Paths, render-chunk + jinja +
│                                   sse/ws napi entries, isWorker, workerId
├── src/pool.rs                     WorkerPool, TsfnEntry, BufPtr (Send+Sync),
│                                   try_claim_render / RenderClaim (atomic-claim)
├── src/server.rs                   accept loop, handle_conn, keep-alive loop,
│                                   dispatch_to_worker_and_stream_chunks, native
│                                   /_brust/* routes (islands, css, cache, mcp).
│                                   500/502 emitted inline; 400/404/405/503 → http.rs
├── src/http.rs                     parse_request (httparse), build_response,
│                                   error_400/404/405/414/503
├── src/{routes,cache,jinja}.rs     matchit router, LRU cache, minijinja ENV
└── src/io/{linux,other,mod}.rs     tokio-uring vs tokio listener/stream wrappers

crates/jsx-rust-compiler/           jsx-rustc: JSX → minijinja compiler (native routes)
├── src/{parser,ir,lower,emit_jinja,lib}.rs   swc parse → IR → lower → emit
├── src/bin/jsx-rustc.rs            CLI: <source.tsx> -o <out.jinja>
├── fixtures/*.{tsx,expected.html}  byte-equal goldens
└── tests/golden_{emit,render}_jinja/         emit + minijinja-render goldens
```

Future splits when the API stabilises (e.g. `brust-cli` if/when one exists).

---

## Performance

All numbers measured. Hardware: M1 Pro (10 cores: 8P + 2E), 16 GB RAM, Bun 1.3+,
release build, `oha -c 120 -z 10s`.

Numbers below are **N=5 medians** unless noted otherwise. Single-run bench
variance on `/` is ±5–10 % RPS and ±25 % p99 — anchor claims to medians, not
single samples.

| Endpoint | Setup | RPS (N=5 med) | p99 (N=5 med) |
|---|---|---|---|
| `/ping` (Rust-native) | default workers (10) | **112 k** | 0.15 ms |
| `/` (React SSR via SAB) | default workers (10) | **30 k** | 1.74 ms |
| `POST /_brust/action/createNote` (server fn dispatch) | default workers (10) | **111 k** | 0.16 ms |
| `/ping` (axum baseline, same box) | — | 100 k+ | — |
| `/ping` (Bun.serve baseline) | — | 89 k | 2.54 ms |
| `/` (Bun.serve baseline) | — | 17.7 k | 7.52 ms |

Reproduce with `bun run bench` — driver at `scripts/benchmark.ts`, results at `bench/RESULTS.md`.
Bun.serve baseline source: `bench/apps/bun-serve/index.ts`.

**Read:** Brust's Rust accept loop + napi + SAB beats Bun.serve+React by ~26 % on `/ping` and ~70 % on `/`. The 2026-05-28 buffering-path napi-merge (`napi_render_chunk_final` + `RenderChunk::BytesAndFinal`) collapsed single-chunk renders from two tsfn round-trips to one — N=5 medians vs the pre-merge baseline (`a54394e`) show `/` RPS 23,193 → 29,993 (**+29 %**, ranges non-overlapping) and p99 2.80 ms → 1.74 ms (**−38 %**). c=1 p50 dropped 11 µs (148 µs → 137 µs) — the per-request round-trip cost. The action endpoint and `/ping` are near-identical (111 k vs 112 k) because both are single-call napi/SAB envelope paths with no React render tree to serialise; the gap to React-SSR (30 k) is the React render cost itself, not envelope overhead. The `/` row is still down vs the pre-2026-05-24 baseline (55 k → 30 k); the residual is the demo-component growth (Tailwind v4 + Layout wrapper) — see [post-mortem 2026-05-28](./docs/superpowers/post-mortems/2026-05-28-slash-route-p99-regression.md).

---

## Comparison

| | Next.js | Astro | Bun + react-router | **Brust** |
|---|---|---|---|---|
| HTTP layer | Node.js | Node.js | Bun | **Rust cdylib loaded into Bun** |
| Render workers | single process | single process | single process | **N Bun Worker threads in one process** |
| Render IPC | — | — | — | **napi tsfn + per-worker `SharedArrayBuffer`** |
| Cache | JS (GC) | JS (GC) | none built-in | **Rust LRU** ✅ |
| HTML processing | JS | JS | JS | **Rust** |
| Hydration | full page | islands | full page | **on-demand component-addressed islands** ✅ |
| Client JS (baseline) | 80–200 KB | 0–10 KB | 80–200 KB | **~1 KB + 45 KB on first hydrate** ✅ |
| Deploy | directory | directory | single binary | **`brust build` → self-contained `dist/`** ✅ (`--compile` single-binary deferred) |

---

## Status

**Built:**

- HTTP/1.1 accept loop with keep-alive, custom Rust (`src/server.rs`)
- Pre-spawned TCP worker pool over `flume::bounded(1024)` MPMC channel
- napi `ThreadsafeFunction` render dispatch
- Per-worker `SharedArrayBuffer` (256 KB) zero-copy render result
- TS facade: `brust.serve`, `brust.registerRenderer`, `isWorker`, `workerId`
- `/ping` static native route for benchmarks
- Auto-tuned worker count: `os.availableParallelism()` (one worker per core — the earlier `* 1.8` multiplier was reverted after it amplified p99 under load; see post-mortem 2026-05-28)
- Integration test + 100-burst manual smoke check
- Bun.serve baseline comparator (`bench/apps/bun-serve/`)
- Benchmark harness (`scripts/benchmark.ts`, `bun run bench`)
- HTTP 414 emission on oversized requests
- Declarative routing: `routes.tsx` + matchit radix tree + JSON envelope tsfn payload + per-route `errorBoundary`
- Layered configuration: defaults < `brust.toml` (`[server]` + `[workers]`) < env (`runtime/config.ts`)
- Per-route LRU cache (`cache: { ttl_seconds, vary? }`, lazy TTL eviction, configurable capacity via `[cache] max_entries`)
- Cache observability: `GET /_brust/cache/stats` returns `{hits, misses, len, capacity}` as JSON
- Cache invalidation: `POST /_brust/cache/invalidate?path=/foo` (purge by path) and `?all=1` (clear all) — returns `{"removed": N}` JSON; hits/misses counters survive
- Richer tsfn return: meta JSON envelope in SAB (`[meta_len u16 BE][meta JSON][body]`, `meta = {status, headers?}`)
- Per-route loaders (`loader: ({ params, path, req }) => Promise<data>`, result lands as component `data` prop)
- Structured `req` in envelope (`{ method, url, headers, cookies, search }` parsed once in Rust via httparse)
- Per-route middleware chain (`middleware: [(req, next) => RouteResponse, ...]` — short-circuit + post-`next()` header mutation; CRLF-injection-guarded)
- Islands hydration MVP: `<Island component props hydrate? ssr?>` (no `id`, no config) + `scanIslandChunks(routes.tsx)` → `buildIslands(map)` + `/_brust/islands/<file>` static route + handwritten bootstrap with 4 triggers (load/idle/visible/interaction) + shared React runtime via importmap. **Component-addressed** (2026-05-29): chunk key = component ident; same component reused N times → one chunk + distinct source-order `instance` per occurrence (`island_<instance>_props/_html`); SSR islands (`ssr` attr) ship server-rendered markup, client-only get an empty `data-brust-csr` mount. Replaced the per-id `island.config.ts` registry. Spec: `docs/superpowers/specs/2026-05-29-component-addressed-islands-design.md`
- Server functions MVP: async functions invokable from islands via `POST /_brust/action/<id>` (JSON args/return). Reuses the renderer tsfn via a `kind: 'render' | 'action'` envelope discriminant. Action-specific middleware (action def's own chain). Client helper `action<F>(id)` from `runtime/client` preserves types via TS generics + `import type` erase. New Rust napi `register_actions(ids: Vec<String>)`; new server.rs branch with charset/length/utf-8 guards and dedicated 404/405/411/413 error paths. Meta envelope grows optional `contentType` (camelCase) so action returns ship as `application/json`. ResponseMeta becomes the Content-Type override channel for any future need.
- `"use server"` directive + boot-time scanner — file-level directive. `brust.scanActions({ roots? })` walks the project, finds files whose first statement is `'use server'`, imports them, and registers all named function exports as actions. Middleware attaches per-action via `withMiddleware([mws], fn)`. Replaces the manual `defineActions` / `brust.registerActions` API.
- Forms & Multipart — `POST /_brust/action/<id>` accepts `multipart/form-data` and `application/x-www-form-urlencoded` bodies in addition to JSON. Handlers declare `(req: BrustRequest, fd: FormData) => R` for form actions. Client helper `formAction<F>(id)` mirrors `action<F>(id)`. Wire-level: `ActionEnvelope.args_json` replaced by `content_type` + `body_text` / `body_b64`; multipart bodies are base64-encoded for transport through the JSON envelope. 256 KB body cap unchanged.
- Nested routes — `Route.children: Route[]` with React Router-style relative child paths. `<Outlet />` component renders the matched child inside a parent layout. Index routes (`{ index: true, Component }`) match the parent path exactly; layout-only parents (`path: ''`) share middleware/layout without contributing a path segment. `errorBoundary` inherits up the chain (leaf wins). Middleware composes parent → child. Each `Component` sees only its own loader's data. Rust route table unchanged — flattening happens in `defineRoutes` (JS-side) so Rust still sees a flat list.
- Agentic surface (MCP) — Mounts a Model Context Protocol 2025-06-18 server at `POST /_brust/mcp`. Server actions (discovered by `brust.scanActions()`) become MCP **tools**; route loaders become **resources** at `brust:///<path-template>`. Schemas are extracted at boot via the TypeScript compiler API (`runtime/mcp/extractor.ts`) and cached to `.brust/mcp-manifest.json`. Capabilities declared by the server: tools, resources, prompts (empty), logging. Transport: POST-only (SSE leg for streaming notifications is deferred). Authentication: tool calls flow through the action's existing middleware chain — gated tools still 401 (surfaced as `isError: true` in the MCP response). Worker bootstrap reads the persisted manifest via `brust.loadMcpManifest()` and constructs the `McpServer` from the example app's entry file.
- Real-time: SSE — `Route.sse: (req) => ReadableStream<Uint8Array \| string>` serves long-lived `text/event-stream` responses. Connections multiplex on each worker via an out-of-band NAPI channel (one tsfn call per conn for the entire stream lifetime + per-chunk `napiSseWrite` with cooperative TCP backpressure through a `oneshot` ack) — no SAB per connection. Middleware runs once pre-open via a reverse-direction `napiSseSignalOpen` callback that the per-conn Rust task awaits on a `oneshot`; Rust writes SSE headers only after the 200 verdict. Auto-emitted: `Content-Type: text/event-stream`, `Cache-Control: no-store`, `X-Accel-Buffering: no`, and a `: ping\n\n` heartbeat every 15 s (opt-out via `sseOptions.heartbeatMs=0`). `req.signal` is a real `AbortSignal` on SSE routes that fires on client disconnect; non-SSE routes receive a permanently-unaborted shared sentinel (`NEVER_ABORTS`) so the field is always present without firing spurious abort listeners. Boot wiring: `brust.registerSsePaths(routes.filter(.sse).map(.fullPath))` tells Rust which literal paths to gate. MVP supports literal SSE paths only — parameterized routes (`/sse/{room}`) and pub/sub broadcast are out of scope, designed jointly with the future WebSocket sub-project.
- Real-time: WebSockets (RFC 6455) — `Route.websocket: () => Promise<WsHandlers>` serves WS upgrades. Rust validates the handshake headers, dispatches a single long-lived tsfn call to a worker, runs middleware via the existing chain (returns 4xx OR 101 + chosen subprotocol via `napiWsSignalOpen`), then on 101 writes the manual handshake response (Sec-WebSocket-Accept + optional Sec-WebSocket-Protocol) and wraps the TCP stream with `tokio_tungstenite::WebSocketStream::from_raw_socket(Role::Server)`. Per-conn task runs a `tokio::select!` over outgoing sends (JS-pushed via mpsc, ack via oneshot for backpressure), incoming frames (Text → string, Binary → Uint8Array), and a ping ticker (default 30 s; 2× window pong timeout closes with 1011). Author surface: `WsHandlers { open, message, close }` + `WsSocket { send, close, id }`. `on_close` fires exactly once for peer/timeout/error/oversize closes; author-initiated `socket.close` skips it. Subprotocol negotiation picks the first route-declared protocol that appears in the client's list. `handleWsConn` accepts handlers in either shape — direct `WsHandlers` OR a module wrapper exposing them via `default` — so the common `() => import('./x.ts')` pattern works without a `.then(m => m.default)` chain. Boot wiring: `brust.registerWsPaths(routes.filter(.websocket).map(.fullPath))`. Two new Rust deps: `tokio-tungstenite` 0.21 (default-features=false) for frame parsing + `sha1` for Sec-WebSocket-Accept. MVP supports literal WS paths only; parameterized routes (`/ws/chat/{room}`), pub/sub broadcast, `permessage-deflate`, client-mode WS, and TLS termination are deferred.
- HTML Streaming (`renderToPipeableStream` + auto-detect Suspense) — Worker registers a single streaming renderer (`Promise<()>`). Chunks flow through a side channel: `napiRenderChunk(workerId, len: u32)` where `len=0` is the final signal. Per-worker `render_slot: Mutex<Option<RenderSlot>>` carries the chunk channel; lifecycle is RAII-clamped by `RenderSlotGuard` so tokio cancellation can't leak the slot. JS-side: `runtime/render/stream.ts` runs a buffering `Writable` sink — `onShellReady` checks an `allReadyFired` flag set by `onAllReady` (set synchronously when no Suspense is pending; React 18 internal `pendingSuspenseBoundaries` isn't exposed on the stream return value). No-Suspense path waits for `onAllReady`, checks `consumeIslandUsedFlag()`, emits one chunk with conditional bootstrap (preserves prior behavior). Suspense path commits chunked headers at `onShellReady` and always includes the islands bootstrap (~500 bytes overhead — late islands inside pending Suspense haven't rendered yet). `dispatch_to_worker_and_stream_chunks` is the unified dispatch for both render and action branches; sse/ws bypass the chunk channel entirely. Cache layer only stores single-chunk responses (chunked framing is ambiguous post-decode). Worker-death detection preserved: `RenderOutcome::EnqueueFailed` triggers `pool.remove` + `exit(1)` on empty pool; `PromiseRejected` keeps the worker alive.
- Navigation interceptor (`/_brust/page/*` JSON page fetches) — Global `<a>` click interceptor (zero markup change) on the bootstrap chunk converts internal same-origin navigations into `GET /_brust/page/{path}` fetches that return a JSON `{ html, title }` envelope. Rust's `handle_conn` strips the `/_brust/page/` prefix, resolves the route through the existing `routes.match_path`, and rewrites the envelope's `kind` field to `"navigation"` via `rewrite_envelope_kind` — same dispatch helper as render, same per-worker render slot. JS-side `navigationBranch` renders synchronously via `renderToString` and regex-extracts `<main>` inner content + `<title>` text (React 18 `<!-- -->` markers stripped). Client swap uses `DOMParser('text/html') + importNode` to inertly parse the trusted server response and replace `<main>`'s children, then re-runs `hydrateMarkersIn(main)` (refactored from the existing init loop with a `data-brust-hydrated` idempotence guard). `pushState` on click, `popstate` on back/forward. Every failure mode (network error, non-2xx, missing `<main>`, malformed JSON) silently falls back to `location.href = url` — user always navigates. Rapid clicks abort in-flight fetches via `AbortController` so only the last click wins. No author API change — demo Layout's `<main>` + nav links become SPA automatically. Deferred: prefetch on hover, View Transitions API, scroll restoration, `<Link>` component, POST navigation.
- `brust build` CLI emits a self-contained `./dist/` directory (`index.js` bundled with `Bun.build`, `islands/*` from pre-built chunks, `mcp-manifest.json`, `native/index.<triple>.node`). Run-phase: `bun run ./dist/index.js` boots without further build work. Two Bun.build plugins (native-shim, actions-prebuilt) replace the napi-rs platform shim and the filesystem-walking action scanner with prebuilt-aware variants during bundling. Banner injects `BRUST_PREBUILT=1` + `BRUST_DIST_DIR=import.meta.dir` so the runtime's `brust.run()` skips the build steps it would normally run on each boot. Identifier minification is disabled to keep `Component.name` stable — it is the React-path island's `data-brust-island` marker (and thus the chunk URL); whitespace + syntax minification still apply. Single platform per build; multi-platform output is a CI matrix concern not in scope. Dev flow (`bun run example/hello-world/index.ts`) unchanged.
- **Tailwind v4** — `<scanRoot>/app.css` convention; compiled programmatically via `@tailwindcss/node` (CSS-first config, user owns `@source` globs); output served at `/_brust/css/<file>` with `Cache-Control: public, max-age=3600`; SSR renderer auto-injects `<link rel="stylesheet">` before `</head>` on the first chunk. Build-only (no watch/HMR); dev mode compiles at boot.
- **`brust dev` tooling (partial)** — CLI subcommand for end-user hot-reload DX. File watcher on TS/TSX/HTML/CSS (no Rust). Synthetic `/_brust/dev` WS route prepended in dev mode; main-side `broadcast()` relays via `worker.postMessage` to workers, each worker forwards to its locally-connected dev clients. Dev client (`~80` LOC) inlined as `<script>` before `</head>` — connects WS, handles `reload`/`css-update`/`error`/`ok` messages, manages a red full-screen overlay on build errors. Hand-rolled ANSI TUI with plain-log fallback. Single-flight coordinator (change-during-build dropped). **Currently ships:** CSS edit → `<link>` hot-swap via `?v=<ms>` (no page reload); CSS / `app.css` syntax error → red overlay + auto-clear on next successful build; `SIGINT` clean exit. **Known limitation:** TS/HTML edits broadcast `reload` correctly but the Rust `WorkerPool` retains stale renderer entries after `Worker.terminate`, so the post-respawn server can hang on dispatch. Fix requires a small Rust napi (`napi_clear_pool`) — deferred. CSS-only workflows are usable today.
- **Component CSS imports + CSS Modules (partial)** — `import './foo.css'` (side-effect) and `import styles from './foo.module.css'` (hashed class-name map) for end-users. Build-time pipeline: scan TS/TSX with TypeScript compiler API → process each `.css`/`.module.css` through `lightningcss` (modules pattern `[local]_[hash]`) → emit `<distDir>/css/components/<sha8>.css` + co-located `.module.css.d.ts` → manifest at `<distDir>/css/component-manifest.json` maps source path → chunk + exports, plus `route.fullPath` → ordered chunk hrefs. A `Bun.plugin` registered in main + workers (before `buildIslands`) reads the manifest and resolves `.module.css` imports to `export default <name-map>` JS; SSR + client hydrate see identical hashes. Renderer combines `app.css` (global) + per-route chunks for the matched route and passes them to `injectCssLink`. Dev watcher distinguishes `component-css` from `app.css`; coordinator hot-swaps the link href on content-only edits and full-reloads on exports name-set change. Zero Rust changes. **Known limitation:** Bun's bundler emits `.module.css` as an additional output chunk with `[name]` derived by stripping at the first dot, which collides with same-basename entries (`Counter.tsx` + `Counter.module.css` → both want `Counter.js`). Verified via standalone spike — Bun bug, not a brust design issue. **Workaround:** route-level (non-island) components can import `.module.css` freely; islands stay on Tailwind/inline styles. Example demo (Counter migration) deferred until the upstream Bun behavior is resolved.
- **`brust new` scaffolding (partial)** — `brust new <name> [--dir <path>]` creates a fresh project at `./<name>/` from `runtime/cli/templates/minimal/`. Single template: TypeScript + Tailwind v4 + one hydrated island, plus `package.json`, `tsconfig.json`, `.gitignore`, `README.md`. `runtime/cli/new.ts` parses args, validates the project name (`/^[a-z0-9][a-z0-9_-]*$/`, max 50), checks the target dir is empty, resolves the brust dependency reference (`file:<abspath>` when the CLI runs from the brust source tree — detected via Cargo.toml + src/ + runtime/cli/index.ts markers — otherwise `^<version>`), copies the template with `__PROJECT_NAME__` and `__BRUST_DEP__` substitutions, renames `_gitignore` → `.gitignore`, strips `.tmpl` suffixes, prints next-steps. Root `package.json` gained an `exports` map (`'.'` → `./runtime/index.ts`, `'./routes'` → `./runtime/routes.ts`) so templates can `import from 'brust'`. 20 tests cover parseArgs, resolveBrustRef, copyTemplate, and the scaffold-output file tree. **Known limitation:** scaffolded projects can be created and `bun install`-ed but cannot run end-to-end (neither `bun run dev` nor `bun run build` + `bun run dist/index.js`) — dual-React copy. Bun's `file:` install symlinks individual source files back to the brust repo; React resolution from those symlinked files finds the brust repo's `node_modules/react` while user code (Counter.tsx etc) finds the scaffold's `node_modules/react` — two physical instances, `useState` hits `dispatcher null`. Fix is a separate sub-project: move brust to a Bun workspace where `example/hello-world` is a workspace member with its own React deps, removing React from the brust root's materialized `node_modules`.
- **Sub-project J — Native dynamic routes via minijinja** — `native: true` flag on a route compiles its JSX into a minijinja template at build time and renders it in Rust at request time. `jsx-rustc` (the `jsx-rust-compiler` crate's CLI, parser + IR + lower carried over from A1 T0–T6, emit target swapped to minijinja) writes `.brust/jinja/<Component.name>.jinja` during `brust build` / `brust dev`. Boot-time `napi_load_jinja_templates(".brust/jinja")` populates `crate::jinja::ENV: OnceLock<Environment>` (chainable undefined mode). Per request: JS worker runs the loader, `JSON.stringify`s the result into the SAB at offset 0, calls `napiRenderJinja(workerId, dataLen, name)`; Rust renders, assembles `[meta_len u16 BE][meta JSON][body]`, ships via `RenderChunk::BytesAndFinal` — the existing `BytesAndFinal` arm at `server.rs:1053` handles framing + write identically to a JS-produced chunk. Composes with `loader` + `middleware`; rejects `sse` / `websocket` / `children` / `cache`. Boot-time mismatch between `routes.tsx` and `.brust/jinja/*.jinja` logs a warning (`napi_list_native_templates`); request to a missing template 500s. See the Sub-project J section below for full architecture.

**Designed, not built:**

- `brust-cli invalidate` (project tooling — separate from the native endpoint that just shipped)
- Default TTL fallback in `[cache]` (semantics deferred — no current consumer)
- Islands: `"use island"` directive + auto-detection at JSX call sites (MVP uses manual `<Island>` wrapper)
- Islands: content-hashed filenames + production caching strategy
- Islands: CSS extraction per chunk
- Islands: hot reload during dev
- Global middleware (`app/middleware.ts`) + response-header *deletion* channel — per-route + set/override is shipped
- Single-binary deploy (`bun build --compile`) — feasibility unknown until tested with the `.node` bundling path
- TOML configuration `[cache]` + `[build]` sections (the `[server]` + `[workers]` part is shipped)
- Project tooling: `brust invalidate` (`build`, `dev` partial, `new` partial — see Built list); end-to-end usability of scaffolded projects waits on a brust-repo workspace restructure (see `brust new` limitation in the Built list)
- Retry on tsfn failure, PING/PONG health checks
- Sub-project J v2.x: cache integration for native routes (boot-time warn → hard panic), nested loader composition for native routes, hot reload of `.brust/jinja/` templates in dev, dev-mode React fallback when `.jinja` is missing, streaming render via `Environment::stream`, loader-side prop validation via jsx-rustc, JSX subset beyond A1 T0–T6 (conditional rendering, Fragment, custom components), adjacent-Text node merging in the emitter

**Deferred (no design yet):**

- Multi-thread tokio runtime (Brust is single-thread Rust today)
- N slots per worker for loader-bound workloads
- HTTP/2
- TLS termination
- Native client wrapper (Tauri / RN) beyond noting it as an option
- Graceful shutdown / drain (SIGINT handled JS-side via `process.exit`)

---

## Sub-project J — Native dynamic routes via minijinja (2026-05-29)

**Shipped.** Routes flagged `native: true` are compiled at build time from their JSX source into minijinja templates and rendered in Rust at request time — no React, no JS render-tree, no per-request `renderToString`. The page's loader still runs in the JS worker (full middleware + `req` access), but its return value is shipped over SAB as JSON and rendered against a pre-loaded minijinja `Environment` inside the napi call. Earlier exploration on this surface (Sub-project A1's JSX→Rust compiler + A1.1 render benches + A2.3's hardcoded short-circuit) has been retired and replaced by Sub-project J; the `jsx-rust-compiler` crate's parser + IR + lower (A1 T0–T6) carry forward verbatim, only the emit target changes.

### Authoring

```tsx
// pages/Profile.tsx
export default function Profile({ user }: { user: string }) {
  return <div><h1>Hello, {user}!</h1></div>
}

// routes.tsx
import Profile from './pages/Profile'
export const routes = defineRoutes([
  { path: '/u/{name}', Component: Profile, native: true,
    loader: async ({ params }) => ({ user: params.name }) },
])
```

The `Component` body is real React code — same as a non-native route. `jsx-rustc` parses the JSX subset (function components + destructured props + lowercase HTML + `{ident/member}` + `xs.map((item) => <JSX>)`) and emits a `.brust/jinja/Profile.jinja` template. The loader's return value is the template's variable scope. `native: true` composes with `loader` + `middleware`; it rejects `sse` / `websocket` / `children` / `cache` (cache integration for native routes is a v2.x follow-up).

### Build pipeline

`runtime/cli/build.ts` (and `dev.ts` watcher) scans `routes.tsx` for entries with `native: true`, resolves each `Component`'s source path by AST-walking the routes module's `ImportDeclaration`s via swc, then spawns `jsx-rustc <source.tsx> --target jinja -o .brust/jinja/<Name>.jinja`. The output directory is gitignored alongside `.brust/css/` and friends. A `_manifest.json` lists every built template so the runtime can validate at boot. The build is dialect-strict — any JSX construct outside A1 T0-T6's covered subset (conditional rendering, Fragment, custom components) errors at build time.

### Runtime — boot

The main thread calls `napi_load_jinja_templates(".brust/jinja")` once during startup. The Rust side reads every `*.jinja` file, builds a `minijinja::Environment` (chainable undefined mode — chained access through optional props doesn't error, but direct render of an undefined var does), and stores it in `crate::jinja::ENV: OnceLock<Environment>`. A companion `napi_list_native_templates()` returns the loaded template names so the JS bootstrap can warn (today) / panic (future) on routes whose `Component.name` doesn't appear in the manifest.

### Runtime — per request

1. Accept loop matches the request via `routes.match_path`; the per-route envelope's `nativeTemplate: string` field is set by `RouteTable::native_template_for(route_id)`.
2. Existing `dispatch_to_worker_and_stream_chunks` path ships the envelope to the chosen Bun Worker via the renderer tsfn — same SAB, same per-worker `render_slot`.
3. Worker dispatcher in `runtime/routes.ts` sees `nativeTemplate` set, branches off the React path: runs middleware → runs the loader → `JSON.stringify(data ?? {})` → writes the JSON bytes into the SAB at offset 0 → calls `napiRenderJinja(workerId, dataLen, templateName)`.
4. Rust `napi_render_jinja` reads `&sab[0..dataLen]` (BufPtr already captured at register time), passes it as the variable scope to `Environment::get_template(name)?.render(...)`, and assembles `[meta_len: u16 BE][meta JSON][body]` in the same SAB-envelope shape JS produces in `emitSingleChunkResponse` (`runtime/routes.ts:818-862`).
5. The bytes ship as `RenderChunk::BytesAndFinal { data, ack }` through the existing chunk channel.
6. The per-conn task at `server.rs:1053` (the `BytesAndFinal` arm) calls `split_meta(&data)` unconditionally — the same path JS-produced chunks already take — then `build_single_response_bytes(&meta, body)` frames the wire HTTP/1.1 response and writes it to the socket. No new IPC primitive; no bypass.

### What `jsx-rust-compiler` keeps from A1

| A1 task | Status in J |
|---|---|
| T0 — bootstrap (Cargo + swc_core 68) | KEEP |
| T1 — swc parser (TsSyntax tsx: true) | KEEP |
| T2 — `CompileError` / `ErrorKind` taxonomy | KEEP (relax `VoidElementHasChildren` — jinja accepts void with content) |
| T3 — IR + zero-prop happy-path lower | KEEP |
| T4 — destructured props + ident/member exprs + type inference | KEEP |
| T5 — `.map((item) => <JSX>)` lowering | KEEP |
| T6 — attr rename precedence + whitespace | KEEP attr rename + whitespace; relax void check |
| T7 — IR → string emit | **REPLACED** with `emit_jinja.rs` |
| T8 — fixtures + golden_emit | REWRITTEN for jinja |
| T9 — golden_render | REWRITTEN against minijinja |
| T10 — `jsx-rustc` CLI | UNCHANGED at arg level; output extension `.jinja` |

The A1.1 render-only bench (`crates/jsx-rust-compiler/src/bin/jsx-bench.rs`) was retired alongside the prior emit target — render throughput now lives in the real request path, not a synthetic harness. Spec acceptance §11.7 sets a **≥60k RPS floor** on `/jinja-test/X` measured via `oha -c 120 -z 10s` (90k+ stretch goal).

### Suggested next steps (v2.x deferrals)

Spec §12 + §14 acknowledge the following as out of scope for v2 and tracked as follow-ups:

- Cache integration for native routes (today the `cache` field is rejected at validation time; reviewer Fix 1's boot-time warn matures into a hard panic).
- Nested loader composition for children of native routes (today only the leaf's loader runs).
- Hot reload of `.brust/jinja/` templates during `brust dev` (today `ENV` is a `OnceLock`; template edits require a restart).
- Dev-mode React fallback when the matching `.jinja` is missing (today the boot warning becomes a request-time 500).
- Streaming render via `Environment::stream` (today renders sync to a String).
- Loader-side prop validation via jsx-rustc parsing the loader's return type.
- JSX subset beyond A1's T0–T6: conditional rendering (`{cond && <X/>}`), `Fragment`, custom components.
- Spec §5 adjacent-Text node merging — the current emitter doesn't merge adjacent text; `lower.rs` handles the common case.

Spec: `docs/superpowers/specs/2026-05-28-minijinja-dynamic-routes-design.md`. Plan: `docs/superpowers/plans/2026-05-29-minijinja-dynamic-routes-plan.md`.

---

*Brust — Built to burst.*
