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
    errorBoundary: () => import("./pages/AppError"),  // catches 4xx/5xx
  },
]
```

Routes declare routing + data + cache. Islands are declared at point of use in
JSX ([Islands](#islands-on-demand-hydration)) — no per-route islands manifest.

Bun parses `routes.tsx` at boot and sends the patterns to Rust over a
dedicated napi call; Rust builds a radix tree. URL matching happens in Rust
(no JS re-entry for matching). Worker dispatch then needs a `route_id` rather
than a raw path — the current tsfn signature (`Function<String, Promise<u32>>`,
where the `String` is the path) evolves to carry `(route_id, params, headers)`,
likely as a JSON-encoded argument until something tighter is justified.

**State:**
- **Loader → props.** Loader return value becomes the page component's `props`
  on both server (initial render) and client (after navigation). No separate
  data-fetch hook.
- **Server → client hydration.** Loader data ships once as JSON inline next to
  the marker for the page; client navigation fetches fresh JSON. No re-fetch
  on first hydration.
- **URL state.** `params` come from the path. Query string + search params are
  on the `req` argument; no special primitive — apps reach for `useState`
  inside islands when they need local state.

**Custom error pages:**
- `errorBoundary` on a route catches thrown loader errors, HTTP 4xx from the
  loader return, and render exceptions in that subtree. Defaults to a built-in
  page if not declared.
- Global `app/_404.tsx` and `app/_500.tsx` if present override the built-ins
  outside any route subtree.

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

Request/response interceptors that wrap routes (or all routes). Run in
declaration order; each is `async` and may short-circuit by returning a
`Response` directly.

```tsx
// middleware.ts
export const middleware = [
  async (req, next) => {
    const t0 = Date.now()
    const res = await next()
    res.headers.set('x-render-ms', String(Date.now() - t0))
    return res
  },
  async (req, next) => {
    if (req.url.pathname.startsWith('/app') && !req.headers.get('authorization')) {
      return Response.redirect('/login', 302)
    }
    return next()
  },
]
```

Brust does not ship a session/auth primitive — apps wire their own middleware
(cookie parsing, session store, OAuth providers, etc.). The middleware
contract above is intentionally generic.

Per-route override via `middleware: [...]` on a route entry. Middleware runs
in the Bun Worker thread alongside the loader/render, so it sees the same
`req` shape.

**Mechanism gap:** the current tsfn contract returns only `u32` (body
length); there is no channel for response headers or status. For
middleware to actually mutate headers/status, the contract must evolve to
either a richer return value (e.g. a struct `{ status, headers, body_len }`
encoded into a fixed prefix of the SAB) or a separate tsfn handle dedicated
to response metadata. The API surface above is the target; the wire format
is unsettled.

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

Server fns accept `FormData` as an argument type via a **dedicated
multipart code path in the generated RPC stub** — the stub detects a
`FormData` arg and sends the request as `multipart/form-data` instead of
JSON. Args other than `FormData` continue to use the JSON path described in
[Server functions](#server-functions); the two paths share the same
`/_brust/action/<id>` endpoint, differentiated by `Content-Type`. Large
uploads stream through Rust without copying the body into the JS heap
until the handler asks for it.

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

Today, env-only:

- `BRUST_PORT` — default 3000
- `BRUST_WORKERS` — default `floor(os.availableParallelism() * 1.8)`
- `BRUST_WORKER_ID` — set per Worker; do not set manually

Roadmap: `brust.toml` with `[server]`, `[workers]`, `[cache]`, `[build]` sections.

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

- Routing + state + custom error pages (`routes.tsx` + radix tree + per-route cache + errorBoundary)
- Cache (LRU, vary headers, TTL, control-socket invalidation)
- Islands hydration (`"use island"`, lazy bootstrap, hydration triggers)
- Server functions (`"use server"`, build-time RPC stub generation)
- Agentic surface (MCP-style schemas auto-extracted at build time)
- Middleware (per-route + global, short-circuit on `Response`)
- Forms & multipart (streaming uploads, dedicated multipart code path in server-fn stubs)
- Real-time: WebSockets (per-route upgrade) + SSE / streaming responses
- HTML Streaming (`renderToPipeableStream` over SAB multi-chunk signals)
- Navigation (intercept Link, JSON page fetches over `/_brust/page/*`)
- Single-binary deploy (`bun build --compile`) — feasibility unknown until tested with the `.node` bundling path
- TOML configuration
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
