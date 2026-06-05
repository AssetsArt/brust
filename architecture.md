# Brust — Architecture

**B**un + **Rust** — an SSR framework that brusts.

React renders on the server inside Bun Worker threads; everything around it —
the HTTP listener, routing, caching, the native-route template engine — is Rust,
loaded into one Bun process as a `.node` module via napi-rs. Worker render output
crosses back to Rust through a per-worker `SharedArrayBuffer`, never through a V8
marshal.

It is also **agent-first**: a Brust app ships a Model Context Protocol server at
`POST /_brust/mcp` that exposes its `defineActions` endpoints as tools and its
route loaders as resources, extracted from the app's own types at boot — agents
drive the app through typed contracts, not DOM scraping.

Current line: **0.1.x-alpha** (npm `brustjs` + 6 platform packages + `create-brustjs`).

---

## Hosting model

One OS process. Bun is the host; Rust is a `cdylib` (`brust.node`) loaded into
it. The HTTP accept loop and all request parsing run on a dedicated Rust thread;
React renders are dispatched into Bun Worker threads via a napi
`ThreadsafeFunction` (tsfn) and their HTML returns through shared memory.

| Concern | Owner |
|---|---|
| HTTP/1.1 + HTTP/2 listener | **Rust** (hyper 1.x + hyper-util, multi-thread tokio) |
| Connection concurrency | **Rust** (`tokio::spawn` per conn, `Semaphore` accept cap) |
| Routing / cache / native templates | **Rust** (`matchit`, `moka`, `minijinja`) |
| React render workers | **Bun Worker threads** — one V8 isolate each, `renderSlots` in-flight |
| Render dispatch (cross-thread) | **napi-rs 3.x** `ThreadsafeFunction` (request = inline JSON String) |
| Render RESPONSE transfer | per-slot `SharedArrayBuffer` sub-region (no V8 marshal) |

Why this shape: a traditional SSR stack renders HTML, ships the whole framework
bundle, then re-runs everything to hydrate. Brust renders once in Rust-fronted
workers, hydrates only the islands you mark, and serves cache hits and native
routes without ever waking a worker.

---

## Process & thread layout

```
Bun process (one OS process)

  Main thread (TS host) — runtime/index.ts → brust.run({ routes, entry, actions })
    ├─ register actions / build islands / compile native routes (build or boot)
    ├─ napi.beginServe({ port, workers })        → spawn the Rust accept thread
    ├─ for i in 0..N: new Worker(entry, BRUST_WORKER_ID=i)
    └─ await napi.untilReady(timeout)            # every worker registered, or exit(1)

  Worker threads × N  (N = os.availableParallelism(), or [workers].count / BRUST_WORKERS)
    const sab = new SharedArrayBuffer(256 KB × renderSlots)   # module-scope root
    brust.registerRenderer(new Uint8Array(sab), renderSlots, renderer)  # renderer = runtime/routes.ts::makeRenderer
      renderer parses the request envelope (an inline JSON String), runs
      middleware + loader, renders (React or native), writes
      [meta_len u16 BE][meta JSON][body] into its render slot's SAB sub-region.
      renderSlots > 1 lets one worker hold N renders in-flight (see IPC below).

brust.node (napi cdylib, same process)

  tokio multi-thread runtime (workerThreads = min(parallelism, 4) by default)
    TcpListener.accept() → Semaphore(conn_queue_cap) → tokio::spawn(conn task)

  connection task × (hyper, per socket)
    hyper auto::Builder (HTTP/1.1 + HTTP/2) → service_fn(handle_request)  # keep-alive

  handle_request (per request)
    /ping            → static "pong\n"                       (no JS, no napi)
    routes.match_path → 404 if no match                      (no worker)
    cache hit        → return stored response bytes          (no worker)
    else             → claim a render slot, dispatch envelope via tsfn,
                       drain rendered chunks from the slot's SAB sub-region
```

---

## Request lifecycle

```
T0  client connects (TCP, keep-alive)
T1  listener.accept() → Semaphore permit → tokio::spawn connection task
T2  hyper serves the connection (HTTP/1.1 or HTTP/2) → handle_request per request
T3  hyper parses method/path/headers (oversized headers → 431)
T4  /ping        → static response                             (no JS)
T5  routes.match_path(method, path)
      no match   → 404                                        (no worker)
T6  cache lookup (only if the route opted into `cache`)
      hit        → return stored wire bytes                   (no worker)
T7  claim a render slot (atomic per-slot CAS) → dispatch the inline JSON envelope via the renderer tsfn
      Bun Worker wakes: middleware → loader → render
        React route  → renderToString / renderToPipeableStream
        native route → minijinja render in Rust (worker only JSON.stringify's loader data)
      worker writes [meta_len][meta JSON][body] into its slot's SAB sub-region
T8  Rust drains chunk(s) from the slot's SAB sub-region:
      split_meta → build_single_response_bytes(status, headers, body) → write_all
      (Suspense-streaming routes write multiple chunks, chunked transfer-encoding)
T9  store in cache if the route opted in; back to T3 (keep-alive)
```

Distinct status paths: `200`/`500`/`502` are emitted inline in `server/mod.rs`;
`400`/`404`/`405`/`431`/`503` come from `server/body.rs` typed builders. A render
throw becomes a `500` without killing the worker; a tsfn dispatch failure is a
`502` and evicts the worker from the pool.

---

## IPC: napi tsfn + SharedArrayBuffer

The render result never round-trips through V8 serialization. Each worker owns a
256 KB `SharedArrayBuffer`, rooted in module scope; Rust captures its raw pointer
once at `registerRenderer` time and reads the bytes directly after the render
promise resolves.

```
                       Bun Worker                 napi               Rust
request envelope   String (JSON)        → tsfn queue (cross-thread) → String
render output      write bytes into SAB → (no V8 marshal)           → read at ptr,len
signal             resolve Promise<u32> → await yields the length   → slice the SAB
```

**Copy count for `/` (React SSR):**

| Hop | Bytes | Note |
|---|---|---|
| path/envelope V8 → Rust `String` | ~tens of B | tiny, unavoidable |
| html V8 → SAB (`TextEncoder.encodeInto`) | full body | one UTF-8 pass, inside the worker |
| SAB → response `Vec<u8>` | full body | Rust-local memcpy (~10 GB/s on M1) |
| response → kernel (`write_all`) | full body | one syscall |

