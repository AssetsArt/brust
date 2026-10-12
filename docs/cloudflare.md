# brust on Cloudflare Workers

brust builds the same app for Cloudflare Workers that it runs natively with `brust start`. The page renderer is the same Rust code, compiled to WebAssembly. The only JavaScript that runs is the shim `worker-build` generates and your own compiled TypeScript: loaders, `jobs.js`, `actions.ts`, client chunks. brust adds no runtime layer of its own, and the runtime needs only Workers. It ships no Durable Object, KV namespace or D1 database.

The target is **Workers with Static Assets**. Cloudflare Pages is not targeted: its landing page says "Start new projects with Workers" (source C1).

This page covers the build, the generated project, bindings, actions, caching, a D1 recipe, the differences from native, limits, and troubleshooting. Cross-instance cache invalidation has its own page: [Cache adapters](./cache-adapters.md).

## 1. Quick start

```sh
bun create @brust/app@latest my-app   # pin or use @latest: `bun create` caches the scaffolder, and a stale cache scaffolds an old template
cd my-app
bun install
bun run dev:cf                    # build + wrangler dev (local workerd, simulated bindings)
bun run deploy:cf                 # build + wrangler deploy of dist/cf
```

`bun run deploy:cf` needs a Cloudflare login on your machine (`wrangler login`) or an API token in the environment. The scripts are:

```json
"dev:cf": "brust dev routes.tsx --target cloudflare",
"deploy:cf": "brust build routes.tsx --target cloudflare && wrangler deploy -c dist/cf/wrangler.jsonc"
```

You need Bun and `wrangler`. You do not need a Rust toolchain: the app-independent wasm ships as the npm package `@brust/core-cf`, which installs next to `@brust/core`.

## 2. Commands

| Command | What it does |
|---|---|
| `brust build [entry] --target cloudflare [--out-dir dist] [--wasm-from-source]` | The normal build into `dist/`, then the Workers project in `dist/cf/`. |
| `brust dev [entry] --target cloudflare [--out-dir dist] [--port N] [--wasm-from-source] [-- <wrangler args>]` | Builds, runs `wrangler dev` on `dist/cf/wrangler.jsonc`, and rebuilds and restarts it when a source file changes. There is no hot module replacement. Arguments after `--` go to wrangler. |

`--target` takes `bun` (the default) or `cloudflare`. `brust dev` supports only `--target cloudflare` for now.

`--wasm-from-source` builds the wasm from a brust checkout instead of using `@brust/core-cf`. It needs the checkout's pinned nightly Rust, the `wasm32-unknown-unknown` target and `worker-build`. App authors never need it.

## 3. `[cloudflare]` in `brust.toml`

The table is optional. Its presence is not required to use `--target cloudflare`; the defaults below apply. Unknown keys are a build error. `[server]` and `[workers]` are ignored on this target, with a warning.

```toml
[cloudflare]
name = "my-worker"                # wrangler `name`
compatibility_date = "2026-10-01" # must be >= 2026-08-04
l1_capacity = 256                 # page cache entries per isolate
job_cache_capacity = 512          # job cache entries per isolate
stats = false                     # serve /_brust/cache/stats
edge_cache = "off"                # the only accepted value today

[cloudflare.alias]
"lib/team-db.ts" = "lib/team-db.d1.ts"
```

| Key | Default | Meaning |
|---|---|---|
| `name` | the app-root `wrangler` `name`, else `package.json` `name` made into a Worker name | The Worker name. If both this and the wrangler file name the Worker and they differ, this wins, with a warning. |
| `compatibility_date` | the date `@brust/core-cf` was built with | Must be `YYYY-MM-DD` and at least `2026-08-04`. From that date `nodejs_compat` is on by default, and brust needs it for `AsyncLocalStorage` (source C2). |
| `l1_capacity` | 256 | Rendered pages kept per isolate (native default is 1000). Integer in 1..4294967295. |
| `job_cache_capacity` | 512 | Job results kept per isolate. Same range. |
| `stats` | `false` | Serve `/_brust/cache/stats`. When off, that path answers 404. The numbers are per isolate. |
| `edge_cache` | `"off"` | Reserved. `"workers-cache"` is refused: the build says it lands later. |
| `alias` | none | Module swaps, see below. |

`[actions]`, `[cors]` and `[cache]` are read as on native. `[build] server_only` is honoured too.

### `[cloudflare.alias]`

