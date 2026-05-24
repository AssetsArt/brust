# Brust — Architecture

**B**un + **Rust** — SSR framework that bursts.

React on the server. Rust everywhere else. One Bun host process, Rust loaded as
a `.node` native module via napi-rs. Renders dispatched into Bun Worker threads;
HTML returned through per-worker SharedArrayBuffer.

Designed agent-first: routes are designed to ship machine-readable schemas
(server fns as tools, loaders as resources) so AI agents can drive the app
without scraping the DOM. The framework already has the structural knowledge —
loader types, server-fn signatures, island markers — that a schema extractor
needs. The extractor and the schema endpoints themselves are still on the
roadmap (see [Agentic surface](#agentic-surface-mcp-style-page-schemas)).

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
| response `Vec<u8>` → kernel | full body | `write_all` syscall, unavoidable |

`build_response` still allocates one `Vec<u8>` and copies the body into it. The
final response buffer + header could be sent with `writev` to drop the
SAB→Vec memcpy; we have not done it yet (see Roadmap).

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
saturated during those pauses. Measured (see Performance table for full
numbers): 18 workers ≈ 72k RPS React SSR; 8 workers ≈ 58k; >24 workers
plateaus then regresses on scheduler thrash.

---

## Designed but not built

The HTTP and dispatch layers above are real. The user-facing parts below are
roadmap.

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
`defineRoutes` is an identity helper that pins the array's element type.

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
- `children: [...]` — nested routes. Follow-up.
- Global `app/_404.tsx` / `app/_500.tsx` overrides — Middleware follow-up.
- Global `app/middleware.ts` — Middleware follow-up.
- Client-side navigation (`/_brust/page/*`) — Navigation plan.

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

**Status (MVP shipped):**

- `<Island id component props hydrate?>` runtime component (from `runtime/islands/island.tsx`) embeds the SSR HTML inside a `data-brust-island` marker and flips a module-scope flag.
- `makeRenderer` auto-injects an importmap + `<script type="module" src="/_brust/islands/_bootstrap.js" defer>` when any island rendered. Pages without islands ship zero JS.
- `buildIslands(configPath)` (from `runtime/islands/build.ts`) at boot reads `island.config.ts` and runs `Bun.build` 3+N times: 1 combined chunk for `react`+`react/jsx-runtime` (`_react.js`, ~7 KB minified), 1 `react-dom/client` chunk (`_react-dom.js`, ~136 KB minified, externalises `react`), N island chunks (all 3 runtime modules external), 1 bootstrap. Output lands in `.brust/islands/`. All builds use `minify: true` + `define: process.env.NODE_ENV = "production"`.
- Rust native route `GET /_brust/islands/<file>` serves chunks with `Cache-Control: public, max-age=3600`. Strict filename-safety check rejects path-traversal, hidden files, non-JS, and anything outside `[A-Za-z0-9_.-]+\.js`.
- 4 hydration triggers shipped: `load` / `idle` / `visible` / `interaction`.

**MVP-scope simplifications (vs the architecture vision above):**

- `<Island>` is a manual wrapper. The `"use island"` directive + auto-detection at JSX call sites is deferred — users explicitly wrap.
- Each island's `id` must be listed in `island.config.ts` (single source of truth for the build).
- Filenames are predictable (`<id>.js`), not content-hashed. Production deployments should fingerprint or wrap with a CDN.
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

### Agentic surface (MCP-style page schemas)

Pages expose their structure as machine-readable schemas — content, inputs,
and actions — so AI agents can drive a page without scraping HTML. Same idea
as Model Context Protocol, applied to web routes: a page is a resource, the
server functions it triggers are tools.

The framework already knows everything an agent would need:

- the route tree (paths, params)
- per-route loader types (what data the page consumes)
- the server fns the page imports (the tools the page can invoke)
- the islands rendered (the interactive surface)

A build-time extractor walks the import graph and emits a schema per route.
Apps don't write the schema by hand.

**Per-route schema:**

```json
GET /_brust/agentic/blog/:slug

{
  "path":        "/blog/:slug",
  "description": "Read a blog post and post comments",
  "params":      { "slug": { "type": "string" } },
  "content": {
    "post": {
      "source": "loader",
      "schema": { "title": "string", "body": "string", "author": "string" }
    }
  },
  "actions": [
    {
      "id":          "createComment",
      "description": "Post a comment on this post",
      "args":        { "postId": "string", "body": "string" },
      "returns":     { "id": "string", "createdAt": "string" }
    }
  ],
  "islands": [
    { "name":   "CommentForm",
      "inputs": [{ "name": "body", "kind": "textarea", "maxLength": 5000 }] }
  ]
}
```

**Global manifest:**

```
GET /_brust/agentic/manifest

{
  "name":   "my-app",
  "routes": [ /* all routes */ ],
  "tools":  [ /* all "use server" functions, route-agnostic */ ]
}
```

**Invoking actions** uses the existing server-fn endpoint
`/_brust/action/<id>` — the same one client islands call. Agents pass JSON
args and receive JSON. No separate transport.

**MCP compatibility:** the manifest can be served through an MCP-compliant
endpoint so any MCP client (Claude desktop, Cursor, custom agents) can
discover and call into a Brust app without bespoke integration. Each Brust
app effectively *is* an MCP server.

**Author overrides:**

```tsx
// pages/Blog.tsx
export const agentic = {
  description: "Read a blog post and post comments",
  actions:     ['createComment'],   // narrow from the import-graph default
  hide:        ['internalDebugFn'], // explicitly exclude
}
```

Default: every server fn the page imports + every island it renders. The
export lets authors trim, narrow, or annotate.

**Trade-offs:**

- ✅ AI-first design — no DOM scraping; agents get typed, stable contracts
- ✅ Schema co-evolves with code (build-time extraction, not hand-maintained)
- ✅ Reuses existing types from server fns & loaders
- ✅ Agents inherit the user's full request context (cookies, headers, any
  middleware-applied auth or rate-limits) — no separate agent-only ACL
  surface; the same middleware that protects users protects agents
- ⚠️ Schema is a public API surface — versioning matters; breaking changes
  to a server-fn signature break agents the same way they break clients
- ⚠️ Agent-specific concerns (per-agent rate limits, audit logging, consent
  prompts before destructive actions) are middleware territory; the
  framework doesn't impose a policy

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

`renderToPipeableStream` writes the page as chunks while loaders are still
resolving — useful for Suspense + slow data. Compared to the current
`renderToString` path, the SAB acts as a one-chunk pipe rather than a
single-shot buffer.

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

Currently deferred from build because most pages don't benefit (latency win
small relative to render time), but the API surface above is the target.

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

