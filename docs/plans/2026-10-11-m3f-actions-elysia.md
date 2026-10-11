# m3f-actions-elysia: `@brust/core/elysia`, `@brust/core/client` on Eden Treaty, `[actions]`/`[cors]` → manifest → StartOptions, the actions bundle and its worker boot, docs/actions.md

**RULED by lead Detoro 2026-10-11 (before dispatch): R1-R10 ALL ACCEPTED as their defaults. R3 = Rust forwards path+query unchanged, the worker mounts the app under the prefix (relayed to the bridge lane; spec A1/E2 amended). R4 ownership as written; the lead merges the adjacent `native.ts` hunks by hand. Spec amended on v2/m3f (E2, E6, A1, A3, A5). Pins: elysia@2.0.0-beta.30, @elysia/eden@2.0.0-beta.6 exact.**

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: m3f (worktree ~/code/brust-m3f) · lane: m3f-actions-elysia · tier: standard · review: complex

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land spec `docs/design/2026-10-11-m3f-actions-elysia-create-app-design.md` §2.2 on `lane/m3f-actions-elysia`.
- `@brust/core/elysia` exports `brust()`: the web-standard adapter named `brust`, whose `listen` throws (E2).
- `@brust/core/client` exports `client<App>()`: a wrapper over Eden Treaty with the 0.1.x prefix resolution order (E6).
- `brust.toml` gets two sections. `[actions]` is read at build time into manifest `actions {entry, prefix, maxBodyBytes}` (A3). `[cors]` is read at start time. `run.ts` passes both to the napi `startServer`.
- `brust build` bundles the actions entry to `dist/actions.js` the way it bundles `jobs.js`. Browser bundles refuse it.
- At boot, the worker mounts the app under the prefix and hands it to the bridge lane's `setActionsApp`.
- `docs/actions.md`; tests.

Tasks 1–10 do not depend on the bridge lane: they use a stub transport (`app.fetch`, or a fake `fetch` given to the client). Task 11 runs only after `m3f-actions-bridge` has merged into `m3f`.

**Reading order:**
1. Spec: §0, §1 E1–E9, §2.2, §3 A1–A6.
2. `packages/brust/src/{config.ts, run.ts, worker.ts:56-72,290-336, native.ts:18-31}` and `src/build/{config.ts, index.ts:71-174, bundle.ts:91-137,299-366, manifest.ts:54-60,232-277}`.
3. `packages/brust/package.json:14-58` and `test/{config,build-manifest,build-safety,worker}.test.ts` (house style).
4. 0.1.x, read-only, at `~/code/brust`: `runtime/treaty.ts` (all; the prefix order is at `:86-93`), `runtime/treaty.test.ts`, `runtime/cors-options.test.ts`, `runtime/index.ts:28-60`, `example/docs/content/actions.md`.
5. The probe scripts: `/private/tmp/claude-501/-Users-detoro-code-brust/a8280810-2b60-4e66-a1d6-2739300c5cfe/scratchpad/elysia-probe/*.ts` (each Fact below names its script).

## Facts (probe 2026-10-11, Bun 1.4.3-canary.1+e555359cc, macOS arm64)

**Versions.**
- `npm view elysia dist-tags`: `next: '2.0.0-beta.30'` (published 2026-10-10T23:23Z; beta.24 to beta.30 came out between 10-07 and 10-10, about one a day). `latest: '1.4.30'`.
- The Eden package for 2.0 is **`@elysia/eden`**, not `@elysiajs/eden`. Its `next` tag is `2.0.0-beta.6`, with `peerDependencies { elysia: '>= 2.0.0-beta.2' }`. `@elysiajs/eden@next` is `1.0.0-beta.5`, which is stale.
- elysia@2.0.0-beta.30 has `dependencies { deuri, memoirist@1.2.3 }` and `peerDependencies { typebox >=1.3.0, @types/bun >=1.3.0, typescript >=5.7.0, exact-mirror >=1.2.6, openapi-types >=12 }`. `bun add` auto-installed typebox 1.3.36, exact-mirror 1.2.6 and openapi-types. The repo's `typescript@^7.0.2` satisfies the peer.

**Import paths** (verified against `node_modules/elysia/package.json` `exports`):
- `import { Elysia, t, problem, status, HTTPError, type AnyElysia } from 'elysia'`
- `import type { ElysiaAdapter } from 'elysia/adapter'`: `type ElysiaAdapter = ReturnType<typeof createAdapter>`, which is `ElysiaAdapterOptions<void>` (`dist/adapter/index.d.ts`).
- `import { WebStandardAdapter } from 'elysia/adapter/web-standard'`. It is NOT on the `elysia` root surface: `grep -c 'WebStandardAdapter\|ElysiaAdapter' dist/index.d.ts` prints `0`.
- `import { treaty, type Treaty } from '@elysia/eden/treaty2'`. `@elysia/eden` (root) also re-exports `treaty`.

**Adapter shape: the spec's §0 description is the Elysia 1.x shape.**
- beta.30 `ElysiaAdapterOptions` (`dist/adapter/types.d.ts`) is `{ listen?(app, options, cb), parse: {json,text,urlencoded,arrayBuffer,formData,default}, response: {map, supportsDefaultHeaderSink?, compact?}, setup?(app) }`.
- It has no `name`, `isWebStandard`, `beforeCompile`, `handler.*`, `composeHandler` or `composeGeneralHandler`. `grep -rn 'adapter\.name\|beforeCompile'` over `dist` finds no adapter use.
- `WebStandardAdapter` has NO `listen` (`dist/adapter/web-standard/index.mjs`). `Elysia#listen` (`dist/base.mjs:1602-1609`) throws `[Elysia] listen() requires an adapter on …` when the configured adapter has no `listen`. The spec's "throws export default Elysia.fetch instead" is not beta.30 behaviour.
- `new Elysia({ adapter })` stores the adapter in `this['~config']` and runs only `adapter.setup` (`base.mjs:190-193`). Compile and response mapping read `frozenRoot['~config'].adapter ?? defaultAdapter` (`compile/handler/index.mjs:155,376`, `handler/fetch.mjs:132`). `'~config'` is a typed public member (`base.d.ts:26`).
- What works (`adapter.ts`, `probe.ts`): `brust()` = `{ ...WebStandardAdapter, name: 'brust', listen() { throw … } }` typed `ElysiaAdapter & { readonly name: 'brust' }`. It typechecks, `new Elysia({ adapter: brust() })` typechecks, `app.listen(3000)` throws our exact message, and `app['~config'].adapter.name === 'brust'`.

**`app.fetch`** (`probe.ts`, `ss-probe.ts`):
- It exists, typed `get fetch(): (request: Request) => MaybePromise<Response>` (`base.d.ts:994`).
- **It can return a Response synchronously:** `app.fetch(req).then` is `undefined`. Callers must `await` it or wrap it in `Promise.resolve(…)`.
- 100 concurrent calls were all correct. It works inside a Bun `Worker` (`wmain.ts`).

**Elysia 2 route signature is `(path, hook, handler)`.** The 1.x order `(path, handler, hook)` throws at definition time: `[Elysia] .post('/team', handler, hook) is the 1.x order; Elysia 2 takes (path, hook, handler)` (`base.mjs:993`). Every example and fixture must use the 2.x order.

**Wire behaviour through `app.fetch`.** From `probe.ts`; NODE_ENV unset = development:

| case | status | content-type | body / headers |
|---|---|---|---|
| GET `/hello?name=ash` | 200 | `application/json;charset=utf-8` | `{"hi":"ash"}` |
| POST JSON valid (`t.Object`) + cookie | 200 | json | `set-cookie: sid=abc; Path=/; HttpOnly` |
| POST JSON invalid | 422 | `application/problem+json` | `{"type":"validation","code":"validation","title":"Validation Error","status":422,"detail":…,"on":"body",…,"errors":[…]}` |
| POST malformed JSON | 400 | problem+json | `{"type":"parse","code":"parse","status":400,"detail":"JSON Parse error: …","title":"Bad Request"}` |
| returned `problem(409, { title: 'Team full', detail: 'max 6' })` | 409 | problem+json | `{"type":"about:blank","title":"Team full","detail":"max 6","status":409}` |
| thrown `class TeamFull extends HTTPError.id('TEAM_FULL') { status = 409; detail() { return { max } } }` | 409 | problem+json | `{"type":"TEAM_FULL","code":"TEAM_FULL","detail":{"max":6},"status":409,"title":"Conflict"}` |
| `.onError(Legacy, ({ error }) => problem(418, { detail: error.why }))` | 418 | problem+json | `{"type":"about:blank","detail":"teapot","status":418,"title":"I'm a teapot"}` |
| two cookies set | 200 | **null** (string body) | `getSetCookie()` = `["a=1; Path=/","b=2; Path=/"]` |
| unknown path | 404 | problem+json | `{"type":"not-found","code":"not-found","status":404,"title":"Not Found"}` |
| **PUT on a GET-only path** | **404** (not 405) | problem+json | as above |
| HEAD / OPTIONS on a GET route | 404 / 404 | | no automatic HEAD |
| `throw new Error('secret internals')` | 500 | problem+json | dev: `"detail":"secret internals"`; with `NODE_ENV=production`: no detail |

