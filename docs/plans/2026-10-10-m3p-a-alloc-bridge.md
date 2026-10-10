# m3p-a-alloc-bridge — P0 mimalloc + P5 bridge/response allocations

owner: 22499151-e133-4508-b358-d7fa4d2851c3 · authority: in-loop · base: m3p · escalation: lead Detoro via task challenge

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land levers P0 and P5 of the M3-P spec on lane `lane/m3p-a-alloc-bridge` (from `m3p`): (P0) `mimalloc` becomes the addon's `#[global_allocator]`; (P5) the per-call `kind_str(kind).to_string()`, the per-call `tokio::spawn` in `call_worker`, the `HeaderMap` clone in `page_response` and the double re-index of job results are removed. Every rendered byte and every response header stays identical; the slot-claim / call-deadline semantics of `call_worker` stay exactly what `pool.rs` and the m2b2 tests demand. Each lever is measured separately (pokedex bench probes B and C, identity, plus the attribution stage tree) and the numbers go in the task note; `bench/RESULTS.md` is regenerated once, at the end.

**Architecture:** Three independent edits. (1) P0 is NOT a one-line dependency add: the addon today links a *fake* mimalloc — `crates/brust-compiler/src/parse/stubs/native.rs` (a verbatim Bun file) defines 24 `#[no_mangle] mi_*` functions over libc, gated on `cfg(not(bun_sema_mimalloc))`, and `bun_alloc`/`bun_mimalloc_sys` call them by `extern "C"` name. Linking the real `libmimalloc-sys` next to those fakes duplicates `mi_malloc`/`mi_free`/… at link time. So P0 = a `brust-compiler` feature `real-mimalloc` whose `build.rs` emits `--cfg bun_sema_mimalloc` (the switch the verbatim file already honours), four tiny Rust stubs for the Bun-fork-only hooks upstream mimalloc lacks, and `#[global_allocator] static GLOBAL: mimalloc::MiMalloc` in `crates/brust-napi/src/lib.rs`; the parser's arenas and every Rust allocation then share one real mimalloc. (2) P5-bridge: the tsfn argument tuple carries `&'static str` for the kind; `call_worker` awaits the dispatch future inline inside a `Detach` wrapper that only `tokio::spawn`s the *remainder* when the caller stops polling (deadline or client disconnect) and catches a panic so the caller still gets `BadResponse` — the claim is released exactly when the worker settles, as today. (3) P5-response: `page_response` takes the response `HeaderMap` by value (built once; the L1 entry gets a clone only when the render is actually stored), and job results are re-indexed through ONE `call id → position` map by a pure helper with unit tests for ordering/duplicates/unknown/missing.

**Tech Stack:** Rust nightly-2026-09-15 (`rust-toolchain.toml`), napi-rs 3.14 (`ToNapiValue for &str` exists; `FnArgs` tuples accept it), tokio (`time`, `rt`), `mimalloc` 0.1.52 → `libmimalloc-sys` 0.1.49 (mimalloc v3 by default; `cc`-built `static.c`; `links = "mimalloc"`), Bun canary for the TS gates, `oha` for the bench.

**Spec:** `docs/design/2026-10-10-m3-perf-bench-design.md` §0 (goal, bar), §2 rows P0 and P5, §4 (lane row `m3p-a-alloc-bridge`, routine / standard review), §5 (stop rule, acceptance), §7 (integration branch `m3p`, no per-lane PR).

## Global Constraints

- Lane: `cd /Users/detoro/code/brust-m3p && git worktree add ../brust-lane-m3p-a-alloc-bridge -b lane/m3p-a-alloc-bridge m3p` — all work in `/Users/detoro/code/brust-lane-m3p-a-alloc-bridge`; base is `m3p` (never `main`, never `v2`).
- NO PR. When done, post READY on the Conclave task with the numbers (Task 7 note); the lead merges into `m3p`.
- Output byte-identical before/after: `examples/pokedex` tests + `tests/server/pokedex.test.ts` green with no assertion change, AND the manual `curl` diff (Task 1 Step 6 script) of `/` and `/pokemon/pikachu` with `?nocache=1`, `Accept-Encoding: identity`, script hashes stripped, headers minus `date` — identical at every measurement point.
- Measure with `BRUST_RELEASE_ADDON=1 BRUST_01X_DIR=/private/tmp/claude-501/-Users-detoro-code-brust/d073159b-8c7b-466d-ae02-a02838faf58a/scratchpad/brust01x bun bench/run.ts` after `cd packages/brust && bun run build` (RELEASE addon). If the 0.1.x addon is missing: `cd $BRUST_01X_DIR/runtime && bun run build`. The load-average guard applies (run.ts exits 2 when 1-min load > cores): run when the machine is idle.
- Record before (baseline on m3p HEAD), after P0, and after P5 — THREE bench runs, each with the identity rps/p50/p99 for probes B and C — in the task note. `bench/RESULTS.md` + `RESULTS.json` are regenerated ONLY in Task 7; after the Task 1 and Task 3 runs, `git checkout -- bench/RESULTS.md bench/RESULTS.json`.
- Attribution: apply `bench/attribution.patch` (rebased in Task 1 — it does not apply to m3p HEAD today: 6 of 20 `pipeline.rs` hunks fail), rebuild the release addon, run `BRUST_RELEASE_ADDON=1 BENCH_CONN=120,1 ATTR_SIDES=v2 bun bench/attribution.ts` before P0, after P0 and after P5; paste the `CW_*` and `RENDER_CHAIN` deltas in the task note; then `git checkout -- Cargo.lock crates/ packages/brust/src/worker.ts` and rebuild the release addon.
- The applied patch must NEVER be in a commit. Before EVERY commit run the guard: `git diff --quiet crates/ packages/brust/src/worker.ts && echo clean` — commit only after `clean` (the guard also catches an unintended Cargo.lock edit when staged files are not what you meant). Committing the refreshed `bench/attribution.patch` FILE is fine and required.
- After ANY Rust edit, rebuild the addon before any TS test: `cd packages/brust && bun run build:debug` — a stale `.node` silently tests old code. The bench needs `bun run build` (release) instead.
- Never `git add -A` at the repo root; stage files by name.
- Every commit message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Gates (all green before each commit that touches code, and in full before READY): `cargo fmt --all -- --check` · `cargo clippy -p brust-compiler -p brust-compiler-cli -p brust-jinja -p brust-server -p brust-napi --no-deps -- -D warnings` · `cargo clippy -p brust-compiler --no-deps -- -D warnings` (feature OFF configuration, see Task 2) · `cargo test --workspace --exclude bun_react_compiler` · `cargo test -p brust-compiler` (feature OFF) · `cd packages/brust && bun run build:debug && bun run typecheck && bun test` · `cd examples/pokedex && bun test` · `bun test --timeout 120000 tests/server/pokedex.test.ts` · `bun test --timeout 120000 tests/server/hydrate.chromium.test.ts` (CI's server job in `.github/workflows/ci.yml` runs each server-starting file alone; do the same when a combined run flakes on a port).
- Do not re-decide: `mimalloc` crate latest 0.1.x with default features (= 0.1.52, mimalloc v3); `kind` crosses as `&'static str` (JS keeps `kind: string`); the claim/release and deadline semantics are the m2b2 ones (`docs/plans/2026-10-09-m2-call-deadline.md`): a claim is released only when the JS promise settles, never by the deadline; the late result is discarded.
- Boundary: `crates/brust-napi/{Cargo.toml,src/lib.rs,src/dispatch.rs,src/server.rs}`, `crates/brust-compiler/{Cargo.toml,build.rs,src/parse/stubs/mod.rs,src/parse/stubs/real_mimalloc.rs}`, `crates/brust-server/src/{dispatch.rs,pipeline.rs}`, `Cargo.lock`, `bench/attribution.patch`, `bench/RESULTS.{md,json}` (Task 7 only). `native.rs` is a verbatim Bun copy — do not edit it.

## Review Focus

1. **Claim/deadline semantics after removing `tokio::spawn`.** The inline future owns the `RenderClaim`; if the caller is dropped (deadline, disconnect) the remainder MUST keep running until JS settles, a late settle must release the slot exactly once and reach no cache, and a panic inside the awaited future must release the slot (RAII through the unwinding async block) and surface as `CallError::BadResponse`, not tear down the hyper connection. Pinned by: the six existing `dispatch.rs` tests unchanged (`call_worker_keeps_slot_claimed_after_caller_drops`, `deadline_returns_504_error_and_keeps_the_claim_until_js_settles`, `late_rejection_after_deadline_releases_the_claim_quietly`, `a_timed_out_call_still_occupies_its_slot_so_the_next_caller_gets_timeout_not_deadline`, the two round-trip tests) + the new `a_panicking_dispatch_releases_its_slot_and_is_a_bad_response` + `detach_runs_the_remainder_off_the_caller` (Task 5) + `tests/busy.rs` (`parked_loader_is_504_and_static_routes_still_answer`, `late_result_after_504_is_not_cached`) green.
2. **mimalloc on the six napi targets, musl in particular.** The real `mi_*` must come from `libmimalloc-sys` only (no duplicate with the fake — `nm` shows `_mi_version` defined and NO undefined `_mi_*`), the Bun-fork-only hooks must have stubs, and on Linux the addon is `dlopen`ed by Bun so the C library must be built with `-ftls-model=local-dynamic` (`local_dynamic_tls` feature; musl's loader rejects initial-exec TLS in a dlopen'ed object, glibc only tolerates it while its static-TLS surplus lasts). Pinned by: Task 2 Step 6 `nm` checks on macOS, the full workspace gates in BOTH feature configurations, and the release.yml note (the six targets are built there with zig; not reproducible locally — `rustup target list --installed` has only `aarch64-apple-darwin`).
3. **HeaderMap reuse leaking headers across responses.** `page_response` now receives an owned map: on a BYPASS/uncached MISS it is the only map (no clone); on a cacheable MISS the L1 entry gets a clone BEFORE `x-brust-cache`/`Content-Encoding`/`Vary` are appended; a HIT still clones the entry's map. Pinned by: `page_response_appends_cache_encoding_and_vary_in_order` (Task 6), the existing `tests/server.rs`/`tests/cache.rs` HIT/gzip/Vary tests unchanged, and the `curl` header diff.
4. **Job re-index losing the per-row `k` ordering.** Results come back in an order Rust must not assume; the single pass maps each result to its REQUEST position `k` (which indexes `misses[k]` → `plans[i]`), unknown ids are ignored, a repeated id keeps the last value, an error wins over a missing result, and `values[i]` for every non-owner plan is fanned out from its owner. Pinned by: `results_in_request_order_*` unit tests (shuffled, duplicate, unknown, missing, error) in Task 6 + `per_instance_job_fills_an_array_by_row`, `plan_lists_chain_jobs_then_child_rows_in_template_order`, `job_error_is_500_and_not_cached`, `job_result_without_value_is_500_and_not_cached` unchanged, + `tests/server/pokedex.test.ts` (`/pokedex` 151 rows in dex order).
5. **Attribution patch leaking into a commit.** The patch adds `perf.rs`, a `/_brust/perf` route and `libc` to `brust-server` — none of it may land. Pinned by: the guard command before every commit (Global Constraints), `git show --stat HEAD` after each commit showing only intended files, and `grep -rn '_brust/perf\|mod perf' crates/brust-server/src` empty at READY.

