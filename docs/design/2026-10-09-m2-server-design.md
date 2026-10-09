# brust v2 — Milestone 2: the server ("one route renders end-to-end in production")

Status: DRAFT for human review (2026-10-09). Owner: lead (Detoro). Supersedes nothing; extends
`docs/design/2026-10-08-react-compiler-design.md` (the compiler spec, "spec §N" below) whose
decisions D1–D8 stay in force. Decisions here are numbered S1–S14.

## 0. Goal and non-goals

**Goal.** An application written as React components + `defineRoutes` is built by `brust build`
and served by `brust start`: Rust (hyper) answers every request, renders minijinja templates
emitted by the M1 compiler, calls Bun at most twice per page (route loader, then one batched
call for the component jobs that missed the cache), and serves the client chunks. A trimmed
port of `example/pokedex` runs on it, is covered by integration tests, and is benchmarked
against 0.1.x.

**In scope (settled with the human 2026-10-09):**
- Server end-to-end, production mode only: Rust HTTP, routing from a build-time manifest,
  loaders, job batching, job cache + route L1 cache, render in Rust, client assets via `bun build`,
  CLI `brust build` / `brust start`.
- `react` tier: `ssr` job (HTML) + ONE hydration strategy (idle); client-only islands get a
  placeholder. A `react` page uses the same path (no streaming).
- Ledger items that are server/render work: F32, F33, F34, F35, F37, F39, F40, F41, F42, F49.
- npm publish workflow for `@brust/*` as a CI dry run; publishing a version is a human action.

**Out of scope (M3+; each gets its own spec):** dev server / HMR, SSG, SPA navigation and
page cache, stores shared between components, `Island` props/`isr`, per-component hydration
overrides and `load`/`visible` strategies, react page streaming, L2 (`key(ctx)`) cache, SSE/WS,
actions, MCP/AI runtime, md pages, docs site. `brust dev` is not shipped in M2; the dev loop is
`brust build && brust start`.

## 1. Topology (S1)

**S1 — Bun is the process; Rust owns the request.** `brust start` runs under Bun, loads the
napi addon, and the addon starts hyper on its own OS thread with a multi-thread tokio runtime
(carried over from `brust-core/src/server/mod.rs::start`). Every request is handled in Rust.
Bun is reached only through the worker pool (carried over: `render/pool.rs`, `render/dispatch.rs`,
`crates/brust/src/dispatch_impl.rs` TsfnDispatch) for two call kinds:

| call | when | request (inline JSON string) | response (worker SAB slot) |
|---|---|---|---|
| `loader` | the leaf route chain has at least one loader and L1 missed | `{ routeId, params, path, req }` | `{ ok: true, data } \| { verdict: notFound\|redirect\|httpError, … }` |
| `jobs` | at least one job missed the job cache | `{ jobs: [{ id, componentId, kind, inputs }] }` | `{ results: [{ id, value \| error }] }` |

The SAB carries responses only; requests cross as inline JSON (the comment block at
`brust-core/src/render/dispatch.rs:8-21` records two failed attempts at SAB requests; do not
retry). A page whose jobs all hit, or that has no loader and no jobs, never touches Bun — this
is spec §2 lines 129-133, which 0.1.x never achieved because it rendered jinja on the Bun worker
thread (`crates/brust/src/lib.rs:1063 napi_render_jinja`). In v2 the minijinja `Environment`
lives in Rust and `render` runs on tokio.

**Rejected:** a Rust binary with a Bun sidecar over a socket (new IPC layer, cross-process
latency, loses the proven bridge); `Bun.serve` with Rust as a render library (contradicts D4
and the no-Bun hit path).

## 2. Crates and packages (S2, S3)

**S2 — `crates/brust-server`** is a new crate in v2, seeded by copying these modules from
`main`'s `crates/brust-core` at `d04718f` verbatim or with the named adaptation, then owned by v2
(no shared history, no feature flags):