Layered, low → high precedence:

1. **Built-in defaults.** Port `3000`, workers `floor(os.availableParallelism() * 1.8)`.
2. **`brust.toml` at the project root.** Optional. Schema (extends as subsystems land):

   ```toml
   [server]
   port = 3000

   [workers]
   count = 18

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

| Command | Does |
|---|---|
| `brust new <name>` | Scaffold a starter project (entry, `routes.tsx`, sample page, `brust.toml`) |
| `brust dev`        | Run the dev server with hot reload (rebuild Rust if changed, restart Bun workers on JS/TSX edit) |
| `brust build`      | Production build: TS transformer (`"use island"` / `"use server"`), client bundle, `bun build --compile` |
| `brust invalidate <path>` | Talk to a running server's control socket to evict a cache entry |

The CLI is itself a Bun script; no separate Rust binary needed beyond the
cdylib.

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

One crate, `cdylib`:

```
brust/
├── Cargo.toml                     edition 2024, napi 3.x, flume 0.11,
│                                   parking_lot, httparse, thiserror,
│                                   tracing, once_cell,
│                                   tokio (mac) / tokio-uring (linux)
├── src/lib.rs                     napi exports: beginServe, untilReady,
│                                   untilShutdown, registerRenderer,
│                                   isWorker, workerId
├── src/pool.rs                    WorkerPool, TsfnEntry, BufPtr (Send+Sync)
├── src/server.rs                  accept loop, handle_conn, read_full_request,
│                                   keep-alive request loop. 500/502 statuses
│                                   are emitted inline via build_response;
│                                   only 400/404/405/503 have helpers in http.rs.
├── src/http.rs                    parse_request (httparse), build_response,
│                                   error_400/404/405/414/503. error_414 builds
│                                   its response inline with Connection: close
│                                   because the client's read cursor is mid-
│                                   headers when oversize is detected.
└── src/io/{linux,other,mod}.rs    tokio-uring vs tokio TcpListener/TcpStream
                                    wrappers (current_thread runtimes on both)
