# m4cf-pokedex-d1: pokedex on Cloudflare: async `TeamDb`, a D1 implementation behind `[cloudflare.alias]`, migration, scripts, and a Workers e2e that keeps the team across a restart
**RULED by lead Detoro 2026-10-12 (before dispatch): R1-R10 ALL ACCEPTED as their defaults — R1 alias via lane 4's `[cloudflare.alias] "lib/team-db.ts" = "lib/team-db.d1.ts"` (`server_only` prefix `lib/team-db`); R2 D1 add = one `batch()` with the conditional INSERT … SELECT … WHERE COUNT(*) < ? ON CONFLICT DO NOTHING + exists SELECT (added/present/full priority as native); R3 ✓; R4 one shared TeamDb test suite run against sqlite (example) and real local D1 (`tests/cf`, harness Worker under pinned `bunx wrangler dev`; no Miniflare in bun.lock); R5 RULED `tests/cf/pokedex-d1.test.ts` (CI-covered by lane 3's `cf` job; the earlier `tests/server/pokedex.cf.test.ts` name is withdrawn — lane 6's [L5] placeholder resolves to this path); R6 no `wrangler` dep in the example, `sync-template.ts` copies blank's devDependency, local `lib/cloudflare.d.ts` for types; R7 no `database_id`/`name` in the example `wrangler.jsonc`, Task 1 probes local acceptance (pre-ruled fallback: all-zero placeholder id); R8 staleness note in READMEs only (page text unchanged so template hashes/m2-exit stay); R9 ✓; R10 tarball exclusions (`.wrangler/`, `.dev.vars*`, `*.sqlite(-wal|-shm)`) in `sync-template.ts` + `pack.test.ts`, the release.yml regex handed to lane 6. The two assertion changes in `sync-template.test.ts` (devDependencies + exclusion filter) are CONFIRMED. Unverified assumptions (single isolate under local workerd for the tag-eviction check; Host rewriting by `wrangler dev` → Origin-less POST for the passing case) are checked in Task 1 and reported in READY. Task 12 (one real D1 + Worker deploy, deleted in try/finally) follows bb rule:cloudflare-account. Base: m4cf after lanes 3 and 4 merge. Implementer Tiësto (after lane 4), reviewer Afrojack.**
owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: m4cf (after lane/m4cf-worker-crate AND lane/m4cf-build-target merge) · lane: m4cf-pokedex-d1 · tier: standard · review: standard
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

This is lane M4-CF-5 of `docs/design/2026-10-12-m4-cloudflare-workers-design.md`. Read these parts of it first:
- the header: R5 AMENDED (isolate-local invalidation ships as "preview" until lane 7), R8, R12, R14;
- §5 "App data" row (:340);
- §6 account rule (:370), "Dev" (:389-391) and "CI" (:393-404);
- §7 (:411-428);
- §9 row M4-CF-5 (:456).

**The contracts this lane consumes (read their headers):**
- **`docs/plans/2026-10-12-m4cf-build-target.md` (lane 4):**
  - `--target cloudflare`;
  - `[cloudflare] alias` (R12 :182 "a table of app-root-relative module paths, each resolved with `Bun.resolveSync` from the app root");
  - the wrangler merge (R5 :119-132: user bindings kept, `d1_databases[].migrations_dir` rebased to `dist/cf`, default `migrations`; no `account_id` added);
  - `brust dev --target cloudflare` (R10 :157-165: `wrangler dev … --persist-to <appRoot>/.wrangler/state`);
  - Task 11 :320, the pokedex `cf-unsupported … bun:sqlite` failure that THIS lane turns into a working alias.
- **`docs/plans/2026-10-12-m4cf-worker-crate.md` (lane 3):**
  - R3: no env/ctx through wasm; apps `import { env } from "cloudflare:workers"`;
  - R6: the e2e driver is `bunx wrangler@<pin>` from `tests/cf/tools.ts`, flags `--port --ip 127.0.0.1 --inspector-port --persist-to --show-interactive-dev-session=false`, env `WRANGLER_SEND_METRICS=false CI=1`, readiness `/Ready on (http:\/\/\S+)/`;
  - Task 9: `describe.skipIf(process.env.BRUST_CF_E2E !== '1')`, run as `BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf`;
  - Task 10: the CI `cf` job runs exactly that.
- **Amendment f1c9893 (lead ruling 19753649):** `cache.invalidate` reaches wasm via `install({ invalidate })`. The pin evidence there is worker-build 0.8.7 + wrangler 4.149.0.

Every `path:line` below was verified at **m4cf @de82854**; f1c9893 since then is docs only. Lanes 3/4 merge before dispatch, so re-anchor `packages/brust/**` and `tests/cf/**` references on the quoted text.

**Account rule (human, 2026-10-12; spec §6 :370).** The optional Task 12 MAY create ONE Worker and ONE D1 named `brust-test-m4cf-pokedex-d1-<shortsha>`, and MUST delete both on every path. Record only the commands (name expanded), status codes and the post-delete not-found. No account ids, database ids, URLs or `whoami` output may appear in Markdown, notes, commits or generated files. Tests and CI stay local (workerd, local D1).

## Facts the plan rests on (verified @de82854)
- **`examples/pokedex/lib/team-db.ts` (52 lines):**
  - `:3` `import { Database } from 'bun:sqlite'`; `:4-5` `node:fs`/`node:path`.
  - `:9-15` the sync interface: `type AddResult = 'added'|'present'|'full'`; `TeamDb { list(): TeamMember[]; add(m): AddResult; remove(id): boolean; close(): void }`.
  - `:23-25` the DDL `CREATE TABLE IF NOT EXISTS team (id INTEGER PRIMARY KEY, name TEXT NOT NULL, display_name TEXT NOT NULL, num TEXT NOT NULL, types TEXT NOT NULL, artwork TEXT NOT NULL, added_at INTEGER NOT NULL)`.
  - `:29` the insert with the never-repeating clock `MAX(?, (SELECT COALESCE(MAX(added_at), 0) + 1 FROM team))`.
  - `:33-38` the `present` → `full` → insert transaction; `:41` `add: (m) => addTx.immediate(m)`.
  - `:47-52` `teamDbPath()` (`POKEDEX_TEAM_DB` or `<cwd>/data/team.sqlite`) and the lazy singleton `teamDb()`.