| module (brust-core) | v2 treatment |
|---|---|
| `server/mod.rs` `start`, `Tuning`, `serve_io`, drain, `claim_or_wait` | carry; rewrite `handle_request` (§4) |
| `server/body.rs`, `server/tls.rs`, `server/cors.rs`, `server/static_assets.rs`, `http/compress.rs` | carry verbatim |
| `routing/routes.rs` `RouteTable` (matchit + catch-all outside matchit), `match_path` | carry; `RouteConfig` becomes the manifest route record (§3) |
| `cache/key_expr.rs` | carry verbatim (grammar unchanged: `header/cookie/query/param/request/env`, `or/and/concat/eq/lower/upper`) |
| `cache/response_cache.rs` moka + per-entry `Expiry` + tag index | carry as the **L1** store, value = JSON context (not framed bytes) |
| `cache/page_cache.rs` moka + tags pattern | reuse the pattern for the **job cache** (§5) |
| `render/pool.rs`, `render/dispatch.rs` | carry; two call kinds instead of render |
| `template/jinja.rs` `RwLock<Environment>` + `load_from(dir)` | carry; `render(name, ctx)` runs on tokio |
| `config.rs` `AppState` | carry, stripped |
| `cache/island_cache.rs`, `render/stream.rs`, `spawn_chunk_pump`, `/_brust/islands`, `/_brust/page`, MCP, SSE/WS, AI | not carried |

`crates/brust-jinja` (M1) stays the filter crate; `brust-server` depends on it.

**S3 — `crates/brust-napi`** (spec §9 line 585) is the thin napi-rs `cdylib` binding for BOTH
`brust-server` (start/stop, register worker, cache invalidate, stats) and `brust-compiler`
(`compileFile(path, opts)` so `brust build` runs the compiler in-process instead of spawning
`brustc`). `brustc` (M1 CLI) stays as the debug/battery tool.

**Packages (npm org `brust`):**
- `@brust/brust` — `packages/brust`: `defineRoutes`, `cache`, `notFound/redirect/httpError`,
  `Outlet`, `run`, the worker entry (loader + job runner), CLI `brust build|start`. Subpath
  exports `@brust/brust/routes`, `@brust/brust/server`. Depends on `@brust/runtime-dom`.
- `@brust/runtime-dom` — `packages/runtime-dom` (M1, unchanged API).
- `@brust/native-{darwin-arm64,darwin-x64,linux-x64-gnu,linux-arm64-gnu,linux-x64-musl,linux-arm64-musl}`
  — the addon per platform, `optionalDependencies` of `@brust/brust` pinned to the same version,
  located by the napi-rs generated loader (`NAPI_RS_NATIVE_LIBRARY_PATH` → sibling `.node` →
  `require('@brust/native-<plat>')`), exactly the 0.1.x mechanism (`runtime/index.js`).
- `create-brust` is M3.

## 3. Build pipeline and manifest (S4, S5, S6)

**S4 — Routes are declared with `defineRoutes` in the 0.1.x shape, minus `native`:**

```ts
import { defineRoutes } from '@brust/brust/routes'
export const routes = defineRoutes([
  { Component: AppLayout, children: [
    { path: '/', Component: HomePage, loader: homeLoader },
    { path: '/pokemon/{name}', Component: DetailPage, loader: detailLoader, cache: { ttl_seconds: 60, tags: ['pokemon'] } },
    { path: '*', Component: NotFoundPage },
  ]},
])
```

Route fields in M2: `path`, `Component`, `loader`, `cache` (§5), `children`. Fields present in
0.1.x but NOT in M2 (`native`, `errorBoundary`, `ssg`, `middleware`, `sse`, `websocket`, `cache.key`,
`cache.key_ttl_seconds`) are a **build error** naming the field and "M3", never silently ignored.
Tier is decided by the compiler per component (D3); there is no per-route switch.

**S5 — `brust build` produces `dist/` and nothing else is read at runtime:**

1. Load the app entry under Bun, walk `defineRoutes`, resolve each `Component` to its source
   file (through the import map Bun gives us via `import.meta.resolve` on the route module's
   bindings; a `Component` that is not a module default export is a build error).
2. Compile every route component with `brust-compiler` (in-process via `brust-napi`;
   `compile_tree` resolves imported children, M1). Emit into `dist/jinja/<id>.jinja`,
   `dist/jobs/<id>.server.ts` (when the component has jobs), `dist/client/<id>.client.js`
   (native tier), `dist/react/<id>.tsx` + descriptor (react tier). Compiler `Error` diagnostics
   fail the build; `Fallback` diagnostics are printed as warnings with the rule name (spec §8.1).
3. `bun build` three bundles: `dist/client/runtime.js` (runtime-dom), every `*.client.js`
   (content-hashed, one chunk per component as M1 emits them), and `dist/client/react-<id>.js`
   per react-tier component (the original module + a hydrate shim, React externalised into one
   shared `dist/client/react.js`). `dist/jobs/*.server.ts` are bundled into one
   `dist/jobs.js` module exporting `{ [componentId]: { precompute?, ssr? } }`.
