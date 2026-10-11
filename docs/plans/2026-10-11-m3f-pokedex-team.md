# m3f-pokedex-team: the pokedex team for real (bun:sqlite + Elysia actions + the unified `team` store), the `/unified` demo, `docs/store.md`, e2e + Chromium + bench sanity

**RULED by lead Detoro 2026-10-11 (before dispatch): R1-R10 ALL ACCEPTED as their defaults (spec E7 amended on v2/m3f). R9 is the rule of the lane: a defect in the merged store/actions code is a task challenge with the failing probe, never a patch here. Dispatch only AFTER m3f-actions-bridge and m3f-actions-elysia are merged into m3f; Task 1 (merge origin/m3f + re-verify anchors) is mandatory.**

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: m3f after m3f-actions-bridge + m3f-actions-elysia merge · lane: m3f-pokedex-team · tier: standard · review: complex

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land spec `docs/design/2026-10-11-m3f-actions-elysia-create-app-design.md` §2.3 (E7) plus the absorbed dogfood of `docs/design/2026-10-11-m3f-unified-store-design.md` (D10 and §5 acceptance items 3–6) on `lane/m3f-pokedex-team`. After this lane:
- **Persistence.** `examples/pokedex/lib/team-db.ts` keeps the team in `bun:sqlite` at `data/team.sqlite`. `MAX_TEAM` is 6. An add is idempotent. Every worker shares the file, and the team survives a restart.
- **Actions.** `examples/pokedex/actions.ts` is an Elysia 2 app on `brust()`. It serves `GET /team`, `POST /team` (TypeBox body; `TeamFull` → 409 problem) and `DELETE /team/:id`, each returning `{ team, max }`. `brust.toml` gets `[actions]`.
- **One store, three surfaces.**
  - `stores/team.ts` = `defineStore('team', …)`.
  - `AddToTeamButton.tsx` is NATIVE. It reads `useStore(team)` at render time and its click calls the actions client.
  - `TeamBuilder.tsx` is an SSR island. It reads `useStore(team)` and deletes through the client.
  - A layout loader seeds `team` from the DB, so the first paint is right in both.
- **Demo.** A `/unified` page carries an island counter, a native counter and a native read-only node on the store `unified`, with the first paint seeded.
- **Docs and tests.** `docs/store.md`; `tests/server/{pokedex,hydrate.chromium}.test.ts` additions; `examples/pokedex/test/*` additions.
- **Bench.** A 3-round interleaved S/D/I sanity against `bench/RESULTS.md` @04794ae.

**Reading order:**
1. Design E1–E9, §2.3, A1–A6 (`docs/design/2026-10-11-m3f-actions-elysia-create-app-design.md:13-86`). Store design D1–D10, C1–C8, §4, §5 (`docs/design/2026-10-11-m3f-unified-store-design.md:106-197`).
2. The wave-2 plans: `docs/plans/2026-10-11-m3f-actions-elysia.md`, which covers Facts (Elysia 2 beta.30 behaviour, `:26-103`), R1–R10 and READY lines `:649-651`; and `docs/plans/2026-10-11-m3f-actions-bridge.md`, which covers "Interfaces" (`:146-166`) and R1–R12 (`:72-101`).
3. The store plans: `docs/plans/2026-10-11-m3f-store-compiler.md` Tasks 3–6 (`:252-404`: render-read rules, precompute inputs, fallbacks) and `docs/plans/2026-10-11-m3f-store-server.md` risk ledger L5/L6 (`:615-616`).
4. The code: `examples/pokedex/**`, `tests/server/*`, `packages/brust/test/fixtures/store-app/**`, `packages/brust/src/worker.ts:130-256`, `scripts/m2-exit/{exit.ts,exit.test.ts}`.
5. 0.1.x, read-only, at `~/code/brust` (main): `example/pokedex/{actions.ts,lib/team-store.ts,stores/team.ts,components/AddToTeamButton.tsx,components/TeamBuilder.tsx}`, `example/docs/{lib/unified-store.ts,components/Unified{Island,Native,StoreNode}.tsx}`, `example/docs/content/store.md`.

## Facts (m3f @ e2538c1, store waves merged @03fed3f; wave-2 code NOT yet merged when this was written)

**Wave-2 interfaces this lane consumes.** They come from the two plans; Task 1 re-verifies each one on the merged tree.
- `import { brust } from '@brust/core/elysia'` gives `{ ...WebStandardAdapter, name: 'brust', listen() { throw } }` (elysia plan Task 1, `:199-215`).
- `import { client } from '@brust/core/client'`, `client<App>(opts?)` = Eden `treaty<App>(baseUrl + prefix, { keepDomain: true, … })`. The prefix order is opts.prefix → `/_brust/action` when `baseUrl` is set → `globalThis.__BRUST_ACTION_PREFIX__` → `/_brust/action` (elysia plan `:350-369`).
- Pins: `elysia@2.0.0-beta.30` and `@elysia/eden@2.0.0-beta.6`, exact and optional peers of `@brust/core` (R7). The APP must install both.
- `brust.toml [actions]` is opt-in. An empty table gives `{ entry: 'actions.ts', prefix: '/_brust/action', maxBodyBytes: 262144 }`, and the manifest records `actions` (`null` when off) (R6, `:379-389`).
- The build writes `dist/actions.js` with `elysia` and `@brust/core*` external (`:430-440`). A browser build refuses `elysia`, `@brust/core/elysia` and the actions entry by real path. An `import type` passes (R8).
- The worker mounts `new Elysia({ adapter: brust(), prefix }).use(app)` and hands it to `setActionsApp`. Rust forwards path+query unchanged (R3), and the fetch runs in `runInStoreContext` (bridge R1). Stores written in an action are per-request and are not snapshotted (E5).
- Elysia 2 route order is `(path, hook, handler)`; the 1.x order throws at definition (`:51`).
  - A RETURNED `problem(409, {...})` is typed on the client: `r.error.status`, plus `r.error.value.<ext>` after narrowing.
  - A THROWN `HTTPError` is `unknown` on the client (`:88`).
  - A wrong method under the prefix gives Elysia's 404, not 405 (`:66`).
  - `NODE_ENV=production` in workers (`packages/brust/src/run.ts:55`), so 422 bodies carry no `errors` (`:70`).
- Eden on `/team/:id` is called as `api.team({ id }).delete()`. Params are `encodeURIComponent`-ed (`:89` (c)).

**The pokedex today.**
- Routes are at `examples/pokedex/routes.tsx:11-24`.
  - `/pokemon/{name}` has `cache: { ttl_seconds: 60, tags: ['pokemon'], bypass: 'query(nocache)' }` (`:18`).
  - `/type-chart` has `cache: { ttl_seconds: 3600, tags: ['types'] }` (`:19`).
  - The `*` catch-all sits outside the layout (`:23`).
- The team is a constant. `lib/loaders.ts:7-11` holds `TEAM_SEED` (bulbasaur, charmander), and `chrome()` returns `teamInitial: TEAM_SEED` (`:16-21`), which every leaf loader spreads.
- `ChromeData.teamInitial` is at `lib/types.ts:29`. `AppLayout` passes `teamInitial` to `<TeamBuilder/>` (`components/AppLayout.tsx:8,28`). `TeamBuilder` is react-tier on purpose (`useReducer`), with local roster state (`components/TeamBuilder.tsx:1-32`).
- `TeamMember.id` is a `number` (`lib/types.ts:6-13`). `lib/pokeapi.ts:9` has a private `byId` map over the offline snapshot, and there is no exported by-id lookup.
- `brust.toml` has only `[server]`. `package.json` deps are `@brust/core` (workspace), `react` and `react-dom`. `tsconfig.json` sets `verbatimModuleSyntax` and `noUncheckedIndexedAccess`.
- `public/app.css` is GENERATED by Tailwind CLI v4 (`@source "../**/*.{tsx,ts}"`, header comment). The README records the command. Never hand-edit it.
- There is no `.gitignore` under `examples/pokedex`. The root `.gitignore` has `dist/`, `node_modules`, `*.node`.

