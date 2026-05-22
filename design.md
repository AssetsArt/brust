# Brust

**B**un + **Rust** — SSR framework that bursts.

React on the server. Rust everywhere else. Ships as a single binary.

Built on [Pingora](https://github.com/cloudflare/pingora)'s core runtime —
the same building blocks that power Cloudflare's edge.

---

## Why Brust

Traditional SSR frameworks make you pay three times:

1. Server renders HTML
2. Client downloads the entire framework bundle
3. Client re-runs everything to "hydrate"

Brust pays once. Server renders, client resumes only when needed.

---

## Why Pingora's runtime — and what we build ourselves

Brust is a long-lived proxy in front of a pool of Bun worker processes that
speak a custom Unix-socket protocol — not HTTP. That shapes which parts of
Pingora are useful and which parts we have to build.

We use `pingora-core` for:

- per-thread tokio runtime with work-stealing disabled
- TCP/TLS listener with graceful reload
- signal handling, daemonization, structured logging

We do **not** use `pingora-proxy` / `ProxyHttp`. That stack assumes HTTP
upstreams; our upstream is Bun over Unix sockets with shm. The "free"
features in the pingora-proxy table — connection pool, LoadBalancer,
retry, circuit breaker — only apply to HTTP upstreams. We re-implement
them ourselves against the worker pool, keeping the surface small:

| Concern | Source |
|---|---|
| HTTP/1.1 + TLS listener | `pingora-core` |
| Per-thread tokio runtime | `pingora-core` |
| Graceful reload, signals | `pingora-core` |
| Worker selection (least-busy) | **Brust** (~50 LOC over an atomic counter array) |
| Worker connection pool | **Brust** (persistent Unix socket per worker, no per-request reconnect) |
| Retry on render failure | **Brust** (idempotent renders only; see "Error & Retry") |
| Health checks | **Brust** (ping frame on idle socket) |

The threading model still matches Brust's worker pool: Pingora runs N
listener threads, each with an isolated runtime, and we pair each thread
with one Bun worker — N Bun processes, each with its own JS heap, true
parallel CPU-bound rendering with no GC interference between workers.

If `pingora-core` ever proves heavier than we need for just the listener
+ runtime layer, we can drop down to `tokio` + `hyper` directly. The
trade is real but small.

---

## Architecture

```
Single Binary (~80–120 MB, mostly the embedded Bun runtime)
├── Rust (pingora-core listener + custom proxy core)
└── Bun runtime + JS bundle     (embedded via include_bytes!)

Boot:
  Rust extracts Bun binary
    Linux  → memfd_create (no disk write)
    macOS  → /tmp/brust-worker-{hash}
  Bun master parses routes.tsx → sends route registry to Rust
  Rust builds radix tree
  Rust creates shared memory region (N × slot_size)
  Spawn N Bun workers = num_cpus(), each receives shm fd + worker id
  Each worker connects back over its dedicated Unix socket
  (one persistent connection per worker, kept open for process lifetime)

Request lifecycle:

  1. listener accepts HTTP request
  2. cache lookup (Rust LRU, keyed on path + vary headers)
       HIT  → return HTML immediately       (~µs, pure Rust, 0 IPC)
       MISS → continue
  3. radix-tree match → route id + params
  4. pick least-busy worker (atomic in-flight counter per worker)
  5. send {route_id, params, headers, url} over Unix socket (length-prefixed JSON)
  6. Bun runs loader, renders, writes HTML into its shm slot, signals 4B length
  7. Rust reads HTML directly from shm slot (no copy across IPC boundary)
  8. build_document → minify → cache_set → write HTTP response
```

---

## IPC Protocol

One persistent Unix-socket connection per worker. No reconnect per
request. The connection is a stream of length-prefixed frames in both
directions.

### Request — Rust → Bun

```
┌──────────────┬─────────────────────────────────────────────┐
│  4B: length  │  { route_id, params, headers, url }         │
└──────────────┴─────────────────────────────────────────────┘
```

Small payload (typically < 1 KB). The copy is negligible compared to
syscall + scheduler wake-up costs.

### Response — Bun → Rust

```
Unix Socket (signal frame, 8 bytes):
┌──────────────┬──────────────┐
│  4B: length  │  4B: html_len│
└──────────────┴──────────────┘

Shared Memory (data, no socket transfer):
  ptr = shm_base + worker_id × slot_size
  len = html_len
  Rust reads HTML directly from the slot
```

Bun writes the rendered HTML fragment into its dedicated shm slot, then
sends only the 4-byte length back. Rust derives the pointer from the
worker id it already owns. No HTML bytes travel over the socket on the
happy path.

### Fallback for oversized renders

If the rendered HTML exceeds `slot_size`, Bun signals `html_len = 0`
followed by a second frame carrying the full HTML body over the socket.
Slow path, but bounded and tested.

### Honest copy count

```
                              Bun side          IPC          Rust side
                              ─────────────     ─────────    ─────────────────
Path with shm (happy):        1 (encode→shm)    0            0 across IPC
Path with socket fallback:    1 (encode→buf)    1 (kernel)   1 (read into heap)
```

End-to-end the request still passes through `build_document` (1 alloc),
optional `minify` (1 alloc), `cache.set` (clone), and `set_body` (move).
shm saves one ~50 µs `memcpy` on the IPC boundary; the rest of the path
is unchanged. We keep shm because at high RPS those microseconds compound
across cores — but it is an optimisation, not the central architectural
claim.

---

## Shared Memory Layout

```
shm region  (mmap, created by Rust at boot, mapped by all Bun workers)

slot_size = 256 KB   (configurable; oversize falls back to socket transfer)

┌──────────────────┐  offset 0
│     slot-0       │  worker-0 writes here exclusively
│     (256 KB)     │
├──────────────────┤  offset 256 KB
│     slot-1       │  worker-1
│     (256 KB)     │
├──────────────────┤
│      ...         │
└──────────────────┘  offset N × 256 KB

Total: num_cpus × 256 KB
8 cores → 2 MB
```

### Slot ownership invariant

A worker holds its slot exclusively only if it processes **one render at
a time**. Loaders are async, so without coordination a worker could
start a second request while the first is awaiting the database — the
two would race for the same slot.

We enforce the invariant inside the worker: incoming requests on the
Unix socket are queued, and only one is dispatched at a time. The full
"loader → renderToString → shm.write → signal" sequence runs to
completion before the next request is dequeued.

Practical consequences:

- **Throughput.** Per-worker concurrency = 1; total concurrency = N
  workers. For CPU-bound render this is optimal — adding more
  concurrent renders on the same core only adds scheduler churn.
- **Loader parallelism.** Within one request, a loader can still do
  `Promise.all([db.a(), db.b()])` — concurrent I/O *inside* one render
  is fine. Concurrency *across* requests on the same worker is what we
  serialise.
- **Loader-bound workloads.** If your app spends most of its time
  awaiting I/O rather than rendering, throughput is capped at N
  in-flight requests. The future escape hatch is "N slots per worker"
  with a slot id in the response framing; for v1 we keep slot-id =
  worker-id and ship the simpler invariant.

---

## Rust proxy core

There is no `ProxyHttp`. The request path is plain async code over a
`pingora-core` listener:

```rust
// Conceptual sketch — not literal API.

impl Brust {
    async fn handle(&self, req: HttpRequest) -> HttpResponse {
        let key = self.cache.key(&req);                  // path + vary headers

        if let Some(html) = self.cache.get(&key) {
            return HttpResponse::ok(html);               // ~µs, no IPC
        }

        let (route_id, params) = match self.router.match_path(req.path()) {
            Some(m) => m,
            None    => return HttpResponse::not_found(),
        };

        let worker = self.pool.pick_least_busy();        // atomic counter
        let _guard = worker.in_flight_guard();           // dec on drop

        let frame = encode_request(route_id, &params, &req);
        worker.socket.send_frame(&frame).await?;

        let html_len = worker.socket.recv_u32().await?;
        let fragment = if html_len == 0 {
            worker.socket.recv_oversized().await?       // fallback path
        } else {
            self.shm.slot(worker.id, html_len as usize) // happy path, no copy
        };

        let html = self.html.build_document(fragment, &route_id);
        let html = self.html.minify(html);

        self.cache.set(key, html.clone());
        HttpResponse::ok(html)
    }
}
```

### Worker selection

Each worker carries an `AtomicU32` in-flight counter. `pick_least_busy`
scans the N counters (cache-line padded, N ≤ ~256 in practice) and picks
the minimum, breaking ties by worker id. The `in_flight_guard` increments
on entry and decrements on drop, so error paths self-heal.

### Retry semantics

We retry on:

- worker socket closed unexpectedly (worker crashed)
- worker timeout (no signal frame within `render_timeout_ms`)

We do **not** retry on:

- HTTP 4xx from the loader (deterministic; retrying won't help)
- worker reported a render error (loader exceptions, etc.)

Retries always go to a **different** worker — the original worker is
marked unhealthy until its next health-ping responds. Since slot id is
tied to worker id, a retry naturally writes to a different slot; there
is no shared mutable state across retries.

Renders should be idempotent. Brust does not retry requests with methods
other than `GET` / `HEAD`.

### Health checks

Idle workers receive a `PING` frame every `health_interval_ms`; a missed
`PONG` marks the worker unhealthy and triggers respawn. Respawn replaces
the process but keeps the slot id and shm offset.

### Error path

If `renderToString` throws, Bun catches the error, writes an error frame
(`html_len = 0xFFFF_FFFF`, followed by a length-prefixed JSON error
body), and stays alive — no need to respawn for a render error. Rust
maps this to an HTTP 500 with an optional dev-mode error page.

---

## Cache Key & Invalidation

The cache is correct only as far as the key captures everything the
render depends on.

**Default key:** `method + path + sorted query + vary_headers`

Vary headers are declared per route:

```tsx
{
  path: "/blog/:slug",
  component: () => import("./pages/Blog"),
  loader: async (req, { slug }) => ({ post: await db.getPost(slug) }),
  cache: {
    vary: ["accept-language"],
    ttl_seconds: 60,
  },
}
```

**Opt-out:** `cache: false` on a route bypasses the LRU entirely —
useful for personalised pages, dashboards, anything cookie-dependent.

**Invalidation:**
- TTL-based eviction (per-entry expiry)
- LRU eviction when `max` is reached
- Programmatic: `brust-cli invalidate <path>` writes to a control socket
  the running server listens on

**What the default key cannot capture:**
- session/cookie-dependent content unless declared in `vary`
- responses that mutate global state (don't put those behind a GET)
- A/B tests keyed on a cookie unless the cookie is in `vary`

If you don't think about cache correctness, you will serve one user's
HTML to another. The default is "cache everything by path"; that is the
right default for marketing sites and blogs, the wrong default for
authed apps. Routes without `cache:` declared opt in at their own risk.

---

## How It Works

```
HTTP Request
      │
      ▼
pingora-core listener  (N threads, each with isolated tokio runtime)
      │
      ▼
cache lookup (Rust LRU, key = path + vary headers)
      ├─ HIT  ────────────────────────────────────► Response   (~µs, pure Rust)
      │
      └─ MISS
            │
            ▼
        radix-tree match → (route_id, params)
            │
            ▼
        pool.pick_least_busy()  (atomic counter scan)
            │
            ▼  Unix Socket (length-prefixed JSON, ~1 KB)
        Bun worker-N
          (queue: at most one request in-flight)
          loader()            fetch data (Promise.all OK internally)
          renderToString()    sync, CPU-bound
          shm.write(slot_N)   one encode + copy into shared memory
            │
            ▼  Unix Socket (4B html_len)
        Rust: shm.slot(N, len) → build_document → minify → cache_set
            │
            ▼
        Response
```

---

## Worker Pool

Brust spawns one Bun process per CPU core.

```
num_cpus() = 8

worker-0   /tmp/brust-0.sock   shm slot-0   AtomicU32 in-flight counter
worker-1   /tmp/brust-1.sock   shm slot-1   AtomicU32 in-flight counter
...
worker-7   /tmp/brust-7.sock   shm slot-7   AtomicU32 in-flight counter

Brust manages:
  - persistent Unix socket per worker (one connection, lifetime of the process)
  - least-busy selection (scan atomic counters)
  - PING/PONG health checks
  - respawn on crash or missed PONG
  - retry to a different worker on transport failure
```

Each worker pre-loads all page modules at boot. No cold start per
request. Each worker has an isolated JS heap; GC in one worker does not
pause others. `renderToString` is synchronous and CPU-bound; one process
per core gives true parallel rendering with no contention.

---

## Routing

Define routes once. Used by both server and client.

```tsx
// routes.tsx

export const routes = [
  {
    path: "/",
    component: () => import("./pages/Home"),
    loader: async (req) => ({
      posts: await db.getPosts(),
    }),
  },
  {
    path: "/blog/:slug",
    component: () => import("./pages/Blog"),
    loader: async (req, { slug }) => ({
      post: await db.getPost(slug),
    }),
    cache: { vary: ["accept-language"], ttl_seconds: 60 },
    islands: [
      { name: "Comments", hydrate: "interaction" },
      { name: "ShareBtn", hydrate: "visible" },
    ],
  },
  {
    path: "/app",
    component: () => import("./pages/App"),
    cache: false,                          // authed
    children: [
      { path: "settings", component: () => import("./pages/Settings") },
      { path: "profile",  component: () => import("./pages/Profile") },
    ],
  },
]
```

At boot, Bun parses `routes.tsx` and sends the route patterns (plus
per-route cache config) to Rust over a dedicated control socket. Rust
builds a radix tree.

At request time:

- **URL pattern matching** happens in Rust (radix tree → route_id + params)
- **Loader and component dispatch** happens in Bun (route_id → handler map)

So a request still crosses the IPC boundary, but the pattern-matching
step itself never re-enters JS — relevant when you have hundreds of
routes.

---

## Pages

```tsx
// pages/Blog.tsx

export interface Props {
  post: Post
}

export default function Blog({ post }: Props) {
  return (
    <article>
      <h1>{post.title}</h1>
      <p>{post.content}</p>
      <Comments postId={post.id} />
    </article>
  )
}
```

---

## Islands (On-Demand Hydration)

Brust ships zero application React to the client by default. Mark a
component `"use island"` to opt in to client-side behaviour.

```tsx
// components/Comments.tsx
"use island"

export default function Comments({ postId }: { postId: string }) {
  const [comments, setComments] = useState<Comment[]>([])

  useEffect(() => {
    fetch(`/api/comments/${postId}`)
      .then(r => r.json())
      .then(setComments)
  }, [postId])

  return (
    <section>
      {comments.map(c => <p key={c.id}>{c.body}</p>)}
    </section>
  )
}
```

Rust renders the island as static HTML and injects serialized props:

```html
<div data-component="Comments"
     data-props='{"postId":"abc123"}'
     data-hydrate="interaction">
  <!-- fully pre-rendered, works before JS arrives -->
</div>
```

A tiny bootstrap script attaches lazy hydration triggers. Nothing runs
until the user triggers an island. On trigger, the component's chunk
(and, for the first island on the page, the React runtime) is imported
and `hydrateRoot` resumes from `data-props` — the same state the server
serialized. No data is fetched again.

---

## Hydration Triggers

| Trigger | Activates when |
|---|---|
| `"interaction"` | first `pointerdown` on the element |
| `"visible"` | element enters the viewport (`IntersectionObserver`) |
| `"idle"` | browser reports idle (`requestIdleCallback`) |

```tsx
islands: [
  { name: "Counter",   hydrate: "interaction" },
  { name: "LazyChart", hydrate: "visible"     },
  { name: "Analytics", hydrate: "idle"        },
]
```

---

## Client JS Budget

Honest accounting — including the React runtime where it actually loads:

| Scenario | JS sent to client |
|---|---|
| Page with no islands | **~1 KB** bootstrap only |
| Page with islands, none yet triggered | **~1 KB** bootstrap |
| First island activates | **~45 KB** React runtime (one-time, cached) + island chunk |
| Subsequent islands | **2–10 KB** per chunk, fetched on demand |
| Next.js full hydration | 80–200 KB up-front, no choice |

The React runtime is loaded **lazily**, the first time any island on the
page activates — and never if no island ever activates. Compare to Astro,
which lets you swap React for Preact (~4 KB) and reach the same baseline;
Brust trades the larger React runtime for ecosystem compatibility.

---

## Navigation

```
User clicks <Link to="/blog/next">
  → intercept click
  → GET /_brust/page/blog/next      JSON: { html, islands, head }
  → swap <div id="root">
  → update <title> and <meta>
  → re-wire island hydration triggers on the new DOM
  → pushState
```

The `/_brust/page/*` endpoint runs the full render path (loader + render +
cache) and returns it as JSON instead of HTML. Same server work, smaller
wire format, and the client avoids re-parsing a full HTML document.

---

## Bun Worker

```typescript
// worker.ts — one process per CPU core

const id         = process.env.WORKER_ID!
const socketPath = `/tmp/brust-${id}.sock`
const shmFd      = parseInt(process.env.SHM_FD!)
const slotSize   = parseInt(process.env.SLOT_SIZE!)
const slotOffset = parseInt(id) * slotSize

// map shared memory segment (this worker's slot only)
const shm = new SharedMemory(shmFd, slotSize, slotOffset)

// pre-load all page modules once at boot — no cold start per request
const pages = await loadAllPages("./pages")

// One in-flight render at a time. Subsequent frames wait in the socket
// buffer until the current render completes.
const queue = new SerialQueue()

const server = Bun.listen({
  unix: socketPath,
  socket: {
    data(socket, chunk) {
      framer.push(chunk, (frame) => queue.enqueue(() => handle(socket, frame)))
    },
  },
})

async function handle(socket, frame) {
  try {
    const { route_id, params } = JSON.parse(frame)
    const page                 = pages.get(route_id)!

    const props    = await page.loader(params)
    const fragment = renderToString(createElement(page.component, props))

    if (fragment.length > slotSize) {
      socket.write(u32(0))                // signal fallback
      socket.write(u32(fragment.length))
      socket.write(fragment)              // socket transfer
    } else {
      const len = shm.writeUTF8(fragment) // 1 encode into shm
      socket.write(u32(len))              // 4B signal only
    }
  } catch (err) {
    const body = JSON.stringify({ message: String(err) })
    socket.write(u32(0xFFFF_FFFF))        // error sentinel
    socket.write(u32(body.length))
    socket.write(body)
  }
}
```

---

## Streaming SSR

`renderToString` produces a complete HTML blob, so the shm slot model
fits naturally. We do not currently support React 18's
`renderToPipeableStream`; adding it would require a multi-write protocol
into the slot (or back to socket-based streaming) and is **deferred to
a future version**. For most pages — especially blogs, marketing, and
content-heavy sites — the latency win from streaming is small relative
to render time, so this is a deliberate trade rather than an oversight.

---

## Single Binary Deploy

```
Build:

  1.  bun build --compile worker.ts  →  bun-worker        (~50 MB, vendored Bun)
  2.  include_bytes!("bun-worker")   →  embedded in Rust
  3.  cargo build --release          →  ./brust            (~80–120 MB)

Deploy:

  scp ./brust user@server:~/
  ./brust

No separate Bun install. No node_modules. No Docker required.
```

**Honest trade:** `bun build --compile` embeds a specific Bun version.
Security patches or perf improvements in Bun require rebuilding Brust —
this is **vendoring** Bun, not eliminating it. The single-binary deploy
benefit is real (one file to ship, one runtime guarantee); the
"no Bun to install" framing is shorthand for "Brust ships its own
copy of Bun and is responsible for keeping it current."

On Linux, the embedded Bun binary is mapped into memory via
`memfd_create` and executed from `/proc/self/fd/N` — no disk write. On
macOS, it's extracted to `/tmp/brust-worker-{hash}` and reused across
runs (hash matches → skip extraction).

---

## Configuration

```toml
# brust.toml

[server]
port    = 3000
threads = 0          # 0 = num_cpus

[workers]
count           = 0           # 0 = num_cpus
socket          = "/tmp/brust-{id}.sock"
slot_size       = 262144      # 256 KB per worker; oversize falls back to socket
render_timeout_ms  = 5000     # kill render after this
health_interval_ms = 30000

[cache]
max = 100            # max pages in LRU
ttl = 60             # default seconds (overridden per-route), 0 = no expiry

[build]
minify = true
pages  = "./pages"
routes = "./routes.tsx"
```

---

## Project Structure

```
my-app/
├── brust.toml
├── routes.tsx              route definitions (server + client)
├── pages/
│   ├── Home.tsx
│   ├── Blog.tsx
│   └── App.tsx
├── components/
│   ├── Comments.tsx        "use island"
│   └── Counter.tsx         "use island"
└── public/                 static assets
```

---

## Crate Structure

We start with four crates. More can be split out when there is a reason
(reuse outside Brust, independent versioning, build-time isolation).
Workspace splitting has real costs — longer builds, less inlining, deps
graph drift — and we don't pay them until we have to.

```
brust/
├── brust-core/        listener, proxy core, cache, html, router, shm
├── brust-worker/      spawn Bun processes, manage shm fds & sockets
├── brust-cli/         brust dev / brust build / brust start / invalidate
└── brust-runtime-js/  Bun-side runtime (worker.ts, framer, hydration bootstrap)
```

Future splits we'd consider, once the API stabilises: `brust-cache`,
`brust-html`, `brust-router`. Not until then.

---

## Performance Profile

The numbers below are design targets, not benchmarks. They will be
re-stated as measurements once an MVP is running end-to-end.

| Path | Target latency | What runs |
|---|---|---|
| Cache hit | ~µs | pure Rust, zero IPC |
| Cache miss (warm worker, simple page) | ~2 ms | Rust + Bun render |
| IPC response transfer | 0 copies across IPC | shm ptr + 4B len signal |
| First paint | immediate | HTML, no JS blocks render |
| Island hydration | on-demand | only on user interaction |

We will publish measured numbers against:

- **Astro** (the closest comparable — islands, Node/Bun runtime, JS-only)
- **Bun.serve + react-router v7** (the simplest possible Bun-native SSR)
- **Next.js App Router** (the incumbent, for context)

Without those numbers, claims of "Brust is faster" are unsubstantiated
and we won't make them.

---

## Comparison

| | Next.js | Astro | Bun + react-router | **Brust** |
|---|---|---|---|---|
| HTTP layer | Node.js | Node.js | Bun | **Rust (pingora-core)** |
| Bundler | webpack | Vite | Bun built-in | **Bun built-in** |
| Cache | JS (GC) | JS (GC) | none built-in | **Rust LRU (no GC)** |
| HTML processing | JS | JS | JS | **Rust** |
| Response IPC | — | — | — | **shm ptr + len (custom)** |
| Workers | single process | single process | single process | **N × CPU cores** |
| Hydration | full page | islands | full page | **on-demand islands** |
| Client JS (baseline) | 80–200 KB | 0–10 KB | 80–200 KB | **~1 KB + 45 KB on first hydrate** |
| Deploy | directory | directory | single binary¹ | **single binary** |

¹ Bun supports single-binary compile too — Brust's advantage there is
the embedded Rust proxy and cache, not the binary format.

---

## Status

Brust is a design concept. Open questions tracked in the doc itself:

- Measured latency vs Astro and Bun-native baseline (none yet)
- Whether `pingora-core` is worth the dependency weight vs `tokio` + `hyper` directly
- Streaming SSR support (deferred)
- N-slots-per-worker variant for loader-bound workloads (deferred)

Contributions welcome.

---

*Brust — Built to burst.*
