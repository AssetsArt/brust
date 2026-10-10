# m3b-bench-suite — bench suite v2 implementation plan

owner: 22499151-e133-4508-b358-d7fa4d2851c3 · authority: in-loop · base: m3p · escalation: lead Detoro via task challenge

> For agentic workers: REQUIRED SUB-SKILL — use `superpowers:executing-plans` (or `superpowers:subagent-driven-development` when dispatched per task) and `superpowers:test-driven-development` for every task below. Each task is red → green → commit. Never skip the "run, expected output" step.

**Goal.** Replace `bench/run.ts` with a standalone benchmark suite under `bench/` that runs the SAME three pages (`/types`, `/dex?nocache=1`, `/team?nocache=1`) on brust v2, Bun.serve + `renderToString`, Next.js 16.4.0 (standalone, Node 22) and optionally brust 0.1.x, checks page parity before any load, drives `oha`, and writes `bench/RESULTS.json` + `bench/RESULTS.md` from numbers only, including the computed verdict block (F68 bar / 2× Next sanity / Bun.serve ceiling).

**Architecture.** `bench/run.ts` is a thin CLI over five libraries in `bench/lib/`: `guard.ts` (refuse to measure on a bad host), `app.ts` + `apps.ts` (AppSpec: build / start / port scrape / stop, one spec per app), `oha.ts` (spawn + parse `oha` JSON), `parity.ts` (normalize `<main>` → tags + text, diff), `report.ts` (RESULTS.json/.md + verdict math). The four apps live in `bench/apps/<name>/` and share ONE data file (`apps/_shared/data.json`, generated from `examples/pokedex/data/pokedex.json`) and ONE markup contract (`apps/_shared/pages.md`). Every library is pure where it can be (parse / verdict / normalize take data, not processes) so CI unit-tests them on fixtures without ever running the bench.

**Tech Stack.** Bun canary 1.4.3 (runner, bun-serve app, brust app, tests via `bun test`, typecheck via `bun check`), Node 22 (Next.js runtime only), `oha` 1.11 on PATH, Next.js 16.4.0 + React 19, `@brust/core` (workspace), optional 0.1.x checkout via `BRUST_01X_DIR`.

**Spec path.** `docs/design/2026-10-10-m3-perf-bench-design.md` §1 (whole), §4 (lane row `m3b-bench-suite`), §6, §7. This plan implements §1 exactly; §2/§3 (levers) are other lanes.

## Global Constraints

- Lane: `lane/m3b-bench-suite` branched from `m3p`; worktree `../brust-lane-m3b-bench-suite` (`git -C ~/code/brust-m3p worktree add ../brust-lane-m3b-bench-suite -b lane/m3b-bench-suite m3p`).
- NO PR: when every task is READY, post READY on the Conclave task; the lead merges the lane into `m3p`.
- Docs-only commits in the lane are fine (docs rule §7).
- Commit with `git add <paths>` / `git commit`; NEVER `git add -A` at the repo root (the addon `*.node`, `dist/`, `.next/` must never enter git).
- Every commit message ends with the line: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
- Next.js version is exactly `"next": "16.4.0"` with `react` / `react-dom` `^19.2.0`; App Router; `output: 'standalone'`; production only: `next build` then `node <standalone>/server.js` with `PORT` + `HOSTNAME` env; Node ≥ 22 guarded (exit 1 otherwise). Never `next dev`, never Next on Bun.
- Bun: the workspace Bun (canary 1.4.3); `bun check` is the typechecker; every new package has `"typecheck": "bun check"`.
- Probes: `S` = `/types` (18 type tiles, cacheable: brust `cache: { ttl_seconds: 3600, tags: ['types'] }` — the spec's `l1: '1h'` shorthand is this field in the real `RouteCacheConfig`, see `packages/brust/src/routes.ts`; Next static), `D` = `/dex?nocache=1` (loader reads `_shared/data.json`, 151 rows, `TypeBadge` per row; brust `cache: { ttl_seconds: 60, bypass: 'query(nocache)', tags: ['dex'] }` so `?nocache=1` is the MISS path every request; Next `export const dynamic = 'force-dynamic'`), `I` = `/team?nocache=1` (ONE interactive `Counter` island using `useReducer`; brust react tier; Next `'use client'`; same `bypass`). Non-brust apps ignore `?nocache`.
- Load: `oha -c 120 -z 10s --no-tui --output-format json -H accept-encoding:identity` is the bar; gzip (`-H accept-encoding:gzip`) is a second pass; 1 s settle + a discarded 3 s warm-up per (app, probe); the server is restarted per (app, probe); app order and probe order are shuffled per run with a seed printed and stored.
- Load guard: 1-min load average > cores → print and `exit 2`. `BRUST_RELEASE_ADDON=1` must be set (declaration guard; exit 1 otherwise). `oha` must be on PATH (exit 1). Node ≥ 22 only when the `next` app is selected (exit 1).
- `BRUST_01X_DIR` optional: unset → the `brust-01x` app is skipped with a printed line `[bench] brust-01x: skipped (BRUST_01X_DIR unset)` and the F68 line reads `NOT MEASURED`.
- Parity (§1.4) runs before any load: normalize = drop `<script>`/`<link>`/`<style>`/`<template>` and HTML comments, unwrap island host wrappers (`<brust-island>`, `[data-brust-island]`), drop every attribute (this subsumes `data-*`, `x-*` and hash-looking `id`s), decode entities, collapse whitespace; compare the text content and the tag sequence of `<main>` across apps per probe; a mismatch aborts the run (exit 1) with a diff.
- Report (§1.5): `RESULTS.json` (raw, every oha JSON kept) + `RESULTS.md` = header (date, host, cores, versions, seed, load at start) + one table per probe + the verdict block, EXACTLY: `bar F68  : v2 vs 0.1.x  D +x.x%  I +y.y%   → MET / NOT MET` · `sanity   : v2 vs next   S ×a  D ×b  I ×c   → MET / NOT MET (≥ 2×)` · `ceiling  : v2 / bun-serve  D p%  I q%        (target D ≥ 80%)`. NO hand-written prose in generated files; `bench/README.md` carries the method.
- CI: add `bun check -p bench`, `bun build --no-bundle bench/run.ts > /dev/null` (already there), and `bun test bench/lib` to the existing `server` job in `.github/workflows/ci.yml`; keep the PR-only trigger; the bench itself never runs in CI.
- Workspaces: `bench/apps/brust`, `bench/apps/bun-serve`, `bench/apps/next` are added to the root `workspaces` (explicitly, not `bench/apps/*`: `_shared` and `brust-01x` carry no package.json). Reason: `@brust/core` is `workspace:*` (only resolvable inside the workspace), `bun check -p bench` needs `next`'s types installed by the root `bun install`, and one lockfile keeps CI's `--frozen-lockfile` honest. The 0.1.x app is NOT a workspace member: it is rsync'd into `$BRUST_01X_DIR/bench/apps/m3-01x/` at run time and imports the 0.1.x runtime relatively, exactly like 0.1.x's own `bench/apps/brust`.
- Keep `bench/attribution.ts` + `bench/attribution.patch` untouched (they measure v2 stages). Delete today's `bench/run.ts`; rewrite `bench/README.md`. The committed `bench/RESULTS.md` / `RESULTS.json` are LEFT as they are (old runner) and the README says so until the first real run on this host replaces them (Task 13).

## Review Focus

| # | input class / failure mode | the test that pins it | owner task |
|---|---|---|---|
| 1 | Parity false NEGATIVE from whitespace / indentation / React `<!-- -->` text-node markers / `&#x27;` vs `&#39;` / `<brust-island>` wrapper — a correct page reported as a mismatch, so the bench never runs | `bench/lib/parity.test.ts`: `brust-style and next-style fixtures normalize equal`, `0.1.x div[data-brust-island] wrapper is unwrapped` | 9 |
| 2 | Parity false POSITIVE — a page that renders fewer rows or different text passes | `parity.test.ts`: `a missing row is a mismatch with a diff naming index and both values`, `different text content is a mismatch` | 9 |
| 3 | `oha` absent, or its JSON shape read wrong (p50 in seconds, `errorDistribution` counting deadline truncation as errors) → rps/latency columns silently wrong | `oha.test.ts`: `parseOha(fixture)` pins rps, p50 ms, total from status sum, errors EXCLUDING "aborted due to deadline"; `guard.test.ts`: `oha missing → exit 1 verdict` | 1, 2 |
| 4 | Next.js standalone server path (`outputFileTracingRoot` moves `server.js` under `.next/standalone/bench/apps/next/`), port collision from a leaked process, Node < 22 | `app.test.ts`: `startApp rejects when the ready line never comes and the child is killed`; `apps.ts` `nextServerJs()` checks both candidate paths and throws naming them; `guard.test.ts`: `node 20 with next selected → exit 1` | 3, 7, 2 |
| 5 | brust app misconfig: `/dex?nocache=1` served as an L1 HIT (bypass missing) or `/types` never HIT → probe D/S measure the wrong path | `run.ts` `brustSanity()` asserts `x-brust-cache` per probe before the load (`HIT` on the 2nd `/types`, never `HIT` on `?nocache=1`) and aborts; `bench/apps/brust/test/build.test.ts` pins the manifest `cache` objects | 6, 11 |
| 6 | Load guard bypass: a run started on a busy host writes RESULTS that lie | `guard.test.ts`: `load > cores → code 2`; `run.ts` has NO flag to skip the guard; `RESULTS.md` header records `loadavg` | 2, 11 |

## Dispatch table

| slug-task | tier | role | deps | acceptance (gate commands + READY evidence) |
|---|---|---|---|---|
| m3b-01-oha | routine | implementer | — | `bun test bench/lib/oha.test.ts` green (4 tests); `bun check -p bench` green; READY = test output pasted |
| m3b-02-guard | routine | implementer | — | `bun test bench/lib/guard.test.ts` green (6 tests); READY = output |
| m3b-03-app | standard | implementer | — | `bun test bench/lib/app.test.ts` green (3 tests, drives the fixture fake server); READY = output |
| m3b-04-shared | routine | implementer | — | `bun bench/apps/_shared/gen-data.ts && git diff --exit-code bench/apps/_shared/data.json`; `bun test bench/lib/data.test.ts`; READY = both outputs |
| m3b-05-bun-serve | routine | implementer | 04 | `bun bench/apps/bun-serve/index.ts` prints the listening line; `curl -s :38202/dex \| grep -c '<tr>'` = 152; READY = curl counts for the 3 pages |
| m3b-06-brust | standard | implementer | 04 | `cd bench/apps/brust && bun test` (manifest test) green; `brust build && brust start --port 38201` then the three curls + `x-brust-cache` header check; READY = header evidence |
| m3b-07-next | standard | implementer | 04 | `cd bench/apps/next && bun run build` ok; `PORT=38203 node <standalone>/server.js` + three curls; `bun check -p bench/apps/next`; READY = curl counts + the standalone path found |
| m3b-08-brust-01x | standard | implementer | 04, 03 | with `BRUST_01X_DIR=~/code/brust`: `bun bench/run.ts --apps brust-01x --probes S --dur 2s` parity passes; without it: the skip line prints; READY = both outputs |
| m3b-09-parity | standard | implementer | — | `bun test bench/lib/parity.test.ts` green (7 tests); READY = output |
| m3b-10-report | standard | implementer | 01 | `bun test bench/lib/report.test.ts` green (6 tests, verdict lines byte-exact); READY = output |
| m3b-11-run | complex | implementer | 01–10 | `bun check -p bench`; `bun build --no-bundle bench/run.ts`; `bun bench/run.ts --apps bun-serve,brust --probes S --dur 2s` writes RESULTS.*; old `bench/run.ts` gone, README rewritten; READY = the printed table |
| m3b-12-ci | routine | implementer | 11 | `bun install` clean (lockfile updated), `bun check -p bench`, `bun test bench/lib`, `make -n build` still resolves; READY = ci.yml diff + outputs |
| m3b-13-first-run | standard | implementer | 12 | on this host, load < cores: `BRUST_RELEASE_ADDON=1 BRUST_01X_DIR=~/code/brust bun run bench` exit 0; RESULTS.md committed; READY = the verdict block + per-probe table pasted into the task note |

Tier rule: routine = no design choice left (copy the code below); standard = must adapt to what the real tool prints / what the compiler accepts; complex = wires every module and owns the exit codes.

## File structure

| path | responsibility |
|---|---|
| `bench/README.md` (rewrite) | how to run, fairness rules, how to read RESULTS, stale-results note |
| `bench/run.ts` (replace) | CLI: flags → guard → build → parity → shuffled measure loop → report |
| `bench/tsconfig.json` (new) | `bun check -p bench` project: runner + lib + brust/bun-serve apps (next has its own; 01x + attribution.ts excluded) |
| `bench/lib/oha.ts` | `ohaArgs`, `parseOha`, `runOha` |
| `bench/lib/oha.test.ts` + `bench/lib/fixtures/oha.json` | parse pinned on a real oha 1.11 JSON |
| `bench/lib/guard.ts` | `evaluateGuards` (pure) + `probeHost` (effects) |
| `bench/lib/guard.test.ts` | verdict table |
| `bench/lib/app.ts` | `AppSpec`, `RunningApp`, `startApp`, `waitForLine`, `stopApp` |
| `bench/lib/app.test.ts` + `bench/lib/fixtures/fake-server.ts` + `fixtures/never-ready.ts` | port scrape, stop, timeout |
| `bench/lib/apps.ts` | the four `AppSpec`s (`brust`, `bun-serve`, `next`, `brust-01x`) + `nextServerJs()` + `brustSanity()` |
| `bench/lib/probes.ts` | `PROBES` (S/D/I) + `ProbeId` |
| `bench/lib/random.ts` | seeded `mulberry32` + `shuffle` |
| `bench/lib/parity.ts` | `normalizeMain`, `diffParity` |
| `bench/lib/parity.test.ts` | review-focus 1 & 2 |
| `bench/lib/report.ts` | `Results` types, `computeVerdict`, `renderVerdict`, `renderMarkdown` |
| `bench/lib/report.test.ts` + `bench/lib/fixtures/results.json` | verdict math byte-exact |
| `bench/lib/data.test.ts` | `_shared/data.json` is the generator's output |
| `bench/apps/_shared/gen-data.ts` | pokedex.json → data.json (151 rows + 18 types) |
| `bench/apps/_shared/data.json` | the one dataset every app reads |
| `bench/apps/_shared/pages.md` | the markup contract (human-readable parity) |
| `bench/apps/bun-serve/{package.json,index.ts,components/*.tsx,lib/data.ts}` | Bun.serve + renderToString ceiling |
| `bench/apps/brust/{package.json,brust.toml,routes.tsx,lib/*.ts,components/*.tsx,pages/*.tsx,test/build.test.ts}` | brust v2 app |
| `bench/apps/next/{package.json,next.config.ts,tsconfig.json,.gitignore,app/**,components/*.tsx,lib/data.ts}` | Next.js 16.4.0 standalone app |
| `bench/apps/brust-01x/{index.ts,routes.tsx,components/*.tsx,pages/*.tsx,lib/*.ts}` | 0.1.x app, rsync'd into `$BRUST_01X_DIR/bench/apps/m3-01x/` |
| `package.json` (root), `Makefile`, `.gitignore`, `.github/workflows/ci.yml` | workspace entries, PKG_FILES glob, `.next/` ignore, CI gates |

---

### Task 1: `lib/oha.ts` — spawn oha, parse its JSON (fixture-pinned)

**Files**
- Create: `bench/tsconfig.json`, `bench/lib/oha.ts`, `bench/lib/oha.test.ts`, `bench/lib/fixtures/oha.json`

**Interfaces**
- Produces:
  ```ts
  export type Encoding = 'identity' | 'gzip'
  export interface OhaOpts { conn: number; dur: string; enc: Encoding }
  export interface OhaNums { rps: number; p50: number; p95: number; p99: number; total: number; errors: number }
  export interface OhaResult extends OhaNums { raw: unknown }
  export function ohaArgs(url: string, o: OhaOpts): string[]
  export function parseOha(json: unknown): OhaResult
  export async function runOha(url: string, o: OhaOpts): Promise<OhaResult>
  ```
- Consumes: `oha` 1.x JSON (`summary.requestsPerSec`, `latencyPercentiles.pNN` in SECONDS, `statusCodeDistribution`, `errorDistribution`).

- [ ] **Step 1: lane + project file**

```bash
git -C ~/code/brust-m3p worktree add ../brust-lane-m3b-bench-suite -b lane/m3b-bench-suite m3p
cd ~/code/brust-lane-m3b-bench-suite && mkdir -p bench/lib/fixtures
```

`bench/tsconfig.json` (attribution.ts stays out: it is untouched and was never typechecked):

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"], "jsx": "react-jsx",
    "strict": true, "noUncheckedIndexedAccess": true, "noEmit": true,
    "types": ["bun"], "skipLibCheck": true, "resolveJsonModule": true,
    "allowImportingTsExtensions": true, "verbatimModuleSyntax": true
  },
  "include": ["run.ts", "lib", "apps/_shared", "apps/bun-serve", "apps/brust"],
  "exclude": ["attribution.ts", "apps/next", "apps/brust-01x", "**/node_modules", "**/dist", "**/.next"]
}
```

- [ ] **Step 2: fixture** — `bench/lib/fixtures/oha.json` is a REAL capture (`oha -c 4 -z 1s --no-tui --output-format json -H accept-encoding:identity http://127.0.0.1:<port>/` against a one-line `Bun.serve`); the keys below are the ones the parser reads, keep the rest as captured:

```json
{
  "summary": { "successRate": 1.0, "total": 1.003600583, "slowest": 0.009679042, "fastest": 0.000021625, "average": 0.0000633, "requestsPerSec": 61997.77187654343, "totalData": 3048682, "sizePerRequest": 49, "sizePerSec": 3037744.35 },
  "responseTimeHistogram": {},
  "latencyPercentiles": { "p10": 0.000038875, "p25": 0.000047458, "p50": 0.000058958, "p75": 0.000073292, "p90": 0.000091833, "p95": 0.000103583, "p99": 0.000125375, "p99.9": 0.000232917, "p99.99": 0.0011495 },
  "rps": {},
  "details": {},
  "statusCodeDistribution": { "200": 62218 },
  "errorDistribution": { "aborted due to deadline": 3 }
}
```

- [ ] **Step 3: failing test** — `bench/lib/oha.test.ts`

```ts
import { describe, expect, test } from 'bun:test'
import fixture from './fixtures/oha.json'
import { ohaArgs, parseOha } from './oha'

describe('parseOha', () => {
  test('rps and latencies (seconds → ms) from the oha 1.x shape', () => {
    const r = parseOha(fixture)
    expect(r.rps).toBeCloseTo(61997.77, 1)
    expect(r.p50).toBeCloseTo(0.058958, 6)
    expect(r.p95).toBeCloseTo(0.103583, 6)
    expect(r.p99).toBeCloseTo(0.125375, 6)
  })
  test('total = sum of statusCodeDistribution; deadline truncation is not an error', () => {
    const r = parseOha(fixture)
    expect(r.total).toBe(62218)
    expect(r.errors).toBe(0)
  })
  test('real errors (connection / non-deadline) are counted', () => {
    const r = parseOha({ ...fixture, statusCodeDistribution: { '200': 10, '500': 2 }, errorDistribution: { 'connection refused': 4, 'aborted due to deadline': 1 } })
    expect(r.total).toBe(12)
    expect(r.errors).toBe(4)
  })
  test('a non-object input throws with the offending shape', () => {
    expect(() => parseOha('nope')).toThrow(/oha json/)
  })
})

describe('ohaArgs', () => {
  test('bar flags, encoding header, url last', () => {
    expect(ohaArgs('http://127.0.0.1:1/x', { conn: 120, dur: '10s', enc: 'identity' })).toEqual([
      '-c', '120', '-z', '10s', '--no-tui', '--output-format', 'json', '-m', 'GET', '-H', 'accept-encoding:identity', 'http://127.0.0.1:1/x',
    ])
    expect(ohaArgs('u', { conn: 1, dur: '3s', enc: 'gzip' })).toContain('accept-encoding:gzip')
  })
})
```

Run: `cd ~/code/brust-lane-m3b-bench-suite && bun test bench/lib/oha.test.ts` → expected: `error: Cannot find module './oha'` (red).

- [ ] **Step 4: implementation** — `bench/lib/oha.ts`

```ts
// bench/lib/oha.ts — one oha run → numbers. Pure parse (`parseOha`) + the spawn (`runOha`).
export type Encoding = 'identity' | 'gzip'
export interface OhaOpts { conn: number; dur: string; enc: Encoding }
export interface OhaNums { rps: number; p50: number; p95: number; p99: number; total: number; errors: number }
export interface OhaResult extends OhaNums { raw: unknown }

/** Requests oha could not finish before `-z` elapsed: a duration boundary, not a failure. */
const DEADLINE = 'aborted due to deadline'

export function ohaArgs(url: string, o: OhaOpts): string[] {
  return ['-c', String(o.conn), '-z', o.dur, '--no-tui', '--output-format', 'json', '-m', 'GET', '-H', `accept-encoding:${o.enc}`, url]
}

const sum = (rec: unknown, skip?: string): number =>
  typeof rec === 'object' && rec !== null
    ? Object.entries(rec as Record<string, unknown>).reduce((a, [k, v]) => (k === skip || typeof v !== 'number' ? a : a + v), 0)
    : 0

export function parseOha(json: unknown): OhaResult {
  if (typeof json !== 'object' || json === null) throw new Error(`oha json: expected an object, got ${JSON.stringify(json)}`)
  const j = json as { summary?: { requestsPerSec?: number }; latencyPercentiles?: Record<string, number>; statusCodeDistribution?: unknown; errorDistribution?: unknown }
  const rps = j.summary?.requestsPerSec
  if (typeof rps !== 'number') throw new Error('oha json: summary.requestsPerSec missing')
  const ms = (k: string): number => {
    const v = j.latencyPercentiles?.[k]
    if (typeof v !== 'number') throw new Error(`oha json: latencyPercentiles.${k} missing`)
    return v * 1000
  }
  return { rps, p50: ms('p50'), p95: ms('p95'), p99: ms('p99'), total: sum(j.statusCodeDistribution), errors: sum(j.errorDistribution, DEADLINE), raw: json }
}

export async function runOha(url: string, o: OhaOpts): Promise<OhaResult> {
  const p = Bun.spawn(['oha', ...ohaArgs(url, o)], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  if (code !== 0) throw new Error(`oha exited ${code} for ${url}:\n${err}`)
  return parseOha(JSON.parse(out))
}
```

Run: `bun test bench/lib/oha.test.ts` → expected `5 pass, 0 fail`. Then `bun check -p bench` → `0 errors` (the project has only these files so far).

- [ ] **Step 5: commit**

```bash
git add bench/tsconfig.json bench/lib/oha.ts bench/lib/oha.test.ts bench/lib/fixtures/oha.json
git commit -m "bench: lib/oha — spawn + parse oha JSON, fixture-pinned

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `lib/guard.ts` — refuse to measure on a bad host

**Files**
- Create: `bench/lib/guard.ts`, `bench/lib/guard.test.ts`

**Interfaces**
- Produces:
  ```ts
  export interface GuardInput { loadavg1: number; cores: number; ohaOnPath: boolean; releaseAddonDeclared: boolean; addonPresent: boolean; nodeVersion: string | null; needNode: boolean }
  export type GuardVerdict = { ok: true } | { ok: false; code: 1 | 2; reason: string }
  export function evaluateGuards(i: GuardInput): GuardVerdict
  export function probeHost(opts: { needNode: boolean; needBrustAddon: boolean }): GuardInput
  ```
- Consumes: `node:os` `loadavg`/`cpus`, `Bun.spawnSync(['oha','--version'])`, `Bun.spawnSync(['node','--version'])`, `packages/brust/native/*.node`.

- [ ] **Step 1: failing test** — `bench/lib/guard.test.ts`

```ts
import { expect, test } from 'bun:test'
import { evaluateGuards, type GuardInput } from './guard'

const good: GuardInput = { loadavg1: 2.5, cores: 10, ohaOnPath: true, releaseAddonDeclared: true, addonPresent: true, nodeVersion: 'v22.23.1', needNode: true }

test('a quiet host with every tool passes', () => {
  expect(evaluateGuards(good)).toEqual({ ok: true })
})
test('1-min load average above the core count → exit 2 (busy host)', () => {
  const v = evaluateGuards({ ...good, loadavg1: 10.5 })
  expect(v).toMatchObject({ ok: false, code: 2 })
  expect((v as { reason: string }).reason).toMatch(/load average 10.5 > 10 cores/)
})
test('load equal to cores is still allowed', () => {
  expect(evaluateGuards({ ...good, loadavg1: 10 })).toEqual({ ok: true })
})
test('oha missing → exit 1 with the install hint', () => {
  expect(evaluateGuards({ ...good, ohaOnPath: false })).toMatchObject({ ok: false, code: 1, reason: expect.stringMatching(/cargo install oha/) })
})
test('BRUST_RELEASE_ADDON unset or addon absent → exit 1', () => {
  expect(evaluateGuards({ ...good, releaseAddonDeclared: false })).toMatchObject({ ok: false, code: 1, reason: expect.stringMatching(/BRUST_RELEASE_ADDON=1/) })
  expect(evaluateGuards({ ...good, addonPresent: false })).toMatchObject({ ok: false, code: 1, reason: expect.stringMatching(/bun run build/) })
})
test('Node < 22 or missing only matters when next is selected', () => {
  expect(evaluateGuards({ ...good, nodeVersion: 'v20.11.0' })).toMatchObject({ ok: false, code: 1, reason: expect.stringMatching(/Node >= 22/) })
  expect(evaluateGuards({ ...good, nodeVersion: null })).toMatchObject({ ok: false, code: 1 })
  expect(evaluateGuards({ ...good, nodeVersion: null, needNode: false })).toEqual({ ok: true })
})
```

Run: `bun test bench/lib/guard.test.ts` → red (`Cannot find module './guard'`).

- [ ] **Step 2: implementation** — `bench/lib/guard.ts`

```ts
// bench/lib/guard.ts — fairness rules the runner enforces (spec §1.3). `evaluateGuards` is pure;
// `probeHost` collects the inputs. Exit 2 = busy host (retry later), exit 1 = missing tool/declaration.
import { existsSync, readdirSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { join, resolve } from 'node:path'

export interface GuardInput {
  loadavg1: number
  cores: number
  ohaOnPath: boolean
  /** BRUST_RELEASE_ADDON=1: the operator asserts the addon was built with `bun run build`, not build:debug (the runner cannot tell). */
  releaseAddonDeclared: boolean
  addonPresent: boolean
  nodeVersion: string | null
  /** Only the Next.js app runs on Node. */
  needNode: boolean
}
export type GuardVerdict = { ok: true } | { ok: false; code: 1 | 2; reason: string }

export const MIN_NODE_MAJOR = 22
const major = (v: string | null): number => (v ? Number.parseInt(v.replace(/^v/, ''), 10) : Number.NaN)

export function evaluateGuards(i: GuardInput): GuardVerdict {
  if (i.loadavg1 > i.cores) return { ok: false, code: 2, reason: `host busy: load average ${i.loadavg1} > ${i.cores} cores — refusing to measure` }
  if (!i.ohaOnPath) return { ok: false, code: 1, reason: 'oha not on PATH (cargo install oha)' }
  if (!i.addonPresent) return { ok: false, code: 1, reason: 'no addon: cd packages/brust && bun run build (RELEASE)' }
  if (!i.releaseAddonDeclared) return { ok: false, code: 1, reason: 'set BRUST_RELEASE_ADDON=1 to assert the addon was built with `bun run build`, not build:debug' }
  if (i.needNode && !(major(i.nodeVersion) >= MIN_NODE_MAJOR))
    return { ok: false, code: 1, reason: `Next.js runs on Node >= ${MIN_NODE_MAJOR} (found ${i.nodeVersion ?? 'no node on PATH'})` }
  return { ok: true }
}

const ROOT = resolve(import.meta.dir, '../..')
const version = (cmd: string[]): string | null => {
  try {
    const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' })
    return r.exitCode === 0 ? r.stdout.toString().trim() : null
  } catch {
    return null
  }
}

export function probeHost(opts: { needNode: boolean; needBrustAddon: boolean }): GuardInput {
  const native = join(ROOT, 'packages/brust/native')
  const addonPresent = !opts.needBrustAddon || (existsSync(native) && readdirSync(native).some((f) => f.endsWith('.node')))
  return {
    loadavg1: Math.round((loadavg()[0] ?? 0) * 100) / 100,
    cores: cpus().length,
    ohaOnPath: version(['oha', '--version']) !== null,
    releaseAddonDeclared: !opts.needBrustAddon || process.env.BRUST_RELEASE_ADDON === '1',
    addonPresent,
    nodeVersion: version(['node', '--version']),
    needNode: opts.needNode,
  }
}
```

Run: `bun test bench/lib/guard.test.ts` → `6 pass`.

- [ ] **Step 3: commit**

```bash
git add bench/lib/guard.ts bench/lib/guard.test.ts
git commit -m "bench: lib/guard — load-average, oha, release-addon and Node >= 22 guards

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `lib/app.ts` — AppSpec, spawn, port scrape, stop

**Files**
- Create: `bench/lib/app.ts`, `bench/lib/app.test.ts`, `bench/lib/fixtures/fake-server.ts`, `bench/lib/fixtures/never-ready.ts`, `bench/lib/probes.ts`, `bench/lib/random.ts`

**Interfaces**
- Produces:
  ```ts
  export type AppId = 'brust' | 'bun-serve' | 'next' | 'brust-01x'
  export interface AppSpec {
    id: AppId; label: string; cwd: string; port: number
    available(): { ok: true } | { ok: false; reason: string }
    build(log: (s: string) => void): Promise<void>
    startCmd(): { cmd: string[]; env: Record<string, string>; cwd?: string }
    /** Matched against accumulated stdout; capture group 1 (if any) overrides `port`. */
    ready: RegExp
    version(): Promise<string>
    /** brust only: assert the cache path per probe before load (Review Focus 5). */
    sanity?(base: string, probe: ProbeId): Promise<void>
  }
  export interface RunningApp { base: string; proc: Subprocess; log(): string; stop(): Promise<void> }
  export async function waitForLine(stdout: ReadableStream<Uint8Array>, re: RegExp, timeoutMs: number, onExit: Promise<number>): Promise<{ match: RegExpExecArray; log: () => string }>
  export async function startApp(spec: Pick<AppSpec, 'id' | 'port' | 'startCmd' | 'ready' | 'cwd'>, opts?: { timeoutMs?: number }): Promise<RunningApp>
  export function killAllOnExit(): void
  ```
  `bench/lib/probes.ts`: `export type ProbeId = 'S' | 'D' | 'I'`; `export const PROBES: { id: ProbeId; path: string; what: string }[]`.
  `bench/lib/random.ts`: `export function mulberry32(seed: number): () => number`; `export function shuffle<T>(xs: readonly T[], rnd: () => number): T[]`.

- [ ] **Step 1: fixtures**

`bench/lib/fixtures/fake-server.ts`:

```ts
// A stand-in server for app.test.ts: binds any port, prints the 0.1.x-style listening line, serves one page.
const s = Bun.serve({
  port: Number.parseInt(process.env.FAKE_PORT ?? '0', 10),
  fetch: () => new Response('<html><body><main><h1>fake</h1></main></body></html>', { headers: { 'content-type': 'text/html' } }),
})
console.log(`[fake] listening on http://127.0.0.1:${s.port}`)
process.on('SIGINT', () => { s.stop(true); process.exit(0) })
```

`bench/lib/fixtures/never-ready.ts`:

```ts
// Prints something else and hangs: startApp must time out and kill it.
console.log('[fake] booting, no listening line will ever come')
await new Promise(() => {})
```

- [ ] **Step 2: failing test** — `bench/lib/app.test.ts`

```ts
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { startApp } from './app'
import { mulberry32, shuffle } from './random'

const fixtures = join(import.meta.dir, 'fixtures')
const fake = (file: string, env: Record<string, string> = {}) => ({
  id: 'bun-serve' as const,
  port: 0,
  cwd: fixtures,
  startCmd: () => ({ cmd: ['bun', join(fixtures, file)], env }),
  ready: /listening on http:\/\/127\.0\.0\.1:(\d+)/,
})