4. Copy `public/` and the addon (`dist/native/brust.<plat>.node`), write
   `dist/index.js` (the `brust start` entry with `BRUST_PREBUILT=1`, `BRUST_DIST_DIR`), and write
   **`dist/manifest.json`**.

**S6 — The manifest is the only contract between build and server.** Rust reads it once at boot
and never asks Bun what a route is:

```jsonc
{
  "version": 1,
  "routes": [
    { "id": "r3", "pattern": "/pokemon/{name}", "chain": ["appLayout_1a2b3c4d", "detailPage_9f8e7d6c"],
      "loaders": ["r0", "r3"],                           // route ids whose loader runs, top-down
      "cache": { "ttl_seconds": 60, "prefix": null, "bypass": null, "tags": ["pokemon"] } | null,
      "catch_all": false }
  ],
  "components": {
    "detailPage_9f8e7d6c": {
      "tier": "native", "template": "jinja/detailPage_9f8e7d6c.jinja",
      "jobs": [ { "id": "j0", "kind": "precompute", "inputs": ["props.pokemon.stats"], "per_instance": null,
                  "cache": { "key": null, "tags": [], "ttl_seconds": null } } ],
      "children": [ { "id": "teamBuilder_0c1d2e3f", "instances": "static" | "per-row:_l1" } ],
      "client": "client/detailPage_9f8e7d6c-3fa9c1.js", "needs_worker": true, "use_id_slots": 2 }
  },
  "assets": { "runtime": "client/runtime-8b1c.js", "react": "client/react-19.2.0.js" },
  "jobs_module": "jobs.js"
}
```

**S6 amendments (2026-10-09, ruled by the lead on the m2b/m2a plans):**
- `jobs[].inputs` are paths relative to the component's props (`"item.price"`, as the M1 IR
  emits); a leading `props.` is accepted and stripped by the server.
- `jobs[].per_instance` is the **loader-context path of the list** the job runs per row of
  (`"todos"`, `"pokemon.moves"`), never the client member name (`_l1`). The build lane
  translates the IR's loop member to its source path.
- `children[]` records carry `"props": { "<childProp>": "<parent context path>" }` where the
  literal `[idx]` stands for the current row of `per_instance` (`"move": "pokemon.moves[idx]"`);
  it must cover the root of every input of the child's jobs (boot rule `UncoveredInput`).
  `children[].instances` stays the STRING form of the example above: `"static"` or
  `"per-row:<list context path>"` (e.g. `"per-row:pokemon.moves"`). `k` is NOT on the wire: both
  sides derive it as the 1-based ordinal of that child id within `children` in template order, and
  the build lane writes `children` in the compiler's instance order. (Lead ruling on Dew's
  challenge 22411f50, 2026-10-09: one wire form; the object form in an earlier amendment is withdrawn.)
- M2 supports ONE level of per-row child instances: a child that has a job or `useId` and sits
  inside nested loops (or is passed as slot content into a receiver's loop) is a compile `Error`
  `nested-instance` (ledger row for M3: n-dimensional instance arrays).
- **React-tier SSR wire form (ruled 2026-10-09 on Mellow's challenge f4649e5d; the compiler is the
  source of truth):** a react CHILD is NOT a child record. Its `ssr` job lives in the PARENT's
  `jobs[]` exactly as the IR emits it (parent-scope `inputs`, `outputs` = the slot names the
  template reads: `_ssr_<childId>` for the first use, `_ssr_<childId>_<k>` after, `per_instance`
  = the list context path when the IR job has `per_item`). Every manifest `jobs[]` record carries
  `"outputs": [..]` copied from the IR; the server writes result k to `outputs[k]` in that
  component's overlay, and for `per_instance` jobs an array indexed by row at `outputs[0]`.
  `children[]` records exist only for inlined native/static children with their own jobs
  (IR `instances`). A react-tier component's OWN record (tier `react`, island-host template,
  own `ssr` job with `inputs: ["*"]`) is used only when it is a route chain entry (a react page).
- An `ssr` job record also carries `"target": "<react component id>"` (the component to render;
  for a react child that is the child's id while the job sits in the parent's `jobs[]`). The server
  passes it through unchanged as `JobCall.target`; the worker calls `jobs[target].ssr(inputs)`.
