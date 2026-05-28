# 2026-05-28 — `/` SSR p99 regression (54k → 16k RPS, 1.23 ms → 17.85 ms p99)

## Summary

`bun run bench` on 2026-05-28 showed brust's `/` SSR row had dropped from 54,828 RPS / p99 1.23 ms (2026-05-24 baseline) to 16,301 RPS / p99 17.85 ms. Two independent causes, found and fixed in one session: (a) the demo component grew (Tailwind v4 + `Layout` wrapper) — the Bun.serve baseline using the same component dropped proportionally (40k → 17.7k), proving the work itself got more expensive; (b) the runtime's default worker formula `floor(os.availableParallelism() * 1.8)` (= 18 on a 10-core M1 Pro) oversubscribed perf cores under heavier per-render work and amplified p99 ~6× under load. Fix: drop the multiplier in `runtime/config.ts:22` to `os.availableParallelism()` and stop hardcoding `BRUST_WORKERS=18` in `scripts/benchmark.ts`. Validation: `/` p99 17.85 ms → 2.42 ms, RPS 16,301 → 23,062. No JIRA — solo-dev repo, this file is the record.

## Symptom

`bench/RESULTS.md` at HEAD `8d340d9`:

| Path | Method | RPS | p50 | p99 |
|---|---|---:|---:|---:|
| `/ping` | GET | 127,113 | 0.13 ms | 0.22 ms |
| `/` | GET | **16,301** | 0.58 ms | **17.85 ms** |
| `/_brust/action/createNote` | POST | 121,013 | 0.14 ms | 0.23 ms |
| `/` (Bun.serve baseline, same component) | GET | 17,713 | 6.77 ms | 7.53 ms |

vs the 2026-05-24 baseline (`715a1e9`):

| Path | RPS | p99 |
|---|---:|---:|
| `/` | 54,828 | 1.23 ms |
| `/` (Bun.serve baseline) | 40,232 | 3.64 ms |

p99 jumped 14× on brust `/`; RPS dropped to within 9% of the Bun.serve baseline (previously brust held a ~37% lead on `/`). `/ping` and POST went *up* over the same window, so the regression was scoped to the React render path on `/`.

## Root cause

Two independent causes compounded.

### Cause A — demo component growth (shared across both servers)

Between `715a1e9` (2026-05-24 bench) and HEAD, `example/hello-world/` migrated to Tailwind v4 and gained a `components/Layout.tsx` wrapper (`d5c0c8e feat(example): migrate hello-world to Tailwind v4` + the `Layout` commits). The original `HelloWorld.tsx` was ~18 lines; the new tree wraps each page in a `<Layout>` that renders a header with 4 nav links, a styled `<main>`, and a footer — all with Tailwind utility classes that expand into long `className=` strings during `renderToString`.

`example/bun-serve-baseline/index.ts` imports `HelloWorld` from `example/hello-world/pages/HelloWorld` and calls `renderToString` directly. It uses **zero brust runtime code**. Its `/` row dropped 40,232 → 17,713 (2.27×) — a regression in a server that doesn't share any brust code with the affected path is mechanically caused by the shared input, which is the component.

Single-connection (`oha -c 1 -z 5s`) measurement confirmed: brust `/` p50 = 148 µs, Bun.serve `/` p50 = 78 µs. Both servers are doing roughly 2× the per-request CPU work the old component required (extrapolating from the May-24 bench ratios). The render cost itself grew.

### Cause B — `defaultWorkers()` oversubscription on CPU-bound renders

`runtime/config.ts:22` (pre-fix):

```ts
const defaultWorkers = (): number => Math.floor(os.availableParallelism() * 1.8)
```

On M1 Pro (10 cores: 8P + 2E), this yields **18** workers. The `* 1.8` multiplier was tuned (see the pre-fix architecture.md "Why floor(availableParallelism * 1.8)?" section) for renders where workers spent ~45% of wall time in V8 GC / IPC / thread-park — i.e. mostly waiting. Oversubscribing kept CPU saturated through those pauses.

Once per-render work grew to ~150 µs of synchronous React (Cause A), the workers became CPU-bound rather than I/O-bound. 18 workers on 8 perf cores started competing for the same cores, causing preemption mid-render. Each preemption pushed a request's tail latency from ~0.6 ms (one render slot worth of wait) to many ms (multiple preempted renders queued ahead).

Empirically confirmed at `oha -c 120 -z 10s`, all else equal:

| `BRUST_WORKERS` | RPS | p50 | p99 |
|---:|---:|---:|---:|
| 18 (old default) | 16,301 | 580 µs | **17.85 ms** |
| 10 (= cores) | 14,466 | 519 µs | **4.76 ms** |
| 8 (= perf cores) | 15,534 | 412 µs | **3.05 ms** |