**Pinned snapshots of the pokedex (the "snapshot tests"; each is updated ONLY where the team UI changes):**
- (a) `examples/pokedex/test/build.test.ts:9-30` pins:
  - the 5 route patterns (`:14`);
  - the detail cache `{ttl_seconds:60,prefix:null,bypass:'query(nocache)',tags:['pokemon']}` (`:16`);
  - detailPage tier `static` (`:19`);
  - an ssr job targeting `teamBuilder_*` on appLayout (`:23`);
  - teamBuilder `react` with its client chunk (`:25-26`);
  - notFoundPage static (`:28`).
- (b) `scripts/m2-exit/exit.test.ts:9-19`: the committed `docs/plans/m2-exit-report.md` must equal a fresh render over a fresh `brust build` of the pokedex, and the manifest routes must equal `ROUTES` (`scripts/m2-exit/exit.ts:12-19`) with their leaf tiers. The Integration prose literally says "`job.misses` = 1" (`exit.ts:51`). CI runs `bun run m2-exit && git diff --exit-code docs/plans/m2-exit-report.md` (`.github/workflows/ci.yml:139-140`).
- (c) `tests/server/pokedex.test.ts`:
  - `:30` island regex with `x-props='…'`;
  - `:31` `team-count >2<`;
  - `:64-65` `job.hits ≥ 2`, `job.misses = 1` on `/pokemon/pikachu` after `/`.

  `tests/server/hydrate.chromium.test.ts:26-28` expects the panel `['Bulbasaur','Charmander']`, and `1` after Remove.
- NOT touched:
  - `examples/pokedex/test/snapshot.test.ts` is the DATASET snapshot (151 Pokémon), so it is unchanged.
  - `crates/brust-server/benches/fixtures/pokedex/**` is a FROZEN golden (`pipeline.rs:2504-2536`, `pokedex_plans_match_the_golden`). It is not derived from the live example. Never regenerate it.

**Probe evidence (`brustc` @ m3f 03fed3f, `target/debug/brustc`; sources in `/private/tmp/claude-501/-Users-detoro-code-brust/a8280810-2b60-4e66-a1d6-2739300c5cfe/scratchpad/probe-team/`):**
- AddToTeamButton (the Task 5 code below) is tier **Native**, with no diagnostics and ONE precompute job with `inputs ["__store.team.members","id"]` (`inTeam = s.members.some(m => m.id === id)`).
  - `full = !inTeam && s.members.length >= s.max` paints in the template as `(__store.team.members | length) >= __store.team.max`.
  - The chunk imports `../stores/team` and `../lib/team-client` and has `computed(() => team.members().some(...))`. The async handler with `useState` busy stays native.
- As a child inside `DetailPage`'s `notFound ? … : …` else-branch, DetailPage stays **Static**. The child is inlined with `x-props='{{ {"id": id} | json_attr }}'`.
- TeamBuilder with `useStore(team)` + `useReducer` is **React**. Its ssr job inputs are `["*","__store"]`. The AppLayout island job is `inputs ["__store"]`, `props {"__store":"__store"}`, and AppLayout stays Static.
- `/unified`: UnifiedNative (render read + handler write) is **Native** with 0 jobs. UnifiedStoreNode (read only) is **Native** with 0 jobs. UnifiedIsland (`useStore` + `useReducer`) is **React** with an ssr job. UnifiedPage is **Static**.

**Server behaviour this lane relies on (merged wave 1):**
- The worker runs the whole loader chain, layout first, in ONE call inside `runInStoreContext`. Before the chain it touches the route's manifest store union (`packages/brust/src/worker.ts:224-256`). The union walks `children[].id` and `jobs[].target` transitively (`:130-151`), so every layout page touches `stores/team.ts` through the TeamBuilder child.
- `loader_calls` counts calls, not loaders (`crates/brust-server/src/pipeline.rs:371-372`). A layout loader adds no Bun call.
- A notFound verdict carries the snapshot (`worker.ts:240-242`).
- ssr jobs run in a scope seeded from `inputs.__store`, which is stripped before render (`worker.ts:199-210`).
- A loader-less route whose chain reads a store still calls the worker (S7b, `7b66c4e`). `packages/brust/test/fixtures/store-app/**` is the merged e2e fixture. It has no native `useStore` component: store-server Task S10 never landed (`git log m3f`), so **this lane is the first end-to-end run of a native `useStore` read.**
- `cache.invalidate({ key?, tags?, path?, method? })` is exported from `@brust/core` (`packages/brust/src/index.ts:2`, `cache.ts:11-28`). `tags` evicts both caches (`crates/brust-server/src/config.rs:217-231`). The server handle is a process-global static (`crates/brust-napi/src/server.rs:22,66`), and workers are threads of that process (`run.ts:89`).
- Workers inherit `process.env` (`run.ts:55-62`), and their cwd is the app root.

**Bench facts.**
- S/D/I run against `bench/apps/brust`: `/types`, `/dex?nocache=1`, `/team?nocache=1` (`bench/lib/probes.ts:4-8`). That app imports no store (`grep -rn "store" bench/apps/brust/{routes.tsx,components,pages,lib}` → empty), and `bench/**` is unchanged since 04794ae.
- Baseline `bench/RESULTS.md` (generated @97b944a, the content at 04794ae): brust S 113,744 · D 13,759 · I 104,889 rps.
- The pokedex is used only by the manual attribution probes B/C (`bench/attribution.ts:2`). After this lane those probes DO touch the store: the layout loader reads sqlite on every page.

## Rulings requested from the lead before dispatch

Each has a default that the implementer follows unless the lead answers differently.
- **R1: table shape (E7 says `id TEXT PRIMARY KEY`).** `TeamMember.id` is a number (`lib/types.ts:7`; 0.1.x zod `z.number().int().positive()`). Default: `team(id INTEGER PRIMARY KEY, name TEXT, display_name TEXT, num TEXT, types TEXT /* JSON */, artwork TEXT, added_at INTEGER)`, ordered by `added_at, rowid`.
- **R2: POST body.** Default: `{ id: t.Integer({ minimum: 1 }) }` only. The server builds the member from the offline snapshot through a new `pokemonById(id)` export in `lib/pokeapi.ts`; an unknown id returns `problem(404, { title: 'UnknownPokemon' })`. Clients cannot forge display data. Alternative: 0.1.x's full-member body (`actions.ts:12-19`).
- **R3: `TeamFull`.** Default: a RETURNED `problem(409, { title: 'TeamFull', detail: 'the team already has 6 members', max: MAX_TEAM })`, which Eden types on the client (Facts). Alternative: a thrown `class TeamFull extends HTTPError.id('TEAM_FULL')` (`unknown` on the client).
- **R4: seeding and the initial team.** Default:
  - the `AppLayout` route gets `loader: layoutLoader` = `team.members.set(teamDb().list()); team.max.set(MAX_TEAM)` (one place; no extra Bun call; covers notFound);
  - `chrome()` drops `teamInitial`, and `TEAM_SEED` is deleted;
  - a fresh DB is EMPTY (0.1.x parity), and tests seed through the HTTP API.
- **R5: L1 interplay.** Default: both cached routes that render the team get the tag `team` (`/pokemon/{name}` tags `['pokemon','team']`, `/type-chart` tags `['types','team']`), and every successful mutation calls `cache.invalidate({ tags: ['team'] })`. `?nocache=1` stays the read-fresh escape. Alternative: `invalidate({ tags: ['pokemon','types'] })` with no route change.
- **R6: DB location.** Default: `process.env.POKEDEX_TEAM_DB` if set, else `<process.cwd()>/data/team.sqlite`, opened lazily on first use. The parent dir is created; WAL is on; `busy_timeout = 5000`. `examples/pokedex/.gitignore` lists `data/team.sqlite*`. Every test sets `POKEDEX_TEAM_DB` to a temp file.
- **R7: `/unified`.** Default:
  - a route under `AppLayout`, with no cache;
  - `unifiedLoader` returns `chrome(…)` and seeds `unified.count.set(start)`, where `start` = `?start=` truncated and clamped to 0..1,000,000 (default 0, as the 0.1.x demo);
  - NAV gains `{ href: '/unified', label: 'Unified' }`;
  - the island counter is forced to react tier by a `useReducer` "clicks from React" tally (D10 asks for an island; `useStore` alone compiles native).