Some modules do not exist on Workers: `bun:sqlite`, `Bun.file`, anything under `bun` or `bun:*`. An alias replaces a module of your app, at bundle time, with another one. Both sides are paths relative to the app root, and both must resolve. Use it to swap a database facade: the pokedex example maps `lib/team-db.ts` to `lib/team-db.d1.ts` (section 8).

## 4. What the build generates

```
dist/cf/
  wrangler.jsonc            merged config (section 4.1)
  worker/                   the @brust/core-cf glue + wasm, copied verbatim
    brust-app.js            ONE Bun bundle of your app
    main.js                 only with a Durable Object cache adapter: re-exports the Worker and BrustCacheDO
  assets/                   Workers Static Assets
    _brust/client/*         copies of dist/client
    public/*                copies of dist/public
    _headers                cache headers
  .stage/                   generated entry, templates, smoke check (kept for inspection)
```

`brust-app.js` is built from a short generated entry (about 25 lines, no logic). It imports your routes, `jobs.js` and `actions.ts` and exports `loader`, `jobs`, `action`, `install`, the manifest, the templates and a baked `CONFIG`. The wasm calls those exports directly. The bundle uses the `workerd`, `worker` and `browser` export conditions. `react-dom/server` therefore resolves to its edge build.

After bundling, the build imports `brust-app.js` under Bun with a stub for `cloudflare:workers` and checks the exports. This catches a broken bundle before wrangler does. The check runs your modules' top level with `env = {}`, so **open bindings lazily**, inside a call, not at import time.

### 4.1 `wrangler.jsonc`

If your app root has a `wrangler.jsonc`, `wrangler.json` or `wrangler.toml`, brust merges it into the generated file. Keep only one of them. brust owns these keys and ignores yours with a warning: `main`, `assets`, `compatibility_date`, `no_bundle`, `find_additional_modules`, `base_dir`, `rules`, `build`, `site`. Everything else is yours: `name`, `vars`, `d1_databases`, `kv_namespaces`, `durable_objects`, `routes`, `observability` and so on, also under `env.<name>`.

brust writes:

```jsonc
{
  "main": "worker/index.js",
  "compatibility_date": "2026-10-01",
  "assets": { "directory": "assets", "binding": "ASSETS", "run_worker_first": false,
              "html_handling": "none", "not_found_handling": "none" }
}
```