"No V8 marshal" means napi doesn't re-encode the HTML at the boundary — not that
the path is zero-copy end to end. (A `writev` attempt to remove the response
memcpy regressed p99 on macOS and was reverted; the SAB→Vec copy stays.)

**SAB is RESPONSE-only; the request is Inline.** The request envelope crosses as
a napi `String` (see the table above), never via the SAB. Routing the request
*through* the SAB was tried twice and closed both times — under the multi-thread
runtime the Rust-side write was not reliably visible to the worker (it read a
stale prior response as the request), and it bought nothing (both paths
serialize + `JSON.parse` regardless). The SAB carries only the worker's response,
where Rust is the reader with atomic semantics under its own control. See the
`render::dispatch` module doc for the full post-mortem; do not reintroduce
SAB-request.

**SAB layout & safety.** The backing store lives outside V8's GC heap and is
stable for the worker's lifetime. Rust reads it only *after*
`tsfn.call_async(..).await` resolves — i.e. after the worker has returned from
the render callback — so napi's tsfn provides the happens-before edge and there
is no concurrent writer. The `BufPtr` wrapper in `dispatch_impl.rs` carries an
`unsafe impl Send + Sync` with this argument documented inline. The SAB is sized
`256 KB × renderSlots` and partitioned into `renderSlots` **disjoint** sub-regions
(one per slot, via `RenderDispatch::buf_slot`); a render in slot *i* reads/writes
only its sub-region, so concurrent renders on one worker never alias. At
`renderSlots = 1` the sole sub-region is the whole buffer — byte-identical to the
single-slot layout. A render that returns `0` or a length outside `(0, sub-cap]`
is a `500` ("oversized") — no spillover path yet.

**Render slots = N concurrent renders per worker** (`tuning.renderSlots`, default
1). napi dispatches tsfn callbacks onto the worker's one V8 isolate, so renders
still serialize on CPU — but a render that *yields* (Suspense / an `await`ed
loader) frees the isolate for a peer render on another slot. So `renderSlots > 1`
overlaps the I/O waits of concurrent requests on a single worker: a measured
~7× throughput on a Suspense route, while purely CPU-bound pages are unaffected
(they serialize either way). Each slot has its own SAB sub-region + chunk channel,
so the responses never cross. Default 1 keeps the historical one-render-per-worker
behaviour; raise it for Suspense/loader-bound apps. SSE/WS are unaffected (they
own their socket and never touch the SAB).

---

## HTTP layer

The server is **hyper 1.x** (`hyper-util` `auto::Builder`, HTTP/1.1 **and**
HTTP/2 auto-negotiated) on a **multi-thread tokio runtime**. A `service_fn`
(`handle_request`) returns `Response<BoxBody>`; the accept loop `tokio::spawn`s a
connection task per socket, bounded by a `Semaphore(conn_queue_cap)` for accept
backpressure. The tokio runtime thread count is `tuning.workerThreads`
(default `min(available_parallelism, 4)`) — these are I/O threads, separate from
the Bun render workers.

- **Per connection:** hyper owns keep-alive, chunked bodies, header parsing
  (no hand-rolled `httparse`), and `Content-Length`/`Date`/header ordering.
  WebSocket upgrades go through `hyper::upgrade::on`; SSE is a streaming body.
- **Response:** the render bytes become a `Full`/`StreamBody` `BoxBody`; hyper
  writes them. Oversized request headers → `431`.
- **Optional TLS:** `tokio-rustls` terminates TLS in-process when
  `tlsCertPath` + `tlsKeyPath` are set (ALPN `h2` + `http/1.1`; `tlsMinVersion`
  `"1.2"`/`"1.3"`). Off by default — plaintext is byte-equivalent.

> **Containers:** the old `tokio_uring` (Linux) runtime panicked under default
> seccomp (`io_uring_*` syscalls denied). That is GONE — plain multi-thread tokio
> runs everywhere, no seccomp exception needed.

Not built: graceful drain, daemonisation.

---

## Worker pool

```
worker-i :  tsfn_i   SAB_i (256 KB × K)   slots: Vec<Slot>   in_flight: AtomicU32
            Slot { idle: AtomicBool, render_slot: Mutex<Option<chunk_tx>> }  × K
```

The pool (`pool.rs`) registers a worker (with its `renderSlots` count `K`) when
it calls `registerRenderer`, claims a free *slot* per render, and evicts a worker
whose tsfn dies (`process::exit(1)` if the pool empties — no respawn yet).

**Render dispatch is atomic per-slot claim.** Each worker holds `K` slots (pure
concurrency permits; `K = renderSlots`, default 1). `try_claim_render` scans for a
slot whose `idle` `AtomicBool` is `true`, CASes it `true→false` (Acquire), installs
the chunk sender, and bumps `in_flight`. The returned `RenderClaim` carries the
slot index; its `Drop` clears the slot's chunk_tx, decrements `in_flight`, then
publishes `idle = true` (Release) — order is load-bearing, and the slot is NOT
released until the render promise has settled (else a recycled slot's new request
could race the old render). Two renders can't claim the same slot; `K` renders
*can* run concurrently on one worker (the multi-render path). `ClaimResult::PoolEmpty`
vs `AllBusy` give distinct 503 bodies (misconfig vs overload). SSE/WS use
`pick_least_busy` + an `in_flight_guard` instead — they own their socket and never
touch the SAB. (A 16-contender/4-worker two-barrier regression test guards the
claim against TOCTOU, plus a K-slot variant proving K concurrent claims on one
worker land on distinct slots.)

**Worker count = `os.availableParallelism()`** — one worker per core. CPU-bound
React renders saturate a core each; oversubscribing (a former `× 1.8` default)
amplified p99 ~6× once per-render work grew past ~150 µs. Override via
`BRUST_WORKERS` or `[workers].count`. For Suspense/await-heavy apps, prefer
raising `renderSlots` (concurrent renders per worker) over adding workers — it
overlaps I/O waits without oversubscribing cores.

---

## Routing & the request model

```tsx
// routes.tsx
import { defineRoutes, type Middleware } from 'brustjs'
export const routes = defineRoutes([
  { path: '/',            Component: Home },
  { path: '/blog/{slug}', Component: BlogPost,
    loader: async ({ params }) => ({ post: await db.post(params.slug) }),
    cache:  { ttl_seconds: 60, vary: ['accept-language'] } },
  { path: '/crash',       Component: Crash, errorBoundary: CrashBoundary },
  { path: '/admin', Component: AdminLayout, middleware: [authRequired], children: [
    { index: true,           Component: Dashboard },
    { path: 'users/{id}',    Component: UserDetail },
  ]},
])
```