test('startApp scrapes the port from stdout, the server answers, stop() ends the child', async () => {
  const app = await startApp(fake('fake-server.ts'))
  expect(app.base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  const r = await fetch(`${app.base}/types`)
  expect(await r.text()).toContain('<main>')
  await app.stop()
  expect(app.proc.exitCode ?? 0).toBeGreaterThanOrEqual(0)
  expect(app.log()).toContain('[fake] listening')
})

test('startApp rejects when the ready line never comes and the child is killed', async () => {
  const t0 = Date.now()
  await expect(startApp(fake('never-ready.ts'), { timeoutMs: 800 })).rejects.toThrow(/not ready after 800 ms[\s\S]*no listening line/)
  expect(Date.now() - t0).toBeLessThan(5000)
})

test('startApp rejects with the log when the child exits before ready', async () => {
  await expect(startApp({ ...fake('fake-server.ts'), startCmd: () => ({ cmd: ['bun', '-e', 'console.log("boom"); process.exit(3)'], env: {} }) })).rejects.toThrow(/exited \(3\) before ready[\s\S]*boom/)
})

test('seeded shuffle is deterministic and a permutation', () => {
  const a = shuffle([1, 2, 3, 4, 5, 6], mulberry32(42))
  const b = shuffle([1, 2, 3, 4, 5, 6], mulberry32(42))
  expect(a).toEqual(b)
  expect([...a].sort()).toEqual([1, 2, 3, 4, 5, 6])
  expect(shuffle([1, 2, 3, 4, 5, 6], mulberry32(7))).not.toEqual(a)
})
```

Run: `bun test bench/lib/app.test.ts` → red.

- [ ] **Step 3: implementation**

`bench/lib/probes.ts`:

```ts
// bench/lib/probes.ts — the three pages every app serves (spec §1.2). `?nocache=1` is honoured by brust only.
export type ProbeId = 'S' | 'D' | 'I'
export interface Probe { id: ProbeId; path: string; what: string }
export const PROBES: readonly Probe[] = [
  { id: 'S', path: '/types', what: 'cacheable: 18 type tiles (brust L1 HIT, Next static)' },
  { id: 'D', path: '/dex?nocache=1', what: 'dynamic SSR: loader reads data.json, 151 rows, TypeBadge per row' },
  { id: 'I', path: '/team?nocache=1', what: 'one interactive Counter island (useReducer), SSR + hydration tags' },
]
export const probe = (id: ProbeId): Probe => PROBES.find((p) => p.id === id) ?? (() => { throw new Error(`unknown probe ${id}`) })()
```

`bench/lib/random.ts`:

```ts
// bench/lib/random.ts — seeded order so a run is reproducible from the seed in RESULTS (spec §1.3).
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export function shuffle<T>(xs: readonly T[], rnd: () => number): T[] {
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[out[i], out[j]] = [out[j] as T, out[i] as T]
  }
  return out
}
```

`bench/lib/app.ts`:

```ts
// bench/lib/app.ts — one running app: spawn, wait for its ready line (port scraped from stdout), stop.
// Every child is tracked and killed on runner exit so a failed start never orphans a server.
import type { Subprocess } from 'bun'
import type { ProbeId } from './probes'

export type AppId = 'brust' | 'bun-serve' | 'next' | 'brust-01x'
export interface AppSpec {
  id: AppId
  label: string
  cwd: string
  port: number
  available(): { ok: true } | { ok: false; reason: string }
  build(log: (s: string) => void): Promise<void>
  startCmd(): { cmd: string[]; env: Record<string, string>; cwd?: string }
  ready: RegExp
  version(): Promise<string>
  sanity?(base: string, probe: ProbeId): Promise<void>
}
export interface RunningApp { base: string; proc: Subprocess; log(): string; stop(): Promise<void> }

const CHILDREN = new Set<Subprocess>()
let hooked = false
export function killAllOnExit(): void {
  if (hooked) return
  hooked = true
  process.on('exit', () => { for (const c of CHILDREN) c.kill('SIGKILL') })
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(130))
}

export async function waitForLine(stdout: ReadableStream<Uint8Array>, re: RegExp, timeoutMs: number, onExit: Promise<number>): Promise<{ match: RegExpExecArray; log: () => string }> {
  const reader = stdout.getReader()
  const dec = new TextDecoder()
  let out = ''
  const log = () => out
  const drain = async () => { for (;;) { const r = await reader.read(); if (r.done) return; out += dec.decode(r.value, { stream: true }) } }
  const found = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) throw new Error(`exited (${await onExit}) before ready:\n${out}`)
      out += dec.decode(value, { stream: true })
      const m = re.exec(out)
      if (m) { void drain(); return m }
    }
  })()
  const timer = new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`not ready after ${timeoutMs} ms:\n${out}`)), timeoutMs))
  const exited = onExit.then((code) => { throw new Error(`exited (${code}) before ready:\n${out}`) })
  const match = await Promise.race([found, timer, exited])
  return { match, log }
}

export async function startApp(spec: Pick<AppSpec, 'id' | 'port' | 'startCmd' | 'ready' | 'cwd'>, opts: { timeoutMs?: number } = {}): Promise<RunningApp> {
  killAllOnExit()
  const { cmd, env, cwd } = spec.startCmd()
  const proc = Bun.spawn(cmd, { cwd: cwd ?? spec.cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'inherit' })
  CHILDREN.add(proc)
  const stop = async () => {
    CHILDREN.delete(proc)
    if (proc.exitCode !== null) return
    proc.kill('SIGINT')
    const r = await Promise.race([proc.exited, Bun.sleep(5000).then(() => 'timeout' as const)])
    if (r === 'timeout') { proc.kill('SIGKILL'); await proc.exited }
  }
  let match: RegExpExecArray
  let log: () => string
  try {
    ;({ match, log } = await waitForLine(proc.stdout as ReadableStream<Uint8Array>, spec.ready, opts.timeoutMs ?? 60_000, proc.exited))
  } catch (e) {
    await stop()
    throw new Error(`[${spec.id}] ${(e as Error).message}`)
  }
  const port = match[1] !== undefined ? Number.parseInt(match[1], 10) : spec.port
  return { base: `http://127.0.0.1:${port}`, proc, log, stop }
}
```

Run: `bun test bench/lib/app.test.ts` → `4 pass`. `bun check -p bench` → 0 errors.

- [ ] **Step 4: commit**

```bash
git add bench/lib/app.ts bench/lib/app.test.ts bench/lib/probes.ts bench/lib/random.ts bench/lib/fixtures/fake-server.ts bench/lib/fixtures/never-ready.ts
git commit -m "bench: lib/app — AppSpec, spawn with stdout port scrape, stop, seeded shuffle, probes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `apps/_shared` — data.json generator + pages.md contract

**Files**
- Create: `bench/apps/_shared/gen-data.ts`, `bench/apps/_shared/data.json` (generated), `bench/apps/_shared/pages.md`, `bench/lib/data.test.ts`

**Interfaces**
- Produces `data.json`:
  ```ts
  export interface TypeRow { name: string; label: string; tint: string }
  export interface DexRow { id: number; name: string; displayName: string; num: string; types: string[] }
  export interface BenchData { generatedFrom: string; types: TypeRow[]; pokemon: DexRow[] }
  ```
- Consumes: `examples/pokedex/data/pokedex.json` (`pokemon[].{id,name,types}`), the pokedex `cap`/`pad`/`TYPE_COLOR` rules (copied as code, not imported: the bench must not depend on the example).

- [ ] **Step 1: failing test** — `bench/lib/data.test.ts`

```ts
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import data from '../apps/_shared/data.json'
import { buildData } from '../apps/_shared/gen-data'

test('data.json: 151 rows in dex order, 18 types, derived fields', () => {
  expect(data.pokemon).toHaveLength(151)
  expect(data.pokemon[0]).toEqual({ id: 1, name: 'bulbasaur', displayName: 'Bulbasaur', num: '#0001', types: ['grass', 'poison'] })
  expect(data.pokemon[150]?.num).toBe('#0151')
  expect(data.types).toHaveLength(18)
  expect(data.types[0]).toEqual({ name: 'normal', label: 'Normal', tint: '#9099a1' })
  expect(data.types[3]).toEqual({ name: 'electric', label: 'Electric', tint: '#f5c84b' })
})

test('the committed file is the generator output (regenerate with `bun bench/apps/_shared/gen-data.ts`)', async () => {
  const snap = await Bun.file(join(import.meta.dir, '../../examples/pokedex/data/pokedex.json')).json()
  expect(buildData(snap)).toEqual(data)
})
```

Run: `bun test bench/lib/data.test.ts` → red.

- [ ] **Step 2: generator** — `bench/apps/_shared/gen-data.ts`

```ts
// bench/apps/_shared/gen-data.ts — derive the bench dataset from the pokedex snapshot (run by hand; output committed).
//   bun bench/apps/_shared/gen-data.ts
import { join } from 'node:path'

export interface TypeRow { name: string; label: string; tint: string }
export interface DexRow { id: number; name: string; displayName: string; num: string; types: string[] }
export interface BenchData { generatedFrom: string; types: TypeRow[]; pokemon: DexRow[] }

/** Same table as examples/pokedex/lib/format.ts `tint` — copied so the bench never imports the example. */
export const TINT: Record<string, string> = { normal: '#9099a1', fire: '#ef7444', water: '#4d90d5', grass: '#63bb5b', electric: '#f5c84b', ice: '#74cec0', fighting: '#ce4069', poison: '#ab6ac8', ground: '#d97746', flying: '#8fa8dd', psychic: '#f06fa0', bug: '#90c12c', rock: '#c7b78b', ghost: '#5269ac', dragon: '#0a6dc4', dark: '#5a5366', steel: '#5a8ea1', fairy: '#ec8fe6' }
export const ALL_TYPES = ['normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground', 'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy']
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ')
const pad = (n: number) => `#${String(n).padStart(4, '0')}`

export function buildData(snap: { pokemon: { id: number; name: string; types: string[] }[] }): BenchData {
  return {
    generatedFrom: 'examples/pokedex/data/pokedex.json',
    types: ALL_TYPES.map((name) => ({ name, label: cap(name), tint: TINT[name] ?? '#888888' })),
    pokemon: snap.pokemon.map((p) => ({ id: p.id, name: p.name, displayName: cap(p.name), num: pad(p.id), types: [...p.types] })),
  }
}

if (import.meta.main) {
  const snap = await Bun.file(join(import.meta.dir, '../../../examples/pokedex/data/pokedex.json')).json()
  const out = join(import.meta.dir, 'data.json')
  await Bun.write(out, `${JSON.stringify(buildData(snap), null, 1)}\n`)
  console.log(`[gen-data] wrote ${out}`)
}
```

Run: `bun bench/apps/_shared/gen-data.ts` → `[gen-data] wrote …/data.json`; `bun test bench/lib/data.test.ts` → `2 pass`.

- [ ] **Step 3: contract** — `bench/apps/_shared/pages.md`

```markdown
# Bench pages — the markup contract

Every app serves these three pages. `lib/parity.ts` compares the TAG SEQUENCE and the TEXT of `<main>` after
normalization (scripts/links/styles/comments dropped, island wrappers unwrapped, attributes ignored, whitespace
collapsed, entities decoded). Attributes, class names and the document shell outside `<main>` are free per
framework; everything inside `<main>` below is not. Data: `data.json` (`types[18]`, `pokemon[151]`).

## S — `/types`
<main>
  <h1>Types</h1>
  <ul>
    <li><span data-type="{t.name}" style="background:{t.tint}">{t.label}</span></li>   ← ×18, data.types order
  </ul>
</main>

## D — `/dex` (brust: `?nocache=1` bypasses L1; others ignore the query)
<main>
  <h1>Pokédex</h1>
  <p>151 Pokémon</p>
  <table>
    <thead><tr><th>#</th><th>Name</th><th>Types</th></tr></thead>
    <tbody>
      <tr><td>{p.num}</td><td>{p.displayName}</td><td>{p.types.map(TypeBadge)}</td></tr>   ← ×151, dex order;
    </tbody>                                                                                   TypeBadge = the S span
  </table>
</main>

## I — `/team` (same query rule as D)
<main>
  <h1>Team</h1>
  <p>Pick up to 6.</p>
  <div data-testid="counter"><button type="button">clicks: {n}</button></div>   ← Counter island, n starts at 0
</main>

Counter is the ONE interactive component: `useReducer`, `'use client'` in Next, react tier in brust, an
`<Island ssr hydrate="load">` in 0.1.x, plain `renderToString` in bun-serve (no hydration — it is the ceiling).
Text nodes: React emits `clicks<!-- -->: <!-- -->0`; the normalizer strips comments, so every app yields
"clicks: 0".
```

- [ ] **Step 4: commit**

```bash
git add bench/apps/_shared/gen-data.ts bench/apps/_shared/data.json bench/apps/_shared/pages.md bench/lib/data.test.ts
git commit -m "bench: apps/_shared — data.json generated from the pokedex snapshot + pages.md contract

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `apps/bun-serve` — Bun.serve + `renderToString` (the ceiling)

**Files**
- Create: `bench/apps/bun-serve/package.json`, `index.ts`, `lib/data.ts`, `components/Page.tsx`, `components/TypeBadge.tsx`, `components/Counter.tsx`, `pages/TypesPage.tsx`, `pages/DexPage.tsx`, `pages/TeamPage.tsx`
- Modify: root `package.json` (`workspaces` += `"bench/apps/bun-serve"`)

**Interfaces**
- Produces: HTTP server on `BENCH_PORT` (default 38202) printing `[bun-serve] listening on http://127.0.0.1:<port>`; routes `/types`, `/dex`, `/team` (query ignored), 404 otherwise.
- Consumes: `../_shared/data.json`, `react-dom/server` `renderToString`.

- [ ] **Step 1: package + workspace**

`bench/apps/bun-serve/package.json`:

```json
{
  "name": "@brust/bench-bun-serve",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "start": "bun index.ts", "typecheck": "bun check -p ../.." },
  "dependencies": { "react": "^19.2.0", "react-dom": "^19.2.0" },
  "devDependencies": { "@types/bun": "^1.4.0", "@types/react": "^19.2.0", "@types/react-dom": "^19.2.0", "typescript": "^7.0.2" }
}
```

Root `package.json` → `"workspaces": ["packages/*", "examples/*", "npm/*", "tests/server", "bench/apps/brust", "bench/apps/bun-serve", "bench/apps/next"]` (all three now; Tasks 6/7 create the other two directories before the next `bun install`, so run `bun install` only after Task 7, or add the entries one task at a time — pick the former: add all three lines now, create the two other package.json files in Tasks 6 and 7, then `bun install` in Task 7 Step 1).

- [ ] **Step 2: data + components**

`bench/apps/bun-serve/lib/data.ts`:

```ts
import data from '../../_shared/data.json'
export type TypeRow = (typeof data.types)[number]
export type DexRow = (typeof data.pokemon)[number]
export const TYPES: TypeRow[] = data.types
export const TINT: Record<string, string> = Object.fromEntries(data.types.map((t) => [t.name, t.tint]))
export const LABEL: Record<string, string> = Object.fromEntries(data.types.map((t) => [t.name, t.label]))
/** Re-read per request (D is "loader reads data.json"): a fresh array, like a loader would return. */
export const loadDex = (): DexRow[] => data.pokemon.map((p) => ({ ...p }))
```

`bench/apps/bun-serve/components/TypeBadge.tsx`:

```tsx
import { LABEL, TINT } from '../lib/data'
export default function TypeBadge({ type }: { type: string }) {
  return <span data-type={type} style={{ background: TINT[type] ?? '#888888' }}>{LABEL[type] ?? type}</span>
}
```

`bench/apps/bun-serve/components/Counter.tsx`:

```tsx
import { useReducer } from 'react'
type Action = { type: 'inc' }
const reducer = (n: number, a: Action) => (a.type === 'inc' ? n + 1 : n)
export default function Counter({ start = 0, label = 'clicks' }: { start?: number; label?: string }) {
  const [n, dispatch] = useReducer(reducer, start)
  return (
    <div data-testid="counter">
      <button type="button" onClick={() => dispatch({ type: 'inc' })}>{label}: {n}</button>
    </div>
  )
}
```

`bench/apps/bun-serve/components/Page.tsx` (document shell; `<main>` is the parity root):

```tsx
import type { ReactNode } from 'react'
export default function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <html lang="en">
      <head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>{title}</title></head>
      <body>
        <header><nav><a href="/types">Types</a><a href="/dex">Pokédex</a><a href="/team">Team</a></nav></header>
        <main>{children}</main>
        <footer>bench · bun-serve</footer>
      </body>
    </html>
  )
}
```

`bench/apps/bun-serve/pages/TypesPage.tsx`:

```tsx
import TypeBadge from '../components/TypeBadge'
export default function TypesPage({ types }: { types: string[] }) {
  return (<><h1>Types</h1><ul>{types.map((t) => <li key={t}><TypeBadge type={t} /></li>)}</ul></>)
}
```

`bench/apps/bun-serve/pages/DexPage.tsx`:

```tsx
import TypeBadge from '../components/TypeBadge'
import type { DexRow } from '../lib/data'
export default function DexPage({ rows }: { rows: DexRow[] }) {
  return (
    <>
      <h1>Pokédex</h1>
      <p>{rows.length} Pokémon</p>
      <table>
        <thead><tr><th>#</th><th>Name</th><th>Types</th></tr></thead>
        <tbody>{rows.map((p) => <tr key={p.id}><td>{p.num}</td><td>{p.displayName}</td><td>{p.types.map((t) => <TypeBadge key={t} type={t} />)}</td></tr>)}</tbody>
      </table>
    </>
  )
}
```

`bench/apps/bun-serve/pages/TeamPage.tsx`:

```tsx
import Counter from '../components/Counter'
export default function TeamPage() {
  return (<><h1>Team</h1><p>Pick up to 6.</p><Counter start={0} label="clicks" /></>)
}
```

- [ ] **Step 3: server** — `bench/apps/bun-serve/index.ts`

