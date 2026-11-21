# bench — brust v2 vs Bun.serve vs Next.js 16.4, and Elysia 2 behind brust vs Elysia on Bun

Four pages, three page servers, one `oha` — plus two Elysia action probes (A1/A2, below). `bench/run.ts` builds every
app in production mode, checks the pages are the SAME page (parity), measures what each app does for each probe, then
measures every (app, probe, encoding, connections) cell several times, interleaved, and writes
`bench/results/<date>-<chip>-<os>.{json,md}` from the numbers alone. The header names the machine model, chip, RAM,
CPU count, OS, the CPUs given to the servers and to the generator, every version and the seed — never the hostname.

```bash
cd packages/brust && bun run build                 # RELEASE addon (not build:debug) — the runner cannot tell
bun install                                        # once: pulls next@16.4.0 into the workspace
BRUST_RELEASE_ADDON=1 bun run bench                # one full run: brust · bun-serve · next · elysia-bun, 5 rounds
BRUST_RELEASE_ADDON=1 bun run bench --sweep default    # the worker sweep (brust · bun-serve · elysia-bun), 3 rounds
BRUST_RELEASE_ADDON=1 bun run bench --sweep default --quick   # the short preset: D, S-render, I, A1; identity; 3 × 6 s
BRUST_RELEASE_ADDON=1 bun run bench --publish      # also rewrite bench/RESULTS.{md,json} (the website reads them)
bun bench/run.ts --apps brust,next --probes D --rounds 3 --dur 5s --enc identity --seed 7   # a quick partial run
```

Prerequisites: `oha` on PATH or in `~/.cargo/bin` (`cargo install oha`); on Linux `taskset` and `lscpu` (util-linux).
Next.js runs on Node when `node` is on PATH, otherwise on Bun (`bun --bun next build`, `bun --bun` server);
`BENCH_NEXT_RUNTIME=node|bun` forces one, and the runtime and its version are printed next to Next's version.
0.1.x (`--apps brust-01x`, `BRUST_01X_DIR`) is measured only when asked.

## Pages (probes)

| probe | path | what | brust v2 | Bun.serve | Next.js |
|---|---|---|---|---|---|
| S | `/types` | 18 type tiles, cacheable | L1 HIT after the first request | renders every request | prerendered (`x-nextjs-cache: HIT`) |
| S-render | `/types?nocache=1` | the S page rendered per request | `bypass: 'query(nocache)'` | renders every request | — (serves its prerender whatever the query) |
| D | `/dex?nocache=1` | loader reads `apps/_shared/data.json`, 151 rows, a `TypeBadge` per type | loader every request, jobs from the job cache | renders every request | `dynamic = 'force-dynamic'` |
| I | `/team?nocache=1` | one interactive `Counter` island (`useReducer`) | react tier: `ssr` job + idle hydration | renders, no hydration | `'use client'` in a dynamic page |
| A1 | `GET /_brust/action/types` | the 18 `data.types` rows as JSON from one Elysia 2 route | `[actions]` entry, `brust()` adapter | — | — |
| A2 | `POST /_brust/action/team` body `{"id":25}` | TypeBox-validated `{ id: number }` → `{ ok: true, id }` | same | — | — |

Bun.serve is the no-framework ceiling: no cache, no hydration, on purpose. So S compares caches (brust and Next) and S-render
compares rendering (brust and Bun.serve); neither is read across. The markup contract is `apps/_shared/pages.md`; the
data is `apps/_shared/data.json` (regenerate with `bun bench/apps/_shared/gen-data.ts`).

## Method (enforced by `run.ts` and `lib/`, not by this text)

- **Never a shared core.** On Linux the physical cores are split (`lib/topology.ts`, from `lscpu`): the last
  `--gen-cores` (default 2) go to `oha`, the rest to the servers; SMT siblings stay on one side; every server and every
  `oha` runs under `taskset`. Where the runner cannot pin (macOS) the header says `unpinned: ratios only`.