- **R8: pins.** Default: update (a) `build.test.ts` in the task that changes each line, and (b) `scripts/m2-exit/exit.ts`:
  - add a `ROUTES` row `{ pattern: '/unified', leafTier: 'static', why: 'unified store: island + native counter + native read-only node on one store, first paint seeded' }`;
  - change the `/` and `/pokemon/{name}` why-text to name the team store;
  - prose `job.misses` = 1 → 2;
  - regenerate the report with a FRESH addon.

  Update (c) the `tests/server` lines listed in Facts. Nothing else changes.
- **R9: out-of-boundary defects.** If the merged core, compiler or wave-2 code misbehaves (the first native `useStore` e2e), do NOT patch `packages/**` or `crates/**` here. File a `task challenge` with the failing test and the probe, and STOP that task.
- **R10: busy state.** Default: AddToTeamButton keeps a native `useState` busy flag (`disabled={busy || full}`). Probe: it stays native.

## Global constraints

**Lane** (after the lead posts "bridge + elysia merged into m3f"):
```
cd ~/code/brust-m3f && git pull --ff-only && git worktree add ../brust-lane-m3f-pokedex-team -b lane/m3f-pokedex-team m3f
cd ../brust-lane-m3f-pokedex-team && bun install --frozen-lockfile && (cd packages/brust && bun run build:debug)
```
- Do NOT use `conclave lane start` (it branches from `main`). Line numbers are at m3f @e2538c1. Task 1 re-anchors them on the merged tree and records the deltas.
- NO PR: post READY on the Conclave task, and the lead merges into `m3f`.

**TDD.** Every task writes its failing tests first, runs them, and pastes the red line into the task note before any implementation.

**Gates** (green before each commit unless the task says otherwise; ALL before READY):
- `cd examples/pokedex && bun run typecheck && bun test`;
- `bun test --timeout 120000 tests/server/pokedex.test.ts`;
- `bun test --timeout 120000 tests/server/hydrate.chromium.test.ts`.

  Each server-starting file runs ALONE (port-race flake, memory `native-island-integration-flake`).
- `bun run browser-test` (happy-dom harness; must be unchanged).
- `bun run battery` → the battery report is unchanged (`git diff --exit-code docs/react-coverage.md`).
- `bun run m2-exit && git diff --exit-code docs/plans/m2-exit-report.md && bun test scripts/m2-exit`. This is red from Task 4 until Task 9 by design; it is not a per-task gate before Task 9.
- `cd packages/brust && bun test --timeout 120000 test/e2e-store.test.ts` and `test/e2e-actions.test.ts` (unchanged, green).
- After `git pull`/merge of Rust changes: `cd packages/brust && bun run build:debug` BEFORE any TS test (memory `stale-napi-node-after-compiler-change`). The m2-exit regeneration also needs a fresh addon (memory: a stale build flipped two tiers).

**Test DB hygiene.**
- No test or gate may create `examples/pokedex/data/team.sqlite`. `git status --short` must never show it, and `ls examples/pokedex/data` = `pokedex.json` after every gate.
- Harnesses pass `POKEDEX_TEAM_DB=<mkdtemp>/team.sqlite` and delete the dir in `afterAll`.

**Commits.**
- Never `git add -A`; stage by name. `git status --short` lists exactly the task's files.
- Messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `bun.lock` changes only in the `examples/pokedex` workspace block.

**Benches.** None, except Task 11's sanity:
- under the two-layer `bench:host-lock` (`BENCH_LOCK_WS`/`BENCH_LOCK_ID`, `bench/README.md:45-52`);
- only while the blackboard key `lead:gates` reads idle (re-check before each round);
- after every partial run, `git checkout -- bench/RESULTS.md bench/RESULTS.json`.

**Do not re-decide:** E1–E9, A1–A6, D1–D10, C1–C8. Store names are dot-free (`team`, `unified`; store R3). Render reads only top-level `signal(…)` keys (`members`, `max`, `count`). Writes happen only in handlers or effects. Elysia 2 order is `(path, hook, handler)`. The pins are exact.

## Boundary (exact)

- `examples/pokedex/`:
  - `package.json` (`dependencies`: `elysia` `2.0.0-beta.30`, `@elysia/eden` `2.0.0-beta.6`, exact), `brust.toml` (`[build] server_only`, `[actions]`), `routes.tsx`, `README.md`, NEW `.gitignore`, NEW `actions.ts`;
  - `lib/{loaders.ts,types.ts}`, `lib/pokeapi.ts` (adds `pokemonById` only), NEW `lib/{team.ts,team-db.ts,api.ts,team-client.ts}`, NEW `stores/{team.ts,unified.ts}`;
  - `components/{AppLayout.tsx,TeamBuilder.tsx}`, NEW `components/{AddToTeamButton.tsx,UnifiedIsland.tsx,UnifiedNative.tsx,UnifiedStoreNode.tsx}`, `pages/DetailPage.tsx`, NEW `pages/UnifiedPage.tsx`;
  - `public/app.css` (regenerated only, Task 9); `test/build.test.ts`; NEW `test/{team-db,actions}.test.ts`.
- `tests/server/{harness.ts,pokedex.test.ts,hydrate.chromium.test.ts}`.
- NEW `docs/store.md`; `docs/actions.md` (the "Next" section only).
- `scripts/m2-exit/exit.ts` (`ROUTES` + the `:51` prose only) and `docs/plans/m2-exit-report.md` (regenerated).
- `bun.lock` (the pokedex block only).
- NOT touched:
  - `packages/**`, `crates/**`, `bench/**`, `.github/**` (the existing CI lines already run every file this lane adds);
  - `packages/create-app` (next lane);
  - `crates/brust-server/benches/fixtures/**`.

## Tasks

### Task 1: Merge, re-anchor, baseline

- [ ] **Step 1:**
  - `git fetch && git merge --no-edit origin/m3f` (no-op if the lane was cut after both merges);
  - `bun install --frozen-lockfile`;
  - `cd packages/brust && bun run build:debug`.
- [ ] **Step 2: Re-verify every wave-2 anchor.** Paste each command's output into the task note, and record any delta as `ANCHOR <name>: plan said X, tree has Y`. Proceed on Y. If a contract (name, signature or default) differs, file a challenge (R9).
  ```
  grep -n "export function brust\|LISTEN_ERROR" packages/brust/src/actions/elysia.ts
  grep -n "export function client\|resolvePrefix\|keepDomain" packages/brust/src/actions/client.ts
  grep -n '"./elysia"\|"./client"\|"elysia"\|"@elysia/eden"' packages/brust/package.json
  grep -n "actions" packages/brust/src/build/config.ts packages/brust/src/build/manifest.ts | head
  grep -n "setActionsApp\|loadActionsApp\|runInStoreContext" packages/brust/src/worker.ts packages/brust/src/actions-bridge.ts
  grep -n "'fetch'" packages/brust/src/native.ts; ls docs/actions.md packages/brust/test/e2e-actions.test.ts
  grep -n "export { cache }" packages/brust/src/index.ts
  ```
  Also re-anchor the Facts line numbers in `examples/pokedex/**`, `tests/server/**`, `worker.ts:130-256` and `scripts/m2-exit/exit.ts:12-19,51`.
- [ ] **Step 3: Baseline**, pasted:
  - `cd examples/pokedex && bun test` (expect `build.test.ts` and `snapshot.test.ts` green);
  - both `tests/server` files, alone;
  - `bun run browser-test`;
  - `bun test scripts/m2-exit`;
  - `cd packages/brust && bun test --timeout 120000 test/e2e-actions.test.ts`.

  Snapshot the four bodies with the bridge plan's `snap.sh` (copy from `/private/tmp/claude-501/-Users-detoro-code-brust/84499717-7bab-40dc-be3d-c896c07cf5ce/scratchpad/m3p-d/{snap,cmp}.sh` to `$OUT`, set `ROOT` to the lane): `$OUT/snap.sh before`. The bench app bodies (`/dex`, `/team`) must stay IDENTICAL for the whole lane; the pokedex bodies will change on purpose.