```ts
// bench/apps/bun-serve/index.ts — the no-framework ceiling: Bun.serve + react-dom/server renderToString of the
// same pages. No cache, no hydration script, no islands: whatever brust loses to this is framework cost.
//   BENCH_PORT=38202 bun bench/apps/bun-serve/index.ts
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import Page from './components/Page'
import { loadDex, TYPES } from './lib/data'
import DexPage from './pages/DexPage'
import TeamPage from './pages/TeamPage'
import TypesPage from './pages/TypesPage'

const HTML = { 'content-type': 'text/html; charset=utf-8' }
const page = (title: string, el: ReturnType<typeof createElement>) => new Response(`<!DOCTYPE html>${renderToString(createElement(Page, { title }, el))}`, { headers: HTML })
const typeNames = TYPES.map((t) => t.name)

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number.parseInt(process.env.BENCH_PORT ?? '38202', 10),
  fetch(req) {
    const { pathname } = new URL(req.url)
    if (pathname === '/types') return page('Types · bench', createElement(TypesPage, { types: typeNames }))
    if (pathname === '/dex') return page('Pokédex · bench', createElement(DexPage, { rows: loadDex() }))
    if (pathname === '/team') return page('Team · bench', createElement(TeamPage))
    return new Response('not found', { status: 404 })
  },
})
console.log(`[bun-serve] listening on http://${server.hostname}:${server.port}`)
process.on('SIGINT', () => { server.stop(true); process.exit(0) })
```

Run (after Task 7's `bun install`; until then run with the root's hoisted react, which is already installed):
`BENCH_PORT=38202 bun bench/apps/bun-serve/index.ts &` then
`curl -s 127.0.0.1:38202/types | grep -o '<li>' | wc -l` → `18`;
`curl -s 127.0.0.1:38202/dex | grep -o '<tr>' | wc -l` → `152`;
`curl -s 127.0.0.1:38202/team` → contains `clicks<!-- -->: <!-- -->0`; `kill %1`.

- [ ] **Step 4: commit**

```bash
git add package.json bench/apps/bun-serve
git commit -m "bench: apps/bun-serve — Bun.serve + renderToString of the three pages (ceiling)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `apps/brust` — the brust v2 app

**Files**
- Create: `bench/apps/brust/package.json`, `brust.toml`, `routes.tsx`, `lib/data.ts`, `lib/format.ts`, `lib/loaders.ts`, `components/Layout.tsx`, `components/TypeBadge.tsx`, `components/Counter.tsx`, `pages/TypesPage.tsx`, `pages/DexPage.tsx`, `pages/TeamPage.tsx`, `test/build.test.ts`

**Interfaces**
- Produces: `brust build routes.tsx` → `dist/`; `brust start --port 38201 --workers <cores>` → `[brust] listening on 127.0.0.1:38201` then `[brust] ready (N workers)`; responses carry `x-brust-cache` (`HIT`/`MISS`/`BYPASS`…), stats at `/_brust/cache/stats`.
- Consumes: `@brust/core/routes` (`defineRoutes`, `Outlet`, `LoaderCtx`), `../_shared/data.json`. Conventions copied from `examples/pokedex`: layout = plain `<html>` document with `<Outlet/>`; the layout's props come from the merged loader context (every leaf loader returns `title`); components are plain React functions; a hook (`useReducer`) makes `Counter` react tier; `TypeBadge` uses module helpers (`label`/`tint`) → one helper-backed job per type, batched (the job-cache path probe D measures).

- [ ] **Step 1: package, toml**

`bench/apps/brust/package.json`:

```json
{
  "name": "@brust/bench-brust",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "build": "brust build routes.tsx", "start": "brust start", "test": "bun test", "typecheck": "bun check -p ../.." },
  "dependencies": { "@brust/core": "workspace:*", "react": "^19.2.0", "react-dom": "^19.2.0" },
  "devDependencies": { "@types/bun": "^1.4.0", "@types/react": "^19.2.0", "typescript": "^7.0.2" }
}
```

`bench/apps/brust/brust.toml`:

```toml
[server]
address = "127.0.0.1"
port = 38201
```

(workers: not pinned here — the runner passes `--workers <cores>` per spec §1.3; `[workers] count` would only be a fallback.)

- [ ] **Step 2: lib**

`bench/apps/brust/lib/data.ts`:

```ts
// The loader's data source (D: "loader reads data.json"). Imported once per worker; rows copied per call.
import data from '../../_shared/data.json'
export interface DexRow { id: number; name: string; displayName: string; num: string; types: string[] }
export const TYPE_NAMES: string[] = data.types.map((t) => t.name)
export const loadDex = (): DexRow[] => data.pokemon.map((p) => ({ id: p.id, name: p.name, displayName: p.displayName, num: p.num, types: [...p.types] }))
```

`bench/apps/brust/lib/format.ts` (module helpers → build jobs, like `examples/pokedex/lib/format.ts`; literal table so the compiler sees a pure helper, no JSON import):

```ts
export const tint = (type: string) => ({ normal: '#9099a1', fire: '#ef7444', water: '#4d90d5', grass: '#63bb5b', electric: '#f5c84b', ice: '#74cec0', fighting: '#ce4069', poison: '#ab6ac8', ground: '#d97746', flying: '#8fa8dd', psychic: '#f06fa0', bug: '#90c12c', rock: '#c7b78b', ghost: '#5269ac', dragon: '#0a6dc4', dark: '#5a5366', steel: '#5a8ea1', fairy: '#ec8fe6' } as Record<string, string>)[type] ?? '#888888'
export const label = (type: string) => type.charAt(0).toUpperCase() + type.slice(1)
```

`bench/apps/brust/lib/loaders.ts`:

```ts
import type { LoaderCtx } from '@brust/core/routes'
import { type DexRow, loadDex, TYPE_NAMES } from './data'

/** Chrome every leaf returns: Layout reads `title` from the merged loader context (child keys win). */
export async function typesLoader(_ctx: LoaderCtx): Promise<{ title: string; types: string[] }> {
  return { title: 'Types · bench', types: TYPE_NAMES }
}
export async function dexLoader(_ctx: LoaderCtx): Promise<{ title: string; rows: DexRow[]; count: number }> {
  const rows = loadDex()
  return { title: 'Pokédex · bench', rows, count: rows.length }
}
export async function teamLoader(_ctx: LoaderCtx): Promise<{ title: string; start: number; label: string }> {
  return { title: 'Team · bench', start: 0, label: 'clicks' }
}
```

- [ ] **Step 3: components + pages**

`bench/apps/brust/components/Layout.tsx`:

```tsx
// The document (S9): plain <html>, <Outlet/> for the leaf. `title` comes from the merged loader context.
import { Outlet } from '@brust/core/routes'
export default function Layout(props: { title: string }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
      </head>
      <body>
        <header><nav><a href="/types">Types</a><a href="/dex">Pokédex</a><a href="/team">Team</a></nav></header>
        <main><Outlet /></main>
        <footer>bench · brust v2</footer>
      </body>
    </html>
  )
}
```

`bench/apps/brust/components/TypeBadge.tsx`:

```tsx
// Helper-backed child (label/tint are module helpers → one job per type, batched; rows reuse the job cache).
import { label, tint } from '../lib/format'
export default function TypeBadge(props: { type: string }) {
  return <span data-type={props.type} style={{ background: tint(props.type) }}>{label(props.type)}</span>
}
```

`bench/apps/brust/components/Counter.tsx`:

```tsx
// React tier on purpose (useReducer): SSR via renderToString job + idle hydration (S12).
import { useReducer } from 'react'
type Action = { type: 'inc' }
const reducer = (n: number, a: Action) => (a.type === 'inc' ? n + 1 : n)
export default function Counter(props: { start: number; label: string }) {
  const [n, dispatch] = useReducer(reducer, props.start)
  return (
    <div data-testid="counter">
      <button type="button" onClick={() => dispatch({ type: 'inc' })}>{props.label}: {n}</button>
    </div>
  )
}
```

`bench/apps/brust/pages/TypesPage.tsx` (mirrors `HomePage`'s `types.map((t) => <TypeBadge type={t}/>)`):

```tsx
import TypeBadge from '../components/TypeBadge'
export default function TypesPage({ types }: { types: string[] }) {
  return (
    <section>
      <h1>Types</h1>
      <ul>{types.map((t) => <li key={t}><TypeBadge type={t} /></li>)}</ul>
    </section>
  )
}
```

NOTE for parity: `<section>` is an extra tag compared with bun-serve's fragment. Fragments are what the other apps emit, so use a fragment here too — `return (<><h1>Types</h1><ul>…</ul></>)`. If `brust build` rejects a fragment root for a leaf page (`error <rule> …` naming the fragment), wrap EVERY app's page content in the same `<section>` instead (bun-serve Task 5, Next Task 7, 0.1.x Task 8) and update `pages.md`; the parity test fixtures in Task 9 use the fragment form and would need the same one-line change. Record which form was needed in the commit message.

`bench/apps/brust/pages/DexPage.tsx` (nested `.map` with a string loop var, as `DetailPage`'s `typeNames.map`):

```tsx
import TypeBadge from '../components/TypeBadge'
import type { DexRow } from '../lib/data'
export default function DexPage({ rows, count }: { rows: DexRow[]; count: number }) {
  return (
    <>
      <h1>Pokédex</h1>
      <p>{count} Pokémon</p>
      <table>
        <thead><tr><th>#</th><th>Name</th><th>Types</th></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}><td>{p.num}</td><td>{p.displayName}</td><td>{p.types.map((t) => <TypeBadge key={t} type={t} />)}</td></tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
```

`bench/apps/brust/pages/TeamPage.tsx`:

```tsx
import Counter from '../components/Counter'
export default function TeamPage({ start, label }: { start: number; label: string }) {
  return (<><h1>Team</h1><p>Pick up to 6.</p><Counter start={start} label={label} /></>)
}
```

- [ ] **Step 4: routes** — `bench/apps/brust/routes.tsx`

```tsx
// bench/apps/brust/routes.tsx — three probes: S cacheable (L1 1 h), D and I bypass L1 on ?nocache=1 (the bench
// measures the MISS path: loader every request, jobs from the job cache, Counter ssr job + hydration tags).
import { defineRoutes } from '@brust/core/routes'
import Layout from './components/Layout'
import { dexLoader, teamLoader, typesLoader } from './lib/loaders'
import DexPage from './pages/DexPage'
import TeamPage from './pages/TeamPage'
import TypesPage from './pages/TypesPage'

export const routes = defineRoutes([
  {
    Component: Layout,
    children: [
      { path: '/types', Component: TypesPage, loader: typesLoader, cache: { ttl_seconds: 3600, tags: ['types'] } },
      { path: '/dex', Component: DexPage, loader: dexLoader, cache: { ttl_seconds: 60, bypass: 'query(nocache)', tags: ['dex'] } },
      { path: '/team', Component: TeamPage, loader: teamLoader, cache: { ttl_seconds: 60, bypass: 'query(nocache)', tags: ['team'] } },
    ],
  },
])
```

- [ ] **Step 5: failing build test** — `bench/apps/brust/test/build.test.ts`

```ts
// `brust build` succeeds and the manifest has the shape the probes rely on (Review Focus 5).
import { expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, '..')
const bin = join(app, '../../../packages/brust/bin/brust')

test('brust build: 3 routes, cache config per probe, typeBadge per-row child, counter is react with a chunk', async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--out-dir', 'dist-test'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  expect(b.stderr.toString()).toBe('')
  expect(b.exitCode).toBe(0)
  const m = await Bun.file(join(app, 'dist-test/manifest.json')).json()
  const byPattern = Object.fromEntries(m.routes.map((r: { pattern: string }) => [r.pattern, r]))
  expect(Object.keys(byPattern).sort()).toEqual(['/dex', '/team', '/types'])
  expect(byPattern['/types'].cache).toEqual({ ttl_seconds: 3600, prefix: null, bypass: null, tags: ['types'] })
  expect(byPattern['/dex'].cache).toEqual({ ttl_seconds: 60, prefix: null, bypass: 'query(nocache)', tags: ['dex'] })
  expect(byPattern['/team'].cache).toEqual({ ttl_seconds: 60, prefix: null, bypass: 'query(nocache)', tags: ['team'] })
  const comp = (prefix: string) => Object.entries(m.components).find(([id]) => id.startsWith(`${prefix}_`))![1] as Record<string, unknown>
  const dex = comp('dexPage') as { tier: string; children: { id: string; instances: string }[] }
  expect(dex.tier).toBe('native')
  expect(dex.children.some((c) => c.id.startsWith('typeBadge_') && c.instances.startsWith('per-row:'))).toBe(true)
  const counter = comp('counter') as { tier: string; client: string }
  expect(counter.tier).toBe('react')
  expect(counter.client).toMatch(/^client\/react-counter_[0-9a-f]{8}-[0-9a-f]{10}\.js$/)
  rmSync(join(app, 'dist-test'), { recursive: true, force: true })
}, 120_000)
```

Run: `cd bench/apps/brust && bun test` → red until the app builds. If the `prefix: null, bypass: null` shape differs from what the manifest writes for an absent field, read `examples/pokedex/test/build.test.ts` (it pins `{ ttl_seconds: 60, prefix: null, bypass: 'query(nocache)', tags: ['pokemon'] }`) and match the real output for the absent `bypass` — the assertion must follow the manifest, not the other way round.

- [ ] **Step 6: build + smoke** (needs the release addon: `cd packages/brust && bun run build`; then `bun install` at the root once Task 7's package exists, or temporarily now)

```bash
cd ~/code/brust-lane-m3b-bench-suite/bench/apps/brust && bun test            # → 1 pass
bun ../../../packages/brust/bin/brust build routes.tsx && bun ../../../packages/brust/bin/brust start --port 38201 --workers 2 &
sleep 2
curl -si '127.0.0.1:38201/types' | grep -i x-brust-cache        # MISS (first)
curl -si '127.0.0.1:38201/types' | grep -i x-brust-cache        # HIT
curl -si '127.0.0.1:38201/dex?nocache=1' | grep -i x-brust-cache  # not HIT (BYPASS/MISS)
curl -s  '127.0.0.1:38201/dex?nocache=1' | grep -o '<tr>' | wc -l   # 152
curl -s  '127.0.0.1:38201/team?nocache=1' | grep -o 'brust-island' | head -1   # the island host is present
kill %1
```

- [ ] **Step 7: commit**

```bash
git add bench/apps/brust
git commit -m "bench: apps/brust — v2 app for probes S/D/I (L1 1 h on /types, ?nocache bypass on /dex and /team)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `apps/next` — Next.js 16.4.0, App Router, standalone, Node 22

**Files**
- Create: `bench/apps/next/package.json`, `next.config.ts`, `tsconfig.json`, `.gitignore`, `app/layout.tsx`, `app/types/page.tsx`, `app/dex/page.tsx`, `app/team/page.tsx`, `components/Counter.tsx`, `components/TypeBadge.tsx`, `lib/data.ts`
- Modify: root `.gitignore` (`+ .next/`, `+ next-env.d.ts`)

**Interfaces**
- Produces: `next build` → `.next/standalone/**/server.js`; `PORT=38203 HOSTNAME=127.0.0.1 node <server.js>` prints `▲ Next.js 16.4.0` … `✓ Ready in …`; `/types` static, `/dex` + `/team` dynamic.
- Consumes: `../_shared/data.json` (outside the app dir: `outputFileTracingRoot` = repo root makes the standalone trace include it).

- [ ] **Step 1: package, config, install**

`bench/apps/next/package.json`:

```json
{
  "name": "@brust/bench-next",
  "version": "0.0.0",
  "private": true,
  "scripts": { "build": "next build", "start": "node .next/standalone/bench/apps/next/server.js", "typecheck": "bun check" },
  "dependencies": { "next": "16.4.0", "react": "^19.2.0", "react-dom": "^19.2.0" },
  "devDependencies": { "@types/node": "^22.0.0", "@types/react": "^19.2.0", "@types/react-dom": "^19.2.0", "typescript": "^7.0.2" }
}
```

`bench/apps/next/next.config.ts`:

```ts
import { join } from 'node:path'
import type { NextConfig } from 'next'

// Production-only comparator (spec §1.3): standalone output, run with `node .next/standalone/bench/apps/next/server.js`.
// `outputFileTracingRoot` = the monorepo root so the trace follows the hoisted node_modules AND ../_shared/data.json;
// the side effect is that server.js lands under .next/standalone/<path from root>/ (lib/apps.ts handles both).
const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: join(import.meta.dirname, '../../..'),
  poweredByHeader: false,
  reactStrictMode: true,
}
export default config
```

`bench/apps/next/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["dom", "dom.iterable", "esnext"], "allowJs": true, "skipLibCheck": true, "strict": true,
    "noEmit": true, "esModuleInterop": true, "module": "esnext", "moduleResolution": "bundler", "resolveJsonModule": true,
    "isolatedModules": true, "jsx": "preserve", "incremental": false, "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules", ".next"]
}
```

`bench/apps/next/.gitignore`:

```
.next/
next-env.d.ts
```

Root `.gitignore` → append `.next/` and `next-env.d.ts` as well (belt and braces: the lane rule bans `git add -A`, but a stray `git add bench/apps/next` must not pick up a build).

Then, at the repo root: `bun install` → the lockfile gains `next@16.4.0` and its platform binaries. Verify: `grep -c '"next@16.4.0"' bun.lock` → `1`; `ls node_modules/next/package.json`.

- [ ] **Step 2: data + components**

`bench/apps/next/lib/data.ts`:

```ts
import data from '../../_shared/data.json'
export type DexRow = (typeof data.pokemon)[number]
export const TYPE_NAMES: string[] = data.types.map((t) => t.name)
export const TINT: Record<string, string> = Object.fromEntries(data.types.map((t) => [t.name, t.tint]))
export const LABEL: Record<string, string> = Object.fromEntries(data.types.map((t) => [t.name, t.label]))
export const loadDex = (): DexRow[] => data.pokemon.map((p) => ({ ...p }))
```

`bench/apps/next/components/TypeBadge.tsx` (server component):

```tsx
import { LABEL, TINT } from '../lib/data'
export default function TypeBadge({ type }: { type: string }) {
  return <span data-type={type} style={{ background: TINT[type] ?? '#888888' }}>{LABEL[type] ?? type}</span>
}
```

`bench/apps/next/components/Counter.tsx`:

```tsx
'use client'
import { useReducer } from 'react'
type Action = { type: 'inc' }
const reducer = (n: number, a: Action) => (a.type === 'inc' ? n + 1 : n)
export default function Counter({ start = 0, label = 'clicks' }: { start?: number; label?: string }) {
  const [n, dispatch] = useReducer(reducer, start)
  return (
    <div data-testid="counter">
      <button type="button" onClick={() => dispatch({ type: 'inc' })}>{label}: {n}</button>
    </div>
  )
}
```

- [ ] **Step 3: app router files**

`bench/apps/next/app/layout.tsx`:

```tsx
import type { ReactNode } from 'react'
export const metadata = { title: 'bench · next' }
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header><nav><a href="/types">Types</a><a href="/dex">Pokédex</a><a href="/team">Team</a></nav></header>
        <main>{children}</main>
        <footer>bench · next</footer>
      </body>
    </html>
  )
}
```

`bench/apps/next/app/types/page.tsx` (no dynamic API → prerendered at build = the S "static" behaviour):

```tsx
import TypeBadge from '../../components/TypeBadge'
import { TYPE_NAMES } from '../../lib/data'
export const metadata = { title: 'Types · bench' }
export default function TypesPage() {
  return (<><h1>Types</h1><ul>{TYPE_NAMES.map((t) => <li key={t}><TypeBadge type={t} /></li>)}</ul></>)
}
```

`bench/apps/next/app/dex/page.tsx`:

```tsx
import TypeBadge from '../../components/TypeBadge'
import { loadDex } from '../../lib/data'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Pokédex · bench' }
export default function DexPage() {
  const rows = loadDex()
  return (
    <>
      <h1>Pokédex</h1>
      <p>{rows.length} Pokémon</p>
      <table>
        <thead><tr><th>#</th><th>Name</th><th>Types</th></tr></thead>
        <tbody>{rows.map((p) => <tr key={p.id}><td>{p.num}</td><td>{p.displayName}</td><td>{p.types.map((t) => <TypeBadge key={t} type={t} />)}</td></tr>)}</tbody>
      </table>
    </>
  )
}
```

`bench/apps/next/app/team/page.tsx`:

```tsx
import Counter from '../../components/Counter'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Team · bench' }
export default function TeamPage() {
  return (<><h1>Team</h1><p>Pick up to 6.</p><Counter start={0} label="clicks" /></>)
}
```

- [ ] **Step 4: build + smoke (Node 22)**

```bash
cd ~/code/brust-lane-m3b-bench-suite/bench/apps/next && node --version          # v22.x
bun run build                                                                   # "✓ Compiled", route table: /types ○ (Static), /dex ƒ, /team ƒ
ls .next/standalone/bench/apps/next/server.js                                   # expected location (tracing root = repo root)
cp -r .next/static .next/standalone/bench/apps/next/.next/static                # assets next to the standalone server (page scripts resolve)
PORT=38203 HOSTNAME=127.0.0.1 node .next/standalone/bench/apps/next/server.js &  # "▲ Next.js 16.4.0" … "✓ Ready in"
sleep 1
curl -s 127.0.0.1:38203/types | grep -o '<li>' | wc -l       # 18
curl -s 127.0.0.1:38203/dex   | grep -o '<tr>' | wc -l       # 152
curl -s 127.0.0.1:38203/team  | grep -o 'clicks<!-- -->: <!-- -->0'   # present
curl -si 127.0.0.1:38203/dex | grep -i 'cache-control'       # no-store / private (force-dynamic) — proves D is dynamic
kill %1
bun check -p bench/apps/next     # from the repo root → 0 errors (Next's plugin entry is ignored by bun check)
```

If `bun run build` prints a warning about multiple lockfiles / inferred workspace root, `outputFileTracingRoot` above is exactly what silences it. If `server.js` is at `.next/standalone/server.js` instead (Next decided the root differently), `nextServerJs()` in Task 11 finds that too — update the `start` script in package.json to the path that exists.

- [ ] **Step 5: commit**

```bash
git add .gitignore bun.lock bench/apps/next/package.json bench/apps/next/next.config.ts bench/apps/next/tsconfig.json bench/apps/next/.gitignore bench/apps/next/app bench/apps/next/components bench/apps/next/lib
git commit -m "bench: apps/next — Next.js 16.4.0 App Router, standalone output, the same three pages

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `apps/brust-01x` — the optional 0.1.x app (`BRUST_01X_DIR`)

