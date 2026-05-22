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
  Spawn N Bun workers = num_cpus()

Request lifecycle (Pingora ProxyHttp):

  upstream_peer()       select least-busy Bun worker socket
  request_filter()      Rust LRU cache lookup
    HIT  → short-circuit, return HTML immediately   (~µs, pure Rust)
    MISS → continue to Bun
  [Pingora forwards to Bun via Unix Socket]
  response_filter()     build_document + minify + cache_set
```

---

## Pingora Pipeline

```rust
#[async_trait]
impl ProxyHttp for Brust {

    // 1. รับ request → check cache
    async fn request_filter(&self, req: &mut Session, ctx: &mut Ctx) -> Result<bool> {
        if let Some(html) = self.cache.get(req.req_header().uri.path()) {
            ctx.cached = Some(html);
            return Ok(true)   // short-circuit, skip Bun entirely
        }
        Ok(false)
    }

    // 2. เลือก Bun worker (Pingora จัดการ pool ให้)
    async fn upstream_peer(&self, _: &mut Session, _: &mut Ctx) -> Result<Box<HttpPeer>> {
        let worker = self.lb.select(b"", 256).unwrap();
        Ok(Box::new(HttpPeer::new(worker, false, String::new())))
    }

    // 3. ได้ HTML fragment จาก Bun → wrap + cache
    async fn response_filter(&self, _: &mut Session, resp: &mut Response, ctx: &mut Ctx) -> Result<()> {
        let fragment = resp.read_body().await?;
        let html     = self.builder.build_document(fragment, &ctx.meta);
        self.cache.set(ctx.path.clone(), html.clone());
        resp.set_body(html);
        Ok(())
    }

