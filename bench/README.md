# bench — brust v2 vs Bun.serve vs Next.js 16.4 vs brust 0.1.x, and Elysia 2 behind brust vs Elysia on Bun

Three pages, four servers, one `oha` — plus two Elysia action probes (A1/A2, below). `bench/run.ts` builds every app in production mode, checks the pages are the
SAME page (parity), then measures each (app, probe) on a freshly started server and writes `RESULTS.json` +
`RESULTS.md` from the numbers alone (spec: `docs/design/2026-10-10-m3-perf-bench-design.md` §1). The header names platform/arch and core count, never the machine's hostname (repo rule).

```bash
cd packages/brust && bun run build                 # RELEASE addon (not build:debug) — the runner cannot tell
bun install                                        # once: pulls next@16.4.0 into the workspace
BRUST_RELEASE_ADDON=1 bun run bench                # brust · bun-serve · next · elysia-bun (0.1.x skipped); probes S,D,I,A1,A2
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
| A1 | `GET /_brust/action/types` | the 18 `data.types` rows as JSON from one Elysia 2 route | `[actions]` entry, `brust()` adapter, answered through Rust and the worker `fetch` call kind | — (see Actions) |
| A2 | `POST /_brust/action/team` body `{"id":25}` | TypeBox-validated `{ id: number }` → `{ ok: true, id }` | same | — (see Actions) |

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

## Actions (A1/A2)

The same Elysia 2 app answers both probes on two stacks, so the route code is byte-identical:
`apps/_shared/actions-app.ts` (`GET /types`, `POST /team`), imported by `apps/brust/actions.ts` (the `[actions]` entry,
`brust()` adapter: Rust HTTP → worker `fetch` call kind → `app.fetch`) and by `apps/elysia-bun/index.ts` (Elysia's
default Bun adapter, `app.listen`). Only `brust` (shown as `elysia-brust` in the Actions tables) and `elysia-bun` run A1/A2; the runner builds (app, probe) pairs from
`Probe.apps`, so `elysia-bun` never gets S/D/I.

- Same URL on both: `elysia-bun` mounts the app under `/_brust/action`, the exact shape brust's worker builds
  (`new Elysia({ adapter: brust(), prefix }).use(app)`), so both route the same path through the same plugin tree.
- Measured at `oha -c 120 -z 10s` and again at `-c 1`, identity only. A-probe parity is equal parsed JSON bodies (status
  200, `application/json`), also checked against the expected value, so two equally wrong apps fail.
- Handlers are functions on both routes: Elysia's Bun adapter promotes a non-function handler to a native `Bun.serve`
  static route that runs no JS per request, and the `brust()` adapter never does. A value handler would compare Bun's
  native static path against a JS handler, so that path is deliberately not exercised.
- Budgets are not CPU-equal: brust = Rust tokio threads (= cores) + N Bun workers; elysia-bun = N Bun processes on one
  port. The brust side crosses one extra hop (Rust → napi → worker → Rust) that the Bun side does not have: that hop is
  what the c=1 p50 delta shows.
- `reusePort` on macOS does not balance: `elysia-bun` gets the same `/_count` balance check as bun-serve (5% minimum
  share, read after the c=120 row and before c=1), and an unbalanced row is labelled `1-proc` in RESULTS.md next to the
  numbers. On such a host the elysia-bun row is in practice a single-process measurement.
- Skipped on A: `next` (no Elysia; a Route Handler would be different code), `bun-serve` (the no-framework page
  ceiling), `brust-01x` (0.1.x actions are `defineActions`, not Elysia).
- `RESULTS.json` carries the A rows in a separate top-level `actions` block (`{ header, measurements[] }`, rows carry
  `conn`); `writeResults` merges into the existing file and replaces only the blocks the run measured, so an A-only run
  leaves `.header`/`.measurements` (F68, m2-exit) byte-identical.

## Host lock and ports

Measurements on the shared host are serialised (lead rule `bench-host-lock`), in two layers, always on for `bun run bench`:
an exclusive lock file `/tmp/brust-bench.lock` (O_EXCL, holder pid inside; a dead holder or one older than 20 min is
stale) and, with `BENCH_LOCK_WS=<workspace id>` + `BENCH_LOCK_ID='<slug> <agent>'`, the blackboard key `bench:host-lock`
(`'<slug> <agent> <ISO time>'`; read fail-closed — an unreadable key refuses the run —, set-then-verified, deleted only
if still ours). Only the load phase is under the lock; the holder aborts itself after 20 min. The guards run twice
(before the builds and again right before the load): 1- and 5-minute load average must not exceed the core count.
Every row must be a clean measurement: a non-200 status or any transport error fails the run (exit 1).
Ports are `BENCH_PORT_BASE` (default 38300) + 1 brust, 2 bun-serve, 3 next, 4 brust-01x, 5 elysia-bun (control ports: bun-serve +20…, elysia-bun +40…); the old M2 runner owns
38201-38204. Apps are spawned in their own process group and `stop()` signals only that group; `startApp` refuses a busy
port by name and never kills a process it did not spawn. Probe order is seeded, apps are interleaved within each probe.

## What differs from the pokedex

brust v2 builds `TypeBadge` as a static child fed by loader-precomputed `{type,label,color}` (a job-bearing child in the
nested dex list is the build error `nested-instance`) and passes the "151 Pokémon" line as one text slot (`{count} Pokémon`
compiles to a `<span x-text>`); parity unwraps the compiler's `<brust-host>` / `<brust-row>` hosts. Native pages carry
their rows in `x-props` for client reconcile, so brust D responses are larger than the plain-HTML apps'.

## Known artefacts of the comparison

- The gzip columns are not like-for-like: Next.js compresses every response, brust only dynamic pages of 16 KiB or more
  (an L1 HIT of `/types` is served identity), Bun.serve and 0.1.x never compress. The bar is the identity column.
- `bytes/resp` is what oha received. brust's D page is ~144 KB against ~22 KB for Bun.serve / 0.1.x: the native page
  carries all 151 rows in `x-props` (including fields the markup does not render) and every `TypeBadge` instance gets
  `x-data`/`x-props`/`x-bind-*` attributes although the manifest lists it as static. So F68 on D mixes payload with CPU.
- Next.js is one Node process as shipped; brust runs `--workers <cores>` and bun-serve runs the same number of copies on one port (`reusePort`). macOS does not balance `SO_REUSEPORT` (the last binder takes the traffic), so the runner reads each copy's `/_count` and, when any copy served under 5% of the requests, labels the ceiling line `1-proc` instead of silently comparing budgets.

## Reading RESULTS.md

One table per probe (rows = apps; rps, p50/p95/p99 ms, errors; identity then gzip) and a verdict block:

```
bar F68  : v2 vs 0.1.x  D +x.x%  I +y.y%   → MET / NOT MET        minimum bar: v2 ≥ 0.1.x on D and I (identity)
sanity   : v2 vs next   S ×a  D ×b  I ×c   → MET / NOT MET (≥ 2×)  v2 at least twice Next.js on every probe
ceiling  : v2 / bun-serve  D p%  I q%        (target D ≥ 80%)      raw Bun.serve is the reference ceiling
```

The Actions section adds one table per A probe (rows = app × connection count) and a verdict line:

```
actions  : elysia-brust / elysia-bun (c=120)  A1 x%  A2 y%   · c=1 p50 elysia-brust − elysia-bun  A1 +n µs  A2 +m µs
```

(elysia-brust is the `brust` app serving the Elysia routes — S/D/I rows keep the name `brust`; its rps as a percentage of elysia-bun's at c=120; the c=1 p50 difference is the per-request cost of the hop.)

`errors` excludes oha's "aborted due to deadline" (requests cut by `-z`, not failures); the raw oha JSON is in
`RESULTS.json`. macOS numbers are not Linux numbers.

## Per-stage attribution (`attribution.ts`)

Unchanged from M2: process CPU per request and, on an instrumented build, per-stage µs for v2 (`attribution.patch`).

```bash
git apply bench/attribution.patch && (cd packages/brust && bun run build)
BRUST_RELEASE_ADDON=1 BRUST_01X_DIR=/path/to/0.1.x BENCH_CONN=120,1 bun run bench/attribution.ts
git apply -R bench/attribution.patch && (cd packages/brust && bun run build)
```
