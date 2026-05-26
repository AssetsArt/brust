# hello-world — Brust demo app

A six-route showcase of every major Brust feature. Each route exists to
demonstrate one capability; if a route looks busy, that's the demo. The
failure-mode, middleware-rejection, cache, nested-route, and
multiple-action variants used by the integration tests live in
[`tests/fixtures/app/`](../../tests/fixtures/app) so this directory
stays approachable.

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
| `GET /` | Routing + a hydrated `<Counter />` island | `curl http://127.0.0.1:3000/` |
| `GET /blog/{slug}` | Dynamic params + an async loader supplying the component's `data` prop | `curl http://127.0.0.1:3000/blog/welcome` |
| `GET /slow-suspense` | HTML Streaming over `Transfer-Encoding: chunked` — shell + Spinner ship first, the resolved content arrives ~200 ms later | `curl -i http://127.0.0.1:3000/slow-suspense` |
| `GET /sse-counter` | Server-Sent Events — three `data: N` frames at 50 ms intervals, then close | `curl -N http://127.0.0.1:3000/sse-counter` |
| `GET /ws/echo` | WebSocket echo — every frame you send comes straight back | `wscat -c ws://127.0.0.1:3000/ws/echo` |

## Layout

```
example/hello-world/
├── index.ts             # entry — 3 lines, calls brust.run() with the routes
├── routes.tsx           # the six demo routes
├── island.config.ts     # one island (Counter) — minimal map
├── sse-counter.ts       # SSE handler for /sse-counter
├── ws-echo.ts           # WS handler for /ws/echo
├── brust.example.toml   # config template — copy to brust.toml to use
├── pages/               # route-mounted components — one per `Component:` in routes.tsx
│   ├── HelloWorld.tsx   # root page; embeds <Counter />
│   ├── BlogPost.tsx     # consumes loader data + params
│   └── SlowSuspense.tsx # <Suspense> with a 200 ms-resolving child
└── components/          # reusable building blocks used inside pages
    └── Counter.tsx      # client-hydrated island
```

The entry is small on purpose — `brust.run({ routes, entry: import.meta.url })`
discovers actions, builds islands (if `island.config.ts` is present), wires
the route table + SSE/WS path lists + MCP manifest, then either serves
(main thread) or registers a renderer (worker thread). For apps that need
finer control, the lower-level helpers (`scanActions`, `registerRoutes`,
`makeRenderer`, etc.) remain exported.

## Where to look for more

- Real-world test scenarios (failure boundaries, gated middleware, cache
  invalidation, nested admin layout, server actions, action error
  reporting): [`tests/fixtures/app/`](../../tests/fixtures/app) and
  [`tests/integration.test.ts`](../../tests/integration.test.ts).
- Architecture overview: [`architecture.md`](../../architecture.md).