    // 4. upstream ล้มเหลว → Pingora retry อัตโนมัติ
    fn should_retry(&self, _: &Session, retries: usize, _: &Ctx, _: &Error) -> bool {
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
Pingora listener  (multi-threaded, per-thread tokio runtime)
      │
      ▼
request_filter()
      ├─ cache HIT ──────────────────────────────── Response   (~µs, pure Rust)
      │
      └─ cache MISS
             │
             ▼
        upstream_peer()
        Pingora LoadBalancer → least-busy Bun worker
             │
             ▼
        Unix Domain Socket → Bun worker-N
        (persistent connection, managed by Pingora pool)
             │
             ▼
        loader() → fetch data
        renderToString(<Page props />)
             │
             ◄─── HTML fragment
             │
        response_filter()
        Rust: build_document + minify + cache_set
             │
             ▼
        Response
```

---

## Worker Pool

Brust spawns one Bun process per CPU core.

```
num_cpus() = 8

/tmp/brust-0.sock  →  Bun worker-0   (isolated JS heap)
/tmp/brust-1.sock  →  Bun worker-1
...
/tmp/brust-7.sock  →  Bun worker-7

Pingora LoadBalancer manages:
  - connection pool per worker
  - least-busy selection
  - health checks
  - automatic failover
  - retry on error
```

Each worker pre-loads all page modules at boot.
`renderToString` is synchronous and CPU-bound —
one isolated process per core gives true parallel rendering.

---

## Routing

Define routes once. Shared between server and client.

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

At boot, Bun parses `routes.tsx` and sends all patterns to Rust via
the control socket. Rust builds a radix tree. URL matching from that
point forward never touches Bun.

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
Components opt in to client-side behavior with `"use island"`.

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

Rust renders the island as static HTML with serialized props:

```html
<div data-component="Comments"
     data-props='{"postId":"abc123"}'
     data-hydrate="interaction">
  <!-- pre-rendered static HTML, works before JS loads -->
</div>
```

The bootstrap script (~500 bytes, not React) attaches listeners.
No React runs until the user triggers the island.
On trigger, the component hydrates and resumes from `data-props`.

---

## Hydration Triggers

| Trigger | When |
|---|---|
| `"interaction"` | first `pointerdown` on the element |
| `"visible"` | element enters the viewport |
| `"idle"` | browser is idle (`requestIdleCallback`) |

```tsx
islands: [
  { name: "Counter",   hydrate: "interaction" },
  { name: "LazyChart", hydrate: "visible" },
  { name: "Analytics", hydrate: "idle" },
]
```

---

## Client JS Budget

| Page type | JS sent to client |
|---|---|
| No islands | **0 KB** |
| With islands | **2–10 KB** per component, loaded on demand |
| Bootstrap | **~500 B** always |
| Next.js equivalent | 80–200 KB |

---

## Navigation

```
User clicks <Link to="/blog/next">
  → intercept native navigation
  → GET /ssr/blog/next   returns JSON: { html, loaderData }
  → swap <div id="root">
  → update <title>, <meta>
  → pushState
```

No React Router bundle. No full page reload.
The `/ssr/*` endpoint runs only the loader, not the full render,
for pages already hydrated on the client.

---

## IPC Protocol

```
Rust → Bun  (request frame)
┌──────────────┬───────────────────────────────────────────┐
│  4B: length  │  { route, params, headers, url }          │
└──────────────┴───────────────────────────────────────────┘

Bun → Rust  (response frame)
┌──────────────┬───────────────────────────────────────────┐
│  4B: length  │  { html, status }                         │
└──────────────┴───────────────────────────────────────────┘
```

Persistent connections managed by Pingora's upstream pool.
No reconnect overhead per request.

---

## Bun Worker

```typescript
// worker.ts — one process per CPU core

const id         = process.env.WORKER_ID!
const socketPath = `/tmp/brust-${id}.sock`

// pre-load all page modules once at boot
const pages = await loadAllPages("./pages")

Bun.listen({ unix: socketPath }, async (socket, frame) => {
  const { route, params } = JSON.parse(frame)
  const page              = pages.get(route)

  const props    = await page.loader(params)
  const fragment = renderToString(createElement(page.component, props))

  socket.write(encode({ html: fragment, status: 200 }))
})
```

---

## Single Binary Deploy

```
Build:

  1.  bun build --compile worker.ts  →  bun-worker
  2.  include_bytes!("bun-worker")   →  embedded in Rust binary
  3.  cargo build --release          →  ./brust   (~56 MB)

Deploy:

  scp ./brust user@server:~/
  ./brust

No Bun to install. No Node. No node_modules. No Docker required.
```

On Linux, the embedded Bun binary is loaded via `memfd_create` —
no disk write at any point.

---

## Configuration

```toml
# brust.toml

[server]
port    = 3000
threads = 0        # 0 = num_cpus

[workers]
count   = 0        # 0 = num_cpus
socket  = "/tmp/brust-{id}.sock"

[cache]
max     = 100      # max pages in LRU
ttl     = 60       # seconds, 0 = no expiry

[build]
minify  = true
pages   = "./pages"
routes  = "./routes.tsx"
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
├── brust-core/         Pingora proxy + lifecycle hooks
├── brust-cache/        Rust LRU cache
├── brust-html/         build_document, minify, island injection
├── brust-router/       radix tree, pattern matching, param extraction
├── brust-worker/       spawn + manage Bun processes
└── brust-cli/          brust dev / brust build / brust start
```

---

## Performance Profile

| Path | Latency | What runs |
|---|---|---|
| Cache hit | ~µs | pure Rust, nothing else |
| Cache miss (warm worker) | ~2 ms | Rust + Bun render |
| First paint | immediate | HTML, no JS blocks render |
| Island hydration | on-demand | triggered by user action only |

---

## Comparison

| | Next.js | Remix | Astro | **Brust** |
|---|---|---|---|---|
| HTTP layer | Node.js | Node.js | Node.js | **Pingora (Rust)** |
| Bundler | webpack | esbuild | Vite | **Bun built-in** |
| Cache | JS (GC) | JS (GC) | JS (GC) | **Rust (no GC)** |
| HTML processing | JS | JS | JS | **Rust** |
| Workers | single process | single process | single process | **N × CPU cores** |
| Hydration | full page | full page | islands | **on-demand only** |
| Client JS | 80–200 KB | 60–150 KB | 0–10 KB | **0–10 KB** |
| Deploy | directory | directory | directory | **single binary** |

---

## Status

Brust is a design concept. Contributions welcome.

---

*Brust — Built to burst.*