Pattern syntax is **matchit 0.8** (`{slug}`, not `:slug`). `defineRoutes` pins
the element type and flattens `children` into the flat list Rust sees — nesting
is a JS-side authoring convenience.

- **Where matching happens:** Bun ships the pattern array to Rust at boot
  (`registerRoutes`); Rust builds a `matchit::Router<u32>` keyed by route index
  (`routes.rs`). `handle_conn` matches in Rust and builds the envelope
  `{ route_id, path, params, nativeTemplate?, req: { method, url, headers,
  cookies, search } }` — headers lower-cased, cookies + query parsed once. No
  match → 404 without waking a worker. The tsfn signature is unchanged; only the
  `String` content is now an envelope.
- **Loaders:** `loader: ({ params, path, req }) => data`; the result is the
  component's `data` prop (and, for native routes, the template scope).
- **Error boundaries:** a route may declare `errorBoundary:
  ComponentType<{ error }>`. A component/loader throw renders it in place with
  `status = 500`; it inherits down the nesting chain (leaf wins).
- **Nested routes:** `children`, `<Outlet/>`, `{ index: true }`, layout-only
  parents (`path: ''`); middleware composes parent → child; each component sees
  only its own loader's data.

---

## Middleware

Per-route interceptors wrapping loader + render: `async (req, next) =>
RouteResponse`, in declaration order (entry `[0]` outermost). A middleware may
short-circuit (return without `next()`) or call `next()` and mutate the
response.

```tsx
const authRequired: Middleware = async (req, next) =>
  req.cookies['user'] ? next()
    : { status: 401, body: 'unauthorised', headers: { 'WWW-Authenticate': 'Cookie' } }
```

Mechanism: the worker writes `[meta_len u16 BE][meta JSON][body]` where
`meta = { status, headers? }`; Rust frames the wire response from it,
CRLF-guarding injected headers and skipping collisions with fixed headers.
Brust ships **no** session/auth primitive — apps wire their own. Cache lookup
runs *before* middleware, so only combine `cache` with deterministic middleware.
Not built: global `app/middleware.ts`, header *deletion*.

---

## Cache

Brust has **two independent caches**, each its own crate dependency and store:

| | Route cache | ISR fragment cache |
|---|---|---|
| Module | `cache.rs` | `island_cache.rs` |
| Backend | `lru` 0.18 (`LruCache` + `Mutex`) | `moka` 0.12 (`MokaStore`, `CacheStore` trait) |
| Caches | whole wire responses | server-rendered island / SSR-component HTML fragments |
| Key | `method + path + query + vary` | a developer-supplied string |
| Opt-in | `cache:` on a route | `isr={{ key, … }}` on a fragment |
| Invalidate | by path / all | by key / tags |

