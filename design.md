# Brust

**B**un + **Rust** — SSR framework that bursts.

React on the server. Rust everywhere else. Ships as a single binary.

Built on [Pingora](https://github.com/cloudflare/pingora) — the same proxy engine that powers Cloudflare.

---

## Why Brust

Traditional SSR frameworks make you pay three times:

1. Server renders HTML
2. Client downloads the entire framework bundle
3. Client re-runs everything to "hydrate"

Brust pays once. Server renders, client resumes only when needed.

---

## Why Pingora over Axum

Brust is fundamentally a **proxy** sitting in front of Bun workers — not a web app.
Pingora was built for exactly this workload.

```
Axum    → build web apps and APIs
Pingora → build proxies and gateways  ← this is Brust
```

What Pingora gives for free:

| Feature | Axum | Pingora |
|---|---|---|
| Upstream connection pool | manual | built-in |
| Load balancing | manual | `pingora-load-balancing` |
| Health checks | manual | built-in |
| Retry logic | manual | built-in |
| Circuit breaker | manual | built-in |
| Per-thread tokio runtime | no | yes |

The threading model also matches Brust's worker pool naturally —
Pingora runs N threads each with an isolated runtime,
mirroring N Bun workers each with an isolated JS heap.

---

## Architecture

```
Single Binary (~56 MB)
├── Rust (Pingora)
└── Bun runtime + JS bundle     (embedded via include_bytes!)

Boot:
  Rust extracts Bun binary
    Linux  → memfd_create (no disk write)
    macOS  → /tmp/brust-worker-{hash}
  Bun master parses routes.tsx → sends route registry to Rust
  Rust builds radix tree
  Rust creates shared memory (N slots × 256 KB)
  Spawn N Bun workers = num_cpus(), each receives shm fd

Request lifecycle (Pingora ProxyHttp):

  request_filter()      Rust LRU cache lookup
    HIT  → return HTML immediately             (~µs, pure Rust, 0 IPC)
    MISS → continue
  upstream_peer()       pick least-busy Bun worker
  [send route + params via Unix Socket]
  [Bun renders → writes HTML to shared memory slot]
  [Bun sends back html_len, 4 bytes, via Unix Socket]
  response_filter()     ptr into shm slot, build_document, cache_set
```

---

## IPC Protocol

Two channels per worker. Both are persistent — no reconnect per request.

### Request  Rust → Bun  (Unix Socket)

```
┌──────────────┬────────────────────────────────────────────┐
│  4B: length  │  { route, params, headers, url }           │
└──────────────┴────────────────────────────────────────────┘
```

Small payload (< 1 KB). Copy is acceptable.

### Response  Bun → Rust  (Unix Socket signal + Shared Memory data)

```
Unix Socket (signal only):
┌──────────────┬──────────────┐
│  4B: length  │  4B: html_len│   8 bytes total
└──────────────┴──────────────┘

Shared Memory (zero-copy data):
  ptr = shm_base + worker_id × slot_size
  len = html_len
  Rust reads HTML directly — no copy
```

Bun writes the rendered HTML fragment into its dedicated shared memory slot,
then signals Rust with only the length. Rust derives the pointer from the
worker ID it already knows. No HTML bytes travel over the socket.

### Copy Count Comparison

```
Unix Socket only:   JS string → encode → kernel → Rust heap   (3 copies)
Socket + shm:       JS string → shm slot                      (1 copy)
                    Rust reads shm slot directly               (0 copies)
```

One copy is unavoidable: JSC strings are not flat UTF-8 buffers and must
be encoded before writing anywhere.

---

## Shared Memory Layout

```
shm region  (mmap, created by Rust at boot, mapped by all Bun workers)

slot_size = 256 KB   (configurable, must be ≥ max rendered HTML)

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

Because `renderToString` is synchronous, each worker handles one request
at a time and always owns its slot exclusively. No locks. No coordination.

If rendered HTML exceeds `slot_size`, Brust falls back to sending the full
body over the socket for that request.

---

## Pingora Pipeline

```rust
#[async_trait]
impl ProxyHttp for Brust {

    // 1. Check cache — skip Bun entirely on hit
    async fn request_filter(
        &self,
        session: &mut Session,
        ctx: &mut Ctx,
    ) -> Result<bool> {
        let path = session.req_header().uri.path();
        if let Some(html) = self.cache.get(path) {
            ctx.cached = Some(html);
            return Ok(true);   // short-circuit
        }
        Ok(false)
    }

    // 2. Select Bun worker — Pingora manages the pool
    async fn upstream_peer(
        &self,
        _session: &mut Session,
        _ctx: &mut Ctx,
    ) -> Result<Box<HttpPeer>> {
        let worker = self.lb.select(b"", 256).unwrap();
        Ok(Box::new(HttpPeer::new(worker, false, String::new())))
    }

    // 3. Receive html_len signal, read HTML from shm, build document
    async fn response_filter(
        &self,
        _session: &mut Session,
        resp: &mut Response,
        ctx: &mut Ctx,
    ) -> Result<()> {
        let html_len  = resp.read_body_u32().await?;
        let worker_id = ctx.worker_id;

        // zero-copy: pointer arithmetic into shared memory
        let fragment = self.shm.slot(worker_id, html_len as usize);
        let html     = self.html.build_document(fragment, &ctx.meta);

        self.cache.set(ctx.path.clone(), html.clone());
        resp.set_body(html);
        Ok(())
    }

    // 4. Pingora retries automatically on upstream failure
    fn should_retry(
        &self,
        _session: &Session,
        retries: usize,
        _ctx: &Ctx,
        _error: &Error,
    ) -> bool {
        retries < 2
    }
}
```

---

## How It Works

```
HTTP Request
      │
      ▼
Pingora listener  (N threads, each with isolated tokio runtime)
      │
      ▼
request_filter()
      ├─ cache HIT ─────────────────────────────── Response   (~µs, pure Rust)
      │
      └─ cache MISS
             │
             ▼
        upstream_peer()
        Pingora LoadBalancer → least-busy Bun worker
             │
             ▼  Unix Socket (route + params, ~1 KB)
        Bun worker-N
          loader()            fetch data
          renderToString()    sync, CPU-bound
          shm.write(slot_N)   write HTML to shared memory
             │
             ▼  Unix Socket (html_len, 4 bytes)
        response_filter()
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

worker-0   /tmp/brust-0.sock   shm slot-0
worker-1   /tmp/brust-1.sock   shm slot-1
...
worker-7   /tmp/brust-7.sock   shm slot-7

Pingora LoadBalancer manages:
  - persistent connection pool per worker
  - least-busy selection
  - health checks
  - automatic failover
  - retry on upstream error
```

Each worker pre-loads all page modules at boot. No cold start per request.
Each worker has an isolated JS heap. GC in one worker does not pause others.
`renderToString` is synchronous and CPU-bound: one process per core gives
true parallel rendering with no contention.

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
    islands: [
      { name: "Comments", hydrate: "interaction" },
      { name: "ShareBtn", hydrate: "visible" },
    ],
  },
  {
    path: "/app",
    component: () => import("./pages/App"),
    children: [
      { path: "settings", component: () => import("./pages/Settings") },
      { path: "profile",  component: () => import("./pages/Profile") },
    ],
  },
]
```

At boot, Bun parses `routes.tsx` and sends all patterns to Rust over
a dedicated control socket. Rust builds a radix tree. URL matching
never touches Bun again at request time.

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

Brust ships zero React to the client by default.
Mark a component `"use island"` to opt in to client-side behavior.

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

A bootstrap script (~500 bytes, not React) attaches event listeners.
Nothing runs until the user triggers the island. On trigger, the
component's JS is imported and `hydrateRoot` resumes from `data-props` —
the same state the server serialized. No data is fetched again.

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

| Page type | JS sent to client |
|---|---|
| No islands | **0 KB** |
| With islands | **2–10 KB** per component, fetched on demand |
| Bootstrap script | **~500 B** on every page |
| Next.js equivalent | 80–200 KB |

---

## Navigation

```
User clicks <Link to="/blog/next">
  → intercept
  → GET /ssr/blog/next         JSON: { html, loaderData }
  → swap <div id="root">
  → update <title> and <meta>
  → pushState
```

No React Router bundle. No full page reload.
`/ssr/*` runs only the loader for pages the client has already rendered.

---

## Bun Worker

```typescript
// worker.ts — one process per CPU core

const id         = process.env.WORKER_ID!
const socketPath = `/tmp/brust-${id}.sock`
const shmFd      = parseInt(process.env.SHM_FD!)
const slotSize   = parseInt(process.env.SLOT_SIZE!)
const slotOffset = parseInt(id) * slotSize

// map shared memory segment
const shm = new SharedMemory(shmFd, slotSize, slotOffset)

// pre-load all page modules once at boot — no cold start per request
const pages = await loadAllPages("./pages")

Bun.listen({ unix: socketPath }, async (socket, frame) => {
  const { route, params } = JSON.parse(frame)
  const page              = pages.get(route)!

  const props    = await page.loader(params)
  const fragment = renderToString(createElement(page.component, props))

  // encode directly into shared memory slot — 1 copy, no socket transfer
  const len = shm.writeUTF8(fragment)

  // signal Rust with length only
  socket.write(u32ToBytes(len))
})
```

---

## Single Binary Deploy

```
Build:

  1.  bun build --compile worker.ts  →  bun-worker        (standalone Bun exe)
  2.  include_bytes!("bun-worker")   →  embedded in Rust
  3.  cargo build --release          →  ./brust            (~56 MB)

Deploy:

  scp ./brust user@server:~/
  ./brust

No Bun to install. No Node. No node_modules. No Docker required.
```

On Linux, the embedded Bun binary is mapped into memory via `memfd_create`
and executed from `/proc/self/fd/N`. No disk write at any point.

---

## Configuration

```toml
# brust.toml

[server]
port    = 3000
threads = 0          # 0 = num_cpus

[workers]
count     = 0        # 0 = num_cpus
socket    = "/tmp/brust-{id}.sock"
slot_size = 262144   # 256 KB per worker, must be >= max rendered HTML

[cache]
max = 100            # max pages in LRU
ttl = 60             # seconds, 0 = no expiry

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

```
brust/
├── brust-core/         Pingora proxy + ProxyHttp lifecycle
├── brust-cache/        Rust LRU cache (no GC)
├── brust-html/         build_document, minify, island injection
├── brust-router/       radix tree, pattern matching, param extraction
├── brust-shm/          shared memory manager, slot allocator
├── brust-worker/       spawn Bun processes, manage shm fds
└── brust-cli/          brust dev / brust build / brust start
```

---

## Performance Profile

| Path | Latency | What runs |
|---|---|---|
| Cache hit | ~µs | pure Rust, zero IPC |
| Cache miss (warm worker) | ~2 ms | Rust + Bun render |
| IPC response transfer | 0 copies | shm ptr + len, no socket data |
| First paint | immediate | HTML, no JS blocks render |
| Island hydration | on-demand | only on user interaction |

---

## Comparison

| | Next.js | Remix | Astro | **Brust** |
|---|---|---|---|---|
| HTTP layer | Node.js | Node.js | Node.js | **Pingora (Rust)** |
| Bundler | webpack | esbuild | Vite | **Bun built-in** |
| Cache | JS (GC) | JS (GC) | JS (GC) | **Rust (no GC)** |
| HTML processing | JS | JS | JS | **Rust** |
| Response IPC | — | — | — | **shm ptr + len** |
| Workers | single process | single process | single process | **N × CPU cores** |
| Hydration | full page | full page | islands | **on-demand only** |
| Client JS | 80–200 KB | 60–150 KB | 0–10 KB | **0–10 KB** |
| Deploy | directory | directory | directory | **single binary** |

---

## Status

Brust is a design concept. Contributions welcome.

---

*Brust — Built to burst.*