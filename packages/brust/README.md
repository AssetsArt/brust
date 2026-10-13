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

Route fields are exactly `path`, `Component`, `loader`, `cache`, `ssg`, `children` (`ssg` only matters
to `--target static`, see [docs/static.md](../../docs/static.md)); anything else fails the
build with `<field> is not supported in M2 (M3)`. Loaders run root → leaf, results merge flat
(later keys win); return `notFound(data)` / `redirect(location, status)` or throw
`httpError(status, body)` for a verdict. `cache(Comp, opts)` and `cache.invalidate(…)` ship too.

## `brust build [entry=routes.tsx] [--out-dir dist]`

`--target static [--strict]` also renders every page to `dist/static/` for Cloudflare Pages or Workers
Static Assets: see [docs/static.md](../../docs/static.md).

Compiles every route component through lowering, then writes (always from scratch):

```
dist/manifest.json        the only build → server contract (spec S6)
dist/jinja/<id>.jinja     templates          dist/jobs.js + jobs/*.server.ts   worker jobs
dist/client/*-<hex>.js    runtime, native chunks, react-<id> island chunks (served immutable)
dist/public/              copied from ./public          dist/index.js   `bun dist/index.js` = start
```

Every route component's `children[]` also gets one static entry per native descendant (at any depth) that has a client chunk, so its `<script>` is linked once per page.

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

## `brust dev [entry=routes.tsx] [--port N] [--workers N]`

The Bun-target dev server. A long-lived parent owns your port and proxies to the newest build; every
successful build is booted as a new child (`brust start` on a loopback port, `--workers 1` unless you pass
`--workers`), the proxy switches over, browsers are told to `reload`, and the old child is stopped. A failed
build **or a failed boot** keeps the old child serving and shows the error as an overlay above the stale page
(a page opened while builds fail shows it too); the next good build clears it and reloads.

- Source changes do a full reload (debounced ~150 ms; an edit made during a rebuild is not dropped).
- A change to `public/*.css` skips the build: the file is copied into the running dist and the `<link>` is
  swapped (`?v=`), the page keeps its state. Other `public/` files reload.
- Every `text/html` response, including error pages, gets `/_brust/dev/client.js` (a WebSocket at
  `/_brust/dev/ws`); responses are `cache-control: no-store`. `Host` and `Origin` reach the child unchanged,
  so the actions cross-site guard behaves as in production.
- Dev builds use React in development mode (`NODE_ENV=development`); `brust build` / `brust start` are unchanged.
- The terminal shows request lines (`method path status ms cache`) and a status block of at most 6 lines at the
  bottom (state, URL, generation, build time, last request, warnings, hotkeys `r` reload, `o` open, `w` warnings,
  `c` clear, `q` quit). It never uses the alternate screen. Not a TTY, `CI` or `NO_COLOR`: plain lines only.
- **Trace for dev tools (L14).** The dev proxy generates a token per session and gives it to each child (`BRUST_DEV_TOKEN`,
  napi `devToken`) and to every upstream request (`x-brust-dev-token`). Only then the core answers `x-brust-dev: base64(json)`
  (route, pattern, chain, params, cache outcome, loader and render ms, jobs with kind/key/tags/hit, bun calls, the components the
  page is made of). It is added after the L1 store, so it is never cached; a core without a token (production) never makes it.
  The proxy strips the header, puts the trace in the page as `<script type=application/json id=__brust_trace>` and keeps the
  last 50 (actions included) at `/_brust/dev/traces`. `brust build --dev` (used by `brust dev`) also writes `dev.json`
  (component id → source file, tier, the react reason, diagnostics with rule/line/col/remediation; served at `/_brust/dev/meta`);
  a production build writes none. In dev only, every chain level is wrapped in `<!--brust:<id>-->…<!--/brust-->` (never inside a
  `<brust-island>`), and the runtime exposes its live instances on `globalThis.__brustDev.instances` (`__BRUST_DEV__` is a
  build define that is `false`, and removed by the minifier, in every other build).
- Not hot module replacement: component state does not survive an edit. `brust dev --target cloudflare` keeps
  its wrangler loop (now on the same watch loop).