- **Importers of `./lib/team-db`:**
  - `actions.ts:8` (`type TeamDb, teamDb`);
  - `lib/loaders.ts:7` (`teamDb`), used in the sync `layoutLoader` `:12-15`;
  - `test/team-db.test.ts:7` (`openTeamDb, teamDb, teamDbPath`);
  - `test/actions.test.ts:7` (`openTeamDb`).
  - `stores/team.ts:1` never imports it.
- **`actions.ts`:**
  - `:15` `teamApp({ db, invalidate } = { db: teamDb, invalidate: cache.invalidate })`;
  - `:16` `reply = () => ({ team: db().list(), max: MAX_TEAM })`;
  - `:21-28` POST (404 `UnknownPokemon`, 409 `TeamFull` with `max`, `changed()` only on `'added'`);
  - `:29-32` DELETE.
- Loaders are awaited in the chain inside one `runInStoreContext` (`packages/brust/src/worker.ts:232-252`), and a `void` result is ignored. So an async `layoutLoader` keeps the store scope.
- **`brust.toml`:** `[server]` :1-3; `[build] server_only = ["lib/team-db.ts"]` :5-6; `[actions]` :8. `server_only` is a **prefix** match on the app-root-relative path (`packages/brust/src/build/bundle.ts:111,123`).
- **`package.json` scripts** :6-12 are `build/start/snapshot/test/typecheck`. devDeps hold no wrangler. The root `workspaces` include `examples/*`, so any devDependency added to the example lands in the root `bun.lock`.
- **`.gitignore`** is one line: `data/team.sqlite*`.
- **`tests/server/pokedex.test.ts` (283 lines):** the team block :167-283. It includes the 403 test :213-226, "20 concurrent POSTs … exactly 6" :228-235, the L1 tag eviction test :237-255 and "restart keeps the team" :264-282. `harness.ts:10-41` boots `brust start` with `POKEDEX_TEAM_DB`.
- **`packages/create-app/scripts/sync-template.ts`:**
  - `EXCLUDE_TOP` :11; `excluded()` :19-24 (excludes `node_modules`, `.DS_Store`, `*.tsbuildinfo` and `^data/team\.sqlite`, but **not `.wrangler/` or `.dev.vars`**);
  - `package.json.tmpl` :56-58 (scripts pass through minus `test`, plus `dev`; `devDependencies` copied verbatim);
  - `_gitignore` :62-63 is derived from the example's `.gitignore`;
  - the overlay `template-overlays/pokedex/README.md.tmpl` is copied last :66-69.