- [ ] **Step 4:** No commit (or a merge commit only). Post the anchor table.

### Task 2: `lib/team.ts` + `lib/team-db.ts` (bun:sqlite)

**Files:** NEW `lib/team.ts`, `lib/team-db.ts`, `test/team-db.test.ts`, `.gitignore`.

- [ ] **Step 1: Failing tests** (`test/team-db.test.ts`; every case opens a fresh temp file or `':memory:'`):
  1. `a fresh db lists nothing`.
  2. `add returns added, then present for the same id; list keeps insertion order`.
  3. `the seventh distinct member is refused with full; an existing member is still present when full`.
  4. `remove deletes; removing an absent id is a no-op`.
  5. `a second connection to the same file sees the rows (workers share one file)`.
  6. `rows survive close + reopen (restart keeps the team)`.
  7. `types round-trip as an array`.
  8. `teamDb() honours POKEDEX_TEAM_DB, creates the parent dir, and is a per-process singleton`.
  9. `importing lib/loaders.ts opens no database`: with `POKEDEX_TEAM_DB` at a temp path, `await import('../lib/loaders')` leaves the file absent. `brust build` imports `routes.tsx`, so the open must be lazy.
- [ ] **Step 2: Implementation.**
  ```ts
  // lib/team.ts: isomorphic (stores, client and server import it)
  export const MAX_TEAM = 6
  ```
  ```ts
  // lib/team-db.ts: server-only (brust.toml [build] server_only). The team is ONE shared roster, as in
  // 0.1.x, but persisted: every worker thread opens the same file (WAL), so workers never diverge (E7).
  import { Database } from 'bun:sqlite'
  import { mkdirSync } from 'node:fs'
  import { dirname, join } from 'node:path'
  import { MAX_TEAM } from './team'
  import type { TeamMember } from './types'
  export type AddResult = 'added' | 'present' | 'full'
  export interface TeamDb { list(): TeamMember[]; add(m: TeamMember): AddResult; remove(id: number): boolean; close(): void }
  export function openTeamDb(file: string): TeamDb {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    const db = new Database(file, { create: true })
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000')
    db.exec('CREATE TABLE IF NOT EXISTS team (id INTEGER PRIMARY KEY, name TEXT NOT NULL, display_name TEXT NOT NULL, num TEXT NOT NULL, types TEXT NOT NULL, artwork TEXT NOT NULL, added_at INTEGER NOT NULL)')
    // prepared statements: list (ORDER BY added_at, rowid), has, count, insert, delete
    // add = db.transaction(...) run with .immediate(): count check + insert under one write lock, so
    // two workers adding concurrently at 5 members cannot both succeed (tests/server concurrency case).
    …
  }
  let shared: TeamDb | null = null
  export const teamDbPath = (): string => process.env.POKEDEX_TEAM_DB || join(process.cwd(), 'data/team.sqlite')
  export function teamDb(): TeamDb { return (shared ??= openTeamDb(teamDbPath())) }
  ```
  `.gitignore`: `data/team.sqlite*`.
- [ ] **Step 3:** 9 pass; typecheck. Commit `feat(pokedex): team roster in bun:sqlite — MAX 6, idempotent add, WAL shared by workers (M3-F E7)`.

### Task 3: `actions.ts`: the Elysia 2 app, deps, `[actions]`

**Files:** NEW `actions.ts`, `test/actions.test.ts`; `package.json`, `bun.lock`, `brust.toml`, `lib/pokeapi.ts` (`pokemonById`).

- [ ] **Step 1: Deps.** Add `"elysia": "2.0.0-beta.30"` and `"@elysia/eden": "2.0.0-beta.6"` to `dependencies` (exact; R7 of the elysia plan). Run `bun install` at the lane root. `git diff bun.lock` must touch only the pokedex block. Then `bun install --frozen-lockfile` → clean.
- [ ] **Step 2: Failing tests** (`test/actions.test.ts`). `const db = openTeamDb(':memory:')`, `const calls: unknown[] = []`, `const app = teamApp({ db: () => db, invalidate: (a) => { calls.push(a) } })`, and `const m = new Elysia({ adapter: brust(), prefix: '/_brust/action' }).use(app)`. `call(p, init)` = `Promise.resolve(m.fetch(new Request('http://l/_brust/action' + p, init)))`.
  1. `GET /team → 200 { team: [], max: 6 }`.
  2. `POST /team {id:25} → 200 with the member from the snapshot`: `{ id: 25, name: 'pikachu', displayName: 'Pikachu', num: '#0025', types: ['electric'] }`, and `calls` = `[{ tags: ['team'] }]` (R5).
  3. `POST twice is idempotent (one row; a no-op does not invalidate)`.
  4. `the seventh distinct POST → 409 application/problem+json { title: 'TeamFull', status: 409, max: 6 }; re-POST of a member when full → 200` (R3).
  5. `DELETE /team/25 → 200 without pikachu (invalidates); DELETE of an absent id → 200 unchanged (no invalidate)`.
  6. `POST { id: 'x' } → 422 problem+json; POST { id: 999 } → 404 { title: 'UnknownPokemon' }`.
  7. `typed client round trip`: `client<App>({ baseUrl: 'http://l', fetch: (i, init) => Promise.resolve(m.fetch(new Request(i, init))) })`. `api.team.post({ id: 4 })` → `data.max === 6`. At six, `r.error?.status === 409` narrows to `r.error.value.max === 6`. `api.team({ id: 4 }).delete()` → `data.team` without 4. Type lines (checked by `bun run typecheck`):
     ```ts
     // @ts-expect-error id is required by the body schema
     void api.team.post({})
     ```
  8. `the default export is built on brust() and refuses listen()`: `(app as any)['~config'].adapter.name === 'brust'`; `listen` throws the elysia lane's message.