- An `ssr` job record for a react CHILD also carries `"props": { "<childProp>": "<parent context path, [idx] for the row>" }`
  (compiler IR `JobDecl.props`, lane `m2a2-ssr-props`); the server evaluates it against the parent's
  overlay (rows: per `per_instance` element) to build the child's props object, which is BOTH the
  job's input (`JobCall.inputs`) and the key material. A react PAGE's own job has no `props`
  (`inputs: ["*"]` = the loader context). A `null` path in the map is a build error (m2c).
- `client_only` react components (IR `JobKind::Ssr { client_only: true }`) get NO ssr job record in the
  manifest: the build lane drops them, the island host paints empty, the server never asks Bun to
  render a window-reading component. (Ruled on Dew's challenge eea156b0.) Absent a `props` map the
  server may fall back to the parent-scope `inputs` plus a row index, but the compiler always emits
  `props` for child ssr jobs from `m2a2-ssr-props` on.
- Every react-tier component the build compiles (pages AND children, client_only included) gets its
  own `components` record with `client` = its react chunk. For a `client_only` child the parent's
  `children[]` additionally carries `{ "id": <childId>, "instances": "static", "props": {} }` so
  the server's asset injection links the chunk (the child has no jobs, so the entry drives nothing
  else). Ruled on Mellow's challenge 01d6722a; no server change.
- Import specifiers: user code imports `cache` from `@brust/brust` and `Outlet`/`defineRoutes`
  from `@brust/brust/routes`; the compiler also accepts the bare `brust` specifier for `cache`
  (M1 fixtures).
- `"*"` in `inputs` means ALL of the component's props: for a chain entry the loader context,
  for a child instance its `child_props`. The job key hashes that whole object.
- Every component's precompute/ssr results and `_props` (= the component's props object) live in
  a per-component overlay, never spread into one shared context: two chain components both
  numbering slots from `_s1` must not collide (S7 step 5 clarification).
- `cache({ key })` job keys are scoped: the cache entry key is `(componentId, jobId, keyValue)`;
  `cache.invalidate({ key })` removes every entry with that user key through an index.
- The `loader` response may carry `headers` (e.g. `Set-Cookie`); a response with `Set-Cookie`
  is never stored in L1.
- `/public/<rel>` is served from `dist/public`; hashed file names (`-<hex6+>` suffix) get
  `Cache-Control: public, max-age=31536000, immutable`.

`inputs` are the template-subset expressions the job reads (spec §4.4 capture analysis); Rust
evaluates them against the loader context with the same evaluator minijinja uses (a
`brust_jinja::eval_path` helper over the context `Value`), so the cache key is computed without
Bun. `use_id_slots` is the number of `useId()` calls in the component (F39).

## 4. Request flow (S7, S8)

**S7 — `handle_request` order** (replaces `brust-core/src/server/mod.rs:447-833`):

1. `HEAD`/`GET` only for pages (others 405); `/_brust/*` and `/public/*` are static from `dist/`
   with immutable caching for hashed names; `/ping`; `/_brust/cache/stats`.
2. `match_path` → route record; no match → the catch-all route at 404, or a plain 404.
3. If the route has `cache`: evaluate `prefix`/`bypass` with `key_expr`; `bypass` non-empty →
   skip L1 for this request; else L1 key = `{prefix, method, path, sorted_query}` →
   **hit**: render the cached JSON context (§5) and respond with `x-brust-cache: HIT`.
4. Loader context: if `loaders` is empty, `ctx = { params, path }`; else one `loader` call to
   Bun with the chain; the worker runs them top-down, merging results flat (child keys win —
   0.1.x `runNativeChainLoaders` semantics), and returns either `data` or the first **verdict**:
   `notFound(data)` → the route's own template renders at 404 (the 0.1.x native rule),
   `redirect(location, status)` → the response, `httpError(status, body)` → the response. A thrown
   error → 500 with the message in the server log and a plain body (no `errorBoundary` in M2).