## Dispatch table

Lane tier: **complex** — `review: complex` (lead ruling 2026-10-10, supersedes the spec §4 row "Tiësto / routine":
P0 replaces a fake libc-backed mimalloc that the addon already links for the Bun crates, and Task 5 touches the
m2b2 call-deadline/claim-release semantics; implementer Dew, reviewer Mellow). Per-task tiers below are for the
Coordinator's gate routing only.

| slug-task | tier | role | deps | acceptance (gate commands + READY evidence) |
|---|---|---|---|---|
| `m3p-a-alloc-bridge-1` baseline | routine | implementer | lane created from `m3p` | `git apply --check bench/attribution.patch` OK on HEAD after the rebase; bench table (B, C identity + gzip, both sides) and attribution tree (c=120 and c=1, probes B and C) pasted in the note; `curl` fixtures saved; commit `bench: rebase attribution.patch onto m3p HEAD` with only `bench/attribution.patch` changed |
| `m3p-a-alloc-bridge-2` P0 | standard | implementer | task 1 | `nm` evidence (Task 2 Step 6) pasted; all Global-Constraints gates green in both feature configurations; `curl` diff empty; commit `perf(napi): mimalloc as the addon's global allocator (M3-P P0)` |
| `m3p-a-alloc-bridge-3` measure P0 | routine | implementer | task 2 | bench + attribution after P0 pasted with deltas vs Task 1; no committed change to RESULTS.*; guard `clean` |
| `m3p-a-alloc-bridge-4` P5 kind | routine | implementer | task 3 | `cargo test -p brust-napi` green; `git diff --stat packages/brust/index.d.ts` empty after `bun run build:debug`; `cd packages/brust && bun test test/napi-server.test.ts test/worker.test.ts` green; commit `perf(napi): pass the call kind as &'static str (M3-P P5)` |
| `m3p-a-alloc-bridge-5` P5 call_worker | standard | implementer | task 4 | `cargo test -p brust-server dispatch` shows the 6 old + 2 new tests green; `cargo test -p brust-server --test busy` green; `grep -n 'tokio::spawn' crates/brust-server/src/dispatch.rs` → only inside `Detach::drop`; commit `perf(server): await the worker call inline; detach only on cancellation (M3-P P5)` |
| `m3p-a-alloc-bridge-6` P5 response | standard | implementer | task 5 | new pipeline unit tests green; `cargo test -p brust-server` green; `curl` diff (body + headers) empty vs Task 1 fixtures; commit `perf(server): build page headers once; one-pass job result re-index (M3-P P5)` |
| `m3p-a-alloc-bridge-7` measure + READY | routine | implementer | task 6 | bench after P5 pasted; `bench/RESULTS.{md,json}` regenerated and committed; `bench/attribution.patch` refreshed for the new `call_worker`/`pipeline.rs` shape and committed; full gate list green; READY note with the three-point table, attribution deltas, lane HEAD sha, guard evidence |

## File structure

```
crates/brust-compiler/Cargo.toml                 + feature real-mimalloc = ["dep:mimalloc"], optional dep mimalloc
crates/brust-compiler/build.rs                   NEW: feature → --cfg bun_sema_mimalloc
crates/brust-compiler/src/parse/stubs/mod.rs     + #[cfg(bun_sema_mimalloc)] mod real_mimalloc;
crates/brust-compiler/src/parse/stubs/real_mimalloc.rs   NEW: 4 Bun-fork-only hooks (no-ops, copied from native.rs)
crates/brust-napi/Cargo.toml                     brust-compiler features=["real-mimalloc"]; mimalloc; linux: local_dynamic_tls
crates/brust-napi/src/lib.rs                     #[global_allocator] static GLOBAL: MiMalloc
crates/brust-napi/src/dispatch.rs                WorkerTsfn tuple (&'static str, String, u32); no to_string()
crates/brust-napi/src/server.rs                  register_worker Function<FnArgs<(&'static str, String, u32)>, …>
crates/brust-server/src/dispatch.rs              call_worker inline + Detach wrapper + 2 tests
crates/brust-server/src/pipeline.rs              page_response(status, HeaderMap, html_len, …); results_in_request_order + tests
Cargo.lock                                       mimalloc 0.1.52, libmimalloc-sys 0.1.49, cc
bench/attribution.patch                          rebased (Task 1), refreshed (Task 7)
bench/RESULTS.md, bench/RESULTS.json             regenerated (Task 7 only)
```

---

### Task 1: Baseline — lane, bench, attribution patch rebase, curl fixtures

**Files:**
- Modify: `bench/attribution.patch` (rebased onto m3p HEAD; the patched source files are reverted before the commit)
- Read: `bench/README.md`, `bench/run.ts`, `bench/attribution.ts`

**Interfaces:** none (measurement only). Produces: the "before" row of the three-point table, the attribution tree before P0, and the `curl` fixtures the later tasks diff against.

- [ ] **Step 1: Create the lane and the scratch dir**
```bash
cd /Users/detoro/code/brust-m3p && git worktree add ../brust-lane-m3p-a-alloc-bridge -b lane/m3p-a-alloc-bridge m3p
cd /Users/detoro/code/brust-lane-m3p-a-alloc-bridge && git log --oneline -1    # expect 0296b39 or a later m3p commit
export OUT=<your scratchpad directory>/m3p-a && mkdir -p $OUT
export BRUST_01X_DIR=/private/tmp/claude-501/-Users-detoro-code-brust/d073159b-8c7b-466d-ae02-a02838faf58a/scratchpad/brust01x
ls $BRUST_01X_DIR/runtime/*.node || (cd $BRUST_01X_DIR/runtime && bun run build)
bun install --frozen-lockfile
```

- [ ] **Step 2: Release addon + bench (before)**
```bash
cd packages/brust && bun run build && cd ../..           # RELEASE addon (bench refuses build:debug by contract)
uptime                                                   # 1-min load must be ≤ 10 (cores); wait if not
BRUST_RELEASE_ADDON=1 BRUST_01X_DIR=$BRUST_01X_DIR bun bench/run.ts | tee $OUT/bench-before.txt
cp bench/RESULTS.json $OUT/RESULTS-before.json && git checkout -- bench/RESULTS.md bench/RESULTS.json
```
Expected shape (numbers will differ; today's committed ones are B 41,086 vs 53,087 and C 33,737 vs 51,449 identity):
```
B-native-miss    identity: v2   4xxxx rps   0.1.x   5xxxx rps   Δ -2x.x%   gzip: …
C-react-child    identity: v2   3xxxx rps   0.1.x   5xxxx rps   Δ -3x.x%   gzip: …
```
Paste the full three-probe table into the task note under **before**.

- [ ] **Step 3: Rebase the attribution patch.** On m3p HEAD `git apply --check bench/attribution.patch` fails: `Cargo.lock` and `server/mod.rs` apply with offsets, but 6 of the 20 `crates/brust-server/src/pipeline.rs` hunks reject (the pipeline moved to `collect_jobs(&s.plans, …)`, `lookup_jobs`, `jobs_request`, `merge_values` since the patch was cut). Apply what applies and place the rejected hunks by hand:
```bash
patch -p1 --forward --reject-file=- < bench/attribution.patch > $OUT/patch.log 2>&1; tail -5 $OUT/patch.log
git status --short            # Cargo.lock, brust-server Cargo.toml, dispatch.rs, lib.rs, perf.rs (new), pipeline.rs, render.rs, server/mod.rs, worker.ts
```
For each rejected `pipeline.rs` hunk, re-add the timers at the HEAD anchors (line numbers at 0296b39):
  - `PAGE_TOTAL`: right after `let resp = page(&s, full, headers, &mut meta).await;` (:127); `HANDLE_TOTAL` right before the final `resp` of `handle`.
  - `MATCH`, `L1`, `CTX_INIT`, `CPU_PRE` inside `page` (:268) exactly as the patch's hunk shows (the surrounding code is unchanged there — only the hunk's leading context shifted).
  - `MERGE_LOADER` (`let _g = Rec(perf::MERGE_LOADER, t);`) before the loader `match r {`.
  - `COLLECT_JOBS` around `let plans = match collect_jobs(&s.plans, &route.chain, &ctx)` (:403); `JOB_LOOKUP` around `let Lookup { mut values, owner, misses } = lookup_jobs(&s.jobs, &plans);`.
  - `JOBS_CALL` (`let _g = Rec(perf::JOBS_CALL, t);`) as the first statement inside `if !misses.is_empty() {` (:415), before `let req = jobs_request(&plans, &misses);`.
  - `SEED` around `seed_child_slots(&s.plans, …)` (:499); `MERGE_RESULTS` around `merge_values(&mut ctx, &plans, &values);` (:503).
  - `BODY_RESP` / `L1_INSERT` / `CPU_POST` around `page_response(…)` and `s.l1.insert(…)` (:526-545); `RENDER_CHAIN` / `INJECT` / `CPU_RENDER` in `render_document` (:562); `CTX_VALUE` / `OVERLAY` in `render_chain_html` (:629-633); `CJ_INPUTS` / `CJ_KEY` in `plan_one`.
