# 2026-05-28 — writev zero-copy response: experiment didn't pay (8% p99 regression on macOS)

## Summary

Tried to apply [nylon-ring](https://github.com/AssetsArt/nylon-ring)'s `NrVec<u8>` zero-copy "ownership transfer instead of memcpy" philosophy to brust's buffering response path. Plan: replace `build_single_response_bytes` (which concats `[head, body]` into one Vec) with `write_all_vectored([&head, body_slice])` so the kernel does scatter-gather. N=5 medians (M1 Pro, oha c=120 / 10s) showed `/` RPS −2.2% / p99 **+7.8%** vs pre-impl baseline — a real regression on the hot path. Reverted the writev path per the plan's pre-written T7 BLOCKED #2 mitigation; kept the `cache_wanted: bool` plumbing in `dispatch_to_worker_and_stream_chunks` because that path's `response_bytes_for_cache.clone()` was unconditional in pre-M code and obviously wasteful for uncached routes (which is every route in the bench). Net landed change is bench-neutral but architecturally cleaner. No JIRA — solo-dev repo, this file is the record.

## Symptom

`bench/RESULTS.json` N=5 medians at three points on the same hardware (M1 Pro, Bun 1.4.0-canary.1, release build via `napi build --release`, `oha -c 120 -z 10s`):

| Metric | PRE (`a890cb1`) | POST writev (`418d763`) | MIT clone-skip only (`b02faa2`) |
|---|---:|---:|---:|
| `/` RPS  | 29,330 (range 28,947 – 29,436) | 28,690 (range 26,792 – 29,447) | 29,005 (range 28,866 – 29,355) |
| `/` p99  | 1.90 ms (range 1.67 – 2.16) | 2.04 ms (range 1.78 – 2.67) | 1.87 ms (range 1.70 – 2.13) |
| `/ping`  | 111,320 | 111,045 | (not re-measured) |
| action   | 111,206 | 112,170 | 110,310 |

POST writev range on `/`: 2,655 RPS span (~9.3%). PRE and MIT both fit in tight ~500 RPS spans (~1.7%). Writev introduced **variance**, not just slowdown — single-run min 26,792 sat below every PRE run.

## Root cause

The hypothesis was wrong for this workload.

**Hypothesis (pre-impl):** the buffering path does two body-sized memcpys per request — `build_single_response_bytes`'s `extend_from_slice(body)` and the unconditional `response_bytes_for_cache = resp.clone()`. Body is ~5 KB on `/`. At 10 GB/s memcpy bandwidth × 5 KB × 30k RPS = ~1.5% CPU savings per memcpy eliminated. Total expected: +2–3% RPS, −5–10% p99 from reduced allocator pressure.

**Reality on macOS:**

- The `response_bytes_for_cache.clone()` was indeed wasted work on uncached routes. Skipping it (mitigation) is bench-neutral — the savings are within N=5 noise (±1.5%).
- The `write_vectored` substitution measurably *slowed down* the hot path. The most plausible mechanism: tokio on macOS does report `is_write_vectored = true` and delegates to a real `writev(2)` syscall via mio, but the kernel still copies each `iovec` entry into the socket send buffer separately. Plus iovec-array iteration overhead. For two small slices, this costs more than one bigger memcpy + a `write(2)`. The kernel-side memory traffic is the same; only the syscall path changed, and it changed for the worse.

**Why the math was wrong:** the per-request budget (~33 µs at 30k RPS) is dominated by React render (~150 µs amortized across 10 workers = ~15 µs effective). Userspace memcpy of 5 KB is ~0.5 µs. The writev experiment optimized 1.5% of per-request CPU but added 1.5%+ overhead in syscall path. Net negative on macOS.

**Linux not measured.** The plan deferred Linux io_uring writev support as a separate sub-project. Whether `io_uring`'s `writev` SQE would have been faster than `write` on Linux remains untested. Possible but unverified.

## Why it produced the symptom

The fat lower tail (single-run min 26.8k RPS, well below all PRE/MIT runs) suggests *occasional* extra work happens on the writev path — possibly:

1. **Scheduler interaction** — `write_vectored` may yield to the scheduler differently than `write_all`, occasionally letting another task interpose.
2. **Cacheline split** — when head and body sit in separate cachelines (different alloc paths), the kernel-side copy may stall on memory.
3. **mio's vectored fallback** — even with `is_write_vectored = true`, mio may convert to `poll_write` on partial writes, doubling overhead under load.

None of these were proven. Profile-driven diagnosis was the plan's BLOCKED #2 next step, but the mitigation (revert + keep clone-skip) was lower-risk and the plan pre-authorized it.

## Fix

Per the plan's T7 BLOCKED #2 fallback ("revert T4's `cache_wanted=false` branch to call `s.write_all(build_single_response_bytes(...))` directly — that still saves Copy 3 even if writev doesn't help"). Reverted the writev arm in all three places (`BytesAndFinal` non-streaming, `Final` non-chunked, `RenderOutcome::Resolved` non-chunked) to the original `build + write_all` shape. Guarded the now-conditional `response_bytes_for_cache.clone()` with `if cache_wanted` so uncached routes skip the clone. Deleted the dead `write_all_vectored` infrastructure (both platforms) + the `build_single_response_head_only` helper that was only useful for the writev path.

**Net effective diff (HEAD vs PRE):**

```
 architecture.md           |   6 ++-
 bench/RESULTS.md          |  10 +-
 src/server.rs             |  36 +++++++--
 tests/integration.test.ts | 122 ++++++++++++++++++++++++++++
 plans/...                 | 848 +++++ (this work's plan + spec)
```

`src/server.rs` change: `dispatch_to_worker_and_stream_chunks` grew a `cache_wanted: bool` param between `label` and `on_success`; 4 call sites (action, mcp, navigation, render) pass an explicit value; 3 arms (BytesAndFinal non-streaming, Final non-chunked, Resolved non-chunked) guard the `response_bytes_for_cache.clone()` with `if cache_wanted`; end-of-fn `on_success` invocation guarded with `cache_wanted && !is_empty()`. No new dependencies, no new unsafe blocks, no new files.

## How it was found

The bench itself. The plan had pre-written N=5 acceptance criteria. T7 ran them faithfully:

- PRE (`a890cb1` pre-impl, code matches HEAD at session start `66f04d3` minus this session's doc-only spec changes) — collected as baseline
- POST (`418d763` post T1–T6, full writev path) — measured
- Compared medians, saw `/` p99 +7.8% — exceeded the spec's anti-regression band (>5%)
- Spec also flagged: "if any RPS goes down by more than 3% on N=5 medians, treat as regression" — RPS was −2.2%, within band, but distribution spread was concerning (fat lower tail).

Mitigation was applied without an advisor call because the plan had pre-authorized it for this exact scenario. Re-measured MIT N=5 — back to PRE-equivalent, p99 regression gone.

## Why it slipped through

The spec's "Known limitations S4" had already conceded the risk:

> Bench measurability is on the noise floor. Expected RPS gain (+1–3%) is comparable to N=5 median variance (±5%). If measurement is ambiguous, the architectural improvement (fewer body memcpys, clearer ownership) still holds; document as such.

The spec author (me, in Phase 2) considered the writev path "low risk because the architectural improvement is real even if bench can't see it." That was wrong in two ways:

1. **Bench could see it — in the wrong direction.** N=5 medians were tight enough to spot a +8% p99 regression. The "bench can't see it" framing assumed the optimization would at worst be neutral. A regression possibility was not explicitly modeled.
2. **"Architectural improvement" was less load-bearing than it sounds.** A vectored write of [head, body_slice] is arguably *more* elegant than concat + memcpy. But "elegant" doesn't outweigh "8% p99 regression on the bench platform." The right framing was "test on your bench platform before declaring victory."

The reviewer subagent caught three correctness issues in the spec (T7 unbuildable, `mut bufs` rebind, narrative-snippet drift) and approved-with-fixes. None of those reviewers had bench data, and the bench wasn't requested as part of spec review — it's a separate task at the END of the pipeline. By the time bench numbers were in, T1–T6 were already committed. Mitigation was clean because the plan had a fallback path; without the plan's BLOCKED #2, the response could have been "ship the regression and document" or "revert everything."

## Validation

After mitigation (`b02faa2`):

- `cargo test --lib` — 107 passed (back to PRE baseline; T1/T2's unit tests deleted with the infrastructure they tested)
- `cargo test --lib --release` — 107 passed
- `bun test runtime/` — 189 passed (no JS-side changes anywhere in Sub-project M)
- `bun test tests/integration.test.ts -t "buffering"` — T5 byte-shape smoke (uncached vs cached HTTP/1.1 wire form) passes in 1.5s
- Manual smoke: `bun run example/hello-world/index.ts` → `curl /` returns 200 + 2451 bytes of HTML; `curl /ping` returns 200 + 5 bytes; both `/` and `/ping` paths exercise the post-mitigation dispatch helper
- Bench (N=5 medians): `/` RPS 29,005 (1.1% noise below PRE), p99 1.87 ms (1.6% noise below PRE) — bench-neutral. Distribution spread (28,866 – 29,355) is essentially identical to PRE (28,947 – 29,436), confirming the variance fattening from the writev path is gone.

## Files / commits

- Spec: `docs/superpowers/specs/2026-05-28-writev-zero-copy-response-design.md` (kept — documents the experiment)
- Plan: `docs/superpowers/plans/2026-05-28-writev-zero-copy-response-plan.md` (kept — its T7 BLOCKED #2 was exactly the right mitigation)
- Commit trail:
  - `45f84de` T1: build_single_response_head_only + 3 unit tests
  - `0c0847e` T2: write_all_vectored macOS + 3 unit tests
  - `f465235` T3: write_all_vectored linux fallback
  - `289f7b7` T4: dispatch_to_worker_and_stream_chunks cache_wanted refactor + writev arms
  - `a5337ae` T5: bun integration test
  - `418d763` T6: architecture.md update (later un-updated by mitigation)
  - `b02faa2` T7 mitigation: revert writev path, keep cache_wanted, delete dead code
- Net effective change: the cache_wanted plumbing in `src/server.rs` only.

## Lessons

1. **Profile before assuming, even on "obvious" memcpy wins.** "Less memcpy = faster" is a heuristic, not a theorem. On Apple Silicon, memcpy is so cheap (10+ GB/s) that small syscall-path differences can dominate. The plan should have included an `Instruments` profiling step BEFORE T7 instead of betting on the bench alone.
2. **Apply nylon-ring's lessons at the right scale.** nylon-ring's NrVec gains matter at sub-µs per call. Brust's per-request budget is dominated by React render at ~15 µs/req (amortized). Optimizations at sub-µs scale are below noise on this workload. Match optimization scale to workload scale.
3. **The plan's pre-written mitigation saved the session.** Without T7 BLOCKED #2's exact "revert writev arm, keep clone-skip" instruction, the orchestrator would have either shipped the regression or panicked and reverted everything. Pre-authoring mitigations in the plan is a load-bearing discipline for autonomous runs.
4. **`response_bytes_for_cache.clone()` was a real waste — but the savings are sub-noise.** Skipping it (the kept change) is the right thing to do for code hygiene even though the bench can't measure the win. Net architectural improvement holds; the perf claim doesn't.