## `brust start [--port N] [--workers N] [--dist-dir dist] [--entry routes.tsx]`

Prints `[brust] listening on <addr>` then `[brust] ready (N workers)`. `--port 0` picks a free port.
SIGINT/SIGTERM drains gracefully (`BRUST_DRAIN_TIMEOUT_MS`); a second signal exits at once.
Config precedence: env (`BRUST_ADDR`, `BRUST_PORT`, `BRUST_WORKERS`, `BRUST_RENDER_SLOTS`,
`BRUST_DRAIN_TIMEOUT_MS`, `BRUST_BOOT_TIMEOUT_MS`, `BRUST_CALL_TIMEOUT_MS`, `BRUST_SLOT_BYTES`,
`BRUST_MAX_LOADER_RESPONSE_BYTES`, `BRUST_DIST_DIR`, `BRUST_APP_ENTRY`) > flags
(`--port`, `--workers`, `--dist-dir`, `--entry`) and `run({ config })` > `brust.toml` (`[server] address/port/max_loader_response_bytes`,
`[workers] count/slot_bytes`, `[cors]`) > defaults (`localhost:1337`, one worker per CPU, `min(cores, 16)` slots per worker (each slot is a `slotBytes` shared response buffer, 256 KiB by default, so 10 slots = 2.5 MiB per worker), 10 s drain, 30 s
worker boot timeout, 30 s call timeout, 8 MiB loader response limit).
`slotBytes` (`[workers] slot_bytes`, env `BRUST_SLOT_BYTES`, `run({ config: { slotBytes } })`) is 64 KiB..16 MiB.
A loader, jobs or planned reply that does not fit its slot is not an error: the worker hands it to the server
over the heap, up to `maxLoaderResponseBytes` (`[server] max_loader_response_bytes`, env
`BRUST_MAX_LOADER_RESPONSE_BYTES`, `run({ config: { maxLoaderResponseBytes } })`; 256 KiB..64 MiB, default 8 MiB).
A bigger reply answers `{"error":"response too large: <n> > <limit> (maxLoaderResponseBytes)"}` (a 500). This
limit applies to loader and jobs replies; `[actions]` has its own `max_response_bytes`.
`[cors]` can also be given as `run({ config: { cors: { origins, methods, headers, exposeHeaders, credentials,
maxAgeSeconds } } })` (camelCase, an unknown key is rejected). It replaces a `brust.toml` `[cors]` as a whole,
never merging with it; `cors: null` turns the toml table off.
A loader or job call that has not settled within `BRUST_CALL_TIMEOUT_MS` answers **504**; its worker
slot stays claimed until the call settles (the late result is discarded), so a stuck call costs one
slot, never a frozen worker. Waiting for a free slot is the separate 503 "all workers busy".
`GET /_brust/cache/stats` reports L1/job cache counters plus `loader_calls` / `job_calls` /
`timed_out_calls`.

## Worker wire (contract 7, `crates/brust-server/src/protocol.rs`)

Requests arrive as inline JSON; responses go into the worker's SharedArrayBuffer slot (never
past `floor(len / slots)` bytes). A `loader`/`jobs` reply that does not fit crosses by heap: the worker
puts the bytes with `putFetchReply` and writes the 5-byte marker `[0x00][u32 LE n]` into the slot (JSON
never starts with 0x00); the server reads the `n` bytes it was handed. A loader context too large for the
slot is planned from the bytes (`planJobsBuf`). Over `maxLoaderResponseBytes` the reply becomes
`{"error":…}`. A handler never rejects.

`loader` `{routeId, params, path, req}` → `{ok:true, data}` | `{verdict, …}` | `{error}`;
`jobs` `{jobs:[{id, componentId, kind, inputs, target?, row?}]}` → `{results:[{id, value}|{id, error}]}`
(an `ssr` job renders `jobs[target]` with the manifest job's `literals` merged over `inputs`).

**M2 limits:** the route fields above only; per-row child instances one level deep (a nested
instance is a build error); a react child's props must be props paths or literals; no worker respawn.
**Gates:** `bun run build:debug && bun run typecheck && bun test` (CI runs each server-starting
file alone; e2e: `bun test --timeout 120000 test/e2e.test.ts`).
