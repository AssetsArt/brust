# beta1-bench-elysia: bench probes A1/A2, the same Elysia 2 app behind brust (`brust()` + Rust HTTP) vs Elysia's Bun adapter
**RULED by lead Detoro 2026-10-12 (before dispatch): R1-R9 ALL ACCEPTED as their defaults — R1 no separate single-process Elysia row (the clustered row is labelled by the same balance check as bun-serve; the macOS `reusePort` caveat MUST appear in README and RESULTS.md next to the numbers); R2 A1/A2 in the default run, apps auto-filtered per probe; R3 inline `-d` + content-type header, GET invocation byte-identical; R4 separate top-level `actions` block in RESULTS.json so `.measurements`/F68/m2-exit stay untouched by an A-only run; R5 attribution.patch untouched; R6 function handlers on both routes; R7 same `/_brust/action` prefix on the Bun side; R8 exact `elysia@2.0.0-beta.30` in `bench/package.json` + `bench/apps/brust/package.json` only, assert one installed copy; R9 interleaved before/after S/D/I sanity with the −3% stop rule. Base is `beta1` (not v2). The human wants the honest number: report brust vs Elysia-on-Bun as measured, with the hop explained, whichever way it falls.**
owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: beta1 · lane: beta1-bench-elysia · tier: standard · review: complex
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Source: the human's goal (2026-10-12). No ledger row. Related context only: F83 (`docs/plans/m1a-followups.md:147`,
"The 14.6 µs bridge cost (c=1) …"). All line numbers were read at v2 @ 79885d3. If code has moved, re-anchor on the
quoted text and record `ANCHOR <name>: plan X, tree Y` in the task note.

## 1. Goal

- `bench/apps/_shared/actions-app.ts` is ONE Elysia 2 app module with `GET /types` (the 18 `data.types` rows from
  `_shared/data.json`) and `POST /team` (TypeBox body `{ id: number }`, answers `{ ok: true, id }`). No persistence.
  Both sides import it, so the route code is byte-identical.
- The brust side is `bench/apps/brust/brust.toml` plus an `[actions]` table, with `bench/apps/brust/actions.ts`
  default-exporting `actionsApp({ adapter: brust() })`. It answers `GET /_brust/action/types` and
  `POST /_brust/action/team`.
- The Bun side is a new `bench/apps/elysia-bun` app: N = `--workers` processes on one port (`reusePort`, the
  `bench/apps/bun-serve/cluster.ts` pattern). Each process runs the same module on Elysia's default Bun adapter
  (`app.listen`) and answers the same two URLs.
- `bun run bench` has two new probes. A1 is `GET /_brust/action/types`. A2 is `POST /_brust/action/team`, body
  `{"id":25}`, `content-type: application/json`. Only `brust` and `elysia-bun` run them. Each A probe is measured at
  `oha -c 120 -z 10s` and again at `-c 1`, always with `accept-encoding: identity`. A-probe parity means equal parsed
  JSON bodies.
- `bench/RESULTS.json` carries the A rows and `bench/RESULTS.md` gets an "Actions" section, both written by
  `report.ts`. The committed numbers come from one release-addon run on this host under the host lock and are
  reported as measured, including if brust loses.
- The S/D/I page rows and the m2-exit report are unchanged. Adding `[actions]` to the bench app shifts brust S/D/I
  by no more than the threshold in R9. The A/B evidence goes in the task note.
- `bench/README.md` documents the new probes, the new app, why next/bun-serve/brust-01x are skipped on A, and the
  fairness notes.

## 2. Rulings requested

**R1: single-process Elysia row.** Default **no**. macOS does not balance `SO_REUSEPORT`, and the last RESULTS
shows it: `bench/RESULTS.md` (2026-10-11) reads `ceiling : v2 / bun-serve (1-proc: reusePort did not balance)`.
`elysia-bun` gets the same `/_count` balance check as bun-serve (`bench/lib/balance.ts`, 5% min share). On this host
the clustered row is therefore labelled `1-proc`, and in practice it already is the single-process measurement. A
second row would duplicate it. The c=1 rows isolate the per-request cost either way. Alternative: add an
`elysia-bun-1` app (same `startCmd` with `BENCH_PROCS=1`, port base+6). It costs about 1 minute under the lock and
is only informative on Linux.

