# beta1-bench-flake: make bench/lib startApp's exit-before-ready path deterministic (F91)

**RULED by lead Detoro 2026-10-12 (plan written by the lead). Routine lane; fixes the flaky `bench/lib/app.test.ts:32` found by the F89 gates (ruling 7422ba3f).**

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: beta1 · lane: beta1-bench-flake · tier: routine · review: standard

**Goal.** `bun test bench/lib/app.test.ts` passes 20× in a row; `startApp` reports `exited (<code>) before ready` with the child's log whenever the child exits before printing the ready line, regardless of how fast it exits; the timeout path is unchanged for a child that never prints the line. Ledger row F91 added and closed in the same lane.

## Boundary
`bench/lib/app.ts`, `bench/lib/app.test.ts`, `docs/plans/m1a-followups.md` (row F91 only).

## Tasks
1. `conclave lane start 838f12fb-70c1-41b7-acf2-d4065cf6bb64 beta1-bench-flake`; `bun install --frozen-lockfile`; reproduce: `for i in $(seq 20); do bun test bench/lib/app.test.ts -t "exits before ready" 2>&1 | grep -E "fail" ; done` and record how often it fails.
2. Read `startApp` in `bench/lib/app.ts`: find where the stdout reader, the `exited` promise and the readiness wait are wired. The race: the child can exit (and its stdout can close) before the readiness loop observes the exit, or the exit code is read before `proc.exited` resolves. Fix by creating the `exited` promise and the log collector BEFORE the first await, and racing `[readyLine, exited, timeout]` in one `Promise.race` whose exit branch formats `exited (<code>) before ready\n<log>`; the timeout branch keeps `not ready after <ms> ms … no listening line`.
3. Test first: make the existing test fail deterministically by using a child that exits immediately (`bun -e 'process.exit(3)'` with no output) in a NEW test, then fix; keep the original test (with "boom") too. 20× green loop.
4. Ledger row F91 (text in the dispatch tell) appended after F90 and closed (`DONE 2026-10-12 — watchers attached before the wait; Promise.race of ready/exit/timeout; `). `bun run m2-exit` exit 0.
5. READY note with the 20× result; `bun test bench/lib` and `cd bench && bun run typecheck` green.

## Acceptance (Afrojack)
20× loop green; a child exiting with no output yields the `exited (3) before ready` message; timeout test unchanged; no sleeps added; boundary respected.

## Gates (lead)
bench lib tests + typecheck, m2-exit.
