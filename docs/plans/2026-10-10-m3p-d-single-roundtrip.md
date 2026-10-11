# m3p-d-single-roundtrip — P6 one worker round trip per page (planned loader call)
owner: 22499151-e133-4508-b358-d7fa4d2851c3 · authority: in-loop · base: m3p · escalation: lead Detoro via task challenge

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Start gate — RULED by lead Detoro 2026-10-10: R1 and R5 ACCEPTED** (amendment Variant R pasted into `docs/design/2026-10-09-m2-server-design.md` S1/S6/S7/§7; Variant L rejected, reasons in Appendix A). Original gate text: **R1** design = "planned loader call" (this plan; Rust keeps the job keys) instead of §3 as written (Appendix A lists what changes under §3-literal); **R5** probe `M` (the bench app's `teamLoader` reads `?start=`, attribution-only). The evidence for both is the section "Evidence the lane starts from" (E1, E7). Without R1 the plan does not apply; without R5 Task 1 Step 3 and every `M` measurement are skipped and the lane's perf evidence is D/I neutrality plus `bun_calls`.

**Goal:** Land lever P6 of the M3-P spec on lane `lane/m3p-d-single-roundtrip` (from `m3p`): a page whose loader returns data makes at most ONE worker round trip, whatever its jobs do (a `notFound` page with a job miss keeps two — Risk 6). Rust offers the plan in the `loader` request (`plan: true` when the chain has jobs); the worker runs the loaders, writes the context into its SAB slot and calls a new sync napi export `planJobs(slot, len)` from its own JS thread; Rust — on that thread — parses the context, runs the existing `collect_jobs` + `lookup_jobs` (keys unchanged, cache hits pinned), leaves the result in the claimed slot's plan cell and returns the misses as today's `JobsRequest` JSON; the worker runs only those and answers `{ planned: true, results }`; Rust takes the plan from the slot after the Promise, validates/inserts/merges with today's code and renders. A worker that ignores the offer gets today's two-call path (the offer is optional on the wire). `bun_calls` per page: L1 HIT 0, loader page 1 (was 2 on a job miss), no-loader page unchanged. Every rendered byte and header stays identical.

**Architecture:** One new seam, no new key code. (1) `pool.rs` `Slot` gains a type-erased plan cell (`Mutex<Option<Box<dyn Any + Send>>>`) whose lifetime is the claim: `RenderClaim::put_plan`/`take_plan`, cleared in `RenderClaim::drop` — so the plan of a request can never be read by another request on the same slot, survives exactly as long as JS may still touch the slot (deadline / disconnect keep the claim, see the `pool.rs` INVARIANT) and needs no global token map. (2) `dispatch.rs` `call_worker_planned(…, seed)` = `call_worker` that puts `seed` into the cell after the claim and returns the cell's content beside the response; `call_worker` becomes its wrapper. (3) `protocol.rs`: `LoaderRequest.plan` (omitted when false), `LoaderResponse::Planned { results }`. (4) `pipeline.rs`: `plan_in_call(&Server, worker, slot, len) -> String` (the worker-thread half: reads the slot bytes the worker just wrote on this same thread, `plan_response` core = `merge_loader_data` + `collect_jobs` + `lookup_jobs` + `jobs_request` JSON, stores `PlanCell::Planned`), `JobPlan` carries its template indices so the stored plan is owned (`PlanRow`) and re-borrowed against `s.plans` after the call (`rehydrate`); `page()` gets the planned arm, and the post-call result handling of today's jobs call is extracted into `apply_job_results` and shared. Any failure on the worker thread returns `"!"` (declined) and leaves no plan: the slot already holds the loader response, so `page()` runs today's code and today's error paths — the worst case of the new path is the old path. (5) `brust-napi`: `planJobs(slot, len): string` (sync, never throws) finds its server and worker id through a thread-local bound in `registerWorker`. (6) `worker.ts`: `makeDispatch` takes the offer (`plan` injectable for tests). (7) Stats: `job_calls` counts job batches the worker ran (in a `jobs` call or inside a planned call — every existing assertion keeps its number), new `worker_calls` counts round trips; the request log's `bun_calls` counts round trips.

**Tech Stack:** Rust nightly-2026-09-15, napi-rs 3.14.2 (sync `#[napi] fn` on the calling JS thread, `String` return), tokio 1, parking_lot 0.12, moka (job cache, unchanged), serde/serde_json 1 (manual `Visitor` in `protocol.rs`), Bun canary (`node:worker_threads` Workers, one OS thread each), `oha`, criterion (`cargo bench -p brust-server --bench render --no-run`).

**Spec:** `docs/design/2026-10-10-m3-perf-bench-design.md` §2 row P6, §3 (P6 design, amends S6/S7/§7 — this plan deviates as ruled in R1, amendment text in `docs/plans/2026-10-10-m3p-d-spec-amendment.draft.md`), §4 (lane row: Dew, complex / complex, Mellow), §5 (stop rule), §7 (integration branch `m3p`, no per-lane PR). Server spec: `docs/design/2026-10-09-m2-server-design.md` S1 (call table), S6 (job key), S7 steps 4-5, S10 (job cache), §7 (stats, `bun_calls` log field). Sibling just merged: `docs/plans/2026-10-10-m3p-b-value-path.md` (the `Node` pipeline this plan anchors on).

## Global Constraints

- Lane: `cd /Users/detoro/code/brust-m3p && git pull --ff-only && git worktree add ../brust-lane-m3p-d-single-roundtrip -b lane/m3p-d-single-roundtrip m3p` (NOT `conclave lane start`, which branches from `main`); all work in `/Users/detoro/code/brust-lane-m3p-d-single-roundtrip`; `bun install --frozen-lockfile` once. Base is `m3p` @ 42db1d1 or later; every line number below is at 42db1d1 — if the code moved, re-anchor on the quoted text and note it in the task note.
- NO PR. When done, post READY on the Conclave task (Task 10 note); the lead merges into `m3p`.
- **Concurrency with `m3p-c-l1-shard` (knock2, runs in parallel; its boundary is `docs/plans/2026-10-10-m3p-c-l1-shard.md` Global Constraints).** m3p-c owns `crates/brust-server/src/cache/l1.rs`, `crates/brust-server/src/routing/routes.rs` and, in `pipeline.rs`, `PageMeta` (:59-64), `handle` (:69-150), the entry of `page()` (:270-307: match, `l1_decision` call, HIT branch) plus ONE line it inserts right before `// ----- (4) loader -----` (`let envelope = rm.into_envelope(…)`), `l1_decision` (:850-984), new `hit_response`/`needs_first_gzip` after `page_response` (:649-672) and the `use` lines (:21, :30); its contract: `envelope`, `route_id`, `ri`, `route`, `status`, `cache_key`, `outcome`, `accept_enc`, `meta.bun_calls` keep names and types from :308 on, and `RequestEnvelope` is unchanged. **This lane never edits those.** Its `pipeline.rs` edits are: `page()` from `// ----- (4) loader -----` (:308) to the end of `// ----- (6) …` (:517) — the `LoaderRequest { … }` literal (:330-335) gains ONE line (`plan: …`); plus `JobPlan`/`PlanIndex`/`collect_jobs`/`lookup_jobs`/`results_in_request_order`/`jobs_request` (:954-1418), the new `plan_in_call`/`plan_response`/`rehydrate`/`apply_job_results`, `plan_stage` (:1659-1803), the `use` block only for new imports (:19-36 — the one place both lanes add lines: keep both), and tests. m3p-c leaves `config.rs`, `server/mod.rs`, `pool.rs`, `dispatch.rs`, `protocol.rs`, the napi crate and the TS package alone. Both lanes regenerate `bench/attribution.patch`. Whoever merges second: `git fetch origin && git merge origin/m3p` in the lane before READY, regenerate the attribution patch on the merged tree, re-run the full gate list, say so in the note.
- Output byte-identical at every measurement point: `examples/pokedex` tests + `tests/server/pokedex.test.ts` green with no assertion change, `crates/brust-server/benches/fixtures/pokedex/plan-golden.json` unchanged, the planned-vs-declined body equality tests of Task 6, AND the `curl` diffs (`$OUT/snap.sh`/`$OUT/cmp.sh` of Task 1 Step 7: pokedex `/` + `/pokemon/pikachu?nocache=1`, bench `/dex?nocache=1` + `/team?nocache=1`; identity; script hashes stripped; headers minus `date`) — `IDENTICAL` ×4 after Task 6, after Task 7, at READY.
- Measurement (every time, same host, machine idle: 1-min load ≤ cores):
  - Release addon first: `cd packages/brust && bun run build && cd ../..` (`BRUST_RELEASE_ADDON=1` is your declaration that this is what runs).
  - Bench, D and I identity, v2 vs 0.1.x: `BRUST_RELEASE_ADDON=1 BRUST_01X_DIR=$BRUST_01X_DIR BENCH_LOCK_WS=<your Conclave workspace id> BENCH_LOCK_ID='m3p-d-single-roundtrip Dew' bun bench/run.ts --apps brust,brust-01x --probes D,I --enc identity`. `run.ts` takes the host lock itself — the exclusive file `/tmp/brust-bench.lock` always, and the blackboard key `bench:host-lock` when `BENCH_LOCK_WS` + `BENCH_LOCK_ID` are set (lead rule `bench-host-lock`; `bench/lib/lock.ts`). Never measure without both layers. After every run except the last: `git checkout -- bench/RESULTS.md bench/RESULTS.json` (partial runs are reverted; only Task 10's full run is committed).
  - Attribution (stage tree): `git apply bench/attribution.patch`, release addon, `BRUST_RELEASE_ADDON=1 BENCH_CONN=120,1 ATTR_SIDES=v2 ATTR_APP=bench ATTR_PROBES=D,I,M bun $OUT/locked.ts` (the m3p-b lock wrapper, Task 1 Step 4), then `git checkout -- Cargo.lock crates/ packages/brust/src/worker.ts && rm -f crates/brust-server/src/perf.rs` and rebuild the release addon.
  - `BRUST_01X_DIR=/private/tmp/claude-501/-Users-detoro-code-brust/d073159b-8c7b-466d-ae02-a02838faf58a/scratchpad/brust01x` (`ls $BRUST_01X_DIR/runtime/*.node || (cd $BRUST_01X_DIR/runtime && bun run build)`).
- The applied attribution patch must NEVER be in a commit. Before EVERY commit: `git status --short` must list exactly the task's files; `grep -rn '_brust/perf\|mod perf' crates/brust-server/src` must be empty. Committing the refreshed `bench/attribution.patch` FILE (Tasks 1 and 9) is required.
- After ANY Rust edit, rebuild the addon before any TS test: `cd packages/brust && bun run build:debug`. The bench needs `bun run build` (release).
- Never `git add -A` at the repo root; stage files by name.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Gates (green before each code commit; in full before READY): `cargo fmt --all -- --check` · `cargo clippy -p brust-compiler -p brust-compiler-cli -p brust-jinja -p brust-server -p brust-napi --no-deps -- -D warnings` · `cargo clippy -p brust-compiler --no-deps -- -D warnings` (feature-OFF configuration) · `cargo test --workspace --exclude bun_react_compiler` · `cargo test -p brust-jinja` · `cargo test -p brust-compiler` (feature OFF) · **`cargo test -p brust-server --release --test single_roundtrip -- --nocapture`** (the 8 workers × 1000 pages stress test, Task 8; also runs in debug inside the workspace run) · **`cargo test -p brust-server --test inputs job_keys_are_pinned`** (the 20-key fixture, Task 4) · `cargo bench -p brust-server --bench render --no-run` and `cargo bench -p brust-jinja --bench json_attr --no-run` · `cd packages/brust && bun run build:debug && bun run typecheck && bun test test/routes.test.ts test/cache.test.ts test/worker.test.ts test/config.test.ts test/napi-compile.test.ts test/build-compile.test.ts && bun test test/napi-server.test.ts && bun test test/build-manifest.test.ts && bun test test/cli.test.ts && bun test --timeout 120000 test/e2e.test.ts` · `cd examples/pokedex && bun test && bun run typecheck` · `bun test --timeout 120000 tests/server/pokedex.test.ts` · `bun test --timeout 120000 tests/server/hydrate.chromium.test.ts` · `bun check -p bench && bun build --no-bundle bench/run.ts > /dev/null && bun test bench/lib && (cd bench/apps/brust && bun test)` · `git diff --quiet crates/brust-server/benches/fixtures && echo GOLDEN-UNCHANGED`. CI's server job runs each server-starting file alone; do the same when a combined run flakes on a port.
- Do not re-decide: job keys stay `inputs::job_key` (blake3, Rust) and `plan_key` stays — one implementation, also when it runs on a worker thread; the plan is an OFFER (`plan: true`), the worker may decline (`"!"`) or ignore it and Rust falls back to the two-call path; no plan or plan id travels on the wire (Rust owns `PlanIndex` since boot); the plan state lives in the claimed slot, never in a global map; `planJobs` never throws (napi-Bun Error-return trap) — every failure is `"!"`; hits are pinned (`Arc<Node>`) at plan time exactly as `lookup_jobs` pins them today; no-loader routes keep planning on tokio (0 calls on an all-hit page).
- Boundary: `crates/brust-server/src/{pool.rs,dispatch.rs,protocol.rs,pipeline.rs,config.rs,server/mod.rs,lib.rs}`, `crates/brust-server/tests/{common/fake_bun.rs,common/mod.rs,logging.rs,fake_bun.rs,inputs.rs,single_roundtrip.rs (new),fixtures/job-keys-20.json (new)}`, `crates/brust-napi/src/server.rs`, `packages/brust/src/{native.ts,worker.ts}`, `packages/brust/test/{worker.test.ts,napi-server.test.ts,e2e.test.ts}`, `bench/apps/brust/lib/loaders.ts` (R5), `bench/attribution.ts`, `bench/attribution.patch`, `bench/RESULTS.{md,json}` (Task 10 only). Not touched: `cache/l1.rs`, `routing/routes.rs`, `render.rs`, `brust-jinja`, the compiler, `routes.ts`, `run.ts`, `bench/run.ts`.

## Review Focus

1. **Plan cell lifetime and exclusivity.** The cell is written by `page()` (tokio, after the claim, before `dispatch.call`), by `plan_in_call` (the worker's JS thread, during the call) and taken by `call_worker_planned` (tokio, after the Promise resolved, before `drop(claim)`); `RenderClaim::drop` clears it on EVERY path. Orderings: put → tsfn enqueue (happens-before the JS call); JS call → Promise resolution → take (the tsfn await is the happens-before, as for the SAB bytes); the `parking_lot::Mutex` makes each access atomic. A late settle after the deadline is still covered: the `Detach` remainder owns the claim until JS settles, then drops it (clears the cell). `plan_in_call` refuses an idle slot (`claimed_plan_cell` → `None`). Pinned by: `put_take_and_drop_clear_the_plan_cell`, `call_worker_planned_returns_what_the_cell_holds_after_the_call`, `a_late_planned_call_leaves_no_plan_behind`, `plan_in_call_declines_an_idle_slot`, and the stress test's `plan_cells_in_use() == 0` at the end.
2. **The raw SAB read on the worker thread.** `plan_in_call` reads `buf_slot(slot)[..len]` of the worker's own registered buffer, on the worker's JS thread, synchronously inside that worker's call for `slot`: the bytes were written by this thread just before (`writeSlot`), the slot is claimed by this call, `len` is bounds-checked against `cap`. This is the response direction (JS writes, Rust reads) the `dispatch.rs` module doc allows; no request ever crosses the SAB. Pinned by: `plan_in_call_declines_a_len_outside_the_slot`, the napi-server planned test (real addon, real SAB view), e2e (real Bun Workers).
3. **Planned ≡ declined.** Both paths run the same `merge_loader_data` → `collect_jobs` → `lookup_jobs` → (results) → `apply_job_results` → `seed_child_slots` → `merge_values` → render, so the ctx, the plans, the keys and the bytes are identical; only WHERE planning runs differs. Pinned by: `planned_and_declined_pages_are_byte_identical` (r1, r2, r5, MISS and second-request), `rehydrated_plans_describe_like_collected_plans` (the three golden contexts), `pokedex_plans_match_the_golden` unchanged, the 4 `curl` diffs.
4. **Hits pinned at plan time vs invalidation.** Today `lookup_jobs` pins the hit `Arc<Node>`s before the `jobs` call, so an invalidation during the call does not change the page being built. The planned path pins them in `plan_response` and carries them in `PlannedCall.lookup.values` — same semantics, no "hit then gone" window (the bitmask design of §3 had one). Pinned by: `hits_pinned_at_plan_time_survive_an_invalidation_before_render` (invalidate between `planJobs` and the reply: the page renders the pinned value, the job is NOT re-run, the NEXT page misses).
5. **Counters and the napi thread binding.** `bun_calls` (log) and the new `worker_calls` (stats) count round trips; `job_calls` counts job batches (unchanged numbers in every existing Rust/TS assertion — the FakeBun counts batches too); `loader_calls` unchanged. `planJobs` resolves its server through a thread-local `(Weak<Server>, worker id)` written by `registerWorker` on that thread; a mismatch (no registration on this thread, a replaced server, an idle slot) declines, which degrades to the two-call path, never to a 500. Pinned by: `logging.rs` (`bun_calls=1`), e2e (`worker_calls` delta 1 with real Workers), napi-server's planned test (`job_calls` 1 then still 1 on an all-hit page), `planJobs on a thread that registered no worker declines` (Task 7 Step 5: a fresh Bun Worker calls the real export before any `registerWorker`).

## Dispatch table

Lane tier: **complex** — `review: complex` (spec §4: implementer Dew, reviewer Mellow). Per-task tiers are for the Coordinator's gate routing only.

| slug-task | tier | role | deps | acceptance (gate commands + READY evidence) |
|---|---|---|---|---|
| `m3p-d-single-roundtrip-1` baseline | routine | implementer | R1 + R5 recorded; lane created | attribution patch regenerated so `git apply --check` passes on HEAD; probe `M` in `attribution.ts` + `teamLoader` `?start=`; bench D/I identity (v2 + 0.1.x) and attribution trees (bench D/I/M, pokedex B/C; c=120 and c=1) pasted; 4 `curl` fixtures saved; commit `bench: attribution probe M (job miss every request); patch re-anchored on 42db1d1` |
| `m3p-d-single-roundtrip-2` slot plan cell | standard | implementer | task 1 | `cargo test -p brust-server pool:: dispatch::` green incl. 3 new tests; clippy clean; commit `feat(server): claim-scoped plan cell per worker slot; call_worker_planned (M3-P P6)` |
| `m3p-d-single-roundtrip-3` protocol | routine | implementer | task 2 | `cargo test -p brust-server protocol::` green incl. 3 new tests; commit `feat(server): loader request plan offer; planned loader response (M3-P P6)` |
| `m3p-d-single-roundtrip-4` owned plans | standard | implementer | task 3 | `pokedex_plans_match_the_golden` green, golden unchanged; `rehydrated_plans_describe_like_collected_plans` + `job_keys_are_pinned` green; commit `refactor(server): job plans carry template indices (PlanRow/rehydrate); 20 pinned job keys (M3-P P6)` |
| `m3p-d-single-roundtrip-5` plan_in_call | complex | implementer | task 4 | 6 new `pipeline::tests` green; commit `feat(server): plan_in_call — plan a page on the worker thread from the slot bytes (M3-P P6)` |
| `m3p-d-single-roundtrip-6` page wiring | complex | implementer | task 5 | `cargo test --workspace --exclude bun_react_compiler` green with only `logging.rs` `bun_calls=2→1` changed among existing assertions; 6 new `single_roundtrip.rs` tests green; golden unchanged; commit `perf(server): one worker round trip per loader page — planned call, declined fallback (M3-P P6)` |
| `m3p-d-single-roundtrip-7` napi + worker | complex | implementer | task 6 | full TS gate list green incl. 4 new worker tests, 1 new napi-server test, e2e `worker_calls` delta 1; `curl` diff IDENTICAL ×4; commit `perf(worker): take the plan offer — planJobs on the worker thread, misses in the same call (M3-P P6)` |
| `m3p-d-single-roundtrip-8` stress | standard | implementer | task 7 | `cargo test -p brust-server --release --test single_roundtrip -- --nocapture` green (8 × 1000 pages, concurrent invalidation, 0 plan cells left); commit `test(server): 8 worker threads plan while tokio inserts and invalidates (M3-P P6)` |
| `m3p-d-single-roundtrip-9` measure | routine | implementer | task 8 | attribution patch refreshed for the new code (PLAN_IN_CALL, CW_JS_PLAN, CW_JS_JOBS); bench D/I + attribution D/I/M after pasted with Δ vs Task 1; snaps IDENTICAL ×4; no committed RESULTS change |
| `m3p-d-single-roundtrip-10` gates + READY | routine | implementer | task 9 | merge `origin/m3p` if m3p-c landed first; full gate list green; `bench/RESULTS.{md,json}` regenerated (full `bun run bench`) and committed with the patch; READY note |

## File structure

```
crates/brust-server/src/pool.rs                 Slot.plan cell; RenderClaim::{put_plan,take_plan}; drop clears it; WorkerEntry::claimed_plan_cell
crates/brust-server/src/dispatch.rs             call_worker_planned (seed in, cell out); call_worker = wrapper; tests
crates/brust-server/src/protocol.rs             LoaderRequest.plan; LoaderResponse::Planned { results }; visitor; tests
crates/brust-server/src/pipeline.rs             JobPlan.src (template indices) / PlanRow / rehydrate; PlanIndex::chain_has_jobs;
                                                results_in_request_order over &[&str]; PLAN_DECLINED, PlanSeed, PlannedCall, PlanCell,
                                                plan_response, plan_in_call; apply_job_results; page() planned arm; tests
crates/brust-server/src/config.rs               Stats.worker_calls; Server.worker_calls
crates/brust-server/src/server/mod.rs           worker_calls init; Server::plan_cells_in_use (doc(hidden), tests)
crates/brust-server/src/lib.rs                  pub use pipeline::{plan_in_call, PLAN_DECLINED}
crates/brust-server/tests/common/fake_bun.rs    planned protocol (bind, after-plan hook); counts = (loader runs, job batches)
crates/brust-server/tests/common/mod.rs         boot* bind the fake to the server + worker id
crates/brust-server/tests/logging.rs            bun_calls=2 → bun_calls=1
crates/brust-server/tests/fake_bun.rs           + planned round trip through call_worker_planned
crates/brust-server/tests/inputs.rs             + job_keys_are_pinned
crates/brust-server/tests/fixtures/job-keys-20.json   NEW: 20 (cid, jid, inputs) → key, written once at 42db1d1
crates/brust-server/tests/single_roundtrip.rs   NEW: planned/declined equality, verdicts, no-loader, pinned hits, late settle, stress
crates/brust-napi/src/server.rs                 thread-local BOUND in register_worker; #[napi] plan_jobs(slot, len) -> String
packages/brust/src/native.ts                    planJobs in NativeBinding + export
packages/brust/src/worker.ts                    LoaderRequest.plan; PLAN_DECLINED; makeDispatch(h, view, slots, plan = planJobs)
packages/brust/test/worker.test.ts              + 4 planned-dispatch tests
packages/brust/test/napi-server.test.ts         + planned page in one call through the real addon
packages/brust/test/e2e.test.ts                 Stats.worker_calls; loader route delta 1
bench/apps/brust/lib/loaders.ts                 teamLoader: start = ?start (R5; absent → 0, probe I unchanged)
bench/attribution.ts                            probe M; TREE rows PLAN_IN_CALL / PIC_* / CW_JS_PLAN / CW_JS_JOBS
bench/attribution.patch                         re-anchored (Task 1), refreshed (Task 9)
bench/RESULTS.md, bench/RESULTS.json            regenerated (Task 10 only)
```

## Evidence the lane starts from

- **E1 — On every bench probe the steady state is ALREADY one worker call.** Post-P3 attribution (`/private/tmp/claude-501/-Users-detoro-code-brust/d073159b-8c7b-466d-ae02-a02838faf58a/scratchpad/m3p-b/attr-p3-bench.txt`, `…/attr-p3-pokedex.txt`): D, I (bench) and B, C (pokedex), c=120 and c=1, show `loader call_worker` at 1.00 calls/req and NO `jobs call_worker` row. D has no jobs at all (`dexPage_2e07494a.jobs = []`, `typeBadge_5f5390d7` static); I's one ssr job (`teamPage_5783433f/j0`, no ttl) hits the job cache after the first request; B/C jobs are cached after warm-up. The spec's "−45–50 µs on D/I; `bun_calls` 2 → 1" (§2 P6 row, §3) does not hold for the probes as built: P6 removes the second call only on pages whose jobs MISS (cold cache, TTL expiry, per-request inputs). Hence probe `M` (R5) and the acceptance "D/I neutral, M one call".
- **E2 — The two-call flow at 42db1d1** (`crates/brust-server/src/pipeline.rs`): call #1 `loader` built at :330-335 and sent at :336-343 (`call_worker::<_, LoaderResponse>`, `CallKind::Loader`), counted at :344-347 (`loader_calls`, `meta.bun_calls`), handled at :348-414; `let mut ctx = Node::map(ctx)` :415; `collect_jobs(&s.plans, &route.chain, &ctx)` :418 → `plan_one` (:1216) → `plan_key` (:1196): `cache.key` set → `"k:<cid>/<keyJob>/<user key>"` (user key raw string or canonical JSON), else `inputs::job_key(cid, keyJob, projected)` (`inputs.rs:243`): blake3 over `u32le len(cid) cid u32le len(jid) jid u32le len(json) json`, json = `serde_json::to_writer` of the `Node` (maps sorted by key bytes — `BTreeMap<Arc<str>, Node>`), `keyJob` = job id or `<jobId>#<row>` for a `per_instance` row without a `props` map; `lookup_jobs` :429 (`JobCache::get` per plan, hits pinned as `Arc<Node>`; identical keys in one page share one miss through `owner`/`misses` = in-page dedupe); call #2 `jobs` :430-456 only when `misses` is non-empty (`jobs_request` :1403, ids `<instance>/<jobId>[/<row>]`); validation `results_in_request_order` :468 + `check_value` + `note_missing_slots`; insert `s.jobs.insert(key, value, ttl, tags, user_key)` :496 (tags → `cacheInvalidate` by tag keeps working); owner fan-out :505-508; `seed_child_slots` + `merge_values` :512-517. Responses: JSON in the worker's SAB slot (`writeSlot` → `encodeInto`, `worker.ts:70`), read by `call_worker` (`dispatch.rs:187`) under the claim.
- **E3 — No cross-request coalescing exists.** No in-flight map in `brust-server` (`grep -rni 'singleflight\|coalesc\|inflight'` → only pool/drain counters); two concurrent requests missing one key both run it, the last insert wins. Dedupe is per page only (E2). The planned path keeps `lookup_jobs` unchanged, so both semantics are preserved.
- **E4 — The addon is loaded in the worker isolate and its statics are shared.** `worker.ts:6` imports `registerWorker` from `./native`; `register_worker` (`crates/brust-napi/src/server.rs:113-140`) runs on the worker's JS thread and reads `static SERVER: RwLock<Option<Arc<Server>>>` (:22) set by `startServer` on the main thread — one dylib per process, shared statics. A sync `#[napi]` fn runs on the calling JS thread with that env; it can touch any `Send + Sync` Rust state (`Server`, `JobCache`, `WorkerPool`). `napi = 3.14.2` (`Cargo.lock:1666`).
- **E5 — Hash.** Rust: blake3 (`inputs.rs:243-265`). Bun 1.4.3 `Bun.CryptoHasher` has no blake3 ("Unsupported algorithm blake3"); measured in scratch (`…/f9f1ca9f-…/scratchpad/m3pd/canon.ts`): a sorted-key canonical JSON writer in JS costs 256 ns for a 45-byte input (+ sha256 → 512 ns) and 115 µs for a D-size 17 KB context (`"*"` inputs) vs `JSON.stringify` 18 µs; `Bun.hash` (wyhash) 47 ns and `xxHash3` 77 ns are 64-bit non-cryptographic (inputs can derive from request data → crafted collisions = job-cache poisoning). Under R1 nothing changes: keys stay blake3 in Rust. (Under §3-literal: sha256, never a 64-bit hash — Appendix A.)
- **E6 — The plan data exists at boot.** `PlanIndex::new(&manifest)` (`pipeline.rs:1080-1134`) builds every component's job templates, child records, call-id prefixes; it is `Server.plans` (`config.rs:155`), built in `server/mod.rs:97`. The worker also loads `manifest.json` (`worker.ts:227`), so even §3-literal needs no plan on the wire.
- **E7 — What a worker call costs (the saving on a miss page).** I c=1: `tsfn bridge round trip` 14.58 µs + `serialize request` 0.33 + `claim` 0.11 + `SAB read + parse` 0.68 ≈ 15.7 µs per round trip; at c=120 the bridge is queueing-dominated (146 µs on I). That is what one fewer round trip saves on `M`; D/I should not move (E1).
- **E8 — Attribution today.** `bench/attribution.ts` + `bench/attribution.patch` time per stage (`perf.rs` stage ids: `COLLECT_JOBS` 22, `CJ_KEY` 24, `JOB_LOOKUP` 25, `JOBS_CALL` 26, `CW_*` 60-77 per loader call, `JB_*` 80-97 per jobs call; JS tail = 8 f64 at the end of the slot: magic, entry, parse, handler, stringify, write, total, exit). `git apply --check bench/attribution.patch` FAILS on 42db1d1 (`pipeline.rs:610`, moved by a53652d); `patch -p1 --dry-run --forward` applies with fuzz — Task 1 regenerates it.
- **E9 — Test churn is small because counts are per batch.** 33 call-count assertions (`grep -n 'counts()\|last_jobs\|job_calls\|loader_calls' crates/brust-server/tests/*.rs`, TS `e2e.test.ts:92-99`, `tests/server/pokedex.test.ts:36-117`, `napi-server.test.ts:49-78`) read `(loader runs, job batches)`; a planned FakeBun keeps both numbers. Only `logging.rs:53` (`bun_calls=2`) changes, by design. `napi-server.test.ts`'s hand-written handler ignores the offer → it keeps exercising the two-call path (`kinds == ['loader','jobs']`).

---

### Task 1: Baseline — lane, patch re-anchor, probe M, bench + attribution before, curl fixtures

**Files:**
- Modify: `bench/attribution.ts` (probe `M`), `bench/attribution.patch` (re-anchored), `bench/apps/brust/lib/loaders.ts` (`teamLoader`, R5)
- Create (scratch, not committed): `$OUT/locked.ts`, `$OUT/snap.sh`, `$OUT/cmp.sh`

- [ ] **Step 1: Lane and scratch**
```bash
cd /Users/detoro/code/brust-m3p && git pull --ff-only && git log --oneline -1     # 42db1d1 or later
git worktree add ../brust-lane-m3p-d-single-roundtrip -b lane/m3p-d-single-roundtrip m3p
cd /Users/detoro/code/brust-lane-m3p-d-single-roundtrip && bun install --frozen-lockfile
export OUT=<your scratchpad directory>/m3p-d && mkdir -p $OUT
export BRUST_01X_DIR=/private/tmp/claude-501/-Users-detoro-code-brust/d073159b-8c7b-466d-ae02-a02838faf58a/scratchpad/brust01x
ls $BRUST_01X_DIR/runtime/*.node || (cd $BRUST_01X_DIR/runtime && bun run build)
```

- [ ] **Step 2: Re-anchor the attribution patch** (E8):
```bash
git apply --check bench/attribution.patch && echo PATCH-OK      # expect: error … pipeline.rs:610
patch -p1 --forward --reject-file=- < bench/attribution.patch    # applies with fuzz; expect no "FAILED"
cargo check -p brust-server
git add -N crates/brust-server/src/perf.rs && git diff -- Cargo.lock crates/ packages/brust/src/worker.ts > $OUT/attribution.patch.base
git reset -q crates/brust-server/src/perf.rs && git checkout -- Cargo.lock crates/ packages/brust/src/worker.ts && rm -f crates/brust-server/src/perf.rs
cp $OUT/attribution.patch.base bench/attribution.patch && git apply --check bench/attribution.patch && echo PATCH-OK
```
`git status --short` → only `bench/attribution.patch` modified.

- [ ] **Step 3: Probe `M` (R5).** `bench/apps/brust/lib/loaders.ts:13-15` current:
```ts
export async function teamLoader(_ctx: LoaderCtx): Promise<{ title: string; start: number; label: string }> {
  return { title: 'Team · bench', start: 0, label: 'clicks' }
}
```
→
```ts
/** `?start=<n>` (attribution probe M only, v2-only): the island's start prop — a distinct job key per value, so
 * every M request misses the job cache. Absent (probe I and every other app) → 0, the parity page. */
export async function teamLoader(ctx: LoaderCtx): Promise<{ title: string; start: number; label: string }> {
  const s = Number.parseInt(ctx.req.search.start ?? '', 10)
  return { title: 'Team · bench', start: Number.isFinite(s) ? s : 0, label: 'clicks' }
}
```
`bench/attribution.ts`: `urlOf` (:31-32) gains `probe === 'M' ? '/team?nocache=1&start=7' :` before the `D` arm (the headers probe), `target` (:33-34) becomes
```ts
const target = (side: string, base: string, probe: string) =>
  probe === 'B' ? ['--rand-regex-url', `${base}/pokemon/(${NAMES.join('|')})${side === 'v2' ? '\\?nocache=1' : ''}`]
  : probe === 'M' ? ['--rand-regex-url', `${base}/team\\?nocache=1&start=[1-9][0-9]{6}`]   // 9·10^6 values ≫ job cache 1000: a miss per request
  : [`${base}${urlOf(side, probe)}`]
```
and the header comment's probe list gains `M (/team?nocache=1&start=<random>: one job miss per request)`. `M` is never a `run.ts` probe (no parity row).
```bash
bun check -p bench && bun build --no-bundle bench/attribution.ts > /dev/null && (cd bench/apps/brust && bun test) && echo TS-OK
```

- [ ] **Step 4: Lock wrapper (scratch)** — exactly m3p-b's, path adjusted:
```ts
// $OUT/locked.ts — hold the two-layer bench host lock around `bun bench/attribution.ts` (env passes through).
import { acquireHostLock } from '/Users/detoro/code/brust-lane-m3p-d-single-roundtrip/bench/lib/lock'
const release = await acquireHostLock((s) => console.log(`[lock] ${s}`))
const p = Bun.spawn(['bun', 'bench/attribution.ts'], { cwd: '/Users/detoro/code/brust-lane-m3p-d-single-roundtrip', stdio: ['inherit', 'inherit', 'inherit'], env: process.env })
const code = await p.exited
release()
process.exit(code)
```

- [ ] **Step 5: Bench (before)**
```bash
cd packages/brust && bun run build && cd ../..            # RELEASE addon
uptime                                                    # 1-min load ≤ cores
BRUST_RELEASE_ADDON=1 BRUST_01X_DIR=$BRUST_01X_DIR BENCH_LOCK_WS=<ws> BENCH_LOCK_ID='m3p-d-single-roundtrip Dew' \
  bun bench/run.ts --apps brust,brust-01x --probes D,I --enc identity | tee $OUT/bench-before.txt
cp bench/RESULTS.json $OUT/RESULTS-before.json && git checkout -- bench/RESULTS.md bench/RESULTS.json
```
Expected shape (committed numbers on this host: D brust 14,253 rps vs 0.1.x 12,495; I brust 103,629 vs 101,013). Paste the four rows under **before**.

- [ ] **Step 6: Attribution (before)** — bench D/I/M and pokedex B/C:
```bash
git apply bench/attribution.patch && cd packages/brust && bun run build && cd ../..
BRUST_RELEASE_ADDON=1 BENCH_CONN=120,1 ATTR_SIDES=v2 ATTR_APP=bench ATTR_PROBES=D,I,M ATTR_OUT=$OUT/attr-before-bench.json BENCH_LOCK_WS=<ws> BENCH_LOCK_ID='m3p-d-single-roundtrip Dew' bun $OUT/locked.ts | tee $OUT/attr-before-bench.txt
BRUST_RELEASE_ADDON=1 BENCH_CONN=120,1 ATTR_SIDES=v2 ATTR_OUT=$OUT/attr-before-pokedex.json BENCH_LOCK_WS=<ws> BENCH_LOCK_ID='m3p-d-single-roundtrip Dew' bun $OUT/locked.ts | tee $OUT/attr-before-pokedex.txt
git checkout -- Cargo.lock crates/ packages/brust/src/worker.ts && rm -f crates/brust-server/src/perf.rs
grep -rn '_brust/perf\|mod perf' crates/brust-server/src || echo no-perf-in-tree
cd packages/brust && bun run build && cd ../..
```
Expected: `### v2 M c=120 …` shows BOTH `loader call_worker (wall)` and `jobs call_worker (misses only)` at 1.00 calls/req (two round trips); D/I show only the loader call (E1). Paste for D, I, M (c=120 and c=1): `SVC_TOTAL`, `CW_TOTAL`, `CW_DISPATCH`, `BRIDGE`, `CW_JS_TOTAL`, `CW_JS_HANDLER`, `CW_READ_PARSE`, `COLLECT_JOBS`, `CJ_KEY`, `JOB_LOOKUP`, `JB_TOTAL`, `RENDER_CHAIN`, `unattributed`, `CW_RESP_BYTES`, CPU µs/req, rps. Pokedex B/C: `SVC_TOTAL`, `COLLECT_JOBS`, `JOB_LOOKUP`, rps (continuity).

- [ ] **Step 7: curl fixtures (before)** — m3p-b's `snap.sh` and `cmp.sh` verbatim (Task 1 Step 7 of `docs/plans/2026-10-10-m3p-b-value-path.md`), saved under `$OUT`; then `chmod +x $OUT/snap.sh $OUT/cmp.sh && $OUT/snap.sh before`. Expected: four bodies (`/dex` ~21.7 KB, `/team` 781 B), `x-brust-cache: BYPASS` on pikachu, `/dex`, `/team`.

- [ ] **Step 8: Commit**
```bash
git status --short     # bench/attribution.ts bench/attribution.patch bench/apps/brust/lib/loaders.ts — nothing else
git add bench/attribution.ts bench/attribution.patch bench/apps/brust/lib/loaders.ts
git commit -m "bench: attribution probe M (job miss every request); patch re-anchored on 42db1d1

M = /team?nocache=1&start=<random>: teamLoader reads ?start (absent → 0,
so probe I and every other app are unchanged), a distinct island prop per
request, so the Counter ssr job misses the job cache every time — the page
shape P6 changes from two worker round trips to one. D and I already make
one call in steady state (their jobs are absent or cached).
attribution.patch no longer applied with git apply after a53652d; it is
regenerated from a fuzzed apply, same stage ids.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: The claim-scoped plan cell and `call_worker_planned`

**Files:**
- Modify: `crates/brust-server/src/pool.rs` (`Slot` :41-50, `RenderClaim` :140-150, `Drop` :152-184, `register` :212-230, `WorkerEntry` impl :81-109), `crates/brust-server/src/dispatch.rs` (`call_worker` :187-250)
- Test: `pool.rs` tests (:342-), `dispatch.rs` tests (:405-)

**Interfaces:**
```rust
// pool.rs
pub type PlanBox = Box<dyn std::any::Any + Send>;
pub struct Slot { idle, render_slot, /* NEW */ pub(crate) plan: parking_lot::Mutex<Option<PlanBox>> }
impl RenderClaim {
    pub fn put_plan(&self, v: PlanBox);
    pub fn take_plan(&self) -> Option<PlanBox>;
}
impl WorkerEntry {
    /// `slot`'s plan cell while that slot is claimed; `None` when out of range or idle.
    pub fn claimed_plan_cell(&self, slot: u32) -> Option<&parking_lot::Mutex<Option<PlanBox>>>;
}
// dispatch.rs
pub async fn call_worker_planned<Req: Serialize, Resp: DeserializeOwned + Send + 'static>(
    pool: &Arc<WorkerPool>, timeout: Duration, call_timeout: Duration, kind: CallKind, req: &Req,
    seed: Option<PlanBox>,
) -> Result<(Resp, Option<PlanBox>), CallError>;
pub async fn call_worker<…>(…) -> Result<Resp, CallError>   // = call_worker_planned(…, None).map(|(r, _)| r)
```

- [ ] **Step 1: Failing tests.** `pool.rs` tests:
```rust
#[test]
fn put_take_and_drop_clear_the_plan_cell() {
    let pool = WorkerPool::new();
    pool.register(Box::new(MockDispatch::with_slots(2)));
    let ClaimResult::Claimed(c) = pool.try_claim_render_lockfree() else { panic!("claim") };
    let entry = Arc::clone(c.entry());
    let slot = c.slot();
    assert!(entry.claimed_plan_cell(slot).is_some(), "a claimed slot exposes its cell");
    assert!(entry.claimed_plan_cell(1 - slot).is_none(), "an idle slot does not");
    assert!(entry.claimed_plan_cell(9).is_none(), "out of range");
    c.put_plan(Box::new(7u32));
    assert_eq!(*c.take_plan().unwrap().downcast::<u32>().unwrap(), 7);
    assert!(c.take_plan().is_none());
    c.put_plan(Box::new(8u32));
    drop(c); // never taken: the claim's drop clears it
    assert!(entry.slot(slot as usize).plan.lock().is_none());
}
```
`dispatch.rs` tests (a mock that, like `plan_in_call`, replaces the seed during the call):
```rust
/// Writes `{"ok":true,"data":{}}` and, during the call, swaps the slot's plan cell content
/// (u32 seed → seed + 1) through `claimed_plan_cell`, as `plan_in_call` does from the worker thread.
struct Planner(MockDispatch, std::sync::Weak<WorkerPool>);
// impl RenderDispatch for Planner: call() looks up its entry (id 0) via the pool, swaps the cell, then delegates to self.0.call
#[tokio::test(flavor = "current_thread")]
async fn call_worker_planned_returns_what_the_cell_holds_after_the_call() { /* seed 41 → (Value, Some(42)); the slot's cell is empty after */ }
#[tokio::test(flavor = "current_thread")]
async fn call_worker_planned_clears_the_cell_on_a_bad_response() { /* MockDispatch::reply_len(0): Err(BadResponse), cell empty */ }
```
Write `Planner` fully (≈30 lines: `Arc::new_cyclic` is not needed — register the `Planner`, then `pool.entry(0)`). `cargo test -p brust-server pool:: dispatch::` → the three fail to compile (no `plan`, no `call_worker_planned`).

- [ ] **Step 2: `pool.rs`.** Add `pub type PlanBox` and the field with this doc:
```rust
    /// M3-P P6: the in-call plan state of the request holding this slot
    /// (`pipeline::PlanCell`, type-erased so the pool stays pipeline-free). Put by
    /// `RenderClaim::put_plan` (tokio, after the claim, before the call), swapped by
    /// `pipeline::plan_in_call` (the worker's JS thread, during the call), taken by
    /// `RenderClaim::take_plan` after the Promise resolved. ALWAYS cleared by
    /// `RenderClaim::drop`: no plan outlives its claim (deadline, disconnect, panic).
    pub(crate) plan: parking_lot::Mutex<Option<PlanBox>>,
```
`register` initialises `plan: parking_lot::Mutex::new(None)`. `put_plan`/`take_plan` lock `self.entry.slots[self.slot as usize].plan`. `claimed_plan_cell`: `self.slots.get(slot as usize).filter(|s| !s.is_idle()).map(|s| &s.plan)`. `Drop`: first line after `let slot = …`: `let stale = slot.plan.lock().take(); drop(stale);` (the Box is dropped outside the lock), before the `render_slot` clear.

- [ ] **Step 3: `dispatch.rs`.** Rename the body of `call_worker` to `call_worker_planned` with the extra `seed` argument: right after `let claim = claim_or_wait(…)?;` add `if let Some(s) = seed { claim.put_plan(s); }`; inside the boxed future, after `parsed` is computed: `let plan = claim.take_plan(); drop(claim); parsed.map(|r| (r, plan))`; `Resp` → `(Resp, Option<PlanBox>)` in the future and `Detach` types. Doc comment: "[`call_worker`] for a call the worker may plan (M3-P P6): `seed` goes into the claimed slot's plan cell before the call; whatever the cell holds after the Promise resolved is returned beside the response — taken under the claim, so it is never another request's." `call_worker` becomes:
```rust
pub async fn call_worker<Req: Serialize, Resp: DeserializeOwned + Send + 'static>(
    pool: &Arc<WorkerPool>, timeout: Duration, call_timeout: Duration, kind: CallKind, req: &Req,
) -> Result<Resp, CallError> {
    call_worker_planned(pool, timeout, call_timeout, kind, req, None).await.map(|(r, _)| r)
}
```
`cargo test -p brust-server pool:: dispatch::` → green (old + 3 new). `cargo test -p brust-server --test fake_bun --test busy` green (cancel-safety unchanged).

- [ ] **Step 4: Commit** `feat(server): claim-scoped plan cell per worker slot; call_worker_planned (M3-P P6)` (files: `pool.rs`, `dispatch.rs`).

### Task 3: Protocol — the plan offer and the planned response

**Files:** Modify `crates/brust-server/src/protocol.rs` (`LoaderRequest` :13-21, `LoaderResponse` :31-44, `LoaderVisitor::visit_map` :61-125); tests (:196-).

**Interfaces:** `LoaderRequest { route_id, params, path, req, plan: bool }` — `plan` serialised as `"plan": true` only when true (`#[serde(skip_serializing_if = "std::ops::Not::not")]`), doc: "M3-P P6: the chain has jobs — the worker may plan them inside this call (`planJobs`) and answer `{ planned, results }`; it may also ignore this". `LoaderResponse::Planned { results: Vec<JobResult> }`, doc: "the worker took the plan offer: the loader data went to `plan_in_call` (it is in the slot's plan cell), `results` answer the misses `planJobs` returned (empty when every job hit)".

- [ ] **Step 1: Failing tests**
```rust
#[test]
fn plan_offer_is_omitted_when_false() {
    let env = || RequestEnvelope { method: "GET", url: "/", headers: vec![], cookies: vec![], search: vec![] };
    let mut r = LoaderRequest { route_id: "r2", params: BTreeMap::new(), path: "/", req: env(), plan: false };
    assert!(!serde_json::to_string(&r).unwrap().contains("plan"));
    r.plan = true;
    assert!(serde_json::to_string(&r).unwrap().contains(r#""plan":true"#));
}
#[test]
fn planned_response_parses_with_and_without_results() {
    assert_eq!(loader(json!({"planned": true})), LoaderResponse::Planned { results: vec![] });
    let LoaderResponse::Planned { results } = loader(json!({"planned": true, "results": [{"id": "c/j0", "value": {"_s1": 1}}]})) else { panic!() };
    assert_eq!((results.len(), results[0].id.as_str()), (1, "c/j0"));
}
#[test]
fn planned_wins_over_every_other_shape_and_false_is_ignored() {
    assert!(matches!(loader(json!({"planned": true, "ok": true, "data": {}})), LoaderResponse::Planned { .. }));
    assert!(matches!(loader(json!({"planned": false, "ok": true, "data": {}})), LoaderResponse::Ok { .. }));
}
```
(`JobResult` gains `#[derive(PartialEq)]` for the first assertion; `LoaderResponse` derives `PartialEq` already.) Red: no field / variant.

- [ ] **Step 2: Implement.** In the visitor: two more locals `(mut planned, mut results) = (None::<bool>, None::<Vec<JobResult>>)`, keys `"planned"` / `"results"`, and as the FIRST decision after the loop: `if planned == Some(true) { return Ok(LoaderResponse::Planned { results: results.unwrap_or_default() }); }`. Update the type doc's precedence sentence ("`Planned` needs `planned: true`; else `Ok` …"). The one constructor of `LoaderRequest` (`pipeline.rs:330`) gets `plan: false` for now (Task 6 sets it). `cargo test -p brust-server protocol::` green; `cargo test -p brust-server` green.

- [ ] **Step 3: Commit** `feat(server): loader request plan offer; planned loader response (M3-P P6)` (files: `protocol.rs`, `pipeline.rs` one line).

### Task 4: Owned plans (`PlanRow` / `rehydrate`), `chain_has_jobs`, 20 pinned keys

**Files:** Modify `crates/brust-server/src/pipeline.rs` (`JobPlan` :977-997, `CompTpl` :1031-1039, `PlanIndex` :1080-1142, `plan_one` :1216-1256, `collect_jobs` :1265-1310, `results_in_request_order` :1366-1400 and its 3 tests :1847-1903, `plan_stage` :1659-1803); `crates/brust-server/tests/inputs.rs`; create `crates/brust-server/tests/fixtures/job-keys-20.json`.

**Interfaces:**
```rust
/// Where a plan's template lives in the `PlanIndex` (M3-P P6: a plan stored across the worker
/// call is owned — `PlanRow` — and re-borrowed with `rehydrate`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PlanSrc { comp: u32, job: u32, via: Option<(u32, u32)> /* (parent comp, child record) */ }
pub(crate) struct JobPlan<'a> { /* existing fields */ pub(crate) src: PlanSrc }
/// What survives the worker call of a plan: its template indices and its per-request strings.
pub(crate) struct PlanRow { src: PlanSrc, row: Option<usize>, key: JobKey, user_key: Option<String> }
impl JobPlan<'_> { pub(crate) fn to_row(&self) -> PlanRow; }
/// The plans `rows` describe, borrowed from `idx` again. `inputs` is `Node::Null`: a rehydrated
/// plan is used after its call (insert, merge, logs), never to build a request.
pub(crate) fn rehydrate(idx: &PlanIndex, rows: Vec<PlanRow>) -> Vec<JobPlan<'_>>;
impl PlanIndex { /// Some chain component or one of its children has a job.
    pub(crate) fn chain_has_jobs(&self, chain: &[String]) -> bool; }
fn results_in_request_order(ids: &[&str], results: Vec<JobResult>) -> Result<Vec<Node>, JobResultError>;
```

- [ ] **Step 1: Failing tests** (`pipeline.rs` tests):
```rust
#[test]
fn rehydrated_plans_describe_like_collected_plans() {
    // The three golden contexts (same loading code as pokedex_plans_match_the_golden).
    for (pattern, file) in [("/pokemon/{name}", "pokemon-pikachu.json"), ("/", "home.json"), ("/type-chart", "type-chart.json")] {
        let (m, ctx) = golden_ctx(pattern, file);           // extract the loader of the golden test into this helper
        let idx = PlanIndex::new(&m).unwrap();
        let route = m.routes.iter().find(|r| r.pattern == pattern).unwrap();
        let plans = collect_jobs(&idx, &route.chain, &ctx).unwrap();
        let rows: Vec<PlanRow> = plans.iter().map(JobPlan::to_row).collect();
        let back = rehydrate(&idx, rows);
        let strip = |d: Node| { /* describe() with every "inputs" set to null */ };
        assert_eq!(strip(plan_stage::Planned(back).describe()), strip(plan_stage::Planned(plans).describe()), "{file}");
        assert!(idx.chain_has_jobs(&route.chain), "{file}");
    }
}
#[test]
fn chain_has_jobs_sees_child_jobs_only_chains() { /* manifest(): r1 chain [appLayout_a1, homePage_b2] → false; r2 → true (own + moveCard child) */ }
```
`tests/inputs.rs`:
```rust
/// 20 job keys pinned at 42db1d1: a change of `job_key`'s bytes (field layout, canonical JSON,
/// number text, key order, hash) fails here before it reaches a cache. Regenerate ONLY with a
/// spec amendment: `BRUST_WRITE_JOB_KEYS=1 cargo test -p brust-server --test inputs job_keys_are_pinned`.
#[test]
fn job_keys_are_pinned() { /* read fixtures/job-keys-20.json: [{cid, jid, inputs, key}]; assert job_key(cid, jid, &Node::from(inputs)) == key for all 20; with the env var, rewrite the file from CASES */ }
```
The 20 `CASES` (cid, jid, inputs): `("typeBadge_5f5390d7","j0",{"type":"fire"})`, `("a","bc",null)`, `("ab","c",null)`, `("","",{})`, `("c","j0#3",{"row":3})`, `("c","j0",[1,"é",{"z":1,"a":[true]}])`, `("detailPage_c3","j0",{"pokemon":{"stats":{"hp":35}}})`, `("moveCard_d4","j0",{"move":{"name":"tackle"}})`, `("teamPage_g7","j0",{"team":["a"]})`, `("teamBuilder_h8","ssr",{"team":["a","b"],"who":"anon"})`, `("n","j0",{"active":true})`, `("n","j0",{"active":false})`, `("x","j1",{"big":18446744073709551615})`, `("x","j1",{"neg":-7,"f":1.5,"e":1e21,"t":1e-7})`, `("x","j1",{"u":"ピカチュウ","esc":"a\"b\\c\n"})`, `("x","j1",{"b":{"a":1},"a":{"b":2}})`, `("x","j1",{"[idx]":{"n":7}})`, `("x","j1",{"a":{"[0]":{"n":1},"[1]":{"n":2}}})`, `("counter_4a7ef039","j0",{"label":"clicks","start":0})`, `("counter_4a7ef039","j0",{"label":"clicks","start":1234567})`. Generate the fixture BEFORE any change to `inputs.rs` (it is not changed in this lane): `BRUST_WRITE_JOB_KEYS=1 cargo test -p brust-server --test inputs job_keys_are_pinned && git add crates/brust-server/tests/fixtures/job-keys-20.json`.

- [ ] **Step 2: Implement.** `PlanIndex` gets `fn comp_ix(&self, id: &str) -> Result<usize, String>`; `CompTpl` gets `deep_jobs: bool` (own jobs non-empty or any child component's jobs non-empty; computed in `new` in a second pass over `comps`); `chain_has_jobs` = `chain.iter().any(|id| self.by_id.get(id).is_some_and(|&i| self.comps[i].deep_jobs))`. `plan_one` takes `src: PlanSrc` and stores it; `collect_jobs` builds `src` from the loop indices (`comp_ix(id)`, `.enumerate()` over `c.jobs`, `c.children`, `child.jobs`; `via = Some((parent_ix, child_record_ix))` for child instances). `to_row` copies `src`, `call_row`, `key`, `user_key`. `rehydrate` rebuilds each `JobPlan` from `src`: chain → `call_prefix = &comp.call_prefixes[job]`, `dest = Dest::Chain { component: &comp.id, row }`; child → `let p = &idx.comps[parent]; let ch = &p.children[rec];` `call_prefix = &ch.call_prefixes[job]`, `dest = Dest::Child { parent: &p.id, component: &comp.id, slot: &ch.slot, row }`; `component_id`, `job_id`, `kind`, `ttl`, `tags`, `outputs`, `target` from `comp.jobs[job]`; `inputs: Node::Null`. `results_in_request_order` takes `ids: &[&str]` (`pos` built from it; `out` sized `ids.len()`); the jobs-call site builds `let ids: Vec<&str> = req.jobs.iter().map(|c| c.id.as_str()).collect();` and its 3 tests use `&["a", "b"]` slices instead of `req_of(…)` (remove `req_of` if unused). `Planned<'a>` in `plan_stage` gets `pub(crate)` visibility of its field kept as is (the test above constructs it).
```bash
cargo test -p brust-server pipeline:: && cargo test -p brust-server --test inputs && git diff --quiet crates/brust-server/benches/fixtures && echo GOLDEN-UNCHANGED
cargo bench -p brust-server --bench render --no-run
```

- [ ] **Step 3: Commit** `refactor(server): job plans carry template indices (PlanRow/rehydrate); 20 pinned job keys (M3-P P6)` (files: `pipeline.rs`, `tests/inputs.rs`, `tests/fixtures/job-keys-20.json`).

### Task 5: `plan_in_call` — planning on the worker thread from the slot bytes

**Files:** Modify `crates/brust-server/src/pipeline.rs` (new section after `merge_values` :1420, "(4+5) the planned loader call"), `crates/brust-server/src/lib.rs` (:25 re-exports); tests in `pipeline.rs`.

**Interfaces:**
```rust
/// `planJobs` answer: not planned — the worker keeps its loader response in the slot and `page`
/// plans after the call (the two-call path). Never a valid `JobsRequest` JSON.
pub const PLAN_DECLINED: &str = "!";
/// Put into the claimed slot by `page` before a planned loader call.
pub(crate) struct PlanSeed { pub route: usize /* manifest route index */, pub base: MapInner /* params + path */ }
/// Left in the slot by `plan_in_call` (success only) for `page`.
pub(crate) struct PlannedCall {
    pub ctx: Node,                          // base + loader data (merge_loader_data), as `page` builds it
    pub headers: BTreeMap<String, String>,  // the loader's response headers
    pub rows: Vec<PlanRow>,                 // collect_jobs, owned
    pub lookup: Lookup,                     // hits pinned, owner, misses — exactly lookup_jobs'
    pub call_ids: Vec<String>,              // ids of the misses' calls, request order
}
pub(crate) enum PlanCell { Seed(PlanSeed), Planned(PlannedCall) }
/// The planning core: `bytes` = the worker's `{ ok: true, data, headers? }`. `None` = decline
/// (not that shape, `ok: false`, a planning error — `page` will meet the same error after the
/// call and answer it with today's log + status). `Some((plan, misses))`: `misses` is the
/// `JobsRequest` JSON of the misses, `""` when every job hit.
fn plan_response(idx: &PlanIndex, cache: &JobCache, route: &RouteRecord, base: MapInner, bytes: &[u8]) -> Option<(PlannedCall, String)>;
/// The worker-thread half of a planned call (napi `planJobs(slot, len)`, Task 7). Runs on the
/// worker's JS thread, synchronously inside its call for `slot`. Never panics out, never errs:
/// every failure is `PLAN_DECLINED` and leaves no plan behind.
pub fn plan_in_call(s: &Server, worker: u32, slot: u32, len: u32) -> String;
```

- [ ] **Step 1: Failing tests** (`pipeline.rs` tests; `manifest()` = the fixture manifest helper at :1994):
```rust
fn base(name: &str) -> MapInner { /* {"params": {"name": name}, "path": "/pokemon/<name>"} as page builds it (:316-327) */ }
fn r2(m: &Manifest) -> &RouteRecord { m.routes.iter().find(|r| r.id == "r2").unwrap() }
const PIKACHU: &[u8] = br#"{"ok":true,"data":{"pokemon":{"name":"pikachu","stats":{"hp":35},"moves":[{"name":"tackle"},{"name":"growl"}]}},"headers":{"x-a":"1"}}"#;

#[test]
fn plan_response_plans_like_page_and_returns_the_misses_request() {
    let m = manifest(); let idx = PlanIndex::new(&m).unwrap(); let cache = JobCache::new(64);
    let (pc, misses) = plan_response(&idx, &cache, r2(&m), base("pikachu"), PIKACHU).unwrap();
    // Same ctx and plans as the declined path: merge_loader_data + collect_jobs over it.
    let mut want = base("pikachu");
    merge_loader_data(&mut want, Node::from(json!({"pokemon":{"name":"pikachu","stats":{"hp":35},"moves":[{"name":"tackle"},{"name":"growl"}]}})), "r2");
    let want = Node::map(want);
    assert_eq!(pc.ctx, want);
    let plans = collect_jobs(&idx, &r2(&m).chain, &want).unwrap();
    assert_eq!(misses, serde_json::to_string(&jobs_request(&plans, &[0, 1, 2])).unwrap());
    assert_eq!(pc.call_ids, ["detailPage_c3/j0", "detailPage_c3/moveCard_d4_1/j0/0", "detailPage_c3/moveCard_d4_1/j0/1"]);
    assert_eq!(pc.lookup.misses, [0, 1, 2]);
    assert_eq!(pc.headers.get("x-a").map(String::as_str), Some("1"));
}
#[test]
fn plan_response_pins_hits_and_answers_empty_when_all_hit() { /* warm the cache with the 3 keys; misses == ""; lookup.values all Some; then invalidate_tags(["moves"]) → the pinned Arcs are still there (values[1..3] Some) */ }
#[test]
fn plan_response_dedupes_identical_keys_like_lookup_jobs() { /* moves [{tackle},{tackle}]: owner = [0,1,1], misses = [0,1], the request JSON has 2 calls */ }
#[test]
fn plan_response_declines_what_is_not_ok_data() {
    let m = manifest(); let idx = PlanIndex::new(&m).unwrap(); let cache = JobCache::new(8);
    for bad in [&br#"{"verdict":"notFound","data":{}}"#[..], br#"{"error":"x"}"#, br#"{"ok":false,"data":{}}"#, br#"{"error":"response too large: 300000 > 262144"}"#, b"not json"] {
        assert!(plan_response(&idx, &cache, r2(&m), base("p"), bad).is_none(), "{}", String::from_utf8_lossy(bad));
    }
    // A planning error (`[idx]` outside a row) declines too; page meets it after the call (500, "job planning failed").
}
#[test]
fn plan_in_call_declines_an_idle_slot_a_missing_seed_and_a_len_outside_the_slot() { /* Server from crate test helpers is heavy: use `start(config(fixture))` like tests/common (pipeline tests may call crate::server::start with the fixture dist), register MockDispatch::with_slots(1): idle slot → "!"; claim without put_plan → "!"; put Seed, len = cap + 1 → "!" and the cell holds nothing */ }
#[test]
fn plan_in_call_stores_the_plan_and_returns_the_misses() { /* claim, put PlanCell::Seed, copy PIKACHU into buf_slot, plan_in_call(&s, id, slot, len) == misses JSON; claim.take_plan() downcasts to PlanCell::Planned with 3 rows */ }
```
Red: nothing exists.

- [ ] **Step 2: Implement `plan_response`.**
```rust
fn plan_response(idx: &PlanIndex, cache: &JobCache, route: &RouteRecord, mut base: MapInner, bytes: &[u8]) -> Option<(PlannedCall, String)> {
    let LoaderResponse::Ok { ok: true, data, headers } = serde_json::from_slice::<LoaderResponse>(bytes).ok()? else { return None };
    merge_loader_data(&mut base, data, &route.id);
    let ctx = Node::map(base);
    let plans = collect_jobs(idx, &route.chain, &ctx).ok()?;
    let lookup = lookup_jobs(cache, &plans);
    let (misses, call_ids) = if lookup.misses.is_empty() {
        (String::new(), Vec::new())
    } else {
        let req = jobs_request(&plans, &lookup.misses);
        let ids = req.jobs.iter().map(|c| c.id.clone()).collect();
        (serde_json::to_string(&req).ok()?, ids)
    };
    let rows = plans.iter().map(JobPlan::to_row).collect();
    Some((PlannedCall { ctx, headers, rows, lookup, call_ids }, misses))
}
```
(`lookup_jobs` counts job-cache hits/misses exactly once per plan, as today — the declined path does not run it again because the cell is empty only when nothing was planned.)

- [ ] **Step 3: Implement `plan_in_call`.**
```rust
pub fn plan_in_call(s: &Server, worker: u32, slot: u32, len: u32) -> String {
    let declined = || PLAN_DECLINED.to_string();
    let Some(entry) = s.pool.entry(worker) else { return declined() };
    let Some(cell) = entry.claimed_plan_cell(slot) else { return declined() };
    let seed = match cell.lock().take().map(|b| b.downcast::<PlanCell>()) {
        Some(Ok(b)) => match *b { PlanCell::Seed(seed) => seed, PlanCell::Planned(_) => return declined() },
        _ => return declined(),
    };
    let (ptr, cap) = entry.dispatch.buf_slot(slot);
    if len == 0 || len as usize > cap { return declined() }
    // SAFETY: we run on the worker's JS thread, synchronously inside its call for `slot` (the slot is
    // claimed: `claimed_plan_cell` returned it): the worker wrote these `len` bytes on this thread just
    // before calling `planJobs`, and nothing else writes a claimed slot. `len` is bounds-checked above.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
    let Some(route) = s.manifest.routes.get(seed.route) else { return declined() };
    let planned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        plan_response(&s.plans, &s.jobs, route, seed.base, bytes)
    }));
    match planned {
        Ok(Some((plan, misses))) => {
            *cell.lock() = Some(Box::new(PlanCell::Planned(plan)));
            misses
        }
        _ => declined(),
    }
}
```
`lib.rs`: `pub use pipeline::{PLAN_DECLINED, plan_in_call};` (`mod pipeline` stays private). `cargo test -p brust-server pipeline::` green; clippy clean.

- [ ] **Step 4: Commit** `feat(server): plan_in_call — plan a page on the worker thread from the slot bytes (M3-P P6)` (files: `pipeline.rs`, `lib.rs`).

### Task 6: `page()` — the planned arm, the declined fallback, counters, the FakeBun protocol

**Files:** Modify `crates/brust-server/src/pipeline.rs` (`page` :308-517 only, see Global Constraints), `crates/brust-server/src/config.rs` (`Stats` :136-148, `Server` :160-162, `stats()` :234-243), `crates/brust-server/src/server/mod.rs` (:114-116, `Server::plan_cells_in_use`), `crates/brust-server/tests/common/fake_bun.rs`, `crates/brust-server/tests/common/mod.rs` (`boot` :93, `boot_with` :98, `boot_in` :107), `crates/brust-server/tests/logging.rs` (:53), `crates/brust-server/tests/fake_bun.rs`; create `crates/brust-server/tests/single_roundtrip.rs`.

**Interfaces:**
```rust
// config.rs
pub struct Stats { …, /// Job batches the worker ran: a `jobs` call, or the misses of a planned loader call (M3-P P6).
    pub job_calls: u64, /// Worker round trips (M3-P P6): the sum of every request's `bun_calls`.
    pub worker_calls: u64, … }