Then `cargo check -p brust-server` must pass and `git diff --stat` must list exactly the files the original patch touched.
```bash
cargo check -p brust-server && git diff > bench/attribution.patch.new
```

- [ ] **Step 4: Attribution run (before)**
```bash
cd packages/brust && bun run build && cd ../..
BRUST_RELEASE_ADDON=1 BENCH_CONN=120,1 ATTR_SIDES=v2 ATTR_OUT=$OUT/attr-before.json bun bench/attribution.ts | tee $OUT/attr-before.txt
```
Expected: four `### v2 B c=120 …` / `### v2 C …` tables (the `/_brust/perf` route answers 200). If the tables are missing, the patched addon was not rebuilt — redo the build line. Paste the c=120 tables for B and C in the note (at least `SVC_TOTAL`, `CW_TOTAL`, `CW_CLAIM`, `CW_SER`, `CW_SPAWN_SCHED`, `CW_DISPATCH`, `BRIDGE`, `CW_JS_TOTAL`, `CW_READ_PARSE`, `CW_JOIN`, `JB_TOTAL`, `RENDER_CHAIN`, `BODY_RESP`, `INJECT`, `unattributed`).

- [ ] **Step 5: Revert the patched sources, keep the rebased patch file**
```bash
git checkout -- Cargo.lock crates/ packages/brust/src/worker.ts && rm -f crates/brust-server/src/perf.rs
mv bench/attribution.patch.new bench/attribution.patch
git apply --check bench/attribution.patch && echo PATCH-OK      # must print PATCH-OK on clean HEAD
git diff --quiet crates/ packages/brust/src/worker.ts && echo clean
cd packages/brust && bun run build && cd ../..                   # clean release addon again
```

- [ ] **Step 6: curl fixtures (before).** Save this as `$OUT/snap.sh`; it is reused in Tasks 2, 6 and 7.
```bash
#!/bin/bash
# usage: snap.sh <label>   — serves examples/pokedex on :38211, saves normalised bodies + headers
set -e; L=$1; ROOT=$(git rev-parse --show-toplevel); OUT=${OUT:?}
( cd $ROOT/examples/pokedex && ../../packages/brust/bin/brust build routes.tsx >/dev/null && \
  BRUST_PORT= ../../packages/brust/bin/brust start --port 38211 --workers 2 >$OUT/srv-$L.log 2>&1 & echo $! > $OUT/srv.pid )
for i in $(seq 1 100); do grep -q '\[brust\] ready' $OUT/srv-$L.log && break; sleep 0.2; done
for p in / /pokemon/pikachu; do
  n=${p//\//_}
  curl -s -H 'accept-encoding: identity' -D $OUT/hdr-$L$n "http://127.0.0.1:38211$p?nocache=1" \
   | sed -E 's/-[0-9a-f]{10}\.js/-HASH.js/g; s/_[0-9a-f]{8}([-"])/_ID\1/g' > $OUT/body-$L$n
  grep -vi '^date:' $OUT/hdr-$L$n > $OUT/hdr-$L$n.norm
done
kill $(cat $OUT/srv.pid); sleep 0.5
wc -c $OUT/body-$L*; cat $OUT/hdr-$L*.norm
```
```bash
chmod +x $OUT/snap.sh && $OUT/snap.sh before
```
Expected: two bodies (tens of KB each), headers containing `content-type: text/html; charset=utf-8` and `x-brust-cache: BYPASS` (pikachu) / no cache header (`/`).

- [ ] **Step 7: Commit the rebased patch only**
```bash
git add bench/attribution.patch && git commit -m "bench: rebase attribution.patch onto m3p HEAD

Six pipeline.rs hunks no longer applied after the m2 collect_jobs/lookup_jobs/
jobs_request/merge_values refactor. Same stages, same names; the patch is
applied temporarily for bench/attribution.ts and never committed applied.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git show --stat HEAD      # exactly one file
```

---

### Task 2: P0 — mimalloc as the addon's global allocator

**Files:**
- Modify: `crates/brust-compiler/Cargo.toml`, `crates/brust-compiler/src/parse/stubs/mod.rs`, `crates/brust-napi/Cargo.toml`, `crates/brust-napi/src/lib.rs`, `Cargo.lock`
- Create: `crates/brust-compiler/build.rs`, `crates/brust-compiler/src/parse/stubs/real_mimalloc.rs`
- Read first: `crates/brust-compiler/src/parse/stubs/native.rs` lines 1-20 (the `cfg(not(bun_sema_mimalloc))` fake) and lines ~674-690 (the four `mi_thread_set_in_threadpool` / `mi_on_thread_idle*` fakes, also gated), `~/.cargo/registry/src/*/libmimalloc-sys-0.1.49/build.rs` lines 85-96 (TLS model flags)

**Interfaces:**
- Consumes: `mimalloc::MiMalloc` (crate `mimalloc` 0.1.52 → `libmimalloc-sys` 0.1.49, `links = "mimalloc"`, no other crate in the tree declares that `links` key); `bun_alloc`'s `extern "C" { fn mi_malloc … }` declarations (`bun_mimalloc_sys`), which the real library now satisfies.
- Produces: cargo feature `brust-compiler/real-mimalloc`; cfg `bun_sema_mimalloc` for brust-compiler when the feature is on; the four stub symbols; `#[global_allocator]` in the cdylib.

Why this shape (the facts, so nobody "simplifies" it back): the v2 addon (`nm brust.darwin-arm64.node`) defines exactly 24 global `_mi_*` symbols — the fake in `native.rs` (libc + bump heap, "Never part of the real build" says Bun, but it IS our real build today). Adding `mimalloc` without removing the fake either silently binds `MiMalloc` to the fake (if the linker never pulls `static.o`) or fails with duplicate `_mi_malloc` (the real archive is pulled as soon as `mi_realloc`/`mi_realloc_aligned`, absent from the fake, are referenced). `native.rs` is verbatim and must not be edited, but it already has the switch: `#[cfg(not(bun_sema_mimalloc))]`. A build script can set that cfg for brust-compiler only when a feature asks for it. Upstream mimalloc v3 lacks four Bun-fork hooks (`mi_thread_set_in_threadpool`, `mi_on_thread_idle`, `mi_on_thread_idle_start`, `mi_on_thread_idle_end`) that `bun_threading`/`bun_core` reference and that the fake also provides under the same cfg — so they need Rust stubs when the cfg is on. Feature unification: `cargo test --workspace` enables the feature for brust-compiler's own tests and `brust-compiler-cli` too (they then link the real mimalloc via `dep:mimalloc` + the stubs); `cargo test -p brust-compiler` alone keeps the fake. Both must stay green.

- [ ] **Step 1: brust-compiler feature + build script**

`crates/brust-compiler/Cargo.toml` — current:
```toml
[features]
default = ["bun-stubs"]
# Provides the native symbols Bun's C/C++ normally supplies. Disable only when linking
# into a host that already provides them.
bun-stubs = []
```
Replace with:
```toml
[features]
default = ["bun-stubs"]
# Provides the native symbols Bun's C/C++ normally supplies. Disable only when linking
# into a host that already provides them.
bun-stubs = []
# Link the real mimalloc (crate `mimalloc` → libmimalloc-sys) instead of the fake,
# libc-backed `mi_*` in src/parse/stubs/native.rs. build.rs turns this into
# `--cfg bun_sema_mimalloc`, the switch that verbatim Bun file already honours.
# The addon (brust-napi) enables it and makes mimalloc its #[global_allocator].
real-mimalloc = ["dep:mimalloc"]
```
and under `[dependencies]` add `mimalloc = { version = "0.1", optional = true }`.

Create `crates/brust-compiler/build.rs`:
```rust
//! `real-mimalloc` → `--cfg bun_sema_mimalloc`: the switch `src/parse/stubs/native.rs`
//! (a verbatim Bun file) uses to drop its fake `mi_*` so the real mimalloc links.
fn main() {
    println!("cargo::rustc-check-cfg=cfg(bun_sema_mimalloc)");
    if std::env::var_os("CARGO_FEATURE_REAL_MIMALLOC").is_some() {
        println!("cargo::rustc-cfg=bun_sema_mimalloc");
    }
    println!("cargo::rerun-if-changed=build.rs");
}
```

- [ ] **Step 2: the four Bun-fork-only hooks.** Open `native.rs` around line 674 and copy the four function bodies EXACTLY (they are `#[cfg(not(bun_sema_mimalloc))] #[unsafe(no_mangle)] extern "C" fn …`; `mi_on_thread_idle_start` returns `bool`). Create `crates/brust-compiler/src/parse/stubs/real_mimalloc.rs`:
```rust
//! The four thread-pool hooks Bun's mimalloc fork adds and upstream mimalloc lacks.
//! `native.rs` provides them only without `bun_sema_mimalloc`; with the real
//! (upstream) library linked (feature `real-mimalloc`) they live here, same bodies.

#[unsafe(no_mangle)]
extern "C" fn mi_thread_set_in_threadpool() {}
#[unsafe(no_mangle)]
extern "C" fn mi_on_thread_idle() {}
#[unsafe(no_mangle)]
extern "C" fn mi_on_thread_idle_start() -> bool {
    false // ← replace with the body native.rs uses (read it; do not guess)
}
#[unsafe(no_mangle)]
extern "C" fn mi_on_thread_idle_end() {}
```
`crates/brust-compiler/src/parse/stubs/mod.rs` — current tail:
```rust
pub(super) mod extra;
pub(super) mod native;
```
Append:
```rust
#[cfg(bun_sema_mimalloc)]
pub(super) mod real_mimalloc;
```

- [ ] **Step 3: brust-napi dependencies + global allocator**