5. Jobs: for every component in `chain` and its inlined children, in template order, evaluate
   each job's `inputs` → `key = (componentId, jobId, blake3(canonical JSON of inputs))` →
   job cache lookup. Per-instance jobs (F34, `per_instance: "_l1"`) evaluate once per row of
   the list the manifest names and produce an array. Misses are batched into ONE `jobs` call;
   results are stored in the job cache (ttl from `cache()` or none = until invalidated) and
   merged into the context as slots: `_sN` for precompute, `_ssr_<id>` for ssr,
   `__<childId>_<k>` arrays for per-instance child jobs (ledger F34's name).
6. `useId` (F39): Rust allocates `brust-<routeId>-<instance>-<k>` for each `use_id_slots`
   per instance, stable across requests, and seeds them as `_idN` context values, **0-based:
   `_id0` is the first `useId()` of the component** (the id VALUE may keep a 1-based suffix), that the
   template writes into `x-props` (compiler change in M2: `useId()` reads `_idN` instead of
   falling back).
7. Render: **nested routes compose at the server**: render the chain leaf-first, each
   result placed into its parent's `__outlet` slot (S8), so the outermost layout's output is
   the document. Append the asset tags (S9), set `Content-Type: text/html; charset=utf-8`,
   compress, respond. Store the merged context in L1 if the route has `cache`, status is 200
   and no `Set-Cookie` was produced (0.1.x storage rules).

**S8 — `Outlet` is a compiler intrinsic.** `import { Outlet } from '@brust/brust/routes'`;
`<Outlet/>` in a route component lowers to `{{ __outlet | safe }}` in the template and is a
no-op in the client chunk. A component that renders `<Outlet/>` but is not a route with
children is a build `Error` (`outlet-outside-layout`, raised by the build lane from `uses_outlet`); a
react-tier component that renders `<Outlet/>` is a compile `Error` (`outlet-in-react`): its template
is the island host and has no `__outlet` slot. The server renders the child first and
passes its HTML as `__outlet`. (Compiler change, small: one recognised import, like `cache()`.)

**S9 — Asset injection is a server concern.** Templates contain no `<script>` tags for the
framework. After render, the server inserts before `</body>` (or at the end if absent):
`<script type="module" src="/_brust/<runtime>"></script>` plus one `<script type="module">`
per component chunk in the chain (`client` entries), and, when the chain contains react-tier
components, the shared React bundle and each `react-<id>.js`. A route whose every component is
`static` gets no scripts at all. The document itself is ordinary JSX: the layout route returns
`<html><head>…</head><body>…<Outlet/></body></html>` and the compiler treats `html`/`head`/`body`
as host elements (no `BrustPage` in v2; `title`/`meta`/`link` are plain elements, dynamic
`<title>{x}</title>` is a normal text binding).

## 5. Caches (S10, S11)

**S10 — Two caches in Rust, both moka with tag indexes.**

| cache | key | value | ttl | invalidated by |
|---|---|---|---|---|
| **job cache** | `(componentId, jobId, hash(inputs))`, or `cache({key})`'s key | the job's JSON result (precompute object, ssr HTML string, or array for per-instance) | `cache({revalidate})` seconds; default none | `cache.invalidate({ tags })`, `{ key }` |
| **L1** | `{prefix, method, path, sorted_query}` (0.1.x `response_cache.rs:37-42`) | the merged JSON context after jobs (spec §5 line 162: JSON, not HTML; Rust re-renders) | route `cache.ttl_seconds` | `cache.invalidate({ tags })`, `{ path, method }` |

`cache(Comp, { key, tags, revalidate })` (spec §3 line 148) is carried in the IR (`CacheDecl`)
into the manifest's job `cache` record; `key` is a template-subset expression over props
evaluated like `inputs`. `cache.invalidate({ key?, tags?, path?, method? })` keeps the 0.1.x
signature and calls two napi functions (`job_cache_invalidate`, `response_cache_invalidate`).
Cross-process sync (`publishCacheSync`, redis) is M3.

**F33 fix (compiler, in M2):** a prop root read for truthiness (`user && …`) is added to the
job's `inputs` as the root itself, so `null` and `{}` hash differently. The integration test
"job cache separates null from {}" pins it end to end.

**S11 — L2 is deferred.** `cache.key(ctx)`/`key_ttl_seconds` (0.1.x L2, native-only) is rejected
at build time with the M3 message. Reason: spec §5 lines 173-174 leave what L2 stores open, and
M2's L1-on-JSON already covers the "personalised prefix" case through `key_expr`.

## 6. `react` tier (S12)

**S12 — One SSR path, one hydration strategy.** For a react-tier component (a page or a child
of a native page):
- Build: `dist/react/<id>.tsx` is the untouched module; the ssr job is generated as
  `ssr(props) => renderToString(<Comp {...props}/>)` inside `dist/jobs.js` (imports
  `react-dom/server`); the client bundle `react-<id>.js` exports `hydrate(host, props)` calling
  `hydrateRoot(host, <Comp {...props}/>)`.
- Server: the `ssr` job's HTML fills `_ssr_<id>` (spec §4.3 line 370); the host element is
  `<brust-island data-id="<id>" x-props='…'>HTML</brust-island>` emitted by the compiler's
  template backend (M1 already emits the slot; M2 adds the host wrapper and `x-props` via
  `json_attr`). `client_only` components get an empty host and no ssr job.
- Client: runtime-dom gains one directive module `island.ts`: on `requestIdleCallback`
  (fallback `setTimeout(…, 1)`), import `react-<id>.js` and call `hydrate(host, props)`.
  No `load`/`visible` strategies, no per-component override (build config is M3).
- A react **page** (the route component itself is react tier) renders through the same path:
  its chain entry has a one-element template `{{ _ssr_<id> | safe }}` plus the host wrapper;
  no streaming.

Function props to a react child remain an `Error` (spec §3.2); the battery row
`e-function-prop-react-child` already pins it.

## 7. Error handling and observability

- Build: compiler `Error` → non-zero exit with every diagnostic; unknown route field → error;
  a `Component` that is not resolvable → error. `Fallback` → warning (rule name + file:line).
- Boot: manifest version mismatch, missing template or chunk file → the process exits with the
  path; no partial boot.
- Request: loader verdicts as §4 step 4; a job that throws → 500 and the error logged with
  `componentId/jobId` (never cached); a worker claim timeout → 503 (carried `claim_or_wait`);
  a template render error → 500 with the minijinja error in the log (template name + line).
- `/_brust/cache/stats` returns hit/miss counters for both caches and the number of Bun calls
  since boot (`loader_calls`, `job_calls`) — the integration tests read these to prove "no Bun on
  hit".
- Logs: `RUST_LOG` (tracing) as in 0.1.x; one line per request at `info` with route id, cache
  outcome (`HIT`/`MISS`/`BYPASS`), Bun calls made (0/1/2), and duration.

## 8. Configuration and CLI

- `brust build [--out-dir dist]` and `brust start [--port] [--workers]`. Precedence as 0.1.x:
  env `BRUST_ADDR`/`BRUST_PORT`/`BRUST_WORKERS` → `brust.toml` (`[server] address/port`,
  `[workers] count`) → defaults (`localhost:1337`, `availableParallelism()`). Also honoured:
  `BRUST_RENDER_SLOTS`, `BRUST_DRAIN_TIMEOUT_MS`, `BRUST_PREBUILT`, `BRUST_DIST_DIR`, `RUST_LOG`.
- `brust start` without `dist/manifest.json` exits with "run brust build first".

## 9. Dogfood: `examples/pokedex` (S13)

**S13 — A trimmed port, not the 0.1.x app.** The 0.1.x pokedex uses `Island` with `isr`,
`brustjs/navigation`, `brustjs/store`, actions, `BrustPage`, `useNav`, CSS modules and
`export const behavior` — all M3 or replaced by v2's premise (ordinary hooks instead of
`behavior`). The M2 port keeps the route tree and loaders (`lib/loaders.ts`, `lib/pokeapi.ts`,
`lib/types.ts`; `detailLoader` returns `notFound`) and rewrites components as plain React:

