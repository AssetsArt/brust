# beta1-bench-remote: A/B bench of the beta1 round on the remote Mac Studio (k28@192.168.68.14)

**RULED by lead Detoro 2026-10-12 (plan written by the lead). Human 2026-10-12: no bench on the main host today; "เอาไป bench ใน ssh k28@192.168.68.14 folder /Users/k28/code ชั่วคราวก่อน". Runner lane (Illenium). The remote host is the human's machine: install ONLY in user space, nothing global is upgraded (see Task 1), delete nothing that is not ours. Results are TEMPORARY evidence: they go under `bench/results/remote-k28-2026-10-12/` and never overwrite `bench/RESULTS.json`/`RESULTS.md` (those are the canonical main-host rows).**

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: beta1 · lane: beta1-bench-remote · tier: routine · review: lead

**Goal.** On the remote host, measured back to back on the same machine: BEFORE = `v2` @db51891 (the round's base, release prep only) and AFTER = the beta1 sha the lead gives in GO (after F82 merges). Report per-row rps deltas for S/D/I (brust, bun-serve) and the A1/A2 rows (elysia-brust vs elysia-bun, AFTER only). A regression > 5% on an S/D/I brust row is a `task challenge` naming the suspected lane (F86/F89 = MISS path + job inserts; F87 = actions prefix; F82 = fetch framing), not a re-run.

Remote facts (lead probe 2026-10-12 10:15 local): macOS 25.1 arm64, Apple M2 Max 12 cores, load 1.3; ssh key auth works (`ssh k28@192.168.68.14`); `/Users/k28/code` exists; bun 1.3.9 (too old — the lockfile is configVersion 1 from bun 1.4.x), cargo stable only (no nightly-2026-09-15), no `oha`, `node` is broken (brew llhttp missing) → the `next` app is skipped; git 2.50.

## Boundary
`bench/results/remote-k28-2026-10-12/` (new: `before.json`, `after.json`, `README.md`). Nothing else in the repo. On the remote: `/Users/k28/code/brust-bench/` (clone), `/Users/k28/.bun-brust/` (isolated bun), rustup's own toolchain dir, `~/.cargo/bin/oha`.

## Tasks
1. Remote setup (idempotent; run each over `ssh k28@192.168.68.14`):
   - isolated bun 1.4.2: `curl -fsSL https://bun.sh/install | BUN_INSTALL=/Users/k28/.bun-brust bash -s "bun-v1.4.2"`; use it as `/Users/k28/.bun-brust/bin/bun` everywhere below (never `bun upgrade` the global one).
   - toolchain: `rustup toolchain install nightly-2026-09-15 -c rust-src` (the repo's `rust-toolchain.toml` selects it automatically inside the clone).
   - `oha`: `cargo +stable install oha --locked` (ends in `~/.cargo/bin/oha`).
   - clone: `git clone https://github.com/AssetsArt/brust.git /Users/k28/code/brust-bench` (or `git fetch` if present).
   Record every command and its last output line in the task note.
2. BEFORE: `cd /Users/k28/code/brust-bench && git checkout -q db51891 && /Users/k28/.bun-brust/bin/bun install --frozen-lockfile && (cd packages/brust && /Users/k28/.bun-brust/bin/bun run build)` (release addon; first build ~10-20 min cold). Then, with `PATH=/Users/k28/.bun-brust/bin:$HOME/.cargo/bin:$PATH`: `BRUST_RELEASE_ADDON=1 BENCH_LOCK_WS=838f12fb-70c1-41b7-acf2-d4065cf6bb64 BENCH_LOCK_ID='beta1-bench-remote Illenium' bun run bench -- --apps brust,bun-serve --probes S,D,I` (check `bench/run.ts` for the exact flag spelling; if `bun run bench` does not forward flags use `bun bench/run.ts …`). The harness refuses a busy host (exit 2) and needs `oha` on PATH. Note: `BENCH_LOCK_WS` makes the harness set the shared blackboard key from the remote — if `conclave` is not on the remote PATH, omit the two BENCH_LOCK_* vars (the remote has no other agents; the file lock still applies) and set `bench:host-lock` by hand from the main host for the duration. Copy `bench/RESULTS.json` → `before.json` (scp to the lane worktree on the main host).
3. AFTER: `git checkout -q <sha from GO>`, same install + release build, run with `--apps brust,bun-serve,elysia-bun --probes S,D,I,A1,A2`; copy to `after.json`.
4. `README.md` in the results dir: host line (from the JSON header), the two shas, a table `app | probe | conn | before rps | after rps | delta %` for every row present in both, plus the A1/A2 rows; one line per row with |delta| > 5%; the oha/bun/rust versions.
5. Commit on the lane (`bench: remote A/B on k28 Mac Studio — before db51891 / after <sha>`); `conclave task note … READY @<sha> — deltas: …`. Leave the remote clone in place (the human said temporary; the lead decides cleanup later), release any lock.

## Acceptance (lead)
Three files under the results dir only; both runs exit 0 with 0 errors per row; README deltas computed from the JSON; the lock keys are empty afterwards.
