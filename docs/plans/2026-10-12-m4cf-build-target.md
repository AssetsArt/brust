# m4cf-build-target: `brust build/dev --target cloudflare` emits a complete wrangler project in `dist/cf/`; `worker.ts` split into pure `handlers.ts` + Bun boot; `fetchInScope`
**RULED by lead Detoro 2026-10-12 (before dispatch): R2 RULED FOR THE DRAFT (Bun bundles `brust-app.js` into ONE file placed beside the worker-build glue — the brief's "let wrangler bundle" default is rejected on the six cited grounds); R3 ACCEPTED (layout read from the `brust` field of `npm/core-cf/package.json`, which lane 3 writes: `main`/`glue` = `index.js`, `appModuleDir` = "."); R4 RULED FOR THE DRAFT (no `optionalDependency` until the first publish — lane 6 adds it; resolution order `--wasm-from-source` > `BRUST_CORE_CF_DIR` > app root > core); R5-R13 ACCEPTED as their defaults (merge policy with brust-owned keys + warnings, no `account_id` unless the user's file has it, `compatibility_date` ≥ 2026-08-04 from core-cf metadata, assets `html_handling:none`/`not_found_handling:none` + `_headers`, `.compile()` at the top level of the generated entry, `brust dev --target cloudflare` = wrangler dev wrapper with rebuild/restart and no HMR, blank template gets `dev:cf`/`deploy:cf`/`wrangler.jsonc.tmpl`, committed `.snap` files, one `ci.yml` line to run the new test files). CORRECTIONS FROM LANE 3 (applied): (a) the `invalidate` mechanism is UNVERIFIED until lane 3's Task 2 reports — implement the virtual stub only after that note lands (ask the lead; pre-ruled fallback = `install(rt)`); (b) `--wasm-from-source` runs `bun crates/brust-wasm/scripts/build.ts`, never bare `worker-build`; (c) `npm/core-cf/worker/` holds the build script's output, not worker-build's raw `build/`; (d) lane 3 owns `npm/core-cf/package.json` — this lane only READS it. Boundary: `packages/brust/**`, `packages/create-app/templates/blank/**` + `packages/create-app/src/**` (blank only; pokedex/examples = lane 5), `docs/create-app.md`, one line in `.github/workflows/ci.yml`; `scripts/release-files.ts` + the optional dep = lane 6. `brust build --target cloudflare` on pokedex fails with `cf-unsupported … bun:sqlite` by design until lane 5. Task 15 (one real deploy) follows bb rule:cloudflare-account — always delete; skip with a note if lane 3's wasm is not merged yet. Base: m4cf now (parallel with lane 2 and 3; no file overlap). Implementer Tiësto, reviewer Mellow (complex).**
owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: m4cf (after lane 2 `m4cf-core-wasm` merges) · lane: m4cf-build-target · tier: standard · review: complex
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Lane M4-CF-4 of `docs/design/2026-10-12-m4-cloudflare-workers-design.md`. Read its header (R1-R14, H3), §3 "Packages", §4 (the generated entry, `[cloudflare]`, CLI, generated `dist/cf/`), §6 and §9 first. This lane runs **in parallel** with lane 3 `m4cf-worker-crate` (owns `crates/brust-wasm`, the `raw_module` imports and the worker-build output). This lane **produces** what spec §4 + the contract table below specify; lane 3 **consumes** it. Any mismatch with lane 3 → `conclave task challenge`, never a local workaround. Every `path:line` is verified at `m4cf` @7a87e6e (0851ae4 since added spec §6's account rule, docs only); re-anchor on the quoted text if the base moved.

**Account rule (human, 2026-10-12; spec §6 :368).** A logged-in `wrangler` exists on the lead's host. This lane MAY do ONE short-lived real deploy of the fixture/blank app named `brust-test-m4cf-build-target-<shortsha>` (Task 15), and MUST `wrangler delete` it at the end, every time, recording both commands in the task note. Tests and CI stay local (no account). No account ids, zones, workers.dev subdomains or secrets in Markdown, notes or generated files. The merged `wrangler.jsonc` carries `account_id` only if the user's own file had it. The template's `deploy:cf` never names a Worker beyond the app's own package name.

## Facts the plan rests on
- `packages/brust/src/worker.ts` (347 lines):
  - pure: wire types `:15-76`, `toJson` `:106-112`, `literalsIndex` `:117-122`, `jobIdOf` `:127-130`, `routeStoresIndex` `:136-155`, `withStore` `:158-162`, `verdictJson` `:168-174`, `Handlers` `:176-179`, `makeHandlers` `:183-263`. The side effect `installServerResolver(getServerInstance)` is at `:13`.
  - Bun only: `writeSlot` `:88-98` (uses `Buffer` `:93`), `PlanJobs`/`PLAN_DECLINED`/`PLANNED` `:101-104`, `makeDispatch` `:269-293` (imports napi `planJobs` `:8`), `SLOT_BYTES` `:297`, boot `startWorker` `:315-342`, auto-start `:346-347` (`node:worker_threads` `:5`).
  - Importers that must keep working unchanged: `run.ts:13` (`SLOT_BYTES`), and tests `worker.test.ts:7-17`, `build-manifest.test.ts:7`, `worker-store.test.ts:4`, `actions-napi.test.ts:10`, `actions-bridge.test.ts:15`, `napi-server.test.ts:4`, `e2e-actions.test.ts:10`.
- `bench/attribution.patch:649-661` patches `worker.ts`: hunk `@@ -1,6 +1,7 @@` (context = lines 1-6 verbatim: three comment lines + the `node:path`, `node:worker_threads`, `./actions-bridge` imports) and a hunk in `makeDispatch`'s body. `git apply --check bench/attribution.patch` is green at 7a87e6e.
- `actions-bridge.ts`: imports `./native` at `:4`; `toRequest` `:71-78` uses `Buffer` `:76`; `runFetch` `:118-155`; the store-scoped core is `:131-139` (`runInStoreContext` around `a.fetch(req)` + headers with set-cookie split + `arrayBuffer()`).
- `native.ts:74` does `require('../native/index.js')` (the napi loader, which `require`s `.node` files and `@brust/native-*`). It is reached from `@brust/core/server` → `cache.ts:5` (`cacheInvalidate`) and from `actions-bridge.ts:4`.
- `actions/load.ts:6-18` `mountActions(app, prefix)` checks `app instanceof Elysia` (`:9`), so the app and brust need ONE elysia. elysia 2.0.0-beta.30 declares `compile(): this` (`node_modules/.bun/elysia@2.0.0-beta.30…/dist/base.d.ts:990`).
- `build/index.ts`:
  - `runBuild` `:76-138`: validation before any write (`:91-117`), a tmp sibling dir, then `buildInto` `:140-199`, then removal of `tmp/.stage` (`:126`) and an atomic rename.
  - `buildInto` writes `manifest.json` at `:180` and copies `public/` at `:183-184`.
- `build/bundle.ts`:
  - `PRODUCTION` `:19` and `sourceDirPlugin` `:43-57`. Its comment at `:39-42` says "an `--out-dir` outside the app has no `node_modules` above it".
  - `buildActions` `:337-342` and `buildJobs` `:346-387` both build `target: 'bun'` with `@brust/core/*`, React (+ elysia for actions) **external** (`:318,333`) and inline the app code. The staged jobs entry is `<out>/.stage/jobs.ts` (`:375-376`).
  - `workerStorePlugin` `:324-329`.
- `build/config.ts:67-87` `loadBuildConfig` parses `[build]` + `[actions]`. Runtime `[cors]` is `config.ts:141` (`parseCors`, used by `loadConfig` `:62`).
- `build/manifest.ts`:
  - `writeManifest` `:242-287`, with `template: 'jinja/<id>.jinja'` at `:258`.
  - brust-core `Manifest::load` keys templates by component id after reading `c.template` (`crates/brust-core/src/manifest.rs:369-386`).
- Static serving in core:
  - `/_brust/<rel>` and `/public/<rel>` (`crates/brust-core/src/pipeline.rs:105-111`), filtered by `safe_rel` (`static_rules.rs:125`): segments `[A-Za-z0-9_.-]`, no leading `.`; under `/_brust/` only `client/<file>.js|.css`.
  - Hashed names (`is_hashed` `static_rules.rs:150`) get `IMMUTABLE` (`:10`, `public, max-age=31536000, immutable`); every static response gets `nosniff` (`pipeline.rs:159-168`). Other files get `public, max-age=3600` (`crates/brust-server/src/server/static_assets.rs:15`).
- `cli.ts` has `build` and `start` only (`:8-16`, `:62-92`). `run.ts:37` uses generator `brust/<version>`; `run.ts:81` sets `NODE_ENV ??= 'production'`.
- react-dom's `./server` export maps `workerd` → `server.edge.js` (`node_modules/.bun/react-dom@19…/react-dom/package.json:59`). `Bun.build` supports `conditions` (`bun-types@1.4.2/bun.d.ts:3308`), and `Bun.JSONC` exists (`:1355`).
- create-app:
  - `templates/blank/package.json.tmpl` (scripts `dev/build/start/typecheck`) is asserted by `test/templates.test.ts:49-51`. `*.tmpl` files are substituted (`src/copy.ts:28,35`).
  - The pokedex template is generated from `examples/pokedex` (`scripts/sync-template.ts`), so its scripts come from lane 5.
  - Monorepo mode overrides `@brust/runtime-dom` + 6 natives (`src/dep.ts:46-48`), and `test/scaffold.test.ts:111` asserts `toHaveLength(7)`.
  - `docs/create-app.md:36` is the scripts line.
- CI runs an explicit file list for `packages/brust` (`.github/workflows/ci.yml:122-131`), so a new test file runs in CI only if it is listed there.
- `npm/*` is a root workspace glob (`package.json` workspaces), so a new `npm/core-cf/package.json` changes `bun.lock`.
- Cloudflare [C, fetched 2026-10-12]:
  - Wrangler bundles `main` with esbuild, honours `exports`, loads the `workerd` key, and imports `.wasm` as `WebAssembly.Module` (https://developers.cloudflare.com/workers/wrangler/bundling/).
  - Assets are served first, and a miss invokes the Worker (…/static-assets/routing/worker-script/). `html_handling` defaults to `auto-trailing-slash` and can be `none` (…/routing/advanced/html-handling/).
  - `_headers`: at most 100 rules; matching rules are comma-joined; `! Header` detaches; it does not apply to Worker responses (…/static-assets/headers/).
  - The workers-rs template uses `main = "build/index.js"` with `worker-build@^0.8` (templates/hello-world/wrangler.toml). The worker-build README still shows `build/worker/shim.mjs`. **The output layout is version-dependent, so it is never hard-coded here.**

## Contract with lane 3 (spec §4, made exact; a mismatch is a challenge)
| Item | This lane produces | Lane 3 consumes |
|---|---|---|
| `brust-app.js` location | written into `dist/cf/worker/<appModuleDir>` read from `@brust/core-cf` `package.json` `brust.appModuleDir` (default `"."` = next to the glue file that holds `raw_module "./brust-app.js"`) | `#[wasm_bindgen(raw_module = "./brust-app.js")]` |
| exports | `loader(json: string): Promise<string>`, `jobs(json): Promise<string>` (never reject: a parse/handler error resolves to `{"error":…}` like `makeDispatch`); `action(req: Request): Promise<Response>`; `MANIFEST: string` (manifest.json text); `TEMPLATES: Record<string,string>` keyed by the manifest `components[id].template` value (`jinja/<id>.jinja`); `CONFIG: string` (JSON below) | bridge externs |
| `CONFIG` JSON | `{"abi":1,"generator":"brust/<core version>","l1Capacity":256,"jobCacheCapacity":512,"stats":false,"edgeCache":"off","cors"?:<config.ts CorsConfig, camelCase>,"actions"?:{"prefix","maxBodyBytes","maxResponseBytes","crossSite"}}` | `CoreConfig` |
| `cache.invalidate` | the CF bundle's napi stub calls the glue export `invalidate(args)` and expects `{l1Removed, jobRemoved}` (R8) | `#[wasm_bindgen] pub fn invalidate` |
| package metadata | `npm/core-cf/package.json` `"brust": {"abi":1,"main":"index.js","appModuleDir":".","glue":"index.js","compatibilityDate":"2026-10-01","workerBuild":"^0.8","wasmBindgen":"0.2.129"}`; files under `worker/` = the worker-build `build/` dir verbatim | lane 3 corrects `main`/`glue`/`appModuleDir` from its Task 1 finding |

## Goal
- `brust build [entry] --target cloudflare [--out-dir dist] [--wasm-from-source]` runs the normal build unchanged, then writes `dist/cf/`:
  - `worker/`: the worker-build output, copied from `@brust/core-cf` or built by `worker-build --release --panic-unwind` in `crates/brust-wasm`;
  - `worker/<appModuleDir>/brust-app.js`: ONE self-contained ESM bundle of a generated ~25-line entry, `.stage/brust-app.entry.js`, kept for inspection;
  - `assets/_brust/client/*` and `assets/public/*` (only `safe_rel`-admissible files) plus `assets/_headers`;
  - `wrangler.jsonc`: the user's app-root config merged with the brust-owned keys (R5).
- With `[cloudflare] alias`, the CF bundle swaps the aliased module paths (spec R12). An import of `bun`/`bun:*` anywhere in the CF graph fails the build with `error cf-unsupported <importer> imports <spec>`.
- `brust dev [entry] --target cloudflare [-- <wrangler args>]` builds, runs `wrangler dev -c dist/cf/wrangler.jsonc --persist-to .wrangler/state`, and rebuilds + restarts wrangler on source change (R10).
- The Bun path is byte-identical:
  - a pokedex `dist/` built before and after the lane diffs empty;
  - every existing `packages/brust` test and `tests/server` e2e passes with assertions unchanged;
  - `git apply --check bench/attribution.patch` stays green.
- `packages/brust/src/handlers.ts` holds the pure handler code and is imported by `worker.ts` (which re-exports it) and, through `@brust/core/server-handlers`, by the generated entry. `actions-bridge.ts` exports `fetchInScope(app, req): Promise<Response>`, and `runFetch` uses its core.
- `npm/core-cf/` defines `@brust/core-cf`. The release leg is lane 6.
- No generated file contains an `account_id` the user did not write. One real deploy of the built fixture answers `/`, a client chunk and a public file, and is deleted afterwards (Task 15, conditional on lane 3's wasm being available).
- The create-app `blank` template gains `dev:cf`/`deploy:cf`, a `wrangler` devDependency and `wrangler.jsonc.tmpl`; `docs/create-app.md:36` lists them.

## Rulings requested
**R1 — Target selection.** *Default:*
- Only `--target cloudflare` (or `--target bun`, the default) selects the target. `[cloudflare]` in `brust.toml` is optional configuration and never changes a plain `brust build`. This keeps the Bun path byte-identical and `brust start` unaffected.
- `--target` with any other value is a usage error (exit 2).
- A `[cloudflare]` table without the flag is parsed and validated, so errors surface early, but writes nothing.

*Alternative (the brief's "both, flag wins"):* table presence makes `brust build` also emit `dist/cf/`. That costs every build a ~1-2 s CF bundle and makes `brust build` depend on `@brust/core-cf` being installed.

**R2 — Who bundles for the Worker.** *Default (spec §4):* brust Bun-bundles the generated entry into ONE self-contained `brust-app.js`:
- options: `target: 'browser'`, `conditions: ['workerd','worker','browser']`, `define: PRODUCTION`, `minify: false`;
- external: `node:*`, `cloudflare:*` and the glue specifier;
- wrangler's esbuild then sees only glue + `brust-app.js` + `.wasm`.

The evidence against leaving resolution to wrangler (the brief's default):
- (a) `@brust/core/server` → `cache.ts:5` → `native.ts:74` statically `require`s the napi loader. Wrangler cannot alias a relative `require` inside a package; a Bun plugin can stub it (R8).
- (b) `[cloudflare] alias` must apply to app sources, but `dist/jobs.js`/`dist/actions.js` already inline the app code (`bundle.ts:337-387`). So the CF build re-bundles from source: the staged `<out>/.stage/jobs.ts`, the actions entry and the routes entry.
- (c) `--out-dir` may lie outside the app, with no `node_modules` above it (`bundle.ts:39-42`). Wrangler would fail to resolve `react-dom`, `elysia` and `@brust/core`.
- (d) `mountActions` needs one elysia instance (`load.ts:9`), which a single bundle guarantees.
- (e) Spec §6 step 7's smoke import under Bun needs a self-contained file.
- (f) The `bun:*` guard fails at `brust build`, not at `wrangler deploy`.

*Alternative:* write only the ~25-line entry as `brust-app.js` with package specifiers and let wrangler bundle. Then (a)-(f) need wrangler `alias` entries, the out dir must sit inside the app, and the alias table is unimplementable for already-bundled modules.

**R3 — `dist/cf/` layout and `brust-app.js` location.** *Default:*
- `dist/cf/worker/` is the worker-build output verbatim.
- `brust-app.js` goes into `worker/<brust.appModuleDir>`, because `raw_module "./brust-app.js"` resolves relative to the glue file that contains it.
- `main` is `worker/<brust.main>`.
- All three names come from `@brust/core-cf`'s `package.json` `brust` field, so the worker-build 0.8 layout (`build/index.js` vs the README's `build/worker/shim.mjs`) is lane 3's finding, not hard-coded here.

*Alternative:* the spec §4 flat layout (`dist/cf/{index.js,index_bg.wasm,brust-app.js}`). It is simpler to read but mixes generated and copied files and breaks if worker-build nests its glue.

**R4 — Resolving `@brust/core-cf`.** *Default:* resolution order:
1. `--wasm-from-source`: requires a brust checkout (`<pkg>/../../crates/brust-wasm`) plus `cargo` and `worker-build` on `PATH` (`Bun.which`). It runs `worker-build --release --panic-unwind` with cwd `crates/brust-wasm` and reads metadata from the repo's `npm/core-cf/package.json`.
2. Env `BRUST_CORE_CF_DIR` (doc-hidden; tests, CI lane 6).
3. `Bun.resolveSync('@brust/core-cf/package.json', appRoot)`.
4. The same, resolved from `@brust/core`'s own directory.

After resolution:
- A missing package, or a missing `worker/<main>`, → `error cf-wasm …` with the hint `bun add -d @brust/core-cf@<core version>` or `--wasm-from-source`.
- `brust.abi !== 1` → error.
- A version ≠ `@brust/core`'s → warning only.
- **The install-graph edge (`optionalDependencies` in `packages/brust/package.json`) is NOT added here.** Adding it now changes create-app monorepo overrides (`dep.ts:46-48`, `scaffold.test.ts:111` `toHaveLength(7)`) and makes packed installs reference an unpublished version [I]. Lane 6 adds it with the first publish.

*Alternative (the brief's default):* add `"@brust/core-cf": "workspace:*"` to `optionalDependencies` now, and update `dep.ts` (+1 override) and `scaffold.test.ts` (7 → 8) in this lane.

**R5 — `wrangler.jsonc` merge (R8 of the spec).** *Default:*
- **Input:** read the app-root `wrangler.jsonc` | `wrangler.json` | `wrangler.toml` (`Bun.JSONC`/`Bun.TOML`). More than one → `error cf-config`. None → start from `{}`.
- **Brust-owned keys**, overridden with a `[brust] wrangler: <key> is owned by brust build --target cloudflare; ignored` warning (also inside every `env.<name>` block):
  - `main`, `assets`, `compatibility_date`, `no_bundle`, `find_additional_modules`, `base_dir`, `rules`, `build`, `site`.
  - `compatibility_flags` = the user's list kept as is. A flag matching `/^no_nodejs_compat/` → `error cf-config` (ALS needs it). Brust adds no flags (R6).
- **Path keys are rebased** from the app root to `dist/cf` (also inside `env.*`):
  - `d1_databases[].migrations_dir`, always written, default `migrations`;
  - `tsconfig`;
  - `alias` values starting with `.`.
- **`name`:** `[cloudflare] name` > the user's `name` > the `package.json` `name` (scope dropped, lowercased, non-`[a-z0-9-]` → `-`, ≤ 63). A brust.toml/wrangler conflict → warning, brust.toml wins.
- **Binding names:** a user binding named `ASSETS` → `error cf-config`.
- **`account_id`** (account rule): copied only if the user's file has it (root or `env.*`). brust never adds it, nor reads it from `wrangler whoami`/env. `[cloudflare]` has no `account_id` key.

*Alternative:* treat a user-set brust-owned key as an error rather than a warning (stricter, but a copied wrangler starter would fail).

**R6 — `compatibility_date`.** *Default:* `[cloudflare] compatibility_date` if set (`YYYY-MM-DD`, ≥ `2026-08-04`, else `error config`); otherwise `brust.compatibilityDate` from `@brust/core-cf`, the date the wasm was built and tested with (`2026-10-01` initially). The user's wrangler value is ignored with a warning. `nodejs_compat` is never added, because it is default from 2026-08-04 (spec R14) and an explicitly re-enabled default flag may be rejected by workerd [I]. *Alternative:* a constant in brust source, bumped by hand.

**R7 — Assets and their headers.** *Default:*
- `assets: { directory: "assets", binding: "ASSETS", run_worker_first: false, html_handling: "none", not_found_handling: "none" }`. With `none`, `/public/x.html` is served verbatim as natively, and every miss falls through to core, which answers 404.
- Copy only files `safe_rel` admits:
  - `dist/client/<file>.js|.css` → `assets/_brust/client/`;
  - `dist/public/**` (no dot-segments) → `assets/public/**`.
- `_headers`:
  - `/*` gets `X-Content-Type-Options: nosniff` + `X-Powered-By: brust/<ver>`;
  - `/_brust/client/*` gets `Cache-Control: public, max-age=31536000, immutable`;
  - per-file `Cache-Control` rules for each `public` file (immutable if a TS port of `is_hashed` holds, else `public, max-age=3600`) while the total stays ≤ 100. Beyond that, one `/public/*` `max-age=3600` rule plus a warning.
- **Documented delta (lane 8):** asset responses carry no CORS headers, since `_headers` cannot reflect origins.

*Alternative:* `run_worker_first: ["/_brust/*","/public/*"]` for full CORS parity. It needs `WasmHost::static_file` to fetch from `ASSETS`, which spec §5 calls "unused in M4" (lane-3 scope creep).

**R8 — `cache.invalidate` on Workers.** *Default:*
- A CF-bundle-only Bun plugin resolves `native.ts`'s `require('../native/index.js')` to a generated virtual module. Its `cacheInvalidate(args)` forwards to the glue's `invalidate(args)` (an external import of `./<glue>`), and every other napi function throws `<name> is not available on Cloudflare Workers`.
- No change to `cache.ts`/`native.ts`. The glue ↔ `brust-app.js` import cycle is safe because `invalidate` is only called at request time [I; lane 3 verifies under workerd].

*Alternative:* a `setInvalidateBackend()` hook in `cache.ts`, called from the entry. That adds public-ish API and is outside the spec §9 boundary.

**R9 — Where `.compile()` runs.** *Default:* at the top level of the generated entry, `const app = mountActions(A, <prefix>).compile()`. Module evaluation is Worker startup, where eval is allowed (spec §8). The Bun path does not compile eagerly (unchanged). *Alternative:* an exported `init()` that lane 3's `#[event(start)]` calls. That is one more export and an ordering dependency.

**R10 — `brust dev --target cloudflare` scope.** *Default:* a minimal wrapper with no HMR:
- build once (a failure exits 1);
- spawn `wrangler dev -c <out>/cf/wrangler.jsonc --persist-to <appRoot>/.wrangler/state [--port N] <args after -->` with stdio inherited and cwd = app root. `--persist-to` keeps local D1/KV across rebuilds, because `dist/` is replaced on every build (`index.ts:127-133`);
- watch the app root recursively (ignoring the out dir, `node_modules`, `.wrangler`, `.git`), debounce 300 ms, rebuild;
- a successful rebuild SIGTERMs + respawns wrangler; a failed one keeps the old child and prints the error;
- SIGINT/SIGTERM kill the child and exit 0; a child that exits on its own exits with its code;
- the wrangler binary is `BRUST_WRANGLER` (tests) else `Bun.which('wrangler', {PATH: <app>/node_modules/.bin:…})`, else `error cf-dev wrangler not found (bun add -d wrangler)`;
- `brust dev` without `--target cloudflare` → usage error 2 ("only --target cloudflare in this release").

*Alternative:* defer `brust dev` to a follow-up and ship only `dev:cf` = `brust build --target cloudflare && wrangler dev -c …`.

**R11 — create-app.** *Default:* `blank` only (pokedex scripts come from lane 5's `examples/pokedex/package.json` via sync-template).
- Scripts:
  - `"dev:cf": "brust dev routes.tsx --target cloudflare"`;
  - `"deploy:cf": "brust build routes.tsx --target cloudflare && wrangler deploy -c dist/cf/wrangler.jsonc"`.
- `devDependencies.wrangler`: `^<current major.minor>.0`, from `npm view wrangler version` at implementation time. `@brust/core-cf` is not listed (R4).
- `wrangler.jsonc.tmpl`: `name: "__PROJECT_NAME__"`, a header comment naming the brust-owned keys, and commented `d1_databases`/`kv_namespaces`/`vars` placeholders. There is no `assets` block: the "assets binding placeholder" is a comment saying brust sets `ASSETS`.
- `_gitignore` gains `.wrangler/`.
- Cost: CI's scaffold test downloads wrangler + workerd. *Alternative:* scripts use `bunx wrangler@^4` and no devDependency.

**R12 — `[cloudflare]` keys this lane parses (build/config.ts).**
- `name` (string), `compatibility_date` (R6), `l1_capacity` (int 1..2^32-1, default 256), `job_cache_capacity` (default 512), `stats` (bool, default false), `edge_cache` (`"off"` only; `"workers-cache"` → `error config … lands with M4-CF-7`).
- `alias`: a table of app-root-relative module paths, each resolved with `Bun.resolveSync` from the app root. A missing file → `error config`. This implements spec R12, because lane 5's boundary is examples-only.
- Unknown keys → `error config`. With `--target cloudflare`, a present `[server]`/`[workers]` → warning `ignored on this target`.

**R13 — Lane-3 contract values.** Rule the contract table above as written: `TEMPLATES` keyed by template rel path (not component id), `CONFIG` in camelCase mirroring napi `StartOptions` (`run.ts:29-41`), `abi: 1`. Alternative: key `TEMPLATES` by component id (matches `Loaded.templates`), with `from_parts` re-deriving paths.

## Boundary
- `packages/brust/src/`:
  - `handlers.ts` (new), `server-handlers.ts` (new), `worker.ts`, `actions-bridge.ts`, `cli.ts`, `dev.ts` (new);
  - `build/index.ts`, `build/config.ts`, `build/bundle.ts` (only `export` added to `PRODUCTION`, `workerStorePlugin`; no output change);
  - `build/cloudflare.ts` (new orchestrator), `build/cf-entry.ts`, `build/cf-wrangler.ts`, `build/cf-assets.ts`, `build/cf-core.ts` (new).
- `packages/brust/package.json`: exports `./server-handlers`, `./server-handlers/actions` only.
- `packages/brust/test/`:
  - `{handlers,fetch-in-scope,cf-config,cf-entry,cf-wrangler,cf-assets,cf-core,cf-build,cf-dev}.test.ts`;
  - `test/__snapshots__/cf-entry.test.ts.snap` (committed: Bun refuses to create snapshots under `CI`);
  - `test/fixtures/cf-core/**`, `test/fixtures/cf-app/**`.
- `npm/core-cf/{package.json,README.md,.gitignore}` and `bun.lock` (workspace member added).
- `packages/create-app/templates/blank/{package.json.tmpl,wrangler.jsonc.tmpl,_gitignore,README.md.tmpl}`, plus `packages/create-app/test/templates.test.ts` (`:49-51` scripts expectation updated: the ONE assertion change allowed).
- `docs/create-app.md` (`:36` + a "Cloudflare" line in §5).
- `.github/workflows/ci.yml`: ONE added line after `:131`, `- run: cd packages/brust && bun test test/handlers.test.ts test/fetch-in-scope.test.ts test/cf-*.test.ts`. Lane 6 owns the rest of the file.
- NOT in the boundary:
  - `crates/**`, `examples/**`, `scripts/release-*.ts` (lane 6 adds `npm/core-cf` to `FILES`), `docs/cloudflare.md` (lane 8);
  - `packages/brust/src/{cache,native,run,routes}.ts`, `packages/create-app/{src,scripts}/**`.
  - Anything else → `conclave task challenge`.

## Tasks
Use `$W=/Users/detoro/code/brust-lane-m4cf-build-target`, `$OUT=/private/tmp/m4cf-build-target`, `$WS=838f12fb-70c1-41b7-acf2-d4065cf6bb64`.

**Task 1 — worktree, baseline, Bun-path reference dist**
- [ ] `git -C /Users/detoro/code/brust fetch origin m4cf && git -C /Users/detoro/code/brust worktree add $W -b lane/m4cf-build-target origin/m4cf && cd $W && git log --oneline -1 --grep 'merge: lane/m4cf-core-wasm'` → prints one merge line. If it prints nothing, lane 2 is not merged: `conclave task challenge`.
- [ ] `bun install --frozen-lockfile && (cd packages/brust && bun run build:debug)` → exit 0.
- [ ] `(cd packages/brust && bun test 2>&1 | tail -3)` → `0 fail`; `bun test --timeout 120000 tests/server/pokedex.test.ts` → `0 fail`; `git apply --check bench/attribution.patch && echo ok` → `ok`.
- [ ] `mkdir -p $OUT && (cd examples/pokedex && bun run build) && cp -R examples/pokedex/dist $OUT/dist-base` → `[brust] built dist`.

**Task 2 — `handlers.ts` extraction (pure move)**
- [ ] Test first, `test/handlers.test.ts`:
  - (a) for each of `makeHandlers, literalsIndex, jobIdOf, routeStoresIndex, toJson`: `expect(worker.X).toBe(handlers.X)`;
  - (b) `Bun.build({ entrypoints:['src/handlers.ts'], target:'browser', external:['node:*'] })` succeeds, and its output contains none of `worker_threads`, `registerWorker`, `planJobs`, `Buffer`;
  - (c) `jsonCall(fn)` returns a function that resolves `'{"error":…}'` on bad JSON and on a throwing `fn` (never rejects), and `toJson(fn result)` otherwise.

  Run `cd packages/brust && bun test test/handlers.test.ts` → fails (no module).
- [ ] Move `worker.ts:15-76`, `:106-112`, `:114-263` and the side effect `:13` (with its imports `:9-11`) into `src/handlers.ts` verbatim. Add `export function jsonCall<Q,R>(fn:(q:Q)=>Promise<R>): (json:string)=>Promise<string>` (parse + call + `toJson`, catch → `toJson({error:String(e)})`).
- [ ] `worker.ts`:
  - keep lines 1-6 byte-identical (attribution.patch context);
  - line 7+ imports what it still uses from `./handlers` and adds `export * from './handlers'` (types included);
  - `writeSlot`, `PlanJobs`, `PLAN_DECLINED`, `PLANNED`, `makeDispatch`, `SLOT_BYTES` and the boot stay, with the `makeDispatch` body unchanged.
- [ ] `bun test test/handlers.test.ts` → pass; `bun test` → `0 fail`; `bun check` → exit 0; `git apply --check bench/attribution.patch` → green. If it is red, regenerate only the `worker.ts` hunks (apply the old patch on a scratch copy of the base, port the hunk, `git diff`), and say so in the note.

**Task 3 — `fetchInScope`**
- [ ] Test first, `test/fetch-in-scope.test.ts`:
  - a store touched inside `app.fetch` and inside a lazy body stream is in scope (no `outside a request scope` throw);
  - status, headers and two `set-cookie` values survive;
  - a 204/304 reply has a `null` body;
  - the result is a `Response`.
- [ ] `actions-bridge.ts`: extract `:131-139` as `export async function fetchParts(a: ActionsApp, req: Request): Promise<{status:number; pairs:[string,string][]; body:Uint8Array}>`, and make `runFetch` call it (same statements, same order). Add `export async function fetchInScope(a: ActionsApp, req: Request): Promise<Response>`, which builds `Headers` by `append` over `pairs` with body `null` for 101/204/205/304. Add `export const noActions = async (_: Request) => new Response('brust: actions are not configured in this worker', {status:500, headers:{'content-type':'text/plain; charset=utf-8'}})`.
- [ ] `bun test test/fetch-in-scope.test.ts test/actions-bridge.test.ts test/actions-napi.test.ts` → `0 fail`.

**Task 4 — `@brust/core/server-handlers`**
- [ ] `src/server-handlers.ts` re-exports `makeHandlers, jsonCall` (`./handlers`), `flattenRoutes` (`./routes`), and `fetchInScope, noActions` (`./actions-bridge`). `package.json` exports gain `"./server-handlers": "./src/server-handlers.ts"` and `"./server-handlers/actions": "./src/actions/load.ts"` (elysia stays out of apps without `[actions]`). Add a test in `handlers.test.ts`: `import('@brust/core/server-handlers')` has those five functions.

**Task 5 — `[cloudflare]` config (R12, R6)**
- [ ] Test first, `test/cf-config.test.ts`: defaults; every key's bad type → `BuildError` rule `config`; `compatibility_date = "2026-08-03"` → error; `edge_cache = "workers-cache"` → error naming M4-CF-7; an alias to a missing file → error; an unknown key → error.
- [ ] `build/config.ts`: `BuildConfig.cloudflare: CloudflareBuildConfig | null` via `parseCloudflare(file, root.cloudflare)`, following `parseActions` (`:28-63`). Existing callers ignore the new field.

**Task 6 — entry generator (pure, snapshot)**
- [ ] Test first, `test/cf-entry.test.ts`: `cfEntrySource(input)` with fixed fake absolute paths, three snapshots: (i) actions + stores, (ii) no actions, (iii) prefix `/api`. Assert that (ii) contains `export const action = noActions` and no `elysia`/`server-handlers/actions` import. Assert that `CONFIG` round-trips `JSON.parse`. Run `bun test --update-snapshots test/cf-entry.test.ts` once, review the `.snap`, commit it.
- [ ] `build/cf-entry.ts` — `cfEntrySource({entry, jobsEntry, actionsEntry|null, prefix, manifestPath, templatesPath, config})`. The output is exactly these lines, the optional ones only with actions:
```js
// generated by `brust build --target cloudflare` — do not edit (M4-CF spec §4)
import * as R from "<entry>"
import J, * as JM from "<jobsEntry>"
import A from "<actionsEntry>"
import M from "<manifestPath>"
import T from "<templatesPath>"
import { fetchInScope, flattenRoutes, jsonCall, makeHandlers, noActions } from "@brust/core/server-handlers"
import { mountActions } from "@brust/core/server-handlers/actions"
const h = makeHandlers({ leaves: flattenRoutes(R.routes ?? R.default).leaves, jobs: J, manifest: M, stores: JM.stores ?? {} })
const app = mountActions(A, "<prefix>").compile() // startup-phase compile (R9)
export const loader = jsonCall(h.loader)
export const jobs = jsonCall(h.jobs)
export const action = (req) => fetchInScope(app, req)   // without actions: export const action = noActions
export const MANIFEST = JSON.stringify(M)
export const TEMPLATES = T
export const CONFIG = <JSON.stringify(JSON.stringify(config))>
```
  `* as JM` replaces spec §4's `{ stores }`, because a named import of an absent `stores` export is a link error (`bundle.ts:320-321` emits it only when stores exist). Every path goes through `JSON.stringify`.

**Task 7 — wrangler merge (pure)**
- [ ] Test first, `test/cf-wrangler.test.ts`. A user config with comments, trailing commas, `kv_namespaces`, `d1_databases` (with and without `migrations_dir`), `vars`, `routes`, `env.staging.d1_databases`, `main`, `assets`, `compatibility_date`, `build` → `mergeWrangler(user, {appRoot, cfDir, name?, compatibilityDate, main, version})`:
  - bindings/vars/routes are deep-equal to the input;
  - `migrations_dir` is rebased to `../../migrations` (root and `env.staging`);
  - `main`/`assets`/`compatibility_date` are brust's, and `build` is dropped;
  - warnings list each owned key;
  - `no_nodejs_compat` → throws `cf-config`; an `ASSETS` binding → throws;
  - three config files → throws;
  - a user file without `account_id` → the output has no `account_id` key at any depth (`JSON.stringify(out)` does not contain `account_id`); a user file with one → kept verbatim;
  - the toml input gives the same result as the jsonc one.
- [ ] `build/cf-wrangler.ts`: `readUserWrangler(appRoot)`, `mergeWrangler(…) → {config, warnings}`, `renderWrangler(config)` (a header comment line + 2-space JSON + `\n`).

**Task 8 — assets + `_headers`**
- [ ] Test first, `test/cf-assets.test.ts`:
  - `public/.env`, `public/a b.png` and `client/manifest.json` are not copied; `public/img/logo-1a2b3c.png` gets an immutable rule; `public/robots.txt` gets 3600;
  - 120 public files → splat fallback + warning;
  - `isHashed` agrees with `static_rules.rs` tests on the 5 cases at `static_rules.rs:176-187`.
- [ ] `build/cf-assets.ts`: `layoutAssets(out, cfDir, version) → {files, warnings}` and `headersFile(files, version)`.

**Task 9 — `@brust/core-cf` layout + resolution (R3, R4)**
- [ ] `npm/core-cf/package.json`: name, version = the core version, `description`, `license`, `repository`, `files: ["worker","README.md"]`, the `brust` field from the contract table, `publishConfig.access public`. Add `README.md` (2 lines) and `.gitignore` `worker/`. Then `bun install` (NOT frozen) → `bun.lock` gains the workspace; commit it; `bun install --frozen-lockfile` → exit 0.
- [ ] Test first, `test/cf-core.test.ts`. Fixture `test/fixtures/cf-core/{package.json (name @brust/core-cf, brust.abi 1, main/glue index.js), worker/index.js, worker/index_bg.wasm (8 bytes)}`:
  - `BRUST_CORE_CF_DIR` → resolves;
  - `abi: 2` → `cf-wasm` error;
  - a missing `worker/index.js` → error with the `bun add -d` hint;
  - `--wasm-from-source` without `crates/brust-wasm` → `cf-wasm needs crates/brust-wasm (lane M4-CF-3)`;
  - with an injected `run` + `which`, `--wasm-from-source` runs exactly `['worker-build','--release','--panic-unwind']` in `crates/brust-wasm`.
- [ ] `build/cf-core.ts`: `resolveCoreCf({appRoot, fromSource, env, run?, which?}) → {workerDir, meta}`.

**Task 10 — orchestrator, CLI flag, plugins, smoke**
- [ ] Test first, `test/cf-build.test.ts`, on `test/fixtures/cf-app` (a copy of `fixtures/actions-app` + a store module + a `public/` dir + `wrangler.jsonc` with a KV binding + `brust.toml [cloudflare] alias` mapping `lib/db.ts` → `lib/db.cf.ts`), with `BRUST_CORE_CF_DIR` set to the fixture:
  - `bun src/cli.ts build routes.tsx --target cloudflare` exits 0, and the tree has `cf/worker/index.js`, `cf/worker/brust-app.js`, `cf/.stage/brust-app.entry.js`, `cf/assets/_headers`, `cf/assets/_brust/client/runtime-*.js`, `cf/wrangler.jsonc` (with the KV binding);
  - `brust-app.js` contains no `require("../native/index.js")`, `.node`, `worker_threads` or `bun:`; it contains `db.cf` and not `db.ts`'s marker string;
  - it is < 2 MB;
  - a fixture importing `bun:sqlite` → exit 1, `error cf-unsupported`;
  - `--target nope` → exit 2;
  - without `--target`, `dist/cf` does not exist.
- [ ] `build/cloudflare.ts`:
  - `prepareCloudflare(appRoot, cfg, flags)` runs in `runBuild` BEFORE the tmp dir (config, core-cf resolution and the user wrangler read fail before any write, per the `index.ts:91` rule);
  - `buildCloudflare(out, ctx)` is called at the end of `buildInto` (after `:184`), only for the target. It:
    - copies `workerDir`;
    - writes `cf/.stage/templates.json` from `compiled` (key `jinja/<id>.jinja`);
    - writes the entry;
    - runs `Bun.build` per R2 with plugins in order `cfGuard` (`bun`/`bun:*` → violation; bare builtins → `node:<name>` external; `native.ts`'s `../native/index.js` → the R8 virtual module), `cfAlias`, `workerStorePlugin` (non-external variant), `sourceDirPlugin(ctx.sourceOf, appRoot)` (register `<out>/.stage/jobs.ts` and the entry in `sourceOf`, mapped to the routes entry, so bare imports resolve from the app root);
    - takes the single `entry-point` JS output (non-JS outputs such as CSS are dropped with a warning);
    - lays out assets and writes `wrangler.jsonc`;
    - runs the smoke check.
  - The **smoke check** is `Bun.spawnSync([process.execPath, '--preload', <cf/.stage/smoke-preload.ts>, <cf/.stage/smoke.ts>])`. The preload `Bun.plugin`-stubs `cloudflare:*` (`env = {}`) and the glue file. It asserts the export types, `JSON.parse(MANIFEST).version === 1`, `JSON.parse(CONFIG).abi === 1`, and that `await loader('{}')` resolves a string containing `error`. On failure: `error cf-smoke <stderr>`. Child process only (mock leaks are process-wide).
  - `cli.ts`: options `target`, `wasm-from-source`. Update the `USAGE` text.

**Task 11 — Bun-path identity**
- [ ] `(cd examples/pokedex && bun run build) && diff -r $OUT/dist-base examples/pokedex/dist && echo identical` → `identical`.
- [ ] `(cd examples/pokedex && BRUST_CORE_CF_DIR=$W/packages/brust/test/fixtures/cf-core bun run build -- --target cloudflare; echo $?)` → `error cf-unsupported lib/team-db.ts imports bun:sqlite …` and `1`. That is expected until lane 5's alias.

**Task 12 — `brust dev --target cloudflare` (R10)**
- [ ] Test first, `test/cf-dev.test.ts`. `BRUST_WRANGLER` = a fake script that appends its argv to `$TMP/args` and sleeps:
  - spawn `bun src/cli.ts dev routes.tsx --target cloudflare -- --port 0` in a copy of `cf-app`;
  - poll (≤ 60 s, deterministic: wait for the condition, never assert durations) until `args` has one line equal to `dev -c <abs>/dist/cf/wrangler.jsonc --persist-to <abs>/.wrangler/state --port 0`;
  - edit `Home.tsx`, then poll until a second line appears;
  - SIGTERM → exit code 0.
  - `brust dev` without `--target` → exit 2.
- [ ] `src/dev.ts` per R10. `cli.ts` splits argv at `--` before `parseArgs`.

**Task 13 — create-app + docs (R11)**
- [ ] Update `templates.test.ts:49-51` to the 6-script object. Add assertions: `wrangler.jsonc.tmpl` parses with `Bun.JSONC` after substitution, has `name`, and has no `main`/`assets`/`compatibility_date`; `devDependencies.wrangler` matches `/^\^\d+\.\d+\.0$/`; `deploy:cf` and `dev:cf` contain no `--name` and no `account`; `wrangler.jsonc.tmpl` has no `account_id`.
- [ ] Edit the template files. In `docs/create-app.md:36`, add `dev:cf` (build for Cloudflare and run `wrangler dev`) and `deploy:cf` (`wrangler deploy` of `dist/cf`). In §5, add one line: "`wrangler.jsonc`: your Cloudflare bindings; brust owns `main`, `assets`, `compatibility_date` (see Cloudflare docs, lane 8)".
- [ ] `cd packages/create-app && bun run typecheck && bun test test/templates.test.ts test/copy.test.ts test/cli.test.ts test/pack.test.ts` → `0 fail`.

**Task 14 — CI line + gates**: add the ci.yml line, then run the Gates.

**Task 15 — one real deploy, then delete (account rule; conditional)**
- [ ] Precondition: a real wasm exists, i.e. lane 3 is merged into `m4cf` (`git merge origin/m4cf` into the lane, rebuild, re-run Task 10/11 tests), or `--wasm-from-source` works. If neither holds at READY time, skip this task and say "Task 15 skipped: no real wasm" in the note. Do not deploy the 8-byte fixture wasm.
- [ ] `wrangler --version` and `wrangler delete --help` (verify the `--name`/`--force` flag spelling [I]). Never run or paste `wrangler whoami` output.
- [ ] In a scratch copy of the blank template under `$OUT/cf-deploy` (scaffold with `bun packages/create-app/bin/create-app.ts cf-deploy --template blank --dir $OUT/cf-deploy --yes`, `bun install`):
```sh
N=brust-test-m4cf-build-target-$(git -C $W rev-parse --short HEAD)
trap 'wrangler delete --name "$N" --force' EXIT        # delete EVERY time, even on failure
bun run build -- --target cloudflare                   # (+ --wasm-from-source if that is the wasm source)
wrangler deploy -c dist/cf/wrangler.jsonc --name "$N"  # name via flag only; nothing written to files
```
  Then curl the printed URL, keeping only status codes, never the host, in the note: `/` → 200 HTML with the counter; `/_brust/client/runtime-<hex>.js` → 200 + `cache-control: public, max-age=31536000, immutable`; `/public/favicon.svg` → 200; `/_brust/action/hello` → 200 `hi`, or the lane-3 status if actions are not yet live; `/nope` → 404.
- [ ] After the trap ran: `wrangler deployments list --name "$N"` → an error/not-found. Record the exact create + delete commands, with `$N` expanded and no URL, in the note.

## Acceptance
- [ ] `cd packages/brust && bun test 2>&1 | tail -3` → `0 fail`; `git diff origin/m4cf -- packages/brust/test ':!packages/brust/test/cf-*' ':!packages/brust/test/handlers.test.ts' ':!packages/brust/test/fetch-in-scope.test.ts' ':!packages/brust/test/fixtures/cf-*' ':!packages/brust/test/__snapshots__'` → empty.
- [ ] Task 11's `identical` line, and `git apply --check bench/attribution.patch` → exit 0.
- [ ] `git diff origin/m4cf -- packages/brust/src/worker.ts | head -20` shows lines 1-6 untouched.
- [ ] `git diff origin/m4cf --stat -- packages/brust/src/build/bundle.ts` → only `export` keywords.
- [ ] `bun test test/cf-build.test.ts`: the tree, alias and guard assertions; `cat <fixture dist>/cf/.stage/brust-app.entry.js | wc -l` ≤ 25.
- [ ] `bun test test/cf-wrangler.test.ts`: bindings preserved, owned keys overridden.
- [ ] `grep -rn "cloudflare\|wrangler" packages/brust/src --include=*.ts -l` → only `build/cf-*.ts`, `build/cloudflare.ts`, `build/config.ts`, `build/index.ts`, `cli.ts`, `dev.ts`. No CF-specific runtime module: H3 (handlers/server-handlers/actions-bridge stay host-agnostic).
- [ ] `git diff origin/m4cf --stat` ⊆ Boundary.
- [ ] `grep -rn "account_id" packages/brust/src packages/create-app/templates npm/core-cf docs/create-app.md` → only the merge code's comment/key handling in `build/cf-wrangler.ts`; nothing in templates or docs.
- [ ] Task 15: the note has the create + delete commands and a not-found after delete, or the explicit skip line.

## Gates
`bun install --frozen-lockfile`; `cd packages/brust && bun run build:debug && bun check && bun test`; `cd packages/create-app && bun run typecheck && bun test test/args.test.ts test/copy.test.ts test/dep.test.ts test/templates.test.ts test/cli.test.ts test/sync-template.test.ts test/pack.test.ts`; `cd examples/pokedex && bun test && bun run typecheck`; `bun test --timeout 120000 tests/server/pokedex.test.ts`; `bun test --timeout 120000 tests/server/hydrate.chromium.test.ts`; `bun run browser-test`; `bun run battery` + report diff; `bun run m2-exit && git diff --exit-code docs/plans/m2-exit-report.md`; `bun test scripts/m2-exit`; `bun test scripts/release-check.test.ts`; `git apply --check bench/attribution.patch`; `bun check -p bench && bun test bench/lib`. No Rust is touched, so the cargo gates are unaffected; run `cargo fmt --check` only as a sanity check. The scaffold test (`bun test --timeout 600000 test/scaffold.test.ts`) runs once at the end: it now downloads wrangler (R11).

## Risk ledger
- **Lane-3 contract drift** (glue name, `appModuleDir`, `invalidate` shape, `TEMPLATES` key). Detected by lane 3's fixture under `wrangler dev`, not here; this lane's smoke test stubs the glue. Mitigation: everything is read from `npm/core-cf/package.json` `brust`. Lane 3 changes that file through a challenge; the code here does not change.
- **attribution.patch context:** if `worker.ts:1-6` or the `makeDispatch` body moves, `git apply --check` goes red (Task 2 gate).
- **Snapshot under CI:** a missing `.snap` makes `bun test` fail in CI. The `.snap` is committed.
- **Bun `conditions` + `target:'browser'`** may pick a browser build of a dep where workerd has its own key. The `conditions` order puts `workerd` first, and react-dom is verified (`package.json:59`). Elysia under workerd is lane 3's R10 gate.
- **Smoke runs user top-level code** (routes, actions) at build time with `env = {}`. Code that touches bindings at import fails the build with `cf-smoke`; the message says to open bindings lazily (spec §5 row "App data").
- **`fs.watch` recursive** on Linux CI [I]: `cf-dev.test.ts` would time out at its 60 s poll. A fallback poll over mtimes is allowed only through a challenge.
- **`bun.lock`:** forgetting the non-frozen `bun install` after adding `npm/core-cf` makes every gate's `--frozen-lockfile` fail.
- **Asset headers parity:** a public tree with more than 97 files loses per-file immutable (warning). CORS is absent on assets (R7, documented by lane 8).
- **Real-deploy leak** (account rule): a crashed shell could skip the `trap`. After Task 15, `wrangler deployments list --name $N` must fail; if it does not, delete again and report it. Never deploy under a name without the `brust-test-` prefix.
- **`.wrangler` state** lives at the app root; a user running plain `wrangler dev -c dist/cf/…` without `--persist-to` gets separate state [I].

## Reporting
`conclave task note 838f12fb-70c1-41b7-acf2-d4065cf6bb64 m4cf-build-target READY @<sha> …`. The note must contain:
- the commit list and R1-R13 as implemented;
- the Task 11 `identical` line and the `cf-unsupported` line;
- `bun test` totals (before/after) and the Acceptance test-diff output (empty);
- the `.snap` file path;
- the fixture `brust-app.js` size;
- `tree -L 3` of the fixture `dist/cf`;
- the merged `wrangler.jsonc` of the fixture;
- the `brust` metadata block lane 3 must confirm;
- every gate with its result;
- Task 15: the create + delete commands with the name expanded (no URL, no account id) and the post-delete not-found, or the skip line;
- one line: "Bun path byte-identical; H3: no CF runtime module".

Escalate with `conclave task challenge 838f12fb-70c1-41b7-acf2-d4065cf6bb64 m4cf-build-target "<what, evidence>"` for any of these:
- lane 3's glue/export/`CONFIG` shape differs from the contract table;
- an existing assertion would have to change (other than `templates.test.ts:49-51`);
- `attribution.patch` needs more than the `worker.ts` hunk regeneration;
- Bun cannot bundle elysia/react for `workerd` conditions;
- `fs.watch` recursion fails on Linux;
- a file outside the Boundary.