| 0.1.x | M2 |
|---|---|
| `AppLayout` with `BrustPage` + `Outlet` + `NavLink`/`ThemeToggle` behaviors | `AppLayout` returns `<html>…<Outlet/>…</html>`; `ThemeToggle` with `useState` + `useEffect` (spec example); `NavLink` static `<a>` |
| `HomePage` + `HeroSearch` behavior | `HeroSearch` with a controlled input + `useState` (native tier) |
| `BrowsePage` + `DexFilter` behavior | `DexFilter` with `useState` filter over a keyed list with a child `<Card>` per row (exercises per-item child props) |
| `DetailPage` + `Breadcrumb` + `AddToTeamButton` + `Island TeamBuilder` | `Breadcrumb` static; `TeamBuilder` as a react-tier child (uses `useReducer` → react, SSR + idle hydration); `AddToTeamButton` dropped (needs stores) |
| `TypeChart` | kept as-is (static table; also the F32 `<table>` case) |
| `app.css` + CSS modules | `public/app.css` only |
| `actions.ts`, `stores/`, `NavPreloader` | dropped |

Exit demo: `cd examples/pokedex && brust build && brust start` serves `/`, `/pokedex`,
`/pokemon/pikachu`, `/type-chart`, a 404 for `/pokemon/nothing` (loader `notFound`), with
`/pokemon/{name}` cached 60 s by tag `pokemon`.