- [ ] **Step 3: Implementation.**
  ```ts
  // examples/pokedex/actions.ts: the team RPC surface (M3-F E7). One Elysia 2 app behind the Rust server
  // (brust.toml [actions]); never imported by browser code except as `import type { App }`.
  import { cache, type InvalidateArgs } from '@brust/core'
  import { brust } from '@brust/core/elysia'
  import { Elysia, problem, t } from 'elysia'
  import { pokemonById } from './lib/pokeapi'
  import { MAX_TEAM } from './lib/team'
  import { type TeamDb, teamDb } from './lib/team-db'
  export interface TeamDeps { db: () => TeamDb; invalidate: (a: InvalidateArgs) => unknown }
  export function teamApp({ db, invalidate }: TeamDeps = { db: teamDb, invalidate: cache.invalidate }) {
    const reply = () => ({ team: db().list(), max: MAX_TEAM })
    // R5: cached pages that render the team carry the tag `team`; drop them after a real change.
    const changed = () => invalidate({ tags: ['team'] })
    return new Elysia({ adapter: brust() })
      .get('/team', () => reply())
      .post('/team', { body: t.Object({ id: t.Integer({ minimum: 1 }) }) }, ({ body }) => {
        const p = pokemonById(body.id)
        if (!p) return problem(404, { title: 'UnknownPokemon', detail: `no Pokémon #${body.id}` })
        const r = db().add(p)
        if (r === 'full') return problem(409, { title: 'TeamFull', detail: `the team already has ${MAX_TEAM} members`, max: MAX_TEAM })
        if (r === 'added') changed()
        return reply()
      })
      .delete('/team/:id', { params: t.Object({ id: t.Integer({ minimum: 1 }) }) }, ({ params }) => {
        if (db().remove(params.id)) changed()
        return reply()
      })
  }
  const app = teamApp()
  export default app
  export type App = typeof app
  ```
  - `lib/pokeapi.ts` adds `export const pokemonById = (id: number): TeamMember | null` (built from `byId`, `cap`, `pad`, `artwork`).
  - If `t.Integer` in `params` does not coerce `'25'` under beta.30, use `t.String({ pattern: '^[1-9][0-9]*$' })` + `Number(...)` and note it (test 5 decides).
  - If `problem()` rejects the `max` extension member, put `max` in `detail` and note it.
  - `brust.toml` gains:
    ```toml
    [build]
    server_only = ["lib/team-db.ts"]

    [actions]
    ```
- [ ] **Step 4:** 8 pass; typecheck. `brust build routes.tsx --out-dir dist-tmp` → `dist-tmp/actions.js` exists and `manifest.actions` = `{ entry: 'actions.js', prefix: '/_brust/action', maxBodyBytes: 262144 }`. Delete `dist-tmp`. Commit `feat(pokedex): team actions on Elysia 2 — GET/POST/DELETE /team, TeamFull 409, tag invalidation (M3-F E7)`.

### Task 4: `stores/team.ts`, the client helpers, layout seeding, TeamBuilder on the store

**Files:** NEW `stores/team.ts`, `lib/api.ts`, `lib/team-client.ts`; `lib/loaders.ts`, `lib/types.ts`, `routes.tsx`, `components/{AppLayout,TeamBuilder}.tsx`, `test/build.test.ts`; `tests/server/{harness,pokedex.test}.ts`.

- [ ] **Step 1: Harness.**
  - `startPokedex(opts?: { build?: boolean; db?: string })` creates `mkdtempSync(join(tmpdir(), 'pokedex-team-'))` when no `db` is given and passes `POKEDEX_TEAM_DB` in `env`.
  - It returns `{ base, stats, stop, db, action(path, init?) }`. `action` is `fetch(base + '/_brust/action' + path, init)`.
  - `stop` removes the temp dir only when the harness created it.
- [ ] **Step 2: Failing tests** (`tests/server/pokedex.test.ts`; append; read-only, empty DB):
  - `first paint: every layout page carries ONE data-brust-store="team" tag = the DB roster, before the runtime script; the TeamBuilder SSR count equals it`. For `/`, `/pokedex`, `/type-chart` and `/pokemon/nothing` (404):
    - exactly one tag;
    - `JSON.parse` of its text equals `{ max: 6, members: [] }` (compare parsed, not bytes: Rust sorts keys, store-server L7);
    - `team-count` is `0`.

    The catch-all `/nope` has no tag (outside the layout).
  - Deliberate pin edits (R8, team UI change):
    - `:31` `>2<` → `>0<` (fresh DB is empty, R4);
    - `:30`: if the island host no longer has `x-props` (TeamBuilder takes no props; `__store` is hidden from x-props, C5), make it optional: `(?: x-props='[^']*')?`. Paste the before/after host tag.
  - `examples/pokedex/test/build.test.ts`: `teamBuilder` manifest `stores` equals `['stores/team.ts']`.
- [ ] **Step 3: Implementation.**
  ```ts
  // stores/team.ts: dot-free name (store R3), its own module (compiler R4); NEVER imports lib/team-db
  import { defineStore, signal } from '@brust/core/store'
  import { MAX_TEAM } from '../lib/team'
  import type { TeamMember } from '../lib/types'
  export const team = defineStore('team', () => ({ members: signal<TeamMember[]>([]), max: signal(MAX_TEAM) }))
  ```
  ```ts
  // lib/api.ts: browser-safe; the App import is type-only (R8 guard of the elysia lane refuses a value import)
  import { client } from '@brust/core/client'
  import type { App } from '../actions'
  export const api = client<App>()
  ```
  ```ts
  // lib/team-client.ts: the one place UI code mutates the team; every reply is written to the store
  import { team } from '../stores/team'
  import { api } from './api'
  type Reply = { data: { team: TeamMember[]; max: number } | null; error: { status: number } | null }
  const apply = (r: Reply) => { if (r.data) { team.members.set(r.data.team); team.max.set(r.data.max) } }
  export async function refreshTeam() { apply(await api.team.get()) }
  export async function removeMember(id: number) { apply(await api.team({ id }).delete()) }
  export async function addMember(id: number) { const r = await api.team.post({ id }); if (r.error?.status === 409) return refreshTeam(); apply(r) }
  export async function toggleMember(id: number, inTeam: boolean) { return inTeam ? removeMember(id) : addMember(id) }
  ```
  Type `Reply` from Eden's response type if the hand type does not fit; typecheck decides.
  - `lib/loaders.ts`:
    - delete `TEAM_SEED`, and `teamInitial` from `chrome()`;
    - add `export function layoutLoader(): void { team.members.set(teamDb().list()); team.max.set(MAX_TEAM) }` with the comment "seeds the request's store scope; every layout page paints the DB roster (D4/E7)".
  - `lib/types.ts`: remove `ChromeData.teamInitial`.
  - `routes.tsx`: `{ Component: AppLayout, loader: layoutLoader, children: [...] }`.
  - `AppLayout.tsx`: drop the `teamInitial` prop and render `<TeamBuilder />`.
  - `TeamBuilder.tsx` keeps its markup and testids. It reads `const { members, max } = useStore(team)` and keeps `useReducer` for `open` (react tier, `build.test.ts:25`). Remove calls `removeMember(m.id)`; the header shows `{members.length} / {max}`. No `mounted` switch: the SSR snapshot equals the first client snapshot (D8), which is better than 0.1.x `TeamBuilder.tsx:27-31`.
- [ ] **Step 4:** pokedex typecheck + `bun test`; `tests/server/pokedex.test.ts` alone → green. `examples/pokedex/data` holds only `pokedex.json`. Commit `feat(pokedex): team store seeded by the layout loader; TeamBuilder reads useStore(team) (M3-F D10, E7)`.

### Task 5: `AddToTeamButton` (native) on the detail page; the `team` cache tag

**Files:** NEW `components/AddToTeamButton.tsx`; `pages/DetailPage.tsx`, `routes.tsx` (tags), `test/build.test.ts`, `tests/server/pokedex.test.ts`.

- [ ] **Step 1: Failing tests.**
  - `build.test.ts`:
    - `addToTeamButton` has tier `native`, `stores` `['stores/team.ts']`, and one `precompute` job whose `inputs` include `__store.team.members` and `id`;
    - detailPage stays `static`, with a child `addToTeamButton_*`;
    - the detail cache `tags` are `['pokemon','team']`; the type-chart route's are `['types','team']`.
  - `tests/server/pokedex.test.ts`: `detail page: AddToTeamButton paints the store state on first paint`. With an empty DB, `/pokemon/pikachu?nocache=1` contains `data-testid="add-to-team"` with text `Add to team`, no `disabled`, and `x-props` `{"id":25}`. (The mutating variants come in Task 8.)
  - Deliberate pin edit `:65` `job.misses` `1` → `2`: the button's precompute job is the second new job on `/pokemon/pikachu`. Paste `a1.job` before/after.
- [ ] **Step 2: Implementation** (the probe shape, verified native):
  ```tsx
  // components/AddToTeamButton.tsx: NATIVE (M3-F D7). Render reads the team store through useStore:
  // the server paints __store.team.*, the chunk reads team.members() live. Writes go through
  // lib/team-client (handlers only, compiler rule store-write-in-render).
  import { useState } from 'react'
  import { useStore } from '@brust/core/store/react'
  import { toggleMember } from '../lib/team-client'
  import { team } from '../stores/team'
  export default function AddToTeamButton({ id }: { id: number }) {
    const s = useStore(team)
    const [busy, setBusy] = useState(false)
    const inTeam = s.members.some((m) => m.id === id)          // precompute slot keyed by __store.team.members + id
    const full = !inTeam && s.members.length >= s.max
    return (
      <button type="button" data-testid="add-to-team" data-in-team={inTeam ? 'true' : 'false'} disabled={busy || full}
        className={…0.1.x BASE / IN_TEAM classes via a ternary on inTeam…}
        onClick={async () => { setBusy(true); try { await toggleMember(id, inTeam) } finally { setBusy(false) } }}>
        {inTeam ? 'In your team' : full ? 'Team Full' : 'Add to team'}
      </button>
    )
  }
  ```
  - Labels are 0.1.x `AddToTeamButton.tsx:35-37` verbatim. The class strings are 0.1.x `:20-23`. If a class is missing from `public/app.css`, Task 9 regenerates the CSS.
  - `DetailPage.tsx`: destructure `id`; render `<div className="mt-5 w-full"><AddToTeamButton id={id} /></div>` under the type badges in the hero card (inside the `notFound` else-branch).
  - `routes.tsx`: the R5 tags.