- With `NODE_ENV=production`, the 422 body is `{"type":"validation","code":"validation","title":"Validation Error","status":422,"on":"body","property":"root"}`. `isProduction = (env.NODE_ENV ?? env.ENV) === 'production'` (`universal/is-production.mjs:5`). `run.ts:55` already sets `NODE_ENV ??= 'production'` for every worker.
- **There is no `.error()` method** (`typeof app.error === 'undefined'`). Errors are registered with `onError(Class, fn | value)` (`base.d.ts:323-344`), declared with `HTTPError.id(...)` subclasses (`error.d.ts:289`), or returned with `problem()`/`status()` (`error.d.ts:203-216`).
- Standard Schema works: a hand-written `{'~standard': {version: 1, validate}}` object as `body` gives 200, and 422 with `"detail":"n must be a number"` (`ss-probe.ts`).
- Body parsing: urlencoded parses to `{"a":"1","b":"2"}`; octet-stream to bytes.

**Prefix mounting works** (`mount-probe.ts`, `mount2.ts`, `twice.ts`):
- `new Elysia({ adapter: brust(), prefix: '/_brust/action' }).use(userApp)` answers:
  - `/_brust/action/hello` 200;
  - `/_brust/action` and `/_brust/action/` → the user's `/` route;
  - `/_brust/actionx` 404;
  - `/hello` (no prefix) 404.
- The user's `onError(Class)` and `HTTPError` still apply. `request.url` inside a handler keeps the prefix.
- The same user app mounts into two outer apps and stays usable directly.
- A user app built WITHOUT `adapter: brust()` also mounts. The root adapter governs compile.

**Eden Treaty 2 beta.6** (`client.ts`, `client-probe.ts`, `kd.ts`, `types-probe*.ts`):
- **Domain normalisation:** without `keepDomain`, a relative base is rewritten to `https:///_brust/action/hello`, which is broken. With `keepDomain: true` it stays `/_brust/action/hello`. A base with no scheme gets `http://` (local) or `https://`. So the wrapper always passes `keepDomain: true` and builds the base itself.
- **Typing:** `client<App>()` types against the app. `api.team.post({ id })` with `name` missing is a type error, and `api.nope` is a type error (both verified with `@ts-expect-error`, `bun check` clean).
- **Error typing:** errors **returned** with `problem(409, {...})`/`status(418, {...})` are typed: `r.error.status: 409 | 422` (422 is added by the body schema), and `r.error.value.max: number` after narrowing. Errors **thrown** (an `HTTPError` subclass, or a class registered with `onError(Class)`) are `unknown` on the client.
- **Differences from 0.1.x `runtime/treaty.ts`:** (a) A network failure resolves `status: 503`, `error.value` = the thrown error. 0.1.x: status `0`. (b) `response.headers`/`headers` is a `Headers` object. 0.1.x: `Record<string,string>`. (c) Params are `encodeURIComponent`-ed: `item({ id: 'a b/c' })` → `/item/a%20b%2Fc`, which Elysia decodes back to `a b/c`. 0.1.x used `String(v)`. (d) ISO date strings in JSON come back as `Date` by default; `parseDate: false` keeps strings. 0.1.x: always strings. (e) A GET carries `content-type: application/json`, so a cross-origin GET is preflighted. 0.1.x sent none. (f) Eden's `fetch` option is a `RequestInit` and its transport is `fetcher`. 0.1.x `fetch` was the transport. (g) `throwHttpError`, `onRequest`, `onResponse` and `.use(plugin)` are new. Unchanged: `headers` may be a function (Eden calls it with `(path, init)`) and is merged with per-call `headers`; a body with File/Blob goes multipart.
- Browser bundle of `client<App>()` with `import type { App }`: **10.3 KB** min, no elysia runtime. A **value** import of the actions module: **430 KB**. `import { t } from 'elysia'` alone: 270 KB (`be*.ts`).

**Bundling** (`bundle-probe.ts`): `Bun.build({ target: 'bun', external: ['elysia','elysia/*', …] })` keeps `import … from "elysia"` and `"elysia/adapter/web-standard"` external. The output imports and runs.

**brust today** (m3f @03fed3f):
- `loadConfig` parses `[server]` and `[workers]` (`config.ts:97-123`). `loadBuildConfig` parses `[build] server_only` (`build/config.ts:13-31`).
- `StartOptions` (`native.ts:18-30`; Rust `crates/brust-napi/src/server.rs:89-107`) has no `cors` and no `actions`. Rust `CorsConfig` fields are `origins, methods, headers, expose_headers, credentials, max_age_seconds` (`crates/brust-server/src/config.rs:39-55`), and `validate` messages are at `:66-79`.
- `Manifest` (`crates/brust-server/src/manifest.rs:12-19`) has no `deny_unknown_fields`, so an extra `actions` key is ignored until the bridge reads it.
- The manifest pin uses `toEqual` (`test/build-manifest.test.ts:41-44`); `BRUST_UPDATE_PIN=1` regenerates it.
- `JOBS_EXTERNALS` (`bundle.ts:310`); `workerStorePlugin` (`:316-321`); server-only regex `@brust/core/(server|native)` (`:103`).
- CI runs an explicit file list (`.github/workflows/ci.yml:120-126`).
- Baseline: `cd packages/brust && bun test test/routes.test.ts test/cache.test.ts test/worker.test.ts test/config.test.ts test/package-name.test.ts` → `35 pass, 0 fail, 154 expect()`. `bun run typecheck` → `No type errors in 162 files`.

**Elysia 2 beta risk:** nothing blocking broke. The fallback is to pin exactly `elysia@2.0.0-beta.30` + `@elysia/eden@2.0.0-beta.6` and never use `next` or ranges. If a later lane needs a newer beta, re-run the probe scripts first.

## Rulings requested from the lead before dispatch

Each has a default that the implementer follows unless the lead answers differently.
- **R1: errors API wording (spec E6 / §2.2 say `.error(MyError, …)`).** beta.30 has no `.error()`. Default: docs and tests use the beta.30 APIs: `problem()`/`status()` **returned**: typed on the client; `HTTPError.id(...)` subclasses **thrown**: problem+json, `unknown` on the client; `onError(Class, fn)`. Amend E6 to "errors via returned `problem()`/`status()` (typed by Eden) or thrown `HTTPError` (RFC 9457 on the wire)".
- **R2: adapter shape (E2).** `name` and `beforeCompile` are not part of `ElysiaAdapter` in beta.30. Default: `brust()` returns `{ ...WebStandardAdapter, name: 'brust', listen }` typed `ElysiaAdapter & { readonly name: 'brust' }`, with no `setup`. Elysia never reads `name`; brust reads it in `mountActions` to refuse an app not built on `brust()`. E2's "beforeCompile registering nothing" becomes "no `setup`".
- **R3: who strips the prefix (A1 `url`). This must be agreed with the bridge lane BEFORE it writes the `fetch` branch.**
  - Default: A1 `url` is the request path+query **unchanged**, prefix included. The worker's app is the user app mounted under the prefix by `mountActions` (`new Elysia({ adapter: brust(), prefix }).use(app)`; probe: every edge correct). Rust strips nothing, and handlers see the real `request.url`.
  - Alternative: Rust strips, as 0.1.x `crates/brust-core/src/server/mod.rs:855-862` did (`rel` = `/` when empty), and `mountActions` returns the app unmounted.
  - Either way, `setActionsApp` receives the app that answers A1's `url` as sent.
- **R4: file ownership between the two lanes.**
  - Bridge: `setActionsApp`, the `fetch` branch of `makeDispatch`, `WorkerFn`'s kind union (`native.ts:31`), the Rust `StartOptions`.
  - This lane: `native.ts` `StartOptions` TS fields `actions?: { prefix: string; maxBodyBytes: number }` and `cors?: { origins: string[]; methods?: string[]; headers?: string[]; exposeHeaders?: string[]; credentials: boolean; maxAgeSeconds?: number }`; `ManifestLike.actions` and the boot wiring in `startWorker`, both in Task 11, after the merge.
  - The bridge's Rust structs must serde-name to exactly these camelCase keys. napi-rs drops unknown or snake_case keys silently (0.1.x `runtime/index.ts:263`).
  - `native.ts:18-31` is adjacent to the bridge's `WorkerFn` edit, so the lead merges that one hunk by hand.
