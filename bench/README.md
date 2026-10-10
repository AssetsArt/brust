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

## Host lock and ports

Measurements on the shared host are serialised (lead rule `bench-host-lock`): with `BENCH_LOCK_WS=<workspace id>` and
`BENCH_LOCK_ID='<slug> <agent>'` set, the runner waits for the blackboard key `bench:host-lock` to be free, sets it to
`'<slug> <agent> <ISO time>'` around the load phase only, and deletes it afterwards (a lock older than 20 min is stale).
Ports are `BENCH_PORT_BASE` (default 38300) + 1 brust, 2 bun-serve, 3 next, 4 brust-01x; the old M2 runner owns
38201-38204. `startApp` refuses a busy port by name and never kills a process it did not spawn.

## What differs from the pokedex

brust v2 builds `TypeBadge` as a static child fed by loader-precomputed `{type,label,color}` (a job-bearing child in the
nested dex list is the build error `nested-instance`) and passes the "151 Pokémon" line as one text slot (`{count} Pokémon`
compiles to a `<span x-text>`); parity unwraps the compiler's `<brust-host>` / `<brust-row>` hosts. Native pages carry
their rows in `x-props` for client reconcile, so brust D responses are larger than the plain-HTML apps'.

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