**Files**
- Create: `bench/apps/brust-01x/index.ts`, `routes.tsx`, `components/AppLayout.tsx`, `components/Counter.tsx`, `pages/TypesPage.tsx`, `pages/DexPage.tsx`, `pages/TeamPage.tsx`, `lib/loaders.ts`, `README.md` (3 lines: this directory is copied, imports are relative to the 0.1.x checkout)

**Interfaces**
- Produces: a directory the runner rsyncs to `$BRUST_01X_DIR/bench/apps/m3-01x/` (with `_shared/data.json` copied to `$BRUST_01X_DIR/bench/apps/m3-01x/data.json`), builds with `bun run runtime/cli/index.ts build bench/apps/m3-01x/index.ts` (cwd `$BRUST_01X_DIR`) and starts with `BRUST_PORT=38204 bun run bench/apps/m3-01x/index.ts`, printing `listening on 127.0.0.1:38204`.
- Consumes: the 0.1.x runtime via relative imports (`../../../runtime/index.ts`, `../../../runtime/routes.ts`) exactly as 0.1.x's `bench/apps/brust/*` does; 0.1.x native-route rules (`native: true`, single return, no local bindings, `<Island component ssr hydrate="load">`, `BrustPage`, `.map()` → x-for with inline markup only, so the type badge is an inline `<span>` fed by loader-precomputed `{name,label,tint}` rows — NOT a per-row child component).
- Not typechecked in `bench/tsconfig.json` (excluded): the imports only resolve inside the 0.1.x checkout.

- [ ] **Step 1: files**

`bench/apps/brust-01x/README.md`:

```markdown
0.1.x comparator for the M3 bench. `bench/run.ts` copies this directory to `$BRUST_01X_DIR/bench/apps/m3-01x/`
(plus `../_shared/data.json` as `data.json`), so every import below is relative to THAT location in a 0.1.x checkout.
Never run it from here.
```

`bench/apps/brust-01x/index.ts`:

```ts
import { brust } from '../../../runtime/index.ts'
import { routes } from './routes'
// Boot the 0.1.x runtime on the three bench pages. BRUST_PORT / BRUST_WORKERS come from the runner's env.
await brust.run({ routes, entry: import.meta.url })
```

`bench/apps/brust-01x/lib/loaders.ts`:

```ts
import data from '../data.json'
export const TYPES = data.types as { name: string; label: string; tint: string }[]
const badge = (t: string) => TYPES.find((x) => x.name === t) ?? { name: t, label: t, tint: '#888888' }
export async function typesLoader() {
  return { title: 'Types · bench', teamProps: { start: 0, label: 'clicks' }, types: TYPES }
}
export async function dexLoader() {
  const rows = data.pokemon.map((p) => ({ id: p.id, num: p.num, displayName: p.displayName, badges: p.types.map(badge) }))
  return { title: 'Pokédex · bench', teamProps: { start: 0, label: 'clicks' }, rows, count: rows.length }
}
export async function teamLoader() {
  return { title: 'Team · bench', teamProps: { start: 0, label: 'clicks' } }
}
```

`bench/apps/brust-01x/components/Counter.tsx` (plain React, hydrated by the 0.1.x island bootstrap):

```tsx
import { useReducer } from 'react'
type Action = { type: 'inc' }
const reducer = (n: number, a: Action) => (a.type === 'inc' ? n + 1 : n)
export default function Counter({ start = 0, label = 'clicks' }: { start?: number; label?: string }) {
  const [n, dispatch] = useReducer(reducer, start)
  return (
    <div data-testid="counter">
      <button type="button" onClick={() => dispatch({ type: 'inc' })}>{label}: {n}</button>
    </div>
  )
}
```

`bench/apps/brust-01x/components/AppLayout.tsx` (single return, no local bindings — the 0.1.x native-layout rule):

```tsx
import { BrustPage, Outlet } from '../../../runtime/index.ts'
export default function AppLayout({ title }: { title: string }) {
  return (
    <BrustPage lang="en" title={title}>
      <header><nav><a href="/types">Types</a><a href="/dex">Pokédex</a><a href="/team">Team</a></nav></header>
      <main><Outlet /></main>
      <footer>bench · brust 0.1.x</footer>
    </BrustPage>
  )
}
```

`bench/apps/brust-01x/pages/TypesPage.tsx`:

```tsx
export default function TypesPage({ types }: { types: { name: string; label: string; tint: string }[] }) {
  return (
    <>
      <h1>Types</h1>
      <ul>{types.map((t) => <li key={t.name}><span data-type={t.name} style={{ background: t.tint }}>{t.label}</span></li>)}</ul>
    </>
  )
}
```

`bench/apps/brust-01x/pages/DexPage.tsx`:

```tsx
type Badge = { name: string; label: string; tint: string }
export default function DexPage({ rows, count }: { rows: { id: number; num: string; displayName: string; badges: Badge[] }[]; count: number }) {
  return (
    <>
      <h1>Pokédex</h1>
      <p>{count} Pokémon</p>
      <table>
        <thead><tr><th>#</th><th>Name</th><th>Types</th></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}><td>{p.num}</td><td>{p.displayName}</td><td>{p.badges.map((b) => <span key={b.name} data-type={b.name} style={{ background: b.tint }}>{b.label}</span>)}</td></tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
```

`bench/apps/brust-01x/pages/TeamPage.tsx` (`ssr` so the island's HTML is in the response, like brust v2's react tier):

```tsx
import { Island } from '../../../runtime/index.ts'
import Counter from '../components/Counter'
export default function TeamPage({ teamProps }: { teamProps: { start: number; label: string } }) {
  return (
    <>
      <h1>Team</h1>
      <p>Pick up to 6.</p>
      <Island component={Counter} props={teamProps} ssr hydrate="load" />
    </>
  )
}
```

`bench/apps/brust-01x/routes.tsx`:

```tsx
import { defineRoutes } from '../../../runtime/routes.ts'
import AppLayout from './components/AppLayout'
import { dexLoader, teamLoader, typesLoader } from './lib/loaders'
import DexPage from './pages/DexPage'
import TeamPage from './pages/TeamPage'
import TypesPage from './pages/TypesPage'

// Same three pages, 0.1.x conventions: every route native, /types L1-cached 1 h; /dex and /team never cached
// (0.1.x has no ?nocache contract here — the probe's query is simply ignored, see spec §1.2).
export const routes = defineRoutes([
  {
    Component: AppLayout,
    native: true,
    children: [
      { path: '/types', Component: TypesPage, native: true, loader: typesLoader, cache: { ttl_seconds: 3600 } },
      { path: '/dex', Component: DexPage, native: true, loader: dexLoader },
      { path: '/team', Component: TeamPage, native: true, loader: teamLoader },
    ],
  },
])
```

- [ ] **Step 2: smoke in the 0.1.x checkout** (needs its release addon: `cd ~/code/brust/runtime && bun run build`)

```bash
X=~/code/brust; L=~/code/brust-lane-m3b-bench-suite
mkdir -p $X/bench/apps/m3-01x && rsync -a --delete $L/bench/apps/brust-01x/ $X/bench/apps/m3-01x/ && cp $L/bench/apps/_shared/data.json $X/bench/apps/m3-01x/data.json
cd $X && bun run runtime/cli/index.ts build bench/apps/m3-01x/index.ts        # exit 0; jinja templates emitted for 4 native components
BRUST_PORT=38204 BRUST_WORKERS=2 bun run bench/apps/m3-01x/index.ts &          # "listening on 127.0.0.1:38204"
sleep 2
curl -s 127.0.0.1:38204/types | grep -o '<li>' | wc -l        # 18
curl -s 127.0.0.1:38204/dex   | grep -o '<tr>' | wc -l        # 152
curl -s 127.0.0.1:38204/team  | grep -o 'data-brust-island' | wc -l   # 1 (the wrapper the normalizer unwraps)
kill %1
```

If the 0.1.x compiler rejects a fragment-root leaf, a nested `.map` inside a `<td>`, or the `style={{ background: t.tint }}` object on an x-for row, read `/Users/detoro/code/brust/docs/` "native route authoring constraints" and the memory note `native-route-authoring-constraints.md`, and adjust ONLY the 0.1.x files (e.g. wrap in `<div>` and give every other app the same wrapper, or precompute a `style` string in the loader). The parity check, not this smoke, is the acceptance.

- [ ] **Step 3: commit**

```bash
git add bench/apps/brust-01x
git commit -m "bench: apps/brust-01x — optional 0.1.x comparator, copied into \$BRUST_01X_DIR at run time

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: `lib/parity.ts` — normalize `<main>`, diff across apps

**Files**
- Create: `bench/lib/parity.ts`, `bench/lib/parity.test.ts`

**Interfaces**
- Produces:
  ```ts
  export interface Normalized { tags: string[]; text: string[] }
  export function normalizeMain(html: string): Normalized          // throws when <main> is absent
  export function decodeEntities(s: string): string
  export function diffParity(ref: { app: string; n: Normalized }, other: { app: string; n: Normalized }): string | null  // null = equal
  export async function checkParity(pages: { app: string; html: string }[], probe: string): Promise<void>  // throws Error(diff) on mismatch
  ```
- Consumes: raw HTML strings fetched by the runner.

- [ ] **Step 1: failing tests** — `bench/lib/parity.test.ts`

```ts
import { describe, expect, test } from 'bun:test'
import { decodeEntities, diffParity, normalizeMain } from './parity'

const brustHtml = `<html lang="en"><head><title>Team</title><link rel="stylesheet" href="/x.css"></head><body>
<header><nav><a href="/types">Types</a></nav></header>
<main>
  <h1>Team</h1>
  <p>Pick up to 6.</p>
  <brust-island data-id="counter_0a1b2c3d" x-props='{"start":0,"label":"clicks"}'><div data-testid="counter"><button type="button">clicks<!-- -->: <!-- -->0</button></div></brust-island>
  <script type="module" src="/_brust/client/runtime-abc.js"></script>
</main>
<footer>bench · brust v2</footer></body></html>`

const nextHtml = `<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><title>Team · bench</title></head><body><header><nav><a href="/types">Types</a></nav></header><main><!--$--><h1>Team</h1><p>Pick up to 6.</p><div data-testid="counter"><button type="button">clicks<!-- -->: <!-- -->0</button></div><!--/$--><style>.x{}</style></main><footer>bench · next</footer><script src="/_next/static/chunks/main.js" async=""></script></body></html>`

const x01Html = `<html><body><main><h1>Team</h1><p>Pick up to 6.</p><div data-brust-island="Counter" data-brust-props="{&quot;start&quot;:0}" data-brust-hydrate="load"><div data-testid="counter"><button type="button">clicks<!-- -->: <!-- -->0</button></div></div></main></body></html>`

describe('normalizeMain', () => {
  test('brust-style and next-style fixtures normalize equal (wrapper, script/link/style, comments, attrs, whitespace)', () => {
    const a = normalizeMain(brustHtml)
    const b = normalizeMain(nextHtml)
    expect(a).toEqual(b)
    expect(a.tags).toEqual(['h1', '/h1', 'p', '/p', 'div', 'button', '/button', '/div'])
    expect(a.text).toEqual(['Team', 'Pick up to 6.', 'clicks: 0'])
  })
  test('0.1.x div[data-brust-island] wrapper is unwrapped', () => {
    expect(normalizeMain(x01Html)).toEqual(normalizeMain(nextHtml))
  })
  test('only <main> is compared: header/footer/title differences are invisible', () => {
    const n = normalizeMain(brustHtml.replace('bench · brust v2', 'something else').replace('<title>Team</title>', '<title>Other</title>'))
    expect(n).toEqual(normalizeMain(brustHtml))
  })
  test('missing <main> throws naming the problem', () => {
    expect(() => normalizeMain('<html><body><div>no main</div></body></html>')).toThrow(/no <main>/)
  })
  test('entities: &#x27; and &#39; and &amp; decode to the same text; void tags do not open', () => {
    expect(decodeEntities('it&#x27;s &amp; it&#39;s &lt;3 &quot;q&quot; &#233;')).toBe(`it's & it's <3 "q" é`)
    const n = normalizeMain('<main><p>a<br>b<img src="x"></p></main>')
    expect(n.tags).toEqual(['p', 'br', 'img', '/p'])
    expect(n.text).toEqual(['a', 'b'])
  })
})