- **R5: `[cors]` is runtime config.** Default: `loadConfig` (`config.ts`) reads it at `brust start`, like `[server]`, and `run.ts` passes it as `StartOptions.cors`. It is **not** written to the manifest: changing origins per environment needs no rebuild. A3's "`cors` as in brust.toml" is read as the shape of the config.
- **R6: `[actions]` is opt-in.** Default: if the table is present, actions are on, with `entry` defaulting to `"actions.ts"`, `prefix` to `"/_brust/action"` and `max_body_bytes` to `262144`. With the table absent, `actions: null`, even if an `actions.ts` exists. The manifest always carries `actions` (`null` when off), so the pin gains one line.
- **R7: dependency model.** Default: `elysia: "2.0.0-beta.30"` and `@elysia/eden: "2.0.0-beta.6"` are exact **optional** `peerDependencies` of `@brust/core` (`peerDependenciesMeta.optional`), and exact `devDependencies` for the tests. An app without actions installs neither. The app and `@brust/core` must resolve one `elysia` copy (`instanceof`; risk 3).
- **R8: server-only guard extension.** Default: every browser build refuses three things, each with `server-only-in-client`:
  - `@brust/core/elysia`;
  - bare `elysia` / `elysia/*`;
  - the configured actions entry file, compared by real path.

  An `import type` is erased before resolution, so it passes. Measured cost of a value import: 270–430 KB.
- **R9: client semantics are Eden's (no 0.1.x shim).** Default: the differences (a)–(g) in Facts are documented in `docs/actions.md`, not papered over. The one 0.1.x-shaped choice: `client({ fetch })` is the transport (maps to Eden `fetcher`), and Eden's RequestInit `fetch` becomes `init`.
- **R10: CI.** Default: the new test files are appended to `.github/workflows/ci.yml:120`, `test/build-actions.test.ts` gets its own line after `:125`, and Task 11 adds `bun test --timeout 120000 test/e2e-actions.test.ts`. `ci.yml` is in the boundary for those lines only.

## Global constraints

**Lane:**
```
cd ~/code/brust-m3f && git pull --ff-only && git worktree add ../brust-lane-m3f-actions-elysia -b lane/m3f-actions-elysia m3f
cd ../brust-lane-m3f-actions-elysia && bun install --frozen-lockfile && (cd packages/brust && bun run build:debug)
```
Do NOT use `conclave lane start` (it branches from `main`). Line numbers are at m3f @03fed3f; if code moved, re-anchor on the quoted text and say so in the task note. Task 11 starts only after the lead posts "bridge merged into m3f", with `git merge --no-edit m3f`.

**TDD.** Every task writes its failing tests first, runs them, and pastes the red line into the task note before any implementation.

**Gates per task:** `cd packages/brust && bun run typecheck` → `No type errors`. The task's `bun test <files>` → all pass. The baseline 35 still pass.

Fixtures are typechecked (`tsconfig.json` includes `test`), with `noUncheckedIndexedAccess`. So destructured cookies need a `cookie: t.Cookie({...})` schema or `cookie.x!` (probe: TS18048 otherwise). There is no biome gate.

**Commits.** Never `git add -A`; stage by name. `git status --short` lists exactly the task's files. Messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. NO PR: post READY on the Conclave task, and the lead merges into `m3f`. No benches.