- **`packages/create-app/test/`:**
  - `sync-template.test.ts` mirrors the exclusion list (:15, :20) and asserts `devDependencies` equal the example's (:40);
  - `pack.test.ts:27-28` is the tarball leftover check (`node_modules|dist|test`, `team.sqlite`, `.gitignore`, `.npmrc`);
  - `release.yml:77,116` repeats that check (lane 6's file).
- **Cloudflare [C, fetched 2026-10-12]:**
  - D1 `batch()`: "Batched statements are SQL transactions … it aborts or rolls back the entire sequence"; statements "execute and commit, sequentially, non-concurrently" (https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
  - D1 "runs every query inside an implicit transaction" (…/d1/sql-api/foreign-keys/).
  - The Worker API offers no transaction handle that spans awaits, so the count-then-insert of `team-db.ts:33-38` cannot be expressed [I from the API surface].
  - `run()` → `D1Result { success, results, meta: { changes, last_row_id, … } }` (…/d1/worker-api/return-object/).
  - `first()` → row or `null`. Ordered params only: `?NNN` (…/d1/worker-api/prepared-statements/).
  - `wrangler d1 migrations apply <DB|binding> --local [--persist-to <dir>]`, and confirmation is skipped when non-interactive. `wrangler d1 execute --local --persist-to --file|--command`. `wrangler d1 delete <name> --skip-confirmation` (…/workers/wrangler/commands/d1/).
  - `d1_databases` keys: `binding`, `database_name`, `database_id` (documented as required), `migrations_dir` (default `migrations`). Automatic provisioning: bindings without ids work, and `wrangler dev` creates local resources that persist; on deploy, ids are written back to the config file passed (…/workers/wrangler/configuration/).

## Goal
- `lib/team-db.ts` defines `AddResult` and `interface TeamDb { list(): Promise<TeamMember[]>; add(m: TeamMember): Promise<AddResult>; remove(id: number): Promise<boolean> }` and re-exports the native implementation.
- `lib/team-db.sqlite.ts` is today's bun:sqlite code with the same SQL and the same `.immediate` transaction; its methods return Promises. Its type `SqliteTeamDb = TeamDb & { close(): void }`.
- `lib/team-db.d1.ts` uses `env.TEAM_DB` from `cloudflare:workers` (read per call, never at import):
  - `add` = ONE `batch([conditional INSERT … ON CONFLICT(id) DO NOTHING, SELECT 1 … WHERE id = ?])`, mapped to `added | present | full`;
  - the 6-member cap holds under concurrency;
  - the reply still carries `max`.
- On `brust build --target cloudflare`, `brust.toml` `[cloudflare.alias]` swaps `lib/team-db.ts` → `lib/team-db.d1.ts`, so the CF bundle contains no `bun:sqlite`. A plain `brust build` is unchanged:
  - `manifest.json`, `jinja/`, `client/` and `public/` are byte-identical to the base;
  - `tests/server/pokedex.test.ts` passes unmodified.
- The example gains:
  - `migrations/0001_team.sql` (the same DDL, enforced by a test);
  - `wrangler.jsonc` with a `d1_databases` binding `TEAM_DB` and no ids;
  - scripts `dev:cf`, `deploy:cf`, `cf:migrate:local`, `cf:migrate:remote`;
  - `.wrangler/` and `.dev.vars*` ignored;
  - a README Cloudflare section.
- On local workerd with a persisted local D1:
  - `/`, `/pokemon/pikachu` and `/unified?start=5` render;
  - `/_brust/action/team` GET/POST/DELETE behave as natively (idempotent add, 409 at six, 403 cross-site);
  - 20 concurrent adds land exactly 6;
  - a mutation evicts the team tag in the serving isolate;
  - a wrangler restart keeps the team.
- `TeamDb` has one contract suite. It runs against sqlite in `cd examples/pokedex && bun test`, and against real D1 (local workerd) in `tests/cf` under `BRUST_CF_E2E=1`.
- `bun create @brust/app --template pokedex` ships the D1 variant, the scripts and `wrangler` as a devDependency, but never `.wrangler/`, `*.sqlite` or `.dev.vars`.

## Rulings requested
**R1 — How the D1 module is selected.**
- *Default:* lane 4's `[cloudflare] alias` (implemented, no lane-4 change). `brust.toml` gains:
  ```toml
  [cloudflare.alias]
  "lib/team-db.ts" = "lib/team-db.d1.ts"
  ```
  The key spelling follows lane 4's merged `packages/brust/test/fixtures/cf-app/brust.toml`; Task 1 reads it.
- `lib/team-db.ts` becomes a facade: the types plus `export { openTeamDb, teamDb, teamDbPath, type SqliteTeamDb } from './team-db.sqlite'`. The alias swaps the whole facade, so app imports (`./lib/team-db`) do not change.
- `team-db.d1.ts` must export every runtime name the app imports from the facade: `teamDb`, plus `openTeamDb(d1)` for tests. A missing export is a Bun link error at the CF build.
- `server_only` becomes `["lib/team-db"]` (prefix: covers all three files).
- *Alternatives:*
  - (a) a package.json `imports` conditional `"#team-db": { "workerd": "./lib/team-db.d1.ts", "default": "./lib/team-db.ts" }`. Lane 4 bundles with `conditions: ['workerd',…]`, so it needs no brust code. But every importer changes to `#team-db`, and it is unverified that the brust compiler, `serverOnlyPlugin` and `bun check` resolve `#` imports.
  - (b) a runtime switch: impossible. Lane 4's `cfGuard` fails the CF build on any static `bun:sqlite` in the graph, and a dynamic import would still ship sqlite code to Workers.

**R2 — D1 `add` semantics.**
- *Default:* ONE `d1.batch([ins, has])`, one transaction [C]:
  - `ins` = `INSERT INTO team (id, name, display_name, num, types, artwork, added_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, MAX(?7, (SELECT COALESCE(MAX(added_at), 0) + 1 FROM team)) WHERE (SELECT COUNT(*) FROM team) < ?8 ON CONFLICT(id) DO NOTHING`. The `WHERE` also resolves SQLite's upsert-after-SELECT parse ambiguity.
  - `has` = `SELECT 1 AS one FROM team WHERE id = ?1`.
  - Result: `ins.meta.changes === 1` → `added`; else `has.results.length` → `present`; else `full`. This keeps native precedence: an existing member is `present` even at six (`test/team-db.test.ts:33`).
  - `?8` = `MAX_TEAM`, so the cap lives in one constant.
- *Alternative:* the single `INSERT … ON CONFLICT DO NOTHING` plus a separate, non-atomic `first()`. A concurrent DELETE between the two statements can mislabel `present` as `full`.
- *Rejected:* a Durable Object roster (out of scope, spec §1 non-goal "Durable Objects for stores").

**R3 — Unchanged surfaces.**
- *Default:* sqlite stays the native default (no env switch).
- `GET /team` and `DELETE /team/:id` keep their shapes and status codes; the handlers only gain `await`.
- `TeamDeps.db` stays `() => TeamDb`.
- The D1 `teamDb()` returns `openTeamDb(env.TEAM_DB)` per call, with no module singleton (no binding object cached across requests). A missing binding throws `Error('TEAM_DB D1 binding missing: add it to wrangler.jsonc (see README)')`.
- *Alternative:* cache the D1 wrapper in a module global like the sqlite `shared`.

**R4 — D1 unit-test driver.**
- *Default:* one contract suite `examples/pokedex/test/team-db.contract.ts` (`teamDbContract(label, fresh: () => Promise<TeamDb>)`; not a `*.test.*` file). It runs:
  - against sqlite (`:memory:`) in `test/team-db.test.ts`;
  - against D1 in `tests/cf/team-db-d1.test.ts`. That test runs a 30-line harness Worker, `tests/cf/pokedex-d1/harness.ts`, which imports `lib/team-db.d1.ts` and exposes `POST /call {op,args}` plus `POST /reset`. Its `wrangler.jsonc` has a `TEAM_DB` binding and `migrations_dir: "../../../examples/pokedex/migrations"`. Wrangler bundles it itself, so no brust wasm is needed.
  - The local D1 is prepared with `bunx $WRANGLER d1 migrations apply TEAM_DB --local --persist-to $STATE -c …` and served by `bunx $WRANGLER dev` (lane 3's R6 flags, same `$STATE`).
  - A `remoteTeamDb(url): TeamDb` proxy lets the same suite run over HTTP.
- *Alternatives:*
  - Miniflare's `getD1Database()` in-process: needs `miniflare` in `bun.lock`, which brings workerd into every CI install (lane 3 R6 avoided exactly this), and Bun-runtime support is unverified.
  - a fake D1 over bun:sqlite: fast, but proves nothing about D1.
  - `@cloudflare/vitest-pool-workers`: a second test runner.

**R5 — Where the Workers e2e lives.**
- *Default:* `tests/cf/pokedex-d1.test.ts`. Lane 3's CI `cf` job already runs `BRUST_CF_E2E=1 bun test tests/cf`, so the e2e is CI-covered with no `ci.yml` edit (that file is lane 6's).
- The test spawns its own wrangler with the lane-3 helper. `tests/server/harness.ts` is untouched: spec §6 step 6 `startPokedexCf()` is lane 6's.
- *Alternative:* the brief's `tests/server/pokedex.cf.test.ts`. Nothing runs it in CI until lane 6 lists it.

**R6 — wrangler dependency and Cloudflare types.**
- *Default:* the example does **not** add `wrangler` (root `bun.lock` unchanged; lane 3 R6 precedent).
  - `sync-template.ts` injects `devDependencies.wrangler` into the pokedex `package.json.tmpl`, read from `templates/blank/package.json.tmpl` (lane 4 R11: one source of truth). The `sync-template.test.ts:40` assertion becomes `{ ...src.devDependencies, wrangler: <blank's> }`.
  - In the repo, the example's `*:cf` scripts need a wrangler on `PATH` or `BRUST_WRANGLER`; the README says so.
  - Types: a local ambient `lib/cloudflare.d.ts` declares `module 'cloudflare:workers' { export const env: { TEAM_DB?: D1Database } }` and the minimal `D1Database`/`D1PreparedStatement`/`D1Result` subset used (`prepare/bind/all/first/run/batch`), so `bun check` passes with no new package.
- *Alternative:* `wrangler` + `@cloudflare/workers-types` as example devDependencies. This changes `bun.lock`, downloads workerd in every CI job, and workers-types' global `Response`/`Request` clash with `lib: DOM` [I].

**R7 — D1 ids and local state.**
- *Default:* the example `wrangler.jsonc` has `d1_databases: [{ binding: "TEAM_DB", database_name: "pokedex-team", migrations_dir: "migrations" }]`: no `database_id`, no `name` (lane 4 derives it from `package.json`, so scaffolds get their own name).
  - Local dev relies on automatic local provisioning [C]. Task 1 verifies that `migrations apply --local` accepts an id-less binding under the pinned wrangler.
  - Pre-ruled fallback: `"database_id": "00000000-0000-0000-0000-000000000000"` with a comment `replace with the id from wrangler d1 create`. This is a placeholder, not an account id.
  - The README tells users to run `wrangler d1 create <name>` and paste the id into the **app-root** file. Deploy write-back would land in the regenerated `dist/cf/wrangler.jsonc` and be lost [I].
  - All local state uses `--persist-to .wrangler/state`, the same dir lane 4's `brust dev` passes.
- *Alternative:* commit no binding and document adding it (the example would then not run on Workers out of the box).

**R8 — The R5 staleness note.**
- *Default:* text only in the README and the template README ("Cloudflare (preview): a team change refreshes cached team pages only in the isolate that served the action; other isolates catch up within the route `ttl` (60 s for `/pokemon/*`, 1 h for `/type-chart`) until M4-CF-7"). No page text changes, so native jinja, component ids, `public/app.css` and `docs/plans/m2-exit-report.md` stay byte-identical.
- *Alternative:* one sentence in `pages/UnifiedPage.tsx:12-15`. That changes the component hash and template, so the m2-exit report and `tests/server` text may move, and the sentence would also show on native, where it is false.

**R9 — Template README.** *Default:* yes. The overlay `README.md.tmpl` gains a "Cloudflare Workers (preview)" section covering the scripts, `wrangler d1 create`, the id paste, the migrations, and the R8 note. The full guide is lane 8's `docs/cloudflare.md`. *Alternative:* a link only.

**R10 — Tarball hygiene.**
- *Default:* in this lane:
  - `excluded()` gains top-level `.wrangler` plus `.dev.vars*` and `*.sqlite`/`*.sqlite-wal`/`*.sqlite-shm` anywhere;
  - `sync-template.test.ts:20`'s mirror filter follows;
  - `pack.test.ts:28` gains `/(^|\/)\.wrangler\//`, `\.dev\.vars` and `\.sqlite(-wal|-shm)?$`.
- The same regex in `release.yml:77,116` is lane 6's: a **handoff** in the READY note, not edited here.
- *Alternative:* edit `release.yml` here (outside the spec §9 boundary).

**R11 — One real deploy (optional Task 12).** *Default:* yes, after Tasks 1-11 are green, as `tests/cf/pokedex-d1-edge.ts` (`bun` script, try/finally): `d1 create` → scratch config in gitignored `dist/cf/` with the id → `migrations apply --remote` → `deploy` → curl → `delete` the Worker → `d1 delete`. *Alternative:* skip (local D1 proves the SQL; the edge adds replication and the real limits).

## Boundary
- `examples/pokedex/`:
  - `lib/team-db.ts`, `lib/team-db.sqlite.ts` (new), `lib/team-db.d1.ts` (new), `lib/cloudflare.d.ts` (new);
  - `lib/loaders.ts` (`layoutLoader` :12-15 only), `actions.ts`;
  - `brust.toml`, `package.json` (scripts only), `.gitignore`, `README.md`, `wrangler.jsonc` (new), `migrations/0001_team.sql` (new);
  - `test/team-db.test.ts`, `test/actions.test.ts` (only `await`/`async` and the contract call: no expected value changes), `test/team-db.contract.ts` (new).
- `tests/cf/team-db-d1.test.ts`, `tests/cf/pokedex-d1.test.ts`, `tests/cf/pokedex-d1/{harness.ts,wrangler.jsonc,remote.ts}`, `tests/cf/pokedex-d1-edge.ts` (all new).
- `packages/create-app/scripts/sync-template.ts`, `packages/create-app/template-overlays/pokedex/README.md.tmpl`, `packages/create-app/test/{sync-template,pack}.test.ts`.
- `docs/design/2026-10-12-m4-cloudflare-workers-design.md`: one status line under §7.
- NOT in the boundary:
  - `packages/brust/**` (lane 4) and `crates/**`;
  - `tests/server/**` (`pokedex.test.ts` must pass unmodified; `harness.ts` is lane 6's);
  - `.github/**` (lane 6), `docs/cloudflare.md` (lane 8), `pages/**`, `components/**`, `bun.lock`.
  - Anything else → `conclave task challenge`.

## Tasks
Use `$W=/Users/detoro/code/brust-lane-m4cf-pokedex-d1`, `$OUT=/private/tmp/m4cf-pokedex-d1`, `$WS=838f12fb-70c1-41b7-acf2-d4065cf6bb64`, `$EX=$W/examples/pokedex`.

**Task 1 — worktree, baseline, tool facts**
- [ ] `git -C /Users/detoro/code/brust fetch origin m4cf && git -C /Users/detoro/code/brust worktree add $W -b lane/m4cf-pokedex-d1 origin/m4cf && cd $W && git log --oneline --grep 'merge: lane/m4cf-worker-crate' --grep 'merge: lane/m4cf-build-target' | wc -l` → `2`. Fewer → `conclave task challenge` (base not ready).
- [ ] `bun install --frozen-lockfile && (cd packages/brust && bun run build:debug)` → exit 0.
- [ ] Run the existing tests:
  - `(cd $EX && bun test 2>&1 | tail -3 && bun run typecheck)` → `0 fail`, exit 0;
  - `bun test --timeout 120000 tests/server/pokedex.test.ts` → `0 fail`;
  - `BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf` → lane 3's 13 pass.
- [ ] `mkdir -p $OUT && (cd $EX && bun run build) && cp -R $EX/dist $OUT/dist-base`.
- [ ] Find the lane-4 failure this lane fixes. Run `(cd $EX && BRUST_CORE_CF_DIR=$W/npm/core-cf bun run build -- --target cloudflare; echo $?)` → `error cf-unsupported lib/team-db.ts imports bun:sqlite` and `1`. If `npm/core-cf/worker/index.js` is missing, first build it exactly as `tests/cf/cf-min.test.ts`'s `beforeAll` does (lane 3's `crates/brust-wasm/scripts/build.ts`; copy that invocation).
- [ ] Record these in `$OUT/facts.md`:
  - `WRANGLER` from `tests/cf/tools.ts`;
  - the name of lane 3's spawn/ready helper, if exported (reuse it; else copy its R6 flag set into `tests/cf/pokedex-d1/remote.ts`);
  - the alias key spelling in `packages/brust/test/fixtures/cf-app/brust.toml`;
  - `bunx $WRANGLER d1 migrations apply --help | grep -E -- '--(local|persist-to|config)'`.
- [ ] R7 probe in `$OUT/probe`: a `wrangler.jsonc` with an id-less `TEAM_DB` binding plus `migrations/0001_x.sql`. Run `bunx $WRANGLER d1 migrations apply TEAM_DB --local --persist-to $OUT/probe/state` → exit 0 (else the R7 fallback applies; note which).

**Task 2 — the contract suite and the sqlite split (TDD)**
- [ ] Write `test/team-db.contract.ts` first: `export function teamDbContract(label: string, fresh: () => Promise<TeamDb>)`, registering inside `describe(label)`:
  - (a) every method returns a `Promise` (`expect(db.list()).toBeInstanceOf(Promise)`, same for `add`/`remove`);
  - (b) the cases at `test/team-db.test.ts:16-44` and `:69-73`, ported with `await` and the expected values verbatim;
  - (c) 20 concurrent `add`s of distinct ids → exactly 6 `added` and 14 `full`, and `list()` has length 6;
  - (d) `add` of an existing member when full → `present`.
- [ ] In `test/team-db.test.ts`, call `teamDbContract('sqlite', async () => openTeamDb(':memory:'))`. Delete the ported tests. Keep `:46-67`, `:75-89` and `:91-102` (file sharing, restart, env path, lazy open) with `await` added. `cd $EX && bun test test/team-db.test.ts` → fails on (a).
- [ ] Create `lib/team-db.sqlite.ts` = `team-db.ts:1-52` moved, with these changes:
  - the header comment names the file;
  - the DDL string becomes `export const TEAM_DDL = '<the :24 string verbatim>'` and `db.exec(TEAM_DDL)`;
  - `import type { AddResult, TeamDb } from './team-db'`;
  - `export type SqliteTeamDb = TeamDb & { close(): void }`;
  - `list: async () => …`, `add: async (m) => addTx.immediate(m)`, `remove: async (id) => …`;
  - `openTeamDb(file): SqliteTeamDb` and `teamDb(): SqliteTeamDb` stay sync.
  - SQL, pragmas, `.immediate`, `teamDbPath` and laziness are unchanged.
- [ ] `lib/team-db.ts` keeps the types (async signatures) plus a header comment ("native default; `brust build --target cloudflare` swaps this module for team-db.d1.ts via brust.toml [cloudflare.alias]") and the re-export line from R1.
- [ ] `cd $EX && bun test test/team-db.test.ts` → `0 fail`.

**Task 3 — async callers**
- [ ] `actions.ts`:
  - `reply = async () => ({ team: await db().list(), max: MAX_TEAM })`;
  - the POST/DELETE handlers become `async` and `await db().add(p)` / `await db().remove(…)`.
  - Status codes, problem bodies and the `changed()` conditions are unchanged.
- [ ] `lib/loaders.ts:12-15`: `export async function layoutLoader(): Promise<void> { team.members.set(await teamDb().list()); team.max.set(MAX_TEAM) }`.
- [ ] `test/actions.test.ts`: `await` on `db.list()` (:41) only.
- [ ] Run:
  - `cd $EX && bun test && bun run typecheck` → `0 fail`, exit 0 (Eden types unwrap the Promise: the `typed client round trip` test at :80-93 stays green);
  - `bun test --timeout 120000 $W/tests/server/pokedex.test.ts` → `0 fail` with the file unmodified.

**Task 4 — migration**
- [ ] Test first, in `test/team-db.test.ts`: `readFileSync('migrations/0001_team.sql')` with comment lines stripped, whitespace collapsed and a trailing `;` dropped equals `TEAM_DDL`. It fails (no file).
- [ ] Write `migrations/0001_team.sql`: a `-- pokedex team roster (lib/team-db.sqlite.ts TEAM_DDL; same table on D1)` comment plus `TEAM_DDL;`. → `0 fail`.

**Task 5 — `lib/team-db.d1.ts` + types**
- [ ] `lib/cloudflare.d.ts` per R6. Type `run()`'s result as `D1Result<T> { success: boolean; results: T[]; meta: { changes: number; last_row_id: number } }` [C return-object]. No top-level import/export, so it is ambient for the whole project (`tsconfig.json` has no `include`).
- [ ] `lib/team-db.d1.ts`:
  - `import { env } from 'cloudflare:workers'`, plus `MAX_TEAM` and the types;
  - `export function openTeamDb(d1: D1Database): TeamDb` with `list` = `prepare(LIST).all<Row>()` (LIST = the `team-db.ts:26` SELECT verbatim) mapped as `:40` does, `add` per R2, and `remove` = `(await prepare('DELETE FROM team WHERE id = ?1').bind(id).run()).meta.changes > 0`;
  - `export function teamDb(): TeamDb` per R3;
  - re-export `type { AddResult, TeamDb }`.
  - Bind order for `ins`: `m.id, m.name, m.displayName, m.num, JSON.stringify(m.types), m.artwork, Date.now(), MAX_TEAM`.
- [ ] `cd $EX && bun run typecheck` → exit 0. `bun test` → `0 fail`: no test imports the d1 file under Bun, because `cloudflare:workers` does not resolve there.

**Task 6 — config, scripts, CF build**
- [ ] `brust.toml`:
  - `server_only = ["lib/team-db"]`;
  - append the R1 `[cloudflare.alias]` table with a one-line comment;
  - no other `[cloudflare]` keys (defaults: name from `package.json`, compatibility date from core-cf).
- [ ] `wrangler.jsonc` per R7, with a header comment: "bindings for `brust build --target cloudflare`; brust owns main/assets/compatibility_date; add database_id from `wrangler d1 create` before deploy".
- [ ] `package.json` scripts, added after `build` (keys exact):
  - `"dev:cf": "wrangler d1 migrations apply TEAM_DB --local --persist-to .wrangler/state && brust dev routes.tsx --target cloudflare"`;
  - `"deploy:cf": "brust build routes.tsx --target cloudflare && wrangler deploy -c dist/cf/wrangler.jsonc"`;
  - `"cf:migrate:local": "wrangler d1 migrations apply TEAM_DB --local --persist-to .wrangler/state"`;
  - `"cf:migrate:remote": "wrangler d1 migrations apply TEAM_DB --remote"`.
- [ ] `.gitignore` += `.wrangler/`, `.dev.vars*`.
- [ ] Run `(cd $EX && BRUST_CORE_CF_DIR=$W/npm/core-cf bun run build -- --target cloudflare; echo $?)` → `0`. Then:
  - `grep -c 'ON CONFLICT(id) DO NOTHING' dist/cf/worker/brust-app.js` → ≥ 1;
  - `grep -c 'bun:sqlite\|journal_mode' dist/cf/worker/brust-app.js` → `0`;
  - `bun -e 'console.log(JSON.stringify(Bun.JSONC.parse(await Bun.file("dist/cf/wrangler.jsonc").text()).d1_databases))'` → one entry with binding `TEAM_DB` and `migrations_dir` `../../migrations`;
  - `grep -c account_id dist/cf/wrangler.jsonc` → `0`.
- [ ] Bun-path identity: `(cd $EX && bun run build) && diff -r $OUT/dist-base $EX/dist` → differences only in `actions.js`. Any other differing file → stop and challenge.
- [ ] `examples/pokedex/test/build.test.ts` → green, with stderr `''` (a plain build must not warn about `[cloudflare]`).

**Task 7 — D1 contract under local workerd (R4)**
- [ ] `tests/cf/pokedex-d1/wrangler.jsonc`:
  - `{ name: "pokedex-d1-harness", main: "harness.ts", compatibility_date: <npm/core-cf brust.compatibilityDate> }`;
  - `d1_databases: [{ binding: "TEAM_DB", database_name: "pokedex-team-test", migrations_dir: "../../../examples/pokedex/migrations" }]` (+ the R7 fallback id if Task 1 needed it).
- [ ] `tests/cf/pokedex-d1/harness.ts`: `POST /reset` → `DELETE FROM team`; `POST /call {op:'list'|'add'|'remove', args}` → `Response.json(await openTeamDb(env.TEAM_DB)[op](...args))`; errors → 500 with the message.
- [ ] `tests/cf/pokedex-d1/remote.ts`:
  - `remoteTeamDb(base): TeamDb`;
  - `startWrangler({ config, state }): Promise<{ base, stop }>` (lane 3's helper or the R6 flag set; stop = SIGINT our PID, SIGKILL after 5 s);
  - `migrateLocal(config, state)` = `bunx $WRANGLER d1 migrations apply TEAM_DB --local --persist-to <state> -c <config>`, which asserts exit 0.
- [ ] `tests/cf/team-db-d1.test.ts`: `describe.skipIf(process.env.BRUST_CF_E2E !== '1')`. `beforeAll`: a temp `$STATE`, `migrateLocal`, `startWrangler`. Then `teamDbContract('d1', async () => { await reset(); return remoteTeamDb(base) })`.
- [ ] `BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf/team-db-d1.test.ts` → all pass, including (c) 6/14. Without the env → 0 run.

**Task 8 — pokedex on Workers e2e (R5): `tests/cf/pokedex-d1.test.ts`**
- [ ] Gate the file with `skipIf` as in Task 7.
- [ ] `beforeAll`:
  - build `$EX` with `--target cloudflare` (`BRUST_CORE_CF_DIR=$REPO/npm/core-cf`; build the worker dir first if absent, as in Task 1);
  - `STATE = mkdtemp`; `migrateLocal('$EX/dist/cf/wrangler.jsonc', STATE)`;
  - `startWrangler`.
- [ ] `afterAll`: stop the server; `rm -rf` `$EX/dist` and `STATE`.
- [ ] One `test` per item, in order:
  1. `GET /` → 200; `teamBuilder_` island SSR with `data-testid="team-count"…>0<`; runtime + `react-teamBuilder_` chunk script URLs (the regexes of `pokedex.test.ts:31-35`).
  2. `GET /pokemon/pikachu` → 200, title `Pikachu · PokéDex`, `0.4 m`, `Add to team` button, `x-brust-cache: MISS`; a second GET → `HIT` and an identical body.
  3. `GET /unified?start=5` → island/native/node counts `5` (`pokedex.test.ts:158-159` regex).
  4. `GET /_brust/action/team` → 200 `{team:[],max:6}`. POST `{id:25}` → 200 with pikachu (`toMatchObject` as `:183`). POST again → 200; the roster is `[25]`.
  5. Fill to six with `[1,4,7,39,94]`. POST 143 → 409 `application/problem+json` `{title:'TeamFull', status:409, max:6}`. POST 4 → 200. `DELETE /team/4` → 200; the roster is `[25,1,7,39,94]`.
  6. A POST with `origin: https://evil.example` → 403 problem `CrossSiteRejected`. `sec-fetch-site: cross-site` form POST → 403. The roster is unchanged. An Origin-less POST passes (do not build a same-origin `Origin` from the wrangler URL: Host rewriting under `wrangler dev` is unverified [I]).
  7. Reset (DELETE each member), then `Promise.all` of 20 POSTs (ids 1..20) → exactly 6×200 and 14×409; the roster has length 6.
  8. Reset; `GET /pokemon/snorlax` MISS then HIT; POST 143 → 200; `GET /pokemon/snorlax` → `MISS` with `In your team` and team store `members:[{id:143}]` (the eviction in the serving isolate; local workerd runs one isolate [I]).
  9. Restart: reset; POST 25 and 4; stop wrangler; `startWrangler` again with the same `STATE` → roster `[25,4]`, and `GET /` paints `team-count … >2<`.
- [ ] `BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf` → lane 3's 13 + Task 7 + these 9 pass. Commit.

**Task 9 — create-app template (R6, R9, R10)**
- [ ] Tests first:
  - `sync-template.test.ts`:
    - :20's filter mirrors the new `excluded()`;
    - :40 becomes `expect(pkg.devDependencies).toEqual({ ...src.devDependencies, wrangler: blankWrangler })`, where `blankWrangler` is read from `templates/blank/package.json.tmpl`;
    - new: with a planted `from/.wrangler/state/x.sqlite`, `from/.dev.vars` and `from/data/team.sqlite-wal`, none appears in the output; `migrations/0001_team.sql` and `wrangler.jsonc` do;
    - `pkg.scripts` contains `dev:cf`/`deploy:cf`/`cf:migrate:local`/`cf:migrate:remote` verbatim.
  - `pack.test.ts:28`: the R10 regex.
  - Run `cd packages/create-app && bun test test/sync-template.test.ts` → red.
- [ ] `sync-template.ts`:
  - `EXCLUDE_TOP` += `.wrangler`;
  - `excluded()` += `/^\.dev\.vars/.test(name) || /\.sqlite(-wal|-shm)?$/.test(name)`;
  - :57 adds `devDependencies: { ...src.devDependencies, wrangler: blankWrangler() }`, where `blankWrangler()` reads `templates/blank/package.json.tmpl` (JSON after replacing `__BRUST_DEP__` with `"x"`). Throw if it is absent.
- [ ] `README.md.tmpl`: the R9 section; the Layout bullet `team-db.ts` → "`team-db.ts` (interface; sqlite natively, D1 on Cloudflare via `[cloudflare.alias]`)".
- [ ] Run `cd packages/create-app && bun run typecheck && bun test test/sync-template.test.ts test/templates.test.ts test/pack.test.ts test/cli.test.ts` → `0 fail`.

**Task 10 — docs**
- [ ] `examples/pokedex/README.md`: a "Cloudflare Workers (preview)" section that covers:
  - the scripts and that the repo needs a wrangler on `PATH` or `BRUST_WRANGLER`;
  - `wrangler d1 create`, the id paste and the migrations;
  - the R8 sentence;
  - the `team-db.ts` line :39 updated as in Task 9.
- [ ] Spec §7: add a status line "M4-CF-5 done @<sha>: async TeamDb, team-db.d1.ts (batch conditional insert), `[cloudflare.alias]`, migrations/0001_team.sql, tests/cf pokedex-d1 + team-db-d1". Commit.

**Task 11 — gates.** Run every command in Gates. Paste the totals into `$OUT/gates.txt`.

**Task 12 (optional, R11) — real D1 + Worker, deleted every time**
- [ ] `tests/cf/pokedex-d1-edge.ts`, run as `bun tests/cf/pokedex-d1-edge.ts`. `N = brust-test-m4cf-pokedex-d1-$(git rev-parse --short HEAD)`. Wrap everything in `try { … } finally { bunx $WRANGLER delete --name N --force; bunx $WRANGLER d1 delete N --skip-confirmation }` (verify the flag spelling with `--help` first).
  1. `bunx $WRANGLER d1 create N`: parse the id from stdout into memory only, never print it.
  2. Build `--target cloudflare`.
  3. Write `dist/cf/wrangler.deploy.jsonc` = `dist/cf/wrangler.jsonc` with `name: N` and `d1_databases[0]` `{database_name: N, database_id: <id>}`. `dist/` is gitignored, and the file is deleted in `finally`.
  4. `d1 migrations apply N --remote -c dist/cf/wrangler.deploy.jsonc`.
  5. `deploy -c dist/cf/wrangler.deploy.jsonc`.
  6. Curl, recording status codes only: `/` 200, `/pokemon/pikachu` 200, team GET 200 `{team:[]}`, POST 25 200, GET → `[25]`, evil-origin POST 403.
- [ ] After: `bunx $WRANGLER deployments list --name N; echo $?` → non-zero, and `bunx $WRANGLER d1 info N; echo $?` → non-zero (exit codes only). If either is zero, delete again and report it.

## Acceptance
- [ ] `git diff origin/m4cf --stat` ⊆ Boundary; `git diff origin/m4cf -- tests/server packages/brust crates .github bun.lock pages components` → empty.
- [ ] `git diff origin/m4cf -- examples/pokedex/test/team-db.test.ts examples/pokedex/test/actions.test.ts`: every removed `expect(...)` line reappears in `test/team-db.contract.ts` with the same expected value. The reviewer checks by `grep`-ing each `toBe`/`toEqual` literal.
- [ ] `cd examples/pokedex && bun test && bun run typecheck` → `0 fail`, exit 0. `bun test --timeout 120000 tests/server/pokedex.test.ts` → `0 fail` (file unmodified).
- [ ] Task 6 `diff -r` shows only `actions.js`. `bun run m2-exit && git diff --exit-code docs/plans/m2-exit-report.md` → exit 0.
- [ ] `BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf` → all pass (lane 3's + `team-db-d1` + `pokedex-d1`); without the env → 0 run, exit 0.
- [ ] `grep -n "ON CONFLICT(id) DO NOTHING" examples/pokedex/lib/team-db.d1.ts` → 1 hit inside a `batch([` call; `grep -n "env\." examples/pokedex/lib/team-db.d1.ts` → only inside `teamDb()`.
- [ ] `grep -rnE "account_id|database_id|workers\.dev" examples/pokedex tests/cf/pokedex-d1* packages/create-app/template-overlays` → nothing (or only the R7 all-zero placeholder plus its comment, if the fallback was taken).
- [ ] `cd packages/create-app && bun test test/sync-template.test.ts test/pack.test.ts` → `0 fail`. `bun pm pack --dry-run` lists no `.wrangler`/`.dev.vars`/`.sqlite`.
- [ ] Task 12: the note has the create/deploy/delete commands with the name expanded, the status codes and the two non-zero post-delete exits, or the line "Task 12 skipped".

## Gates
- `bun install --frozen-lockfile`; `cd packages/brust && bun run build:debug && bun test`;
- `cd examples/pokedex && bun test && bun run typecheck`;
- `bun test --timeout 120000 tests/server/pokedex.test.ts`; `bun test --timeout 120000 tests/server/hydrate.chromium.test.ts`;
- `bun run m2-exit && git diff --exit-code docs/plans/m2-exit-report.md`; `bun test scripts/m2-exit`;
- `cd packages/create-app && bun run typecheck && bun test test/args.test.ts test/copy.test.ts test/dep.test.ts test/templates.test.ts test/cli.test.ts test/sync-template.test.ts test/pack.test.ts`; once at the end, `bun test --timeout 600000 test/scaffold.test.ts` (the pokedex scaffold now installs wrangler);
- `BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf` (new for this lane; it is lane 3's CI `cf` job);
- `bun run browser-test`; `git apply --check bench/attribution.patch` (sanity; no Rust or `worker.ts` touched).
- The cargo gates are unaffected: no Rust edits.

## Risk ledger
- **The alias spelling or matching differs from lane 4's implementation** (key with or without `./`, matching resolved paths vs specifiers). Detected by the Task 6 grep `bun:sqlite` → non-zero, or `cf-unsupported` again. Mitigation: copy the fixture's spelling (Task 1). If lane 4 matches specifiers rather than resolved files, challenge; do not rename imports.
- **D1 batch atomicity or `meta.changes` under local workerd.** Task 7 (c) and Task 8 #7 (exactly 6 of 20) fail if the batch is not one transaction. Do not retry-loop around it: challenge with the observed counts.
- **`Date.now()` binding** may be stored as REAL by D1 [I]. Ordering still works because `MAX(?7, …)` compares numerically; the contract's insertion-order case catches a regression.
- **Id-less local D1 (R7)** may be rejected by the pinned wrangler. Task 1 probes it first; the fallback is pre-ruled.
- **Persist-dir mismatch.** If migrations are applied to one `--persist-to` and `dev` uses another, the first `/` load fails (`no such table: team`, a 500 from the layout loader). Every command in tests and scripts names `.wrangler/state` or the same `$STATE`.
- **Smoke check (lane 4)** runs the CF bundle's top level with `env = {}`. A binding read at import time fails `cf-smoke`; `teamDb()` reads `env` per call (Acceptance grep).
- **Single isolate assumption** for Task 8 #8 [I]. If local workerd spreads requests over isolates, #8 flakes: report it, and do not weaken the assertion.
- **`wrangler dev` Host rewrite** could make same-origin checks differ from native; Task 8 #6 avoids constructing an `Origin` from the URL.
- **Template leak.** A developer's `.wrangler/state/**/*.sqlite` (local D1) sits in `examples/pokedex/` after any `dev:cf`. `sync-template.ts` and `pack.test.ts` now exclude and assert on it; `release.yml` lags until lane 6 (handoff).
- **Eden typing of async handlers.** If `@elysia/eden` 2.0.0-beta.6 types `Promise<…>` returns differently, `bun run typecheck` fails in Task 3. The fix stays in `actions.ts`; never edit tests to cast.
- **Shared-host processes:** stop only the wrangler PIDs the tests spawned (memory rule: no broad `pkill`).

## Reporting
`conclave task note 838f12fb-70c1-41b7-acf2-d4065cf6bb64 m4cf-pokedex-d1 READY @<sha> …`. The note must contain:
- the commit list, and R1-R11 as implemented (alias spelling used; whether the R7 fallback id was needed);
- Task 1's `cf-unsupported` line (before) and Task 6's exit 0 plus grep counts (after);
- the Task 6 `diff -r` result (only `actions.js`);
- `bun test` totals for `examples/pokedex` before/after;
- `tests/server/pokedex.test.ts` → `0 fail` (unmodified);
- the `BRUST_CF_E2E=1 … tests/cf` summary;
- the 20-concurrent counts on D1 (6/14);
- the restart roster `[25,4]`;
- the `dist/cf/wrangler.jsonc` `d1_databases` block (no ids);
- every gate with its result;
- Task 12 commands (name expanded, no ids or URLs) with the status codes and post-delete exits, or the skip line;
- **handoff to lane 6:** extend the `release.yml:77,116` leftover regex with `\.wrangler/|\.dev\.vars|\.sqlite(-wal|-shm)?$`, and decide whether `startPokedexCf()` replaces or wraps `tests/cf/pokedex-d1.test.ts`;
- **handoff to lane 8:** the D1 recipe and the preview staleness note now live in `examples/pokedex/README.md`.

Escalate with `conclave task challenge 838f12fb-70c1-41b7-acf2-d4065cf6bb64 m4cf-pokedex-d1 "<what, evidence>"` for any of these:
- lanes 3/4 not merged at Task 1;
- the alias not swapping the module;
- a needed change in `packages/brust/**`;
- D1 batch not enforcing the cap;
- the plain-build `diff -r` showing more than `actions.js`;
- `tests/server/pokedex.test.ts` needing any edit;
- a file outside the Boundary.