`crates/brust-napi/Cargo.toml` — current:
```toml
brust-compiler = { path = "../brust-compiler" }
brust-server = { path = "../brust-server" }
```
Replace / add:
```toml
brust-compiler = { path = "../brust-compiler", features = ["real-mimalloc"] }
brust-server = { path = "../brust-server" }
# M3-P P0: the addon's #[global_allocator]. Default features = mimalloc v3.
mimalloc = "0.1"

# Bun dlopen()s the addon: its C thread-locals must use the local-dynamic TLS
# model. musl's loader refuses initial-exec TLS in a dlopen'ed object outright
# and glibc only tolerates it while its static-TLS surplus lasts. Cost: one
# __tls_get_addr per allocation on Linux; macOS (Mach-O TLV) is unaffected.
[target.'cfg(target_os = "linux")'.dependencies]
mimalloc = { version = "0.1", features = ["local_dynamic_tls"] }
```
`crates/brust-napi/src/lib.rs` — current head:
```rust
//! napi-rs binding of `brust-server` and `brust-compiler` for Bun.
#![deny(clippy::all)]

mod compile;
mod dispatch;
mod server;
mod stubs;
```
Insert after `mod stubs;`:
```rust
/// M3-P P0: mimalloc for every Rust allocation in the addon (render path, JSON
/// parse, response bodies) and, through `brust-compiler/real-mimalloc`, for the
/// parser's `bun_alloc` heaps too — one real mimalloc, no libc fake.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;
```

- [ ] **Step 4: Build and lock**
```bash
cargo build -p brust-napi 2>&1 | tail -3        # pulls mimalloc 0.1.52, libmimalloc-sys 0.1.49, cc
grep -n -A1 'name = "mimalloc"\|name = "libmimalloc-sys"' Cargo.lock
```
Expected: both present once; `cc` 1.x present. A `duplicate symbol _mi_malloc` link error here means the cfg did not reach brust-compiler — check `CARGO_FEATURE_REAL_MIMALLOC` spelling in build.rs (feature `real-mimalloc` → env `CARGO_FEATURE_REAL_MIMALLOC`).