**Do not re-decide:** E1–E9 and A1–A6. In particular: default prefix `/_brust/action`; default `max_body_bytes = 262144`; A3 key `maxBodyBytes` (camelCase, unlike the manifest's snake_case keys; fixed); global name `__BRUST_ACTION_PREFIX__`; prefix order: opts.prefix → default when `baseUrl` → global → default. The Elysia 2 handler order is `(path, hook, handler)`.

## Boundary (exact)

- `packages/brust/package.json`: `exports` (`./elysia`, `./client`), `peerDependencies`, `peerDependenciesMeta`, `devDependencies`.
- `bun.lock`: only the lines `bun install` writes for those packages and their auto-installed peers.
- NEW `packages/brust/src/actions/{elysia,prefix,load,client}.ts`.
- `packages/brust/src/config.ts`: `BrustConfig.cors`, `CorsConfig`, `[cors]` parsing.
- `packages/brust/src/build/config.ts`: `BuildConfig.actions`, `[actions]` parsing.
- `packages/brust/src/build/bundle.ts`, these parts only:
  - `BrowserCtx.serverFiles`;
  - the `isServerOnly` additions;
  - NEW `buildActions` and `ACTIONS_EXTERNALS`.
- `packages/brust/src/build/manifest.ts`: `ActionsRecord`, `ManifestJson.actions`, the `writeManifest` `actions` option.
- `packages/brust/src/build/index.ts`: actions validation, the build call and the manifest field.
- `packages/brust/src/run.ts`: `startOptions()` extraction, manifest read, `cors`/`actions` passing.
- `packages/brust/src/native.ts`: `StartOptions` fields only (R4).
- `packages/brust/src/worker.ts`: **Task 11 only**, `ManifestLike.actions` and the `startWorker` boot lines.
- NEW tests:
  - `packages/brust/test/actions-{elysia,load,client}.test.ts`;
  - `packages/brust/test/{build-config-actions,config-cors,run-options,build-actions,e2e-actions}.test.ts`;
  - `packages/brust/test/fixtures/actions/app.ts`;
  - `packages/brust/test/fixtures/actions-app/{routes.tsx,Home.tsx,actions.ts,brust.toml}`.
- `packages/brust/test/fixtures/app.expected-manifest.json`: the `"actions": null` line only.
- NEW `docs/actions.md`.
- `.github/workflows/ci.yml`: the R10 lines only.

NOT touched: `crates/**`; `makeDispatch`, `setActionsApp`, `WorkerFn` (bridge); `examples/**` (pokedex lane); `packages/create-app` (create-app lane); `packages/runtime-dom/**`; every existing test assertion except the pin line.

## Tasks

### Task 1: dependencies and `@brust/core/elysia`

**Files:** `packages/brust/package.json`, `bun.lock`, NEW `src/actions/elysia.ts`, NEW `test/actions-elysia.test.ts`.

- [ ] **Step 1: Failing tests** (`test/actions-elysia.test.ts`; red = module not found):
  1. `brust() is the web-standard adapter named brust`:
     - `a.name === 'brust'`;
     - `a.parse === WebStandardAdapter.parse`, `a.response === WebStandardAdapter.response`;
     - `a.setup === undefined`.
  2. `app.listen() throws the brust message`: `expect(() => new Elysia({ adapter: brust() }).listen(3000)).toThrow('brust actions are served by the Rust server — remove app.listen()')`.
  3. `an app built on brust() answers through app.fetch (sync or async)`: `await Promise.resolve(app.fetch(new Request('http://l/x')))` → 200, `{ ok: true }`.
  4. `each call returns a fresh adapter object`: `brust() !== brust()`.
  5. `isBrustAdapter`: true for `brust()`; false for `WebStandardAdapter`, `undefined` and `{ name: 'other' }`.
- [ ] **Step 2: Implementation.**
  - In `package.json`:
    - `exports` gains `"./elysia": "./src/actions/elysia.ts"` after `"./store/react"`;
    - `peerDependencies` gains `"elysia": "2.0.0-beta.30", "@elysia/eden": "2.0.0-beta.6"`;
    - NEW `"peerDependenciesMeta": { "elysia": { "optional": true }, "@elysia/eden": { "optional": true } }`;
    - `devDependencies` gains the same two exact versions.
  - Run `bun install` at the lane root, then `git diff --stat bun.lock`.
  ```ts
  // `@brust/core/elysia` (M3-F E2, ruling R2): the adapter an actions app is built with. Rust owns
  // HTTP; the worker drives the app with `app.fetch(request)`. Elysia 2.0.0-beta.30's adapter is
  // `{ listen?, parse, response, setup? }` (elysia/adapter/types.d.ts); `name` is brust's own tag.
  import type { ElysiaAdapter } from 'elysia/adapter'
  import { WebStandardAdapter } from 'elysia/adapter/web-standard'

  export const LISTEN_ERROR = 'brust actions are served by the Rust server — remove app.listen()'
  export type BrustAdapter = ElysiaAdapter & { readonly name: 'brust' }

  export function brust(): BrustAdapter {
    return { ...WebStandardAdapter, name: 'brust', listen() { throw new Error(LISTEN_ERROR) } }
  }
  export function isBrustAdapter(a: unknown): a is BrustAdapter {
    return typeof a === 'object' && a !== null && (a as { name?: unknown }).name === 'brust'
  }
  ```
- [ ] **Step 3:** `bun test test/actions-elysia.test.ts test/package-name.test.ts` → pass; typecheck. Commit `feat(core): @brust/core/elysia — the brust() adapter over Elysia's web-standard adapter (M3-F E2)`.

### Task 2: `prefix.ts` + `load.ts`: validate, mount under the prefix, round trip through `app.fetch`

**Files:** NEW `src/actions/prefix.ts`, `src/actions/load.ts`, `test/fixtures/actions/app.ts`, `test/actions-load.test.ts`.

- [ ] **Step 1: Fixture `test/fixtures/actions/app.ts`.** Elysia 2 order, `noUncheckedIndexedAccess`-clean.
  ```ts
  import { Elysia, HTTPError, problem, t } from 'elysia'
  import { brust } from '../../../src/actions/elysia'
  export class TeamFull extends HTTPError.id('TEAM_FULL') {
    override readonly status = 409
    constructor(readonly max: number) { super('team is full') }
    detail() { return { max: this.max } }
  }
  const app = new Elysia({ adapter: brust() })
    .get('/', () => 'root')
    .get('/hello', { query: t.Object({ name: t.Optional(t.String()) }) }, ({ query }) => ({ hi: query.name ?? 'world' }))
    .post('/team', { body: t.Object({ id: t.String(), name: t.String() }), cookie: t.Cookie({ sid: t.Optional(t.String()) }) },
      ({ body, cookie: { sid } }) => body.id === 'full' ? problem(409, { title: 'Team full', max: 6 }) : ((sid.value = 'abc'), { team: [body], max: 6 }))
    .get('/thrown', () => { throw new TeamFull(6) })
    .get('/cookies', ({ cookie }) => { cookie.a!.value = '1'; cookie.b!.value = '2'; return { ok: true } })
    .get('/url', ({ request }) => ({ path: new URL(request.url).pathname }))
  export default app
  export type App = typeof app
  ```
  Re-check that `sid.value = …` typechecks with the `t.Cookie` schema (probe: yes). If it does not, use `cookie.sid!`.
- [ ] **Step 2: Failing tests** (`test/actions-load.test.ts`). `const m = mountActions(app, '/_brust/action')`, and `const call = (p, init?) => Promise.resolve(m.fetch(new Request('http://l' + p, init)))`. Assert only stable members: tests run with NODE_ENV=test, so dev diagnostics are present.
  1. `GET with a query answers JSON`: `/_brust/action/hello?name=ash` → 200, `{ hi: 'ash' }`.
  2. `POST JSON answers 200 and sets the cookie`: `getSetCookie()` contains `sid=abc; Path=/`.
  3. `invalid body → 422 application/problem+json`: `{ type: 'validation', status: 422 }` (`toMatchObject`).
  4. `returned problem() → 409 problem+json with extension members`: `toMatchObject({ type: 'about:blank', title: 'Team full', status: 409, max: 6 })`.
  5. `thrown HTTPError → 409 problem+json`: `{ type: 'TEAM_FULL', code: 'TEAM_FULL', detail: { max: 6 }, status: 409 }`.
  6. `two cookies survive as two Set-Cookie headers`: `getSetCookie().length === 2`.
  7. `prefix edges`:
     - `/_brust/action` and `/_brust/action/` → `'root'`;
     - `/_brust/actionx` → 404;
     - `/hello` → 404;
     - `/_brust/action/url` → `{ path: '/_brust/action/url' }` (R3: handlers see the real URL).
  8. `a wrong method under the prefix is Elysia's 404 problem` (pins Facts: no 405).
  9. `mountActions refuses`:
     - `undefined` → `/no default export/`;
     - `{}` → `/not an Elysia app/`;
     - `new Elysia()` (no brust adapter) → `/new Elysia\(\{ adapter: brust\(\) \}\)/`.
  10. `loadActionsApp imports the file and mounts its default export`: `loadActionsApp(join(import.meta.dir, 'fixtures/actions/app.ts'), '/p')` → `/p/hello` 200.
  11. `prefixError`:
      - `null` for `/_brust/action`, `/api`, `/v1/actions`, `/_brust/action/x`;
      - a message for `''`, `'api'`, `'/'`, `'/api/'`, `'//a'`, `'/a/../b'`, `'/a b'`, `'/_brust'`, `'/_brust/client'`.
- [ ] **Step 3: Implementation.**
  ```ts
  // src/actions/prefix.ts: browser-safe (the client imports it); no elysia import.
  export const DEFAULT_ACTION_PREFIX = '/_brust/action'
  export const DEFAULT_MAX_BODY_BYTES = 262_144
  const SEG = /^[A-Za-z0-9._~-]+$/
  /** Why `p` cannot be the actions prefix, or null. Segment-safe like the server's match. */
  export function prefixError(p: unknown): string | null {
    if (typeof p !== 'string' || !p.startsWith('/') || p.length < 2 || p.endsWith('/'))
      return `must start with '/', be longer than '/' and have no trailing '/' (got ${JSON.stringify(p)})`
    const segs = p.slice(1).split('/')
    if (segs.some((s) => !SEG.test(s) || s === '.' || s === '..'))
      return `segments must be [A-Za-z0-9._~-]+ and not '.'/'..' (got ${JSON.stringify(p)})`
    if (p === '/_brust' || (p.startsWith('/_brust/') && p !== DEFAULT_ACTION_PREFIX && !p.startsWith(`${DEFAULT_ACTION_PREFIX}/`)))
      return `${p} is reserved for the server's own /_brust/ paths`
    return null
  }
  ```
  ```ts
  // src/actions/load.ts: worker side (imports elysia at runtime).
  import { type AnyElysia, Elysia } from 'elysia'
  import { brust, isBrustAdapter } from './elysia'
  /** R3: the user's app mounted under `prefix`, so it answers A1's `url` (path+query, prefix included) as sent. */
  export function mountActions(app: unknown, prefix: string, what = 'actions entry'): AnyElysia {
    if (app === undefined) throw new Error(`${what}: no default export (export default new Elysia({ adapter: brust() }) …)`)
    if (!(app instanceof Elysia))
      throw new Error(`${what}: the default export is not an Elysia app (got ${typeof app}); if it is, two copies of elysia are installed (bun pm ls elysia)`)
    if (!isBrustAdapter(app['~config']?.adapter))
      throw new Error(`${what}: build the app with new Elysia({ adapter: brust() }) — import { brust } from '@brust/core/elysia'`)
    return new Elysia({ adapter: brust(), prefix }).use(app)
  }
  export async function loadActionsApp(file: string, prefix: string): Promise<AnyElysia> {
    return mountActions((await import(file)).default, prefix, file)
  }
  ```
- [ ] **Step 4:** `bun test test/actions-load.test.ts` → 11 pass; typecheck. Commit `feat(core): mount the actions app under its prefix; prefix rules (M3-F E1/E3, ruling R3)`.

### Task 3: `@brust/core/client`: Eden Treaty, 0.1.x prefix order

**Files:** NEW `src/actions/client.ts`, `test/actions-client.test.ts`; `package.json` (`exports["./client"]`).

- [ ] **Step 1: Failing tests** (`test/actions-client.test.ts`).
  - Setup: a stub transport `stub(calls)` records `String(input)` and `init`. It routes into `mountActions(fixtureApp, <prefix seen>)` by stripping the origin, so responses are real Elysia responses.
  - `afterEach` deletes `globalThis.__BRUST_ACTION_PREFIX__`.
  - Names port 0.1.x `runtime/treaty.test.ts` where they still apply:
    1. `prefix order 1: opts.prefix wins` (`{ prefix: '/api' }`, global set to `/g`) → `/api/hello`.
    2. `prefix order 2: baseUrl without prefix uses /_brust/action and never the global` → `https://api.example.com/_brust/action/hello`.
    3. `prefix order 3: no baseUrl, no prefix → globalThis.__BRUST_ACTION_PREFIX__` (`/custom-actions`) → `/custom-actions/hello`.
    4. `prefix order 4: nothing set → /_brust/action/hello (relative, keepDomain — never https:///…)`.
    5. `baseUrl + custom prefix composes` → `https://api.example.com/api/hello`.
    6. `baseUrl trailing slash is stripped; a path suffix composes` → `https://api.example.com/v2/_brust/action/hello`.
    7. `invalid baseUrl (non-http(s)) throws at client() time`: message `client baseUrl must be an absolute http(s) origin (got "ftp://x")`.
    8. `GET builds params + query`: `api.item({ id: 'a b' })` against a stub-only route → URL `/_brust/action/item/a%20b?x=1`, pinning (c).
    9. `typed round trip`: `api.team.post({ id: '1', name: 'a' })` → `data.max === 6`, `status 200`.
    10. `returned problem() is a typed error`: `post({ id: 'full', name: 'a' })` → `error.status === 409`, and `error.value.max === 6` after `if (r.error?.status === 409)`.
    11. `validation error → error.status 422, data null`.
    12. `network failure resolves (Eden: status 503, not 0.1.x 0)`.
    13. `fetch option is the transport; init carries RequestInit`: `client({ fetch: stub, init: { credentials: 'include' } })` → `calls[0].init.credentials === 'include'`.
    14. `headers may be a function evaluated per request, merged with per-call headers`.
  - Type assertions in the same file, checked by `bun run typecheck`:
    ```ts
    // @ts-expect-error name is required by the body schema
    void api.team.post({ id: '1' })
    // @ts-expect-error unknown route
    void api.nope
    ```