- [ ] **Step 3:** typecheck; `bun test`; `tests/server/pokedex.test.ts` alone (incl. `/pokemon/nothing` still 404 with no button). `bun run battery` unchanged. Commit `feat(pokedex): native AddToTeamButton reads the team store at render; team cache tag (M3-F D7, D10)`.

### Task 6: The `/unified` page

**Files:** NEW `stores/unified.ts`, `components/Unified{Island,Native,StoreNode}.tsx`, `pages/UnifiedPage.tsx`; `lib/loaders.ts` (`unifiedLoader`, NAV), `routes.tsx`, `test/build.test.ts`, `tests/server/pokedex.test.ts`.

- [ ] **Step 1: Failing tests.**
  - `build.test.ts` (route list deliberately extended):
    - patterns `['/', '/pokedex', '/pokemon/{name}', '/type-chart', '/unified', '*']`;
    - `unifiedPage` static;
    - `unifiedNative` and `unifiedStoreNode` native with 0 jobs and `stores` `['stores/unified.ts']`;
    - `unifiedIsland` react, with an ssr job on the page.
  - `tests/server/pokedex.test.ts`: `/unified?start=5: one unified tag {count:5}; island, native counter and read-only node all paint 5; /unified paints 0; a team tag too`. Read `data-testid="unified-{island,native,node}-count"` text from the HTML.
- [ ] **Step 2: Implementation** (the probe shapes; 0.1.x `example/docs/components/Unified*.tsx` for copy and layout):
  ```ts
  // stores/unified.ts
  export const unified = defineStore('unified', () => ({ count: signal(0) }))
  ```
  - `UnifiedNative`: `const s = useStore(unified)`; `<p data-testid="unified-native-count">{s.count}</p>`; `<button data-testid="unified-native-inc" onClick={() => unified.count.set(s.count + 1)}>Increment — zero React</button>`.
  - `UnifiedStoreNode`: `const { count } = useStore(unified)`; "one store" + `<span data-testid="unified-node-count">{count}</span>` + `<code>unified</code>`.
  - `UnifiedIsland`: `const { count } = useStore(unified)`; `const [mine, tally] = useReducer((n: number) => n + 1, 0)`; `<p data-testid="unified-island-count">{count}</p>`; `<button data-testid="unified-island-inc" onClick={() => { tally(); unified.count.set(count + 1) }}>Increment from React ({mine})</button>`.
  - `UnifiedPage`: a heading, a one-paragraph explanation (one store, three surfaces, first paint from the server snapshot), and the three components in a row.
  - `lib/loaders.ts`:
    ```ts
    export async function unifiedLoader({ req, path }: LoaderCtx) {
      const start = Math.max(0, Math.min(1_000_000, Math.trunc(Number(req.search.start) || 0)))   // R7
      unified.count.set(start)
      return chrome(req, path, 'Unified store · PokéDex', 'Unified')
    }
    ```
    NAV gains `{ href: '/unified', label: 'Unified' }`.
  - `routes.tsx`: `{ path: '/unified', Component: UnifiedPage, loader: unifiedLoader }` after `/type-chart`.
- [ ] **Step 3:** typecheck; `bun test`; `tests/server/pokedex.test.ts` alone. Commit `feat(pokedex): /unified — island, native counter and read-only node on one store, first paint seeded (M3-F D10)`.

### Task 7: Chromium: the store across surfaces, live

**Files:** `tests/server/hydrate.chromium.test.ts`.

- [ ] **Step 1: Tests.** Helpers:
  - `seed(ids)` deletes every member (GET, then DELETE each) and POSTs `ids` through `srv.action`;
  - `ready(page)` waits for `brust-island[data-hydrated="1"]`. Native `mount()` runs before `scheduleIslands`, so natives are live by then (store spec §2.4).
  - Each test sets `window.__noReload = 1` before acting and asserts it is still `1` after: no reload.
  - Every test collects console errors/warnings and `pageerror` and ends with `expect(errors).toEqual([])`, as `:17-19`.

  Tests:
  1. EXISTING test (`:15-35`), deliberate edit: `seed([1, 4])` before `goto` replaces `TEAM_SEED` (R4). The assertions (`['Bulbasaur','Charmander']`, `1` after Remove, ThemeToggle) are unchanged.
  2. `native Add to team updates the TeamBuilder island without a reload`:
     - `seed([])`, then open `/pokemon/pikachu?nocache=1` and `ready`;
     - `team-count` `0`;
     - click `[data-testid="add-to-team"]`;
     - `waitForFunction` team-count `1` and the button text `In your team`;
     - open the panel → `['Pikachu']`.
  3. `island Remove updates the native button without a reload`:
     - `seed([25])`, then `/pokemon/pikachu?nocache=1`;
     - the button reads `In your team`;
     - open the panel and click Remove;
     - `waitForFunction` the button reads `Add to team` and `team-count` `0`.
  4. `Team Full at six; the seventh button is disabled`: `seed([1,4,7,39,94,143])`, then `/pokemon/pikachu?nocache=1` → the button text is `Team Full` and `disabled`.
  5. `/unified: native, island and node move together`:
     - `/unified?start=5`, `ready`;
     - all three read `5`;
     - click `unified-native-inc` → all `6`;
     - click `unified-island-inc` → all `7`.
  6. `first paint equals the seeded value with JavaScript disabled (no flash of default)`:
     - `browser.newContext({ javaScriptEnabled: false })`;
     - `/unified?start=5` → all three read `5`;
     - after `seed([25])`, `/pokemon/pikachu?nocache=1` → button `In your team`, `team-count` `1`.
- [ ] **Step 2:** Run alone ×3, all green. Then `ls examples/pokedex/data` → `pokedex.json`. Commit `test(server): Chromium — native/island/node share one store live; first paint seeded (M3-F §5.4)`.

### Task 8: Actions + L1 end to end through Rust

**Files:** `tests/server/pokedex.test.ts` (appended LAST; these tests mutate the DB, so they run after every stats-arithmetic test, `:53-108`).

- [ ] **Step 1: Tests** (`describe('team actions through Rust')`):
  1. `GET lists, POST adds (member from the snapshot), POST is idempotent` (A1/A2 through the bridge; `content-type` JSON).
  2. `409 TeamFull at six: application/problem+json {title:'TeamFull', status:409, max:6}; a member re-POST is 200; DELETE removes`.
  3. `422 for a bad body (production shape: no errors member); 404 problem for an unknown id; PUT /team is Elysia's 404; POST / is still 405`.
  4. `20 concurrent POSTs of distinct ids across 2 workers add exactly 6` (`Promise.all`; then 6 × 200 and 14 × 409; GET lists 6). This is the shared-file proof (E7).
  5. `L1: a mutation evicts the team tag` (R5):
     - GET `/pokemon/pikachu` twice → `MISS` then `HIT`;
     - POST `{id:25}`;
     - GET again → `MISS`, the store tag lists 25, and the button reads `In your team`;
     - GET again → `HIT` with identical bytes;
     - `/type-chart` → `MISS` after the mutation as well.
  6. `?nocache=1 always reflects the DB` (DELETE, then `?nocache=1` → `Add to team`, without any L1 eviction assumption).
  7. `restart keeps the team`:
     - `stop()`;
     - `startPokedex({ build: false, db: srv.db })`;
     - GET `/team` lists the same members;
     - `/` `team-count` equals that.
- [ ] **Step 2:** If test 5 shows `cache.invalidate` failing inside the worker (e.g. `startServer has not been called`), STOP: R9 challenge with the log. Do not swap to a workaround silently.
- [ ] **Step 3:** Alone ×3 green. Commit `test(server): pokedex team actions through Rust — 409 at six, concurrency, tag invalidation, restart (M3-F E7, §5.3)`.