The route cache is below; the moka-backed ISR cache is detailed in
[ISR cache](#isr-cache--ssr-islands--ssr-components).

### Route cache (LRU)

A bounded LRU (default 1000 entries, `[cache] max_entries`) keyed on
`method + path + sorted_query + selected_vary_values`. **Opt-in per route** —
omit `cache:` and the route never caches (so authed pages never serve another
user's HTML). Hits respond entirely from Rust (no tsfn call); misses store the
full wire bytes — including middleware-mutated headers — so the next hit is one
`write_all`.

- `cache: { ttl_seconds, vary?: string[] }` — lazy TTL eviction on read; each
  `vary` header value joins the key.
- `GET /_brust/cache/stats` → `{ hits, misses, len, capacity }`.
- `POST /_brust/cache/invalidate?path=/foo` (purge a path) / `?all=1` (clear);
  returns `{ removed: N }`, counters survive. Unauthenticated by design — gate
  `/_brust/*` at your proxy if exposed.

Implementation: `cache.rs` wraps `lru::LruCache` behind a `parking_lot::Mutex`,
between `match_path` and worker dispatch; hit/miss counters are lifetime atomics.
Only **single-chunk** responses are cached — a Suspense-**streamed** (chunked)
response isn't stored, since chunked framing is ambiguous to replay.

---

## Islands — on-demand hydration

Islands are declared at point of use with an explicit `<Island>` wrapper and are
**component-addressed**: the chunk key is the `component={X}` identifier — no
`id`, no registry. A page with no islands ships zero JS.

```tsx
import Counter from './Counter'
<Island component={Counter} props={count} hydrate="visible" />   // client-only mount
<Island component={Counter} props={count} hydrate="load" ssr />  // + server-rendered markup
```

- **Render:** `island.tsx` embeds SSR HTML inside a `data-brust-island="<Name>"`
  marker (with `data-brust-props`, `data-brust-hydrate`); a client-only island
  gets an empty `data-brust-csr` mount. Multiple `<Island>` may reuse one
  component — each occurrence gets a source-order `instance` for its
  `island_<instance>_props/_html` slot.
- **Triggers:** `load` / `idle` (`requestIdleCallback`) / `visible`
  (`IntersectionObserver`) / `interaction` (first `pointerdown`).
- **Build:** `scanIslandChunks(routes.tsx)` resolves each `component={X}` to its
  source; `buildIslands` runs `Bun.build` → one shared `_react.js`
  (react + jsx-runtime, ~7 KB), one `_react-dom.js` (~136 KB, react external),
  N island chunks (all runtime modules external), one bootstrap. Output to
  `.brust/islands/`, served by the native route `GET /_brust/islands/<file>`
  (`max-age=3600`, strict filename safety). `makeRenderer` injects an importmap +
  the bootstrap only when a page used an island.
- **Constraints:** island component names must be unique app-wide (the name is
  the chunk key); filenames are predictable, not content-hashed (fingerprint at
  the CDN for prod). `react`/`react-dom` are `peerDependencies` so only the
  app's single copy installs.

---

## Isomorphic store (`brustjs/store`)

A tiny framework-agnostic reactive core + a named-store abstraction that is the
single source of truth for shared client state, with correct per-request
isolation on the server.

```ts
// signal / computed / effect / batch — pull-based, push-on-write, sync notify
import { signal, computed, defineStore } from 'brustjs/store'

export const teamStore = defineStore('pokedex.team', () => ({
  members: signal<Member[]>([]),
  count: computed(() => /* … */ 0),
}))
```

- **Reactive core** (`runtime/store/signal.ts`): `signal` (callable read + `.set`),
  `computed` (memoised, lazy), `effect` (re-runs on tracked change, returns a
  disposer), `batch`. `Object.is` write guard.
- **`defineStore(name, factory)`** returns a handle that is also a property proxy
  over the *active* instance:
  - **client** — one instance per `name` on `window.__BRUST_STORES__` (so two
    separately-built island/directive chunks resolve the **same** object — fixes
    GAP S4),
  - **server** — a per-request instance in an `AsyncLocalStorage` scope (two
    concurrent requests never see each other's writes — fixes GAP S6;
    out-of-scope access throws).
- **Cross-chunk identity is load-bearing.** Each island / the directive runtime is
  a separate `Bun.build` that inlines its own copy of `signal.ts`. So the brands
  (`isSignal`/`isComputed`) AND the dependency-tracking context
  (`activeConsumer`/batch/pending-notify) live in **global** registries
  (`Symbol.for('brust.signal')`, `Symbol.for('brust.reactive.ctx')`), never
  module-local — otherwise an `effect` in chunk B can't track a `signal` created
  in chunk A (a native directive button wouldn't react to a store a React island
  mutated). Verifiable only in a real browser with ≥2 chunks.
- **Snapshot** serialize → `<script type="application/json" data-brust-store>` →
  client hydrate, injected on the **React render paths**; native pages currently
  seed via a loader/`init()` fetch (SSR snapshot injection into native HTML is
  deferred). `useStore(store)` (a `useSyncExternalStore` adapter, exported from
  `brustjs/client`) lets React islands consume a store with no authoring change.
- **No Rust, no compiler involvement** — pure TS.

---

## Server actions (treaty client)

Typed HTTP endpoints declared with a chained `defineActions(...)` builder and
called from an island via an end-to-end-typed `client<Actions>()` proxy — same
types both sides, no separate API schema, no codegen.

```tsx
// actions.ts — an EXPLICIT module the app imports
import { defineActions } from 'brustjs'
import { z } from 'zod'

export const actions = defineActions()
  .post('/notes', ({ body }) => ({ id: 'n-' + body.text.length }), {
    body: z.object({ text: z.string().max(1000) }),
  })
  .get('/whoami', ({ req }) => ({ user: req.cookies['user'] ?? null }))
  .delete('/notes/{id}', ({ params }) => ({ ok: true, id: params.id }), {
    middleware: [requireUser],
  })
export type Actions = typeof actions

// index.ts — wire actions into the server
await brust.run({ routes, entry: import.meta.url, actions })

// in an island:
import { client } from 'brustjs/client'
const api = client<Actions>()
const { data, error } = await api.notes.post({ text })   // POST /_brust/action/notes
const { data } = await api.whoami.get()                  // GET  /_brust/action/whoami
await api.notes({ id }).delete()                         // DELETE /_brust/action/notes/{id}
```

- **Declaration:** `defineActions().get/post/put/patch/delete/head(path, ctx => R, opts?)`.
  The handler receives a context object `{ req, body, params, query, headers, respond }`.
  `opts.body` / `opts.query` are [Standard Schema](https://standardschema.dev)
  validators (e.g. zod); `opts.middleware` attaches a per-endpoint chain, and
  `.use(mw)` adds a builder-global one. Path params use `{id}` syntax. Actions are
  an explicit module passed to `brust.run({ actions })` — there is no filesystem
  scan and no build-time codegen.
- **Transport:** `METHOD <prefix>/<path>` over the same accept loop + worker pool
  as renders. Default prefix `/_brust/action`, configurable via the `actionPrefix`
  option to `brust.run` / `brust.serve`. Request bodies decode by content-type —
  `application/json` (default), `application/x-www-form-urlencoded`, and
  `multipart/form-data` (→ object with `File` entries) — into a plain object
  *before* schema validation; JSON return out; 256 KB body cap. The Rust action
  router matches method + path: unknown path → 404, known path + wrong method →
  405. Body schema failure → 422, malformed body → 400.
- **Client:** `client<Actions>(opts?)` builds a treaty proxy. Static segments
  accumulate (`api.notes` → `/notes`); a function call fills `{param}`s positionally
  (`api.notes({ id })` → `/notes/<id>`); a terminal `.get/.post/...` performs the
  request. It returns `{ data, error, status, headers, response }` and **never
  throws on an HTTP status** — branch on `error`. A body carrying a top-level
  `File`/`Blob` (or a `FormData`) is auto-sent as `multipart/form-data`;
  otherwise JSON. `opts.prefix` overrides the base (absolute URL needed for
  server-side `fetch`); in the browser the prefix is auto-discovered from an
  injected `globalThis.__BRUST_ACTION_PREFIX__` when the app sets a custom
  `actionPrefix`. `opts.headers` / per-call `{ headers }` thread request headers;
  `opts.fetch` injects a fetch impl.

Not built: build-time client RPC auto-rewrite, a shared client chunk,
route-middleware inheritance, streaming uploads.

### Known limitations / deferred

- **Multipart edge cases.** Single files via a top-level `File`/`Blob` work
  end-to-end (client → wire → `Object.fromEntries(formData)` → schema). A `File`
  **nested** inside a sub-object isn't detected (goes through JSON, serializes to
  `{}`), and repeated form fields collapse to the last value (no arrays yet).
- **Custom-prefix browser injection covers the React-SSR render path only.** The
  `__BRUST_ACTION_PREFIX__` global is spliced into HTML by the SSR renderer;
  native/jinja routes don't bake it (the prefix isn't a build-time input), so a
  client on a native page with a custom prefix must pass `prefix` explicitly.
  Server-side callers always pass it explicitly.
- **HEAD ships a response body.** `.head` endpoints run like `get`; the Rust
  single-chunk writer does not strip the body for HEAD (RFC-correct stripping
  would be a separate Rust change).

---

## Real-time: SSE & WebSockets

Both ride the one accept loop, dispatched out-of-band (no SAB per connection).

```tsx
{ path: '/events',     sse: (req) => ReadableStream<string | Uint8Array> }
{ path: '/ws/chat',    websocket: () => import('./ws/chat') }  // { open, message, close }
```

- **SSE:** one tsfn call per connection for the stream's lifetime + per-chunk
  `napiSseWrite` with a `oneshot` ack for TCP backpressure. Middleware runs once
  pre-open (reverse `napiSseSignalOpen`); Rust writes `text/event-stream` +
  `Cache-Control: no-store` + `X-Accel-Buffering: no` only after the 200 verdict,
  plus a 15 s heartbeat (`sseOptions.heartbeatMs=0` to opt out). `req.signal` is
  a real `AbortSignal` that fires on disconnect.
- **WebSocket (RFC 6455):** Rust validates the handshake, runs middleware
  (4xx or 101 + chosen subprotocol via `napiWsSignalOpen`), then wraps the socket
  with `tokio-tungstenite`. A per-conn `tokio::select!` covers JS-pushed sends
  (mpsc + oneshot ack), incoming frames (Text→string, Binary→Uint8Array), and a
  ping ticker (30 s; 2× window → close 1011). Handlers: `{ open, message, close }`
  + `WsSocket { send, close, id }`; one connection pins to one worker.

MVP: literal SSE/WS paths only (no `/ws/{room}` params, no built-in pub/sub — wire
Redis/NATS yourself).

---

## HTML streaming

`renderToPipeableStream`, auto-detected per request. A route whose tree has no
pending Suspense at `onShellReady` emits one Content-Length chunk (byte-identical
to the non-streaming path); a route with pending Suspense streams via HTTP/1.1
chunked transfer-encoding.

The worker writes each chunk into the SAB at **offset 0** and signals length via
`napiRenderChunk(workerId, len)` (`len=0` = final). A per-worker
`render_slot: Mutex<Option<RenderSlot>>` carries the chunk channel, RAII-clamped
against tokio cancellation. Rust drains each chunk to the socket *before* acking,
giving the worker explicit backpressure. The cache only stores single-chunk
responses (chunked framing is ambiguous to replay).

---

## Navigation — SPA without author work

The bootstrap chunk installs a global `<a>` click interceptor: same-origin
internal links become `GET /_brust/page/{path}` fetches returning
`{ html, title }`. Rust strips the prefix, resolves through the same
`match_path` + render slot (envelope `kind: "navigation"`), and the worker
`renderToString`s, extracting `<main>` inner HTML + `<title>`. The client swaps
`<main>`'s children (inert `DOMParser` parse + `importNode`), re-runs island
hydration (idempotent via `data-brust-hydrated`), and `pushState`s. Every failure
mode falls back to a full `location.href` navigation; rapid clicks abort
in-flight fetches. No author API. Deferred: hover prefetch, View Transitions,
`<Link>`, scroll restoration.

---

## Native routes & the JSX→minijinja compiler

A route flagged `native: true` is compiled from its JSX **at build time** into a
minijinja template and rendered **in Rust** at request time — no React tree, no
per-request `renderToString`. The loader still runs in the worker (full
middleware + `req`); its return value is `JSON.stringify`d into the SAB and
becomes the template scope.

```tsx
// pages/Profile.tsx
export default function Profile({ user }: { user: string }) {
  return <div><h1>Hello, {user}!</h1></div>
}
// routes.tsx
{ path: '/u/{name}', Component: Profile, native: true,
  loader: async ({ params }) => ({ user: params.name }) }
```

`native: true` composes with `loader` + `middleware`; it rejects `sse` /
`websocket` / `children` / whole-route `cache`.

### Compiler pipeline (`crates/jsx-rust-compiler`)

```
parser.rs   swc parse (TsSyntax tsx) → ParsedSource
ir.rs       JsxNode / Expr  (Element, Text, Expr, Map, Cond, ChildrenSlot,
                             Island, SsrComponent, Document)
lower.rs    AST → IR; gated inline expansion (see "native inline")
analyze.rs  inlinability gate (hook / side-effect scan)
emit_jinja.rs   IR → minijinja template   ({{ … }}, {% for %}, {% if %}, slots)
emit_factory.rs IR → JS factory for SSR components
lib.rs      compile_full; ComponentMeta / IslandMeta collection
```

Invoked two ways: the **`jsx-rustc` binary** (build CLI, no inline) and the
**NAPI `compileJsx(source, path, componentSources?)`** (the `brust build`
native-route path — threads component sources for inline, returns
`warnings: string[]`). The build emits `<outDir>/jinja/<Name>.jinja` (+
`.islands.json` / `.components.json` / `.factory.ts` as needed) and a
`_manifest.json` — INTO the build output (`dist/jinja`), alongside
islands/css/mcp, so a dist-only deploy ships them, AND mirrors the same dir to
`cwd/.brust/jinja` so the non-prebuilt source runtime (`bun run <entry>`) and
`bun run dev` find templates after a build without a separate compile step.
Boot loads them into `crate::jinja::ENV: OnceLock<Environment>` (from
`<distDir>/jinja` for a pre-built run, `cwd/.brust/jinja` in dev/source) and
warns on `routes.tsx` ↔ template mismatches.

**Per request:** the matched envelope carries `nativeTemplate`; the worker runs
middleware + loader, `JSON.stringify`s the data into the SAB, and calls
`napiRenderJinja(workerId, dataLen, name)`; Rust renders against the loaded
`Environment` and frames `[meta_len][meta JSON][body]` through the same chunk
channel a JS render uses — no special IPC.

### SSR components

A native route may use capitalized components (`<Layout>`, `<Card>`). By default
each lowers to a **JS-worker factory**: the compiler emits a
`{{ comp_<N>_html | safe }}` jinja slot + a generated `.factory.ts`
(`emit_factory.rs`); the worker fills each slot via `(ctx) => h(Layout, props)` →
`renderToString`, once per request. Named + `{...spread}` props and children are
supported, and a nested `<Island>` inside an SSR component still hydrates.
Artifacts: `<Name>.components.json` + `<Name>.factory.ts`.

### Conditional rendering

`{cond && <X/>}`, `{cond ? <A/> : <B/>}`, and top-level `if (…) return …` lower
to `JsxNode::Cond` → minijinja `{% if %} … {% else %} … {% endif %}`. Operands
translate: member-path truthiness, comparison (`=== !== > < >= <=`), logical
(`&& || !`). Every IR walker recurses into both branches, so an island or SSR
component inside a conditional branch is still collected and hydrated.

### List rendering — `.map()` (incl. nested)

`xs.map((x) => <li>{x.name}</li>)` lowers to `JsxNode::Map` → minijinja
`{% for x in xs %} … {% endfor %}`. The map source is a member-path
(`data.items`, `r.cells`) or an iter binding that is itself an array
(`matrix.map((row) => row.map(…))`). **Nesting works to any depth** — a `.map()`
in a child position re-enters `lower_call_as_map`, which clones the scope and
pushes the new iter binding, so the inner body still resolves the outer binding
(`rows.map((r) => r.cells.map((c) => <td>{r.type}:{c.label}</td>))`). Per-item
conditionals (`c.hot ? <td/> : <td/>`) compose inside a map body. Still rejected:
the two-arg `(item, idx)` form and a bare-fragment map body. (Golden tests:
`native_nested_map_*` in `jsx-rust-compiler/src/lib.rs`; runtime render coverage
in `tests/jinja-route.test.ts`.)

### Native inline — `<Comp native/>`

`<Comp native/>` expands a component's JSX into the route template **at compile
time** — no factory, no per-request worker crossing for that subtree (the
fastest path for pure presentational components; the JS-bridge floor is ~60k RPS).
`native` is a bare boolean attribute, auto-typed on every element via a
`React.JSX.IntrinsicAttributes` augmentation (`runtime/islands/isr-jsx.ts`, like
`isr`).

```tsx
function Badge({ label, strong }: { label: string; strong: boolean }) {
  return <span class="badge">{strong ? <b>{label}</b> : <i>{label}</i>}</span>
}
<Badge native label={title} strong={isHot} />
// → <span class="badge">{% if strong %}<b>{{ label }}</b>{% else %}<i>{{ label }}</i>{% endif %}</span>
```

- **Inlinable** (all must hold): source resolves (recursive import walk), body is
  **pure** (no `use*` hook, no `await`/`throw`/`console`/side effect), every
  expression translates.
- **Expression translation:** member paths, arithmetic, template literals (→ `~`),
  an allowlisted method→filter map (`toUpperCase→upper`, `toLowerCase→lower`,
  `trim`, `slice`, `join`, `.length`), comparison / logical / `not`.
- **Prop substitution:** call-site prop expressions are lowered in the **route**
  scope, then substituted for the component's prop references. `{children}` →
  `ChildrenSlot`, spliced with the call-site children (which may contain islands
  or further inlined components).
- **Recursion** is explicit per level: a `native` child inside an inlined
  component inlines recursively; an *un*annotated child stays an SSR slot.
- **Graceful fallback, not failure:** a non-inlinable `native` component degrades
  to the SSR-component slot + factory and a build **warning** to stderr. The one
  hard error is **circular inline** (`A → B → A`).
- **Inlined islands** are collected/numbered/hydrated like top-level islands (the
  build merges transitive import maps so they reconcile), with the island's
  `props_path` remapped through the substitution.
- **Gating:** inline lowering is active only in inline mode, so a route without
  `native` compiles byte-identically (regression-tested: `lower ==
  lower_with_sources(empty)`; golden fixtures unmoved).

### ISR cache — SSR islands & SSR components

A server-rendered fragment (SSR island **or** SSR component) opts into an
ISR-style cache via `isr={{ key, tags?, revalidate? }}`: its `renderToString`
runs **once per key**, and later requests serve a frozen result from a Rust-side
store — removing the per-request render (the jitter-bound bottleneck) while the
jinja shell still renders Rust-side.

```tsx
loader: async ({ params, req }) => ({ product, cacheKey: `p_${params.id}` })
<Island component={Card} props={product} ssr hydrate="load"
        isr={{ key: cacheKey, tags: ['product'], revalidate: 60 }} />
<Layout isr={{ key: 'navbar', tags: ['nav'] }}>…</Layout>   // SSR component, literal key
```

- **One store, one keyspace.** An island caches `{html, props}`; an SSR component
  caches `comp_<N>_html`. Key/tags can be a **loader-data path** or a **string
  literal** (static identity, no loader plumbing). Islands need `ssr` for `isr`
  to mean anything; SSR components always render server-side. `isr` on a
  `native`-**inlined** component is meaningless (already static) → ignored + warn.
- **Compiler:** a shared `parse_isr_object` helper (used by `lower_island` and
  `lower_ssr_component`) validates `key` (required), `tags` (`string[]`),
  `revalidate` (int seconds), threading them through `IslandMeta` / `ComponentMeta`
  and the `…_to_json` manifests (`keyPath`/`tagsPath`/`revalidate` +
  `keyLiteral`/`tagsLiteral`).
- **Worker:** `resolveIslandContext` / `resolveComponentContext`
  (`runtime/islands/native-render.ts`) resolve the key, `islandCacheGet` (NAPI) →
  hit serves the frozen pair (no render), miss renders then `islandCacheSet`. The
  frozen `html` + `data-brust-props` are stored and served **together** (serving
  cached markup against fresh props would break `hydrateRoot`); a throwing render
  degrades to an empty mount and never poisons the cache.
- **Rust store (`island_cache.rs`):** a `CacheStore` trait (swappable for Redis)
  with a `MokaStore` impl — `moka::sync::Cache` + a `Mutex<HashMap<tag,
  HashSet<key>>>` reverse index for tag invalidation, lazy TTL. Process-global,
  shared across the pool. NAPI: `islandCache{Get,Set,Invalidate,Clear}`,
  `?.`-guarded so a stale addon degrades to "no caching."
- **Invalidate:** `import { cache } from 'brustjs'` →
  `cache.invalidate({ tags })` / `{ key }`. Dev hot-reload clears the cache on any
  render-affecting edit (`ts`/`html`/`islands`); CSS-only edits keep it.

---

## Native interactivity — DOM directives

Make a `native: true` (jinja) page interactive **without a React island**, via
Alpine.js-style `x-*` directives bound to the isomorphic store. A native
interactive component is **single-file**: a `.tsx` whose `export default` is the
JSX template (→ jinja, server-rendered, unchanged) and whose co-located
`export const behavior` is the client logic.

```tsx
// components/AddToTeamButton.tsx
import { signal, computed } from 'brustjs/store'
import { client } from 'brustjs/client'
import { teamStore } from '../stores/team'

export const behavior = ({ props }) => {            // → client chunk (react-free)
  const busy = signal(false)
  const label = computed(() => (/* reads teamStore */ '＋ Add to team'))
  async function toggle() { /* action + teamStore.members.set(...) */ }
  return { busy, label, toggle }
}

export default function AddToTeamButton({ data }: { data: string }) {  // → jinja
  return (
    <div x-data="addToTeamButton" x-props={data}>
      <button x-text="label" x-bind-disabled="busy" x-on-click="toggle">＋ Add to team</button>
    </div>
  )
}
// detail page: <AddToTeamButton native data={d.addProps} />   (loader precomputes addProps = JSON.stringify(...))
```

- **Directive set (v1, Scheme 1 — JSX-safe):** `x-data` (mount + component name),
  `x-props` (JSON initial props), `x-text`, `x-show`, `x-bind-<attr>` (e.g.
  `x-bind-class`/`x-bind-disabled`), `x-on-<event>` (e.g. `x-on-click`), `x-for`.
  **No colon forms** (`x-on:click`/`:class`) — the native compiler rejects
  namespaced (`:`) attributes, so v1 uses hyphenated lowercase names, which pass
  through `lower_attr` as static string attrs (no compiler change for the attrs).
- **No inline expression eval** (no `new Function`/`with`): directive values name
  instance members (`x-text="label"`) or, inside `x-for`, dotted paths
  (`x-text="item.name"`) resolved by a tiny path resolver. All logic lives in the
  typed `behavior` — CSP-safe, XSS-safe.
- **Runtime** (`runtime/native/runtime.ts`, react-free, built on `effect`): each
  binding is one `effect`; `x-on-*` is an `addEventListener`; a `MutationObserver`
  on `document.body` mounts added subtrees and disposes removed ones — so it works
  on initial load, SPA-nav swaps, and dynamic content with no coupling to the
  islands bootstrap.
- **Single-file needs one compiler relaxation.** The co-located
  `export const behavior` made the native compiler's `find_default_export`
  (`lower.rs`) error (`UnexpectedStatement` on any top-level statement besides
  imports + the single default function). It now **tolerates and ignores** extra
  top-level statements and lowers only the default export — the *only* Rust change
  for directives.
- **Code-split, loaded on demand.** `buildDirectives` emits the shared runtime
  `_directives.js` (register/start/observer; exposes `register` on
  `globalThis[Symbol.for('brust.directive.register')]`) PLUS one
  `<name>.directive.js` chunk per component (behavior + store/treaty;
  self-registers via that global; react-leak-guarded per chunk). The runtime
  `<script>` is baked into **every** native page when the app has any directive
  (so it's live to catch SPA-nav swaps); a component's chunk is **dynamically
  `import()`ed on demand** the first time its `x-data="<name>"` appears — a page
  never downloads JS for components it doesn't render. Chunks served from the same
  `/_brust/islands/` route as island chunks (no Rust change).
- **Cross-paradigm:** a native `x-on-click` mutating `teamStore` is observed
  reactively by a React island reading the same store (the global reactive ctx
  above is what makes this work across chunks). Dogfood: pokedex
  `AddToTeamButton` is native; `TeamBuilder` stays a React island sharing the
  store.

---

## Styling

- **Tailwind v4** — `<scanRoot>/app.css` convention, compiled via
  `@tailwindcss/node` (CSS-first config, user owns `@source`), served at
  `/_brust/css/<file>` (`max-age=3600`); the renderer injects the `<link>` before
  `</head>` on the first chunk. Build-only (dev compiles at boot).
- **Component CSS & CSS Modules (partial)** — `import './x.css'` and
  `import s from './x.module.css'` via a `lightningcss` build pass
  (`[local]_[hash]`), a `Bun.plugin` resolving `.module.css` to the name map so
  SSR + client see identical hashes, and a per-route manifest merging global +
  route chunks. Known Bun bundler caveat: a `Counter.tsx` + `Counter.module.css`
  basename collision — route-level components can import `.module.css` freely;
  islands stay on Tailwind/inline for now.

---

## Agentic surface (MCP)

Brust mounts a Model Context Protocol (2025-06-18) server at `POST /_brust/mcp`
(JSON-RPC 2.0). The framework already knows what an agent needs:

- `defineActions` endpoints → MCP **tools** (one per `METHOD path`)
- route loaders → MCP **resources** at `brust:///<path-template>`

A boot-time extractor (`runtime/mcp/extractor.ts`) walks the `defineActions`
chain and the route types via the TypeScript compiler API and caches
`.brust/mcp-manifest.json` — no hand-written schema. Each tool's `inputSchema`
nests `params` (from `{x}` path segments), `body`, and `query` (inferred from
the endpoint's Standard Schema validators); the tool name is a slug like
`post_notes` / `get_notes_by_id`. Capabilities: tools, resources, prompts
(empty), logging. Transport is POST-only (SSE notifications deferred).

`tools/call` resolves the tool to its `EndpointDef` and dispatches through the
**same `dispatchAction` path as a real HTTP request** — so body/query validation
(422), the endpoint middleware chain, and the `respond`/error contract all apply
identically. The same auth that protects users protects agents. Tool arguments
are nested by routing role: `{ params?, query?, body? }`.

---

## Tooling

- **`brust build`** → a self-contained `./dist/`: `index.js` (`Bun.build`),
  prebuilt `islands/*`, `mcp-manifest.json`, native templates, and the platform
  `.node`. A Bun.build plugin swaps the napi platform shim for a prebuilt-aware
  variant; a banner sets `BRUST_PREBUILT=1` so `brust.run()` skips per-boot build
  steps. Actions need no build-time codegen — the bundled entry registers them via
  `import { actions } from './actions'` → `brust.run({ actions })`. Identifier
  minification is off (`Component.name` is the island chunk key). One platform per
  build; multi-platform is a CI matrix concern.
- **`brust dev` (partial)** — TS/TSX/HTML/CSS watcher (no Rust) + a synthetic
  `/_brust/dev` WS that relays `reload`/`css-update`/`error` to an inlined dev
  client (red error overlay, single-flight). CSS edits hot-swap the `<link>`;
  TS/HTML edits broadcast `reload` but worker respawn can leave stale pool
  entries (a small `napi_clear_pool` is the unbuilt fix) — CSS workflows are solid
  today.
- **`brust new` (partial)** — scaffolds from `runtime/cli/templates/minimal/`
  (TS + Tailwind + one island). `resolveBrustRef` uses `file:<abspath>` from the
  source tree, else `^<version>`. End-to-end run of a scaffold is blocked on a
  dual-React `file:`-install issue (fix = a Bun workspace restructure).

---

## Configuration

Layered: defaults < `brust.toml` < env (`runtime/config.ts`). Shipped:
`[server]` (port), `[workers]` (`count`), `[cache]` (`max_entries`); env
`BRUST_WORKERS`, `BRUST_DEV`. `[build]` and a default-TTL `[cache]` knob are
deferred (no consumer).

**Serve tunables** (`brust.run({ serve: { tuning } })`, all optional):
`connWorkers` (Rust accept concurrency, default `workers`), `workerThreads`
(tokio I/O threads, default `min(parallelism, 4)`), **`renderSlots`** (concurrent
in-flight renders per Bun worker, default 1 — raise for Suspense/loader-bound
apps; also via `BRUST_RENDER_SLOTS`), plus `tlsCertPath`/`tlsKeyPath`/
`tlsMinVersion` for in-process TLS. Each has a matching env var the bench app
reads.

---

## Crate & module map

A Cargo **workspace** (`resolver = "2"`, shared release profile: `lto`, `strip`,
`codegen-units=1`).

```
crates/brust-core/  — the pure-Rust core (zero napi; `cargo tree` has no napi/lru)
  src/server/{mod,body,static_assets,tls}.rs  hyper server, response builders,
                        /_brust/* routes (islands, css, cache, mcp, page), TLS
  src/render/{pool,dispatch,stream}.rs  WorkerPool + Vec<Slot> + RenderClaim,
                        the RenderDispatch napi-free seam, chunk/stream protocol
  src/routing/          matchit router, action router, envelope build
  src/cache.rs / cache/  route-level ResponseCache (moka) + ISR island store
  src/template/jinja.rs minijinja ENV (OnceLock)
  src/realtime/         sse.rs / ws.rs registries
  src/config.rs         AppState, Tuning (defaults)

crates/brust/  — the thin napi cdylib (brust.node) over brust-core
  src/lib.rs            napi exports: beginServe, untilReady, registerRenderer,
                        registerRoutes/Actions, render-chunk + jinja + sse/ws
  src/dispatch_impl.rs  TsfnDispatch (RendererTsfn + BufPtr) impl RenderDispatch
  src/jsx_compile.rs    NAPI compileJsx → jsx-rust-compiler

crates/jsx-rust-compiler/  — JSX → minijinja (+ JS factories) compiler
  src/{parser,ir,lower,analyze,emit_jinja,emit_factory,lib}.rs
  src/bin/jsx-rustc.rs     CLI
  fixtures/ + tests/golden_{emit,render}_jinja/   byte-equal goldens

runtime/                  — the TS framework
  index.ts routes.ts config.ts            host + dispatcher + config
  store/    (signal.ts, define-store.ts, server-context.ts, react.ts, serialize.ts)  isomorphic store
  native/   (runtime.ts, build.ts, index.ts)   directive runtime + per-component chunk build
  islands/  (island.tsx, build.ts, native-render.ts, bootstrap.ts, isr-jsx.ts, …)
  cli/      (build.ts, dev.ts, new.ts, native-routes-emit.ts, …)
  mcp/      (extractor.ts, server.ts, schema.ts)
  render/ sse/ ws/ css/ client/ dev/
```

---

## Performance

`bench/RESULTS.md` (2026-05-31) — darwin/arm64 M1 Pro, Bun 1.4.0, release,
`oha -c 120 -z 10s`, 1000 ms boot-settle + 3 s discarded JIT-warm per probe
(single run, not multi-median; treat as indicative, and re-measure per the
`brust-perf-bench-caveats` note — the bench has misled before).

| Scenario | Path | RPS | p50 | p95 | p99 |
|---|---|---:|---:|---:|---:|
| Rust-only | `GET /ping` | **138 k** | 0.10 | 0.15 | 0.17 |
| React SSR | `GET /` | **31 k** | 0.40 | 0.61 | 1.31 |
| Native (jinja) | `GET /native-profile/World` | **69 k** | 0.20 | 0.27 | 0.35 |
| Native + islands | `GET /native-islands` | **62 k** | 0.22 | 0.30 | 0.53 |
| Native + ISR island | `GET /native-islands-isr` | **65 k** | 0.21 | 0.28 | 0.38 |
| Server action | `POST /_brust/action/createNote` | **68 k** | 0.20 | 0.27 | 0.36 |
| Bun.serve (baseline) | `GET /ping` | 103 k | 1.16 | 1.33 | 2.17 |
| Bun.serve (baseline) | `GET /` | 18 k | 6.80 | 7.51 | 7.99 |

`bun run bench` (`scripts/benchmark.ts`). Reading the tiers: `/ping` (138 k) is
pure Rust — no worker, no napi. Everything that crosses to a worker **once**
without a React tree clusters around 65–69 k — native jinja (the loader runs in
the worker, the template renders in Rust), and server actions (the worker runs
the fn). Adding a per-request React render drops `/`-style SSR to ~31 k; adding a
server-rendered island to a native page costs ~7 k (69 k → 62 k), which ISR
claws most of back (→ 65 k) by skipping the per-request `renderToString`. Native
inline removes the worker crossing entirely for inlinable components, trending a
native route back toward the jinja ceiling.

These figures are at the default `renderSlots = 1`. For **Suspense / async-loader**
routes (where the render *yields* on I/O), raising `renderSlots` overlaps the
waits of concurrent requests on one worker — a measured ~7× throughput on a
~25 ms-data Suspense route (`bench/apps/brust` `/suspense-data`,
`BRUST_RENDER_SLOTS=8`). CPU-bound pages (the table above) are unaffected; they
serialize on the isolate either way, so the default stays 1.

---

## Status

**Shipped:** hyper HTTP/1.1+2 server + keep-alive + optional TLS · multi-thread
tokio · worker pool (per-slot atomic-claim, **`renderSlots`** concurrent renders
per worker) · napi tsfn + per-slot SAB render path · HTML streaming (Suspense
auto-detect) · declarative routing + nested routes + loaders + errorBoundary ·
per-route middleware · per-route cache (moka) + stats + invalidation ·
component-addressed
islands (4 triggers) · server actions (defineActions + treaty client) · MCP server · SSE +
WebSockets (literal paths) · SPA navigation · native routes (JSX→minijinja) +
**SSR components** + **conditional rendering** + **native inline** + **ISR cache
(islands & SSR components)** · **isomorphic store** (`signal`/`computed`/`defineStore`,
window-singleton client + per-request ALS server) · **native interactivity** (Alpine-style
`x-*` DOM directives + single-file components, per-component chunks loaded on demand) ·
Tailwind v4 + component CSS (partial) · `brust build` → `dist/` · `brust dev` / `brust new`
(partial).

**Not yet / deferred:** native store-snapshot SSR injection (native stores seed via
loader/`init()` fetch) · keyed `x-for` diff (v1 full re-renders) · whole-route cache for
native routes · `Fragment` lowering · global `app/middleware.ts` + header deletion · build-time client RPC
auto-rewrite · content-hashed island filenames + per-chunk CSS extraction ·
single-binary `--compile` · graceful drain · tsfn retry / health checks · SSE/WS
no-SAB dispatch variant for `renderSlots > 1` (safe today — they never touch the
SAB — but unenforced).

---

*Brust — built to brust.*