- [ ] **Step 2: Implementation** (probe prototype `elysia-probe/client.ts`, typechecked):
  ```ts
  // `@brust/core/client` (M3-F E6): Eden Treaty pre-wired to the brust actions mount. Browser-safe:
  // elysia is type-only here. Differences from 0.1.x runtime/treaty.ts: docs/actions.md "The client".
  import { type Treaty, treaty } from '@elysia/eden/treaty2'
  import type { AnyElysia } from 'elysia'
  import { DEFAULT_ACTION_PREFIX } from './prefix'
  export { DEFAULT_ACTION_PREFIX }
  export type { Treaty }

  export interface ClientOptions<Head extends Record<string, unknown> = {}> extends Omit<Treaty.Config<Head>, 'keepDomain' | 'fetcher' | 'fetch'> {
    /** Mount point of the actions app. Default: see resolvePrefix. */
    prefix?: string
    /** Absolute http(s) origin of ANOTHER brust deployment; the page's injected prefix is then ignored. */
    baseUrl?: string
    /** The transport (0.1.x name; Eden calls it `fetcher`). */
    fetch?: typeof fetch
    /** RequestInit defaults for every call (Eden's `fetch` option), e.g. `{ credentials: 'include' }`. */
    init?: Treaty.Config<Head>['fetch']
  }
  /** 0.1.x runtime/treaty.ts:86-93, verbatim order. */
  export function resolvePrefix(opts?: { prefix?: string; baseUrl?: string }): string {
    if (opts?.prefix) return opts.prefix
    if (opts?.baseUrl !== undefined) return DEFAULT_ACTION_PREFIX
    return (globalThis as { __BRUST_ACTION_PREFIX__?: string }).__BRUST_ACTION_PREFIX__ ?? DEFAULT_ACTION_PREFIX
  }
  /** 0.1.x runtime/treaty.ts:95-106; message names `client`. */
  export function resolveBaseUrl(opts?: { baseUrl?: string }): string {
    const b = opts?.baseUrl
    if (b === undefined) return ''
    if (!/^https?:\/\//.test(b)) throw new Error(`client baseUrl must be an absolute http(s) origin (got ${JSON.stringify(b)})`)
    return b.replace(/\/+$/, '')
  }
  export function client<const App extends AnyElysia, Head extends Record<string, unknown> = {}>(opts: ClientOptions<Head> = {}): Treaty.Instance<App, Head> {
    const { prefix: _p, baseUrl: _b, fetch: fetcher, init, ...rest } = opts
    // keepDomain: Eden would rewrite a relative base to `https:///…` (probe kd.ts).
    return treaty<App, Head>(resolveBaseUrl(opts) + resolvePrefix(opts), {
      ...rest, keepDomain: true, ...(fetcher ? { fetcher } : {}), ...(init ? { fetch: init } : {}),
    })
  }
  ```
  `exports` gains `"./client": "./src/actions/client.ts"` (no `browser` condition: the file is isomorphic).
- [ ] **Step 3:** `bun test test/actions-client.test.ts test/package-name.test.ts` → pass; typecheck (the two `@ts-expect-error` lines must be "used"). Commit `feat(core): @brust/core/client — Eden Treaty with the 0.1.x prefix order (M3-F E6)`.

### Task 4: `[actions]` in `brust.toml` (build config)

**Files:** `src/build/config.ts`, NEW `test/build-config-actions.test.ts`.

- [ ] **Step 1: Failing tests.** Write a temp-dir `brust.toml`, as in `test/config.test.ts:10-21`.
  1. `no [actions] table → actions null` (R6), even with an `actions.ts` present.
  2. `empty [actions] → defaults`: `{ entry: 'actions.ts', prefix: '/_brust/action', maxBodyBytes: 262144 }`.
  3. `explicit values`: `entry = "./server/api.ts"` → `'server/api.ts'` (the leading `./` is stripped, as `server_only` is at `:30`); `prefix = "/api"`; `max_body_bytes = 1024`.
  4. Each of these fails with `BuildError` rule `config` and the message `<file>: actions.entry must be a non-empty string`, `actions.prefix <prefixError>` or `actions.max_body_bytes must be an integer in 1..4294967295 (got …)`:
     - `[actions]` set to a non-table (`actions = 1`) → `[actions] must be a table`;
     - `entry = ""`;
     - `prefix = "/api/"`;
     - `prefix = "/_brust"`;
     - `max_body_bytes = 0`;
     - `max_body_bytes = 1.5`;
     - `max_body_bytes = 4294967296`.
  5. `[build] server_only still parses alongside [actions]`.
- [ ] **Step 2: Implementation.**
  - `export interface ActionsBuildConfig { entry: string; prefix: string; maxBodyBytes: number }`.
  - `BuildConfig` gains `actions: ActionsBuildConfig | null`.
  - Restructure `loadBuildConfig` so both tables parse from one `parsed` root. Every early `return { serverOnly: [] }` becomes `{ serverOnly: [], actions: null }`, else `[build]`-less files would drop `[actions]`.
  - Use `MAX_U32 = 0xffff_ffff`; the value crosses napi as `u32`, as `MAX_MS` does in `config.ts:42`.
- [ ] **Step 3:** tests pass; existing `test/build-safety.test.ts` `so-config` cases still pass (`bun test test/build-safety.test.ts`). Commit `feat(build): brust.toml [actions] — entry, prefix, max_body_bytes (M3-F E1, ruling R6)`.

### Task 5: `[cors]` in `brust.toml` (runtime config)

**Files:** `src/config.ts`, NEW `test/config-cors.test.ts`.

- [ ] **Step 1: Failing tests** (port of 0.1.x `runtime/cors-options.test.ts` + parsing):
  1. `no [cors] → cfg.cors undefined`.
  2. `full table maps snake_case → camelCase`: `origins`, `methods`, `headers`, `expose_headers` → `exposeHeaders`, `credentials`, `max_age_seconds` → `maxAgeSeconds`.
  3. `credentials defaults to false; absent optionals stay absent (no undefined-valued keys)`, so the napi object is minimal.
  4. `credentials + wildcard origin throws at boot`: also when the list only CONTAINS `"*"`. The message contains the Rust text `cors.credentials cannot be combined with a wildcard origin '*'` (`crates/brust-server/src/config.rs:72-77`).
  5. `empty origins throws "cors.origins must be non-empty"`.
  6. Shape errors: non-table, non-string-array `origins` or `methods`, non-boolean `credentials`, `max_age_seconds = -1`. Each is a `BrustConfigError` naming `<file>: cors.<key>`.
- [ ] **Step 2: Implementation.**
  ```ts
  export interface CorsConfig { origins: string[]; methods?: string[]; headers?: string[]; exposeHeaders?: string[]; credentials: boolean; maxAgeSeconds?: number }
  ```
  - `BrustConfig` gains `cors?: CorsConfig`.
  - Parse inside `fromTomlTable` (`config.ts:97-123`) with a local `strings(v, key)` helper.
  - `loadConfig` returns `cors: fromToml.cors` only when present: no env and no CLI layer (R5).
  - The two validation messages are the Rust ones verbatim, prefixed `${file}: `.
- [ ] **Step 3:** `bun test test/config-cors.test.ts test/config.test.ts` → pass (the existing config tests are unchanged). Commit `feat(config): brust.toml [cors] → BrustConfig.cors, validated like Rust CorsConfig (M3-F §2.1, ruling R5)`.

### Task 6: `buildActions` + the browser guard

**Files:** `src/build/bundle.ts`, NEW `test/build-actions.test.ts` (bundle-level part).

- [ ] **Step 1: Failing tests** (`test/build-actions.test.ts`; out dirs are `mkdtempSync(join(import.meta.dir, '.tmp-out-'))`, so externals resolve from the package, as in `build-safety.test.ts:19-24`):
  1. `buildActions writes dist/actions.js with elysia and @brust/core external`. The output text contains `from "elysia"` and `from "@brust/core/elysia"`, and contains no `class Elysia`. Use a temp entry that imports `{ brust } from '@brust/core/elysia'`.
  2. `the bundled module's default export mounts and answers`: `loadActionsApp(join(out, 'actions.js'), '/p')` → `/p/hello` 200.
  3. `a store imported by the actions entry stays the worker's @brust/core/store`: an entry importing `@brust/runtime-dom/store` gives output containing `from "@brust/core/store"` (`workerStorePlugin` applies).
  4. `a relative import of the entry is bundled`: `./lib.ts` is inlined (no `from "./lib`).
