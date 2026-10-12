# beta1-bench-again: re-measure the full bench on v2 after beta1 (alpha.2) AND M4-CF (#145) merged

**RULED by lead Detoro 2026-10-12 (plan written by the lead). Run-and-report lane for the Runner; no code changes except the committed bench results. Dispatch only when the lead says GO with the sha.**

**AMENDED by lead Detoro 2026-10-12 ~12:50Z: the HUMAN lifted the bench hold on the main Mac (bb rule:bench-hold LIFTED); the remote host stays revoked. Base moves from beta1 to v2 @629b6d5 (beta1 shipped as 2.0.0-alpha.2 via #143/#144; M4-CF via #145 adds the brust-core split and the cache adapter layer with NO adapter configured by default). The result header carries model · chip · RAM · cores · platform/arch only, never a hostname.**

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: v2 @629b6d5 · lane: beta1-bench-again · tier: routine · review: lead

**Goal.** `bench/RESULTS.json` + `bench/RESULTS.md` on v2 reflect the merged tree (beta1: F86, F87, F89, F82, bench-elysia harness; M4-CF: brust-core split, cache adapter layer with no adapter configured) measured under the host lock with a release addon; the READY note states the deltas vs the previously committed rows.

## Boundary
`bench/RESULTS.json`, `bench/RESULTS.md`.

## Tasks
1. `conclave lane start 838f12fb-70c1-41b7-acf2-d4065cf6bb64 beta1-bench-again` FROM /Users/detoro/code/brust (worktree lands under .claude/worktrees/); reset the lane to v2 at the sha in the GO message if it branched from main; `bun install --frozen-lockfile`.
2. Record the pre-run rows: `git show HEAD:bench/RESULTS.md | grep -E "^\| (brust|elysia-brust|elysia-bun|bun-serve|next) \|" > /tmp/bench-before.txt`.
3. Release addon: `cd packages/brust && bun run build` (exit 0).
4. Confirm `conclave bb get 838f12fb-70c1-41b7-acf2-d4065cf6bb64 bench:host-lock` is empty and `uptime` 1-min load < 10 (the harness guards this too; if busy, wait, do not force).
5. Measure: `BRUST_RELEASE_ADDON=1 BENCH_LOCK_WS=838f12fb-70c1-41b7-acf2-d4065cf6bb64 BENCH_LOCK_ID='beta1-bench-again Illenium' bun run bench` from the repo root (all probes incl. A1/A2; the harness takes and releases the lock). Exit must be 0 (exit 2 = busy host → wait and retry once; exit 1 = a failed row → task challenge with the log, no re-run).
6. Deltas: for each (app, probe, conn) row compare rps before/after; list every row with |delta| > 5%. S/D/I brust rows must be within noise (±5%); the A rows are the new baseline. A regression > 5% on S/D/I is a `task challenge` naming the suspected lane (F86/F89 touch the MISS path and job inserts; F87 the actions prefix; F82 the fetch framing; M4-CF core split = crates/brust-core pipeline move, cache-adapter-core = CallKind::Cache read-through on L1 MISS) — do not re-run to make it go away. The remote A/Bs already bounded the two M4-CF lanes at ±2.06% and ±0.65%, so a larger S/D/I move points at the host, not the code: note the load and challenge anyway.
7. Commit `bench: v2 re-measure after beta1 + M4-CF (seed <n>)` with only the two files; `bun test bench/lib` green; `conclave task note … READY @<sha> — deltas: <row: before → after (%)> …; lock held <from>-<to>; load <x>`.

## Acceptance (lead)
Two files changed; lock released (bb key empty); READY note has the per-row deltas and the seed; S/D/I within ±5% or a challenge filed.
