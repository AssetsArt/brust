# M3-P: bench suite v2 + request-path performance — design

Status: APPROVED in conversation 2026-10-10 (sections 1–4 walked with the human; "เริ่มทำไปเลย").
Owner: lead Detoro (22499151) · authority: in-loop · base: v2 @ a833bc0 or later.
Reads before this: `docs/design/2026-10-09-m2-server-design.md` (S6, S7, S10), ledger row F68 in
`docs/plans/m1a-followups.md`, `docs/plans/2026-10-09-m2-render-perf.md` (what m2p already landed),
`bench/README.md` + `bench/attribution.ts` (the stage tree this spec reasons with).

## 0. Goal and non-goals

**Goal.** Two deliverables. (1) A standalone benchmark suite under `bench/`, written new in the
shape of 0.1.x's `bench/apps/*` + runner, that compares brust v2 with Bun.serve+`renderToString`,
Next.js (latest, 16.4.0) and optionally brust 0.1.x on the SAME three pages, and writes
`bench/RESULTS.md` from numbers only. (2) The v2 request path made as fast as the design allows —
every lever in §2 lands, measured with (1) after each one; no "beat 0.1.x and stop".

**The human's words.** "Improve performance และ แยก code bench ต่างหากคล้ายๆ v1 แต่เป็น code ใหม่
ใส่ nextjs เข้ามาด้วย" · "ใช้ nextjs version ล่าสุดนะ" · "ขอดีที่สุด ไม่ใช่มากกว่า v1 แล้วหยุดเลย".

**Bar (settled).** Minimum: v2 ≥ 0.1.x on probes D and I (identity encoding, same host, same run) —
this closes F68. Sanity: v2 ≥ 2× Next.js on every probe. Reference ceiling: Bun.serve raw; target to
chase on D: ≥ 80% of Bun.serve rps. Stop rule in §5.

**Non-goals.** Rendering on Bun threads, streaming, L2 (`key(ctx)`) cache, SSG, dev server, any
page-content change in `examples/pokedex`; running the bench in CI (manual, load-guarded, as today).

## 1. Bench suite (`bench/`, replaces the current runner)

### 1.1 Layout

```
bench/
  README.md                 how to run, fairness rules, how to read RESULTS
  run.ts                    runner CLI: --apps a,b --probes S,D,I --conn 120 --dur 10s --enc identity|gzip|both
  lib/app.ts                AppSpec: name, cwd, build(), start() → {proc, port}, stop(); port scraped from stdout regex
  lib/oha.ts                runOha(url, {conn, dur, enc, body?}) → parsed oha JSON (rps, p50/p95/p99, errors)
  lib/parity.ts             fetch each probe from each app once; normalize; assert equal (§1.4)
  lib/guard.ts              load-average, oha on PATH, brust release addon, Node ≥ 22 for next
  lib/report.ts             RESULTS.json (raw) + RESULTS.md (table + computed verdict lines)
  apps/_shared/data.json    151 rows derived from examples/pokedex/data/pokedex.json (id, name, displayName, num, types[])
  apps/_shared/pages.md     the three pages' required markup (the parity contract, human-readable)
  apps/brust/               brust v2 app: routes.tsx, pages/, components/, brust.toml; `brust build && brust start`
  apps/bun-serve/           Bun.serve + react-dom/server renderToString, same components copied (no framework)
  apps/next/                Next.js 16.4.0 App Router, `output: 'standalone'`, `next build && node .next/standalone/server.js`
  apps/brust-01x/           0.1.x app (same pages) run from $BRUST_01X_DIR; optional, skipped when unset
  RESULTS.md / RESULTS.json written ONLY by run.ts
```

`bench/attribution.ts` + `attribution.patch` stay (they measure v2 stages); `run.ts` of today is
deleted (its two-sided pokedex compare becomes the `brust-01x` app + probe set).

### 1.2 The three pages (every app must serve all three)

| probe | path | what it exercises | brust v2 behaviour | Next.js behaviour |
|---|---|---|---|---|
| S | `/types` | cacheable page: 18 type tiles, no per-request data | L1 HIT after first request (`cache: { ttl_seconds: 3600 }`) | static (prerendered at build) |
| D | `/dex?nocache=1` | dynamic SSR: loader reads `data.json`, renders 151 rows, one `TypeBadge` component per row | loader every request, `cache: { ttl_seconds: 60, bypass: 'query(nocache)' }` so `?nocache` bypasses L1, jobs from job cache | `export const dynamic = 'force-dynamic'`, server component maps rows |
| I | `/team?nocache=1` | page with ONE interactive island (`Counter`, `useReducer`), SSR + hydration script tags | react-tier child: `ssr` job + idle hydration | `'use client'` component inside a dynamic page |

