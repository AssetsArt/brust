# beta1-research-f83-f84: F84 foreign-fd pump probe (GO/NO-GO) and F83 bridge/parse cost split in ATTRIBUTION

**RULED by lead Detoro 2026-10-12 (plan written by the lead; decisions final). Researcher lane (Guetta). Two deliverables, two tasks, ONE lane: F84 first (no bench, no host lock), then F83 (measure-only, under the bench host lock, AFTER `beta1-bench-elysia` has released it). Nothing in this lane changes server behaviour; probe code is throwaway and is NOT committed.**

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: beta1 · lane: beta1-research-f83-f84 · tier: standard · review: standard

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Ledger rows (docs/plans/m1a-followups.md:147-148):
- F83: "The 14.6 µs bridge cost (c=1) and the 81 µs loader-response parse are measured as single stages; their wake-vs-JSON and read-vs-parse shares are unknown, so the ceiling of any in-process bridge (research memo `docs/plans/2026-10-11-research-bun-inprocess-bridge-memo.md`) is an estimate. Measure-only lane under bench:host-lock: split both stages; record in ATTRIBUTION."
- F84: "The inverted-pump shape (§5.3 of the research memo) needs Bun's loop to watch a foreign kqueue/epoll fd; feasibility unknown. Half-day functional probe (no bench): adopt an fd via `net.Socket({fd})` / `Bun.connect({fd})` and prove a wake; report GO/NO-GO for the pump."

**Goal.** After this lane merges into `beta1`:
- Memo §5.3 carries a dated GO/NO-GO for the inverted pump with the evidence (what API adopted the fd, what woke, what did not), and §6.4's trigger table is updated.
- `bench/ATTRIBUTION.md` has two new sub-stages under its existing tree: the bridge stage split into `wake` (tsfn signal → JS callback entry) vs `envelope` (JSON encode in Rust + `JSON.parse` in the worker), and the loader-response stage split into `read` (SAB/bytes → string) vs `parse` (`JSON.parse` of the loader result). Numbers at c=1 and c=120, same method as the file's `## Method`.
- Ledger rows F83 and F84 are `DONE 2026-10-12 — …`.

## Decisions (lead rulings, final)

- **R1 Order and lock.** F84 does not measure anything; start it immediately. F83 measures: set the blackboard lock exactly as `bench/README.md` §"Host lock and ports" describes (`BENCH_LOCK_WS=838f12fb-70c1-41b7-acf2-d4065cf6bb64 BENCH_LOCK_ID='beta1-research-f83-f84 Guetta'`, or set `bench:host-lock` by hand for `bench/attribution.ts` if it does not use `lib/lock.ts` — read it). If the lock is held, wait; do not run heavy builds while someone else holds it.
- **R2 F84 is a probe, not a prototype.** Budget: half a day. The probe lives in the scratchpad or `/tmp`, never in the repo. Three experiments, each a tiny Bun script plus, where needed, a tiny Rust or C helper: (a) create a `kqueue` (macOS) fd in native code via `bun:ffi`, hand it to `new net.Socket({ fd })` / `Bun.connect({ fd })` — observe whether Bun's loop polls it and fires `readable`/`data` when the kqueue becomes readable; (b) same with a plain pipe fd and a `socketpair` fd (control: those SHOULD work — if they do not, the API is not an fd adopter and the conclusion is NO-GO for this route); (c) a `bun:ffi` `JSCallback` fired from a foreign thread — does it wake the loop without a pending timer? Record Bun version (`bun --version`) and the exact API calls. Verdict rule: GO only if (a) wakes on a kqueue/epoll fd with ≤ 1 ms latency and no busy loop; otherwise NO-GO with the reason. Linux is not available on this host — say so; a Linux epoll run is a follow-up row if (a) is GO on macOS.
- **R3 F83 method.** Extend `bench/attribution.ts` (read `bench/ATTRIBUTION.md` §Method first — it is the contract) with the two splits using the same stage-timing technique the file already uses (timestamps around each stage, sampled at c=120). Changes to `attribution.ts` must keep `git apply --check bench/attribution.patch` green (the patch is a gate — read what it patches; if your change moves its hunks, regenerate the patch with the method described at the top of `bench/attribution.patch`/`ATTRIBUTION.md` and say so). Report the split at c=1 and c=120 for probes D and I; append a dated section `### F83 split (2026-10-12)` to `ATTRIBUTION.md` and update the memo §6.1 inputs and §6.4 trigger table with the measured shares. If a share cannot be isolated without changing server code, say which and why — that is a finding, not a failure.
- **R4 No code paths change.** Any edit outside `bench/attribution.ts`, `bench/attribution.patch`, `bench/ATTRIBUTION.md`, the memo, and the ledger is a `task challenge`.