### Task 9: Pins: the m2-exit report, Tailwind CSS, README

**Files:** `scripts/m2-exit/exit.ts`, `docs/plans/m2-exit-report.md`, `public/app.css`, `README.md`.

- [ ] **Step 1: Red evidence.** `bun test scripts/m2-exit` → paste the failing route-list and report-diff lines.
- [ ] **Step 2:** Apply R8 to `exit.ts`:
  - the `ROUTES` row `/unified`;
  - the `/` why-text gains `; team store seeded by the layout loader`;
  - the `/pokemon/{name}` why-text gains `; native AddToTeamButton (useStore) + team tag`;
  - the `:51` prose `job.misses` = 1 → 2.

  Then `cd packages/brust && bun run build:debug && cd ../.. && bun run m2-exit`. `git diff docs/plans/m2-exit-report.md` may show only:
  - the counts line;
  - the component-id hashes of changed components;
  - the table rows above;
  - the new row;
  - the prose number.

  Paste the diff. Then `bun test scripts/m2-exit` → green.
- [ ] **Step 3:** `cd examples/pokedex && bunx @tailwindcss/cli@4 -i styles/app.css -o public/app.css --minify`, keeping the header comment. Check that every class used by the new components is present (`grep -c` a sample). If `bunx` cannot fetch (offline), restrict the new markup to classes already in `public/app.css` and say so. Never hand-edit.
- [ ] **Step 4: README.** The Run section gains the actions (`brust.toml [actions]`), `data/team.sqlite` (gitignored; delete it to reset; `POKEDEX_TEAM_DB` override), `/unified`, and the store files under Layout.
- [ ] **Step 5:** All gates. Commit `chore(pokedex): regenerate the M2 exit report and app.css for the team + /unified pages (R8)`.

### Task 10: `docs/store.md`; the actions "Next" link

**Files:** NEW `docs/store.md`; `docs/actions.md` ("Next" only).

- [ ] Port of 0.1.x `example/docs/content/store.md` (164 lines). Plain markdown without front-matter, as `docs/actions.md`. v2 paths: `@brust/core/store`, `@brust/core/store/react`. Sections:
  1. **One store, every surface.** Server loaders, native components, React islands; the D1 surface table.
  2. **`defineStore`.** The handle; reserved `name subscribe snapshot serialize hydrate then`; `snapshot()` vs `serialize()` (top-level signals only); first factory wins. Dot-free names (`store-name-dotted`).
  3. **Scoping.**
     - Browser: one instance per name on `globalThis[Symbol.for('brust.stores')]`, shared by every chunk.
     - Server: per request (loader chain, ssr render, action fetch).
     - The two error strings verbatim (store spec §4).
  4. **Seeding and the snapshot.**
     - Write in a loader (the pokedex `layoutLoader`).
     - Tag shape C4, placed before the runtime script, lazy first-access seeding.
     - Stores read at render are snapshotted even when no loader touched them (manifest union).
     - Pages without stores are byte-identical.
  5. **Native components: render-time reads.**
     - `const s = useStore(team)`: `s.members` paints `__store.team.members` and updates live.
     - Rules: top-level signal keys only (`store-key-unsupported`); writes in handlers/effects only (`store-write-in-render`); no `team.members()` in render (`store-handle-in-render`); the store in its own module, never the component's (`store-name-unresolved`).
     - Derived values are precompute slots keyed by `__store.<name>.<key>` and recomputed on the client.
     - Every violation falls back to the React tier with the named diagnostic.
     - Example: `AddToTeamButton`.
  6. **React islands.** `useStore` = `useSyncExternalStore`. SSR runs in a scope seeded from the snapshot, so the first paint equals hydration; no `mounted` switch (contrast 0.1.x). Example: `TeamBuilder`.
  7. **Caching.**
     - The snapshot rides in the L1 page and the job keys.
     - Per-user values plus L1 is the same mistake with or without stores.
     - Tag pages that render a store and `cache.invalidate({ tags })` after a mutation (the pokedex `team` tag, R5); `?nocache` for reads.
  8. **Actions and stores.** Stores written inside an action are per-request and never reach the page (E5). Persist, return the data, and set the store on the client (`lib/team-client.ts`).
  9. **Limits.**
     - No SPA navigation snapshot, no selectors, no nested signals.
     - `Map`/`Set`/`Date` → `{}`; `BigInt` throws naming the store and key; the snapshot is unbounded.
     - A store module's top-level code runs more than once in a worker (store-server L6), so keep store modules side-effect-free (the pokedex keeps sqlite out of `stores/team.ts`).
  10. **Example.** `/unified` and the pokedex team.
  11. **Next.** `docs/actions.md`.
- [ ] Every code block typechecks: copy each into `examples/pokedex/` scratch files, run `bun run typecheck`, delete them, and paste "doc blocks typechecked: N".
- [ ] `docs/actions.md` "Next": link `examples/pokedex/actions.ts` + `lib/team-client.ts` and `docs/store.md`.
- [ ] Commit `docs: store — the unified store in v2 (native render reads, island SSR seeding, caching, actions) (M3-F §5.6)`.

### Task 11: Gates, bench sanity, READY

- [ ] **Step 1: All gates** (Global), pasted. Also:
  - `$OUT/snap.sh after && $OUT/cmp.sh before after`: bench `/dex` and `/team` print IDENTICAL; the pokedex bodies differ (expected; paste the byte sizes);
  - `git diff --name-only m3f` ⊆ Boundary;
  - `ls examples/pokedex/data` = `pokedex.json`;
  - `grep -rn "store" bench/apps/brust/{routes.tsx,components,pages,lib}` → empty;
  - the chunk sizes of `addToTeamButton_*` and `react-teamBuilder_*` (Eden is bundled into each; paste the bytes).
- [ ] **Step 2: Bench sanity** (§5.5 acceptance; S/D/I within −1% of `bench/RESULTS.md` @04794ae):
  - Copy `/private/tmp/claude-501/-Users-detoro-code-brust/f9f1ca9f-9960-401d-990c-64a7577cb7d5/scratchpad/m3pe/abproto.ts` to `$OUT`. Change it so each variant has its own tree (`TREE = $OUT/tree-<variant>`, used for `APP`, `BIN` and the addon target). The worker TS differs between the two sides (store scope + fetch branch), so ONE tree with swapped addons would measure HEAD's TS twice.
  - Trees: `git worktree add $OUT/wt-before 04794ae`, then `cp -cR $OUT/wt-before $OUT/tree-before && rm -rf $OUT/tree-before/.git` (and the same for `after` from the lane HEAD). `bun install --frozen-lockfile` in each. Release addons: `cd packages/brust && bun run build` in each tree.
  - Wait for idle (`vm.loadavg` < 6) and for `lead:gates` idle. Then run `BENCH_LOCK_WS=<ws> BENCH_LOCK_ID='m3f-pokedex-team <agent>' AB_VARIANTS=before,after AB_PROBES=S,D,I AB_ROUNDS=3 bun $OUT/abproto.ts`.
  - Acceptance: paired median rps after/before ≥ −1% on S, D and I. Below that, STOP and post the numbers. This lane changes no bench path, so a drop belongs to wave 1/2; the lead's options are the store-server L2 / bridge K6 ones. Do not tune.
  - `git worktree remove $OUT/wt-before`; `git status` clean of bench files.
- [ ] **Step 3:** Post READY (template). Do not merge.

## Review Focus