- **Same budget for every app.** One count N (default: the logical CPUs of the server set; `--workers` overrides) is
  brust's `--workers`, Bun.serve's and Elysia's copies on one port (`reusePort`), and Next's copies through
  `node:cluster` (`apps/next/cluster.mjs`). brust's tokio threads and render slots stay at their default, which inside
  the server set is the same N; the header prints both.
- **Production mode everywhere**, built with the runtime that serves it; brust on a release addon (`BRUST_RELEASE_ADDON=1`
  is your declaration).
- **All apps up at once, cells interleaved.** Every app is started once, then each round runs every cell in its own
  seeded order (`--rounds`, default 5 for a run, 3 for a sweep); a 2 s warm-up per cell is discarded. Before each cell
  the host must be idle outside the bench (at most `--idle-max` CPUs busy, default 1; it waits up to `--idle-wait` s and
  then exits 2).
- **Two connection counts.** c=120 and a lower count found by calibration: the largest of 64, 48, 32, 24, 16, 8, 4 at
  which `oha` stays under 80% of its CPUs on the fastest probe of the run. A/B probes add c=1.
- **Measured, not assumed.** Before the load the runner asks each app every probe twice and prints a `work` line: cached
  (with the cache header that said so) or rendered per request, hydration scripts or none, compressed or not, body bytes.
  Bodies that differ by more than 10% are named under the table.
- **Marks, never silent:** `noisy` (rps (max-min)/median over 5%), `generator-limited` (`oha` used 90% or more of its
  CPUs: the number is the generator's ceiling, not the server's), `unbalanced` (busiest / idlest copy over 2:1 by CPU
  time from `/proc`, judged at 4 or more connections per copy), `copies idle` (the same ratio below 4 connections per
  copy: the kernel's port hash left copies without work, so fewer copies were measured), `not compressed` (a gzip
  request got identity). The generator's share is its exact CPU time (rusage, user + system) over the `-z` window.
- **What the low count measures.** For a multi-process app the calibrated low count (c=8 with N=8 on the build host)
  leaves some copies idle, a different number each round: those cells measure fewer working copies and carry `copies
  idle`. On a host where c=120 is generator-limited for an app and the low count leaves its copies idle (elysia-bun on
  A1/A2 on the build host), that app has no fully comparable row.
- Parity runs before any load: `<main>` of every page is normalized (scripts/links/styles/comments dropped, island
  wrappers unwrapped, attributes ignored, whitespace collapsed) and compared by tag sequence + text; a mismatch aborts.

### The sweep (`--sweep default` or `--sweep 1,2,4,8`)

`--quick` (run or sweep) is the short preset: probes D, S-render, I and A1, identity only, 3 rounds of 6 s; any flag
given explicitly still wins. The header prints the minutes planned and taken.

The same cells at c=120, identity, for each N (default: 1, 2, 3, then up to the server set's CPUs, at most 8 points).
Per (app, probe) the table names the best N: the highest median rps whose p99 is within 20% of the best p99 of the
sweep, next to the N brust would pick by default in the same CPU set.

N compares an app with itself. brust's N is Bun workers only (its tokio threads stay at the server set's CPUs), while
Bun.serve's and Elysia's N is whole processes: do not compare apps at the same N. Each N is one block (its rounds
interleave inside the block); the blocks run in a seeded shuffled order so host drift does not line up with N, but
drift between blocks still lands on the N axis.

## Actions (A1/A2)

The same Elysia 2 app answers both probes on two stacks, so the route code is byte-identical:
`apps/_shared/actions-app.ts` (`GET /types`, `POST /team`), imported by `apps/brust/actions.ts` (the `[actions]` entry,
`brust()` adapter: Rust HTTP → worker `fetch` call kind → `app.fetch`) and by `apps/elysia-bun/index.ts` (Elysia's
default Bun adapter, `app.listen`). Only `brust` (shown as `elysia-brust` in the Actions tables) and `elysia-bun` run A1/A2; the runner builds (app, probe) pairs from
`Probe.apps`, so `elysia-bun` never gets S/D/I.