describe('diffParity', () => {
  test('equal pages → null', () => {
    expect(diffParity({ app: 'brust', n: normalizeMain(brustHtml) }, { app: 'next', n: normalizeMain(nextHtml) })).toBeNull()
  })
  test('a missing row is a mismatch with a diff naming index and both values', () => {
    const ref = normalizeMain('<main><table><tbody><tr><td>#0001</td></tr><tr><td>#0002</td></tr></tbody></table></main>')
    const other = normalizeMain('<main><table><tbody><tr><td>#0001</td></tr></tbody></table></main>')
    const d = diffParity({ app: 'brust', n: ref }, { app: 'next', n: other })
    expect(d).toMatch(/tags differ at index 6/)
    expect(d).toMatch(/brust: tr/)
    expect(d).toMatch(/next: \/tbody/)
    expect(d).toMatch(/counts: brust 12 tags \/ 2 texts, next 8 tags \/ 1 texts/)
  })
  test('different text content is a mismatch', () => {
    const d = diffParity({ app: 'brust', n: normalizeMain('<main><h1>Types</h1></main>') }, { app: 'next', n: normalizeMain('<main><h1>Type</h1></main>') })
    expect(d).toMatch(/text differs at index 0: brust "Types" vs next "Type"/)
  })
})
```

Run: `bun test bench/lib/parity.test.ts` → red.

- [ ] **Step 2: implementation** — `bench/lib/parity.ts`

```ts
// bench/lib/parity.ts — "same page" as a checked claim (spec §1.4). For each app's HTML: take <main>, drop
// <script>/<link>/<style>/<template> and comments, unwrap island hosts (<brust-island>, [data-brust-island]),
// ignore every attribute (subsumes data-*/x-*/hash ids), decode entities, collapse whitespace; compare the tag
// sequence and the text nodes. Attributes/classes are framework-free territory; tags and text are not.
export interface Normalized { tags: string[]; text: string[] }

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number.parseInt(d, 10)))
    .replace(/&([a-z]+);/g, (m, n: string) => NAMED[n] ?? m)
}

const isWrapper = (name: string, attrs: string): boolean => name === 'brust-island' || /\sdata-brust-island\b/.test(` ${attrs}`)

export function normalizeMain(html: string): Normalized {
  const m = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)
  if (!m) throw new Error(`no <main> element in the response (${html.length} bytes): ${html.slice(0, 120).replace(/\s+/g, ' ')}…`)
  const body = m[1]!
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
  const tags: string[] = []
  const text: string[] = []
  const stack: boolean[] = [] // true = this open tag was an unwrapped island host
  const re = /<\/?([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g
  for (let t = re.exec(body); t !== null; t = re.exec(body)) {
    if (t[3] !== undefined) {
      const s = decodeEntities(t[3]).replace(/\s+/g, ' ').trim()
      if (s) text.push(s)
      continue
    }
    const name = t[1]!.toLowerCase()
    const attrs = t[2] ?? ''
    if (t[0].startsWith('</')) {
      const skipped = stack.pop() ?? false
      if (!skipped) tags.push(`/${name}`)
      continue
    }
    if (VOID.has(name) || attrs.trimEnd().endsWith('/')) { tags.push(name); continue }
    const skip = isWrapper(name, attrs)
    stack.push(skip)
    if (!skip) tags.push(name)
  }
  return { tags, text }
}

export function diffParity(ref: { app: string; n: Normalized }, other: { app: string; n: Normalized }): string | null {
  const counts = `counts: ${ref.app} ${ref.n.tags.length} tags / ${ref.n.text.length} texts, ${other.app} ${other.n.tags.length} tags / ${other.n.text.length} texts`
  const ctx = (xs: string[], i: number) => xs.slice(Math.max(0, i - 3), i + 4).join(' ')
  const nt = Math.max(ref.n.tags.length, other.n.tags.length)
  for (let i = 0; i < nt; i++) {
    const a = ref.n.tags[i]
    const b = other.n.tags[i]
    if (a !== b) return `tags differ at index ${i}: ${ref.app}: ${a ?? '<end>'} vs ${other.app}: ${b ?? '<end>'}\n  ${ref.app}: … ${ctx(ref.n.tags, i)} …\n  ${other.app}: … ${ctx(other.n.tags, i)} …\n  ${counts}`
  }
  const nx = Math.max(ref.n.text.length, other.n.text.length)
  for (let i = 0; i < nx; i++) {
    const a = ref.n.text[i]
    const b = other.n.text[i]
    if (a !== b) return `text differs at index ${i}: ${ref.app} ${JSON.stringify(a ?? '<end>')} vs ${other.app} ${JSON.stringify(b ?? '<end>')}\n  ${counts}`
  }
  return null
}

/** The runner's entry: every app against the first one; the first mismatch aborts with its diff. */
export async function checkParity(pages: { app: string; html: string }[], probe: string): Promise<void> {
  const [ref, ...rest] = pages.map((p) => ({ app: p.app, n: normalizeMain(p.html) }))
  if (!ref) throw new Error(`parity ${probe}: no pages to compare`)
  for (const other of rest) {
    const d = diffParity(ref, other)
    if (d) throw new Error(`parity mismatch on probe ${probe} (${ref.app} vs ${other.app}):\n${d}`)
  }
}
```

Run: `bun test bench/lib/parity.test.ts` → `8 pass` (the row fixture: ref = `table tbody tr td /td /tr tr td /td /tr /tbody /table` = 12 tags, other = 8; index 6 is `tr` vs `/tbody`).

- [ ] **Step 3: commit**

```bash
git add bench/lib/parity.ts bench/lib/parity.test.ts
git commit -m "bench: lib/parity — normalize <main> (tags + text), diff across apps, abort on mismatch

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: `lib/report.ts` — RESULTS.json / RESULTS.md + verdict math

**Files**
- Create: `bench/lib/report.ts`, `bench/lib/report.test.ts`, `bench/lib/fixtures/results.json`

**Interfaces**
- Produces:
  ```ts
  import type { AppId } from './app'; import type { Encoding, OhaNums } from './oha'; import type { ProbeId } from './probes'
  export interface Measurement { app: AppId; probe: ProbeId; enc: Encoding; nums: OhaNums; raw: unknown }
  export interface Header { date: string; host: string; cores: number; loadavg: number[]; seed: number; conn: number; dur: string; warmup: string; settleMs: number; workers: number; versions: Record<string, string>; apps: AppId[]; skipped: { app: AppId; reason: string }[]; order: string[] }
  export interface Results { header: Header; measurements: Measurement[] }
  export interface Verdict { f68: { d: number | null; i: number | null; met: boolean | null }; sanity: { s: number | null; d: number | null; i: number | null; met: boolean | null }; ceiling: { d: number | null; i: number | null } }
  export function rpsOf(r: Results, app: AppId, probe: ProbeId, enc?: Encoding): number | null
  export function computeVerdict(r: Results): Verdict
  export function renderVerdict(v: Verdict): string        // exactly three lines, spec §1.5
  export function renderMarkdown(r: Results): string
  export async function writeResults(dir: string, r: Results): Promise<void>
  ```

- [ ] **Step 1: fixture** — `bench/lib/fixtures/results.json` (identity for 4 apps × 3 probes, gzip for brust only; `raw` omitted = `null`)

```json
{
  "header": { "date": "2026-10-10", "host": "darwin/arm64", "cores": 10, "loadavg": [3.1, 4.2, 4.0], "seed": 12345, "conn": 120, "dur": "10s", "warmup": "3s", "settleMs": 1000, "workers": 10,
    "versions": { "bun": "1.4.3-canary", "node": "v22.23.1", "next": "16.4.0", "brust": "0.0.0 @ abc1234", "brust-01x": "0.1.69-alpha", "oha": "1.11.0" },
    "apps": ["brust", "bun-serve", "next", "brust-01x"], "skipped": [], "order": ["next:I", "brust:S", "bun-serve:D"] },
  "measurements": [
    { "app": "brust", "probe": "S", "enc": "identity", "nums": { "rps": 46000, "p50": 2.5, "p95": 2.8, "p99": 2.9, "total": 460000, "errors": 0 }, "raw": null },
    { "app": "brust", "probe": "D", "enc": "identity", "nums": { "rps": 50000, "p50": 2.3, "p95": 4.0, "p99": 5.1, "total": 500000, "errors": 0 }, "raw": null },
    { "app": "brust", "probe": "I", "enc": "identity", "nums": { "rps": 40000, "p50": 2.9, "p95": 5.5, "p99": 7.0, "total": 400000, "errors": 0 }, "raw": null },
    { "app": "brust", "probe": "D", "enc": "gzip", "nums": { "rps": 48000, "p50": 2.4, "p95": 4.2, "p99": 5.3, "total": 480000, "errors": 0 }, "raw": null },
    { "app": "bun-serve", "probe": "S", "enc": "identity", "nums": { "rps": 70000, "p50": 1.6, "p95": 2.0, "p99": 2.4, "total": 700000, "errors": 0 }, "raw": null },
    { "app": "bun-serve", "probe": "D", "enc": "identity", "nums": { "rps": 60000, "p50": 1.9, "p95": 2.6, "p99": 3.3, "total": 600000, "errors": 0 }, "raw": null },
    { "app": "bun-serve", "probe": "I", "enc": "identity", "nums": { "rps": 65000, "p50": 1.8, "p95": 2.4, "p99": 3.0, "total": 650000, "errors": 0 }, "raw": null },
    { "app": "next", "probe": "S", "enc": "identity", "nums": { "rps": 5000, "p50": 23.0, "p95": 35.0, "p99": 40.0, "total": 50000, "errors": 0 }, "raw": null },
    { "app": "next", "probe": "D", "enc": "identity", "nums": { "rps": 15000, "p50": 7.8, "p95": 12.0, "p99": 15.0, "total": 150000, "errors": 0 }, "raw": null },
    { "app": "next", "probe": "I", "enc": "identity", "nums": { "rps": 12000, "p50": 9.9, "p95": 14.0, "p99": 18.0, "total": 120000, "errors": 2 }, "raw": null },
    { "app": "brust-01x", "probe": "S", "enc": "identity", "nums": { "rps": 5100, "p50": 23.4, "p95": 34.9, "p99": 40.2, "total": 51000, "errors": 0 }, "raw": null },
    { "app": "brust-01x", "probe": "D", "enc": "identity", "nums": { "rps": 45000, "p50": 2.6, "p95": 5.0, "p99": 6.5, "total": 450000, "errors": 0 }, "raw": null },
    { "app": "brust-01x", "probe": "I", "enc": "identity", "nums": { "rps": 42000, "p50": 2.8, "p95": 5.4, "p99": 6.6, "total": 420000, "errors": 0 }, "raw": null }
  ]
}
```

- [ ] **Step 2: failing tests** — `bench/lib/report.test.ts`

```ts
import { describe, expect, test } from 'bun:test'
import fixture from './fixtures/results.json'
import { computeVerdict, renderMarkdown, renderVerdict, type Results, rpsOf } from './report'

const r = fixture as unknown as Results
const without01x: Results = { ...r, header: { ...r.header, apps: ['brust', 'bun-serve', 'next'], skipped: [{ app: 'brust-01x', reason: 'BRUST_01X_DIR unset' }] }, measurements: r.measurements.filter((m) => m.app !== 'brust-01x') }

describe('computeVerdict', () => {
  test('F68: v2 vs 0.1.x on D and I, identity; MET only when both ≥ 0', () => {
    const v = computeVerdict(r)
    expect(v.f68.d).toBeCloseTo(11.111, 2)
    expect(v.f68.i).toBeCloseTo(-4.762, 2)
    expect(v.f68.met).toBe(false)
    expect(computeVerdict({ ...r, measurements: r.measurements.map((m) => (m.app === 'brust-01x' && m.probe === 'I' ? { ...m, nums: { ...m.nums, rps: 40000 } } : m)) }).f68.met).toBe(true)
  })
  test('sanity: v2 / next per probe, MET when every ratio ≥ 2', () => {
    const v = computeVerdict(r)
    expect(v.sanity.s).toBeCloseTo(9.2, 3)
    expect(v.sanity.d).toBeCloseTo(3.3333, 3)
    expect(v.sanity.i).toBeCloseTo(3.3333, 3)
    expect(v.sanity.met).toBe(true)
    expect(computeVerdict({ ...r, measurements: r.measurements.map((m) => (m.app === 'next' && m.probe === 'I' ? { ...m, nums: { ...m.nums, rps: 30000 } } : m)) }).sanity.met).toBe(false)
  })
  test('ceiling: v2 / bun-serve in percent on D and I', () => {
    const v = computeVerdict(r)
    expect(v.ceiling.d).toBeCloseTo(83.333, 2)
    expect(v.ceiling.i).toBeCloseTo(61.538, 2)
  })
  test('a skipped app yields nulls, never NaN, and met = null', () => {
    const v = computeVerdict(without01x)
    expect(v.f68).toEqual({ d: null, i: null, met: null })
    expect(rpsOf(without01x, 'brust-01x', 'D')).toBeNull()
    expect(rpsOf(r, 'brust', 'D', 'gzip')).toBe(48000)
  })
})

describe('renderVerdict', () => {
  test('the three lines, byte-exact (spec §1.5)', () => {
    expect(renderVerdict(computeVerdict(r))).toBe(
      ['bar F68  : v2 vs 0.1.x  D +11.1%  I -4.8%   → NOT MET', 'sanity   : v2 vs next   S ×9.2  D ×3.3  I ×3.3   → MET (≥ 2×)', 'ceiling  : v2 / bun-serve  D 83.3%  I 61.5%        (target D ≥ 80%)'].join('\n'),
    )
  })
  test('missing 0.1.x → NOT MEASURED, dashes instead of numbers', () => {
    expect(renderVerdict(computeVerdict(without01x)).split('\n')[0]).toBe('bar F68  : v2 vs 0.1.x  D —  I —   → NOT MEASURED')
  })
})

describe('renderMarkdown', () => {
  test('header fields, one table per probe with identity + gzip columns, the verdict block, no prose', () => {
    const md = renderMarkdown(r)
    expect(md).toContain('# bench — 2026-10-10')
    expect(md).toContain('seed 12345')
    expect(md).toContain('load 3.1 4.2 4.0 (10 cores)')
    expect(md).toContain('next 16.4.0')
    expect(md).toContain('## S — `/types`')
    expect(md).toContain('| brust | 50,000 | 2.30 | 4.00 | 5.10 | 0 | 48,000 | 2.40 | 5.30 |')   // D row: identity then gzip
    expect(md).toContain('| next | 12,000 | 9.90 | 14.00 | 18.00 | 2 | — | — | — |')            // I row: no gzip pass
    expect(md).toContain('bar F68  : v2 vs 0.1.x  D +11.1%  I -4.8%   → NOT MET')
    expect(md).not.toMatch(/The gzip columns are|not slower|Bar \(/)                              // no hand-written sentences
    expect(renderMarkdown(without01x)).toContain('skipped: brust-01x (BRUST_01X_DIR unset)')
  })
})
```

Run: `bun test bench/lib/report.test.ts` → red.

- [ ] **Step 3: implementation** — `bench/lib/report.ts`

```ts
// bench/lib/report.ts — RESULTS.json (raw) + RESULTS.md (header, one table per probe, computed verdict block).
// No prose is generated here: the method lives in bench/README.md (spec §1.5).
import { join } from 'node:path'
import type { AppId } from './app'
import type { Encoding, OhaNums } from './oha'
import { PROBES, type ProbeId } from './probes'

export interface Measurement { app: AppId; probe: ProbeId; enc: Encoding; nums: OhaNums; raw: unknown }
export interface Header {
  date: string; host: string; cores: number; loadavg: number[]; seed: number; conn: number; dur: string; warmup: string; settleMs: number; workers: number
  versions: Record<string, string>; apps: AppId[]; skipped: { app: AppId; reason: string }[]; order: string[]
}
export interface Results { header: Header; measurements: Measurement[] }
export interface Verdict {
  f68: { d: number | null; i: number | null; met: boolean | null }
  sanity: { s: number | null; d: number | null; i: number | null; met: boolean | null }
  ceiling: { d: number | null; i: number | null }
}

export const APP_LABEL: Record<AppId, string> = { brust: 'brust', 'bun-serve': 'bun-serve', next: 'next', 'brust-01x': 'brust-01x' }

export function rpsOf(r: Results, app: AppId, probe: ProbeId, enc: Encoding = 'identity'): number | null {
  const m = r.measurements.find((x) => x.app === app && x.probe === probe && x.enc === enc)
  return m ? m.nums.rps : null
}
const pct = (a: number | null, b: number | null): number | null => (a === null || b === null || b === 0 ? null : ((a - b) / b) * 100)
const ratio = (a: number | null, b: number | null): number | null => (a === null || b === null || b === 0 ? null : a / b)
const share = (a: number | null, b: number | null): number | null => (a === null || b === null || b === 0 ? null : (a / b) * 100)
const allOf = (xs: (number | null)[], ok: (n: number) => boolean): boolean | null => (xs.some((x) => x === null) ? null : xs.every((x) => ok(x as number)))

export function computeVerdict(r: Results): Verdict {
  const v2 = (p: ProbeId) => rpsOf(r, 'brust', p)
  const f68d = pct(v2('D'), rpsOf(r, 'brust-01x', 'D'))
  const f68i = pct(v2('I'), rpsOf(r, 'brust-01x', 'I'))
  const s = ratio(v2('S'), rpsOf(r, 'next', 'S'))
  const d = ratio(v2('D'), rpsOf(r, 'next', 'D'))
  const i = ratio(v2('I'), rpsOf(r, 'next', 'I'))
  return {
    f68: { d: f68d, i: f68i, met: allOf([f68d, f68i], (n) => n >= 0) },
    sanity: { s, d, i, met: allOf([s, d, i], (n) => n >= 2) },
    ceiling: { d: share(v2('D'), rpsOf(r, 'bun-serve', 'D')), i: share(v2('I'), rpsOf(r, 'bun-serve', 'I')) },
  }
}

const signed = (n: number | null) => (n === null ? '—' : `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(1)}%`)
const times = (n: number | null) => (n === null ? '×—' : `×${n.toFixed(1)}`)
const percent = (n: number | null) => (n === null ? '—' : `${n.toFixed(1)}%`)
const met = (m: boolean | null, suffix = '') => (m === null ? `NOT MEASURED${suffix}` : m ? `MET${suffix}` : `NOT MET${suffix}`)

export function renderVerdict(v: Verdict): string {
  return [
    `bar F68  : v2 vs 0.1.x  D ${signed(v.f68.d)}  I ${signed(v.f68.i)}   → ${met(v.f68.met)}`,
    `sanity   : v2 vs next   S ${times(v.sanity.s)}  D ${times(v.sanity.d)}  I ${times(v.sanity.i)}   → ${met(v.sanity.met, ' (≥ 2×)')}`,
    `ceiling  : v2 / bun-serve  D ${percent(v.ceiling.d)}  I ${percent(v.ceiling.i)}        (target D ≥ 80%)`,
  ].join('\n')
}

const int = (n: number) => Math.round(n).toLocaleString('en-US')
const ms = (n: number) => n.toFixed(2)

export function renderMarkdown(r: Results): string {
  const h = r.header
  const versions = Object.entries(h.versions).map(([k, v]) => `${k} ${v}`).join(' · ')
  const lines: string[] = [
    `# bench — ${h.date}`,
    '',
    `host ${h.host} · ${versions} · seed ${h.seed} · \`oha -c ${h.conn} -z ${h.dur}\` · settle ${h.settleMs} ms + warm-up ${h.warmup} discarded · workers ${h.workers} · load ${h.loadavg.join(' ')} (${h.cores} cores) · order ${h.order.join(' ')}`,
  ]
  if (h.skipped.length) lines.push('', `skipped: ${h.skipped.map((s) => `${s.app} (${s.reason})`).join(', ')}`)
  for (const p of PROBES) {
    lines.push('', `## ${p.id} — \`${p.path}\``, '', '| app | rps | p50 ms | p95 ms | p99 ms | errors | gzip rps | gzip p50 | gzip p99 |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|')
    for (const app of h.apps) {
      const id = r.measurements.find((m) => m.app === app && m.probe === p.id && m.enc === 'identity')
      if (!id) continue
      const gz = r.measurements.find((m) => m.app === app && m.probe === p.id && m.enc === 'gzip')
      lines.push(`| ${APP_LABEL[app]} | ${int(id.nums.rps)} | ${ms(id.nums.p50)} | ${ms(id.nums.p95)} | ${ms(id.nums.p99)} | ${id.nums.errors} | ${gz ? int(gz.nums.rps) : '—'} | ${gz ? ms(gz.nums.p50) : '—'} | ${gz ? ms(gz.nums.p99) : '—'} |`)
    }
  }
  lines.push('', '```', renderVerdict(computeVerdict(r)), '```', '', 'Generated by `bun run bench` (`bench/run.ts`) from `RESULTS.json`; method and reading guide in `bench/README.md`.', '')
  return lines.join('\n')
}