RPS varies <12% across the three values. p99 collapses by 4–6×. The over-subscription only hurts the tail because mean throughput is bounded by the React render itself, not the worker count.

## Why it produced the symptom

The symptom was a single number on the bench table: `/` RPS dropped from 54k to 16k. Decomposed:

- Component growth (Cause A) doubled per-request work. By itself: 54k → ~27k RPS. p50 ~280 µs → ~600 µs.
- Oversubscription (Cause B) was latent under the old lighter component (renders finished before scheduler thrash mattered), and turned acute when each render now occupied a CPU for ~150 µs. p99 then amplified 14× while RPS dropped further.

`/ping` was unaffected because it's a pure-Rust path in `src/server.rs` that returns `pong\n` before any worker dispatch. POST through `/_brust/action/createNote` went *up* over the same window because the atomic-claim refactor (`bc729d7`) doubled worker-pool dispatch throughput — a win large enough to mask any latent oversubscription effect on the POST path's much shorter per-request CPU footprint.

## Fix

Two changes in one commit-set (uncommitted at draft time):

- **`runtime/config.ts:22`** — `Math.floor(os.availableParallelism() * 1.8)` → `os.availableParallelism()`. Also updates the surrounding JSDoc, the `loadConfig` doc-comment, and adds a comment explaining the trade-off (CPU-bound vs I/O-bound renders) and pointing to `BRUST_WORKERS` / `workers.count` for users who need to override.
- **`scripts/benchmark.ts:61`** — removes the hardcoded `BRUST_WORKERS: '18'` override from the brust scenario, with a comment pointing to this post-mortem. The bench now uses the runtime default — what users actually experience.

`architecture.md` updates: pre-fix "Why floor(availableParallelism * 1.8)?" section rewritten as "Why `availableParallelism()`?"; performance table refreshed with the post-fix numbers; slot-size note updated (10 workers × 256 KB = 2.5 MB). `README.md` regression note replaced — the old text blamed CSS-link / dev-client injection, which is wrong (see "How it was found").

The fix addresses the root cause rather than working around it: changing the default worker count changes what every brust user experiences, not just the bench. The handoff's earlier guess (per-request CSS injection cost) would have been a symptom-side optimization that did not touch either real cause.

## How it was found

Reproducer: `bun run bench` at HEAD `8d340d9` reproduces the regression deterministically. Two reruns within ±10% RPS variance.

Trace cascade (debug-mantra step 2):

1. Read `runtime/render/stream.ts`, `runtime/render/inject-css-link.ts`, `runtime/render/inject-dev-client.ts` — confirmed the handoff's suspect path. Found `injectCssLink` does one O(N) `findHeadCloseTag` scan + one `Uint8Array.set` copy; `injectDevClient` short-circuits when `snippet === null`.
2. Confirmed `configureDevClientSnippet` is only called when `dev=true` (`runtime/index.ts:239,455`). The bench scenario does not set `BRUST_DEV`, so `getDevClientSnippet()` returns `null` and `injectDevClient` is a no-op. **Handoff hypothesis falsified for one of the two named injection paths.**
3. Diffed `715a1e9..HEAD` for `example/hello-world/`, `runtime/render/`, `runtime/css.ts`, `runtime/dev/` — found `d5c0c8e feat(example): migrate hello-world to Tailwind v4` and the `Layout.tsx` commits. Read `pages/HelloWorld.tsx` and `components/Layout.tsx` — confirmed the demo component had grown substantially (Layout wraps every page with a header/nav/footer + heavy Tailwind classes).
4. Read `example/bun-serve-baseline/index.ts` — confirmed it imports the *same* `HelloWorld` from `example/hello-world/pages/HelloWorld`. The bun-serve baseline's lockstep drop (40k → 17.7k) becomes a clean discriminator: a server using zero brust runtime code cannot regress because of a brust runtime change.

Discriminating experiments:

- **`oha -c 1 -z 5s` against both servers.** Brust `/` p50 = 148 µs, Bun.serve `/` p50 = 78 µs, tight tails on both (p99/p50 = 2× on brust). Eliminated GC pause / per-request allocation tail variance as a primary cause — at c=1 brust has no tail problem.
- **`oha -c 120 -z 10s` with `BRUST_WORKERS=8`.** p99 17.85 ms → 3.05 ms; RPS unchanged. Confirmed Cause B.
- **`oha -c 120 -z 10s` with `BRUST_WORKERS=10`.** p99 4.76 ms — between 8 and 18 as expected. Provides the data point for choosing `availableParallelism()` (= 10) as the new portable default.

Hypotheses tried and rejected:

| Hypothesis | Why rejected |
|---|---|
| Per-request CSS-link injection cost (handoff) | One O(N) scan + one alloc; ~30µs total. Doesn't explain 14× p99 jump. |
| Per-request dev-client injection cost (handoff) | `snippet === null` in bench → early-return no-op. Path is dead code in prod. |
| Atomic-claim refactor regression | POST through the same dispatch path *doubled* (61k → 121k) over the same window. |
| GC / allocation tail variance | At `oha -c 1`, brust p99/p50 = 2× (no tail). Tail amplification is concurrency-only. |
| `getCssHrefs()` defensive `.slice()` per request | Real cost, but ~10–20 µs/req — too small to be the primary cause. (Tracked as optional follow-up.) |

The single experiment that nailed Cause B: dropping `BRUST_WORKERS` from 18 to 8 cut p99 by 6× without moving RPS. That asymmetry — tail collapsed, throughput unchanged — is the signature of scheduler oversubscription rather than per-request work cost.

## Why it slipped through

Two gaps compounded.

1. **`scripts/benchmark.ts:61` hardcoded `BRUST_WORKERS=18`.** That value was the runtime default on the dev hardware at the time of the original tuning. As long as the bench used the value the runtime would have produced anyway, the bench was an honest reflection of user experience. Once a user happened to have a 4-core or 16-core machine, the bench number and the user's experience diverged silently — but the dev hardware never tripped that asymmetry. When the per-render work grew and made oversubscription painful, the bench script's hardcoded value was redundant (it equaled the default) but masked the fact that *the default itself was the problem*. Removing the override would have made the new bench number reflect the actual user experience earlier.
2. **No CI signal on `/` p99.** `bun run bench` is invoked manually. Nothing in CI fails on a p99 regression. The two-day drift from 1.23 ms → 17.85 ms only surfaced because the bench was rerun manually after the atomic-claim ship.

Neither is a review miss — the Tailwind / Layout migration was a deliberate scope change to the demo; the `* 1.8` multiplier was a defensible tuning at the time it was written. The gap is in the validation harness, not in the changes themselves.

## Validation

- `bun test runtime/` — 188 pass / 0 fail (unchanged before and after).
- `bun run bench` rerun twice with the new defaults:

  | Path | RPS (pre-fix HEAD) | RPS (post-fix) | p99 (pre-fix) | p99 (post-fix) |
  |---|---:|---:|---:|---:|
  | `/ping` | 127,113 | 104,953 | 0.22 ms | 0.15 ms |
  | `/` | 16,301 | **23,062** | 17.85 ms | **2.42 ms** |
  | POST `/_brust/action/createNote` | 121,013 | 110,372 | 0.23 ms | 0.16 ms |
  | `/` (Bun.serve baseline, control) | 17,713 | 17,705 | 7.53 ms | 7.51 ms |

  `/` p99 fix landed: 17.85 → 2.42 ms (7.4× tighter). RPS recovered 16k → 23k. The Bun.serve baseline control is unchanged across the fix, confirming the brust delta is the brust change, not host-load drift.

  `/ping` and POST dropped 10–17% on RPS. Trade-off: fewer workers means less pool parallelism for the napi/SAB envelope path. Both are still well above the May-24 baseline (`/ping` 116k → 105k = −9%; POST 61k → 110k = still +80%, the atomic-claim win is intact). The choice trades single-digit-percent throughput on the bounded-CPU paths for a 7× p99 win on the React render path, which is the visible user-perceived latency.

- Coverage: M1 Pro / 10 cores / darwin-arm64 only. Not retested on Linux, x86_64, or other core counts. The fix is conservative (drops a multiplier, doesn't add complexity) and matches the `1 worker per CPU` convention shared by Node, Bun, and most worker pools, so cross-platform regression risk is low — but call this out as a coverage gap.

## Action items

- **Add `runtime/config.test.ts`** asserting `defaultWorkers()` matches `os.availableParallelism()` and that env override / TOML override still win. Currently no test file covers the loader. (Tracked: this session's TODO; not a separate ticket.)
- **CI bench gate.** Add a CI step that runs `bun run bench` on a fixed-spec runner and fails on `/` p99 > a guard threshold (e.g., 5 ms). The 2-day drift between the May-24 baseline and the May-28 rerun would not have happened with this gate. (Tracked: handoff line item — to be added to next-session list.)
- **Audit other "tuning" constants in `runtime/`.** The `* 1.8` multiplier was a single-context tuning that aged out; `SAB_SIZE = 256 * 1024` and the bench `CONN = 120` default may have similar latent assumptions. (Tracked: opportunistic, not blocking.)
- **Optional micro-optimization** — drop the per-request `.slice()` defensive copies in `runtime/css.ts::getCssHrefs` / `getCssHrefsForRoute`. Worth ~10–20 µs/req. Out of scope for this post-mortem; ticket if needed when prioritizing perf work.

The handoff-listed "Workspace restructure (unblocks `brust new` e2e)" and "Rust pool clear (closes `brust dev` TS-reload)" remain as next-session pickups.
