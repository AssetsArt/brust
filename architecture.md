# Brust — Architecture

**B**un + **Rust** — an SSR framework that brusts.

React renders on the server inside Bun Worker threads; everything around it —
the HTTP listener, routing, caching, the native-route template engine — is Rust,
loaded into one Bun process as a `.node` module via napi-rs. Worker render output
crosses back to Rust through a per-worker `SharedArrayBuffer`, never through a V8
marshal.

It is also **agent-first**: a Brust app ships a Model Context Protocol server at
`POST /_brust/mcp` that exposes its server functions as MCP tools and route
loaders as resources, extracted from the app's own types at boot — agents drive
the app through typed contracts, not DOM scraping.

Current line: **0.1.x-alpha** (npm `brustjs` + 6 platform packages + `create-brustjs`).

---

## Hosting model

One OS process. Bun is the host; Rust is a `cdylib` (`brust.node`) loaded into
it. The HTTP accept loop and all request parsing run on a dedicated Rust thread;
React renders are dispatched into Bun Worker threads via a napi
`ThreadsafeFunction` (tsfn) and their HTML returns through shared memory.

| Concern | Owner |
|---|---|
| HTTP/1.1 listener + accept loop | **Rust** (tokio on macOS, tokio-uring on Linux, `current_thread`) |
| TCP connection workers | **Rust** (pre-spawned tasks over a `flume::bounded` MPMC channel) |
| Routing / cache / native templates | **Rust** (`matchit`, `lru`, `minijinja`) |
| React render workers | **Bun Worker threads** — one V8 isolate each |
| Render dispatch (cross-thread) | **napi-rs 3.x** `ThreadsafeFunction` |
| Render result transfer | per-worker `SharedArrayBuffer` (no V8 marshal) |

Why this shape: a traditional SSR stack renders HTML, ships the whole framework
bundle, then re-runs everything to hydrate. Brust renders once in Rust-fronted
workers, hydrates only the islands you mark, and serves cache hits and native
routes without ever waking a worker.

---

## Process & thread layout

```
Bun process (one OS process)

  Main thread (TS host) — runtime/index.ts → brust.run({ routes, entry })
    ├─ scan actions / build islands / compile native routes (build or boot)
    ├─ napi.beginServe({ port, workers })        → spawn the Rust accept thread
    ├─ for i in 0..N: new Worker(entry, BRUST_WORKER_ID=i)
    └─ await napi.untilReady(timeout)            # every worker registered, or exit(1)

  Worker threads × N  (N = os.availableParallelism(), or [workers].count / BRUST_WORKERS)
    const sab = new SharedArrayBuffer(256 KB)    # module-scope root
    brust.registerRenderer(new Uint8Array(sab), renderer)   # renderer = runtime/routes.ts::makeRenderer
      renderer parses the request envelope, runs middleware + loader,
      renders (React or native), writes [meta_len u16 BE][meta JSON][body] into the SAB

brust.node (napi cdylib, same process)

  Accept thread (dedicated)
    tokio (macOS) / tokio-uring (Linux), current_thread
    TcpListener → flume::bounded::<TcpStream>(1024) → N TCP worker tasks

  TCP worker tasks × N (async, cooperative, all on the accept thread)
    loop { stream = rx.recv_async().await; handle_conn(stream).await }  # keep-alive

  handle_conn (per connection)
    loop {
      read_full_request → httparse
      /ping            → static "pong\n"                       (no JS, no napi)
      routes.match_path → 404 if no match                      (no worker)
      cache hit        → write stored response bytes           (no worker)
      else             → claim a worker, dispatch envelope via tsfn,
                         drain rendered chunks from the SAB to the socket
    }
```

---

## Request lifecycle

```
T0  client connects (TCP, keep-alive)
T1  accept loop:  listener.accept() → flume.send_async(stream)
T2  TCP worker:   rx.recv_async() → handle_conn
T3  read_full_request (until \r\n\r\n, ≤ 16 KB) → httparse → method/path
T4  /ping        → static response, back to T3                (no JS)
T5  routes.match_path(method, path, buf)
      no match   → 404                                        (no worker)
T6  cache lookup (only if the route opted into `cache`)
      hit        → write stored wire bytes, back to T3        (no worker)
T7  claim a worker (atomic) → dispatch the request envelope via the renderer tsfn
      Bun Worker wakes: middleware → loader → render
        React route  → renderToString / renderToPipeableStream
        native route → minijinja render in Rust (worker only JSON.stringify's loader data)
      worker writes [meta_len][meta JSON][body] into its SAB at offset 0
T8  Rust drains chunk(s) from the SAB:
      split_meta → build_single_response_bytes(status, headers, body) → write_all
      (Suspense-streaming routes write multiple chunks, chunked transfer-encoding)
T9  store in cache if the route opted in; back to T3 (keep-alive)
```