- Same URL on both: `elysia-bun` mounts the app under `/_brust/action`, the exact shape brust's worker builds
  (`new Elysia({ adapter: brust(), prefix }).use(app)`), so both route the same path through the same plugin tree.
- Measured at c=120, the calibrated count and c=1, identity only. A-probe parity is equal parsed JSON bodies (status
  200, `application/json`), also checked against the expected value, so two equally wrong apps fail.
- Handlers are functions on both routes: Elysia's Bun adapter promotes a non-function handler to a native `Bun.serve`
  static route that runs no JS per request, and the `brust()` adapter never does. A value handler would compare Bun's
  native static path against a JS handler, so that path is deliberately not exercised.
- Budgets are not CPU-equal: brust = Rust tokio threads (= the server set's CPUs) + N Bun workers; elysia-bun = N Bun processes on one
  port. The brust side crosses one extra hop (Rust → napi → worker → Rust) that the Bun side does not have: that hop is
  what the c=1 p50 delta shows.
- Balance: `elysia-bun`'s copies get the same CPU-time balance check as every multi-process app (Method, above).
- Skipped on A: `next` (no Elysia; a Route Handler would be different code), `bun-serve` (the no-framework page
  ceiling), `brust-01x` (0.1.x actions are `defineActions`, not Elysia).
- `RESULTS.json` carries the A rows in a separate top-level `actions` block (`{ header, measurements[] }`, rows carry
  `conn`); `writeResults` merges into the existing file and replaces only the blocks the run measured, so an A-only run
  leaves `.header`/`.measurements` (F68, m2-exit) byte-identical.

## Host lock and ports

Measurements on the shared host are serialised (lead rule `bench-host-lock`), in two layers, always on for `bun run bench`:
an exclusive lock file `/tmp/brust-bench.lock` (O_EXCL, holder pid inside; a dead holder or one older than 20 min is
stale; `BENCH_LOCK_MAX_MIN` raises the 20 min for a long run, and the runner refuses a run whose estimate exceeds it) and, with `BENCH_LOCK_WS=<workspace id>` + `BENCH_LOCK_ID='<slug> <agent>'`, the blackboard key `bench:host-lock`
(`'<slug> <agent> <ISO time>'`; read fail-closed — an unreadable key refuses the run —, set-then-verified, deleted only
if still ours). Only the load phase is under the lock; the holder aborts itself after 20 min. The guards run twice
(before the builds, and before every cell: the idle check in Method): 1- and 5-minute load average must not exceed the core count.
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
- macOS does not balance `SO_REUSEPORT` (the last binder takes the traffic): there the multi-process rows are in
  practice one process, and the CPU balance is not measured (no `/proc`). Read macOS runs as ratios only.

## Reading the results

One table per probe: rows are (app, N for a sweep, connections, encoding) with the median rps of the rounds and its
[min-max], p50, p99 [min-max], bytes per response, the generator's CPU share, the copies' balance and the marks. Then:

- **Like with like** (a run): ratios at c=120, identity, only between apps doing the same work — S brust / Next (both   cached), S-render and D brust / Bun.serve and D, I brust / Next (all rendering), A1/A2 brust / elysia-bun at each count. A
  mark on either side is printed next to its ratio.
- **Best N** (a sweep), as above.
- **Marked cells**: every cell that carries a mark.

`--publish` writes the medians into `bench/RESULTS.{md,json}` in their old shape (the website and `scripts/m2-exit`
read them). Numbers from different hosts or OSes are not compared.

## Per-stage attribution (`attribution.ts`)

Unchanged from M2: process CPU per request and, on an instrumented build, per-stage µs for v2 (`attribution.patch`).

```bash
git apply bench/attribution.patch && (cd packages/brust && bun run build)
BRUST_RELEASE_ADDON=1 BRUST_01X_DIR=/path/to/0.1.x BENCH_CONN=120,1 bun run bench/attribution.ts
git apply -R bench/attribution.patch && (cd packages/brust && bun run build)
```