Shared data: `_shared/data.json`. Shared markup contract: `_shared/pages.md`. Components are written
once per app (each framework has its own file conventions) but must produce the normalized HTML of §1.4.
`?nocache=1` is honoured by brust only; other apps ignore the query (they never cache).

### 1.3 Fairness rules (enforced by `lib/guard.ts` and the runner, not by prose)

- Same host, same session; the runner refuses when 1-min load average > cores (as today).
- Every app in production mode: brust `brust build && brust start` on Bun canary with a RELEASE
  addon (`BRUST_RELEASE_ADDON=1` declaration kept); Bun.serve on the same Bun; Next.js
  `next build` then `node .next/standalone/server.js` on Node ≥ 22 (never `next dev`, never Bun —
  Node is its canonical runtime); 0.1.x on its own release addon.
- Workers: brust `--workers = cores`; Next.js single Node process by default (its production
  default) with an optional `NEXT_CLUSTER=n` row that runs `n` instances behind a port-sharing
  proxy is NOT in scope — report Next.js as shipped. State this in README.
- **Equal CPU budget for the ceiling (amendment 2026-10-10, Mellow's challenge d89baa2f):** bun-serve runs
  N = brust workers processes on one port (`Bun.serve({ reusePort: true })`). The runner verifies the
  kernel actually balances: each bun-serve process serves `GET /_count`; after warm-up every process must
  have ≥ 5% of requests, otherwise the run prints `bun-serve: 1-proc (reusePort did not balance)` and the
  ceiling line is labelled `1-proc`. The RESULTS header prints the process budget per app.
- `oha -c 120 -z 10s --no-tui --output-format json`, identity encoding is the bar; gzip a second
  column. 1 s settle + discarded 3 s warm-up per (app, probe). Server restarted per (app, probe).
- App order and probe order are shuffled per run (seeded; seed printed in RESULTS).
- Parity check (§1.4) runs before any load and aborts the run on mismatch.

### 1.4 Parity check

For each (app, probe): fetch once, strip `<script>`/`<link>`/`<style>` elements, framework
ALL attributes and HTML comments (framework wrappers differ by design), collapse whitespace, then compare
the text content and the element-tag sequence of `<main>` across apps (amended 2026-10-10 at planning: attribute-level
parity is not a goal; tags + text are). Mismatch = the run aborts with a
diff. This is what makes "same page" a checked claim instead of a sentence.

### 1.5 Report

`RESULTS.md` = header (date, host, cores, Bun/Node/Next/brust versions, seed, load at start) + one
table per probe (rows = apps; rps, p50, p95, p99, errors, identity and gzip) + a verdict block
computed from the numbers:

```
bar F68  : v2 vs 0.1.x  D +x.x%  I +y.y%   → MET / NOT MET
sanity   : v2 vs next   S ×a  D ×b  I ×c   → MET / NOT MET (≥ 2×)
ceiling  : v2 / bun-serve[N-proc]  D p%  I q%   (target D ≥ 80%, equal process budget)
```

No hand-written prose in the generated file. `bench/README.md` carries the method text.

### 1.6 Tests (CI, cheap)

`bun check -p bench`, `bun build --no-bundle bench/run.ts`, and a unit test for `lib/parity.ts`
normalization and `lib/report.ts` verdict math on fixture JSON. The bench itself is manual.

## 2. Request-path levers (all land, in this order)

Each lane: output byte-identical (pokedex snapshot tests + bench parity), all gates green, bench
probe D and I before/after + `attribution.ts` stage diff in the task note, `RESULTS.md` regenerated.

| id | lever | files | expected (from attribution 2026-10-10) |
|---|---|---|---|
| P0 | `mimalloc` as the addon's global allocator (`#[global_allocator]` in `crates/brust-napi`) | brust-napi/src/lib.rs, Cargo.toml | allocator share of RENDER_CHAIN drops; measure first so later deltas are clean |
| P5 | bridge/response allocations: no `kind_str().to_string()` per call, no `tokio::spawn` per call (await the tsfn future inline), no `HeaderMap` clone in `page_response`, single re-index of job results | brust-napi/src/dispatch.rs:91, brust-server/src/dispatch.rs:198, pipeline.rs:446-466, :588-611 | CW_DISPATCH/BRIDGE toward the tsfn floor |
| P1 | worker: `TextEncoder.encodeInto` straight into the SAB slot (one copy, not two); loaders merge into one object without re-spreading per level; `jobs_request` stops deep-cloning `inputs` per miss | packages/brust/src/worker.ts:62-76, :156, pipeline.rs:1288-1302 | CW_JS_STRINGIFY + SAB_WRITE down |
| P2 | parse loader/jobs responses straight into a render `Value` (a serde `Deserialize` impl for minijinja `Value`, skipping `serde_json::Value` + `value_of` over the whole ctx) | brust-server/src/dispatch.rs:219, pipeline.rs:628, brust-jinja/src/lib.rs:17 | −(11–14 µs parse + ctx→Value) per request |
| P3 | string-keyed map object (`Object` impl keyed by `Arc<str>`) instead of `BTreeMap<Value,Value>`; overlays as views (no per-component map clone); render chain writes into ONE `String`/`BytesMut` through `inject_assets` (no intermediate String per template) | brust-jinja, brust-server/src/render.rs:100-133, pipeline.rs:633-648 | render −5–11% + fewer allocs per level |
| P4 | sharded read front over L1 (same as job cache); build the request envelope (headers/cookies/query) lazily — only after `l1_decision` says MISS | brust-server/src/cache/l1.rs:241, routing/routes.rs:239,300-346, pipeline.rs:275-296 | L1 get 2.7 µs → ~150 ns under contention; HIT path = match + get |
| P6 | single round trip per request (§3) | protocol.rs, pipeline.rs, worker.ts, native.ts, brust-napi | −45–50 µs on D/I; `bun_calls` 2 → 1 |
| P8 | **payload** (F70, F71; amendment 2026-10-10 from Mellow's m3b review): static child instances emitted as plain HTML; list-host `x-props` projected to the read set or omitted when nothing on the client consumes it. Bench D is 144 KB vs 22 KB for the same markup — on D this outweighs every server-side lever. Runs in parallel with the server lanes (compiler/manifest boundary). | crates/brust-compiler/src/lower/template.rs:598,988,1180, lower/mod.rs:134, packages/brust/src/build/manifest.ts:263 | D bytes/resp → within 10% of 0.1.x; rps on D scales with bytes |
| P7 | tail, chosen from the post-P6 attribution: `simd-json` for the SAB parse, body as `Bytes` without copy, accept/keep-alive tuning — planned when P6's numbers exist | named in the m3p-e plan once P6 numbers exist | — |

Already landed in m2p (do not redo): cached rendered body on L1 HIT, lazy gzip, gzip level 1 ≥ 16 KiB,
`_props` as a view, byte-scan `e` filter, one-pass `json_attr`, plan templates at boot, sharded job-cache
read front, tokio threads = cores.

## 3. P6 — one round trip (amends S6 and S7)

**Why two calls today.** Job keys depend on loader output (props per row), so Rust waits for call #1,
computes keys (`plan_key`, pipeline.rs:1139), looks up the job cache, and sends call #2 for misses.

**Design.**
1. One `WorkerFn` call per page. The request envelope = today's `LoaderRequest` + `plan`: the route's
   component ids, prop maps, literals and plan-template ids (all known at boot; sent by id, not by value,
   after the first call — the worker caches the plan by route id).
2. The worker runs the loaders, then computes every job key itself: canonical JSON of
   (component id, inputs, literals) hashed — ONE implementation, in TS. Rust stops computing keys and
   stores them as opaque strings (`plan_key` is deleted, its tests move to the worker).
3. The worker calls `native.jobLookup(keys: string[]): Uint8Array` — a new napi export, callable from
   the worker isolate (the addon is already loaded there for `registerWorker`). It reads the SAME moka
   job cache and returns a hit bitmask. Sync, no tsfn, no JSON round trip.
4. The worker runs only the misses and writes one response: `{ ctx, jobs: [{ key, id, k, tags, output }],
   hits: [key] }`. Rust reads hit values from its cache, inserts the fresh ones (with their tags so
   `cacheInvalidate` by tag/path keeps working), merges, renders — unchanged from here on.
5. `bun_calls` on D/I becomes 1; an L1 HIT is still 0.

**Spec amendments to write before the lane starts** (lead): S6 "job key: produced by the worker, opaque
to Rust"; S7 "request flow: one worker call carrying loader + plan; `jobLookup` export"; §7 the
`bun_calls` field meaning. Done as amendment blocks like M2's, committed to v2 (docs rule).

**Amendment (2026-10-10, lead, from the m3p-d plan evidence):** the design above is superseded by
"planned loader call" (Variant R): keys stay in Rust (`inputs::job_key`, blake3), the worker calls a sync
`planJobs(slot, len)` that plans and pins hits on the worker thread, runs only the misses, and answers in
the same call; a declined/ignored offer falls back to two calls. Reasons: no lookup→read gap (hits are
pinned), one key implementation (Bun has no blake3; a 64-bit hash would allow cache poisoning), no extra
JS CPU on worker threads, routes without a loader stay at 0 calls. Evidence E1 also showed D and I are
ALREADY one call in steady state (their jobs hit), so P6 is measured on attribution probe `M`
(`/team?nocache=1&start=<random>`, every job misses) and must be neutral on D/I. Kept because real pages
with per-request job inputs miss on every request ("ขอดีที่สุด"); it counts as ~0 on D/I for the §5
stop rule. Server-spec blocks: `docs/design/2026-10-09-m2-server-design.md` S1/S6/S7/§7 amendments.

**Risks.** Key format change (no persisted cache, so no migration); concurrent `jobLookup` from worker
threads while tokio inserts (moka is concurrent; a stress test with 8 workers × 1000 pages proves it);
key parity (single implementation, plus a pinned fixture of 20 keys committed and asserted).

## 4. Lanes

| wave | slug | content | impl | tier / review |
|---|---|---|---|---|
| 1 | `m3b-bench-suite` | §1 whole | knock2 | standard / complex (Mellow) |
| 1 | `m3p-a-alloc-bridge` | P0 + P5 | Tiësto | routine / standard (Afrojack) |
| 2 | `m3p-b-value-path` | P1 + P2 + P3 | Dew | complex / complex (Mellow) |
| 3 | `m3p-c-l1-shard` | P4 | knock2 | standard / standard (Afrojack) |
| 3 | `m3p-d-single-roundtrip` | P6 (after the lead's S6/S7 amendment) | Dew | complex / complex (Mellow) |
| 2 | `m3p-f-payload` | P8 (F70 + F71), parallel with `m3p-b` (disjoint boundary) | knock2 | standard / complex (Mellow) |
| 4 | `m3p-e-tail` | P7, planned from attribution after P6 | by result | by result |

Wave 1 runs in parallel (disjoint files). Perf lanes after that are serial (pipeline.rs / render.rs /
worker.ts are shared). `m3p-a` measures with today's pokedex bench while `m3b` is in flight; from
wave 2 every lane uses the new suite. Coordinator Aitthi dispatches from each plan's table; Illenium
runs gates; the lead merges and reruns the bench on this host before `task state merged`.

## 5. Stop rule and acceptance

- Stop when the attribution tree shows ≥ 90% of per-request time in inherent stages (the loader's
  JS handler, `renderToString` of the island, HTTP I/O), or when two consecutive levers each yield
  < 2% on D and I. Record the final tree in `bench/RESULTS.md`'s companion `bench/ATTRIBUTION.md`.
- Acceptance of the milestone: §0 bar lines computed MET in `RESULTS.md`; every lane's before/after
  numbers in its task notes; F68 closed in the ledger with the final numbers.

## 6. Decisions recorded here

- Bench app = small shared 3-page app written per framework (option A), not a Next.js port of the pokedex.
- Next.js = latest at planning time, 16.4.0 (React 19, App Router, standalone output), run on Node 22.
- Bar = F68 minimum + 2× Next.js sanity + Bun.serve ceiling with D ≥ 80% target; all levers land
  regardless of the minimum bar ("ขอดีที่สุด").
- P6 is unconditional and last among the planned levers; key computation moves to the worker.
- Rejected: port pokedex to Next.js (days of work, bench coupled to an example); run Next.js on Bun
  (fairness disputes); bench in CI (noise).

## 7. Integration branch (human decision 2026-10-10)

"สร้าง branch ใหม่ ทำกันในนั้นไม่ต้อง PR ได้ code ที่ดีที่สุด ค่อยเปิด PR เข้า v2": all M3-P lanes
branch from and merge into `m3p` (worktree `~/code/brust-m3p`), merged by the lead after gates +
review, with NO per-lane PR. CI does not run on `m3p` pushes (ci.yml is PR-only); the gate runner's
local run is the gate, and the lead may trigger `workflow_dispatch` on `m3p` at wave boundaries.
When §5 acceptance is MET, ONE PR `m3p → v2` carries the whole result. Docs on `m3p` are committed
directly, as on v2.