- [ ] **Step 2: Implementation.**
  ```ts
  /** dist/actions.js externals: the jobs set plus Elysia, so the app, `@brust/core/elysia` and the
   * worker's `mountActions` share ONE elysia (instanceof, HTTPError) — ruling R7. */
  const ACTIONS_EXTERNALS = [...JOBS_EXTERNALS, 'elysia', 'elysia/*', '@elysia/*']
  /** `dist/actions.js` (M3-F E1): the actions entry for the worker (`target: 'bun'`). No `define`: Elysia
   * and app code read NODE_ENV at runtime (run.ts sets production). */
  export async function buildActions(dist: string, entry: string): Promise<string> {
    const res = await Bun.build({ entrypoints: [entry], target: 'bun', format: 'esm', external: ACTIONS_EXTERNALS, plugins: [workerStorePlugin] })
    if (!res.success) throw new BuildError('bundle', `actions: ${res.logs.map(String).join('\n')}`)
    write(join(dist, 'actions.js'), await res.outputs[0]!.text())
    return 'actions.js'
  }
  ```
  Guard (R8). `BrowserCtx` gains `serverFiles?: string[]`: real paths, set by Task 7. In `isServerOnly`:
  - `:103` becomes `/^@brust\/core\/(server|native|elysia)(\/|$)/`;
  - add `if (spec === 'elysia' || spec.startsWith('elysia/')) return true`;
  - after `file` resolves (`:109`), add `if (ctx.serverFiles?.includes(realpathSync(file))) return true` (wrap `realpathSync` in try).

  Update the doc comment at `:91-97` to name the three additions.
- [ ] **Step 3:** `bun test test/build-actions.test.ts test/build-safety.test.ts` → pass. Commit `feat(build): dist/actions.js (elysia external) and the browser guard for actions code (M3-F E1, ruling R8)`.

### Task 7: manifest `actions` + `brust build` wiring

**Files:** `src/build/manifest.ts`, `src/build/index.ts`, `test/fixtures/app.expected-manifest.json`, `test/build-actions.test.ts` (build-level part).

- [ ] **Step 1: Failing tests** (append to `test/build-actions.test.ts`; throwaway apps as in `build-safety.test.ts:92-105`):
  5. `an app with [actions] gets manifest.actions and dist/actions.js`: `m.actions` equals `{ entry: 'actions.js', prefix: '/api', maxBodyBytes: 1024 }`, and the file exists.
  6. `an app without [actions] gets "actions": null and no actions.js`.
  7. `a missing entry file fails before anything is written`: `BuildError` rule `actions-entry`, message `actions.entry nope.ts is not a file inside the app`. The previous dist is untouched (pattern `build-safety` "previous dist").
  8. `a literal route under the prefix is refused`: a page at `/api/docs` with prefix `/api` → rule `actions-prefix`, message contains `lies under the actions prefix /api`. A root `*` catch-all is NOT refused.
  9. `a react island importing the actions module (value) fails with server-only-in-client`: the error contains `Island.tsx imports ../actions`.
  10. `a native component importing only the App TYPE plus client<App>() builds`, and its chunk contains no `class Elysia`.
  11. `a react island importing @brust/core/elysia or elysia fails with server-only-in-client`.
- [ ] **Step 2: Implementation.**
  - `manifest.ts`:
    - `export interface ActionsRecord { entry: string; prefix: string; maxBodyBytes: number }`;
    - `ManifestJson` gains `actions: ActionsRecord | null` after `jobs_module`;
    - `writeManifest` opts gain `actions?: ActionsRecord | null`, and the return becomes `{ …, jobs_module: 'jobs.js', actions: opts.actions ?? null }` (`:276`).
  - `build/index.ts`:
    - `const { serverOnly, actions } = await loadBuildConfig(appRoot)` (`:84`);
    - after `validateRoutes` (`:89-94`): check the entry (`isAbsolute`/`..`/not a file → `BuildError('actions-entry', …)`) and the shadow check (each leaf with `pattern !== '*'` and (`pattern === prefix` or `pattern.startsWith(prefix + '/')`) → `BuildError('actions-prefix', 'route <id> (<pattern>) lies under the actions prefix <prefix>: the actions app answers every path there')`);
    - add the entry to `assertSafeOutDir`'s keep list;
    - `buildInto` gets `actions` plus `actionsEntry` (absolute), and sets `ctx.serverFiles = actionsEntry ? [realpathSync(actionsEntry)] : []`;
    - after `buildJobs` (`:150`): `const actionsRec = actions ? { entry: await buildActions(out, actionsEntry), prefix: actions.prefix, maxBodyBytes: actions.maxBodyBytes } : null`;
    - pass `actions: actionsRec` to `writeManifest`. Its call moves below so the record exists; `storeModules(manifest)` only reads `components`, so compute the manifest after `buildActions`, or set `manifest.actions` before the write at `:151`. Pick the second: it is a one-line change.
  - Pin: `BRUST_UPDATE_PIN=1 bun test test/build-manifest.test.ts`. `git diff test/fixtures/app.expected-manifest.json` must show exactly `"jobs_module": "jobs.js"` → `"jobs_module": "jobs.js",` plus `"actions": null`. Then run once more without the env var.
- [ ] **Step 3:** `bun test test/build-actions.test.ts test/build-manifest.test.ts test/build-safety.test.ts test/build-store.test.ts test/cli.test.ts` → pass; `cargo test -p brust-server --test manifest` → pass (serde ignores the new key). Commit `feat(build): manifest actions {entry, prefix, maxBodyBytes} + route/prefix shadow check (M3-F A3)`.

### Task 8: `run.ts` → `StartOptions` (`actions`, `cors`)

**Files:** `src/run.ts`, `src/native.ts` (`StartOptions` only, R4), NEW `test/run-options.test.ts`.

- [ ] **Step 1: Failing tests** for a pure `startOptions(cfg, distDir, manifest, version)`:
  1. `no actions and no cors → exactly today's keys`: `Object.keys` equals `['host','port','distDir','workers','callTimeoutMs','workerThreads','generator']`, so apps without actions get a byte-identical napi call.
  2. `actions → { prefix, maxBodyBytes } (camelCase, no entry)`: napi drops snake_case silently (0.1.x `runtime/index.ts:263`).
  3. `cors → passed through with camelCase keys only`: `JSON.stringify` contains no `_`.
  4. `manifest.actions null → no actions key`.
- [ ] **Step 2: Implementation.**
  - `native.ts:18-30` gains the two R4 fields with doc comments.
  - `run.ts`:
    ```ts
    export interface RunManifest { actions?: { entry: string; prefix: string; maxBodyBytes: number } | null }
    export function startOptions(cfg: BrustConfig, distDir: string, m: RunManifest, version: string): StartOptions {
      return {
        host: cfg.host, port: cfg.port, distDir, workers: cfg.workers, callTimeoutMs: cfg.callTimeoutMs, workerThreads: cfg.ioThreads, generator: `brust/${version}`,
        ...(m.actions ? { actions: { prefix: m.actions.prefix, maxBodyBytes: m.actions.maxBodyBytes } } : {}),
        ...(cfg.cors ? { cors: cfg.cors } : {}),
      }
    }
    ```
  - `run()` reads `manifest.json` once after the existence check (`:35`): `JSON.parse` failure → `fail(\`bad manifest ${manifest}: …\`)`. `:48` becomes `startServer(startOptions(cfg, distDir, m, version))`.
  - Before the bridge merges, the addon ignores the two unknown fields (napi `FromNapiValue` reads only declared fields). The e2e suite proves it: run `bun test --timeout 120000 test/e2e.test.ts` → unchanged.