## Boundary

`bench/attribution.ts`, `bench/attribution.patch`, `bench/ATTRIBUTION.md`, `docs/plans/2026-10-11-research-bun-inprocess-bridge-memo.md`, `docs/plans/m1a-followups.md` (rows F83, F84 only). Probe code: scratchpad only.

## Tasks

### Task 1 — lane worktree, read the method

- [ ] `conclave lane start 838f12fb-70c1-41b7-acf2-d4065cf6bb64 beta1-research-f83-f84`; `bun install --frozen-lockfile`.
- [ ] Read memo §5.3, §6.1, §6.4; `bench/ATTRIBUTION.md` §Method and the D/I trees; `bench/attribution.ts` top comment; `bench/README.md` §Host lock; the F83/F84 rows.

### Task 2 — F84 probe (no lock)

- [ ] Experiments (a)(b)(c) per R2; keep a log `f84-log.md` in the scratchpad with each command and its observed output.
- [ ] Memo §5.3: append `**F84 probe (2026-10-12, Bun <version>, macOS <version>): GO | NO-GO.**` plus 5-15 lines: what was tried, what woke, latency observed, what this means for Shape C; §6.4: update the F84 row/trigger. Memo §0 verdict line stays NOT-YET unless (a) is GO AND the lead rules otherwise (file a challenge with the evidence; the verdict is the lead's).
- [ ] Ledger F84 → `DONE 2026-10-12 — GO|NO-GO: <one line>; `.
- [ ] Commit `research(f84): foreign-fd pump probe — <GO|NO-GO>` and `conclave task note … beta1-research-f83-f84 F84 DONE @<sha> <verdict one line>`.

### Task 3 — F83 split (under the lock)

- [ ] Release addon: `cd packages/brust && bun run build` (release; `BRUST_RELEASE_ADDON=1` is the declaration the harness wants).
- [ ] Take the lock (R1). Run the existing attribution once first to confirm the baseline reproduces within noise (compare to `ATTRIBUTION.md` "After P7" numbers; if > 15% off, stop and note the host state — load average, other processes — before continuing).
- [ ] Implement the two splits in `attribution.ts`; run at c=1 and c=120 for D and I; 3 repetitions, report the median.
- [ ] Release the lock. `git apply --check bench/attribution.patch` green (or regenerated + explained).
- [ ] `ATTRIBUTION.md`: new section `### F83 split (2026-10-12)` with a table `stage | sub-stage | c=1 µs | c=120 µs | share`; one paragraph on what it means for the in-process ceiling. Memo §6.1: replace the "estimate" wording with the measured shares; §6.4 row F83 → done.
- [ ] Ledger F83 → `DONE 2026-10-12 — bridge = wake <x> µs + envelope <y> µs; loader-response = read <a> µs + parse <b> µs (c=1); `.
- [ ] `bun test bench/lib` and `cd bench && bun run typecheck` green; `bun run m2-exit` exit 0.
- [ ] Commit `research(f83): split bridge and loader-response stages in ATTRIBUTION` and `conclave task note … beta1-research-f83-f84 READY @<sha> — F84 <verdict>; F83 <four numbers>; lock held <from>-<to>`.

## Acceptance (Afrojack, standard)

1. Memo §5.3 has the dated verdict with evidence a reader can reproduce (API names, Bun version, observed behaviour); §6.4 updated; §0 verdict unchanged unless the lead ruled.
2. `ATTRIBUTION.md` new section present; the four sub-stage numbers sum to within 10% of the parent stage numbers measured in the same session (state the parent numbers in the section).
3. `git apply --check bench/attribution.patch` green; `bun test bench/lib` green; no file outside the Boundary changed; no probe code committed.
4. Lock discipline visible in the READY note (held/released times) and `conclave bb get … bench:host-lock` is empty afterwards.

## Gates (lead, at merge)

JS/bench set only: bench lib tests + typecheck, `git apply --check bench/attribution.patch`, `bun run m2-exit` + diff.

## Risk ledger

- The attribution harness lied before (memory `brust-perf-bench-caveats`): verify fresh, report deltas against the same-session parent stage, not against the file's old numbers.
- Bun may accept `{fd}` and silently never poll it: the control experiment (b) tells you whether the API works at all.
- The host lock is cooperative; other lanes pause heavy builds while it is held — keep the hold under 20 min per run (the harness aborts itself at 20 min).

## Reporting

Two notes (F84 DONE, then READY) as above; challenges via `conclave task challenge 838f12fb-70c1-41b7-acf2-d4065cf6bb64 beta1-research-f83-f84 --claim <text>`.