Refused with an error:
- a binding named `ASSETS` (it is brust's static assets binding);
- a `compatibility_flags` entry starting with `no_nodejs_compat`.

brust never writes an account identifier. It keeps one only if you wrote it.

`migrations_dir` of each `d1_databases` entry, and relative `tsconfig` and `alias` paths, are rewritten relative to `dist/cf/`, so `wrangler d1 migrations apply` finds your files when run with `-c dist/cf/wrangler.jsonc`.

### 4.2 Static assets and `_headers`

Files under `dist/client` and `dist/public` become assets at the URL they are requested at. Only files the native server would serve are copied; others are skipped with a warning. A request for an asset does not run the Worker. A miss under `/_brust/` or `/public/` reaches brust, which answers 404.

`_headers` sets `X-Content-Type-Options: nosniff` and `X-Powered-By` on everything, `immutable` on `/_brust/client/*`, and per file on `/public/*`: `immutable` for names with a content hash, `max-age=3600` otherwise. A `_headers` file holds at most 100 rules; past that brust writes a single `/public/*` rule with `max-age=3600` and warns.

## 5. Bindings and `cloudflare:workers`

Declare bindings in your own `wrangler.jsonc` and read them from the `env` export:

```ts
import { env } from 'cloudflare:workers'

export function db() {
  const d1 = env.TEAM_DB
  if (!d1) throw new Error('TEAM_DB D1 binding missing: add it to wrangler.jsonc')
  return d1
}
```

Rules that follow from Workers (source C3):
- I/O (D1, KV, `fetch`) works only inside a request. Open bindings inside the function that uses them. Never keep an I/O object across requests.
- The build runs your module top level once, with an empty `env`. A top-level `env.DB.prepare(...)` fails the build smoke check.

## 6. Actions on Workers

[Actions](./actions.md) run as on native: one Elysia 2 app, `[actions]` read from `brust.toml`. What differs:

- brust generates a startup `.compile()` of your Elysia app. Workers allow `eval()` and `new Function(text)` during the startup phase of a Worker script (source C4), and Elysia's compiler needs them, so compiling at startup is the safe place. Do not rely on lazy compilation in your own code.
- The admission rules still run in Rust: method gate, ambiguous path (400), `Content-Encoding` (415), body cap (413) and the cross-site guard (403). `cross_site = "reject"` is the default and works the same way. See [Actions](./actions.md), "Security posture".
- `cache.invalidate(...)` from an action clears the cache of the isolate that ran it. Section 7 explains how to reach the others.

## 7. Caching on Workers

There are two cache tiers. **Tier 1** is the per-isolate memory cache inside the wasm: pages (`l1_capacity`) and job results (`job_cache_capacity`). **Tier 2** is an optional shared store you add with a cache adapter ([Cache adapters](./cache-adapters.md)).

An isolate is one running copy of your Worker. Cloudflare starts and recycles many of them, in many locations, at will. Each has its own tier 1. So:

- A page rendered in one isolate is not a hit in another. The hit rate is lower than on native.
- **`cache.invalidate` is isolate-local without an adapter.** The isolate that ran the action drops its entries at once. Every other isolate keeps serving the old page until its route `ttl_seconds` runs out. Keep `ttl_seconds` short on Workers if you do not configure an adapter.
- To make a mutation visible everywhere within about `epoch_interval_ms` (default 1 s), configure a cache adapter with a broadcast. The Durable Object adapter does this. See [Cache adapters](./cache-adapters.md).

Within one isolate the stamp rules are the native ones: a page whose render started before an invalidation is not stored. `Date.now()` on Workers advances only across I/O, so TTLs are coarse inside a single request. That is harmless.

A page with `Set-Cookie` is not cached, as on native.

## 8. Recipe: Cloudflare D1

This is the pokedex example's team roster: native uses `bun:sqlite`, Workers use D1. Both sit behind one async `TeamDb` interface.

**1. Migration.** `migrations/0001_team.sql`:

```sql
CREATE TABLE IF NOT EXISTS team (id INTEGER PRIMARY KEY, name TEXT NOT NULL, display_name TEXT NOT NULL,
  num TEXT NOT NULL, types TEXT NOT NULL, artwork TEXT NOT NULL, added_at INTEGER NOT NULL);
```

**2. Binding.** In your `wrangler.jsonc` (`wrangler d1 create <name>` prints the `database_id`):

```jsonc
{ "d1_databases": [{ "binding": "TEAM_DB", "database_name": "pokedex-team", "database_id": "<paste the id>", "migrations_dir": "migrations" }] }
```

**3. The D1 module**, `lib/team-db.d1.ts`. The binding is read per call. The cap of six members is one conditional statement, because D1 has no transaction handle across awaits:

```ts
import { env } from 'cloudflare:workers'

const INSERT =
  'INSERT INTO team (id, name, display_name, num, types, artwork, added_at) ' +
  'SELECT ?1, ?2, ?3, ?4, ?5, ?6, MAX(?7, (SELECT COALESCE(MAX(added_at), 0) + 1 FROM team)) ' +
  'WHERE (SELECT COUNT(*) FROM team) < ?8 ON CONFLICT(id) DO NOTHING'

// inside add(): one batch is one transaction. 1 row changed = added; else look the id up to tell present from full.
const [ins, has] = await env.TEAM_DB.batch([
  env.TEAM_DB.prepare(INSERT).bind(m.id, m.name, m.displayName, m.num, JSON.stringify(m.types), m.artwork, Date.now(), 6),
  env.TEAM_DB.prepare('SELECT 1 AS one FROM team WHERE id = ?1').bind(m.id),
])
```

**4. Alias.** In `brust.toml`:

```toml
[cloudflare.alias]
"lib/team-db.ts" = "lib/team-db.d1.ts"
```

Mark the sqlite module `server_only` so it never reaches a browser bundle.

**5. Apply and run.**

```sh
wrangler d1 migrations apply pokedex-team --local -c dist/cf/wrangler.jsonc    # local workerd
bun run dev:cf
wrangler d1 migrations apply pokedex-team --remote -c dist/cf/wrangler.jsonc   # before the first deploy
```

Build once first so `dist/cf/wrangler.jsonc` exists. A D1 query counts as a subrequest, and the Free plan allows 50 queries per invocation (source C6).

## 9. Differences from native

| | Native (`brust start`) | Workers |
|---|---|---|
| Page cache scope | one process, all workers | one isolate; capacity 256 pages by default |
| `cache.invalidate` | the whole process | the running isolate; others after `ttl_seconds`, unless a cache adapter broadcasts |
| Response compression | gzip in Rust | none in the Worker; Cloudflare compresses at the edge |
| `/_brust/cache/stats` | always on | off (404) unless `stats = true`; per isolate |
| Static files | served by Rust | Workers Static Assets, with the headers from `_headers`; the Worker is not run for a hit |
| CORS on static assets | stamped by the server | **not stamped**: Static Assets answer without running brust. Only pages and actions get CORS headers |
| Plan offer (loader and jobs in one call) | on | off: the loader and jobs are two direct in-isolate calls, which cost microseconds |
| `[server]`, `[workers]` | used | ignored, with a warning |
| Server-only modules (`bun:*`) | allowed | build error `cf-unsupported`; swap with `[cloudflare.alias]` |
| Static site generation (`--ssg`) | not in v2 | not targeted |

## 10. Limits

Numbers below are Cloudflare's, read on 2026-10-12. They change; check the source before you size anything.

| Limit | Free | Paid | Source |
|---|---|---|---|
| Worker size (uncompressed) | 64 MiB | 64 MiB | C5 |
| Startup (global scope) | 1 s | 1 s | C5 |
| CPU time per HTTP request | 10 ms | 30 s default, up to 5 min | C5 |
| Memory per isolate (JS heap and wasm) | 128 MB | 128 MB | C5 |
| Subrequests per invocation | 50 | 10,000 | C5 |
| Static Asset files per Worker version | 20,000 | 100,000 | C5 |
| One Static Asset file | 25 MiB | 25 MiB | C5 |
| D1 queries per invocation | 50 | 1,000 | C6 |

What this means for brust:
- **Size.** The brust wasm plus glue is about 2.65 MB raw (0.79 MB gzip) in the minimal test app, measured by the brust CI on 2026-10-12. A real app adds `react-dom`, Elysia and its own code.
- **CPU.** A cache hit costs microseconds. A miss runs the loader, the jobs and the template render. The Free plan's 10 ms is tight for heavy pages; measure `wrangler dev` output on your own routes.
- **Memory.** Both caches live in the 128 MB. Lower `l1_capacity` if your pages are large. A body over 8 MiB is never cached.
- **Subrequests.** brust makes none of its own. Your D1, KV and `fetch` calls count.
- **Startup.** brust parses the manifest, compiles templates and compiles Elysia at startup. A large app should stay far from 1 s; wrangler's deploy output reports `startup_time_ms`.

## 11. Troubleshooting

**`cf-unsupported`: `<file> imports bun:sqlite`** (or `bun`, `bun:*`). The module does not exist on Workers. Replace it with a Workers-safe module and map it with `[cloudflare.alias]` (section 8). A `server_only` entry keeps it out of browser bundles.

**`cf-smoke` failure at build.** The build imported your bundle with an empty `env` and an export was missing, or your top level threw. Move binding access into functions.

**`cf-config`: more than one wrangler config.** Keep one of `wrangler.jsonc`, `wrangler.json`, `wrangler.toml`.

**`cf-config`: a binding named ASSETS.** Rename yours. `ASSETS` belongs to brust's static assets.

**`compatibility_date ... must be >= 2026-08-04`.** Raise `[cloudflare] compatibility_date`. brust needs `nodejs_compat` for `AsyncLocalStorage`.

**`@brust/core-cf is not installed`.** Run `bun add -d @brust/core-cf@<same version as @brust/core>`, or use `--wasm-from-source` in a brust checkout. A version mismatch with `@brust/core` prints a warning.

**A binding is `undefined`.** It is missing from your `wrangler.jsonc`, or it was read at import time. Check with `wrangler dev` and read bindings inside the request.

**Error 10021 on deploy (startup too long).** The global scope took more than 1 s. Remove heavy work at module top level.

**A page stays stale after a mutation.** Expected without a cache adapter: other isolates serve the old page up to `ttl_seconds`. See section 7.

## Sources

All fetched 2026-10-12.

| Id | Page |
|---|---|
| C1 | https://developers.cloudflare.com/pages/ |
| C2 | https://developers.cloudflare.com/workers/runtime-apis/nodejs/ |
| C3 | https://developers.cloudflare.com/workers/runtime-apis/bindings/#importing-env-as-a-global |
| C4 | https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-eval-during-startup |
| C5 | https://developers.cloudflare.com/workers/platform/limits/ |
| C6 | https://developers.cloudflare.com/d1/platform/limits/ |

Every figure and quotation above was re-read from these pages on that date.