- [ ] **Step 3:** `bun test test/run-options.test.ts`, then `bun test --timeout 120000 test/e2e.test.ts` → pass. Commit `feat(core): run passes manifest actions and [cors] to startServer (M3-F A3)`.

### Task 9: `docs/actions.md`

**Files:** NEW `docs/actions.md`.

- [ ] Port of 0.1.x `example/docs/content/actions.md`, rewritten for Elysia 2. Plain markdown with no front-matter (`docs/` has none: `docs/react-coverage.md`). Sections:
  1. **What actions are.** One Elysia 2 app behind the Rust server: no `Bun.serve`, no second port. The flow diagram from spec §2.
  2. **Setup.** Pinned installs `bun add elysia@2.0.0-beta.30 @elysia/eden@2.0.0-beta.6`. The `brust.toml [actions]` keys with defaults. `actions.ts` with `export default app` + `export type App = typeof app`. `app.listen()` throws, by design.
  3. **Routes.** `.get/.post/.put/.patch/.delete`, `:param`; **Elysia 2 order `(path, hook, handler)`**, with the exact 1.x-order error text; cookies (`cookie: t.Cookie(...)`), headers, `set.status`.
  4. **Validation.** TypeBox `t` and any Standard Schema (Zod, Valibot, ArkType) as `body`/`query`/`params`. Failure is 422 `application/problem+json`, with diagnostics only outside production.
  5. **Errors** (R1).
     - Returned `problem(status, {...})`/`status(code, value)` are typed on the client.
     - Thrown `HTTPError.id('CODE')` subclasses (`status`, `detail()`, `value()`) and `onError(Class, fn)` are RFC 9457 on the wire and `unknown` on the client.
     - Unknown path → 404 problem. A wrong method under the prefix is **404** (Elysia has no 405). Outside the prefix, non-GET → 405 from Rust.
     - An unhandled throw → 500 without detail in production.
  6. **The client.** `client<App>(opts)`, with an options table: `prefix`, `baseUrl`, `fetch`, `init`, `headers`, `parseDate`, `throwHttpError`, `onRequest`, `onResponse`. Then a response-shape table and the **differences from 0.1.x** list (a)–(g) from Facts. On the server, pass `baseUrl`: a relative URL cannot be fetched there.
  7. **The prefix.** Default, configuration, the injected `<script>globalThis.__BRUST_ACTION_PREFIX__=…</script>` (A4: only when non-default, with the store tags), the 4-step resolution order, and the route shadow build error.
  8. **CORS.** The `[cors]` keys with defaults (methods `GET,POST,PUT,PATCH,DELETE,OPTIONS`; headers echo; max_age 600), the wildcard + credentials boot error, the cross-origin credentials client example (`init: { credentials: 'include' }`), the global-policy caveat, and that Eden's GET content-type triggers a preflight.
  9. **Limits.**
     - Request body ≤ `max_body_bytes` (413, else 415 for an unsupported transfer); buffered.
     - Response body ≤ one worker slot (256 KiB): larger → 500 `brust: action response exceeds <n> bytes` (**F82**).
     - No streaming, SSE or WebSocket (E9).
     - A string body has no `content-type` (Elysia 2).
     - Stores written in an action are per-request (E5).
     - Running the app without Rust: `export default app.fetch` yourself (E9).
  10. **Next.** The pokedex team example (after the pokedex lane).
- [ ] Every code block uses the 2.x order and typechecks. Copy each block into `test/fixtures/actions/` scratch, `bun run typecheck`, then delete it; paste "doc blocks typechecked: N" in the task note. Commit `docs: actions on Elysia 2 — routes, validation, problem details, client, prefix, CORS, limits (M3-F §2.2)`.

### Task 10: pre-merge gates, CI lines, READY (stage 1)

- [ ] `.github/workflows/ci.yml:120`: append `test/actions-elysia.test.ts test/actions-load.test.ts test/actions-client.test.ts test/build-config-actions.test.ts test/config-cors.test.ts test/run-options.test.ts`. After `:125`, add `- run: cd packages/brust && bun test test/build-actions.test.ts` (R10).
- [ ] Gates, pasted:
  - `cd packages/brust && bun run typecheck`.
  - The `ci.yml:120` line verbatim.
  - `bun test test/napi-server.test.ts`, `test/build-manifest.test.ts`, `test/cli.test.ts`, `test/build-actions.test.ts`, `test/build-store.test.ts`.
  - `bun test --timeout 120000 test/e2e.test.ts`, then `test/e2e-store.test.ts` (run separately: port-race flake).
  - `cd examples/pokedex && bun test && bun run typecheck`.
  - `bun install --frozen-lockfile` at the lane root → no change.
  - `git diff --name-only m3f` ⊆ Boundary.
- [ ] Post `READY (stage 1, stub transport)`. Then WAIT for the lead's "bridge merged into m3f" before Task 11.

### Task 11 (after `m3f-actions-bridge` is in `m3f`): worker boot + integration through Rust

**Files:** `src/worker.ts` (`ManifestLike.actions`, `startWorker`), NEW `test/fixtures/actions-app/*`, NEW `test/e2e-actions.test.ts`, `ci.yml` (one line).

- [ ] **Step 0:** `git merge --no-edit m3f`. Confirm the bridge's exports: `grep -n "export function setActionsApp\|'fetch'" packages/brust/src/worker.ts packages/brust/src/native.ts`. Re-anchor if the names differ; a different name goes in the task note, not a rename.
- [ ] **Step 1: Failing tests.**
  - Fixture `test/fixtures/actions-app/`:
    - `routes.tsx` with `/` → `Home.tsx` (a static page);
    - `actions.ts` = the Task 2 app plus `GET /big` (returns 300 KiB of `'x'`);
    - `brust.toml`:
      ```toml
      [actions]
      prefix = "/api"
      max_body_bytes = 1024
      [cors]
      origins = ["https://app.example"]
      credentials = true
      expose_headers = ["x-total"]
      ```
  - `test/e2e-actions.test.ts` boots `brust build` + `brust start --port 0 --workers 2` exactly as in `e2e.test.ts:17-41`. Tests:
    1. `GET /api/hello?name=ash → 200 {hi:"ash"} through Rust`.
    2. `POST /api/team JSON → 200 and both Set-Cookie headers on /api/cookies` (`res.headers.getSetCookie().length === 2`; A2 pairs).
    3. `invalid body → 422 application/problem+json` (production body: no `errors` member, because NODE_ENV=production from run.ts).
    4. `returned problem() → 409; thrown HTTPError → 409 type TEAM_FULL`.
    5. `unknown path under the prefix → Elysia's 404 problem, not the page 404`.
    6. `body over max_body_bytes → 413 before the worker` (`/_brust/cache/stats` `worker_calls` unchanged).
    7. `response over the slot → 500 "brust: action response exceeds"` (F82; `/api/big`).
    8. `preflight from https://app.example → 204 with Access-Control-Allow-Origin + Allow-Credentials; actual response carries them and Expose-Headers`.
    9. `the page carries <script>globalThis.__BRUST_ACTION_PREFIX__="/api"</script>` (A4).
    10. `client<App>({ baseUrl: base, prefix: '/api' }) round trip with real fetch: typed data and typed 409`.
    11. `POST / (outside the prefix) still 405` (GET/HEAD gate unchanged).
    12. `startWorker fails boot with the mountActions message when the entry has no default export`. This is a worker-level test with `setNative(fake)`, as in `worker.test.ts:205-230`, on a tiny dist whose manifest has `actions`.
- [ ] **Step 2: Implementation.**
  - `ManifestLike` gains `actions?: { entry: string; prefix: string; maxBodyBytes: number } | null`.
  - In `startWorker`, after the jobs import (`:320-321`): `if (manifest.actions) setActionsApp(await loadActionsApp(join(dist, manifest.actions.entry), manifest.actions.prefix))`.
  - A throw propagates. `run.ts:92-97` already turns a worker boot error into a loud shutdown.
  - `ci.yml`: add `- run: cd packages/brust && bun test --timeout 120000 test/e2e-actions.test.ts` after `:126`.