Distinct status paths: `200`/`500`/`502` are emitted inline in `server.rs`;
`400`/`404`/`405`/`414`/`503` come from `http.rs`. A render throw becomes a `500`
without killing the worker; a tsfn dispatch failure is a `502` and evicts the
worker from the pool.

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

**SAB layout & safety.** The backing store lives outside V8's GC heap and is
stable for the worker's lifetime. Rust reads it only *after*
`tsfn.call_async(..).await` resolves — i.e. after the worker has returned from
the render callback — so napi's tsfn provides the happens-before edge and there
is no concurrent writer. The `BufPtr` wrapper in `pool.rs` carries an
`unsafe impl Send + Sync` with this argument documented inline. Slot size is
256 KB per worker (10 workers ≈ 2.5 MB, comfortably in L2/L3). A render that
returns `0` or a length outside `(0, slot]` is a `500` ("oversized") — no
spillover path yet.

**Slot ownership = one render at a time.** napi dispatches tsfn callbacks
serially per worker (one V8 isolate), so a worker can't render two requests at
once — the second tsfn call queues. Consequences: per-worker concurrency is 1
(optimal for CPU-bound render); a loader can still `Promise.all` *within* one
render; loader-bound apps cap throughput at N in-flight renders (an "N slots per
worker" escape hatch is unbuilt).

---

## HTTP layer

The accept loop runs on one dedicated thread with a single-threaded async
runtime — `tokio::runtime::new_current_thread` + `tokio::net` on macOS,
`tokio_uring::start` + `tokio_uring::net` on Linux. There is no multi-thread
tokio runtime; the accept loop and all TCP worker tasks are cooperatively
scheduled on this one thread.

- **Dispatch:** one `flume::bounded::<TcpStream>(1024)` MPMC channel; N
  pre-spawned TCP worker tasks clone the receiver. Accept pushes, an idle worker
  grabs — natural work-stealing, bounded backpressure if every worker stalls.
- **Per connection:** HTTP/1.1 keep-alive; `handle_conn` loops over requests on
  the socket until EOF or malformed input. `read_full_request` reads to
  `\r\n\r\n`, capped at 16 KB; `parse_request` is zero-copy `httparse`.
- **Response:** `build_response` pre-sizes one `Vec`, writes the status line + a
  few headers, appends the body; a single `write_all` per response.

> **Linux: io_uring needs permitted syscalls.** The Linux runtime calls
> `io_uring_setup`/`io_uring_enter`/`io_uring_register`, which most container
> seccomp profiles (Docker, podman, restrictive k8s) deny. Under a default
> profile `tokio_uring::start` panics at boot with `ENOSYS` → no listener →
> connections refused. Run with `--security-opt seccomp=unconfined` or a profile
> that allows the three `io_uring_*` syscalls (glibc **and** musl — it's an
> io_uring property, not libc). Bare-metal/VM deploys are unaffected.

Not built: TLS termination, HTTP/2, graceful drain, daemonisation.

---

## Worker pool

```
worker-i :  tsfn_i   SAB_i (256 KB)   render_slot: Mutex<Option<…>>   in_flight: AtomicU32
```

The pool (`pool.rs`) registers a worker when it calls `registerRenderer`,
claims one per render, and evicts one whose tsfn dies (`process::exit(1)` if the
pool empties — no respawn yet).

**Render dispatch is atomic-claim.** `try_claim_render` picks the first worker
whose `render_slot` is `None` under a per-entry `parking_lot::Mutex`, installs
the chunk sender, and bumps `in_flight` in one critical section. The returned
`RenderClaim` is an RAII guard whose `Drop` clears the slot then decrements
`in_flight` (order is load-bearing). Two renders can't claim the same worker.
`ClaimResult::PoolEmpty` vs `AllBusy` give distinct 503 bodies (misconfig vs
overload). SSE/WS use `pick_least_busy` instead — their per-conn model doesn't
share the SAB chunk channel. (This atomic-claim closed an earlier TOCTOU race
where two pickers overwrote each other's `chunk_tx`; a 16-contender/4-worker
regression test guards it.)

**Worker count = `os.availableParallelism()`** — one worker per core. CPU-bound
React renders saturate a core each; oversubscribing (a former `× 1.8` default)
amplified p99 ~6× once per-render work grew past ~150 µs. Override via
`BRUST_WORKERS` or `[workers].count` for Suspense/await-heavy apps.

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

## Server functions & forms

Server-only async functions callable from a client island as if local — same
types both sides, no separate API schema.

```tsx
// actions/posts.ts
"use server"
export async function createComment(postId: string, body: string) { … }

// in an island:
import { action } from 'brustjs/client'
await action<typeof createComment>('createComment')(postId, body)
```

- **Discovery:** `"use server"` file-level directive; `brust.scanActions()`
  imports those files at boot and registers every named export. `withMiddleware([…],
  fn)` attaches per-action middleware.
- **Transport:** `POST /_brust/action/<id>` over the same accept loop + worker
  pool as renders (a `kind: 'render' | 'action'` envelope discriminant). JSON
  args/return; errors → `{ error: { message, name } }`. Server-only code (DB,
  secrets) stays out of the client bundle.
- **Forms / multipart:** the same endpoint accepts `multipart/form-data` and
  `x-www-form-urlencoded`; handlers declare `(req, fd: FormData) => R`, called
  via `formAction<F>(id)`. The envelope carries `content_type` + `body_text` /
  `body_b64` (multipart base64-encoded), 256 KB body cap.

Not built: build-time client RPC auto-rewrite (today islands call `action(id)`),
a shared client chunk, route-middleware inheritance, streaming uploads.

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

- server functions (`"use server"`) → MCP **tools**
- route loaders → MCP **resources** at `brust:///<path-template>`

A boot-time extractor (`runtime/mcp/extractor.ts`) walks the types via the
TypeScript compiler API and caches `.brust/mcp-manifest.json` — no hand-written
schema. `tools/call` flows through the action's existing middleware chain, so the
same auth that protects users protects agents (rejections surface as
`isError: true`). Capabilities: tools, resources, prompts (empty), logging.
Transport is POST-only (SSE notifications deferred).

---

## Tooling

- **`brust build`** → a self-contained `./dist/`: `index.js` (`Bun.build`),
  prebuilt `islands/*`, `mcp-manifest.json`, native templates, and the platform
  `.node`. Two Bun.build plugins swap the napi platform shim and the
  filesystem-walking action scanner for prebuilt-aware variants; a banner sets
  `BRUST_PREBUILT=1` so `brust.run()` skips per-boot build steps. Identifier
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

---

## Crate & module map

A Cargo **workspace** (`resolver = "2"`, shared release profile: `lto`, `strip`,
`codegen-units=1`).

```
crates/brust/  — the napi cdylib (brust.node)
  src/lib.rs            napi exports: beginServe, untilReady, registerRenderer,
                        registerRoutes/Actions, register{Sse,Ws}Paths, render-chunk
                        + jinja + sse/ws + islandCache + compileJsx entries
  src/server.rs         accept loop, handle_conn, keep-alive, chunk dispatch,
                        native /_brust/* routes (islands, css, cache, mcp, page)
  src/pool.rs           WorkerPool, BufPtr (Send+Sync), try_claim_render/RenderClaim
  src/http.rs           parse_request (httparse), build_response, 4xx/5xx
  src/routes.rs         matchit router + envelope build
  src/cache.rs          route-level LRU
  src/island_cache.rs   ISR store (CacheStore trait + MokaStore)
  src/jinja.rs          minijinja ENV (OnceLock)
  src/jsx_compile.rs    NAPI compileJsx → jsx-rust-compiler
  src/render_stream.rs / sse.rs / ws.rs   streaming + realtime
  src/io/{linux,other}.rs  tokio-uring vs tokio listener/stream

crates/jsx-rust-compiler/  — JSX → minijinja (+ JS factories) compiler
  src/{parser,ir,lower,analyze,emit_jinja,emit_factory,lib}.rs
  src/bin/jsx-rustc.rs     CLI
  fixtures/ + tests/golden_{emit,render}_jinja/   byte-equal goldens

runtime/                  — the TS framework
  index.ts routes.ts config.ts            host + dispatcher + config
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

---

## Status

**Shipped:** Rust accept loop + keep-alive + worker pool (atomic-claim) · napi
tsfn + per-worker SAB render path · HTML streaming (Suspense auto-detect) ·
declarative routing + nested routes + loaders + errorBoundary · per-route
middleware · per-route LRU cache + stats + invalidation · component-addressed
islands (4 triggers) · server functions + forms/multipart · MCP server · SSE +
WebSockets (literal paths) · SPA navigation · native routes (JSX→minijinja) +
**SSR components** + **conditional rendering** + **native inline** + **ISR cache
(islands & SSR components)** · Tailwind v4 + component CSS (partial) · `brust
build` → `dist/` · `brust dev` / `brust new` (partial).

**Not yet / deferred:** whole-route cache for native routes · `Fragment`
lowering · global `app/middleware.ts` + header deletion · build-time client RPC
auto-rewrite · content-hashed island filenames + per-chunk CSS extraction ·
single-binary `--compile` · multi-thread tokio · N slots per worker · HTTP/2 ·
TLS · graceful drain · tsfn retry / health checks.

---

*Brust — built to brust.*
