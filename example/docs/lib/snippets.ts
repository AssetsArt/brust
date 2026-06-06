// Every code sample shown on the docs, as plain strings highlighted server-side
// (Prism, in the loader). They live here — NOT inline in pages — because the
// native compiler rejects template literals in page bodies (gap G1) and the
// directive scanner is a text-regex (gap G5): a page whose source contained the
// marker phrase for a behavior export would be mistaken for a directive component
// and break the build. None of these strings contain that phrase (the two that show a
// real behavior live in their component files — Clock.tsx / Toggle.tsx `source`).
//
// All samples use the REAL brust API (verified against runtime/): capital
// `Component`, `brust.run`, treaty `client`, route-level `cache`/`sse`/`websocket`,
// `brust.toml`, `useStore`/`useNav` from `brustjs/client`, `navigate` from
// `brustjs/navigation`.

export const S = {
  // ── Home ───────────────────────────────────────────────────────────────────
  // Real routes from example/pokedex (trimmed) — every route native: compiled to
  // a minijinja template and rendered in Rust. Nested under one AppLayout/<Outlet>.
  heroRoutes: `import { defineRoutes } from 'brustjs/routes'
import AppLayout from './components/AppLayout'
import { homeLoader, detailLoader } from './lib/loaders'
import HomePage from './pages/HomePage'
import DetailPage from './pages/DetailPage'

export const routes = defineRoutes([
  {
    Component: AppLayout,            // native layout — renders <Outlet/>
    native: true,
    children: [
      // rendered in Rust, zero client JS
      { path: '/', Component: HomePage, native: true, loader: homeLoader },
      { path: '/pokemon/{name}', Component: DetailPage, native: true, loader: detailLoader },
    ],
  },
])`,

  // ── Introduction ────────────────────────────────────────────────────────────
  boot: `import { brust } from 'brustjs'
import { routes } from './routes'
import { actions } from './actions'

// One process, two runtimes: Bun owns the build, Rust owns the socket.
await brust.run({ routes, entry: import.meta.url, actions })`,

  // ── Installation ──────────────────────────────────────────────────────────────
  scaffold: `# scaffold a new app
bun create brustjs my-app

cd my-app
bun install
bun run dev   # ▲ http://localhost:1337`,

  addExisting: `bun add brustjs react react-dom
bun add -d @types/react @types/react-dom`,

  pkgScripts: `{
  "scripts": {
    "dev": "brust dev index.ts",
    "build": "brust build index.ts",
    "start": "bun run dist/index.js"
  },
  "dependencies": {
    "brustjs": "^0.1.39-alpha",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}`,

  // ── Project structure ────────────────────────────────────────────────────────
  layoutTree: `my-app/
├─ index.ts              # brust.run({ routes, actions }) — the entry
├─ routes.tsx            # defineRoutes() — the route table
├─ actions.ts            # defineActions() — your typed API + MCP tools
├─ app.css               # Tailwind v4 entry (@import "tailwindcss")
├─ components/
│  ├─ Layout.tsx         # native — the document shell, renders <Outlet/>
│  └─ Counter.tsx        # native — x-* directives + a behavior export
├─ pages/
│  ├─ Home.tsx           # native: true  (rendered in Rust)
│  └─ Dashboard.tsx      # streaming SSR + islands
├─ public/               # static assets, served by Rust
├─ brust.toml            # server config (optional)
└─ package.json`,

  brustToml: `# brust.toml — all optional; env vars and CLI flags override these.
[server]
address = "0.0.0.0"
port = 1337

[workers]
count = 4        # render threads (default: availableParallelism())`,

  // ── First route ──────────────────────────────────────────────────────────────
  firstNative: `// pages/Home.tsx — a native route renders to HTML in Rust.
export default function Home() {
  return (
    <main className="prose">
      <h1>Hello from Rust</h1>
      <p>This page rendered without touching the JS runtime.</p>
    </main>
  )
}`,

  firstRegister: `// routes.tsx
import { defineRoutes } from 'brustjs/routes'
import Home from './pages/Home'

export const routes = defineRoutes([
  { path: '/', Component: Home, native: true },
])`,

  firstLoader: `// pages/Home.tsx
export async function homeLoader() {
  return { now: new Date().toISOString() }
}

// the loader's return value becomes the component's props
export default function Home({ now }: { now: string }) {
  return <p>Rendered at <time>{now}</time></p>
}`,

  firstRun: `bun run dev
# ▲ brust dev  ·  http://localhost:1337  ·  ready in 9ms`,

  // ── Dev & build ──────────────────────────────────────────────────────────────
  cmdDev: `bun run dev          # brust dev index.ts
# ▲ brust dev  ·  http://localhost:1337
#   native routes  2  ·  islands  1  ·  actions  2
#   watching . — hot reload on save`,

  cmdBuild: `bun run build        # brust build index.ts
# islands:    1 chunk(s) → dist/islands
# directives: runtime + 6 component chunk(s)
# mcp:        2 tools + 5 resources → dist/mcp-manifest.json
# jinja:      5 template(s) → dist/jinja
# css:        dist/css/app.css
# bundle:     dist/index.js
# ✓ done.`,

  cmdStart: `bun run dist/index.js
# ▲ brust  ·  0.0.0.0:1337  ·  http/1.1 + http/2  ·  native hyper`,

  // ── Routing ──────────────────────────────────────────────────────────────────
  defineRoutes: `import { defineRoutes } from 'brustjs/routes'
import Layout from './components/Layout'
import Home from './pages/Home'
import Dashboard from './pages/Dashboard'
import ServerDetail from './pages/Server'

export const routes = defineRoutes([
  {
    Component: Layout,            // a layout — renders <Outlet/>
    native: true,
    children: [
      { index: true, Component: Home, native: true, loader: homeLoader },
      { path: '/dashboard', Component: Dashboard, loader: dashboardLoader },
      { path: '/servers/:id', Component: ServerDetail, loader: serverLoader },
    ],
  },
])`,

  outlet: `import { BrustPage, Outlet } from 'brustjs'

export default function Layout({ title }: { title: string }) {
  return (
    <BrustPage title={title}>
      <Sidebar />
      <main>
        <Outlet />   {/* the active child route renders here */}
      </main>
    </BrustPage>
  )
}`,

  params: `// path: '/servers/:id'  →  params.id: string
import { notFound } from 'brustjs/routes'

export async function serverLoader({ params }: { params: { id: string } }) {
  const server = await db.servers.find(params.id)
  if (!server) return notFound()      // render the 404 boundary
  return { server }
}

export default function ServerDetail({ server }) {
  return <h1>{server.name}</h1>
}`,

  loaders: `export async function dashboardLoader({ req }) {
  const [servers, regions] = await Promise.all([
    db.servers.list(),
    db.regions.summary(),
  ])
  return { servers, regions }          // ← inferred prop types
}

export default function Dashboard({ servers, regions }) {
  return <ServerTable rows={servers} />
}`,

  middleware: `import type { Middleware } from 'brustjs/routes'

// Middleware is a plain typed function: (req, next) => Promise<RouteResponse>.
const requireUser: Middleware = async (req, next) => {
  const session = await readSession(req)
  if (!session) {
    return { status: 302, headers: { location: '/login' }, body: '' }
  }
  return next()    // run the rest of the chain (loader + render)
}

// attach it to a route (parent middleware runs before child)
// { path: '/dashboard', Component: Dashboard, middleware: [requireUser] }`,

  navigation: `import { navigate } from 'brustjs/navigation'
import { useNav } from 'brustjs/client'

// imperative SPA navigation — fetches the next route, swaps the matched segment
function openServer(id: string) {
  navigate('/servers/' + id)
}

// subscribe a React island to navigation state (phase: idle | loading)
function Progress() {
  const { phase } = useNav()
  return phase === 'loading' ? <Spinner /> : null
}`,

  // ── Rendering ────────────────────────────────────────────────────────────────
  streaming: `import { Suspense } from 'react'

export default function Dashboard({ servers }) {
  return (
    <>
      <Header />                          {/* flushed immediately */}
      <Suspense fallback={<TableSkeleton />}>
        <ServerTable rows={servers} />    {/* streamed when ready */}
      </Suspense>
    </>
  )
}`,

  modes: `// native: rendered in Rust, 0 kb JS
{ path: '/', Component: Home, native: true }

// streaming SSR + islands (React on the server, hydrates islands only)
{ path: '/dashboard', Component: Dashboard }`,

  island: `// components/Search.island.tsx
import { useState } from 'react'

export default function Search() {
  const [q, setQ] = useState('')
  return (
    <input value={q} onChange={(e) => setQ(e.target.value)}
           placeholder="Search…" />
  )
}`,

  islandUse: `import { Island } from 'brustjs'
import Search from './Search.island'

export default function Header() {
  return (
    <header>
      <Logo />
      {/* hydrates on load; 'visible' / 'idle' also available */}
      <Island component={Search} hydrate="load" />
    </header>
  )
}`,

  isr: `// Cache a route's rendered HTML in the Rust layer for 300s.
export const routes = defineRoutes([
  {
    path: '/posts/:slug',
    Component: Post,
    loader: postLoader,
    cache: { ttl_seconds: 300, tags: ['posts'] },
  },
])`,

  isrInvalidate: `import { cache } from 'brustjs'

// drop cached pages tagged "posts" — e.g. from an action after a publish
cache.invalidate({ tags: ['posts'] })`,

  // ── Native interactivity ─────────────────────────────────────────────────────
  directives: `// A native component becomes interactive with x-* attributes.
// Logic lives in a co-located behavior export — auto x-data is injected.
export default function Panel() {
  return (
    <div>
      <button x-on-click="toggle">Toggle</button>
      <div x-show="open">
        <button x-on-click="dec">–</button>
        <output x-text="count">3</output>
        <button x-on-click="inc">+</button>
      </div>
    </div>
  )
}`,

  chunks: `import { Island } from 'brustjs'

<Island component={Panel} hydrate="visible" />  {/* default: on view */}
<Island component={Panel} hydrate="load" />     {/* on first load */}
<Island component={Panel} hydrate="idle" />     {/* requestIdleCallback */}`,

  // ── Store ────────────────────────────────────────────────────────────────────
  signals: `import { signal, computed, effect } from 'brustjs/store'

const count = signal(0)
const doubled = computed(() => count() * 2)

effect(() => {
  console.log('count is', count(), '→', doubled())
})

count.set(2)              // logs: count is 2 → 4
count.set(count() + 1)    // logs: count is 3 → 6`,

  defineStore: `import { defineStore, signal, computed } from 'brustjs/store'

export const cart = defineStore('cart', () => {
  const items = signal<Item[]>([])
  const total = computed(() =>
    items().reduce((sum, i) => sum + i.price * i.qty, 0),
  )
  const add = (item: Item) => items.set([...items(), item])
  const clear = () => items.set([])
  return { items, total, add, clear }
})`,

  singleton: `// header island and drawer island — different chunks…
import { cart } from '../store'   // …the same instance

cart.add(product)   // both islands re-render`,

  useStore: `import { useStore } from 'brustjs/client'
import { cart } from '../store'

export default function CartBadge() {
  const { items, total } = useStore(cart)   // subscribe + read
  return <button>🛒 {items.length} · \${total.toFixed(2)}</button>
}`,

  // ── Actions & API ─────────────────────────────────────────────────────────────
  defineActions: `import { z } from 'zod'
import { defineActions } from 'brustjs'

export const actions = defineActions()
  .get('/servers', () => db.servers.list())
  .post('/deploy', ({ body }) => deploy(body.id, body.sha), {
    body: z.object({ id: z.string(), sha: z.string() }),
  })`,

  client: `import { client } from 'brustjs/client'
import type { actions } from '../actions'

const api = client<typeof actions>()

async function deploy() {
  // returns { data, error, status, headers } — never throws
  const { data, error, status } = await api.deploy.post({
    id: 'srv_a8K9xL2P',
    sha: '4f90c12',
  })
  if (error) return toast(error.message)
  console.log(data)   // typed from the handler's return
}`,

  validation: `.post('/create', ({ body }) => db.servers.create(body), {
  body: z.object({
    name: z.string().min(1),
    region: z.enum(['sg-1', 'fra-1', 'iad-1']),
    size: z.number().int().positive().default(1),
  }),
})
// invalid input → 422 + a typed error envelope; your handler only
// ever sees parsed, well-formed data.`,

  sse: `// routes.tsx — a route can stream Server-Sent Events directly.
{
  path: '/deploy/:id/logs',
  sse: (req) => new ReadableStream({
    async start(controller) {
      for await (const line of tailDeploy(req)) {
        controller.enqueue('data: ' + JSON.stringify(line) + '\\n\\n')
      }
      controller.close()
    },
  }),
}`,

  websocket: `// routes.tsx — a route can accept WebSocket upgrades.
{
  path: '/metrics',
  websocket: () => import('./ws/metrics'),
}

// ws/metrics.ts
import type { WsHandlers } from 'brustjs/routes'
export const open: WsHandlers['open'] = (socket) => {
  const stop = watchMetrics((m) => socket.send(JSON.stringify(m)))
  socket.onClose?.(stop)
}`,

  // ── Styling ──────────────────────────────────────────────────────────────────
  tailwind: `/* app.css */
@import "tailwindcss";

/* v4 theme tokens — no tailwind.config.js needed */
@theme {
  --color-brand: oklch(0.55 0.22 295);
  --font-display: "Nunito", sans-serif;
}`,

  classUse: `// native route — plain class names, scanned at build
<h1 className="text-3xl font-display text-brand">Servers</h1>

// react island — same utilities
<button className="rounded-xl bg-brand px-4 py-2 text-white">Deploy</button>`,

  cssModule: `/* ServerCard.module.css */
.card {
  border: 1px solid var(--border-subtle);
  border-radius: 14px;
  padding: 18px;
}
.healthy { color: var(--success-600); }`,

  cssModuleUse: `import s from './ServerCard.module.css'

export default function ServerCard({ server }) {
  return (
    <div className={s.card}>
      <span className={s.healthy}>{server.status}</span>
    </div>
  )
}`,

  // ── Agents (MCP) ─────────────────────────────────────────────────────────────
  mcpBoot: `import { brust } from 'brustjs'
import { routes } from './routes'
import { actions } from './actions'

// MCP is automatic: the build reads your action tree and emits a manifest,
// served at /_brust/mcp. Nothing extra to write.
await brust.run({ routes, entry: import.meta.url, actions })`,

  mcpTools: `// GET /_brust/mcp · tools/list
{
  "tools": [
    {
      "name": "deploy",
      "description": "POST /deploy",
      "inputSchema": {
        "type": "object",
        "properties": {
          "id":  { "type": "string" },
          "sha": { "type": "string" }
        },
        "required": ["id", "sha"]
      }
    }
  ]
}`,

  mcpResources: `// resources/read · brust://servers
{
  "uri": "brust://servers",
  "mimeType": "application/json",
  "data": [
    { "id": "srv_a8K9xL2P", "region": "sg-1", "status": "healthy" }
  ]
}`,

  // ── CLI ──────────────────────────────────────────────────────────────────────
  cliDev: `brust dev index.ts
#   the dev server compiles native routes on the fly, hot-reloads
#   islands, and rebuilds the action client when your API changes.`,

  cliBuild: `brust build index.ts
#   compiles native routes → minijinja, bundles island + directive
#   chunks, builds the MCP manifest, and emits a self-contained dist/.`,

  cliNew: `brust new my-app
#   scaffold a new app (same as: bun create brustjs my-app)`,

  // ── Deployment ───────────────────────────────────────────────────────────────
  dockerfile: `# --- build ---
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# --- run ---
FROM oven/bun:1-slim
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
EXPOSE 1337
ENV BRUST_PORT=1337
CMD ["bun", "run", "dist/index.js"]`,

  deployConfig: `# brust.toml
[server]
address = "0.0.0.0"
port = 1337

[workers]
count = 4

# env vars override the file: BRUST_PORT / BRUST_WORKERS / BRUST_ADDRESS`,

  health: `curl -s localhost:1337/_brust/health
# { "status": "ok" }`,
} as const

export type SnippetKey = keyof typeof S