export async function writeResults(dir: string, r: Results): Promise<void> {
  await Bun.write(join(dir, 'RESULTS.json'), `${JSON.stringify(r, null, 2)}\n`)
  await Bun.write(join(dir, 'RESULTS.md'), renderMarkdown(r))
}
```

Run: `bun test bench/lib/report.test.ts` → `7 pass`; `bun check -p bench` → 0 errors.

- [ ] **Step 4: commit**

```bash
git add bench/lib/report.ts bench/lib/report.test.ts bench/lib/fixtures/results.json
git commit -m "bench: lib/report — RESULTS.json/.md renderer and the F68 / sanity / ceiling verdict math

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: `lib/apps.ts` + `run.ts` CLI + README (delete the old runner)

**Files**
- Create: `bench/lib/apps.ts`, `bench/run.ts` (new content), `bench/README.md` (rewrite)
- Delete: today's `bench/run.ts` (overwritten by the new file — `git rm` is implicit; the diff shows a full replacement)

**Interfaces**
- `bench/lib/apps.ts` produces: `export const APPS: Record<AppId, AppSpec>`; `export function nextServerJs(cwd: string): string`; `export async function brustSanity(base: string, probe: ProbeId): Promise<void>`; `export function prepare01x(dir: string): string` (rsync + data copy, returns the app dir inside the 0.1.x checkout).
- `bench/run.ts` consumes every lib; flags: `--apps brust,bun-serve,next,brust-01x` (default all four; 01x auto-skipped when `BRUST_01X_DIR` is unset) · `--probes S,D,I` · `--conn 120` · `--dur 10s` · `--warmup 3s` · `--settle 1000` · `--enc identity|gzip|both` (default both) · `--seed <n>` (default `Date.now() % 1e9`) · `--out bench` · `--workers <n>` (default cores) · `--timeout 60000`. Exit codes: 0 ok · 1 missing tool / build / parity / sanity failure · 2 busy host.

- [ ] **Step 1: app registry** — `bench/lib/apps.ts`