## 10. Verification and exit criteria (S14)

**Tests (all in CI, `v2` workflow gains a `server` job):**
- Rust unit tests per carried module keep their 0.1.x tests (`routes.rs` 45, `key_expr.rs` 22).
- `crates/brust-server/tests/`: manifest loading, L1 key evaluation, job key hashing
  (F33 case), outlet composition, asset injection, `useId` allocation stability.
- Integration (`tests/server/*.test.ts`, bun:test, 0.1.x pattern: `spawn` the built pokedex,
  free port, wait for the "listening" line, SIGINT): every route 200 with expected text; 404 via
  loader `notFound`; redirect verdict; L1 HIT on the second request with `loader_calls`
  unchanged (reads `/_brust/cache/stats`); job cache HIT across two different routes that share
  a component and inputs; `cache.invalidate({tags:['pokemon']})` → next request MISS; a static
  route makes 0 Bun calls on first request; per-instance child jobs produce the `__<childId>_<k>`
  array; `useId` values identical across two requests; react child SSR HTML equals the client's
  first paint (hydrate with no console error) — this one runs in real Chromium via Playwright
  (closes F45 for this path), the rest under happy-dom are not needed since the server returns
  HTML strings.
- Battery and browser harness (M1 gates) stay green; `docs/react-coverage.md` gains no new
  known gaps (F37/F40/F41 close: `b-memo` native, `a-array-from` recognised, both warnings
  emitted).
- Bench: `bench/` with `oha` (0.1.x script), three points — static route hit, native route miss
  (loader + 1 job), native route with a react child — reported as `bench/RESULTS.md` next to the
  same three routes on 0.1.x pokedex. Exit bar: v2 not slower than 0.1.x on any of the three
  (perf memory says bench lied 3×: run fresh, report deltas, macOS ≠ Linux).
- Publish: `release.yml` (6 targets, zigbuild for all Linux cross legs per memory) with
  `npm publish --dry-run` on `workflow_dispatch`; the `latest` dist-tag policy from 0.1.x applies.

**M2 exit criteria:** the pokedex demo above serves all five paths from `brust start`; every
integration test and the Chromium hydration test are green in CI; the bench table exists and
meets the bar; ledger F32–F35, F37, F39–F42, F49 are closed or re-filed with a reason; the
exit report `docs/plans/m2-exit-report.md` is generated by the integration suite (pinned sets,
no hard-coded prose — the M1 lesson).

## 11. Risks

| risk | mitigation |
|---|---|
| Evaluating job `inputs` in Rust diverges from what the Bun job reads | inputs come from the compiler's capture analysis (one source); the dual-eval harness already proves job output = client paint; add a server test that a changed input changes the key |
| `html`/`head`/`body` as JSX roots hit a compiler path M1 never exercised | first M2 compiler task adds a fixture `document-root` before any server work depends on it |
| Per-instance child jobs (F34) multiply Bun work on long lists | they batch into the same single call; the battery reports job counts, and `cache()` per child caps re-runs |
| Carried modules drift from `main` fixes | they are copied once and owned; a `docs/design/brust-core-port.md` table records the source SHA per module |
| Chromium test flakiness in CI | one test, one page, explicit `waitForFunction` on a hydration marker the island directive sets (`data-hydrated`) |

## 12. Decisions recorded in this spec

S1 topology · S2 brust-server from brust-core · S3 brust-napi binds server+compiler ·
S4 defineRoutes minus `native`, unknown fields error · S5 `dist/` layout · S6 manifest as the only
contract · S7 request order · S8 `Outlet` intrinsic + server composition · S9 asset injection by
the server, document is JSX · S10 job cache + L1 on JSON · S11 L2 deferred · S12 react tier =
renderToString + idle hydrate · S13 trimmed pokedex · S14 tests, bench bar, generated exit report.

Open for the lead to rule when the first task hits them: the exact `brust_jinja::eval_path`
subset (must equal what the compiler emits as `inputs`); the `brust-island` element name (follows
the M1 `brust-host/brust-if/brust-row` convention).