```

Future splits when the API stabilises (e.g. `brust-cli` if/when one exists).

---

## Performance

All numbers measured. Hardware: M1 Pro (10 cores: 8P + 2E), 16 GB RAM, Bun 1.3+,
release build, `oha -c 120 -z 10s`.

| Endpoint | Setup | RPS | p99 |
|---|---|---|---|
| `/ping` (Rust-native) | `BRUST_WORKERS=18` | **117 k** | 0.24 ms |
| `/` (React SSR via SAB) | `BRUST_WORKERS=18` | **55 k** | 1.2 ms |
| `POST /_brust/action/createNote` (server fn dispatch) | `BRUST_WORKERS=18` | **61 k** | 0.54 ms |
| `/ping` (axum baseline, same box) | — | 100 k+ | — |
| `/ping` (Bun.serve baseline) | — | 86 k | 2.6 ms |
| `/` (Bun.serve baseline) | — | 40 k | 3.6 ms |

Reproduce with `bun run bench` — driver at `scripts/benchmark.ts`, results at `bench/RESULTS.md`.
Bun.serve baseline source: `example/bun-serve-baseline/index.ts`.

**Read:** Brust's Rust accept loop + napi + SAB beats Bun.serve+React by ~35 % on `/ping` and ~37 % on `/`. The smaller `/` margin is the cost of crossing the napi tsfn boundary once per render — irreducible until a non-React render path appears. The action endpoint outpaces React-SSR (61 k vs 55 k) because the JS handler returns a JSON object with no React render tree to serialise; both share the same SAB envelope path so the gap is React render cost, not envelope overhead.

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
- Islands hydration MVP: `<Island id component props hydrate?>` + `buildIslands(configPath)` + `/_brust/islands/<file>` static route + handwritten bootstrap with 4 triggers (load/idle/visible/interaction) + shared React runtime via importmap
- Server functions MVP: async functions invokable from islands via `POST /_brust/action/<id>` (JSON args/return). Reuses the renderer tsfn via a `kind: 'render' | 'action'` envelope discriminant. Action-specific middleware (action def's own chain). Client helper `action<F>(id)` from `runtime/client` preserves types via TS generics + `import type` erase. New Rust napi `register_actions(ids: Vec<String>)`; new server.rs branch with charset/length/utf-8 guards and dedicated 404/405/411/413 error paths. Meta envelope grows optional `contentType` (camelCase) so action returns ship as `application/json`. ResponseMeta becomes the Content-Type override channel for any future need.
- `"use server"` directive + boot-time scanner — file-level directive. `brust.scanActions({ roots? })` walks the project, finds files whose first statement is `'use server'`, imports them, and registers all named function exports as actions. Middleware attaches per-action via `withMiddleware([mws], fn)`. Replaces the manual `defineActions` / `brust.registerActions` API.
- Forms & Multipart — `POST /_brust/action/<id>` accepts `multipart/form-data` and `application/x-www-form-urlencoded` bodies in addition to JSON. Handlers declare `(req: BrustRequest, fd: FormData) => R` for form actions. Client helper `formAction<F>(id)` mirrors `action<F>(id)`. Wire-level: `ActionEnvelope.args_json` replaced by `content_type` + `body_text` / `body_b64`; multipart bodies are base64-encoded for transport through the JSON envelope. 256 KB body cap unchanged.

**Designed, not built:**

- Loaders + nested routes (`children: [...]`) — nested routes still pending
- `brust-cli invalidate` (project tooling — separate from the native endpoint that just shipped)
- Default TTL fallback in `[cache]` (semantics deferred — no current consumer)
- Islands: `"use island"` directive + auto-detection at JSX call sites (MVP uses manual `<Island>` wrapper)
- Islands: content-hashed filenames + production caching strategy
- Islands: CSS extraction per chunk
- Islands: hot reload during dev
- Agentic surface (MCP-style schemas auto-extracted at build time)
- Global middleware (`app/middleware.ts`) + response-header *deletion* channel — per-route + set/override is shipped
- Real-time: WebSockets (per-route upgrade) + SSE / streaming responses
- HTML Streaming (`renderToPipeableStream` over SAB multi-chunk signals)
- Navigation (intercept Link, JSON page fetches over `/_brust/page/*`)
- Single-binary deploy (`bun build --compile`) — feasibility unknown until tested with the `.node` bundling path
- TOML configuration `[cache]` + `[build]` sections (the `[server]` + `[workers]` part is shipped)
- Project tooling: `brust new` / `dev` / `build` / `invalidate`
- Retry on tsfn failure, PING/PONG health checks

**Deferred (no design yet):**

- Multi-thread tokio runtime (Brust is single-thread Rust today)
- N slots per worker for loader-bound workloads
- HTTP/2
- TLS termination
- Native client wrapper (Tauri / RN) beyond noting it as an option
- Graceful shutdown / drain (SIGINT handled JS-side via `process.exit`)

---

*Brust — Built to burst.*