```ts
// bench/lib/apps.ts — the four comparators (spec §1.1 / §1.3). Every app in production mode; ports fixed per app;
// the runner restarts a server per (app, probe) so every row starts from a cold process.
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join, resolve } from 'node:path'
import type { AppId, AppSpec } from './app'
import type { ProbeId } from './probes'

export const ROOT = resolve(import.meta.dir, '../..')
const BRUST_BIN = join(ROOT, 'packages/brust/bin/brust')
const sh = (cmd: string[], cwd: string, log?: (s: string) => void): void => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
  log?.(r.stdout.toString().trimEnd())
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')} (cwd ${cwd}) exited ${r.exitCode}:\n${r.stderr.toString()}\n${r.stdout.toString()}`)
}
const out = (cmd: string[], cwd = ROOT): string => { const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' }); return r.exitCode === 0 ? r.stdout.toString().trim() : '?' }
const workers = () => process.env.BENCH_WORKERS ?? String(availableParallelism())

/** Standalone output lands under `.next/standalone/<path from outputFileTracingRoot>/server.js`. */
export function nextServerJs(cwd: string): string {
  const candidates = [join(cwd, '.next/standalone/bench/apps/next/server.js'), join(cwd, '.next/standalone/server.js')]
  const hit = candidates.find((p) => existsSync(p))
  if (!hit) throw new Error(`next standalone server.js not found; looked at:\n  ${candidates.join('\n  ')}\n(run \`bun run build\` in bench/apps/next)`)
  return hit
}

/** Review Focus 5: the brust app must serve S from L1 and D/I from the loader on ?nocache=1. */
export async function brustSanity(base: string, probe: ProbeId): Promise<void> {
  const hdr = async (path: string) => (await fetch(`${base}${path}`)).headers.get('x-brust-cache')
  if (probe === 'S') {
    await hdr('/types')
    const second = await hdr('/types')
    if (second !== 'HIT') throw new Error(`brust sanity S: second /types answered x-brust-cache=${second}, expected HIT (cache: ttl_seconds on /types?)`)
  } else {
    const path = probe === 'D' ? '/dex?nocache=1' : '/team?nocache=1'
    await hdr(path)
    const second = await hdr(path)
    if (second === 'HIT') throw new Error(`brust sanity ${probe}: ${path} answered HIT on the second request — bypass: 'query(nocache)' is not in effect`)
  }
}

/** Copy the 0.1.x app + data into the 0.1.x checkout, where its relative imports resolve. */
export function prepare01x(dir: string): string {
  const dst = join(dir, 'bench/apps/m3-01x')
  mkdirSync(dst, { recursive: true })
  cpSync(join(ROOT, 'bench/apps/brust-01x'), dst, { recursive: true, force: true })
  cpSync(join(ROOT, 'bench/apps/_shared/data.json'), join(dst, 'data.json'), { force: true })
  return dst
}

const brust: AppSpec = {
  id: 'brust', label: 'brust v2', cwd: join(ROOT, 'bench/apps/brust'), port: 38201,
  available: () => ({ ok: true }),
  build: async (log) => sh([BRUST_BIN, 'build', 'routes.tsx'], join(ROOT, 'bench/apps/brust'), log),
  startCmd: () => ({ cmd: [BRUST_BIN, 'start', '--port', '38201', '--workers', workers()], env: { BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', RUST_LOG: 'warn' } }),
  ready: /\[brust\] ready/,
  version: async () => `${(await Bun.file(join(ROOT, 'packages/brust/package.json')).json()).version} @ ${out(['git', 'rev-parse', '--short', 'HEAD'])}`,
  sanity: brustSanity,
}

const bunServe: AppSpec = {
  id: 'bun-serve', label: 'Bun.serve + renderToString', cwd: join(ROOT, 'bench/apps/bun-serve'), port: 38202,
  available: () => ({ ok: true }),
  build: async () => {},
  startCmd: () => ({ cmd: ['bun', 'index.ts'], env: { BENCH_PORT: '38202', NODE_ENV: 'production' } }),
  ready: /\[bun-serve\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
  version: async () => Bun.version,
}

const next: AppSpec = {
  id: 'next', label: 'Next.js 16.4.0 (standalone, Node)', cwd: join(ROOT, 'bench/apps/next'), port: 38203,
  available: () => ({ ok: true }),
  build: async (log) => {
    const cwd = join(ROOT, 'bench/apps/next')
    sh(['bun', 'run', 'build'], cwd, log)
    const server = nextServerJs(cwd)
    cpSync(join(cwd, '.next/static'), join(server, '../.next/static'), { recursive: true, force: true })
  },
  startCmd: () => ({ cmd: ['node', nextServerJs(join(ROOT, 'bench/apps/next'))], env: { PORT: '38203', HOSTNAME: '127.0.0.1', NODE_ENV: 'production' } }),
  ready: /Ready in|Local:\s+http:\/\/\S+/,
  version: async () => (await Bun.file(join(ROOT, 'node_modules/next/package.json')).json()).version,
}

const brust01x: AppSpec = {
  id: 'brust-01x', label: 'brust 0.1.x', cwd: process.env.BRUST_01X_DIR ?? '', port: 38204,
  available: () => (process.env.BRUST_01X_DIR ? { ok: true } : { ok: false, reason: 'BRUST_01X_DIR unset' }),
  build: async (log) => {
    const dir = process.env.BRUST_01X_DIR!
    if (!existsSync(join(dir, 'runtime')) || !readdirSync(join(dir, 'runtime')).some((f) => f.endsWith('.node')))
      throw new Error(`0.1.x addon missing in ${dir}/runtime (cd runtime && bun run build)`)
    prepare01x(dir)
    sh(['bun', 'run', 'runtime/cli/index.ts', 'build', 'bench/apps/m3-01x/index.ts'], dir, log)
  },
  startCmd: () => ({ cmd: ['bun', 'run', 'bench/apps/m3-01x/index.ts'], env: { BRUST_PORT: '38204', BRUST_WORKERS: workers(), RUST_LOG: 'brust=warn', NODE_ENV: 'production' }, cwd: process.env.BRUST_01X_DIR }),
  ready: /listening on 127\.0\.0\.1:(\d+)/,
  version: async () => (await Bun.file(join(process.env.BRUST_01X_DIR!, 'package.json')).json()).version,
}

export const APPS: Record<AppId, AppSpec> = { brust, 'bun-serve': bunServe, next, 'brust-01x': brust01x }
export const APP_ORDER: AppId[] = ['brust', 'bun-serve', 'next', 'brust-01x']
```

- [ ] **Step 2: the runner** — `bench/run.ts` (replaces the old file entirely)

```ts
// bench/run.ts — M3 bench suite (spec §1). Manual, load-guarded, never in CI.
//   BRUST_RELEASE_ADDON=1 bun run bench                                      # brust, bun-serve, next (01x skipped)
//   BRUST_RELEASE_ADDON=1 BRUST_01X_DIR=/path/to/0.1.x bun run bench         # + 0.1.x → F68 line measured
//   bun bench/run.ts --apps brust,next --probes D --dur 3s --enc identity --seed 7
// Flow: guards → build every app → parity (abort on mismatch) → shuffled (app, probe) loop, server restarted per
// pair, 1 s settle + discarded warm-up, identity then gzip → RESULTS.json + RESULTS.md. Exit 0 ok, 1 failure, 2 busy.
import { cpus, hostname, loadavg } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { type AppId, type AppSpec, killAllOnExit, startApp } from './lib/app'
import { APP_ORDER, APPS, ROOT } from './lib/apps'
import { evaluateGuards, probeHost } from './lib/guard'
import { type Encoding, runOha } from './lib/oha'
import { checkParity } from './lib/parity'
import { probe as probeOf, PROBES, type ProbeId } from './lib/probes'
import { mulberry32, shuffle } from './lib/random'
import { type Measurement, type Results, renderVerdict, computeVerdict, writeResults } from './lib/report'

const { values: f } = parseArgs({
  args: process.argv.slice(2),
  options: {
    apps: { type: 'string', default: APP_ORDER.join(',') }, probes: { type: 'string', default: 'S,D,I' },
    conn: { type: 'string', default: '120' }, dur: { type: 'string', default: '10s' }, warmup: { type: 'string', default: '3s' },
    settle: { type: 'string', default: '1000' }, enc: { type: 'string', default: 'both' }, seed: { type: 'string' },
    out: { type: 'string', default: 'bench' }, workers: { type: 'string' }, timeout: { type: 'string', default: '60000' },
  },
})
const say = (s: string) => console.log(`[bench] ${s}`)
const die = (code: 1 | 2, s: string): never => { console.error(`[bench] ${s}`); process.exit(code) }

const appIds = f.apps!.split(',').map((s) => s.trim()).filter(Boolean) as AppId[]
for (const a of appIds) if (!(a in APPS)) die(1, `unknown app ${a} (choose from ${APP_ORDER.join(', ')})`)
const probeIds = f.probes!.split(',').map((s) => s.trim()).filter(Boolean) as ProbeId[]
for (const p of probeIds) probeOf(p)
const encs: Encoding[] = f.enc === 'both' ? ['identity', 'gzip'] : f.enc === 'identity' || f.enc === 'gzip' ? [f.enc] : die(1, `--enc must be identity|gzip|both`)
const conn = Number.parseInt(f.conn!, 10)
const settleMs = Number.parseInt(f.settle!, 10)
const timeoutMs = Number.parseInt(f.timeout!, 10)
const seed = f.seed !== undefined ? Number.parseInt(f.seed, 10) : Date.now() % 1_000_000_000
if (f.workers) process.env.BENCH_WORKERS = f.workers
const cores = cpus().length
const workersN = Number.parseInt(process.env.BENCH_WORKERS ?? String(cores), 10)

// 1. Guards (spec §1.3): busy host → 2; missing tool/declaration → 1. No flag skips them.
const skipped: { app: AppId; reason: string }[] = []
const apps: AppSpec[] = []
for (const id of appIds) {
  const av = APPS[id].available()
  if (av.ok) apps.push(APPS[id])
  else { skipped.push({ app: id, reason: av.reason }); say(`${id}: skipped (${av.reason})`) }
}
const g = evaluateGuards(probeHost({ needNode: apps.some((a) => a.id === 'next'), needBrustAddon: apps.some((a) => a.id === 'brust') }))
if (!g.ok) die(g.code, g.reason)
const load = loadavg().map((l) => Math.round(l * 100) / 100)
say(`load average ${load.join(' ')} (${cores} cores) · seed ${seed} · apps ${apps.map((a) => a.id).join(',')} · probes ${probeIds.join(',')} · enc ${encs.join('+')}`)
killAllOnExit()

// 2. Build every app (production mode, spec §1.3).
for (const a of apps) {
  say(`build ${a.id} …`)
  try { await a.build((s) => { if (s) console.log(s.split('\n').map((l) => `  ${l}`).join('\n')) }) } catch (e) { die(1, `build ${a.id} failed: ${(e as Error).message}`) }
}

// 3. Parity before any load (spec §1.4): one server per app, three GETs, normalized <main> must match app #1.
const html: Record<ProbeId, { app: string; html: string }[]> = { S: [], D: [], I: [] }
for (const a of apps) {
  const run = await startApp(a, { timeoutMs }).catch((e) => die(1, (e as Error).message))
  try {
    await Bun.sleep(settleMs)
    for (const p of probeIds) {
      const r = await fetch(`${run.base}${probeOf(p).path}`)
      if (r.status !== 200) die(1, `${a.id} ${probeOf(p).path} → HTTP ${r.status}`)
      html[p].push({ app: a.id, html: await r.text() })
    }
  } finally { await run.stop() }
}
for (const p of probeIds) {
  try { await checkParity(html[p], p) } catch (e) { die(1, (e as Error).message) }
  say(`parity ${p}: ${html[p].map((x) => x.app).join(' = ')} ✓`)
}

// 4. Shuffled measure loop (spec §1.3): app order and probe order from the seed; server restarted per pair.
const rnd = mulberry32(seed)
const pairs = shuffle(apps, rnd).flatMap((a) => shuffle(probeIds, rnd).map((p) => ({ a, p })))
const order = pairs.map(({ a, p }) => `${a.id}:${p}`)
say(`order ${order.join(' ')}`)
const measurements: Measurement[] = []
for (const { a, p } of pairs) {
  const run = await startApp(a, { timeoutMs }).catch((e) => die(1, (e as Error).message))
  try {
    await Bun.sleep(settleMs)
    if (a.sanity) await a.sanity(run.base, p).catch((e) => die(1, (e as Error).message))
    const url = `${run.base}${probeOf(p).path}`
    for (const enc of encs) {
      await runOha(url, { conn, dur: f.warmup!, enc })                       // discarded JIT warm-up
      const { raw, ...nums } = await runOha(url, { conn, dur: f.dur!, enc })
      measurements.push({ app: a.id, probe: p, enc, nums, raw })
      console.log(`  ${a.id.padEnd(10)} ${p} ${enc.padEnd(8)} ${nums.rps.toFixed(0).padStart(7)} rps  p50 ${nums.p50.toFixed(2)} ms  p99 ${nums.p99.toFixed(2)} ms  errors ${nums.errors}`)
    }
  } finally { await run.stop() }
}

// 5. Report (spec §1.5): numbers only.
const versions: Record<string, string> = { bun: Bun.version, oha: Bun.spawnSync(['oha', '--version']).stdout.toString().trim().replace(/^oha /, '') }
const nodeV = Bun.spawnSync(['node', '--version']); if (nodeV.exitCode === 0) versions.node = nodeV.stdout.toString().trim()
for (const a of apps) versions[a.id] = await a.version()
const results: Results = {
  header: { date: new Date().toISOString().slice(0, 10), host: `${process.platform}/${process.arch} ${hostname()}`, cores, loadavg: load, seed, conn, dur: f.dur!, warmup: f.warmup!, settleMs, workers: workersN, versions, apps: apps.map((a) => a.id), skipped, order },
  measurements,
}
const outDir = join(ROOT, f.out!)
await writeResults(outDir, results)
console.log(`\n${renderVerdict(computeVerdict(results))}\n`)
say(`wrote ${join(outDir, 'RESULTS.md')} and RESULTS.json`)
process.exit(0)
```

- [ ] **Step 3: README** — `bench/README.md` (full rewrite)

````markdown
# bench — brust v2 vs Bun.serve vs Next.js 16.4 vs brust 0.1.x

Three pages, four servers, one `oha`. `bench/run.ts` builds every app in production mode, checks the pages are the
SAME page (parity), then measures each (app, probe) on a freshly started server and writes `RESULTS.json` +
`RESULTS.md` from the numbers alone (spec: `docs/design/2026-10-10-m3-perf-bench-design.md` §1).

```bash
cd packages/brust && bun run build                 # RELEASE addon (not build:debug) — the runner cannot tell
bun install                                        # once: pulls next@16.4.0 into the workspace
BRUST_RELEASE_ADDON=1 bun run bench                # brust · bun-serve · next (0.1.x skipped)
BRUST_RELEASE_ADDON=1 BRUST_01X_DIR=/path/to/0.1.x bun run bench      # + 0.1.x → the F68 line is measured
bun bench/run.ts --apps brust,next --probes D --dur 3s --enc identity --seed 7   # a quick partial run
```

Prerequisites: `oha` on PATH (`cargo install oha`); Node ≥ 22 on PATH (Next.js runs on Node, never on Bun);
for 0.1.x its release addon (`cd $BRUST_01X_DIR/runtime && bun run build`).

## Pages (probes)

| probe | path | what | brust v2 | Next.js |
|---|---|---|---|---|
| S | `/types` | 18 type tiles, cacheable | L1 HIT after the first request (`cache: { ttl_seconds: 3600 }`) | static (prerendered) |
| D | `/dex?nocache=1` | loader reads `apps/_shared/data.json`, 151 rows, a `TypeBadge` per type | `bypass: 'query(nocache)'` → loader every request, jobs from the job cache | `dynamic = 'force-dynamic'` |
| I | `/team?nocache=1` | one interactive `Counter` island (`useReducer`) | react tier: `ssr` job + idle hydration | `'use client'` in a dynamic page |

`?nocache=1` is honoured by brust only; the other servers never cache. The markup contract is
`apps/_shared/pages.md`; the data is `apps/_shared/data.json` (regenerate with `bun bench/apps/_shared/gen-data.ts`).

## Fairness (enforced by `lib/guard.ts` and `run.ts`, not by this text)

- Same host, same session; the runner exits 2 when the 1-min load average exceeds the core count.
- Production mode everywhere: brust `brust build && brust start --workers <cores>` on the workspace Bun with a release
  addon (`BRUST_RELEASE_ADDON=1` is your declaration); Bun.serve on the same Bun; Next.js `next build` then
  `node .next/standalone/…/server.js` (its canonical runtime); 0.1.x on its own release addon.
- Next.js is one Node process, as shipped. A clustered row (`NEXT_CLUSTER=n` behind a port-sharing proxy) is out of
  scope — read the Next rows as "Next.js as shipped", not "Next.js tuned".
- `oha -c 120 -z 10s --no-tui --output-format json`; `accept-encoding: identity` is the bar, gzip a second column.
  1 s settle + a discarded 3 s warm-up per (app, probe); the server is restarted per (app, probe); app and probe
  order are shuffled per run (seed printed and stored in RESULTS).
- Parity runs before any load: `<main>` of every page is normalized (scripts/links/styles/comments dropped, island
  wrappers unwrapped, attributes ignored, whitespace collapsed) and compared by tag sequence + text; a mismatch aborts.

## Reading RESULTS.md

One table per probe (rows = apps; rps, p50/p95/p99 ms, errors; identity then gzip) and a verdict block:

```
bar F68  : v2 vs 0.1.x  D +x.x%  I +y.y%   → MET / NOT MET        minimum bar: v2 ≥ 0.1.x on D and I (identity)
sanity   : v2 vs next   S ×a  D ×b  I ×c   → MET / NOT MET (≥ 2×)  v2 at least twice Next.js on every probe
ceiling  : v2 / bun-serve  D p%  I q%        (target D ≥ 80%)      raw Bun.serve is the reference ceiling
```

`errors` excludes oha's "aborted due to deadline" (requests cut by `-z`, not failures); the raw oha JSON is in
`RESULTS.json`. macOS numbers are not Linux numbers. **Until the first run of this runner on the lead's host, the
committed `RESULTS.md`/`RESULTS.json` are from the previous runner (v2 pokedex vs 0.1.x pokedex, probes A/B/C) and
do not have this format.**

## Per-stage attribution (`attribution.ts`)

Unchanged from M2: process CPU per request and, on an instrumented build, per-stage µs for v2 (`attribution.patch`).

```bash
git apply bench/attribution.patch && (cd packages/brust && bun run build)
BRUST_RELEASE_ADDON=1 BRUST_01X_DIR=/path/to/0.1.x BENCH_CONN=120,1 bun run bench/attribution.ts
git apply -R bench/attribution.patch && (cd packages/brust && bun run build)
```
````

- [ ] **Step 4: gates + a short real run**

```bash
cd ~/code/brust-lane-m3b-bench-suite
bun check -p bench                                   # 0 errors
bun build --no-bundle bench/run.ts > /dev/null       # ok
bun test bench/lib                                   # every lib test green
BRUST_RELEASE_ADDON=1 bun bench/run.ts --apps bun-serve,brust --probes S --dur 2s --warmup 1s --enc identity --seed 1
```
Expected console: `[bench] load average …`, `build brust …`, `[bench] parity S: bun-serve = brust ✓`, `[bench] order …`, two `rps` lines, the three verdict lines (`bar F68 … → NOT MEASURED`, `sanity … NOT MEASURED`, `ceiling … D —  I —`), `wrote …/bench/RESULTS.md`. Then `git checkout bench/RESULTS.md bench/RESULTS.json` (the 2 s partial must NOT be committed; Task 13 commits a full run). Also run once with `--apps brust,next --probes I --dur 2s` to prove the Next path (Node 22, standalone, parity on the island page).

- [ ] **Step 5: commit**

```bash
git add bench/lib/apps.ts bench/run.ts bench/README.md
git commit -m "bench: run.ts v2 — guards, builds, parity, shuffled oha loop, RESULTS writer; README rewritten

Replaces the M2 two-sided pokedex runner (its 0.1.x compare is now the brust-01x app).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: CI gates + workspace/Makefile wiring

**Files**
- Modify: `.github/workflows/ci.yml` (server job), `Makefile` (`PKG_FILES`), root `package.json` (already has the workspaces from Task 5; add a `bench:test` script)

- [ ] **Step 1: ci.yml** — in the `server` job, replace the single line `- run: bun build --no-bundle bench/run.ts > /dev/null` with:

```yaml
      # m3b: the bench suite's cheap gates (spec §1.6). The bench itself is manual and load-guarded — never here.
      - run: bun check -p bench
      - run: bun check -p bench/apps/next
      - run: bun build --no-bundle bench/run.ts > /dev/null
      - run: bun test bench/lib
```

Triggers stay `pull_request` → `v2` + `workflow_dispatch` (PR-only rule, spec §7). `bun test bench/lib` runs `app.test.ts`, which spawns the fixture servers on random ports — fine on a runner; it never starts brust/next.

- [ ] **Step 2: Makefile** — extend the stamp inputs so a bench package.json change re-runs `bun install`:

```make
PKG_FILES := package.json bun.lock \
  $(wildcard packages/*/package.json examples/*/package.json npm/*/package.json tests/server/package.json bench/apps/*/package.json)
```

- [ ] **Step 3: root package.json script** — add `"bench:test": "bun check -p bench && bun test bench/lib"` next to `"bench": "bun bench/run.ts"`.

- [ ] **Step 4: verify locally exactly what CI runs**

```bash
bun install --frozen-lockfile        # must succeed: the lockfile committed in Task 7 is complete
bun check -p bench && bun check -p bench/apps/next && bun build --no-bundle bench/run.ts > /dev/null && bun test bench/lib && echo GATES-GREEN
make -n build | head -3              # the Makefile still parses
```

- [ ] **Step 5: commit**

```bash
git add .github/workflows/ci.yml Makefile package.json
git commit -m "ci: bench suite gates (bun check -p bench, bun test bench/lib); Makefile tracks bench package.json files

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: first real run on this host + READY note

**Files**
- Modify (generated): `bench/RESULTS.json`, `bench/RESULTS.md`; `bench/README.md` (drop the "until the first run" sentence)

- [ ] **Step 1: wait for a quiet host** — `uptime` 1-min load must be below the core count (10 on the lead's machine; on 2026-10-10 07:37 it was 8.68 — close; retry rather than lower the bar). Close other servers/editors' indexers if needed.

- [ ] **Step 2: run**

```bash
cd ~/code/brust-lane-m3b-bench-suite
(cd packages/brust && bun run build)                                   # RELEASE addon
(cd ~/code/brust/runtime && bun run build)                             # 0.1.x release addon
BRUST_RELEASE_ADDON=1 BRUST_01X_DIR=$HOME/code/brust bun run bench     # full: 4 apps × 3 probes × 2 encodings ≈ 24 × 14 s + builds
```

Expected: exit 0, parity ✓ ×3, 24 rps lines, the verdict block. If it exits 2, wait and rerun. If parity fails, fix the app whose normalized `<main>` differs (the diff names index and both values) — never the normalizer, unless the difference is a framework artefact of the kind §1.4 lists (then add it to `parity.ts` WITH a test).

- [ ] **Step 3: README note + commit the results**

Remove the bold "Until the first run …" sentence from `bench/README.md` (the files now have this format), then:

```bash
git add bench/RESULTS.json bench/RESULTS.md bench/README.md
git commit -m "bench: first run of the v2 suite on the lead's host (brust / bun-serve / next 16.4.0 / 0.1.x)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 4: READY** — post on the Conclave task: the three verdict lines, the three per-probe tables (paste from RESULTS.md), the seed, the load at start, and the lane head SHA. The lead merges `lane/m3b-bench-suite` into `m3p`. Expectation from the M2 numbers: F68 NOT MET today (D −22.6 %, I −34.4 % on the pokedex pages) — the suite's job is to show it, the perf lanes close it.

## Self-review

**Spec coverage (§1 subsection → task)**

| spec | where |
|---|---|
| §1.1 layout: `README.md`, `run.ts`, `lib/app.ts`, `lib/oha.ts`, `lib/parity.ts`, `lib/guard.ts`, `lib/report.ts`, `apps/_shared/{data.json,pages.md}`, `apps/{brust,bun-serve,next,brust-01x}`, RESULTS written only by run.ts, attribution kept, old run.ts deleted | T11 (README/run.ts/delete), T3 (app.ts; the per-app specs in the extra `lib/apps.ts`, probes in `lib/probes.ts`, seed in `lib/random.ts`), T1, T9, T2, T10, T4, T6, T5, T7, T8 |
| §1.2 the three pages, brust/Next behaviour, `?nocache` brust-only, shared data + contract | T4 (contract/data), T5–T8 (per app), T6 routes (`ttl_seconds` = spec's `l1`), T7 `force-dynamic` + static `/types` |
| §1.3 fairness: load guard, production mode everywhere, Node for Next, workers = cores, oha flags, settle + warm-up, restart per pair, shuffled seeded order, parity first | T2 (guards), T11 (`apps.ts` startCmds, loop, seed), README "Next.js as shipped" paragraph |
| §1.4 parity: strip script/link/style, framework attrs, hash ids, whitespace; tags + text of `<main>`; abort with diff | T9 (attributes dropped entirely = superset; comments + island wrappers added because the real outputs need them), T11 step 3 of the flow |
| §1.5 report: header fields, one table per probe, computed verdict block, no prose | T10 (byte-exact tests), T11 writes it |
| §1.6 CI: `bun check -p bench`, `bun build --no-bundle bench/run.ts`, unit tests for parity + verdict; bench manual | T12 (+ `bun check -p bench/apps/next` for the Next app, which has its own tsconfig) |
| §4 lane row, §6 decisions (option A app, Next 16.4.0 on Node 22, bar), §7 branch rules (m3p, no PR, docs direct) | Global Constraints; T13 READY |

**Risk ledger**

| risk | likelihood | mitigation in the plan |
|---|---|---|
| v2 compiler rejects a fragment-root leaf page or the nested `p.types.map(TypeBadge)` inside `<td>` | medium | T6 note: switch every app to the same `<section>` wrapper / flatten; `build.test.ts` is the gate; parity catches drift |
| Next 16.4.0 standalone `server.js` path / ready line differ from the plan (`Ready in` / `Local:`) | medium | `nextServerJs()` checks two paths and names them; `ready` regex accepts both; T7 smoke prints what it found |
| Next build in a Bun workspace: lockfile/root inference warnings, `data.json` outside the app dir not traced | medium | `outputFileTracingRoot` = repo root; `.next/static` copied next to the standalone server |
| 0.1.x compiler constraints (style object on x-for rows, fragment roots, nested map) break the 01x pages | medium | T8 smoke + the authoring-constraints note; only 01x files change; parity is the acceptance |
| Parity normalizer too strict (React text-node markers, entity spellings, `<brust-island>`/`div[data-brust-island]`, Next `<!--$-->`) or too loose (attributes ignored) | low | T9 fixtures mirror all four real outputs; attributes ignored by design (tags + text is what §1.4 names) |
| Load guard makes the first run hard on the lead's busy host (load 8.7 of 10 at planning time) | high | T13 says wait, not lower; exit 2 is distinguishable from failure |
| `bun check -p bench/apps/next` chokes on Next's tsconfig plugin / `.next/types` globs | low | separate CI line: drop ONLY that line if it is a `bun check` limitation (record in the commit), keep `bun check -p bench` |
| Port collisions (38201–38204) from an orphaned server | low | `killAllOnExit`, `stop()` with SIGKILL fallback, timeout kills the child |
| RESULTS committed from a partial run | low | T11 step 4 explicitly reverts; only T13 commits results |
