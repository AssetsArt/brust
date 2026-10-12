# cache-adapter-perf-remote: A/B of the cache adapter lane A with NO adapter configured, on the remote Mac Studio

**RULED by lead Detoro 2026-10-12 (plan written by the lead). Runner lane (Illenium). Fulfils plan `cache-adapter-core` L4: the lane ran no bench on the main host (human rule); the perf bar is checked on the human's remote Mac Studio (address and clone path in the task notes of `beta1-bench-remote`, never in Markdown). Results under `bench/results/remote-2026-10-12-cache-adapter/` (`before-11.json`, `before-12.json`, `after-11.json`, `after-12.json`, `README.md`; header = model · chip · RAM · cores · platform/arch, no hostname); never into `bench/RESULTS.*`. Required before the m4cf → v2 PR, not before lanes B/C start.**

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: m4cf · lane: cache-adapter-perf-remote · tier: routine · review: lead

**Goal.** BEFORE = m4cf @98968df (lane 6 merged, lane A not) vs AFTER = m4cf @26f0d7e (lane A merged), app `brust` only, NO `[cache] adapter` configured, probes S,D,I, identity + gzip, two seeds (11, 12) each, release addon, back to back on the same remote machine. Bar: every brust S/D/I row within ≤ 3% best-of-two vs best-of-two (worst-case single pairing listed, not a gate). A miss = `task challenge` on `cache-adapter-core` with the rows.

## Boundary
`bench/results/remote-2026-10-12-cache-adapter/` only.

## Tasks
1. `conclave lane start 838f12fb-70c1-41b7-acf2-d4065cf6bb64 cache-adapter-perf-remote` FROM /Users/detoro/code/brust (base m4cf). Remote clone from the earlier remote lanes: `git fetch origin`.
2. BEFORE: `git checkout -q 98968df`; `bun install --frozen-lockfile`; `cd packages/brust && bun run build`; repo root: `BRUST_RELEASE_ADDON=1 bun run bench -- --apps brust --probes S,D,I --seed 11` then `--seed 12`; keep the two RESULTS.json copies.
3. AFTER: `git checkout -q 26f0d7e` (run `cargo clean -p brust-core -p brust-server -p brust-napi` first — crates moved/changed), same install + release build, two seeds.
4. README: machine line, shas, table `probe | enc | before best | after best | delta % | worst-case %`, verdict line.
5. Commit on the lane; `conclave task note … READY @<sha> — <verdict> — deltas …`; leave the remote clone.

## Acceptance (lead)
Five files under the results dir only; four runs exit 0 with 0 errors; deltas computed from the JSON; verdict matches the numbers.
