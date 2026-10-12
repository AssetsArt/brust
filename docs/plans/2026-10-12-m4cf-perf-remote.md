# m4cf-perf-remote: A/B of the brust-core extraction (lane 1) on the remote Mac Studio

**RULED by lead Detoro 2026-10-12 (plan written by the lead). Runner lane (Illenium). No bench on the main host (human rule); the remote host is the human's Mac Studio offered for benching — address and paths are in the task note of `beta1-bench-remote`, never in Markdown. Results go under `bench/results/remote-2026-10-12-core-split/` (`before.json`, `after.json`, `README.md`; header = model · chip · RAM · cores · platform/arch, no hostname) and never into `bench/RESULTS.*`.**

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: m4cf · lane: m4cf-perf-remote · tier: routine · review: lead

**Goal.** BEFORE = `m4cf` base (v2 @0f0a136) vs AFTER = lane `lane/m4cf-core-split` @a86d6d4 (fetch it: `git fetch origin lane/m4cf-core-split`), app `brust` only, probes S,D,I, identity + gzip, TWO runs each (different seeds), measured back to back on the same remote machine with the release addon. Bar (plan m4cf-core-split): every brust S/D/I row within ≤ 3% of BEFORE on both runs (compare the better of the two AFTER runs to the better of the two BEFORE runs, and also list the worst case). A miss is a `task challenge` on `m4cf-core-split` with the rows, not a re-run.

## Boundary
`bench/results/remote-2026-10-12-core-split/` only.

## Tasks
1. `conclave lane start 838f12fb-70c1-41b7-acf2-d4065cf6bb64 m4cf-perf-remote` (from m4cf). Remote: the clone from `beta1-bench-remote` exists; `git fetch origin && git fetch origin lane/m4cf-core-split`. Toolchains are installed (bun 1.4.4 global, nightly-2026-09-15, oha).
2. BEFORE: `git checkout -q 0f0a136`, `bun install --frozen-lockfile`, `cd packages/brust && bun run build` (release), then from the repo root `BRUST_RELEASE_ADDON=1 bun run bench -- --apps brust --probes S,D,I --seed 11` and again with `--seed 12`; keep both RESULTS.json copies (`before-11.json`, `before-12.json`).
3. AFTER: `git checkout -q a86d6d4`, same install + release build (the addon rebuilds against the new crate layout — a build failure here is a finding: challenge with the log), two runs (`--seed 11`, `--seed 12`) → `after-11.json`, `after-12.json`.
4. README: machine line, shas, table `probe | enc | before best | after best | delta % | worst-case delta %`; verdict line (all ≤ 3% or the offending rows).
5. Commit on the lane, `conclave task note … READY @<sha> — <verdict> — deltas …`; leave the remote clone in place.

## Acceptance (lead)
Five files under the results dir only; four runs exit 0 with 0 errors; deltas computed from the JSON; the verdict matches the numbers.
