# hello-world — Brust demo app

A small showcase of every major Brust feature. Each route exists to
demonstrate one capability; if a route looks busy, that's the demo. The
failure-mode, middleware-rejection, cache, nested-route, and
multiple-action variants used by the integration tests live in
[`tests/fixtures/app/`](../../tests/fixtures/app) so this directory
stays approachable.

The HTML pages share a `<Layout>` with a sticky nav, so clicking links
in the top bar takes you between pages with classic full-request
navigation (SPA-style interception is a future Brust feature).

## Run

```bash
cd <repo root>
bun install                  # one-time
cd runtime && bun run build  # build the native module
cd ..
bun run example/hello-world/index.ts
```

The server listens on `127.0.0.1:3000` by default (override with
`BRUST_PORT`, `BRUST_WORKERS`, or a project-local `brust.toml`).

## Routes

| Path | What it demonstrates | Try it |
|---|---|---|
| `GET /` | Routing + a hydrated `<Counter />` island | open `http://127.0.0.1:3000/` |
| `GET /blog/{slug}` | Dynamic params + an async `loader` supplying the component's `data` prop | `/blog/welcome` |
| `GET /slow-suspense` | HTML Streaming over `Transfer-Encoding: chunked` — shell + Spinner ship first; resolved content arrives ~200 ms later | `/slow-suspense` |
| `GET /profile/{user}` | Async-data component pattern — sync page ships its shell + `loading bio...` fallback, then `<Bio />` streams in the resolved bio ~150 ms later | `/profile/world` |
| `GET /native-islands` | Islands on a **native** (jinja) route — static Rust-rendered shell with a client-only island (empty mount → `createRoot`) and a server island (worker `renderToString` → `hydrateRoot`) | `/native-islands` |
| `GET /sse-counter` | Server-Sent Events — three `data: N` frames at 50 ms intervals, then close | `curl -N http://127.0.0.1:3000/sse-counter` |
| `GET /ws/echo` | WebSocket echo — every frame you send comes straight back | `wscat -c ws://127.0.0.1:3000/ws/echo` |

## Layout

```
example/hello-world/
├── index.ts             # entry — 3 lines, calls brust.run() with the routes
├── routes.tsx           # the routes table
├── sse-counter.ts       # SSE handler for /sse-counter
├── ws-echo.ts           # WS handler for /ws/echo
├── brust.example.toml   # config template — copy to brust.toml to use
├── pages/               # route-mounted components — one per `Component:` in routes.tsx
│   ├── HelloWorld.tsx   # root page; embeds <Counter />
│   ├── BlogPost.tsx     # consumes loader data + params
│   ├── SlowSuspense.tsx # <Suspense> with a 200 ms-resolving child
│   └── Profile.tsx      # sync page + async <Bio /> child in <Suspense>
└── components/          # reusable building blocks used inside pages
    ├── Layout.tsx       # shared chrome — head, inline CSS, top nav, footer
    ├── Counter.tsx      # client-hydrated island
    └── Bio.tsx          # async-data component (Promise prop + Suspense)
```

The entry is small on purpose — `brust.run({ routes, entry: import.meta.url })`
discovers actions, builds island chunks (scanning the pages for `<Island>`),
wires the route table + SSE/WS path lists + MCP manifest, then either
serves (main thread) or registers a renderer (worker thread). For apps
that need finer control, the lower-level helpers (`scanActions`,
`registerRoutes`, `makeRenderer`, etc.) remain exported.

### Async data on the server

The `/profile/{user}` route shows the supported pattern for
server-side `await` under stable React 18: the page renders
synchronously and hands a `Promise` to a child component, which
suspends until it settles. `renderToPipeableStream` ships the shell +
fallback first, then streams the resolved markup as a follow-up chunk
under `Transfer-Encoding: chunked`. Top-level `async function`
components return a Promise that React's stable stream renderer
rejects as an invalid child, so the Promise-in-prop + Suspense pattern
is the supported path until React Server Components ship in a Brust
release.

## Where to look for more

- Real-world test scenarios (failure boundaries, gated middleware, cache
  invalidation, nested admin layout, server actions, action error
  reporting): [`tests/fixtures/app/`](../../tests/fixtures/app) and
  [`tests/integration.test.ts`](../../tests/integration.test.ts).
- Architecture overview: [`architecture.md`](../../architecture.md).