**R2: A probes in the default run.** Default **yes**. `--probes` defaults to `S,D,I,A1,A2` and `APP_ORDER` gains
`elysia-bun`. Each probe declares the apps that serve it (`Probe.apps`). The runner builds (app, probe) pairs only
from that list, so `elysia-bun` never gets S/D/I, and next/bun-serve/brust-01x never get A1/A2. A run with no pair
left exits 1 and names the problem. Alternative: A probes are opt-in (`--probes A1,A2`), and the default stays
`S,D,I`.

**R3: the oha POST body.** Default: `OhaOpts` gains `method?: 'GET' | 'POST'` and `body?: string`. When `body` is
set, `ohaArgs` adds `-d <body> -H content-type:application/json` (header in the same `name:value` form as the
`accept-encoding` one). It uses `-m POST` from `method`. GET args stay byte-identical, so the existing
`bench/lib/oha.test.ts:46-51` passes unchanged. Alternatives: `-T application/json` (oha's own flag), or `-D <file>`.
The inline `-d` was chosen because the body is 9 bytes and lives in the probe table.

**R4: how RESULTS grows.** Default: one file, two blocks, merged when written.
- `RESULTS.json` = `{ header, measurements, actions?: { header: ActionsHeader, measurements: Measurement[] } }`.
- `Measurement` gains optional `conn?: number`. A rows always carry it; page rows omit it, which means the
  header's `conn`.
- `writeResults` reads the existing `RESULTS.json` in the out dir and replaces only the blocks this run measured.
  - A run with no page probe keeps the old `header` + `measurements`.
  - A run with no A probe keeps the old `actions`.
  - When there is no old page block, the run's own header is written with `measurements: []`.
- Why: F68 is closed on `RESULTS.json` measurements. `scripts/m2-exit/run.ts:8-13` reads D/I identity rps of
  brust/brust-01x. `scripts/m2-exit/exit.test.ts:20-35` fails if a closed F68 is not met. The committed
  `docs/plans/m2-exit-report.md:34` quotes "D +7.9%, I +2.3%".
  - A full rerun would need `BRUST_01X_DIR`. It would rewrite those numbers (I's +2.3% is within run-to-run noise),
    which forces an m2-exit report diff.
  - An A-only run under R4 leaves `.measurements` byte-identical. Consumers that read `.measurements`/`.header`
    (m2-exit, `report.test.ts` via `fixtures/results.json`) see no change.

Alternative: flat A rows inside `measurements` (`probe: 'A1'`, `conn`). That needs one full run with
`BRUST_01X_DIR=~/code/brust`, plus a regenerated, committed m2-exit report and the risk that the F68 test flips.

**R5: `bench/attribution.patch`.** Default: no change, and the gate stays. The patch touches only `Cargo.lock`,
`crates/brust-server/{Cargo.toml,src/dispatch.rs,src/lib.rs,src/perf.rs (new),src/pipeline.rs,src/render.rs,
src/server/mod.rs}` and `packages/brust/src/worker.ts` (`grep '^diff --git' bench/attribution.patch`). None of them
is in this lane's boundary. `git apply --check bench/attribution.patch` exits 0 on v2 @ 79885d3 (verified).
Alternative: none needed.

**R6: handlers are functions, not values.** Default: both routes take a function handler (`() => …`). Elysia's Bun
adapter promotes non-function static-route handlers to native `Bun.serve` routes, which run no JS per request:
`collectStaticRoutes`, `isPromotable = (h) => promoteResponses && typeof h !== "function" …` in
`node_modules/.bun/elysia@2.0.0-beta.30+*/node_modules/elysia/dist/adapter/bun/index.mjs:132-142` (read in
`~/code/brust-m3f`). The `brust()` adapter is the web-standard adapter (`packages/brust/src/actions/elysia.ts:10-12`)
and never promotes. A value handler would compare Bun's native static path against a JS handler. Alternative: a
value handler on `/types`, read as "what the Bun adapter gives you for free". Then A1 measures that, not the
handler path.

**R7: the Bun side mounts under the same prefix.** Default: `elysia-bun` serves
`new Elysia({ prefix: '/_brust/action' }).use(actionsApp())`. This is the exact shape brust's worker builds
(`packages/brust/src/actions/load.ts:17`: `new Elysia({ adapter: brust(), prefix }).use(app)`), so both sides route
the same URL through the same plugin tree, and `Probe.path` is one string. Alternative: a root mount on Bun
(`/types`, `/team`), with a per-app path in the probe. The URL is 14 bytes shorter and the plugin layer is gone.

**R8: where `elysia` is declared.** Default: exact `"elysia": "2.0.0-beta.30"` in two places.
- `bench/package.json` `dependencies`, so that `_shared/actions-app.ts` resolves it. The repo uses Bun's isolated
  linker (`node_modules/.bun`, no hoisting, `bun.lock` configVersion 1), and resolution from `bench/apps/_shared`
  walks up to `bench/node_modules`. `bun check -p bench` also types it there.
- `bench/apps/brust/package.json` `dependencies`, because `dist/actions.js` keeps `elysia` external
  (`packages/brust/src/build/bundle.ts:331-333`) and resolves it from the app dir at worker boot.

`elysia-bun` gets no `package.json`. It resolves through `bench`, and root `package.json` is untouched. Exactly one
`elysia@2.0.0-beta.30+<hash>` may exist in `node_modules/.bun`. Otherwise `mountActions` throws "two copies of
elysia" (`load.ts:10-12`). Alternative: `bench/apps/elysia-bun/package.json` as its own workspace. That adds a root
`package.json:5-14` edit to the boundary.

**R9: the "adding `[actions]` does not move S/D/I" check.**
- Default: brust-only, identity, interleaved before/after/before/after (`[actions]` removed / present).
- Pass when the paired median Δ of rps is ≥ −3% on each of S, D and I.
- Otherwise run a third pair. If it still fails, STOP and challenge.
- Code argument, to quote in the note:
  - A page request pays one `a.is_under(path_only)` prefix compare (`crates/brust-server/src/pipeline.rs:95-101`).
  - The worker imports the app once at boot (`packages/brust/src/worker.ts:326-330`), with no per-page work.
  - The only other effect is heap.
- Alternative: argue from the code alone, with no runs. That saves about 5 minutes under the lock.

## 3. Boundary

`bench/run.ts` · `bench/lib/{app,apps,oha,parity,probes,report}.ts` and their `*.test.ts` · `bench/lib/fixtures/**`
(new fixtures only; `results.json` unchanged) · `bench/lib/actions-app.test.ts` (new) ·
`bench/apps/_shared/{actions-app.ts (new),pages.md}` ·
`bench/apps/brust/{brust.toml,actions.ts (new),package.json,test/build.test.ts}` · `bench/apps/elysia-bun/**` (new) ·
`bench/{package.json,tsconfig.json,README.md,RESULTS.json,RESULTS.md}` · `bun.lock`.
NOT in the boundary: `packages/**`, `crates/**`, root `package.json` (under R8), `scripts/m2-exit/**`,
`docs/plans/m2-exit-report.md`, `bench/attribution.*`, `bench/apps/{bun-serve,next,brust-01x}/**`,
`.github/workflows/ci.yml` (`bun test bench/lib` at `:143` already picks up the new test file). Anything else needs
a `conclave task challenge`.

## 4. Tasks

Global constraints: Elysia 2 route order is `(path, hook, handler)` (`docs/actions.md:70-76`). Never call
`listen()` on a `brust()` app. Kill only PIDs you spawned (the runner's `stop()` already does this). zsh has no
`timeout`. Commit per task with the attribution trailer.

### Task 1: lane worktree, install, addon, baseline green
- [ ] `cd ~/code/brust-v2 && git pull --ff-only && git worktree add ../brust-lane-beta1-bench-elysia -b lane/beta1-bench-elysia v2 && cd ../brust-lane-beta1-bench-elysia && bun install --frozen-lockfile`
  (NOT `conclave lane start`, which branches from `main`).
- [ ] `cd packages/brust && bun run build:debug && cd ../..`. The release build comes in Task 9.
- [ ] Baseline: `bun check -p bench && bun test bench/lib` (expect `0 fail`); `cd bench/apps/brust && bun test`
  (expect `1 pass`); `git apply --check bench/attribution.patch` (exit 0). Paste the counts into the note.

### Task 2: oha POST (R3)
Files: `bench/lib/oha.ts:3,10-12`, `bench/lib/oha.test.ts`.
- [ ] Test first, in `describe('ohaArgs')`:
  `ohaArgs('u', { conn: 1, dur: '3s', enc: 'identity', method: 'POST', body: '{"id":25}' })` equals
  `['-c','1','-z','3s','--no-tui','--output-format','json','-m','POST','-H','accept-encoding:identity','-d','{"id":25}','-H','content-type:application/json','u']`.
  The existing GET case stays as-is. Run `bun test bench/lib/oha.test.ts` and confirm it is red.
- [ ] Implement it: `OhaOpts { conn; dur; enc; method?: 'GET' | 'POST'; body?: string }`. Run again → green.

### Task 3: probe and app model
Files: `bench/lib/probes.ts:2-9`, `bench/lib/app.ts:6,18-19`, a new `bench/lib/probes.test.ts`.
- [ ] Test first:
  - `PROBES.map(p => p.id)` = `['S','D','I','A1','A2']`.
  - `probe('A2')` = `{ kind: 'json', method: 'POST', path: '/_brust/action/team', body: '{"id":25}', apps: ['brust','elysia-bun'] }`, plus a `what` string.
  - Every page probe has `kind: 'page'` and `apps: ['brust','bun-serve','next','brust-01x']`.
  - `serves(appId, probeId)` is true/false accordingly.
- [ ] Implement: `ProbeId = 'S'|'D'|'I'|'A1'|'A2'`; `Probe { id; kind: 'page'|'json'; path; method: 'GET'|'POST';
  body?: string; apps: AppId[]; what }`; `AppId` gains `'elysia-bun'`; `AppSpec.distribution` doc says
  "bun-serve, elysia-bun". A1 `what`: `'Elysia GET: 18 types as JSON (no cache on either side)'`. A2 `what`:
  `'Elysia POST: TypeBox-validated {id} → {ok,id}'`.
- [ ] `bun check -p bench` will now flag `run.ts:68` (`Record<ProbeId,…>`) and `report.ts:24` (`APP_LABEL`). Fix both
  minimally here (`html: Partial<Record<…>>`, label `'elysia-bun'`) so typecheck is green between tasks.

### Task 4: JSON parity
Files: `bench/lib/parity.ts` (append), `bench/lib/parity.test.ts`.
- [ ] Test first, for `checkJsonParity(rs: { app: string; status: number; contentType: string | null; body: string }[], probe: string, expected: unknown)`:
  - Equal bodies with different key order and whitespace pass.
  - A status other than 200, a content-type that does not start with `application/json`, a body that is not JSON, or
    a deep difference each throw `json parity mismatch on probe A1 (brust vs elysia-bun): …`. The message names the
    first differing path, e.g. `$[3].label`.
  - Every body is also compared with `expected`, so two equally wrong apps fail.
- [ ] Implement it with `Bun.deepEquals` plus a small path walker for the message.

### Task 5: the shared app and the brust side
Files: `bench/apps/_shared/actions-app.ts`, `bench/apps/brust/{actions.ts,brust.toml,package.json,test/build.test.ts}`,
`bench/package.json`, `bench/tsconfig.json:9`, `bun.lock`, `bench/lib/actions-app.test.ts`.
- [ ] Test first, `bench/lib/actions-app.test.ts`, in-process with no server:
  - Mount `const app = new Elysia({ prefix: '/_brust/action' }).use(actionsApp())`.
  - `await app.fetch(new Request('http://x/_brust/action/types'))` → 200, a JSON body deep-equal to `data.types`
    (18 rows).
  - POST `/_brust/action/team` with `{"id":25}` → `{ ok: true, id: 25 }`.
  - POST with `{"id":"x"}` → 422.
  - `servedCount()` rises by 2 over the two good calls.
- [ ] `actions-app.ts`:
  - `import { Elysia, t } from 'elysia'` and `import data from './data.json'`.
  - `let served = 0`; `export const servedCount = () => served`.
  - `export function actionsApp(config: ConstructorParameters<typeof Elysia>[0] = {})` returns
    `new Elysia(config).get('/types', () => { served++; return data.types }).post('/team', { body: t.Object({ id: t.Number() }) }, ({ body }) => { served++; return { ok: true, id: body.id } })`.
  - The counter sits in the handlers on both sides, so the per-process balance check costs both sides the same. There
    is no hook (R6, R7).
- [ ] `bench/apps/brust/actions.ts`: `import { brust } from '@brust/core/elysia'`; `const app = actionsApp({ adapter: brust() })`;
  `export default app`; `export type App = typeof app`. `brust.toml`: append a bare `[actions]` (all defaults).
- [ ] R8: add `"elysia": "2.0.0-beta.30"` to `dependencies` in `bench/package.json` and `bench/apps/brust/package.json`.
  Run `bun install` (NOT frozen) and commit `bun.lock`. Check `ls node_modules/.bun | grep '^elysia@'` → exactly one line.
  `bench/tsconfig.json:9` `include` gains `"apps/elysia-bun"`.
- [ ] `build.test.ts`: assert
  `expect(m.actions).toEqual({ entry: 'actions.js', prefix: '/_brust/action', maxBodyBytes: 262144 })`. The existing
  `stderr === ''` and 3-route asserts stay.
- [ ] Green: `bun test bench/lib/actions-app.test.ts`; `cd bench/apps/brust && bun test`; `bun check -p bench`.

### Task 6: the elysia-bun app
Files: `bench/apps/elysia-bun/{index.ts,cluster.ts}`, `bench/lib/apps.ts:10-13,65-77,108-109`, `bench/lib/actions-app.test.ts`.
- [ ] Test first (append): spawn `bun bench/apps/elysia-bun/index.ts` through `startApp` with `BENCH_PORT=0`,
  `BENCH_CTRL_PORT=0` and ready regex `/\[elysia-bun\] listening on http:\/\/127\.0\.0\.1:(\d+)/`.
  - GET A1 and POST A2 → 200 with the expected JSON.
  - `stop()` ends it.
- [ ] `index.ts`, one process:
  - `const app = new Elysia({ prefix: '/_brust/action' }).use(actionsApp())` (R7).
  - `app.listen({ hostname: '127.0.0.1', port, reusePort: true }, (s) => console.log(`[elysia-bun] listening on http://127.0.0.1:${s.port}`))`.
    The ready line is printed in the callback, because the Bun adapter gates requests until its build settles.
  - Control server as in `bench/apps/bun-serve/index.ts:33-35`, answering `{ pid, count: servedCount() }`.
  - On SIGINT, stop both servers and exit 0.
  - Run with `NODE_ENV=production`.
- [ ] `cluster.ts`: copy of `bench/apps/bun-serve/cluster.ts:7-25` with the entry `index.ts`, the label
  `[elysia-bun]` and the ready line `[elysia-bun] listening on http://127.0.0.1:${port} procs=${procs} ctrl=${ctrlBase}`.
  It is a copy because `bun-serve/**` is outside the boundary.
- [ ] `apps.ts`: add the `elysiaBun` spec.
  - `id: 'elysia-bun'`, `label: 'Elysia 2 on Bun (default adapter)'`, `port: P(5)`, `build: async () => {}`.
  - `startCmd` = `['bun','cluster.ts']`, env `{ BENCH_PORT: P(5), BENCH_PROCS: workers(), BENCH_CTRL_BASE: P(40), NODE_ENV: 'production' }`.
    The ctrl range starts at +40 because bun-serve uses +20…+(20+cores).
  - `distribution` is the same as bun-serve's, but on `P(40)+i`.
  - `version`: `elysia ${bench/node_modules/elysia/package.json version} · bun ${Bun.version}`.
  - Add it to `APPS`, and append `'elysia-bun'` to `APP_ORDER`. Update the port comment at `:10-11`
    (`+5 elysia-bun, ctrl +40…`).
- [ ] Green: `bun test bench/lib`.

### Task 7: report (R4)
Files: `bench/lib/report.ts:8-17,24,65-90`, `bench/lib/report.test.ts`, the new `bench/lib/fixtures/results-actions.json`.
- [ ] Tests first, with all existing tests unchanged:
  - (a) `renderMarkdown(fixture)` with no `actions` contains no `## Actions`.
  - (b) With the new fixture, the output has `## Actions` and one `### A1 — \`GET /_brust/action/types\`` table.
    Its columns are `| app | conn | rps | p50 ms | p95 ms | p99 ms | errors | bytes/resp |`, its latencies use 3
    decimals, and its rows are `brust c=120`, `brust c=1`, `elysia-bun c=120`, `elysia-bun c=1`.
  - (c) The actions verdict line, byte-exact:
    `actions  : brust / elysia-bun (c=120)  A1 87.5%  A2 90.0%   · c=1 p50 brust − elysia-bun  A1 +14 µs  A2 +16 µs`.
    When `elysiaBunBalanced === false`, `elysia-bun` is followed by ` (1-proc: reusePort did not balance)`.
  - (d) `mergeResults(old, run, { page: false, actions: true })` keeps `old.header` and `old.measurements`
    deep-equal and replaces `actions`. `{ page: true, actions: false }` keeps `old.actions`.
  - (e) `JSON.stringify(merged.measurements) === JSON.stringify(old.measurements)`.
- [ ] Implement:
  - `Measurement.conn?: number`.
  - `ActionsHeader { date; host; cores; loadavg; seed; conns: number[]; dur; warmup; settleMs; workers; versions; apps; skipped; order; budgets; elysiaBunBalanced: boolean | null }`.
  - `Results.actions?: { header: ActionsHeader; measurements: Measurement[] }`.
  - `computeActionsVerdict` and `renderActionsVerdict`. `renderVerdict` stays untouched.
  - `renderMarkdown` loops page probes only (`PROBES.filter(p => p.kind === 'page')`). The Actions section goes
    between the page verdict block and the "Generated by" footer.
  - `writeResults(dir, run, measured: { page: boolean; actions: boolean })` reads `dir/RESULTS.json` if present,
    merges, then writes both files.

### Task 8: runner wiring
Files: `bench/run.ts`.
- [ ] `:24` default `probes: 'S,D,I,A1,A2'` (R2). `:134` `join(ROOT, f.out!)` → `resolve(ROOT, f.out!)`, so an
  absolute scratch `--out` works.
- [ ] Parity (`:67-83`):
  - Per app, fetch only the probes it serves, using the probe's method and body (with the header
    `content-type: application/json`).
  - Page probes go to `checkParity`. JSON probes go to `checkJsonParity` with the expected values: A1 `data.types`,
    A2 `{ ok: true, id: 25 }`.
- [ ] Pairs (`:100`): `shuffle(probeIds).flatMap(p => shuffle(apps.filter(a => serves(a.id, p))))`. No pairs → `die(1, …)`.
- [ ] Measure loop (`:105-124`):
  - Page probes are unchanged.
  - JSON probes run identity only. For each `c` of `[conn, 1]`: a discarded warm-up at `c`, then the measured run
    with `{ method, body }`, then push `{ …, enc: 'identity', conn: c }`.
  - Read `a.distribution()` after the `c=conn` row and before `c=1`, because one connection always lands on one
    process.
- [ ] Balance verdicts per app (`:104,118-122`): `bunServeBalanced` only from `bun-serve`, `elysiaBunBalanced` only
  from `elysia-bun`.
- [ ] `brustSanity` (`apps.ts:32-44`) for A1/A2: a second GET/POST answers without an `x-brust-cache` header (actions
  never reach L1).
- [ ] Header (`:129-133`): the page header's `apps`/`budgets` list only apps that served a measured page probe. The
  actions header is built the same way, with `elysia-bun: procs=<N>`. `writeResults(outDir, results, { page, actions })`.
  The final print adds `renderActionsVerdict` when A probes ran.
- [ ] Smoke run, not committed:
  `BRUST_RELEASE_ADDON=1 BENCH_LOCK_WS=838f12fb-70c1-41b7-acf2-d4065cf6bb64 BENCH_LOCK_ID='beta1-bench-elysia <agent>' bun run bench --apps brust,elysia-bun,bun-serve --probes S,A1,A2 --dur 2s --warmup 1s --enc identity --out $SCRATCH/smoke`.
  The guard needs the addon declaration even on debug, and these numbers are not results.
  - Expect `parity S: brust = bun-serve ✓`, `parity A1: brust = elysia-bun ✓` and `parity A2 …`.
  - Expect 2 S rows and 8 A rows (2 apps × 2 probes × c=120 and c=1), and both verdict blocks printed.
  - `git status bench/RESULTS.*` must be clean.

### Task 9: measurement (release addon, host lock)
- [ ] `cd packages/brust && bun run build` (RELEASE). Do not run `build:debug` until this task is done.
- [ ] R9 A/B. Four runs, interleaved B0 A1 B0 A1:
  - B0 = `sed -i '' '/^\[actions\]/,$d' bench/apps/brust/brust.toml` (`[actions]` is the last table).
  - A1 = `git checkout bench/apps/brust/brust.toml`.
  - Each run: `BRUST_RELEASE_ADDON=1 BENCH_LOCK_WS=838f12fb-70c1-41b7-acf2-d4065cf6bb64 BENCH_LOCK_ID='beta1-bench-elysia <agent>' bun run bench --apps brust --probes S,D,I --enc identity --out $SCRATCH/ab/<run>`.
  - Table the S/D/I identity rps, compute the paired median Δ, and apply R9. `git diff --exit-code bench/apps/brust/brust.toml` afterwards.
- [ ] Committed run:
  `BRUST_RELEASE_ADDON=1 BENCH_LOCK_WS=838f12fb-70c1-41b7-acf2-d4065cf6bb64 BENCH_LOCK_ID='beta1-bench-elysia <agent>' bun run bench --apps brust,elysia-bun --probes A1,A2`.
  - Exit 0 is expected. Exit 2 means the host is busy: wait and retry, and never bypass the check.
  - Check: `jq 'del(.actions)' bench/RESULTS.json | diff - <(git show v2:bench/RESULTS.json | jq .)` → no output.
  - Check: `git diff bench/RESULTS.md` → only added lines (the Actions section).
  - Commit `bench/RESULTS.{json,md}` with the run's seed in the message.
- [ ] Afterwards, `cd packages/brust && bun run build:debug` again for the gates.

### Task 10: docs
Files: `bench/README.md`, `bench/apps/_shared/pages.md`.
- [ ] README:
  - The title, and a probes table row each for A1 and A2.
  - An "Actions (A1/A2)" subsection:
    - The shared module (R7 mount).
    - c=120 and c=1, identity only.
    - JSON parity.
    - R6 (function handlers; the Bun adapter's native static promotion is deliberately not exercised).
    - The equal-budget note: brust = Rust tokio threads (= cores) + N workers, elysia-bun = N Bun processes.
      Neither is CPU-equal.
    - The macOS `reusePort` balance label.
    - Why next (no Elysia; a Route Handler would be different code), bun-serve (no-framework page ceiling) and
      brust-01x (0.1.x actions are `defineActions`, not Elysia) are skipped.
  - Ports: `+5 elysia-bun`, ctrl `+40…`.
  - Reading RESULTS: the actions verdict line.
- [ ] `pages.md`: a short "A1/A2 — JSON contract" section with the two bodies.

### Task 11: gates and READY
- [ ] Run every command in §6 and paste each tail into the note.

## 5. Acceptance

- [ ] `bun check -p bench && bun test bench/lib` → 0 fail. The new tests are in oha, probes, parity, report and
      actions-app.
- [ ] `cd bench/apps/brust && bun test` → 1 pass, with the `m.actions` assert.
- [ ] `ls node_modules/.bun | grep -c '^elysia@'` → `1`.
- [ ] `git diff v2 -- bench/lib/fixtures/results.json scripts docs packages crates package.json` → empty.
- [ ] `jq 'del(.actions)' bench/RESULTS.json | diff - <(git show v2:bench/RESULTS.json | jq .)` → empty.
      `jq '.actions.measurements | length' bench/RESULTS.json` → `8` (2 apps × 2 probes × 2 conns).
      `jq '[.actions.measurements[].nums.errors] | add'` → `0`.
- [ ] `bench/RESULTS.md` has an `## Actions` section with two tables and the `actions  :` line. The page tables are
      byte-identical to v2.
- [ ] `bun run m2-exit && git diff --exit-code docs/plans/m2-exit-report.md && bun test scripts/m2-exit` → green.
- [ ] `git apply --check bench/attribution.patch` → exit 0.
- [ ] The note's R9 A/B table passes R9.
- [ ] A reviewer rerun is optional (manual):
      `bun run bench --apps brust,elysia-bun --probes A1,A2 --dur 3s --out <scratch>` reproduces parity ✓.

## 6. Gates

`cargo fmt --check` and `cargo clippy` are untouched (no Rust edits). Run:
`bun install --frozen-lockfile` · `cd packages/brust && bun run build:debug && bun run typecheck && bun test` (sanity
only; nothing in packages changed) · `bun check -p bench` · `bun check -p bench/apps/next` ·
`bun build --no-bundle bench/run.ts > /dev/null` · `bun test bench/lib` · `cd bench/apps/brust && bun test && bun run typecheck` ·
`bun run m2-exit && git diff --exit-code docs/plans/m2-exit-report.md` · `bun test scripts/m2-exit` ·
`git apply --check bench/attribution.patch` · `bun test --timeout 120000 tests/server/pokedex.test.ts`.
The pokedex test resolves elysia, and the new `bun.lock` must not change its copy.

## 7. Risk ledger

| # | Risk | How it shows |
|---|---|---|
| 1 | A second elysia copy under the isolated linker (peer hash differs per workspace) | Worker boot: `the default export is not an Elysia app … two copies of elysia`; `grep -c '^elysia@'` ≠ 1. Fix it in the package.json deps (same `@types/bun`/`typescript` ranges as pokedex), not in `packages/` |
| 2 | `_shared/actions-app.ts` cannot resolve `elysia` (R8 not applied) | `bun check -p bench` or the elysia-bun spawn: `Cannot find package 'elysia' from …/_shared/actions-app.ts` |
| 3 | elysia-bun copies don't balance on macOS | The run prints `elysia-bun A1: per-process requests …— 1-proc`. Expected on this host. It must be labelled, not hidden |
| 4 | The c=1 balance read pollutes the verdict | Balance is read before the c=1 row (Task 8); the `per-process requests` log line must print before the `c=1` row in the run log (paste it) |
| 5 | Elysia's Bun adapter promotes `/types` natively (a value handler slipped in) | A1 elysia-bun rps jumps far above A2; `servedCount()` stays 0 in the Task 6 test |
| 6 | The merge rewrites `.measurements` (float formatting, key order) | The Task 9 `jq … diff` is non-empty; the m2-exit report diffs |
| 7 | `[actions]` shifts S/D/I (heap, worker boot) | The R9 A/B fails → STOP + challenge with the table |
| 8 | Debug addon measured | The guard cannot tell. The note must show `bun run build` in Task 9 and the `.node` mtime |
| 9 | Host busy or another bench holds the lock | Exit 2, or the lock message names the holder. Wait; never kill someone else's process |
| 10 | Elysia beta API drift (constructor config type, `listen` callback) | Typecheck/test failure in Tasks 5-6. Pinned exact `2.0.0-beta.30` |

## 8. Reporting

`conclave task note 838f12fb-70c1-41b7-acf2-d4065cf6bb64 beta1-bench-elysia "READY lane/beta1-bench-elysia @<sha> …"`. The note contains:
```
READY lane/beta1-bench-elysia @ <sha> (base v2 @ <sha>)
rulings: R1 <no 1-proc row|…> · R2 <default incl.|…> · R3 -d + content-type · R4 actions block + merge · R5 patch untouched · R6 fn handlers · R7 prefix mount · R8 bench + brust deps · R9 <A/B|code-only>
anchors: <none|ANCHOR …>
tests: oha +1 · probes +<n> · parity +<n> · report +<n> · actions-app +<n> · bench/apps/brust build.test (+actions assert)
elysia: one copy (node_modules/.bun/elysia@2.0.0-beta.30+<hash>)
R9 A/B (identity rps, brust only, seeds …): S b/a/b/a … Δ … · D … · I … → pass
RESULTS (seed <n>, load <x>, elysia-bun balanced=<bool>, release addon mtime <…>):
  A1 c=120 brust <rps> p99 <ms> · elysia-bun <rps> p99 <ms> · c=1 p50 brust <µs> · elysia-bun <µs>
  A2 (same)
  verdict: <paste the actions line>
page block: byte-identical (jq diff empty) · m2-exit report unchanged
gates: <paste tails>
```
Escalate with `conclave task challenge 838f12fb-70c1-41b7-acf2-d4065cf6bb64 beta1-bench-elysia "<what, evidence>"`
for any of these: R9 failing after the third pair, a need to touch `packages/**`/`crates/**` (for example, an
actions bridge defect seen at c=120), or any change to `.measurements` that the merge cannot avoid. Do not work
around one silently.