- [ ] **Step 5: Gates in BOTH feature configurations**
```bash
cargo fmt --all -- --check
cargo clippy -p brust-compiler -p brust-compiler-cli -p brust-jinja -p brust-server -p brust-napi --no-deps -- -D warnings   # feature ON (unified)
cargo clippy -p brust-compiler --no-deps -- -D warnings                                                                       # feature OFF
cargo test --workspace --exclude bun_react_compiler 2>&1 | grep -E '^test result|FAILED|panicked' | sort | uniq -c            # feature ON everywhere
cargo test -p brust-compiler 2>&1 | grep -E '^test result'                                                                    # feature OFF: the fake still links
```
Expected: every `test result: ok.`; the OFF run exists to prove `brust-compiler-cli`/tests without the feature still build (the stubs module is cfg'd out there and the fake provides the symbols).

- [ ] **Step 6: Prove the real mimalloc is linked (macOS arm64)**
```bash
cd packages/brust && bun run build:debug && cd ../..
N=packages/brust/native/brust.darwin-arm64.node
nm $N | grep -c '_mi_'                                   # expect well above 24 (the fake had exactly 24 globals)
nm $N | grep ' [Tt] _mi_version$'                        # expect one line: upstream mimalloc's mi_version — the fake has none
nm $N | grep ' [Tt] _mi_on_thread_idle_start$'           # expect one line: our stub
nm -u $N | grep -c '_mi_'                                # expect 0: nothing resolved against Bun at dlopen
```
Paste the four outputs in the task note. Then the TS gates (the debug addon was just rebuilt):
```bash
cd packages/brust && bun run typecheck && bun test test/routes.test.ts test/cache.test.ts test/worker.test.ts test/config.test.ts test/napi-compile.test.ts test/build-compile.test.ts && bun test test/napi-server.test.ts && bun test test/build-manifest.test.ts && bun test test/cli.test.ts && bun test --timeout 120000 test/e2e.test.ts && cd ../..
cd examples/pokedex && bun test && bun run typecheck && cd ../..
bun test --timeout 120000 tests/server/pokedex.test.ts
bun test --timeout 120000 tests/server/hydrate.chromium.test.ts
```

- [ ] **Step 7: Byte-identical check (release addon, as served)**
```bash
cd packages/brust && bun run build && cd ../.. && $OUT/snap.sh p0
for n in _ _pokemon_pikachu; do cmp $OUT/body-before$n $OUT/body-p0$n && diff $OUT/hdr-before$n.norm $OUT/hdr-p0$n.norm && echo "IDENTICAL $n"; done
```
Expected: `IDENTICAL _` and `IDENTICAL _pokemon_pikachu`.

- [ ] **Step 8: Release-target note (no local cross build).** The six `napi.targets` in `packages/brust/package.json` are built by `.github/workflows/release.yml` (macOS runners for darwin; ubuntu + `cargo-zigbuild` for both gnu and both musl legs; `cc` honours zigbuild's `CC_<target>` wrappers, so `static.c` cross-compiles like aws-lc-sys does). `rustup target list --installed` here shows only `aarch64-apple-darwin`, so `cargo check --target x86_64-unknown-linux-musl` is NOT possible locally; do not install targets for this lane. Write in the task note: "Linux legs unverified locally; release.yml is the gate; risk = libmimalloc-sys cc build under zig for musl (mitigation: `local_dynamic_tls` on, no `override`/`secure` features)". The lead may trigger `workflow_dispatch` on `m3p` at the wave boundary (spec §7).

- [ ] **Step 9: Commit**
```bash
git diff --quiet crates/ packages/brust/src/worker.ts || { echo "ABORT: unexpected diff — attribution patch applied?"; }   # it WILL show the P0 diff; inspect it is only the 8 files below
git status --short    # Cargo.lock, crates/brust-compiler/{Cargo.toml,build.rs,src/parse/stubs/mod.rs,src/parse/stubs/real_mimalloc.rs}, crates/brust-napi/{Cargo.toml,src/lib.rs}
git add Cargo.lock crates/brust-compiler/Cargo.toml crates/brust-compiler/build.rs crates/brust-compiler/src/parse/stubs/mod.rs crates/brust-compiler/src/parse/stubs/real_mimalloc.rs crates/brust-napi/Cargo.toml crates/brust-napi/src/lib.rs
git commit -m "perf(napi): mimalloc as the addon's global allocator (M3-P P0)

The addon linked Bun's fake libc-backed mi_* (native.rs, verbatim) because
nothing set --cfg bun_sema_mimalloc. brust-compiler gains feature
real-mimalloc: build.rs emits that cfg, the fake drops out, libmimalloc-sys
provides mi_*, and four Bun-fork-only hooks get no-op stubs. brust-napi
enables it and installs mimalloc::MiMalloc as #[global_allocator]; Linux
builds use local_dynamic_tls because Bun dlopen()s the addon.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git show --stat HEAD    # 7 files, no perf.rs, no worker.ts
```

---

### Task 3: Measure after P0

**Files:** none committed. Reads `bench/attribution.patch`.

- [ ] **Step 1: Bench (after P0)** — same commands as Task 1 Step 2 with `tee $OUT/bench-p0.txt`, copy `RESULTS.json` to `$OUT/RESULTS-p0.json`, then `git checkout -- bench/RESULTS.md bench/RESULTS.json`. Paste the B/C identity rows and Δ vs before in the note.
- [ ] **Step 2: Attribution (after P0)**
```bash
git apply --3way bench/attribution.patch || { git status --short; echo "fix the Cargo.lock hunk by hand (mimalloc lines moved it) then continue"; }
cd packages/brust && bun run build && cd ../..
BRUST_RELEASE_ADDON=1 BENCH_CONN=120,1 ATTR_SIDES=v2 ATTR_OUT=$OUT/attr-p0.json bun bench/attribution.ts | tee $OUT/attr-p0.txt
git checkout -- Cargo.lock crates/ packages/brust/src/worker.ts && rm -f crates/brust-server/src/perf.rs
git diff --quiet crates/ packages/brust/src/worker.ts && echo clean
cd packages/brust && bun run build && cd ../..
```
Paste `RENDER_CHAIN`, `CW_READ_PARSE`, `BODY_RESP`, `INJECT`, `SVC_TOTAL` and the per-request CPU µs for B and C, before → after P0, in the note. Expected direction: allocator-heavy stages (`RENDER_CHAIN`, `CW_READ_PARSE`, `INJECT`) down; if nothing moves by ≥ 2 % on both probes, say so — §5's stop rule counts it, but P5 lands regardless (§2: "all land").

---

### Task 4: P5 — the call kind crosses as `&'static str`

**Files:**
- Modify: `crates/brust-napi/src/dispatch.rs` (`WorkerTsfn` :26-32, `call` :91), `crates/brust-napi/src/server.rs` (`register_worker` :117)
- Test: existing `kind_names_match_the_wire` (dispatch.rs) + `packages/brust/test/{worker,napi-server}.test.ts`

**Interfaces:**
- Consumes: `napi::bindgen_prelude::ToNapiValue for &str` (napi 3.14.2 `js_values/string.rs:89`), `JsValuesTupleIntoVec for FnArgs<(A, B, C)>` with each `: ToNapiValue`.
- Produces: `WorkerTsfn = ThreadsafeFunction<FnArgs<(&'static str, String, u32)>, Promise<u32>, FnArgs<(&'static str, String, u32)>, napi::Status, false>`. JS signature unchanged: `(kind: string, requestJson: string, slot: number) => Promise<number>`.

- [ ] **Step 1: Edit `dispatch.rs`.** Current:
```rust
pub type WorkerTsfn = ThreadsafeFunction<
    FnArgs<(String, String, u32)>,
    Promise<u32>,
    FnArgs<(String, String, u32)>,
    napi::Status,
    false,
>;
```
→
```rust
pub type WorkerTsfn = ThreadsafeFunction<
    FnArgs<(&'static str, String, u32)>,
    Promise<u32>,
    FnArgs<(&'static str, String, u32)>,
    napi::Status,
    false,
>;
```
Current call site:
```rust
            match tsfn
                .call_async((kind_str(kind).to_string(), request_json, slot).into())
                .await
```
→
```rust
            match tsfn
                .call_async((kind_str(kind), request_json, slot).into())
                .await
```
Update the type's doc comment: "Worker signature: `(kind, requestJson, slot) => Promise<number>`; `kind` is a `&'static str` on the Rust side (no per-call allocation; napi copies it into a JS string on the worker thread)".

- [ ] **Step 2: Edit `server.rs`.** Current:
```rust
    f: Function<FnArgs<(String, String, u32)>, Promise<u32>>,
```
→
```rust
    f: Function<FnArgs<(&'static str, String, u32)>, Promise<u32>>,
```
`cargo check -p brust-napi`. If the `#[napi]` derive rejects the lifetime inside the generic (napi-derive-backend 6.1.5 maps `str` → `string`, so this is expected to pass), FALLBACK without changing the JS type: keep the `Function<FnArgs<(String, String, u32)>, Promise<u32>>` parameter and build the tsfn with the data type decoupled from the declared args:
```rust
    let tsfn: WorkerTsfn = f
        .build_threadsafe_function::<FnArgs<(&'static str, String, u32)>>()
        .build_callback(|ctx| Ok(ctx.value))?;
```
(`ThreadsafeFunctionBuilder::build_callback<CallJsBackArgs, _>` returns `ThreadsafeFunction<T, Return, CallJsBackArgs, …>`; the `Function`'s own `Args` only types the declaration.) Record which path was needed in the note.

- [ ] **Step 3: Gates**
```bash
cargo fmt --all -- --check && cargo clippy -p brust-napi --no-deps -- -D warnings && cargo test -p brust-napi
cd packages/brust && bun run build:debug && git diff --stat index.d.ts   # expect: no output (JS signature unchanged)
bun run typecheck && bun test test/worker.test.ts && bun test test/napi-server.test.ts && cd ../..
```

- [ ] **Step 4: Commit**
```bash
git diff --quiet crates/brust-server packages/brust/src/worker.ts && echo clean
git add crates/brust-napi/src/dispatch.rs crates/brust-napi/src/server.rs
git commit -m "perf(napi): pass the call kind as &'static str (M3-P P5)

kind_str() already returns a static; the tsfn tuple carried an owned String
built per call. The JS signature is unchanged (index.d.ts diff empty).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: P5 — `call_worker` without a per-call `tokio::spawn`

**Files:**
- Modify: `crates/brust-server/src/dispatch.rs` (`CallError::Deadline` doc :130-133, `call_worker` :176-234, `mod tests` :455+)
- Read first: `crates/brust-server/src/pool.rs` :122-186 (`RenderClaim`, its `Drop` and the load-bearing INVARIANT comment), `docs/plans/2026-10-09-m2-call-deadline.md` §Global Constraints

**Interfaces:**
- Unchanged: `pub async fn call_worker<Req: Serialize, Resp: DeserializeOwned + Send + 'static>(pool: &Arc<WorkerPool>, timeout: Duration, call_timeout: Duration, kind: CallKind, req: &Req) -> Result<Resp, CallError>`; all `CallError` variants; `RenderClaim` is never released before the dispatch future settles.
- New (private): `struct Detach<T>(Option<Pin<Box<dyn Future<Output = T> + Send>>>)` — polls inline, spawns the remainder on drop-before-completion, converts a panic into `Err(payload)`.

Semantics to preserve (verbatim from today, each pinned by a test): (a) happy path parses in the SAB slot and releases the claim after the parse; (b) `EnqueueFailed` removes the worker and returns `Enqueue`; (c) `PromiseRejected` → `Rejected`, claim released; (d) caller dropped mid-call → claim held until JS settles, then released; (e) deadline elapsed → `Err(Deadline)` now, claim held until JS settles, late result dropped, nothing cached; (f) a panic in the call path → `Err(BadResponse(..))` to the caller, claim released. Today (d)/(e)/(f) come for free from `tokio::spawn` (task owns the claim; `JoinError` for the panic). Inline, (d)/(e) need the detach-on-drop and (f) needs `catch_unwind` around the poll.

- [ ] **Step 1: Failing tests** (append inside `mod tests`, after `a_timed_out_call_still_occupies_its_slot…`):
```rust
    /// `call` panics when polled: the claim must be released by unwinding and
    /// the caller must get `BadResponse`, not a torn-down task.
    struct PanickingDispatch(MockDispatch);

    impl RenderDispatch for PanickingDispatch {
        fn call(
            &self,
            _kind: CallKind,
            _request_json: String,
            _slot: u32,
        ) -> Pin<Box<dyn Future<Output = Result<u32, DispatchError>> + Send>> {
            Box::pin(async { panic!("worker exploded") })
        }
        fn buf(&self) -> (*mut u8, usize) {
            self.0.buf()
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_panicking_dispatch_releases_its_slot_and_is_a_bad_response() {
        let pool = Arc::new(WorkerPool::new());
        pool.register(Box::new(PanickingDispatch(MockDispatch::new())));
        let r = call_with(&pool, 100, 1_000, CallKind::Loader).await;
        match r {
            Err(CallError::BadResponse(m)) => assert!(m.contains("worker exploded"), "{m}"),
            other => panic!("expected BadResponse, got {other:?}"),
        }
        assert!(
            matches!(pool.try_claim_render_lockfree(), ClaimResult::Claimed(_)),
            "the slot must be free after the panic"
        );
    }

    /// The happy path must not spawn: the caller's task is the only one alive
    /// before and after a round trip (current_thread runtime, nothing else running).
    #[tokio::test(flavor = "current_thread")]
    async fn detach_runs_the_remainder_off_the_caller() {
        // Deadline fires → the remainder is detached and finishes on its own
        // (the claim is released without anyone awaiting the call again).
        let (pool, release) = gated_pool();
        let r = call_with(&pool, 100, 30, CallKind::Loader).await;
        assert!(matches!(r, Err(CallError::Deadline)));
        release.send(Ok(())).unwrap();
        wait_claimable(&pool).await;
        // And a second, un-gated call on the same (now free) slot round-trips.
        let pool2 = pool_with(MockDispatch::replying(br#"{"ok":true}"#));
        let v = call_with(&pool2, 100, 1_000, CallKind::Jobs).await.expect("round trip");
        assert_eq!(v, serde_json::json!({"ok": true}));
    }
```
(`call_with`, `gated_pool`, `wait_claimable`, `pool_with` already exist in the module.) Run `cargo test -p brust-server dispatch` → the panic test FAILS today (the panic becomes `BadResponse("worker call task: … panicked …")` — actually passes on the message check only if the `JoinError` Display includes the payload; if it passes, keep it: it must still pass after). `detach_runs_the_remainder_off_the_caller` passes today too; it is a regression pin for the new shape.

- [ ] **Step 2: Implement.** Current `call_worker` body (:187-234):
```rust
    let claim = claim_or_wait(pool, timeout, || pool.try_claim_render_lockfree()).await?;
    let json = serde_json::to_string(req)
        .map_err(|e| CallError::BadResponse(format!("request serialise: {e}")))?;
    let pool = Arc::clone(pool);
    let task = tokio::spawn(async move {
        let entry = Arc::clone(claim.entry());
        let slot = claim.slot();
        let len = match entry.dispatch.call(kind, json, slot).await {
            Ok(n) => n,
            Err(DispatchError::EnqueueFailed(m)) => {
                tracing::error!(worker_id = entry.id(), ?kind, error = %m, "enqueue failed — worker dead, removing from pool");
                pool.remove(entry.id());
                return Err(CallError::Enqueue(m));
            }
            Err(DispatchError::PromiseRejected(m)) => return Err(CallError::Rejected(m)),
        };
        let (ptr, cap) = entry.dispatch.buf_slot(slot);
        if len == 0 || len as usize > cap {
            return Err(CallError::BadResponse(format!(
                "resp_len {len} outside (0, {cap}]"
            )));
        }
        // SAFETY: …
        let bytes = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
        let parsed = serde_json::from_slice::<Resp>(bytes)
            .map_err(|e| CallError::BadResponse(e.to_string()));
        drop(claim);
        parsed
    });
    match tokio::time::timeout(call_timeout, task).await {
        Ok(joined) => {
            joined.map_err(|e| CallError::BadResponse(format!("worker call task: {e}")))?
        }
        // The task keeps running and keeps the claim until JS settles (the
        // `RenderClaim` drop rule in `pool.rs`); its late result is dropped
        // with the JoinHandle, so nothing from this call reaches a cache.
        Err(_elapsed) => Err(CallError::Deadline),
    }
```
Replace from `let pool = Arc::clone(pool);` to the end with:
```rust
    let pool = Arc::clone(pool);
    // The body is identical to the former spawned task. It is polled INLINE on
    // the request's task (no spawn, no scheduling hop); `Detach` makes the two
    // cases the spawn used to cover explicit: dropped before completion
    // (deadline, client disconnect) → the remainder is spawned so the claim it
    // owns is released only when JS settles; a panic → `Err(payload)` to us,
    // the claim released by the unwinding async block.
    let call: Pin<Box<dyn Future<Output = Result<Resp, CallError>> + Send>> =
        Box::pin(async move {
            let entry = Arc::clone(claim.entry());
            let slot = claim.slot();
            let len = match entry.dispatch.call(kind, json, slot).await {
                Ok(n) => n,
                Err(DispatchError::EnqueueFailed(m)) => {
                    tracing::error!(worker_id = entry.id(), ?kind, error = %m, "enqueue failed — worker dead, removing from pool");
                    pool.remove(entry.id());
                    return Err(CallError::Enqueue(m));
                }
                Err(DispatchError::PromiseRejected(m)) => return Err(CallError::Rejected(m)),
            };
            let (ptr, cap) = entry.dispatch.buf_slot(slot);
            if len == 0 || len as usize > cap {
                return Err(CallError::BadResponse(format!(
                    "resp_len {len} outside (0, {cap}]"
                )));
            }
            // SAFETY: the worker's Promise resolved (happens-before through the dispatch
            // future), JS is done writing this slot's sub-region; `len` is bounds-checked
            // above; `claim` is still held so no other request can write the slot.
            let bytes = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
            let parsed = serde_json::from_slice::<Resp>(bytes)
                .map_err(|e| CallError::BadResponse(e.to_string()));
            drop(claim);
            parsed
        });
    match tokio::time::timeout(call_timeout, Detach(Some(call))).await {
        Ok(Ok(result)) => result,
        Ok(Err(payload)) => Err(CallError::BadResponse(format!(
            "worker call panicked: {}",
            panic_message(&payload)
        ))),
        // `Detach` was dropped by the timeout: the remainder now runs as its own
        // task and keeps the claim until JS settles (the `RenderClaim` drop rule
        // in `pool.rs`); its late result is dropped, so nothing from this call
        // reaches a cache.
        Err(_elapsed) => Err(CallError::Deadline),
    }
}

/// A boxed call future polled inline. Dropped before completion → the remainder
/// is detached onto the runtime (it owns the `RenderClaim`, which must outlive
/// the worker's write — see the INVARIANT in `pool.rs`). A panic while polling
/// is caught and returned as `Err(payload)`; the panicked future is dropped
/// (its locals, the claim included, were already released by the unwind) and
/// is never polled again.
struct Detach<T: Send + 'static>(Option<Pin<Box<dyn Future<Output = T> + Send>>>);

impl<T: Send + 'static> Future for Detach<T> {
    type Output = Result<T, Box<dyn std::any::Any + Send>>;

    fn poll(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Self::Output> {
        use std::task::Poll;
        let Some(inner) = self.0.as_mut() else {
            panic!("Detach polled after completion");
        };
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| inner.as_mut().poll(cx))) {
            Ok(Poll::Pending) => Poll::Pending,
            Ok(Poll::Ready(v)) => {
                self.0 = None;
                Poll::Ready(Ok(v))
            }
            Err(payload) => {
                self.0 = None;
                Poll::Ready(Err(payload))
            }
        }
    }
}

impl<T: Send + 'static> Drop for Detach<T> {
    fn drop(&mut self) {
        if let Some(rest) = self.0.take() {
            match tokio::runtime::Handle::try_current() {
                Ok(h) => {
                    h.spawn(rest);
                }
                // Only outside a runtime (shutdown): the claim is released with
                // the future, there is no worker left to protect.
                Err(_) => tracing::warn!("worker call dropped outside the runtime; claim released"),
            }
        }
    }
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> &str {
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("non-string panic payload")
}
```
Also update the doc comments: on `call_worker` (:176-186) replace the "run in a spawned task that OWNS the claim" paragraph with "run inline inside [`Detach`]: if the caller's future is dropped (hyper drops the request future on client disconnect; the deadline below), the remainder is spawned and keeps the slot claimed until the worker's call settles, so the SAB slot is never handed to another request while JS may still be writing it"; on `CallError::Deadline` (:130-133) "The spawned task still holds the claim" → "The detached remainder still holds the claim".

- [ ] **Step 3: Run**
```bash
cargo test -p brust-server dispatch 2>&1 | grep -E '^test |test result'
grep -n 'tokio::spawn\|h.spawn' crates/brust-server/src/dispatch.rs      # exactly one hit, inside Detach::drop
cargo test -p brust-server --test busy 2>&1 | grep -E '^test |test result'
cargo test -p brust-server 2>&1 | grep -E 'test result|FAILED'
```
Expected: 8 dispatch tests `ok` (6 old + 2 new), `busy` 4 `ok`, no FAILED.

- [ ] **Step 4: Gates + addon rebuild + server e2e** (the request path changed; the e2e proves the real tsfn future works inline):
```bash
cargo fmt --all -- --check && cargo clippy -p brust-server -p brust-napi --no-deps -- -D warnings
cd packages/brust && bun run build:debug && bun test test/napi-server.test.ts && bun test --timeout 120000 test/e2e.test.ts && cd ../..
bun test --timeout 120000 tests/server/pokedex.test.ts
```

- [ ] **Step 5: Commit**
```bash
git diff --quiet crates/brust-napi packages/brust/src/worker.ts && echo clean && git status --short   # only dispatch.rs
git add crates/brust-server/src/dispatch.rs
git commit -m "perf(server): await the worker call inline; detach only on cancellation (M3-P P5)

call_worker spawned a task per call so the claim could outlive a dropped
caller and a panic became a JoinError. Detach gives both without the spawn:
polled inline; dropped before completion → the remainder is spawned and
releases the claim when JS settles (deadline/disconnect semantics of m2b2
unchanged, same tests); a panic is caught and reported as BadResponse.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: P5 — page headers built once; one-pass job result re-index

**Files:**
- Modify: `crates/brust-server/src/pipeline.rs` (HIT path :291-296; jobs block :441-497; response block :508-545; `page_response` :588-611; `mod tests` :1705+)
- Read first: `crates/brust-server/src/server/body.rs` :92-138 (`header_map`, `resp_with`), `crates/brust-server/src/cache/l1.rs` :36-50 (`RenderedBody`) and :255-263 (`insert`)

**Interfaces:**
- Changed (private): `fn page_response(status: u16, headers: HeaderMap, html_len: usize, bytes: Bytes, gzipped: bool, cache_hdr: Option<&'static str>) -> Response<ResponseBody>`.
- New (private): `fn results_in_request_order(req: &JobsRequest, results: Vec<JobResult>) -> Result<Vec<Value>, JobResultError>` and `enum JobResultError { Threw { id: String, k: Option<usize>, error: String }, NoValue { id: String, k: Option<usize> }, Missing { k: usize } }` where `k` indexes `req.jobs` (= `misses`).
- Unchanged: `RenderedBody` (its `headers` is empty when the body is not stored — nothing reads it then; document that on the field), `cached_body`, `l1.insert`, `jobs.insert`, every log line's fields and text.

- [ ] **Step 1: Failing tests** (append in `mod tests`; `JobCall`/`JobsRequest`/`JobResult` are in `crate::protocol`, `JobKind` in `crate::manifest`):
```rust
    fn req_of(ids: &[&str]) -> JobsRequest {
        JobsRequest {
            jobs: ids
                .iter()
                .map(|id| JobCall {
                    id: id.to_string(),
                    component_id: "c".into(),
                    kind: JobKind::Precompute,
                    inputs: Value::Null,
                    target: None,
                    row: None,
                })
                .collect(),
        }
    }
    fn res(id: &str, v: Option<Value>, e: Option<&str>) -> JobResult {
        JobResult { id: id.into(), value: v, error: e.map(String::from) }
    }

    #[test]
    fn results_in_request_order_reorders_by_call_id() {
        let req = req_of(&["p/j/0", "p/j/1", "p/j/2"]);
        let out = results_in_request_order(
            &req,
            vec![res("p/j/2", Some(json!(2)), None), res("p/j/0", Some(json!(0)), None), res("p/j/1", Some(json!(1)), None)],
        )
        .unwrap();
        assert_eq!(out, vec![json!(0), json!(1), json!(2)]);
    }

    #[test]
    fn results_in_request_order_ignores_unknown_ids_and_keeps_the_last_duplicate() {
        let req = req_of(&["a", "b"]);
        let out = results_in_request_order(
            &req,
            vec![res("zzz", Some(json!(9)), None), res("a", Some(json!(1)), None), res("b", Some(json!(2)), None), res("a", Some(json!(3)), None)],
        )
        .unwrap();
        assert_eq!(out, vec![json!(3), json!(2)]);
    }

    #[test]
    fn results_in_request_order_reports_missing_error_and_no_value_with_positions() {
        let req = req_of(&["a", "b"]);
        assert!(matches!(
            results_in_request_order(&req, vec![res("a", Some(json!(1)), None)]),
            Err(JobResultError::Missing { k: 1 })
        ));
        assert!(matches!(
            results_in_request_order(&req, vec![res("b", None, Some("boom")), res("a", Some(json!(1)), None)]),
            Err(JobResultError::Threw { k: Some(1), .. })
        ));
        assert!(matches!(
            results_in_request_order(&req, vec![res("nope", None, Some("boom"))]),
            Err(JobResultError::Threw { k: None, .. })
        ));
        assert!(matches!(
            results_in_request_order(&req, vec![res("a", None, None), res("b", Some(json!(1)), None)]),
            Err(JobResultError::NoValue { k: Some(0), .. })
        ));
    }

    #[test]
    fn page_response_appends_cache_encoding_and_vary_in_order() {
        let mut h = HeaderMap::new();
        h.insert(http::header::CONTENT_TYPE, http::HeaderValue::from_static(HTML));
        let r = page_response(200, h, PAGE_GZIP_MIN, Bytes::from_static(b"x"), true, Some("MISS"));
        let names: Vec<&str> = r.headers().iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["content-type", "x-brust-cache", "content-encoding", "vary"]);
        let r = page_response(200, HeaderMap::new(), PAGE_GZIP_MIN - 1, Bytes::new(), false, None);
        assert!(r.headers().is_empty());
    }
```
`cargo test -p brust-server results_in_request_order` → compile error (no such fn). Good.

- [ ] **Step 2: `page_response` and its two callers.** Current (:588-611):
```rust
fn page_response(
    body: &RenderedBody,
    bytes: Bytes,
    gzipped: bool,
    cache_hdr: Option<&'static str>,
) -> Response<ResponseBody> {
    let mut h = body.headers.clone();
    if let Some(v) = cache_hdr {
        h.append("x-brust-cache", http::HeaderValue::from_static(v));
    }
    …
    if body.html.len() >= PAGE_GZIP_MIN {
        h.append(http::header::VARY, http::HeaderValue::from_static("Accept-Encoding"));
    }
    body::resp_with(body.status, h, bytes)
}
```
→
```rust
/// The page response: `headers` (the body's stored map — a HIT clones the
/// shared entry's, a fresh render moves the map it just built), then
/// `x-brust-cache`, `Content-Encoding` and `Vary` (on every gzip-eligible
/// document, identity or not, so a shared cache keys on `Accept-Encoding`).
fn page_response(
    status: u16,
    mut h: HeaderMap,
    html_len: usize,
    bytes: Bytes,
    gzipped: bool,
    cache_hdr: Option<&'static str>,
) -> Response<ResponseBody> {
    if let Some(v) = cache_hdr {
        h.append("x-brust-cache", http::HeaderValue::from_static(v));
    }
    if gzipped {
        h.append(http::header::CONTENT_ENCODING, http::HeaderValue::from_static("gzip"));
    }
    if html_len >= PAGE_GZIP_MIN {
        h.append(http::header::VARY, http::HeaderValue::from_static("Accept-Encoding"));
    }
    body::resp_with(status, h, bytes)
}
```
HIT path (:296) `return page_response(&hit.body, bytes, encoded, Some("HIT"));` → `return page_response(hit.body.status, hit.body.headers.clone(), hit.body.html.len(), bytes, encoded, Some("HIT"));` (the clone stays: the entry is shared by every HIT).

Render block — current (:508-545):
```rust
    let headers: Arc<[(String, String)]> = extra.into();
    let html = match render_document(s, route, &ctx) {
        Ok(h) => h,
        Err(e) => return render_failed(route, &e),
    };
    let body = Arc::new(RenderedBody {
        status,
        headers: body::header_map(HTML, &headers),
        html,
        gzip: std::sync::OnceLock::new(),
    });
    let (bytes, encoded) = cached_body(&body, crate::http::compress::accepts_gzip(accept_enc));
    let resp = page_response(&body, bytes, encoded, hdr);
    if let Some(k) = cache_key
        && status == 200
        && cacheable
        && let Some(c) = &route.cache
    {
        // The loader's headers ride with the ctx (and the rendered body, with
        // its gzip if this request made it) so a HIT replays them.
        s.l1.insert(k, ctx, body, headers, Duration::from_secs(c.ttl_seconds), &c.tags);
    }
    resp
```
→
```rust
    let html = match render_document(s, route, &ctx) {
        Ok(h) => h,
        Err(e) => return render_failed(route, &e),
    };
    // One header map per request. Only a render that is stored needs a second
    // copy (the L1 entry's); a BYPASS or an uncached route sends the only one.
    let store = cache_key.is_some() && status == 200 && cacheable && route.cache.is_some();
    let response_headers = body::header_map(HTML, &extra);
    let body = Arc::new(RenderedBody {
        status,
        headers: if store { response_headers.clone() } else { HeaderMap::new() },
        html,
        gzip: std::sync::OnceLock::new(),
    });
    let (bytes, encoded) = cached_body(&body, crate::http::compress::accepts_gzip(accept_enc));
    let resp = page_response(status, response_headers, body.html.len(), bytes, encoded, hdr);
    if store
        && let Some(k) = cache_key
        && let Some(c) = &route.cache
    {
        // The loader's headers ride with the ctx (and the rendered body, with
        // its gzip if this request made it) so a HIT replays them.
        s.l1.insert(k, ctx, body, extra.into(), Duration::from_secs(c.ttl_seconds), &c.tags);
    }
    resp
```
On `RenderedBody::headers` in `l1.rs` add to the doc: "Empty for a body that is not stored (nothing reads it then)."

- [ ] **Step 3: the job result re-index.** Current (:462-497):
```rust
        let plan_of: HashMap<&str, &JobPlan> = req
            .jobs
            .iter()
            .zip(&misses)
            .map(|(call, &i)| (call.id.as_str(), &plans[i]))
            .collect();
        let mut by_id: HashMap<String, Value> = HashMap::new();
        for res in resp.results {
            let (component_id, job_id) = plan_of
                .get(res.id.as_str())
                .map_or(("?", "?"), |p| (p.component_id, p.job_id));
            if let Some(error) = res.error {
                tracing::error!(route = %route.id, component_id, job_id, call_id = %res.id, %error, "job threw");
                return body::error_500();
            }
            let Some(value) = res.value else {
                tracing::error!(route = %route.id, component_id, job_id, call_id = %res.id, "job result has neither value nor error");
                return body::error_500();
            };
            by_id.insert(res.id, value);
        }
        let mut fresh = Vec::with_capacity(misses.len());
        for (call, &i) in req.jobs.iter().zip(&misses) {
            let Some(v) = by_id.remove(&call.id) else {
                tracing::error!(route = %route.id, component_id = %plans[i].component_id, job_id = %plans[i].job_id, "jobs response has no result for {}", call.id);
                return body::error_500();
            };
            if let Err(e) = check_value(&plans[i], &v) {
                tracing::error!(route = %route.id, component_id = %plans[i].component_id, job_id = %plans[i].job_id, call_id = %call.id, error = %e, "job result does not fit its outputs");
                return body::error_500();
            }
            note_missing_slots(s, &plans[i], &v);
            fresh.push((i, Arc::new(v)));
        }
        for (i, v) in fresh {
            let p = &plans[i];
            s.jobs.insert(p.key.clone(), Arc::clone(&v), p.ttl, p.tags, p.user_key.as_deref());
            values[i] = Some(v);
        }
```
→
```rust
        // Validate every result before inserting any: one bad job fails the
        // request and nothing is cached. One index (call id → request position),
        // one pass; `k` indexes `req.jobs` and `misses` alike. Log fields come
        // from the plan the id names (ids are opaque, never parsed).
        let labels = |k: Option<usize>| {
            k.map_or(("?", "?"), |k| {
                let p = &plans[misses[k]];
                (p.component_id, p.job_id)
            })
        };
        let fresh = match results_in_request_order(&req, resp.results) {
            Ok(v) => v,
            Err(JobResultError::Threw { id, k, error }) => {
                let (component_id, job_id) = labels(k);
                tracing::error!(route = %route.id, component_id, job_id, call_id = %id, %error, "job threw");
                return body::error_500();
            }
            Err(JobResultError::NoValue { id, k }) => {
                let (component_id, job_id) = labels(k);
                tracing::error!(route = %route.id, component_id, job_id, call_id = %id, "job result has neither value nor error");
                return body::error_500();
            }
            Err(JobResultError::Missing { k }) => {
                let p = &plans[misses[k]];
                tracing::error!(route = %route.id, component_id = %p.component_id, job_id = %p.job_id, "jobs response has no result for {}", req.jobs[k].id);
                return body::error_500();
            }
        };
        for (k, (v, &i)) in fresh.iter().zip(&misses).enumerate() {
            if let Err(e) = check_value(&plans[i], v) {
                tracing::error!(route = %route.id, component_id = %plans[i].component_id, job_id = %plans[i].job_id, call_id = %req.jobs[k].id, error = %e, "job result does not fit its outputs");
                return body::error_500();
            }
            note_missing_slots(s, &plans[i], v);
        }
        for (v, &i) in fresh.into_iter().zip(&misses) {
            let p = &plans[i];
            let v = Arc::new(v);
            s.jobs.insert(p.key.clone(), Arc::clone(&v), p.ttl, p.tags, p.user_key.as_deref());
            values[i] = Some(v);
        }
```
(the owner fan-out loop `for i in 0..plans.len() { if values[i].is_none() { values[i] = values[owner[i]].clone(); } }` stays as is). Add next to `jobs_request`:
```rust
/// Why a worker's `results` cannot be used; `k` is the request position
/// (`req.jobs[k]`, = `misses[k]`), `None` for an id the request never sent.
enum JobResultError {
    Threw { id: String, k: Option<usize>, error: String },
    NoValue { id: String, k: Option<usize> },
    Missing { k: usize },
}

/// The worker's results in request order (`out[k]` answers `req.jobs[k]`):
/// one `id → k` index, one pass. An id the request never sent is ignored, a
/// repeated id keeps its last value, an error wins over a missing result —
/// exactly the former two-map behaviour.
fn results_in_request_order(
    req: &JobsRequest,
    results: Vec<JobResult>,
) -> Result<Vec<Value>, JobResultError> {
    let pos: HashMap<&str, usize> = req
        .jobs
        .iter()
        .enumerate()
        .map(|(k, c)| (c.id.as_str(), k))
        .collect();
    let mut out: Vec<Option<Value>> = std::iter::repeat_with(|| None).take(req.jobs.len()).collect();
    for res in results {
        let k = pos.get(res.id.as_str()).copied();
        if let Some(error) = res.error {
            return Err(JobResultError::Threw { id: res.id, k, error });
        }
        let Some(value) = res.value else {
            return Err(JobResultError::NoValue { id: res.id, k });
        };
        if let Some(k) = k {
            out[k] = Some(value);
        }
    }
    out.into_iter()
        .enumerate()
        .map(|(k, v)| v.ok_or(JobResultError::Missing { k }))
        .collect()
}
```
`JobPlan` may no longer need to be imported by name here; let clippy tell you (`-D warnings` catches an unused import).

Reviewer-flag sweep in the same functions (do, and list in the note): `extra.into()` (Vec → `Arc<[_]>`) now happens only on the store path; `p.key.clone()` (`JobKey(String)`) per insert stays — `plans` is borrowed immutably by `merge_values` afterwards and `JobKey` has no `Default` to `mem::take` from; `meta.route = route.id.clone()` (one `String` per request for the log line) stays — a borrowed `PageMeta<'_>` touches `handle`'s signature and the logging tests; both are listed as follow-ups for the lead, not done here.

- [ ] **Step 4: Run**
```bash
cargo test -p brust-server 2>&1 | grep -E 'test result|FAILED|panicked'
cargo clippy -p brust-server --no-deps -- -D warnings && cargo fmt --all -- --check
```
Expected: all `ok`, incl. `results_in_request_order_*`, `page_response_appends_cache_encoding_and_vary_in_order`, and the unchanged `tests/server.rs` (`job_error_is_500_and_not_cached`, `job_result_without_value_is_500_and_not_cached`, the HIT/gzip/Vary tests) and `tests/logging.rs`.

- [ ] **Step 5: Byte-identical check (release addon)**
```bash
cd packages/brust && bun run build && cd ../.. && $OUT/snap.sh p5
for n in _ _pokemon_pikachu; do cmp $OUT/body-before$n $OUT/body-p5$n && diff $OUT/hdr-before$n.norm $OUT/hdr-p5$n.norm && echo "IDENTICAL $n"; done
```
Expected `IDENTICAL` twice (headers in the same order: content-type, [loader headers], x-brust-cache, [vary]).

- [ ] **Step 6: TS gates with a fresh debug addon, then commit**
```bash
cd packages/brust && bun run build:debug && bun test test/napi-server.test.ts && cd ../..
cd examples/pokedex && bun test && cd ../..
bun test --timeout 120000 tests/server/pokedex.test.ts
git diff --quiet crates/brust-napi packages/brust/src/worker.ts && echo clean && git status --short   # pipeline.rs (+ l1.rs doc line)
git add crates/brust-server/src/pipeline.rs crates/brust-server/src/cache/l1.rs
git commit -m "perf(server): build page headers once; one-pass job result re-index (M3-P P5)

page_response takes the response HeaderMap by value: a BYPASS or uncached
render sends the only map it built; a stored render clones once for the L1
entry; a HIT still clones the shared entry's. Job results are placed by one
call-id → request-position index (results_in_request_order) instead of two
HashMaps; unknown/duplicate/missing/error cases keep the old outcomes and
log lines (unit-tested).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Measure after P5, refresh the attribution patch, regenerate RESULTS, READY

**Files:**
- Modify: `bench/attribution.patch` (dispatch.rs and pipeline.rs hunks rewritten for the new shapes), `bench/RESULTS.md`, `bench/RESULTS.json`

- [ ] **Step 1: Bench (after P5)** — Task 1 Step 2 commands with `tee $OUT/bench-p5.txt`; this time KEEP `bench/RESULTS.md` and `bench/RESULTS.json` (they are the lane's regenerated result). Paste the B/C identity rows and Δ vs before and vs after-P0.

- [ ] **Step 2: Refresh the attribution patch for the new code.** `git apply --3way bench/attribution.patch` will reject the `crates/brust-server/src/dispatch.rs` hunk (the spawned task is gone) and the two `pipeline.rs` hunks around the jobs block and `page_response`. Re-instrument by hand with the same stage ids: in `call_worker` keep `CW_CLAIM`, `CW_SER`, `CW_REQ_BYTES`, `CW_DISPATCH`, `CW_RESP_BYTES`, the perf tail read, `CW_READ_PARSE`, `CW_TOTAL`; drop `CW_SPAWN_SCHED` and `CW_JOIN` (no spawn, no join — `attribution.ts` skips a stage with zero calls); the `(parsed, Instant)` tuple return is no longer needed. In `pipeline.rs` put `JOBS_CALL`'s `Rec` guard at the top of `if !misses.is_empty() {` and `BODY_RESP` around the new `response_headers`/`page_response` lines. Then:
```bash
cargo check -p brust-server && git diff > $OUT/attribution.patch.new
cd packages/brust && bun run build && cd ../..
BRUST_RELEASE_ADDON=1 BENCH_CONN=120,1 ATTR_SIDES=v2 ATTR_OUT=$OUT/attr-p5.json bun bench/attribution.ts | tee $OUT/attr-p5.txt
git checkout -- Cargo.lock crates/ packages/brust/src/worker.ts && rm -f crates/brust-server/src/perf.rs
cp $OUT/attribution.patch.new bench/attribution.patch && git apply --check bench/attribution.patch && echo PATCH-OK
git diff --quiet crates/ packages/brust/src/worker.ts && echo clean
grep -rn '_brust/perf\|mod perf' crates/brust-server/src || echo no-perf-in-tree
cd packages/brust && bun run build && cd ../..
```
Paste the c=120 B and C stage tables (before / after P0 / after P5) side by side in the note: `CW_TOTAL`, `CW_CLAIM`, `CW_SER`, `CW_DISPATCH`, `BRIDGE`, `CW_JS_TOTAL`, `CW_READ_PARSE`, `RENDER_CHAIN`, `BODY_RESP`, `SVC_TOTAL`, CPU µs/req. Expected: `CW_TOTAL − CW_DISPATCH − CW_READ_PARSE` (the bridge overhead on our side) shrinks by the former `CW_SPAWN_SCHED + CW_JOIN`; `BODY_RESP` down.

- [ ] **Step 3: Full gate list** (every line in Global Constraints, in this order; paste the `test result` lines):
```bash
cargo fmt --all -- --check
cargo clippy -p brust-compiler -p brust-compiler-cli -p brust-jinja -p brust-server -p brust-napi --no-deps -- -D warnings
cargo clippy -p brust-compiler --no-deps -- -D warnings
cargo test --workspace --exclude bun_react_compiler 2>&1 | grep -E 'test result|FAILED' | sort | uniq -c
cargo test -p brust-compiler 2>&1 | grep -E 'test result'
cd packages/brust && bun run build:debug && bun run typecheck && bun test test/routes.test.ts test/cache.test.ts test/worker.test.ts test/config.test.ts test/napi-compile.test.ts test/build-compile.test.ts && bun test test/napi-server.test.ts && bun test test/build-manifest.test.ts && bun test test/cli.test.ts && bun test --timeout 120000 test/e2e.test.ts && cd ../..
cd examples/pokedex && bun test && bun run typecheck && cd ../..
bun test --timeout 120000 tests/server/pokedex.test.ts
bun test --timeout 120000 tests/server/hydrate.chromium.test.ts
bun build --no-bundle bench/run.ts > /dev/null
```

- [ ] **Step 4: Commit the results and the refreshed patch**
```bash
git status --short      # bench/RESULTS.md, bench/RESULTS.json, bench/attribution.patch — nothing else
git add bench/RESULTS.md bench/RESULTS.json bench/attribution.patch
git commit -m "bench: results after M3-P P0+P5; attribution.patch for the inline call_worker

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git log --oneline m3p..HEAD     # 5 commits: patch rebase, P0, P5 kind, P5 call_worker, P5 response, results
```

- [ ] **Step 5: READY note** (post on the Conclave task; the lead merges into `m3p`):
```
READY lane/m3p-a-alloc-bridge @ <sha>  (base m3p @ <sha>)

| probe (identity, oha -c 120 -z 10s) | before | after P0 | after P5 | 0.1.x (same runs) |
| B /pokemon/{name}?nocache=1 rps / p50 / p99 | … | … (Δ…%) | … (Δ…%) | … |
| C / rps / p50 / p99                          | … | … | … | … |
gzip columns: …   load average at start of each run: …   Bun …   host darwin/arm64

attribution (µs/req, c=120): CW_TOTAL …→…→…, CW_SPAWN_SCHED+CW_JOIN …→(gone), BRIDGE …, CW_READ_PARSE …,
RENDER_CHAIN …, BODY_RESP …, SVC_TOTAL …, CPU/req …  (c=1 rows: …)
P0 evidence: nm counts (_mi_ …, _mi_version present, 0 undefined); Linux legs built by release.yml only (unverified locally)
P4 path taken: &'static str in Function<…> (or: build_callback fallback)
byte-identical: snap.sh before/p0/p5 → IDENTICAL ×2 at each point
gates: <paste test result lines>  guard: `git diff --quiet crates/ packages/brust/src/worker.ts` clean at every commit;
grep '_brust/perf|mod perf' → empty
follow-ups for the lead: JobKey clone per insert; PageMeta.route String per request; HIT path still clones the entry's HeaderMap (shared entry)
```

## Self-review

**Spec coverage.**
- §2 P0 `mimalloc` as the addon's global allocator, `brust-napi/src/lib.rs`, `Cargo.toml` → Task 2 (plus the brust-compiler feature the fake allocator forces; measured in Task 3 "measure first so later deltas are clean").
- §2 P5 "no `kind_str().to_string()` per call" (`brust-napi/src/dispatch.rs:91`) → Task 4.
- §2 P5 "no `tokio::spawn` per call (await the tsfn future inline)" (`brust-server/src/dispatch.rs:198`) → Task 5.
- §2 P5 "no `HeaderMap` clone in `page_response`" (`pipeline.rs:588-611`) and "single re-index of job results" (`pipeline.rs:446-466`) → Task 6.
- §2 per-lane rule "output byte-identical, all gates green, bench B/I before/after + attribution diff in the task note, RESULTS.md regenerated" → Tasks 1, 3, 7 (bench + attribution at three points; RESULTS regenerated once). This lane measures with today's pokedex bench (B, C) per §4 ("`m3p-a` measures with today's pokedex bench while `m3b` is in flight").
- §7 integration branch, no PR, READY to the lead → Global Constraints + Task 7 Step 5.
- §5 stop rule: not this lane's call; the note reports the two consecutive-lever deltas so the lead can apply it.

**Risk ledger.**
1. `Detach` + `catch_unwind`: a panic inside the inner async block unwinds through its `poll`, dropping its live locals (`claim`, `entry`) — that is how the slot is released; the poisoned future is then dropped, never re-polled, never spawned. If a reviewer doubts the unwind-drops-locals claim, the Task 5 panic test is the proof (slot claimable after the panic).
2. `tokio::runtime::Handle::try_current()` in `Detach::drop`: the drop happens inside the hyper task (deadline) or inside hyper's drop of the request future (disconnect) — both on the runtime. Only runtime shutdown lands in the `Err` arm, where releasing is harmless.
3. mimalloc musl: not buildable locally; the `local_dynamic_tls` feature is the mitigation for the dlopen TLS problem, and release.yml's zig legs are the gate. If a Linux leg fails on `cc` for `static.c`, the fallback (lead decision) is to scope the feature to `cfg(not(target_env = "musl"))` for the first merge and open a ledger row.
4. Feature unification: `cargo test --workspace` enables `real-mimalloc` for `brust-compiler-cli` and brust-compiler's tests; `cargo test -p brust-compiler` does not. Both configurations are in the gates so neither the fake nor the real path can rot.
5. The `#[napi]` derive and `&'static str` inside `Function<FnArgs<…>>`: expected to work (typegen maps `str` → `string`); the `build_callback` fallback keeps the d.ts untouched if it does not. The `index.d.ts` diff check is the pin.
6. Header order: `HeaderMap::append` order is the serialisation order; the unit test pins `content-type, x-brust-cache, content-encoding, vary`, and the `curl` header diff pins the real responses.
7. Re-index semantics: the only observable change is which error is logged when a response is BOTH missing a result and carries an ill-fitting one (missing now wins over "does not fit"); both are 500 with nothing cached.
8. Attribution patch hygiene: three apply/revert cycles in this lane; the guard before every commit and the `grep` at READY are the pins. The patch file itself changes twice (rebase, refresh) and is committed on purpose.