// server/mod.rs
impl Server { #[doc(hidden)] /// Slots whose plan cell holds something (tests: 0 when idle).
    pub fn plan_cells_in_use(&self) -> usize; }
// pipeline.rs
/// Validate, store and fan out the worker's `results` for `lookup.misses` — shared by the jobs
/// call and the planned loader call. `Err` = the 500 to send, already logged (today's messages).
fn apply_job_results(s: &Server, route: &RouteRecord, plans: &[JobPlan], lookup: &mut Lookup,
                     ids: &[&str], results: Vec<JobResult>) -> Result<(), Response<ResponseBody>>;
// tests/common/fake_bun.rs
impl FakeBun {
    /// Take the plan offer of `loader` requests (`plan: true`) like the real worker: write the
    /// loader response into the slot, `plan_in_call`, run the misses, answer `{planned, results}`.
    pub fn bind(&self, s: &Arc<Server>, worker: u32);
    /// Runs between `plan_in_call` and the reply (tests of the plan-to-render window).
    pub fn with_after_plan(self: Arc<Self>, f: impl Fn() + Send + Sync + 'static) -> Arc<Self>;  // Arc::into_inner, set, re-wrap
}
```

- [ ] **Step 1: Failing tests** — `crates/brust-server/tests/single_roundtrip.rs` (uses `mod common;`):
```rust
/// r2 MISS: loader + 3 job misses in ONE worker round trip.
#[test]
fn a_loader_page_with_job_misses_is_one_worker_call() {
    let f = fake(); let s = boot(f.clone());
    let (st, h, body) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!((st, cache_hdr(&h)), (200, Some("MISS")));
    assert!(body.contains("<p>HP 35</p>") && body.contains("<li>tackle: MOVE tackle</li><li>growl: MOVE growl</li>"), "{body}");
    assert_eq!(f.counts(), (1, 1), "one loader run, one job batch");
    let st = stats(&s);
    assert_eq!((st["loader_calls"].as_u64(), st["job_calls"].as_u64(), st["worker_calls"].as_u64()), (Some(1), Some(1), Some(1)));
    assert_eq!(f.last_loader().unwrap()["plan"], true);
    assert_eq!(s.plan_cells_in_use(), 0);
}
/// The same pages through a fake that ignores the offer (unbound) are byte-identical.
#[test]
fn planned_and_declined_pages_are_byte_identical() {
    for path in ["/", "/pokemon/pikachu", "/team", "/ids", "/nope"] {
        let (a, b) = (fake(), FakeBun::new(default_loader, default_jobs));   // fake() is bound by boot(); b is registered by hand, never bound
        let sa = boot(a.clone());
        let sb = start(config(&fx())).unwrap(); sb.register_worker(Box::new(FakeBunHandle(b.clone())));
        for round in 0..2 {
            let (ra, rb) = (get(&sa, path, &[]), get(&sb, path, &[]));
            assert_eq!((ra.0, ra.2.as_str()), (rb.0, rb.2.as_str()), "{path} round {round}");
            let strip = |h: &http::HeaderMap| { let mut h = h.clone(); h.remove("date"); h };
            assert_eq!(strip(&ra.1), strip(&rb.1), "{path} round {round}");
        }
        assert_eq!(a.counts(), b.counts(), "{path}: same loader runs and job batches");
        let wa = stats(&sa)["worker_calls"].as_u64().unwrap(); let wb = stats(&sb)["worker_calls"].as_u64().unwrap();
        assert!(wa <= wb, "{path}: planned {wa} ≤ declined {wb}");
    }
}
#[test]
fn verdicts_are_never_planned() {
    // redirect / httpError: one call, no jobs, as today (counts (1,0), worker_calls 1).
    // notFound renders the route's template at 404 and runs its jobs (S7 step 4): the worker plans only
    // `ok` data, so a notFound page keeps today's two-call path on a job miss — counts (1,1), worker_calls 2,
    // body byte-identical to the declined fake's. plan_cells_in_use() == 0 after each.
}
#[test]
fn no_loader_routes_keep_planning_in_rust() { /* "/" and "/ids": counts (0,0), worker_calls 0 (no plan offer, no call) */ }
#[test]
fn hits_pinned_at_plan_time_survive_an_invalidation_before_render() {
    // Warm r2's moveCard jobs (tag "moves"), then a page whose fake invalidates "moves" AFTER plan_in_call
    // returned "" (all hit) and BEFORE it replies: the page still renders the pinned values, no job ran;
    // the next page (another name, L1 miss) misses the moveCard jobs and runs one batch.
    let calls = Arc::new(AtomicU32::new(0));
    let srv: Arc<OnceLock<Arc<Server>>> = Default::default();
    let (c2, srv2) = (calls.clone(), srv.clone());
    let f = fake().with_after_plan(move || {
        if c2.fetch_add(1, Ordering::SeqCst) == 1 {
            srv2.get().unwrap().invalidate(InvalidateArgs { tags: vec!["moves".into()], ..Default::default() });
        }
    });
    let s = boot(f.clone()); srv.set(Arc::clone(&s)).ok();
    assert_eq!(get(&s, "/pokemon/pikachu", &[]).0, 200);                    // 1st: all miss, 1 batch
    let (_, _, body) = get(&s, "/pokemon/raichu", &[]);                        // 2nd: all hit; invalidated mid-call
    assert!(body.contains("<li>tackle: MOVE tackle</li>"), "{body}");
    assert_eq!(f.counts(), (2, 1), "the pinned hits were rendered, nothing re-ran");
    get(&s, "/pokemon/mew", &[]);                                               // 3rd: moveCard keys gone → 1 batch
    assert_eq!(f.counts(), (3, 2));
}
#[test]
fn a_late_planned_call_leaves_no_plan_behind() {
    // FakeBun::gated + bind, call_timeout 50 ms (boot_with): the page answers 504; after settle_all the
    // detached remainder drops the claim → plan_cells_in_use() == 0, stats timed_out_calls == 1.
}
```
`logging.rs:53`: `"route=r2 status=200 cache=MISS bun_calls=2"` → `bun_calls=1`. `tests/fake_bun.rs`: + `planned_loader_call_round_trips_through_call_worker_planned` (a bound fake over a real `start(config(&fx()))` server's pool is not reachable from the test — keep this one at the `Server` level: GET `/team` (r5, 1 ssr job) → `last_jobs()["jobs"][0]["target"] == "teamBuilder_h8"`, counts (1,1), worker_calls 1). `cargo test -p brust-server --test single_roundtrip --test logging` → red.

- [ ] **Step 2: Counters.** `config.rs`: `worker_calls` in `Stats` (after `job_calls`) and `pub(crate) worker_calls: AtomicU64` in `Server`; `stats()` reads it; `server/mod.rs` initialises it; `plan_cells_in_use` iterates `self.pool` entries' slots counting `plan.lock().is_some()` (add `pub(crate) fn entries(&self) -> Vec<Arc<WorkerEntry>>` to `WorkerPool` if none fits). In `page()`, every place that does `meta.bun_calls += 1` also does `s.worker_calls.fetch_add(1, Relaxed)`.

- [ ] **Step 3: `page()`.** (a) The `LoaderRequest` literal (:330) gets `plan: s.plans.chain_has_jobs(&route.chain),`. (b) The call (:336-343) becomes
```rust
        let seed: Option<PlanBox> = req.plan.then(|| -> PlanBox {
            Box::new(PlanCell::Seed(PlanSeed { route: ri, base: ctx.clone() }))   // params + path: two entries
        });
        let r = call_worker_planned::<_, LoaderResponse>(&s.pool, s.claim_timeout, s.call_timeout, CallKind::Loader, &req, seed).await;
        let (r, cell) = match r { Ok((v, c)) => (Ok(v), c), Err(e) => (Err(e), None) };
```
(c) A new first arm of the match:
```rust
            Ok(LoaderResponse::Planned { results }) => {
                let Some(PlanCell::Planned(pc)) = cell.and_then(|b| b.downcast::<PlanCell>().ok()).map(|b| *b) else {
                    tracing::error!(route = %route.id, "planned loader response without a plan in the slot");
                    return body::error_500();
                };
                planned = Some((pc, results));
            }
```
with `let mut planned: Option<(PlannedCall, Vec<JobResult>)> = None;` declared before the `if !route.loaders.is_empty()`. (d) After the loader block, replace `let mut ctx = Node::map(ctx);` + the `(5) jobs` section with:
```rust
    // ----- (5) jobs -----
    let (mut ctx, plans, mut lookup) = match planned {
        Some((pc, results)) => {
            for (k, v) in &pc.headers { if k.eq_ignore_ascii_case("set-cookie") { cacheable = false; } extra.push((k.clone(), v.clone())); }
            let plans = rehydrate(&s.plans, pc.rows);
            let mut lookup = pc.lookup;
            if !lookup.misses.is_empty() {
                s.job_calls.fetch_add(1, Ordering::Relaxed);
                let ids: Vec<&str> = pc.call_ids.iter().map(String::as_str).collect();
                if let Err(resp) = apply_job_results(s, route, &plans, &mut lookup, &ids, results) { return resp; }
            }
            (pc.ctx, plans, lookup)
        }
        None => {
            let ctx = Node::map(ctx);
            let plans = match collect_jobs(&s.plans, &route.chain, &ctx) { /* today's :418-424 */ };
            let mut lookup = lookup_jobs(&s.jobs, &plans);
            if !lookup.misses.is_empty() {
                /* today's jobs call :431-456 (counters: job_calls, worker_calls, bun_calls) */
                let ids: Vec<&str> = req.jobs.iter().map(|c| c.id.as_str()).collect();
                if let Err(resp) = apply_job_results(s, route, &plans, &mut lookup, &ids, resp.results) { return resp; }
            }
            (ctx, plans, lookup)
        }
    };
```
`apply_job_results` is today's :457-509 moved verbatim (labels → `plans[lookup.misses[k]]`, `results_in_request_order(ids, results)`, `check_value`, `note_missing_slots`, `s.jobs.insert`, owner fan-out on `lookup.values`); the `Missing` log names `ids[k]`. The planned loader response's headers are applied in the arm above because the loader's `Ok` arm (which applies them today) does not run on the planned path. (e) `(6)`: `merge_values(&mut ctx, &plans, &lookup.values);`. Nothing after :517 changes.

- [ ] **Step 4: FakeBun protocol.** `common/fake_bun.rs`: fields `bound: std::sync::OnceLock<(std::sync::Weak<Server>, u32)>` and `after_plan: Option<Box<dyn Fn() + Send + Sync>>`. In `call`, the reply bytes come from one `fn reply(&self, kind, req: Value, slot) -> Vec<u8>` evaluated where the bytes are written today (immediately, or inside the gated future after the gate opens):
```rust
let resp = respond(req.clone());
if kind == CallKind::Loader && req["plan"] == true && resp["ok"] == true
    && let Some((s, id)) = self.bound.get().and_then(|(w, id)| w.upgrade().map(|s| (s, *id)))
{
    let first = serde_json::to_vec(&resp).unwrap();
    self.write(slot, &first);
    let misses = brust_server::plan_in_call(&s, id, slot, first.len() as u32);
    if misses == brust_server::PLAN_DECLINED { return first; }
    let results = if misses.is_empty() { json!([]) } else {
        let jr: Value = serde_json::from_str(&misses).unwrap();
        self.job_calls.fetch_add(1, Ordering::SeqCst);
        *self.last_jobs.lock().unwrap() = Some(jr.clone());
        (self.jobs)(jr)["results"].clone()
    };
    if let Some(f) = &self.after_plan { f(); }
    return serde_json::to_vec(&json!({"planned": true, "results": results})).unwrap();
}
serde_json::to_vec(&resp).unwrap()
```
(the `jobs` kind keeps today's counting). `common/mod.rs`: `boot`, `boot_with`, `boot_in` do `let id = s.register_worker(Box::new(FakeBunHandle(Arc::clone(&fake)))); fake.bind(&s, id);`. Module doc: "counts are (loader runs, job batches) — a planned call counts one of each, as the two-call path did".
```bash
cargo test --workspace --exclude bun_react_compiler 2>&1 | grep -E 'test result|FAILED|panicked' | sort | uniq -c
git diff --stat crates/brust-server/tests/ | grep -v 'single_roundtrip\|common/\|logging\|fake_bun.rs'   # empty: no other existing test changed
git diff --quiet crates/brust-server/benches/fixtures && echo GOLDEN-UNCHANGED
```

- [ ] **Step 5: Commit** `perf(server): one worker round trip per loader page — planned call, declined fallback (M3-P P6)` (files: `pipeline.rs`, `config.rs`, `server/mod.rs`, `pool.rs` only if `entries()` was added, `tests/common/{fake_bun.rs,mod.rs}`, `tests/{logging.rs,fake_bun.rs,single_roundtrip.rs}`).

### Task 7: napi `planJobs` and the worker taking the offer

**Files:** Modify `crates/brust-napi/src/server.rs` (`register_worker` :113-140, new export), `packages/brust/src/native.ts` (:31-40, :58-64), `packages/brust/src/worker.ts` (`LoaderRequest` :11-16, `makeDispatch` :178-199, imports :6), tests `packages/brust/test/{worker.test.ts,napi-server.test.ts,e2e.test.ts}`.

**Interfaces:** napi: `planJobs(slot: number, len: number): string` — the misses' `JobsRequest` JSON, `""` (all hit) or `"!"` (declined). TS: `export type PlanJobs = (slot: number, len: number) => string`, `export const PLAN_DECLINED = '!'`, `makeDispatch(h: Handlers, view: Uint8Array, slots: number, plan: PlanJobs = planJobs)`; `LoaderRequest.plan?: boolean`.

- [ ] **Step 1: Failing TS tests** (`worker.test.ts`; `dec = (v, n) => JSON.parse(new TextDecoder().decode(v.subarray(0, n)))`):
```ts
const planned = (jobs: JobsModule) => makeHandlers({ leaves: leaves({ child: async () => ({ team: ['a'] }) }), jobs })
test('dispatch: a planned loader call hands the ctx to planJobs and answers the misses in the same call', async () => {
  const view = new Uint8Array(new SharedArrayBuffer(4096))
  const seen: unknown[] = []
  const plan = (slot: number, len: number) => {
    seen.push(dec(view.subarray(slot * 4096), len))          // the ctx is in the slot when planJobs runs
    return JSON.stringify({ jobs: [{ id: 'c/j0', componentId: 'c', kind: 'precompute', inputs: { team: ['a'] } }] })
  }
  const d = makeDispatch(planned({ c: { precompute: (p: { team: string[] }) => ({ _s1: p.team.length }) } }), view, 1, plan)
  const n = await d('loader', JSON.stringify({ ...ctx('r1'), plan: true }), 0)
  expect(seen).toEqual([{ ok: true, data: { team: ['a'] } }])
  expect(dec(view, n)).toEqual({ planned: true, results: [{ id: 'c/j0', value: { _s1: 1 } }] })
})
test('dispatch: planJobs "" (every job hit) answers {planned:true}', async () => { /* plan = () => '' → {planned:true} */ })
test('dispatch: planJobs "!" leaves the loader response in the slot', async () => { /* plan = () => PLAN_DECLINED → dec(view, n) == {ok:true,data:{team:['a']}} */ })
test('dispatch: verdicts, errors and plan:false never call planJobs', async () => { /* plan throws if called; notFound loader + plan:true, throwing loader + plan:true, ok + no plan → no call, today's bodies */ })
```
`napi-server.test.ts`, new test after the existing one (the existing handler ignores `plan` → it still proves the two-call path; add `expect(JSON.parse(cacheStats()).worker_calls).toBe(4)` at its end? No — keep it untouched and assert in the new test only):
```ts
test('a worker that takes the plan offer answers a loader page with misses in ONE call', async () => {
  startServer({ host: '127.0.0.1', port: 0, distDir: dist, workers: 1, claimTimeoutMs: 500 })
  const view = new Uint8Array(new SharedArrayBuffer(256 * 1024 * SLOTS))
  const kinds2: string[] = []
  const planning = async (kind: string, requestJson: string, slot: number) => {
    kinds2.push(kind)
    const req = JSON.parse(requestJson)
    const ctx = { ok: true, data: { pokemon: { name: req.params.name, stats: { hp: 35 }, moves: [{ name: 'tackle' }, { name: 'growl' }] }, team: ['a'], who: 'anon' } }
    const n = writeSlot(view, slot, SLOTS, JSON.stringify(ctx))
    expect(req.plan).toBe(true)
    const misses = planJobs(slot, n)                         // the real addon, on this (main) thread: registerWorker bound it
    if (misses === '!') return n
    const results = misses === '' ? [] : JSON.parse(misses).jobs.map((j: JobCall) => ({ id: j.id, value: jobValue(j) }))
    return writeSlot(view, slot, SLOTS, JSON.stringify({ planned: true, results }))
  }
  registerWorker(view, SLOTS, planning)
  await untilReady(2000)
  const base = `http://${localAddr()}`
  const b1 = await (await fetch(`${base}/pokemon/pikachu`)).text()
  expect(b1).toContain('<li>tackle: MOVE tackle</li><li>growl: MOVE growl</li>')
  expect(kinds2).toEqual(['loader'])
  expect(JSON.parse(cacheStats())).toMatchObject({ loader_calls: 1, job_calls: 1, worker_calls: 1 })
  await (await fetch(`${base}/pokemon/bulbasaur`)).text()     // L1 miss; every job hits → planJobs ""
  expect(kinds2).toEqual(['loader', 'loader'])
  expect(JSON.parse(cacheStats())).toMatchObject({ loader_calls: 2, job_calls: 1, worker_calls: 2 })
  await beginDrain(1000)
})
```
(import `planJobs` from `'../native/index.js'`). `e2e.test.ts`: `type Stats = { loader_calls: number; job_calls: number; worker_calls: number }` (:14) and after :93 `expect(s1.worker_calls - before.worker_calls).toBe(1) // loader + jobs in one round trip (M3-P P6)`. Red: `planJobs` missing, `makeDispatch` ignores `plan`.

- [ ] **Step 2: napi.** `crates/brust-napi/src/server.rs`:
```rust
thread_local! {
    /// The server and worker id registered from THIS thread (`register_worker`): a worker's
    /// `planJobs` runs on its own JS thread, so this is that worker's binding. The last
    /// registration on a thread wins (tests register several on the main thread); a stale or
    /// absent binding makes `plan_jobs` decline, which degrades to the two-call path.
    static BOUND: std::cell::RefCell<Option<(std::sync::Weak<Server>, u32)>> = const { std::cell::RefCell::new(None) };
}
```
`register_worker`: after `let id = s.register_worker(…)`: `BOUND.with_borrow_mut(|b| *b = Some((Arc::downgrade(&s), id)));`. Export:
```rust
/// M3-P P6: plan the calling worker's in-flight loader call for `slot` from the `len` bytes it
/// just wrote there. Returns the misses' `JobsRequest` JSON, `""` when every job hit, or `"!"`
/// (declined: answer with the loader response already in the slot). Sync, on the worker's JS
/// thread; never throws (a napi Error return is unreliable under Bun).
#[napi]
pub fn plan_jobs(slot: u32, len: u32) -> String {
    match BOUND.with_borrow(|b| b.as_ref().and_then(|(w, id)| w.upgrade().map(|s| (s, *id)))) {
        Some((s, id)) => brust_server::plan_in_call(&s, id, slot, len),
        None => brust_server::PLAN_DECLINED.to_string(),
    }
}
```
Module doc's export list gains `planJobs`. `native.ts`: `planJobs(slot: number, len: number): string` in `NativeBinding` (doc: "M3-P P6 — see crates/brust-napi/src/server.rs `plan_jobs`") and `export const planJobs = (slot: number, len: number): string => native().planJobs(slot, len)`.

- [ ] **Step 3: `worker.ts`.** `LoaderRequest` gains `/** M3-P P6: the chain has jobs — plan them in this call (`planJobs`). Optional to honour. */ plan?: boolean`. Add after `writeSlot`:
```ts
/** `planJobs` (napi): the misses' JobsRequest JSON, '' (every job hit) or PLAN_DECLINED. */
export type PlanJobs = (slot: number, len: number) => string
/** `planJobs` declined: the loader response already in the slot is the answer (Rust plans after the call). */
export const PLAN_DECLINED = '!'
const PLANNED = { planned: true } as const

function toJson(out: unknown): string {
  try { return JSON.stringify(out) } catch (e) { return JSON.stringify({ error: `response not serialisable: ${String(e)}` }) }
}
```
`makeDispatch(h, view, slots, plan: PlanJobs = planJobs)` (import `planJobs` from `./native`, lazy: the addon is touched only when a request carries `plan: true`):
```ts
  return async (kind: string, requestJson: string, slot: number): Promise<number> => {
    let out: unknown
    try {
      const req = JSON.parse(requestJson)
      if (kind === 'loader') {
        out = await h.loader(req)
        if (req.plan === true && (out as { ok?: unknown }).ok === true) {
          // One round trip (M3-P P6): the ctx goes to Rust through this slot, synchronously, and only
          // the jobs Rust found missing run here; the final answer replaces it in the same slot.
          const json = toJson(out)
          const n = writeSlot(view, slot, slots, json)
          const misses = plan(slot, n)
          if (misses === PLAN_DECLINED) return n
          out = misses === '' ? PLANNED : { planned: true, results: (await h.jobs(JSON.parse(misses))).results }
        }
      } else if (kind === 'jobs') out = await h.jobs(req)
      else out = { error: `unknown call kind ${kind}` }
    } catch (e) {
      out = { error: String(e) }
    }
    return writeSlot(view, slot, slots, toJson(out))
  }
```
(A non-serialisable ok response writes the `response not serialisable` error first; Rust's `plan_response` declines it and `page()` answers it as today.)
```bash
cd packages/brust && bun run build:debug && bun run typecheck && bun test test/worker.test.ts && bun test test/napi-server.test.ts && bun test --timeout 120000 test/e2e.test.ts && cd ../..
cd packages/brust && bun run build && cd ../.. && $OUT/snap.sh t7 && $OUT/cmp.sh before t7     # IDENTICAL ×4
```

- [ ] **Step 4: Full TS gate list** (Global Constraints, TS lines) green.

- [ ] **Step 5: The unbound thread declines.** Add to `worker.test.ts`: `test('planJobs on a thread that registered no worker declines', …)` — spawn a Bun `Worker` from an inline module that imports `../native/index.js` and posts `planJobs(0, 10)`; expect `'!'`. (No skip: the gate builds the addon first, as for `napi-server.test.ts`.)

- [ ] **Step 6: Commit** `perf(worker): take the plan offer — planJobs on the worker thread, misses in the same call (M3-P P6)` (files: `crates/brust-napi/src/server.rs`, `packages/brust/src/{native.ts,worker.ts}`, `packages/brust/test/{worker.test.ts,napi-server.test.ts,e2e.test.ts}`).

### Task 8: Stress — 8 worker threads plan while tokio inserts and invalidates

**Files:** Modify `crates/brust-server/tests/single_roundtrip.rs`.

**Interfaces (test-local):** `ThreadWorker` — a `RenderDispatch` backed by its own OS thread (like a Bun Worker): `call()` sends `(kind, json, slot, oneshot::Sender<u32>)` over a `std::sync::mpsc` channel and returns a future awaiting the oneshot; the thread computes the reply (planned protocol of Task 6 Step 4, calling `brust_server::plan_in_call` FROM THAT THREAD), writes its leaked 2-slot buffer, sends the length. Binding `Arc<OnceLock<(Weak<Server>, u32)>>` set after `register_worker`.

- [ ] **Step 1: The test**
```rust
/// 8 worker threads × 1000 pages: `plan_in_call` reads the job cache from 8 OS threads while
/// tokio inserts results and a task invalidates the "moves" tag every millisecond. Every page
/// must render the values of ITS OWN inputs (no torn or crossed entries), no call may fail, and
/// no plan may be left in a slot.
#[test]
fn eight_workers_plan_while_tokio_inserts_and_invalidates() {
    const WORKERS: usize = 8; const PAGES: usize = 1000; const NAMES: usize = 40;
    let hp = |i: usize| 10 + (i * 7919) % 90;                       // per-name stats → per-name detailPage key
    // loader: {"ok":true,"data":{"pokemon":{"name":n,"stats":{"hp":hp(i)},"moves":[{"name":"m-<n>-a"},{"name":"m-<n>-b"}]}}}
    // jobs:   detailPage_c3/j0 → {"_s1": "HP <inputs.pokemon.stats.hp>"}; moveCard_d4 → {"_s1": "MOVE <inputs.move.name>"}
    let s = start(Config { expected_workers: WORKERS as u32, ..config(&fx()) }).unwrap();
    for _ in 0..WORKERS { /* register a ThreadWorker, bind it */ }
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(4).enable_all().build().unwrap();
    rt.block_on(async {
        let stop = Arc::new(AtomicBool::new(false));
        let inv = { /* spawn: while !stop { s.invalidate(tags ["moves"]); sleep(1 ms) } */ };
        // 64 concurrent clients, WORKERS*PAGES requests total: GET /pokemon/n<i % NAMES>?q=<k> (unique query → L1 MISS)
        // each asserts 200, "<p>HP {hp(i)}</p>", "<li>m-n<i>-a: MOVE m-n<i>-a</li><li>m-n<i>-b: MOVE m-n<i>-b</li>"
        stop.store(true, Ordering::SeqCst); inv.await.unwrap();
    });
    let st = stats(&s);
    assert_eq!(st["loader_calls"], (WORKERS * PAGES) as u64);
    assert_eq!(st["worker_calls"], (WORKERS * PAGES) as u64, "every page is one round trip");
    assert!(st["job"]["hits"].as_u64().unwrap() > 0 && st["job"]["misses"].as_u64().unwrap() > 0, "{st}");
    assert_eq!(s.plan_cells_in_use(), 0);
}
```
Write the client with the `hyper::client::conn::http1` pattern of `common::request`, one connection per client task, `tokio::sync::Semaphore(64)` or 64 tasks each doing `WORKERS*PAGES/64` requests.
```bash
cargo test -p brust-server --release --test single_roundtrip -- --nocapture eight_workers   # green; note the wall time
cargo test -p brust-server --test single_roundtrip                                          # debug, whole file green
```

- [ ] **Step 2: Commit** `test(server): 8 worker threads plan while tokio inserts and invalidates (M3-P P6)`.

### Task 9: Measure after P6 — refresh the attribution patch, bench, attribution, snaps

**Files:** Modify `bench/attribution.patch`, `bench/attribution.ts` (TREE rows).

- [ ] **Step 1: Re-instrument for the new code** (same stage ids where the code is the same; new ids for the planned path):
  - `perf.rs` `stages!`: add `PLAN_IN_CALL = 44, PIC_COLLECT = 45, PIC_LOOKUP = 46` and `CW_JS_PLAN = 78, CW_JS_JOBS = 79`.
  - `pipeline.rs`: `PLAN_IN_CALL` around the body of `plan_in_call` (recorded on the worker thread — perf accumulators are per thread, summed by `/_brust/perf`); inside `plan_response`, `PIC_COLLECT` around `collect_jobs`, `PIC_LOOKUP` around `lookup_jobs` (NOT `COLLECT_JOBS`/`JOB_LOOKUP`: those are level-1 stages summed into "unattributed", and `plan_in_call` runs inside `CW_DISPATCH`); `COLLECT_JOBS`/`JOB_LOOKUP`/`JOBS_CALL` stay on the declined path; `MERGE_RESULTS`/`SEED` unchanged.
  - `dispatch.rs`: the `CW_*` hunk now lives in `call_worker_planned` (same ids); the JS tail grows to 10 f64 (80 bytes at `slot*sub + sub - 80`): magic 7.5, entry, parse, handler (loaders only), plan (`writeSlot` #1 + `planJobs`), jobs (`h.jobs` on misses), stringify, write, total, exit → `CW_JS_PLAN`, `CW_JS_JOBS` added to the read.
  - `worker.ts` hunk: timestamps around `writeSlot`+`plan(…)` and around `h.jobs(…)` in the planned branch.
  - `attribution.ts` TREE (:98-133): under `CW_JS_TOTAL` add `[4, 'CW_JS_PLAN', 'planJobs (ctx write + Rust plan on this thread)']`, `[5, 'PLAN_IN_CALL', 'plan_in_call (Rust)']`, `[6, 'PIC_COLLECT', 'collect_jobs (worker thread)']`, `[6, 'PIC_LOOKUP', 'job cache lookups (worker thread)']`, `[4, 'CW_JS_JOBS', 'missed jobs (same call)']`; relabel `CW_JS_HANDLER` → `chain loaders`.
```bash
cargo check -p brust-server && git add -N crates/brust-server/src/perf.rs && git diff -- Cargo.lock crates/ packages/brust/src/worker.ts > $OUT/attribution.patch.new && git reset -q crates/brust-server/src/perf.rs
bun check -p bench && bun build --no-bundle bench/attribution.ts > /dev/null && echo TS-OK
cd packages/brust && bun run build && cd ../..
BRUST_RELEASE_ADDON=1 BENCH_CONN=120,1 ATTR_SIDES=v2 ATTR_APP=bench ATTR_PROBES=D,I,M ATTR_OUT=$OUT/attr-after-bench.json BENCH_LOCK_WS=<ws> BENCH_LOCK_ID='m3p-d-single-roundtrip Dew' bun $OUT/locked.ts | tee $OUT/attr-after-bench.txt
BRUST_RELEASE_ADDON=1 BENCH_CONN=120,1 ATTR_SIDES=v2 ATTR_OUT=$OUT/attr-after-pokedex.json BENCH_LOCK_WS=<ws> BENCH_LOCK_ID='m3p-d-single-roundtrip Dew' bun $OUT/locked.ts | tee $OUT/attr-after-pokedex.txt
git checkout -- Cargo.lock crates/ packages/brust/src/worker.ts && rm -f crates/brust-server/src/perf.rs
cp $OUT/attribution.patch.new bench/attribution.patch && git apply --check bench/attribution.patch && echo PATCH-OK
grep -rn '_brust/perf\|mod perf' crates/brust-server/src || echo no-perf-in-tree
cd packages/brust && bun run build && cd ../..
```
Expected: `M` shows no `jobs call_worker` row (JB_TOTAL gone), `planJobs` + `missed jobs` under the loader call; D identical tree (no plan offer: `dexPage` has no jobs); I shows `planJobs` ≈ 1-3 µs and `COLLECT_JOBS`/`JOB_LOOKUP` moved into `PIC_*`; `CW_RESP_BYTES` on I 71 → 16 (`{"planned":true}`).

- [ ] **Step 2: Bench (after)** — Task 1 Step 5 commands with `tee $OUT/bench-after.txt`, `cp bench/RESULTS.json $OUT/RESULTS-after.json`, revert RESULTS. Snaps: `$OUT/snap.sh after && $OUT/cmp.sh before after` → `IDENTICAL` ×4.

- [ ] **Step 3: Note** — paste, before → after with Δ: D/I rps/p50/p99 (expected within run-to-run noise, E1), M rps/p50/p99 and the stage table side by side for D, I, M at c=120 and c=1: `SVC_TOTAL`, `CW_TOTAL`, `BRIDGE`, `CW_JS_TOTAL`, `CW_JS_HANDLER`, `CW_JS_PLAN`, `PLAN_IN_CALL`, `CW_JS_JOBS`, `CW_READ_PARSE`, `COLLECT_JOBS`, `JOB_LOOKUP`, `JB_TOTAL`, `RENDER_CHAIN`, `unattributed`, `CW_RESP_BYTES`, CPU µs/req; pokedex B/C `SVC_TOTAL`/rps. Expected on M c=1: `SVC_TOTAL` −(15-20) µs (one bridge round trip, E7). If D or I regress beyond noise (> 2% rps on two consecutive runs), STOP and challenge the lead with both trees before Task 10.

### Task 10: Gates, merge order, RESULTS, READY

**Files:** Modify `bench/RESULTS.md`, `bench/RESULTS.json`, `bench/attribution.patch` (from Task 9).

- [ ] **Step 1: Merge order.** `git fetch origin && git log --oneline lane/m3p-d-single-roundtrip..origin/m3p` — if it lists m3p-c's merge, `git merge origin/m3p` (textual conflicts expected only at `page()`'s `// ----- (4) loader -----` boundary — m3p-c's inserted `let envelope = …` line next to this lane's loader-block edits — and in the `use` block: keep both sides), regenerate `bench/attribution.patch` on the merged tree (Task 9 Step 1 procedure, no new stage ids), then `cargo test -p brust-server` and Task 9 Step 2's snaps again; note it.

- [ ] **Step 2: Full gate list** (every line of Global Constraints, in order; paste the `test result` lines):
```bash
cargo fmt --all -- --check
cargo clippy -p brust-compiler -p brust-compiler-cli -p brust-jinja -p brust-server -p brust-napi --no-deps -- -D warnings
cargo clippy -p brust-compiler --no-deps -- -D warnings
cargo test --workspace --exclude bun_react_compiler 2>&1 | grep -E 'test result|FAILED' | sort | uniq -c
cargo test -p brust-jinja 2>&1 | grep -E 'test result'
cargo test -p brust-compiler 2>&1 | grep -E 'test result'
cargo test -p brust-server --release --test single_roundtrip -- --nocapture 2>&1 | grep -E 'test result|eight_workers'
cargo test -p brust-server --test inputs job_keys_are_pinned 2>&1 | grep -E 'test result'
cargo bench -p brust-server --bench render --no-run && cargo bench -p brust-jinja --bench json_attr --no-run
cd packages/brust && bun run build:debug && bun run typecheck && bun test test/routes.test.ts test/cache.test.ts test/worker.test.ts test/config.test.ts test/napi-compile.test.ts test/build-compile.test.ts && bun test test/napi-server.test.ts && bun test test/build-manifest.test.ts && bun test test/cli.test.ts && bun test --timeout 120000 test/e2e.test.ts && cd ../..
cd examples/pokedex && bun test && bun run typecheck && cd ../..
bun test --timeout 120000 tests/server/pokedex.test.ts
bun test --timeout 120000 tests/server/hydrate.chromium.test.ts
bun check -p bench && bun build --no-bundle bench/run.ts > /dev/null && bun test bench/lib && (cd bench/apps/brust && bun test)
git diff --quiet crates/brust-server/benches/fixtures && echo GOLDEN-UNCHANGED
```

- [ ] **Step 3: Regenerate RESULTS with every app** (the only committed bench run):
```bash
cd packages/brust && bun run build && cd ../..
BRUST_RELEASE_ADDON=1 BRUST_01X_DIR=$BRUST_01X_DIR BENCH_LOCK_WS=<ws> BENCH_LOCK_ID='m3p-d-single-roundtrip Dew' bun run bench | tee $OUT/bench-final.txt
git status --short      # bench/RESULTS.md, bench/RESULTS.json, bench/attribution.patch — nothing else
git add bench/RESULTS.md bench/RESULTS.json bench/attribution.patch
git commit -m "bench: results after M3-P P6; attribution.patch for the planned loader call

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline m3p..HEAD     # 9 commits (+ a merge of origin/m3p if m3p-c landed first)
```

- [ ] **Step 4: READY note** (Conclave task; the lead merges into `m3p`):
```
READY lane/m3p-d-single-roundtrip @ <sha>  (base m3p @ <sha>; merged origin/m3p @ <sha>: yes/no)
design: R1 planned loader call — keys stay inputs::job_key (blake3, Rust); planJobs(slot,len) on the worker thread; plan state in the claimed slot; offer may be declined/ignored → two-call fallback
| probe (identity, oha -c 120 -z 10s) | before | after | Δ | 0.1.x (same runs) |
| D /dex?nocache=1 rps / p50 / p99 | … | … | …% | … |
| I /team?nocache=1 rps / p50 / p99 | … | … | …% | … |
| M /team?nocache=1&start=<rand> (attribution run) rps / p50 / p99 | … | … | …% | — |
bar F68 line from the final RESULTS.md: D …%  I …%  → MET / NOT MET     load at start of each run: …
bun_calls: M 2 → 1 (JB_TOTAL 1.00 → absent); D 1 → 1; I 1 → 1; HIT 0
attribution (µs/req, c=120 | c=1): D SVC_TOTAL …→…; I SVC_TOTAL …→…, CW_JS_PLAN …, PLAN_IN_CALL …, CW_RESP_BYTES 71→16; M SVC_TOTAL …→…, BRIDGE …→…, JB_TOTAL …→0, CW_JS_JOBS …; pokedex B/C SVC_TOTAL …→…
stress: 8 × 1000 pages, invalidation every 1 ms, <wall> s release, 0 plan cells left; 20 pinned keys green; golden unchanged
byte-identical: snap before/t7/after → IDENTICAL ×4; planned_and_declined_pages_are_byte_identical green
gates: <test result lines>      guard: no perf in tree; attribution.patch applies on HEAD
follow-ups: a plan-offer flag per route at boot (chain_has_jobs is O(chain) per request); `CachedEntry.ctx` dead weight (m3p-b follow-up); P7 planned from this attribution
```

## Appendix A — what changes if the lead rules for §3 as written (R1 = no)

The plan above is replaced in Tasks 4-7; Tasks 1-3, 8-10 keep their shape. Deltas (each one is a reason R1 recommends against it):
1. **Keys move to TS** (`packages/brust/src/job-key.ts`): canonical JSON writer (sorted keys by UTF-16 order, `JSON.stringify` number text — `1e+21`, not ryu's `1e21`; unrepresentable u64 lose precision), length-prefixed `cid`/`jid`, **sha256** via `Bun.CryptoHasher.hash` (no blake3 in Bun; never wyhash/xxh3 — 64-bit, attacker-collidable from request-derived inputs = cache poisoning). Measured cost on the worker thread (E5): +0.5 µs per small key, +115 µs for a `"*"` input over a D-size context. `inputs::job_key`, `plan_key` and their tests are deleted; `plan-golden.json`'s `key` fields are rewritten; the 20-key fixture becomes a TS test.
2. **Plan not on the wire:** the worker builds its plan index from the `manifest.json` it already loads (`worker.ts:227`) — the "sent by id after first call" cache is unnecessary state; TS must reimplement `Path`, `Projection`, `PropsMap`, per-row/child enumeration, `cache.key`, `"*"` (≈ 400 lines of TS, a second walk to keep in step with Rust's `Dest` walk).
3. **`jobLookup(keys) → bitmask` has a hit-then-gone window** (TTL expiry, capacity eviction or `cacheInvalidate` between the lookup and Rust's read). Closing it needs the same claim-scoped cell (Task 2) to pin the hit `Arc`s — i.e. this plan's seam anyway; otherwise a third round trip or a 500.
4. **No-loader routes regress 0 → 1 call** on an all-hit page (Rust no longer has keys), unless Rust keeps a key implementation (two implementations, which §3 forbids).
5. **FakeBun needs a Rust port of the TS key** to drive 33 count assertions — a second implementation in test code; or every Rust integration test that has jobs moves to TS.
6. **Gain on the bench is the same as R1's** (E1: zero on D/I, one round trip on M), at a higher CPU cost on the scarce worker threads.
Effort: +2 tasks (TS key + TS planner), ≈ +700 lines, a rewritten golden.

## Self-review

**Spec coverage.**
- §3.1 "one `WorkerFn` call per page; envelope = `LoaderRequest` + plan" → Tasks 3 + 6 (`plan: true` offer; the plan itself never travels because Rust owns it — E6, R1). §3.2 "worker computes job keys; `plan_key` deleted" → NOT done by ruling R1: keys stay in Rust and run on the worker thread inside the call (one implementation, Task 5); Appendix A states the literal alternative. §3.3 "`native.jobLookup` sync napi export reading the SAME moka job cache" → `planJobs(slot, len)` (Task 7) reads the same `JobCache` (`plan_response` → `lookup_jobs`) and pins hits instead of returning a bitmask (Review Focus 4). §3.4 "worker runs misses only; Rust inserts with tags, merges, renders unchanged" → Tasks 6/7 (`apply_job_results` = today's insert with `tags`/`ttl`/`user_key`; render untouched). §3.5 "`bun_calls` on D/I becomes 1; L1 HIT 0" → D/I already 1 (E1); `M` 2 → 1 (Task 9); HIT 0 (`logging.rs`). §3 risks: key format change → none (keys unchanged, 20 pinned + golden); concurrent lookup vs tokio inserts → Task 8 (8 × 1000, plus invalidation); key parity → one implementation + `job_keys_are_pinned` + `rehydrated_plans_describe_like_collected_plans`.
- §2 per-lane rule (byte-identical, gates, D/I before/after + attribution diff, RESULTS regenerated) → Global Constraints, Tasks 1/9/10. §4 lane row (Dew, complex/complex, Mellow) → Dispatch table. §5 stop rule → Task 9 Step 3 (regression stop) and the note's numbers; the lead applies "two consecutive levers < 2%" with D/I Δ. §7 integration branch, no PR → Global Constraints. Lead's concurrency ruling with m3p-c → Global Constraints + Task 10 Step 1.
- "Spec amendments before the lane starts" → `docs/plans/2026-10-10-m3p-d-spec-amendment.draft.md` (S1 call table, S6, S7 steps 4-5, §7 stats/log), for the lead to rule and paste.

**Risk ledger.**
1. **Gain invisible on the committed bench** (E1). Mitigation: probe `M` (R5) measures the page shape P6 changes; acceptance on D/I is neutrality. If the lead rules P6 out instead, nothing here is needed (the stop rule's "two levers < 2%" counts it as 0).
2. **Worker-thread CPU.** On an all-hit page with jobs (I), parse + `collect_jobs` + `lookup_jobs` move from tokio to the Bun worker thread (~1-2 µs on I, ~25 µs on pokedex C with 22 keys) plus one sync napi call; total CPU is unchanged, distribution shifts toward the scarcer pool. D is untouched (no offer). Measured in Task 9 (`CW_JS_PLAN`, per-thread CPU line); a regression stops the lane.
3. **Unsafe slot read on the worker thread.** Same-thread write→read, claimed slot, bounds check, idle-slot refusal (Review Focus 2); tested through the real addon and real Workers.
4. **Plan cell leaks or cross-talk.** Claim-scoped by construction (`RenderClaim::drop` clears); late settle, decline, verdict and stress paths assert `plan_cells_in_use() == 0`.
5. **Merge conflict with m3p-c.** Adjacent hunks at the `(4) loader` boundary and the `use` block, plus both lanes' `attribution.patch`; boundaries match m3p-c's plan; whoever merges second merges `origin/m3p`, regenerates the patch and re-runs the gates.
6. **notFound pages keep two calls on a job miss.** The worker plans only `ok` data (one condition in `makeDispatch`, one in `plan_response`); a `notFound` verdict that renders a template with missing jobs takes the declined path (pinned by `verdicts_are_never_planned`). Planning it too would need the verdict status in `PlannedCall` — a follow-up if a probe ever shows it.
7. **`planJobs` failure modes under Bun.** Never throws; every failure declines to the two-call path (tested: idle slot, no seed, bad len, non-ok bytes, unbound thread).
8. **Attribution double counting.** Worker-thread stages get their own ids nested under `CW_JS_TOTAL` (Task 9 Step 1) so "unattributed" stays meaningful; the refreshed patch is checked with `git apply --check`.