1. **Real, shared persistence.**
   - Add is one `immediate` transaction: count check plus insert under the write lock (team test #4 is the proof).
   - The DB is opened lazily (team-db #9; the build imports the routes).
   - `POKEDEX_TEAM_DB` is honoured, and no test or gate ever creates `examples/pokedex/data/team.sqlite`.
2. **Store contract, used as written.**
   - Names `team`/`unified` (dot-free). Each store lives in its own module, imports no server code (`stores/team.ts` never reaches sqlite) and holds only top-level signals.
   - Render reads only `members`, `max`, `count`. Writes happen only in handlers / `lib/team-client.ts`.
   - Tiers are as the probe: button native with ONE precompute job on `__store.team.members` + `id`; TeamBuilder react; unified natives with 0 jobs.
3. **First paint is the DB/seed, everywhere.** The layout loader seeds. One `data-brust-store` tag appears per store per page, and none on `*`. The SSR island count, the native button label and the `/unified` nodes match on the server HTML and with JavaScript disabled.
4. **L1 is honest.** Cached team pages carry the `team` tag, and a real mutation (not a no-op) invalidates it. Test #5 shows `MISS` → fresh roster → `HIT`, on both cached routes. `?nocache=1` is documented.
5. **Actions are Elysia 2 as ruled.**
   - Route order `(path, hook, handler)`; exact pins; TypeBox body/params.
   - A returned `problem(409)` is typed on the client; the member is built server-side from the snapshot.
   - Browser code imports `type { App }` only; `lib/team-db.ts` is `server_only`.
6. **Every pin change is deliberate and listed.** `build.test.ts` (routes, tags, new components), `pokedex.test.ts:30,31,65`, chromium `:15-35` seeding, the m2-exit `ROUTES` and prose. No other assertion moves. `snapshot.test.ts` and `benches/fixtures/pokedex` are untouched.
7. **Nothing outside the example moved.** No `packages/**`, `crates/**`, `bench/**` or `.github/**` diff; bench bodies IDENTICAL; S/D/I within −1%.

## Risk ledger

| # | Risk | Mitigation / stop rule |
|---|---|---|
| 1 | A wave-2 name or default differs from the plans (merged after this was written) | Task 1 anchor table; R9 challenge for a contract change; proceed on the tree's names |
| 2 | First native `useStore` end to end (S10 never landed): chunk import, live update or first paint misbehave | Task 5/6/7 tests isolate it; R9: challenge with the failing test + the probe; no core patch in this lane |
| 3 | `cache.invalidate` from an action in a worker thread fails (process-global static assumed) | Task 8 #5 proves it; STOP + challenge if it throws (Task 8 Step 2) |
| 4 | Two concurrent adds overshoot six (two workers, two connections per worker: loader source copy + `dist/actions.js` bundle) | `transaction(...).immediate`, WAL, `busy_timeout = 5000`; team #4 (20 parallel POSTs) |
| 5 | The DB opens at import → `brust build` or `bun test` writes `data/team.sqlite` | Lazy `teamDb()`; team-db #9; the `ls data` gate |
| 6 | Elysia beta.30 details: `t.Integer` param coercion, `problem()` extension members | Task 3 tests 4/5 decide; the fallbacks are written in Task 3 Step 3 and noted |
| 7 | `public/app.css` misses new classes (generated file) | Task 9 Step 3 regenerates; offline fallback = existing classes only |
| 8 | Pin churn hides a real regression | Each pin edit names its cause (R8); the m2-exit diff is pasted and limited to the listed lines |
| 9 | Test order: DB mutations break the stats arithmetic (`pokedex.test.ts:53-108`) | Mutating tests are appended last; the chromium tests `seed()` their own state |
| 10 | Eden bundled into the native and island chunks (~10 KB each, elysia plan Facts) | Sizes pasted in READY; acceptable for the dogfood; a shared chunk is a later concern |
| 11 | A store module's side effects run twice in the worker (store-server L6) | Stores hold only `defineStore`; sqlite stays in `lib/team-db.ts` |
| 12 | Bench drift from waves 1/2 surfaces here | No bench path changed in this lane; STOP + report below −1%, do not tune |
| 13 | Attribution probes B/C (pokedex) now include a sqlite read per page | Not a gate (manual); noted in READY |

## Dispatch table

Lane tier: standard (one implementer; tasks are sequential in one worktree) · review: complex (Review Focus 1–7). Starts only after "bridge + elysia merged into m3f".

| slug-task | tier | role | deps | acceptance (gate commands + READY evidence) |
|---|---|---|---|---|
| `m3f-pokedex-team-1` merge + anchors + baseline | standard | implementer | both wave-2 lanes merged; R1–R10 answered | anchor table (deltas or "none"); baseline gates pasted; `snap.sh before` saved |
| `m3f-pokedex-team-2` team-db | standard | implementer | 1 | 9 team-db tests red→green; typecheck; `.gitignore`; commit |
| `m3f-pokedex-team-3` actions | standard | implementer | 2; R2, R3, R5 | 8 action tests incl. typed client + `@ts-expect-error`; `bun.lock` pokedex block only; manifest `actions` pasted; commit |
| `m3f-pokedex-team-4` store + seeding + TeamBuilder | standard | implementer | 3; R4 | first-paint test red→green; pins `:30/:31` edited with reason; tests/server alone green; commit |
| `m3f-pokedex-team-5` AddToTeamButton | standard | implementer | 4; R5, R10 | build.test native + 1 precompute job; detail test; pin `:65` 1→2 with stats pasted; battery unchanged; commit |
| `m3f-pokedex-team-6` /unified | standard | implementer | 5; R7 | build.test 6 routes; `/unified?start=5` server test; commit |
| `m3f-pokedex-team-7` Chromium | standard | implementer | 6 | 6 chromium tests alone ×3; no console errors; commit |
| `m3f-pokedex-team-8` actions e2e + L1 | standard | implementer | 6 | 7 team tests alone ×3 (concurrency, MISS→HIT after mutation, restart); commit |
| `m3f-pokedex-team-9` pins | standard | implementer | 7, 8; R8 | m2-exit diff pasted (listed lines only); `bun test scripts/m2-exit` green; app.css regenerated; README; commit |
| `m3f-pokedex-team-10` docs | standard | implementer | 9 | `docs/store.md`, blocks typechecked (count); actions Next; commit |
| `m3f-pokedex-team-11` gates + bench + READY | standard | implementer | 10 | all gates; bench bodies IDENTICAL; boundary diff clean; S/D/I 3 rounds paired median ≥ −1% (else STOP); READY |

## READY note template

```
READY lane/m3f-pokedex-team @ <sha> (base m3f @ <sha> incl. bridge @<sha> + elysia @<sha>)
rulings: R1 <INTEGER id|…> · R2 <id-only body|…> · R3 <returned problem 409|…> · R4 layout loader, empty DB · R5 <team tag + invalidate|…> · R6 POKEDEX_TEAM_DB · R7 /unified ?start · R8 pins · R9 <challenges: none|ids> · R10 busy
anchors (Task 1): <none|list of deltas>
tiers (manifest): addToTeamButton native (1 precompute: __store.team.members, id) · teamBuilder react · detailPage static · unifiedNative/unifiedStoreNode native 0 jobs · unifiedIsland react · unifiedPage static
tests: team-db 9 · actions 8 (+1 type) · tests/server pokedex +<n> (alone ×3) · chromium +5 & 1 edited (alone ×3) · build.test <n>
pins changed (deliberate): build.test routes/tags/components · pokedex.test :30 :31 :65 · chromium :15-35 seeding · m2-exit ROUTES + prose + report (diff lines: <n>)
L1: mutation → invalidate {tags:['team']} → /pokemon/pikachu MISS (fresh roster) → HIT; /type-chart MISS · ?nocache documented
concurrency: 20 parallel POSTs / 2 workers → 6 added, 14 × 409 · restart keeps <n> members
chunks: addToTeamButton <bytes> · react-teamBuilder <bytes> (Eden in each)
bench A/B 04794ae→HEAD (3 rounds, paired median): S …% D …% I …% · bench bodies IDENTICAL · bench/apps/brust store-free
gates: pokedex typecheck+test <paste> · tests/server pokedex <paste> · chromium <paste> · browser-test <paste> · battery unchanged · m2-exit <paste> · e2e-store/e2e-actions <paste> · boundary diff clean · data/ = pokedex.json only
for m3f-create-app: template excludes data/team.sqlite*; examples/pokedex/.gitignore → _gitignore; deps elysia 2.0.0-beta.30 + @elysia/eden 2.0.0-beta.6 exact; POKEDEX_TEAM_DB for tests; snap baseline for pokedex bodies is now <sha>
notes: attribution probes B/C now read sqlite per page (layout loader) — manual, not a gate
```
