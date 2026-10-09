# @brust/core

Rust serves the pages; N Bun workers answer only `loader` and `jobs` calls. One napi addon
(`crates/brust-napi`, loader generated into `native/` by `napi build`) binds `brust-server` and
`brust-compiler`. Workspace-private (0.0.0) until m2e publishes it; peers `react`/`react-dom` 19.

## Routes (`routes.tsx`)

```tsx
import { defineRoutes, notFound } from '@brust/core/routes'
export const routes = defineRoutes([
  { Component: AppLayout, children: [                     // layout renders <Outlet />
    { path: '/', Component: HomePage },                   // static: never calls Bun
    { path: '/items/{id}', Component: ItemPage,
      loader: async ({ params }) => (params.id === 'x' ? notFound({}) : { item: await load(params.id) }),
      cache: { ttl_seconds: 60, tags: ['items'] } },      // a HIT never calls Bun
  ] },
])
```

Route fields are exactly `path`, `Component`, `loader`, `cache`, `children`; anything else fails the
build with `<field> is not supported in M2 (M3)`. Loaders run root → leaf, results merge flat
(later keys win); return `notFound(data)` / `redirect(location, status)` or throw
`httpError(status, body)` for a verdict. `cache(Comp, opts)` and `cache.invalidate(…)` ship too.

## `brust build [entry=routes.tsx] [--out-dir dist]`

Compiles every route component through lowering, then writes (always from scratch):

```
dist/manifest.json        the only build → server contract (spec S6)
dist/jinja/<id>.jinja     templates          dist/jobs.js + jobs/*.server.ts   worker jobs
dist/client/*-<hex>.js    runtime, native chunks, react-<id> island chunks (served immutable)
dist/public/              copied from ./public          dist/index.js   `bun dist/index.js` = start
```

A diagnostic (`nested-instance`, `outlet-in-react`, `outlet-outside-layout`, unsupported route
field, unresolvable Component) prints `error <rule> <message>` and exits 1. The route tree is
validated whether or not the entry used `defineRoutes` (`route-config`, `duplicate-route` for two
patterns the router cannot hold together, e.g. `/a` and `/a/`).

Server-only code never reaches a browser bundle (`error server-only-in-client <importer> imports
<spec>`, at any import depth, react islands included): `node:*` / `bun:*` / bare Node builtins
(unless an npm package of that name is installed), `@brust/core/server|native`, any
`*.server.*` file, and the paths/prefixes listed in `brust.toml`:

```toml
[build]
server_only = ["lib/server", "@acme/db"]   # import prefixes, or paths relative to the app root
```

Loaders and precompute jobs may use all of it (they run in Bun). In the browser `@brust/core`
resolves to a side-effect-free entry (`cache`, route helpers, verdicts; `cache.invalidate` throws).

The out dir is rebuilt in a sibling temp dir and swapped in only on success (a failed build leaves
the previous one untouched); an out dir that is the filesystem root, the home dir, the app root or
an ancestor of it, or that holds the entry / a route Component / `public/`, is refused
(`out-dir-unsafe`). Relative imports of
generated files resolve against the component's source dir, bare imports against the app root, so
`--out-dir` may point anywhere; at run time `dist/` must still resolve `react` and `@brust/core`
(keep it inside the app, or next to a `node_modules` that has them).

## `brust start [--port N] [--workers N] [--dist-dir dist] [--entry routes.tsx]`

Prints `[brust] listening on <addr>` then `[brust] ready (N workers)`. `--port 0` picks a free port.
SIGINT/SIGTERM drains gracefully (`BRUST_DRAIN_TIMEOUT_MS`); a second signal exits at once.
Config precedence: env (`BRUST_ADDR`, `BRUST_PORT`, `BRUST_WORKERS`, `BRUST_RENDER_SLOTS`,
`BRUST_DRAIN_TIMEOUT_MS`, `BRUST_BOOT_TIMEOUT_MS`, `BRUST_CALL_TIMEOUT_MS`, `BRUST_DIST_DIR`, `BRUST_APP_ENTRY`) > flags
(`--port`, `--workers`, `--dist-dir`, `--entry`) > `brust.toml` (`[server] address/port`,
`[workers] count`) > defaults (`localhost:1337`, one worker per CPU, `min(cores, 16)` slots per worker (each slot is a 256 KiB shared response buffer, so 10 slots = 2.5 MiB per worker), 10 s drain, 30 s
worker boot timeout, 30 s call timeout).
A loader or job call that has not settled within `BRUST_CALL_TIMEOUT_MS` answers **504**; its worker
slot stays claimed until the call settles (the late result is discarded), so a stuck call costs one
slot, never a frozen worker. Waiting for a free slot is the separate 503 "all workers busy".
`GET /_brust/cache/stats` reports L1/job cache counters plus `loader_calls` / `job_calls` /
`timed_out_calls`.

## Worker wire (contract 7, `crates/brust-server/src/protocol.rs`)

Requests arrive as inline JSON; responses go into the worker's SharedArrayBuffer slot (never
past `floor(len / slots)` bytes: an oversize response becomes `{"error":…}`). A handler never rejects.

`loader` `{routeId, params, path, req}` → `{ok:true, data}` | `{verdict, …}` | `{error}`;
`jobs` `{jobs:[{id, componentId, kind, inputs, target?, row?}]}` → `{results:[{id, value}|{id, error}]}`
(an `ssr` job renders `jobs[target]` with the manifest job's `literals` merged over `inputs`).

**M2 limits:** the route fields above only; per-row child instances one level deep (a nested
instance is a build error); a react child's props must be props paths or literals; no worker respawn.
**Gates:** `bun run build:debug && bun run typecheck && bun test` (CI runs each server-starting
file alone; e2e: `bun test --timeout 120000 test/e2e.test.ts`).