- [ ] **Step 3: Gates:**
  - the Task 10 list again;
  - `bun test --timeout 120000 test/e2e-actions.test.ts`;
  - `cargo test -p brust-server --test actions` (the bridge's suite, to show that nothing on this side broke it).

  Commit `feat(core): worker boots the actions app from the manifest; e2e through Rust (M3-F E1/E5)`. Post READY (template).

## Test map (spec §2.2 → files)

| spec item | file | task |
|---|---|---|
| adapter unit (listen throws, name) | `test/actions-elysia.test.ts` (5) | 1 |
| tiny Elysia app round trip: GET, POST JSON, 422, problem+json, cookies | `test/actions-load.test.ts` (11), via `app.fetch` | 2 |
| same, through Rust + the bridge's `fetch` kind | `test/e2e-actions.test.ts` (12) | 11 |
| client URL building, four prefix cases (+ 0.1.x `treaty.test.ts` ports) | `test/actions-client.test.ts` (14 + 2 type assertions) | 3 |
| brust.toml parsing | `test/build-config-actions.test.ts` (5), `test/config-cors.test.ts` (6) | 4, 5 |
| bundle + guard + manifest | `test/build-actions.test.ts` (11), pin line | 6, 7 |
| StartOptions | `test/run-options.test.ts` (4) | 8 |

## Review Focus

1. **The adapter is beta.30's, not 1.x's (R2).** `brust()` spreads `WebStandardAdapter` from `elysia/adapter/web-standard` and adds only `name` + `listen`; no `setup`. The type is `ElysiaAdapter & { readonly name: 'brust' }`. Nothing in the lane imports from `elysia/dist/*` or relies on an untyped internal except the typed `'~config'` (`base.d.ts:26`).
2. **Prefix contract (R3).** `mountActions` mounts under the manifest prefix; test 7 pins that handlers see the full URL. The bridge's `fetch` branch must not also strip. Check the merged `makeDispatch` in Task 11. `prefixError` is segment-safe and refuses `/_brust` and other `/_brust/*` paths. The build refuses literal routes under the prefix.
3. **Client = Eden, honestly.** `keepDomain: true` is always passed (otherwise a relative base becomes `https:///…`). The prefix order is 0.1.x `treaty.ts:86-93` verbatim. `fetch` → `fetcher`, and `init` → Eden `fetch`. The differences (a)–(g) are documented, not shimmed. The client module imports elysia type-only, and the browser test (Task 7 #10) proves there is no Elysia runtime in a chunk.
4. **One elysia copy.** `elysia`, `elysia/*` and `@elysia/*` are external in `actions.js`; peers are exact and optional. `mountActions` uses `instanceof Elysia` with a message that names the two-copies cause. `bun.lock` changes only for these packages and their auto-installed peers (typebox, exact-mirror, openapi-types, deuri, memoirist).
5. **Apps without actions are unchanged.** `startOptions` emits exactly today's keys (Task 8 #1). The manifest differs only by `"actions": null`. `e2e.test.ts`/`e2e-store.test.ts` are green with no edit. `worker.ts` is untouched before Task 11.
6. **Config errors are loud and placed right.** `[actions]` is parsed at build time, `[cors]` at start time (R5). The CORS messages equal Rust's. Every numeric value crossing napi is bounded to u32.

## Risk ledger

| # | Risk | Mitigation |
|---|---|---|
| 1 | Elysia/Eden betas move daily; a newer beta changes the adapter or the route signature | Exact pins (R7), no `next`/ranges; Facts record beta.30/beta.6; the probe scripts are re-runnable before any bump |
| 2 | The bridge strips the prefix too, so every action 404s | R3 ruled before either lane writes it; Task 11 Step 0 reads the merged `fetch` branch; e2e test 1 fails loudly |
| 3 | Two elysia copies (app vs `@brust/core` peer resolution) fail `instanceof` or break `.use()` | `elysia` external in `actions.js`; optional exact peer; the error message names `bun pm ls elysia`; the create-app lane's tarball test exercises a real install |
| 4 | `app.fetch` returns a sync Response and the bridge calls `.then` on it | Facts + a READY note for the bridge: `await` it or wrap it in `Promise.resolve` |
| 5 | The bridge serialises headers with `headers.forEach`/`entries` and merges two `Set-Cookie`s | A2 pairs; READY note: use `getSetCookie()` for `set-cookie`; e2e test 2 |
| 6 | A string body has no content-type (Elysia 2), so browsers sniff | Documented in Limits; noted for the bridge (Rust must not invent one) |
| 7 | Dev-mode problem bodies leak internals | `run.ts:55` sets NODE_ENV=production for workers; e2e test 3 asserts the production shape |
| 8 | napi drops misnamed StartOptions keys silently | camelCase pinned by `test/run-options.test.ts`; R4 names the Rust serde names |
| 9 | `native.ts` and `worker.ts` hunks adjacent to the bridge's | R4 split; `worker.ts` edits only in Task 11, after the merge; the lead hand-merges the one `native.ts` hunk |
| 10 | The pin regenerated with unrelated drift | Task 7: the diff must be exactly the `actions` line |

## Dispatch table

Lane tier: standard (one implementer; tasks are sequential in one worktree) · review: complex (Review Focus 1–6). Tasks 1–10 can run in parallel with the bridge lane. Task 11 is gated on the lead's "bridge merged".

| slug-task | tier | role | deps | acceptance (gate commands + READY evidence) |
|---|---|---|---|---|
| `m3f-actions-elysia-1` deps + adapter | standard | implementer | lane created; R1, R2, R7 answered | red pasted; `bun test test/actions-elysia.test.ts test/package-name.test.ts` pass; typecheck; `git diff --stat bun.lock` only elysia/eden + peers; commit |
| `m3f-actions-elysia-2` prefix + mount | standard | implementer | 1; R3 agreed with bridge | 11 load tests pass (GET, POST, 422, problem, HTTPError, 2 cookies, edges, refusals); commit |
| `m3f-actions-elysia-3` client | standard | implementer | 2; R9 | 14 client tests + 2 `@ts-expect-error` used; typecheck; commit |
| `m3f-actions-elysia-4` [actions] | standard | implementer | 2; R6 | 5 tests pass; build-safety green; commit |
| `m3f-actions-elysia-5` [cors] | standard | implementer | 1; R5 | 6 tests pass; config.test green; Rust message text equal; commit |
| `m3f-actions-elysia-6` bundle + guard | standard | implementer | 4; R8 | 4 bundle tests; build-safety green; commit |
| `m3f-actions-elysia-7` manifest + build | standard | implementer | 6 | 7 build tests; pin diff = one line; `cargo test -p brust-server --test manifest` green; commit |
| `m3f-actions-elysia-8` StartOptions | standard | implementer | 5, 7; R4 | 4 tests; e2e.test unchanged green; commit |
| `m3f-actions-elysia-9` docs | standard | implementer | 3, 8 | every block typechecked (count pasted); commit |
| `m3f-actions-elysia-10` gates stage 1 | standard | implementer | 9; R10 | Task 10 list pasted; READY stage 1 |
| `m3f-actions-elysia-11` boot + e2e | standard | implementer | 10 + **bridge merged into m3f** | `git merge m3f` clean; 12 e2e tests; all Task 10 gates again; READY |

## READY note template

```
READY lane/m3f-actions-elysia @ <sha> (base m3f @ <sha>; stage <1 stub | 2 integrated>)
rulings: R1 <…> · R2 <…> · R3 <mount|rust-strips> · R4 <…> · R5 runtime cors · R6 opt-in · R7 exact optional peers · R8 guard · R9 Eden semantics · R10 ci lines
versions: elysia 2.0.0-beta.30 · @elysia/eden 2.0.0-beta.6 · bun.lock: <+N packages: …>
tests: actions-elysia 5 · actions-load 11 · actions-client 14 (+2 type) · build-config-actions 5 · config-cors 6 · build-actions 11 · run-options 4 · e2e-actions <12|n/a stage 1>
gates: typecheck <files> clean · ci.yml:120 line <pass> · napi-server/build-manifest/cli/build-store <pass> · e2e <pass> · e2e-store <pass> · pokedex <pass> · frozen-lockfile clean · boundary diff clean · pin diff = "actions": null only
for the bridge: app.fetch may return a Response synchronously (await/Promise.resolve) · set-cookie via headers.getSetCookie() into A2 pairs · string bodies carry no content-type · setActionsApp receives the app mounted under the prefix (R3): forward url unchanged
for pokedex/create-app lanes: Elysia 2 order (path, hook, handler) · returned problem() is typed on the client, thrown HTTPError is not · cookie destructuring needs t.Cookie or ! under noUncheckedIndexedAccess · brust.toml [actions] is opt-in
deviations from spec text (ruled): no .error() in beta.30 (R1) · adapter has no name/beforeCompile in its type (R2) · Elysia answers 404 (not 405) for a wrong method under the prefix
```
