# m3p-b-value-path — P1 worker copies + P2 direct Value parse + P3 string-keyed render values and single buffer
owner: 22499151-e133-4508-b358-d7fa4d2851c3 · authority: in-loop · base: m3p (after m3p-a) · escalation: lead Detoro via task challenge

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land levers P1, P2 and P3 of the M3-P spec on lane `lane/m3p-b-value-path` (from `m3p`, after `lane/m3p-a-alloc-bridge` is merged). (P1) The worker writes its response UTF-8 straight into the SAB slot with `TextEncoder.encodeInto` (one copy, not two), the loader chain merges into ONE object instead of re-spreading per level, and `jobs_request` borrows each plan's `inputs` instead of deep-cloning them per miss. (P2) The loader and jobs responses are parsed ONCE into a render tree (`brust_jinja::ctx::Node`: string-keyed sorted maps and arrays behind `Arc`s) that the pipeline reads and mutates directly and that minijinja renders through O(1) `Object` views — no `serde_json::Value`, no untagged-enum `Content` buffer, no `value_of` walk of the whole context per request. (P3) Maps are string-keyed (`BTreeMap<Arc<str>, Node>` looked up by `get_value_by_str`, never `BTreeMap<Value, Value>`), each chain component's overlay is a `Scope` view over the base context (no `from_pairs` map, no `MergeDict` per component), and the chain is rendered into one `String` sized from the route's last document length, through an in-place `inject_assets`. Every rendered byte and every header stays identical (pokedex + bench-app `curl` diffs, snapshot tests, the pokedex plan golden). Each lever is measured separately — bench probes D and I (identity) with `bench/run.ts` plus the `attribution.ts` stage tree — and the numbers go in the task notes; `bench/RESULTS.md` is regenerated once, at the end.

**Architecture:** Three levers, nine code tasks, one shape decision. The decision is **(a)**: one conversion, at the parse. `crates/brust-jinja/src/ctx.rs` (new) defines `Node { Null, Bool, Num(serde_json::Number), Str(Arc<str>), Arr(Arc<CtxArr>), Map(Arc<CtxMap>) }` with `CtxMap(BTreeMap<Arc<str>, Node>)` and `CtxArr(Vec<Node>)`. `CtxMap`/`CtxArr` implement minijinja `Object` (string-keyed `get_value_by_str`, sorted enumeration = exactly `serde_json::Map`'s order, so `{% for k in obj %}`, `keys`, `entries` and `json_attr` paint the same bytes), `Node::to_value()` is an `Arc` bump for maps/arrays/strings (zero copy), mutation goes through `Arc::make_mut` (unique during the pipeline → in place; a node shared with the job cache → copy-on-write, never aliasing). The pipeline's mutation sites are few and all in `pipeline.rs` (listed in Task 6 with lines) and its readers are `inputs.rs` (`Path::get`, `Projection::eval`, `PropsMap::eval`, `canonical`, `job_key`) plus six small helpers — all ported 1:1 from `serde_json::Map` to `BTreeMap<Arc<str>, Node>`. Job-cache values become `Arc<Node>`: merging a cached value into the context is an `Arc` clone, not a deep copy. `json_attr` gets a downcast fast path over `CtxMap`/`CtxArr`/`MapView` that writes JSON + attribute escape straight from the tree (the D page's `x-props` of 151 rows never becomes minijinja values). Option **(b)** — keep `serde_json::Value` and make `value_of` a zero-copy `Object` wrapper — is rejected: a child view would need a raw pointer into the parent `Arc` (unsafe self-reference) or an `Arc` per node (= (a) anyway), it keeps the untagged `Content` buffering and the deep clones in `merge_result`, and strings would still be copied at every access. The cost of (a) is a mechanical port (~500 lines, mostly tests) pinned three ways: the pokedex plan golden (`seed + merge == captured ctx`, keys and inputs unchanged), a Node-vs-`value_of` render equivalence sweep, and the `curl` diffs.

**Tech Stack:** Rust nightly-2026-09-15, minijinja 3.0.0 (`Object::get_value_by_str`, `Enumerator::{Values, Seq}`, `Value::from(Arc<str>)`, `Value::from_dyn_object(Arc<T>)`, `downcast_object_ref`, `Template::render_captured_to(ctx, io::Write)`), serde 1 / serde_json 1 (manual `Visitor`s), Bun canary (`TextEncoder.encodeInto` on a `SharedArrayBuffer` view), `oha`, criterion (`cargo bench -p brust-server --bench render`, `-p brust-jinja --bench json_attr`).

**Spec:** `docs/design/2026-10-10-m3-perf-bench-design.md` §0 (goal, bar F68 on D and I), §2 rows P1, P2, P3 (files and expected deltas), §4 (lane row `m3p-b-value-path`, complex / complex review Mellow; perf lanes serial after wave 1), §5 (stop rule, acceptance), §7 (integration branch `m3p`, no per-lane PR). Sibling: `docs/plans/2026-10-10-m3p-a-alloc-bridge.md` (its Tasks 4-6 define the post-P5 shapes this plan anchors on).

## Global Constraints

- Lane: `cd /Users/detoro/code/brust-m3p && git pull --ff-only && git worktree add ../brust-lane-m3p-b-value-path -b lane/m3p-b-value-path m3p` — all work in `/Users/detoro/code/brust-lane-m3p-b-value-path`; base is `m3p` (never `main`, never `v2`). **Start only after `lane/m3p-a-alloc-bridge` is merged into `m3p`** (`git log --oneline m3p | grep -c 'M3-P P5'` ≥ 3). Rebase on m3p after m3p-a merged; the anchors below quote the post-m3p-a code (`call_worker` inline + `Detach`, `kind` as `&'static str`, `page_response(status, HeaderMap, html_len, …)`, `results_in_request_order` one-pass re-index). If the anchors differ from what you find, re-anchor on the text, not the line numbers, and note it in the task note.
- NO PR. When done, post READY on the Conclave task with the numbers (Task 10 note); the lead merges into `m3p`.
- Output byte-identical at every measurement point: `examples/pokedex` tests + `tests/server/pokedex.test.ts` green with no assertion change, the pokedex plan golden unchanged (`benches/fixtures/pokedex/plan-golden.json` not rewritten), AND the `curl` diffs of Task 1 Step 6 (`/` and `/pokemon/pikachu?nocache=1` on the pokedex; `/dex?nocache=1` and `/team?nocache=1` on `bench/apps/brust`; identity; script hashes stripped; headers minus `date`) — `IDENTICAL` ×4 after P1, after P2, after P3.
- Measurement (every time, same host, machine idle: 1-min load ≤ cores):
  - Release addon first: `cd packages/brust && bun run build && cd ../..` (`BRUST_RELEASE_ADDON=1` is your declaration that this is what runs).
  - Bench, D and I identity, v2 vs 0.1.x: `BRUST_RELEASE_ADDON=1 BRUST_01X_DIR=$BRUST_01X_DIR BENCH_LOCK_WS=<your Conclave workspace id> BENCH_LOCK_ID='m3p-b-value-path Dew' bun bench/run.ts --apps brust,brust-01x --probes D,I --enc identity` (`run.ts` flags: `--apps`, `--probes`, `--enc identity|gzip|both`, `--dur 10s`, `--warmup 3s`, `--conn 120`, `--seed`). `run.ts` takes the host lock itself — the exclusive file `/tmp/brust-bench.lock` always, and the blackboard key `bench:host-lock` when `BENCH_LOCK_WS` + `BENCH_LOCK_ID` are set (lead rule `bench-host-lock`; `bench/lib/lock.ts`). Never run a measurement without both layers. After every run except the last: `git checkout -- bench/RESULTS.md bench/RESULTS.json`.
  - Attribution (stage tree): `git apply bench/attribution.patch`, release addon, `BRUST_RELEASE_ADDON=1 BENCH_CONN=120,1 ATTR_SIDES=v2 ATTR_APP=bench ATTR_PROBES=D,I bun $OUT/locked.ts` (the wrapper in Task 1 Step 4 holds the same two-layer lock around `bench/attribution.ts`; `ATTR_APP=bench` is added in Task 1), then `git checkout -- Cargo.lock crates/ packages/brust/src/worker.ts && rm -f crates/brust-server/src/perf.rs` and rebuild the release addon.
  - `BRUST_01X_DIR=/private/tmp/claude-501/-Users-detoro-code-brust/d073159b-8c7b-466d-ae02-a02838faf58a/scratchpad/brust01x` (the m3p-a checkout; `ls $BRUST_01X_DIR/runtime/*.node || (cd $BRUST_01X_DIR/runtime && bun run build)`).
- The applied attribution patch must NEVER be in a commit. Before EVERY commit: `git diff --quiet crates/ packages/brust/src/worker.ts && echo clean` must print `clean` unless the diff is exactly the task's intended files — inspect `git status --short` against the task's file list. `grep -rn '_brust/perf\|mod perf' crates/brust-server/src` must be empty at READY. Committing the refreshed `bench/attribution.patch` FILE (Tasks 1 and 10) is required.
- After ANY Rust edit, rebuild the addon before any TS test: `cd packages/brust && bun run build:debug`. The bench needs `bun run build` (release).
- Never `git add -A` at the repo root; stage files by name.
- Every commit message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Gates (green before each code commit; in full before READY): `cargo fmt --all -- --check` · `cargo clippy -p brust-compiler -p brust-compiler-cli -p brust-jinja -p brust-server -p brust-napi --no-deps -- -D warnings` · `cargo clippy -p brust-compiler --no-deps -- -D warnings` (feature-OFF configuration, from m3p-a) · `cargo test --workspace --exclude bun_react_compiler` · `cargo test -p brust-jinja` · `cargo test -p brust-compiler` (feature OFF) · `cargo bench -p brust-server --bench render --no-run` and `cargo bench -p brust-jinja --bench json_attr --no-run` (benches are not built by `cargo test`; this lane changes their APIs) · `cd packages/brust && bun run build:debug && bun run typecheck && bun test test/routes.test.ts test/cache.test.ts test/worker.test.ts test/config.test.ts test/napi-compile.test.ts test/build-compile.test.ts && bun test test/napi-server.test.ts && bun test test/build-manifest.test.ts && bun test test/cli.test.ts && bun test --timeout 120000 test/e2e.test.ts` · `cd examples/pokedex && bun test && bun run typecheck` · `bun test --timeout 120000 tests/server/pokedex.test.ts` · `bun test --timeout 120000 tests/server/hydrate.chromium.test.ts` · `bun check -p bench && bun build --no-bundle bench/run.ts > /dev/null && bun test bench/lib` (Task 1 edits `bench/attribution.ts`). CI's server job runs each server-starting file alone; do the same when a combined run flakes on a port.
- Do not re-decide: option (a) for P2 (the `Node` tree in `brust-jinja`); maps stay SORTED by key (`BTreeMap`, never `IndexMap`/insertion order — the output order of `{% for k in obj %}` is serde_json's sorted order today and must stay so); job-cache and L1 entries hold `Arc<Node>`; the `LoaderResponse` untagged enum becomes a hand-written `Deserialize` (an untagged enum buffers the whole response into serde's `Content` tree first — that IS the intermediate tree P2 removes); `inject_assets` keeps its tag order and insertion point; no buffer pool (a fresh `String::with_capacity(hint)` per request — a pool is a follow-up, see Review Focus 5).
- Boundary: `packages/brust/src/worker.ts`, `packages/brust/test/worker.test.ts`, `crates/brust-jinja/src/{lib.rs,ctx.rs}`, `crates/brust-jinja/benches/json_attr.rs` (only if its API use breaks), `crates/brust-server/src/{protocol.rs,pipeline.rs,inputs.rs,render.rs,config.rs,server/mod.rs,lib.rs}`, `crates/brust-server/src/cache/{job_cache.rs,l1.rs}`, `crates/brust-server/tests/{fake_bun.rs,render.rs}`, `crates/brust-server/benches/render.rs`, `bench/attribution.ts`, `bench/attribution.patch`, `bench/RESULTS.{md,json}` (Task 10 only). Not touched: `dispatch.rs` (both crates), `pool.rs`, `native.rs`, the compiler, `routes.ts`, `run.ts`.

## Review Focus

1. **SAB slot overflow with `encodeInto`.** Today `writeSlot` encodes the whole JSON, compares `byteLength > sub`, substitutes `{"error":"response too large: <bytes> > <sub>"}` (and, if even that does not fit, the first `sub` bytes of `{"error":"too large"}`), and `view.set`s — the neighbouring slot is never touched and the Rust reader gets a parsable error or a `BadResponse`. With `encodeInto` into `view.subarray(slot*sub, slot*sub+sub)` the overflow is detected as `read < json.length` (the encoder stops at the last whole code point that fits; it never writes past the subarray) and the same two substitutions follow, with the exact byte count from `Buffer.byteLength(json)` (overflow path only). Pinned by: the existing `writeSlot stays inside the slot and substitutes an error when too large` test unchanged (`response too large: 111 > 64`), plus Task 2's `writeSlot: multi-byte overflow reports UTF-8 bytes, exact fit succeeds, tiny slot truncates like before` and `encodeInto writes into a SharedArrayBuffer view` (a real SAB, as in production), and `call_worker_returns_bad_response_on_len_over_capacity` (Rust side, unchanged).
2. **Key ordering of maps changing template output.** A loader's object renders through `{% for k in obj %}`, `obj | keys`, `obj | entries`, `obj | json_attr`, `obj | style_css` in serde_json's SORTED key order today (`serde_json::Map` is a `BTreeMap<String, Value>`; `value_of` then builds minijinja's `BTreeMap<Value, Value>`, sorted the same way). `CtxMap` is `BTreeMap<Arc<str>, Node>` — same order by construction; the `Scope` view enumerates the union of its layers sorted (as `MergeDict` does). Pinned by: Task 5's `node_renders_like_value_of_for_every_json_shape` sweep (random JSON with UNSORTED keys, nested maps/arrays, every number form, unicode, through a template battery: `for k in`, `for k, v in`, `keys`, `entries`, `json_attr`, `style_css`, `length`, `in`, `==`, `is defined`, `[idx]`, negative index, `.attr`, `e`, `js_string`, `attr_str`, `join`, `includes`) asserting byte equality against the `value_of(serde_json::Value)` path; the pokedex plan golden; the `curl` diffs.
3. **`json_attr` / `e` escaping over the new map type.** The `json_attr` fast path writes JSON from `Node` directly (`write_json_attr_str` for every string and key, `serde_json::Number`'s `Display` — the same ryu/itoa text the serializer and today's one-pass number arm already use — for numbers, `null`/`true`/`false` literals); a `Node` never holds `undefined`, a repeated key or a non-string key, so the writer never bails. `e` over `Node::Str` goes through `ValueKind::String` → `escape_text(as_str())` as today (an `Arc<str>` value instead of a `SmallStr`/copied `Arc<str>` — same bytes). Pinned by: Task 5's `json_attr_over_node_matches_the_three_pass_reference` (the existing `gen_string`/C0-control/specials generator, now producing JSON, compared with `json_attr_slow` over `value_of` of the same JSON), the existing `json_attr_one_pass_matches_the_three_pass_reference` and `escaping_table` unchanged, and `props_view_paints_like_the_cloned_props` re-pointed at `MapView`.
4. **Overlay view aliasing a mutated context.** A `Scope` holds `Arc` clones of `ctx["__own"][id]` / `ctx["__children"][id]` and of the base map; the pipeline mutates the context only BEFORE `render_document` (`merge_loader_data`, `seed_child_slots`, `merge_values`) and through `Arc::make_mut`, so a node shared with the job cache (a cached value merged in) is copied on write, never written through. Pinned by: Task 6's `merging_a_cached_value_never_mutates_the_cache_entry` (insert a cached `Arc<Node>` map into a cell, then mutate the cell → the cached node is unchanged, `Arc::strong_count` evidence), the golden `seed + merge rebuild the captured ctx`, Task 8's `scope_lookup_order_matches_the_merge_dict` (outlet > `_props` > own > children > ids > base, undefined skipped) and `scope_sees_the_context_as_rendered_not_as_later_mutated` (a scope built, the context mutated through `make_mut`, the scope still paints the old value), and `jinja_round_trip` / `outlet_composes_leaf_first` unchanged.
5. **Buffer reuse leaking bytes between requests.** There is no pool: `render_document` allocates `String::with_capacity(hint)` per request from `Server::render_hints[route]` (a size, never bytes), and `render_chain_into` starts with `out.clear()` so a caller that does hand it a used buffer still gets exactly the document. Pinned by: Task 9's `render_chain_into_clears_and_never_depends_on_capacity` (render A then B into one `String` → B exact; hint 0 vs 1 MiB → identical bytes; a pre-filled junk buffer → identical bytes), `inject_assets_into_equals_inject_assets` (same tags, same insertion point, spare capacity irrelevant), `hint_follows_the_last_document_length` and the `curl` diffs (`cmp` of 4 bodies before/after P3).

## Dispatch table

Lane tier: **complex** — `review: complex` (spec §4: implementer Dew, reviewer Mellow). Per-task tiers below are for the Coordinator's gate routing only.

| slug-task | tier | role | deps | acceptance (gate commands + READY evidence) |
|---|---|---|---|---|
| `m3p-b-value-path-1` baseline | routine | implementer | m3p-a merged into `m3p`; lane created | `git apply --check bench/attribution.patch` OK on HEAD (rebased here only if m3p-a's Task 7 left it broken); bench D/I identity table (v2 + 0.1.x) and attribution trees (pokedex B/C and bench D/I, c=120 and c=1) pasted; 4 `curl` fixtures saved; `$OUT/locked.ts` works; commit `bench: attribution.ts measures the bench app (ATTR_APP=bench, probes D/I)` (+ the rebased patch if needed) |
| `m3p-b-value-path-2` P1 worker | standard | implementer | task 1 | `cd packages/brust && bun test test/worker.test.ts` green incl. 3 new tests; `bun run typecheck`; `bun test test/napi-server.test.ts` + `test/e2e.test.ts` green; `curl` diff IDENTICAL ×4; commit `perf(worker): encodeInto straight into the SAB slot; loaders merge into one object (M3-P P1)` |
| `m3p-b-value-path-3` P1 jobs_request | routine | implementer | task 2 | `cargo test -p brust-server` green (`jobs_request_is_camel_case`, `results_in_request_order_*`, `pokedex_plans_match_the_golden`, `tests/fake_bun.rs`); `grep -n 'inputs.clone()' crates/brust-server/src/pipeline.rs` empty; commit `perf(server): jobs_request borrows plan inputs, no deep clone per miss (M3-P P1)` |
| `m3p-b-value-path-4` measure P1 | routine | implementer | task 3 | bench D/I + attribution after P1 pasted with Δ vs Task 1 (`CW_JS_STRINGIFY`, `CW_JS_WRITE`, `CW_SER`, `CW_REQ_BYTES`); no committed change to RESULTS.*; guard `clean` |
| `m3p-b-value-path-5` P2 Node | complex | implementer | task 4 | `cargo test -p brust-jinja` green incl. the 6 new ctx tests; `cargo bench -p brust-jinja --bench json_attr --no-run`; clippy clean; commit `perf(jinja): ctx::Node — string-keyed Arc-shared render tree with zero-copy minijinja views (M3-P P2)` |
| `m3p-b-value-path-6` P2 wire | complex | implementer | task 5 | `cargo test --workspace --exclude bun_react_compiler` green with `plan-golden.json` unchanged (`git diff --quiet crates/brust-server/benches/fixtures`); `grep -c 'serde_json::Value' crates/brust-server/src/pipeline.rs` → 0 outside tests; the full TS gate list green; `curl` diff IDENTICAL ×4; commit `perf(server): parse worker responses straight into ctx::Node; pipeline over Node (M3-P P2)` |
| `m3p-b-value-path-7` measure P2 | routine | implementer | task 6 | bench D/I + attribution after P2 pasted with Δ vs P1 (`CW_READ_PARSE`, `CTX_VALUE` (gone), `OVERLAY`, `RENDER_CHAIN`, `MERGE_RESULTS`, `SEED`); criterion `render_chain`/`ctx_to_value` before/after; guard `clean` |
| `m3p-b-value-path-8` P3 overlays | standard | implementer | task 7 | `cargo test -p brust-server render` + pipeline tests green incl. 2 new scope tests; `grep -n 'from_pairs\|context! {' crates/brust-server/src/render.rs` → only in tests; `curl` diff IDENTICAL ×4; commit `perf(render): overlays as a Scope view — no per-component map build (M3-P P3)` |
| `m3p-b-value-path-9` P3 buffer | standard | implementer | task 8 | 3 new render tests green; criterion `render_chain`/`finish_identity` before/after for A and B pasted (the 16 KiB writer threshold validated or adjusted, see Task 9 Step 5); `curl` diff IDENTICAL ×4; commit `perf(render): render the chain into one hinted buffer; inject_assets in place (M3-P P3)` |
| `m3p-b-value-path-10` measure + READY | routine | implementer | task 9 | bench after P3 pasted; `bench/RESULTS.{md,json}` regenerated (full `bun run bench` with all apps) and committed; `bench/attribution.patch` refreshed and committed; full gate list green; READY note with the four-point table, attribution deltas, lane HEAD sha, guard evidence |

## File structure

```
packages/brust/src/worker.ts                      writeSlot via encodeInto (one copy); loader merge = Object.assign into one object
packages/brust/test/worker.test.ts                + overflow (multi-byte, exact fit, tiny slot), SAB view, no-mutation-of-loader-return tests
crates/brust-jinja/src/ctx.rs                     NEW: Node / CtxMap / CtxArr / MapView; Object impls; Serialize/Deserialize; From<serde_json::Value>; write_node/write_map (json_attr fast path); tests
crates/brust-jinja/src/lib.rs                     pub mod ctx; write_json_attr downcast fast path; write_json_attr_str pub(crate)
crates/brust-server/src/protocol.rs               JobsRequest<'a>/JobCall<'a> (borrowed); LoaderResponse manual Deserialize over Node; Verdict::NotFound { data: Node }; JobResult { value: Option<Node> }
crates/brust-server/src/inputs.rs                 Path::get / Projection::eval / PropsMap::eval / canonical / job_key / project / child_props over Node
crates/brust-server/src/pipeline.rs               ctx as Node end to end; overlays via Overlay; render_document into a hinted String; props_view → MapView
crates/brust-server/src/render.rs                 Overlay + Scope (Object); render_chain_into; inject_assets_into; render_chain/render_chain_value kept for tests
crates/brust-server/src/cache/job_cache.rs        Arc<Value> → Arc<Node> (+ tests)
crates/brust-server/src/cache/l1.rs               CachedEntry.ctx: Arc<Node>; insert(ctx: Arc<Node>) (+ tests)
crates/brust-server/src/config.rs                 Server.render_hints: Vec<AtomicUsize>
crates/brust-server/src/server/mod.rs             render_hints built in start()
crates/brust-server/src/lib.rs                    bench re-exports (props_view signature)
crates/brust-server/tests/fake_bun.rs             JobCall<'a> construction
crates/brust-server/tests/render.rs               unchanged API (render_chain over serde_json kept) — verify only
crates/brust-server/benches/render.rs             ctx fixtures → Node; ctx_to_value → Node::from(json) ; props_view(&Node)
bench/attribution.ts                              ATTR_APP=bench (probes D, I against bench/apps/brust)
bench/attribution.patch                           checked (Task 1), refreshed (Task 10)
bench/RESULTS.md, bench/RESULTS.json              regenerated (Task 10 only)
```

---

### Task 1: Baseline — lane, patch check, attribution for D/I, bench + attribution before, curl fixtures

**Files:**
- Modify: `bench/attribution.ts` (`ATTR_APP=bench`), `bench/attribution.patch` (only if it does not apply on HEAD)
- Create (scratch, not committed): `$OUT/locked.ts`, `$OUT/snap.sh`

**Interfaces:** `bench/attribution.ts` gains env `ATTR_APP` (`pokedex` default | `bench`): with `bench` it builds/starts `bench/apps/brust` on `:38211` and probes `D` (`/dex?nocache=1`) and `I` (`/team?nocache=1`) (`B`/`C` stay the pokedex probes); side `01x` is skipped for `bench`. Produces: the "before" row of the four-point table, the stage trees before P1, and the `curl` fixtures.

- [ ] **Step 1: Create the lane and the scratch dir**
```bash
cd /Users/detoro/code/brust-m3p && git pull --ff-only && git log --oneline -8 | grep 'M3-P P5' | wc -l    # expect ≥ 3 (m3p-a merged); if 0, STOP and ask the lead
git worktree add ../brust-lane-m3p-b-value-path -b lane/m3p-b-value-path m3p
cd /Users/detoro/code/brust-lane-m3p-b-value-path && git log --oneline -1
export OUT=<your scratchpad directory>/m3p-b && mkdir -p $OUT
export BRUST_01X_DIR=/private/tmp/claude-501/-Users-detoro-code-brust/d073159b-8c7b-466d-ae02-a02838faf58a/scratchpad/brust01x
ls $BRUST_01X_DIR/runtime/*.node || (cd $BRUST_01X_DIR/runtime && bun run build)
bun install --frozen-lockfile
```

- [ ] **Step 2: Patch check (and rebase only if needed)**
```bash
git apply --check bench/attribution.patch && echo PATCH-OK
```
m3p-a's Task 7 refreshes the patch for the inline `call_worker` and the new response block; expect `PATCH-OK`. If it fails instead, do exactly m3p-a Task 1 Step 3 (apply what applies with `patch -p1 --forward --reject-file=-`, place the rejected hunks by hand at the same stage ids — `CW_*` in `call_worker` now inside the `Box::pin(async move { … })` of the `Detach` call with no `CW_SPAWN_SCHED`/`CW_JOIN`; `JOBS_CALL` at the top of `if !misses.is_empty() {`; `BODY_RESP` around `response_headers`/`page_response`), `cargo check -p brust-server`, `git diff > bench/attribution.patch.new`, revert the sources, move the new patch in, and `git apply --check` again. Record which it was.

- [ ] **Step 3: `ATTR_APP=bench` in `bench/attribution.ts`.** Current:
```ts
const PROBES = (process.env.ATTR_PROBES ?? 'B,C').split(',')
const SIDES = (process.env.ATTR_SIDES ?? 'v2,01x').split(',')
…
const target = (side: string, base: string, probe: string) =>
  probe === 'B' ? ['--rand-regex-url', `${base}/pokemon/(${NAMES.join('|')})${side === 'v2' ? '\\?nocache=1' : ''}`] : [`${base}/`]
```
→
```ts
const PROBES = (process.env.ATTR_PROBES ?? 'B,C').split(',')
const SIDES = (process.env.ATTR_SIDES ?? 'v2,01x').split(',')
// ATTR_APP=bench: the M3 bench app (bench/apps/brust, probes D = /dex?nocache=1, I = /team?nocache=1) instead of the
// pokedex (probes B, C). The 0.1.x side is pokedex-only and is skipped for the bench app.
const APP = process.env.ATTR_APP === 'bench' ? 'bench' : 'pokedex'
const APP_DIR = APP === 'bench' ? 'bench/apps/brust' : 'examples/pokedex'
/** One URL per probe (D/I: the bench pages; C: the pokedex home); B is a regex over every name. */
const urlOf = (side: string, probe: string): string =>
  probe === 'D' ? '/dex?nocache=1' : probe === 'I' ? '/team?nocache=1' : probe === 'B' ? `/pokemon/pikachu${side === 'v2' ? '?nocache=1' : ''}` : '/'
const target = (side: string, base: string, probe: string) =>
  probe === 'B' ? ['--rand-regex-url', `${base}/pokemon/(${NAMES.join('|')})${side === 'v2' ? '\\?nocache=1' : ''}`] : [`${base}${urlOf(side, probe)}`]
```
`startV2`: `const app = join(ROOT, 'examples/pokedex')` → `const app = join(ROOT, APP_DIR)`. `warm`:
```ts
async function warm(base: string, side: string): Promise<void> {
  if (APP === 'bench') {
    for (const p of ['/dex?nocache=1', '/team?nocache=1', '/types']) for (let i = 0; i < 3; i++) await fetch(`${base}${p}`)
    return
  }
  for (const n of NAMES) await fetch(`${base}/pokemon/${n}${side === 'v2' ? '?nocache=1' : ''}`)
  for (let i = 0; i < 3; i++) await fetch(`${base}/`)
}
```
The side loop: after `if (side === '01x' && !dir) continue` add `if (side === '01x' && APP === 'bench') continue`. The headers probe line `const h = await fetch(\`${srv.base}${probe === 'B' ? '/pokemon/pikachu' + (side === 'v2' ? '?nocache=1' : '') : '/'}\`, …)` → `const h = await fetch(\`${srv.base}${urlOf(side, probe)}\`, …)`. Nothing else changes (the `/_brust/perf` reading, the thread CPU accounting and the stage tree are app-independent).
```bash
bun check -p bench && bun build --no-bundle bench/attribution.ts > /dev/null && echo TS-OK
```

- [ ] **Step 4: The lock wrapper (scratch).** `attribution.ts` predates the host lock; run it through `bench/lib/lock.ts` so both layers (file + blackboard key) are held:
```ts
// $OUT/locked.ts — hold the two-layer bench host lock around `bun bench/attribution.ts` (env passes through).
import { acquireHostLock } from '/Users/detoro/code/brust-lane-m3p-b-value-path/bench/lib/lock'
const release = await acquireHostLock((s) => console.log(`[lock] ${s}`))
const p = Bun.spawn(['bun', 'bench/attribution.ts'], { cwd: '/Users/detoro/code/brust-lane-m3p-b-value-path', stdio: ['inherit', 'inherit', 'inherit'], env: process.env })
const code = await p.exited
release()
process.exit(code)
```
Always invoke it with `BENCH_LOCK_WS=<ws> BENCH_LOCK_ID='m3p-b-value-path Dew'` in the environment.

- [ ] **Step 5: Bench (before)**
```bash
cd packages/brust && bun run build && cd ../..            # RELEASE addon
uptime                                                    # 1-min load ≤ cores
BRUST_RELEASE_ADDON=1 BRUST_01X_DIR=$BRUST_01X_DIR BENCH_LOCK_WS=<ws> BENCH_LOCK_ID='m3p-b-value-path Dew' \
  bun bench/run.ts --apps brust,brust-01x --probes D,I --enc identity | tee $OUT/bench-before.txt
cp bench/RESULTS.json $OUT/RESULTS-before.json && git checkout -- bench/RESULTS.md bench/RESULTS.json
```
Expected shape (committed numbers on this host: D brust 6,148 rps / 144,226 B vs 0.1.x 14,194 rps / 21,860 B; I brust 95,866 vs 93,530):
```
  brust      D identity    6xxx rps  p50 18.xx ms  p99 4x.xx ms  errors 0
  brust-01x  D identity   14xxx rps  …
  brust      I identity   9xxxx rps  …
  brust-01x  I identity   9xxxx rps  …
```
Paste the four rows under **before** in the note (the `bytes/resp` column too: it explains most of D's gap, ledger F70/F71 — not this lane's lever).

- [ ] **Step 6: Attribution (before)** — pokedex B/C and bench D/I:
```bash
git apply bench/attribution.patch && cd packages/brust && bun run build && cd ../..
BRUST_RELEASE_ADDON=1 BENCH_CONN=120,1 ATTR_SIDES=v2 ATTR_OUT=$OUT/attr-before-pokedex.json BENCH_LOCK_WS=<ws> BENCH_LOCK_ID='m3p-b-value-path Dew' bun $OUT/locked.ts | tee $OUT/attr-before-pokedex.txt
BRUST_RELEASE_ADDON=1 BENCH_CONN=120,1 ATTR_SIDES=v2 ATTR_APP=bench ATTR_PROBES=D,I ATTR_OUT=$OUT/attr-before-bench.json BENCH_LOCK_WS=<ws> BENCH_LOCK_ID='m3p-b-value-path Dew' bun $OUT/locked.ts | tee $OUT/attr-before-bench.txt
git checkout -- Cargo.lock crates/ packages/brust/src/worker.ts && rm -f crates/brust-server/src/perf.rs
git diff --quiet crates/ packages/brust/src/worker.ts && echo clean
cd packages/brust && bun run build && cd ../..
```
Expected: `### v2 D c=120 …` / `### v2 I c=120 …` tables (the `/_brust/perf` route answers 200; if the tables are missing the patched addon was not rebuilt). Paste for D and I (c=120): `SVC_TOTAL`, `CW_TOTAL`, `CW_SER`, `CW_REQ_BYTES`, `CW_JS_PARSE`, `CW_JS_HANDLER`, `CW_JS_STRINGIFY`, `CW_JS_WRITE`, `CW_JS_TOTAL`, `CW_RESP_BYTES`, `CW_READ_PARSE`, `COLLECT_JOBS`, `SEED`, `MERGE_RESULTS`, `RENDER_CHAIN`, `CTX_VALUE`, `OVERLAY`, `SCOPE_BUILD`, `TMPL0`, `TMPL1`, `INJECT`, `BODY_RESP`, `unattributed`, CPU µs/req. These are the lane's targets: P1 moves `CW_JS_STRINGIFY`+`CW_JS_WRITE` and `CW_SER`; P2 moves `CW_READ_PARSE`, `CTX_VALUE`, `OVERLAY`, `MERGE_RESULTS`; P3 moves `OVERLAY`, `SCOPE_BUILD`, `TMPL*`, `INJECT`.

- [ ] **Step 7: curl fixtures (before).** Save as `$OUT/snap.sh`; it snapshots BOTH apps and is reused in Tasks 2, 6, 8, 9.
```bash
#!/bin/bash
# usage: snap.sh <label> — pokedex on :38211 (/ and /pokemon/pikachu) + bench app on :38311 (/dex and /team), ?nocache=1,
# identity; bodies with script hashes stripped, headers minus date.
set -e; L=$1; ROOT=$(git rev-parse --show-toplevel); OUT=${OUT:?}; BIN=$ROOT/packages/brust/bin/brust
snap_app() { # <dir> <port> <tag> <paths…>
  local dir=$1 port=$2 tag=$3; shift 3
  ( cd $dir && $BIN build routes.tsx >/dev/null && BRUST_PORT= BRUST_WORKERS= BRUST_ADDR= $BIN start --port $port --workers 2 >$OUT/srv-$L-$tag.log 2>&1 & echo $! > $OUT/srv.pid )
  for i in $(seq 1 150); do grep -q '\[brust\] ready' $OUT/srv-$L-$tag.log && break; sleep 0.2; done
  for p in "$@"; do
    n=$tag${p//\//_}
    curl -s -H 'accept-encoding: identity' -D $OUT/hdr-$L-$n "http://127.0.0.1:$port$p?nocache=1" \
     | sed -E 's/-[0-9a-f]{10}\.js/-HASH.js/g' > $OUT/body-$L-$n
    grep -vi '^date:' $OUT/hdr-$L-$n > $OUT/hdr-$L-$n.norm
  done
  kill $(cat $OUT/srv.pid); sleep 0.5
}
snap_app $ROOT/examples/pokedex 38211 pokedex / /pokemon/pikachu
snap_app $ROOT/bench/apps/brust 38311 bench /dex /team
wc -c $OUT/body-$L-*; cat $OUT/hdr-$L-*.norm
```
And the comparison one-liner used later (`$OUT/cmp.sh <a> <b>`):
```bash
#!/bin/bash
for n in pokedex_ pokedex_pokemon_pikachu bench_dex bench_team; do
  cmp $OUT/body-$1-$n $OUT/body-$2-$n && diff $OUT/hdr-$1-$n.norm $OUT/hdr-$2-$n.norm && echo "IDENTICAL $n"; done
```
```bash
chmod +x $OUT/snap.sh $OUT/cmp.sh && $OUT/snap.sh before
```
Expected: four bodies (pokedex `/` and pikachu tens of KB; `/dex` ~144 KB; `/team` ~0.8 KB), `x-brust-cache: BYPASS` on pikachu, `/dex`, `/team`, no cache header on pokedex `/`.

- [ ] **Step 8: Commit**
```bash
git diff --quiet crates/ packages/brust/src/worker.ts && echo clean
git add bench/attribution.ts          # + bench/attribution.patch only if Step 2 rebased it
git commit -m "bench: attribution.ts measures the bench app (ATTR_APP=bench, probes D/I)

The stage tree (attribution.patch, applied temporarily) was pokedex-only.
ATTR_APP=bench starts bench/apps/brust and probes D (/dex?nocache=1) and
I (/team?nocache=1) so the M3-P value-path levers are attributed on the
pages the F68 bar is measured on. The 0.1.x side stays pokedex-only.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git show --stat HEAD
```

---

### Task 2: P1 — `encodeInto` straight into the slot; loaders merge into one object

**Files:**
- Modify: `packages/brust/src/worker.ts` (`writeSlot` :62-77, `loader` :141-162)
- Test: `packages/brust/test/worker.test.ts`

**Interfaces:** `writeSlot(view: Uint8Array, slot: number, slots: number, json: string): number` — unchanged signature and contract (returns the byte length written, `> 0` for non-empty JSON, `≤ sub`; a response that does not fit is replaced by the same two error substitutions as today). `makeDispatch` unchanged. `loader` returns the same `data` object shape and key order.

- [ ] **Step 1: Failing tests** (append to `packages/brust/test/worker.test.ts`):
```ts
test('writeSlot: multi-byte overflow reports UTF-8 bytes, exact fit succeeds, tiny slot truncates like before', () => {
  const view = new Uint8Array(new SharedArrayBuffer(128))
  view.fill(0x41)
  // 'é' is 2 bytes: 40 chars = 80 bytes > 64 → the exact BYTE count is reported, slot 1 untouched.
  const n = writeSlot(view, 0, 2, JSON.stringify({ s: 'é'.repeat(40) }))
  expect(JSON.parse(new TextDecoder().decode(view.subarray(0, n)))).toEqual({ error: `response too large: ${Buffer.byteLength(JSON.stringify({ s: 'é'.repeat(40) }))} > 64` })
  expect(view[64]).toBe(0x41)
  // Exactly sub bytes fit (64 = {"s":" + 56 + "}).
  const fit = JSON.stringify({ s: 'x'.repeat(56) })
  expect(Buffer.byteLength(fit)).toBe(64)
  expect(writeSlot(view, 1, 2, fit)).toBe(64)
  expect(new TextDecoder().decode(view.subarray(64, 128))).toBe(fit)
  // A slot too small even for the error message: the first `sub` bytes of {"error":"too large"}, as before.
  const tiny = new Uint8Array(new SharedArrayBuffer(16))
  const t = writeSlot(tiny, 0, 1, JSON.stringify({ s: 'x'.repeat(100) }))
  expect(t).toBe(16)
  expect(new TextDecoder().decode(tiny.subarray(0, t))).toBe('{"error":"too la')
})

test('writeSlot encodes into a SharedArrayBuffer view with one copy (no detached intermediate)', () => {
  // encodeInto accepts [AllowShared] Uint8Array: the production view IS over a SAB (run.ts allocates it).
  const sab = new SharedArrayBuffer(SLOT_BYTES)
  const view = new Uint8Array(sab)
  const json = JSON.stringify({ ok: true, data: { name: 'ピカチュウ', n: [1, 2, 3] } })
  const n = writeSlot(view, 0, 1, json)
  expect(n).toBe(Buffer.byteLength(json))
  expect(new TextDecoder().decode(new Uint8Array(sab, 0, n))).toBe(json)
})

test('loader: the merge never mutates an object a loader returned (shared module constants stay intact)', async () => {
  const shared = Object.freeze({ a: 1, b: 'parent' })
  const h = makeHandlers({
    leaves: leaves({ parent: async () => shared, child: async () => ({ b: 'child', c: 3 }) }),
    jobs: {},
  })
  expect(await h.loader(ctx('r1'))).toEqual({ ok: true, data: { a: 1, b: 'child', c: 3 } })
  expect(shared).toEqual({ a: 1, b: 'parent' })
  // Key order is first-seen: a's keys, then new keys — what {...a, ...b} produced.
  expect(Object.keys((await h.loader(ctx('r1')) as { data: object }).data)).toEqual(['a', 'b', 'c'])
})
```
`cd packages/brust && bun test test/worker.test.ts` → the first test fails today only on the "exact fit" sub-check? No: today's `writeSlot` passes all three sub-checks (it is the overflow semantics we are pinning); the frozen-constant test passes too (spread never mutated). They are regression pins for the rewrite; run them and confirm green BEFORE the edit so a red after the edit is unambiguous.

- [ ] **Step 2: `writeSlot`.** Current:
```ts
export function writeSlot(view: Uint8Array, slot: number, slots: number, json: string): number {
  const sub = Math.floor(view.byteLength / Math.max(1, slots))
  let bytes = enc.encode(json)
  if (bytes.byteLength > sub) {
    bytes = enc.encode(JSON.stringify({ error: `response too large: ${bytes.byteLength} > ${sub}` }))
    if (bytes.byteLength > sub) bytes = enc.encode('{"error":"too large"}').subarray(0, sub)
  }
  view.set(bytes, slot * sub)
  return bytes.byteLength
}
```
→
```ts
/** Writes `json` as UTF-8 at the start of `slot`'s sub-region `[slot*sub, slot*sub+sub)`,
 * `sub = floor(view.byteLength / slots)`; returns the byte length (> 0, ≤ sub). ONE copy: the
 * encoder writes straight into the slot (M3-P P1); it stops at the last whole code point that
 * fits, so `read < json.length` means "did not fit" and the neighbouring slot is never touched.
 * A response that does not fit is replaced by a small `{"error":"response too large: <n> > <sub>"}`
 * (`n` = its exact UTF-8 length, computed only on this path). */
export function writeSlot(view: Uint8Array, slot: number, slots: number, json: string): number {
  const sub = Math.floor(view.byteLength / Math.max(1, slots))
  const dst = view.subarray(slot * sub, slot * sub + sub)
  const r = enc.encodeInto(json, dst)
  if (r.read === json.length) return r.written
  const err = JSON.stringify({ error: `response too large: ${Buffer.byteLength(json)} > ${sub}` })
  const e = enc.encodeInto(err, dst)
  if (e.read === err.length) return e.written
  // Not even the message fits: the first `sub` bytes of a fixed one (ASCII, so byte = char).
  return enc.encodeInto('{"error":"too large"}', dst).written
}
```
Note on `written` vs the old `bytes.byteLength`: for a fitting string they are equal (`encodeInto` writes the full UTF-8); for the fixed fallback `written = min(21, sub)` = the old `subarray(0, sub).byteLength`.

- [ ] **Step 3: loader merge.** Current (:141-162):
```ts
      let merged: Record<string, unknown> = {}
      try {
        for (const node of leaf.chain) {
          …
          if (isVerdict(r)) return verdictJson(r, merged)
          if (r && typeof r === 'object') merged = { ...merged, ...(r as Record<string, unknown>) }
        }
        return { ok: true, data: merged }
```
→
```ts
      // One object for the whole chain: each level's keys are assigned INTO it (later keys win,
      // first-seen key order — what `{...merged, ...r}` produced) instead of re-spreading every
      // key once per level (M3-P P1). `merged` is fresh per call; a loader's own object is never
      // written to.
      const merged: Record<string, unknown> = {}
      try {
        for (const node of leaf.chain) {
          …
          if (isVerdict(r)) return verdictJson(r, merged)
          if (r && typeof r === 'object') Object.assign(merged, r)
        }
        return { ok: true, data: merged }
```
(`let` → `const`; biome is happy.) `verdictJson(v, merged)` unchanged — it builds `{ ...parent, ...own }`, fresh.

- [ ] **Step 4: Gates + byte-identical check**
```bash
cd packages/brust && bun run typecheck && bun test test/worker.test.ts && bun test test/napi-server.test.ts && bun test --timeout 120000 test/e2e.test.ts && cd ../..
bun test --timeout 120000 tests/server/pokedex.test.ts
cd packages/brust && bun run build && cd ../.. && $OUT/snap.sh p1 && $OUT/cmp.sh before p1
```
Expected: all green; `IDENTICAL` ×4.

- [ ] **Step 5: Commit**
```bash
git diff --quiet crates/ && git status --short      # only worker.ts + worker.test.ts
git add packages/brust/src/worker.ts packages/brust/test/worker.test.ts
git commit -m "perf(worker): encodeInto straight into the SAB slot; loaders merge into one object (M3-P P1)

writeSlot encoded the response into a fresh Uint8Array and copied it into
the slot; TextEncoder.encodeInto writes it once, straight into the slot's
sub-region, and reports an overflow as read < length (same substitutions,
same exact byte count in the message, neighbouring slot untouched). The
loader chain assigned into one object instead of re-spreading per level;
key order and a loader's own objects are unchanged (tests).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: P1 — `jobs_request` borrows plan inputs (no deep clone per miss)

**Files:**
- Modify: `crates/brust-server/src/protocol.rs` (`JobsRequest` :67-71, `JobCall` :73-90, test `jobs_request_is_camel_case` :212-242), `crates/brust-server/src/pipeline.rs` (`jobs_request` — lane :1368; `results_in_request_order` signature — lane :1332; test helper `req_of` — lane :1789), `crates/brust-server/tests/fake_bun.rs` (`JobCall { … }` :41-47)

**Interfaces:**
- Changed: `pub struct JobsRequest<'a> { pub jobs: Vec<JobCall<'a>> }`, `pub struct JobCall<'a> { pub id: String, pub component_id: &'a str, pub kind: JobKind, pub inputs: &'a Value, pub target: Option<&'a str>, pub row: Option<usize> }` (wire JSON identical: `jobs_request_is_camel_case` pins it). `pub(crate) fn jobs_request<'a>(plans: &'a [JobPlan<'a>], misses: &[usize]) -> JobsRequest<'a>`; `fn results_in_request_order(req: &JobsRequest<'_>, results: Vec<JobResult>) -> …`.

- [ ] **Step 1: protocol.rs.** Current:
```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobsRequest {
    pub jobs: Vec<JobCall>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCall {
    /// …
    pub id: String,
    pub component_id: String,
    pub kind: JobKind,
    pub inputs: Value,
    /// …
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// …
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row: Option<usize>,
}
```
→
```rust
/// `jobs` call request: `{ jobs: [{ id, componentId, kind, inputs }] }`. Borrows
/// the plans it is built from (M3-P P1): `inputs` is serialised in place, never
/// cloned per miss.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobsRequest<'a> {
    pub jobs: Vec<JobCall<'a>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCall<'a> {
    /// (doc unchanged)
    pub id: String,
    pub component_id: &'a str,
    pub kind: JobKind,
    pub inputs: &'a Value,
    /// (doc unchanged)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<&'a str>,
    /// (doc unchanged)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row: Option<usize>,
}
```
Test `jobs_request_is_camel_case`: bind the inputs first — `let inputs = json!({"move": {"name": "growl"}});` then `inputs: &inputs`, `component_id: "moveCard_d4"`, `target: None`; second case `let inputs = json!({"productId": "p2"});`, `target: Some("reviews_7")`. Assertions unchanged.

- [ ] **Step 2: pipeline.rs.** `jobs_request` (lane :1368):
```rust
pub(crate) fn jobs_request(plans: &[JobPlan], misses: &[usize]) -> JobsRequest {
    JobsRequest {
        jobs: misses
            .iter()
            .map(|&i| JobCall {
                id: plans[i].call_id(),
                component_id: plans[i].component_id.to_string(),
                kind: plans[i].kind,
                inputs: plans[i].inputs.clone(),
                target: plans[i].target.map(String::from),
                row: plans[i].instance_row(),
            })
            .collect(),
    }
}
```
→
```rust
/// The one batched `jobs` call for the owners in `misses`: borrows each plan's
/// `inputs` (serialised in place — no deep clone per miss, M3-P P1).
pub(crate) fn jobs_request<'a>(plans: &'a [JobPlan<'a>], misses: &[usize]) -> JobsRequest<'a> {
    JobsRequest {
        jobs: misses
            .iter()
            .map(|&i| JobCall {
                id: plans[i].call_id(),
                component_id: plans[i].component_id,
                kind: plans[i].kind,
                inputs: &plans[i].inputs,
                target: plans[i].target,
                row: plans[i].instance_row(),
            })
            .collect(),
    }
}
```
`results_in_request_order(req: &JobsRequest, …)` → `req: &JobsRequest<'_>`. In `page`, `let req = jobs_request(&plans, &misses);` now borrows `plans` for as long as `req` lives — `req` is used after the call (`results_in_request_order(&req, …)`, `req.jobs[k].id` in log lines) and `plans` is only read there and in `merge_values` later: no conflict (the borrow checker will tell you if a `plans[i]` write sneaked in — there is none). The test helper `req_of` (lane :1789): add `static NULL: Value = Value::Null;` above it and use `component_id: "c", inputs: &NULL, target: None` (a `&Value::Null` temporary is NOT promoted to `'static` — `Value` has drop glue — hence the static, the same trick `inputs.rs` uses). `plan_stage::Planned::request_json` compiles unchanged.

- [ ] **Step 3: tests/fake_bun.rs** (:41-47): bind `let inputs = json!({});` and write `component_id: "<same literal>", inputs: &inputs, target: <None or Some("…")>`.

- [ ] **Step 4: Run**
```bash
cargo test -p brust-server 2>&1 | grep -E 'test result|FAILED|panicked'
cargo clippy -p brust-server --no-deps -- -D warnings && cargo fmt --all -- --check
grep -n 'inputs.clone()' crates/brust-server/src/pipeline.rs     # expect: no output
git diff --quiet crates/brust-server/benches/fixtures && echo GOLDEN-UNCHANGED
```

- [ ] **Step 5: Commit**
```bash
git add crates/brust-server/src/protocol.rs crates/brust-server/src/pipeline.rs crates/brust-server/tests/fake_bun.rs
git commit -m "perf(server): jobs_request borrows plan inputs, no deep clone per miss (M3-P P1)

JobsRequest<'a>/JobCall<'a> serialise the plan's inputs, component id and
target by reference; the wire JSON is unchanged (jobs_request_is_camel_case,
plan-golden request JSON).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Measure after P1

**Files:** none committed.

- [ ] **Step 1: Bench (after P1)** — Task 1 Step 5 commands with `tee $OUT/bench-p1.txt`, copy `RESULTS.json` to `$OUT/RESULTS-p1.json`, `git checkout -- bench/RESULTS.md bench/RESULTS.json`. Paste the D/I identity rows and Δ% vs before.
- [ ] **Step 2: Attribution (after P1)** — Task 1 Step 6 commands with `-p1` file names (`git apply --3way bench/attribution.patch`; the `worker.ts` hunk sits in `makeDispatch`, untouched by Task 2 — it must apply; the Rust hunks are untouched by Task 3). Revert, guard `clean`, rebuild release. Paste D and I (c=120): `CW_JS_STRINGIFY`, `CW_JS_WRITE`, `CW_JS_TOTAL`, `CW_SER`, `CW_REQ_BYTES` (jobs call — the bytes are the same, the serialise time should drop), `CW_TOTAL`, `SVC_TOTAL`, CPU µs/req, before → after P1. Expected direction: `CW_JS_WRITE` roughly halves on D (144 KB response: one copy instead of two), `CW_SER` down on the jobs call when there are misses (D/I `?nocache=1` have job-cache HITS after warm-up, so `JB_*`/`CW_SER` of the jobs call only moves on the cold rows — say so if the delta is noise). If nothing moves ≥ 2 % on both probes, write that down; §5's stop rule is the lead's call, and P2/P3 land regardless (§2: "all land").

---

### Task 5: P2 — `brust_jinja::ctx::Node`: the render tree, its minijinja views, the `json_attr` fast path

**Files:**
- Create: `crates/brust-jinja/src/ctx.rs`
- Modify: `crates/brust-jinja/src/lib.rs` (`pub mod ctx;`, `write_json_attr` :250, `write_json_attr_str` :325 → `pub(crate)`)
- Read first: minijinja 3.0.0 `src/value/object.rs` (`trait Object` :175-290, `Enumerator` :740-860, the `impl … Object for Vec<T>` — grep `for Vec<` — for how a Seq object answers `get_value` with an index), `src/value/mod.rs` (`from_dyn_object` :1162, `downcast_object_ref` :1778, `as_usize` :1468), `src/value/argtypes.rs:372` (`From<Arc<str>> for Value`), `src/value/serialize.rs` :80-125 (how `value_of` maps i64/u64/f64/str — the exact reprs `Node::to_value` must reproduce)

**Interfaces** (all `pub` in `brust_jinja::ctx`):
```rust
pub enum Node { Null, Bool(bool), Num(serde_json::Number), Str(Arc<str>), Arr(Arc<CtxArr>), Map(Arc<CtxMap>) }
pub type MapInner = BTreeMap<Arc<str>, Node>;
pub struct CtxMap(pub MapInner);          // minijinja Object, repr Map, string-keyed, sorted
pub struct CtxArr(pub Vec<Node>);         // minijinja Object, repr Seq
pub struct MapView { map: Arc<CtxMap>, hidden: &'static [&'static str] }   // Object: `map` minus `hidden` top-level keys
impl Node {
    pub fn map(m: MapInner) -> Node;  pub fn arr(v: Vec<Node>) -> Node;  pub fn str(s: &str) -> Node;
    pub fn get(&self, key: &str) -> Option<&Node>;  pub fn index(&self, i: usize) -> Option<&Node>;
    pub fn as_map(&self) -> Option<&CtxMap>;  pub fn as_arr(&self) -> Option<&CtxArr>;  pub fn as_str(&self) -> Option<&str>;
    pub fn is_null(&self) -> bool;  pub fn is_map(&self) -> bool;  pub fn is_str(&self) -> bool;
    pub fn map_mut(&mut self) -> Option<&mut MapInner>;   // Arc::make_mut: in place when unique, copy-on-write when shared
    pub fn arr_mut(&mut self) -> Option<&mut Vec<Node>>;
    pub fn to_value(&self) -> minijinja::Value;           // O(1) for Str/Arr/Map
    pub fn view(map: &Arc<CtxMap>, hidden: &'static [&'static str]) -> minijinja::Value;   // MapView
}
impl Default for Node (Null); Clone (O(1) for Arr/Map/Str); PartialEq; Debug
impl Serialize for Node; impl<'de> Deserialize<'de> for Node
impl From<serde_json::Value> for Node; impl From<&Node> for serde_json::Value   // tests, golden, describe()
pub(crate) fn write_node(out: &mut String, n: &Node); pub(crate) fn write_map(out: &mut String, m: &MapInner, hidden: &[&str])   // json_attr fast path
```
Reprs `to_value` must reproduce (what `value_of` makes of the same JSON): `Null` → `Value::from(())` (None), `Bool` → `Value::from(b)`, `Num` → `u64` if `n.as_u64()` (serde_json `PosInt` → `serialize_u64` → `ValueRepr::U64`), else `i64` (`NegInt`), else `f64` (`Float`); `Str` → `Value::from(Arc<str>)` (a `ValueRepr::String`; `value_of` makes a `SmallStr` for short strings — same kind, same `as_str`, same painting/equality); `Arr`/`Map` → `Value::from_dyn_object(Arc::clone(..))` (today's lists/maps are objects too: `Vec<Value>` and `ValueMap`).

- [ ] **Step 1: Failing tests** (`crates/brust-jinja/src/ctx.rs`, `mod tests`, written first; they need the types to compile — write the type skeleton with `todo!()` bodies if you want red first, or write Step 2 and run these as the pins):
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use minijinja::Environment;
    use serde_json::json;

    fn env() -> Environment<'static> {
        let mut env = Environment::new();
        crate::register(&mut env);
        env
    }

    /// The two conversions of the same JSON paint the same bytes for a battery
    /// of template shapes: iteration order, lookups, indexing, filters, equality.
    const BATTERY: &[&str] = &[
        "{% for k in o %}{{ k }}={{ o[k] | json_attr }};{% endfor %}",
        "{% for k, v in o %}{{ k }}:{{ v | js_string }},{% endfor %}",
        "{{ o | keys | join(',') }}|{{ (o | entries) | json_attr }}|{{ o | length }}|{{ l | length }}",
        "{{ o | json_attr }}|{{ l | json_attr }}|{{ s | json_attr }}|{{ n | json_attr }}|{{ b | json_attr }}|{{ z | json_attr }}",
        "{{ o.a | e }}|{{ o['a'] | e }}|{{ o.missing.deep | e }}|{{ l[0] | e }}|{{ l[-1] | e }}|{{ l[9] | e }}|{{ o.a.b.c | e }}",
        "{{ s | e }}|{{ s | attr_str }}|{{ s | js_string }}|{{ n | js_string }}|{{ n | attr_str }}|{{ n | e }}|{{ b | js_string }}|{{ z | js_string }}",
        "{% if 'a' in o %}y{% endif %}{% if o %}t{% endif %}{% if l %}t{% endif %}{% if o == o %}eq{% endif %}{% if l | includes(1) %}inc{% endif %}{% if s | includes('x') %}sx{% endif %}",
        "{{ o is defined }}|{{ o.a is defined }}|{{ o.nope is defined }}|{{ (o | keys) | length }}|{{ l | join('-') }}|{{ s | str_slice(1) }}",
        "{{ sty | style_css }}|{{ sty | keys | join }}|{{ o | truthy }}|{{ z | present }}|{{ b | present }}",
        "{% for x in l %}{{ loop.index0 }}:{{ x | json_attr }}/{% endfor %}{% for x in o.l2 %}{{ x.k | e }}{% endfor %}",
    ];

    fn sample_json(r: &mut Rng) -> serde_json::Value {
        // Keys deliberately unsorted; every number form; unicode; nested maps/lists; empty containers.
        json!({
            "zeta": gen_json(r, 3), "alpha": gen_json(r, 3), "Mid": gen_json(r, 2),
            "o": {"b": 2, "a": {"b": {"c": gen_json(r, 1)}}, "A": "<&'\">", "l2": [{"k": "x"}, {"k": gen_json(r, 0)}], "_": null},
            "l": [1, "two", 3.5, null, true, {"z": 1, "a": [1e21, 1e-7, -0.0, 0.1, 18446744073709551615u64, -9223372036854775808i64, 1.0]}],
            "s": "ไทย<é>😀&'\"\u{7f}\u{2028}", "n": gen_number(r), "b": true, "z": null,
            "sty": {"fontSize": 12, "backgroundColor": "red", "zIndex": 2, "bad;": "x", "margin": 0, "color": null}
        })
    }

    #[test]
    fn node_renders_like_value_of_for_every_json_shape() {
        let env = env();
        let mut r = Rng(0x1234_5678_9ABC_DEF1);
        for i in 0..400 {
            let json = sample_json(&mut r);
            let node = Node::from(json.clone());
            for (t, src) in BATTERY.iter().enumerate() {
                let want = env.render_str(src, crate::value_of(&json)).unwrap();
                let got = env.render_str(src, node.to_value()).unwrap();
                assert_eq!(got, want, "#{i} template {t}: {src}\n{json}");
            }
        }
    }

    #[test]
    fn maps_iterate_in_serde_json_order_and_lookups_are_string_keyed() {
        let n: Node = serde_json::from_str(r#"{"zeta":1,"alpha":{"y":1,"x":2},"Mid":[3,2,1]}"#).unwrap();
        let keys: Vec<&str> = n.as_map().unwrap().0.keys().map(|k| &**k).collect();
        assert_eq!(keys, ["Mid", "alpha", "zeta"]); // byte order, as serde_json::Map
        assert_eq!(n.get("alpha").and_then(|a| a.get("x")), Some(&Node::Num(2.into())));
        assert_eq!(n.get("Mid").and_then(|m| m.index(2)), Some(&Node::Num(1.into())));
        assert_eq!(n.get("nope"), None);
        assert_eq!(n.index(0), None, "a map is not indexable");
        let v = n.to_value();
        assert_eq!(v.get_attr("zeta").unwrap(), minijinja::Value::from(1u64));
        assert!(v.get_attr("nope").unwrap().is_undefined());
        assert_eq!(v.get_attr("Mid").unwrap().get_item_by_index(0).unwrap(), minijinja::Value::from(3u64));
        assert_eq!(v.get_attr("Mid").unwrap().len(), Some(3));
    }

    #[test]
    fn to_value_is_an_arc_bump_and_make_mut_copies_only_when_shared() {
        let mut n: Node = serde_json::from_str(r#"{"a":{"b":[1,2]}}"#).unwrap();
        let Node::Map(root) = &n else { unreachable!() };
        assert_eq!(Arc::strong_count(root), 1);
        let v = n.to_value();
        let Node::Map(root) = &n else { unreachable!() };
        assert_eq!(Arc::strong_count(root), 2, "to_value shares the map");
        drop(v);
        // Unique again: mutation is in place.
        let a_ptr = Arc::as_ptr(match n.get("a") { Some(Node::Map(a)) => a, _ => unreachable!() });
        n.map_mut().unwrap().insert("c".into(), Node::Null);
        assert_eq!(Arc::as_ptr(match n.get("a") { Some(Node::Map(a)) => a, _ => unreachable!() }), a_ptr);
        // Shared with a "cache": the shared subtree is copied on write, the cache's copy untouched.
        let cached = n.get("a").cloned().unwrap();
        n.get_mut_path(&["a", "b"]).unwrap().arr_mut().unwrap().push(Node::Null);
        assert_eq!(serde_json::Value::from(&cached), json!({"b": [1, 2]}));
        assert_eq!(serde_json::Value::from(n.get("a").unwrap()), json!({"b": [1, 2, null]}));
    }

    #[test]
    fn json_attr_over_node_matches_the_three_pass_reference() {
        let env = env();
        let mut r = Rng(0x9E37_79B9_7F4A_7C15);
        for i in 0..5_000 {
            let json = gen_json(&mut r, 4);
            let node = Node::from(json.clone());
            let via_node = env.render_str("{{ v | json_attr }}", minijinja::context! { v => node.to_value() }).unwrap();
            let reference = env.render_str("{{ v | json_attr }}", minijinja::context! { v => crate::value_of(&json) }).unwrap();
            assert_eq!(via_node, reference, "#{i}: {json}");
            // The attribute text decodes to the original JSON.
            let back: serde_json::Value = serde_json::from_str(&crate::tests_support::unescape(&via_node)).unwrap();
            assert_eq!(back, json);
        }
        // Every C0 control, the JSON and attribute specials, the key path.
        let all: String = (0u8..0x80).map(char::from).collect::<String>() + "é😀\u{2028}";
        let json = json!({ all.clone(): all, "k\"<>&'": [all] });
        assert_eq!(
            env.render_str("{{ v | json_attr }}", minijinja::context! { v => Node::from(json.clone()).to_value() }).unwrap(),
            env.render_str("{{ v | json_attr }}", minijinja::context! { v => crate::value_of(&json) }).unwrap()
        );
    }

    #[test]
    fn map_view_hides_top_level_keys_only() {
        let n: Node = serde_json::from_str(r#"{"__own":{"p":1},"__children":{},"name":"<a>","nested":{"__own":2}}"#).unwrap();
        let Node::Map(m) = &n else { unreachable!() };
        let v = Node::view(m, &["__own", "__children"]);
        let env = env();
        let out = env.render_str(
            "{{ v | json_attr }}|{{ v.__own is defined }}|{{ v.name | e }}|{{ v | length }}|{% for k in v %}{{ k }},{% endfor %}|{{ 'name' in v }}|{{ '__own' in v }}",
            minijinja::context! { v => v },
        ).unwrap();
        assert_eq!(out, "{&quot;name&quot;:&quot;&lt;a&gt;&quot;,&quot;nested&quot;:{&quot;__own&quot;:2}}|false|&lt;a&gt;|2|name,nested,|true|false");
    }

    #[test]
    fn serde_round_trip_and_json_conversions_are_lossless() {
        let text = r#"{"a":[1,-2,3.5,1e21,1e-7,0.1,true,false,null,"s",{"b":{}},[]],"n":18446744073709551615,"m":-9223372036854775808}"#;
        let node: Node = serde_json::from_str(text).unwrap();
        let json: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(serde_json::to_string(&node).unwrap(), serde_json::to_string(&json).unwrap());
        assert_eq!(Node::from(json.clone()), node);
        assert_eq!(serde_json::Value::from(&node), json);
        // A repeated key keeps its last value, as serde_json::Map does.
        let n: Node = serde_json::from_str(r#"{"a":1,"a":2}"#).unwrap();
        assert_eq!(n.get("a"), Some(&Node::Num(2.into())));
    }
}
```
`gen_json`, `gen_number` (JSON-valued), `Rng` and `tests_support::unescape`: lift the generators from `lib.rs`'s tests into a `#[cfg(test)] pub(crate) mod tests_support` in `lib.rs` (move `Rng`, `gen_string`, the 5-line `unescape`; add `gen_number_json` producing `serde_json::Value` numbers from the same `FLOATS` list + random `i64`/`u64`/`f64::from_bits` filtered through `serde_json::Number::from_f64`, and `gen_json(r, depth)` building `Null | Bool | Number | String | Array | Object` with unsorted keys and repeated-key-free objects) so both test modules share them. `Node::get_mut_path(&[&str]) -> Option<&mut Node>` is a tiny test helper (`pub` is fine; the pipeline may use it).

- [ ] **Step 2: `ctx.rs`** (the full type; the `Object` impls are the load-bearing part):
```rust
//! The render tree (M3-P P2/P3): what a worker response is parsed INTO, what the
//! pipeline reads and mutates, and what minijinja renders — one conversion, at
//! the parse. Maps are string-keyed and SORTED (`BTreeMap`, exactly
//! `serde_json::Map`'s order, so `{% for k in obj %}`, `keys`, `entries` and
//! `json_attr` paint the bytes the `serde_json::Value` → `value_of` path painted).
//! Maps, arrays and strings sit behind `Arc`s: `to_value` is a refcount bump, a
//! job-cache value merged into a context is shared, and `Arc::make_mut` makes a
//! write to a shared node a copy, never an alias.
use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

use minijinja::value::{Enumerator, Object, ObjectRepr, Value};

pub type MapInner = BTreeMap<Arc<str>, Node>;

#[derive(Debug, Clone, PartialEq, Default)]
pub enum Node {
    #[default]
    Null,
    Bool(bool),
    Num(serde_json::Number),
    Str(Arc<str>),
    Arr(Arc<CtxArr>),
    Map(Arc<CtxMap>),
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct CtxMap(pub MapInner);

#[derive(Debug, Clone, PartialEq, Default)]
pub struct CtxArr(pub Vec<Node>);

impl Node {
    pub fn map(m: MapInner) -> Node { Node::Map(Arc::new(CtxMap(m))) }
    pub fn arr(v: Vec<Node>) -> Node { Node::Arr(Arc::new(CtxArr(v))) }
    pub fn str(s: &str) -> Node { Node::Str(Arc::from(s)) }
    pub fn get(&self, key: &str) -> Option<&Node> {
        match self { Node::Map(m) => m.0.get(key), _ => None }
    }
    pub fn index(&self, i: usize) -> Option<&Node> {
        match self { Node::Arr(a) => a.0.get(i), _ => None }
    }
    pub fn as_map(&self) -> Option<&CtxMap> { if let Node::Map(m) = self { Some(m) } else { None } }
    pub fn as_arr(&self) -> Option<&CtxArr> { if let Node::Arr(a) = self { Some(a) } else { None } }
    pub fn as_str(&self) -> Option<&str> { if let Node::Str(s) = self { Some(s) } else { None } }
    pub fn is_null(&self) -> bool { matches!(self, Node::Null) }
    pub fn is_map(&self) -> bool { matches!(self, Node::Map(_)) }
    pub fn is_str(&self) -> bool { matches!(self, Node::Str(_)) }
    /// The map for writing: in place while this node is the only owner, a
    /// copy (of this level only) when it is shared — a cached value merged
    /// into a context is never written through.
    pub fn map_mut(&mut self) -> Option<&mut MapInner> {
        match self { Node::Map(m) => Some(&mut Arc::make_mut(m).0), _ => None }
    }
    pub fn arr_mut(&mut self) -> Option<&mut Vec<Node>> {
        match self { Node::Arr(a) => Some(&mut Arc::make_mut(a).0), _ => None }
    }
    pub fn get_mut_path(&mut self, path: &[&str]) -> Option<&mut Node> {
        let mut cur = self;
        for k in path { cur = cur.map_mut()?.get_mut(*k)?; }
        Some(cur)
    }
    /// The minijinja value: the reprs `value_of` produces for the same JSON
    /// (`serialize.rs`: u64 → U64, i64 → I64, f64 → F64, str → String, unit → None).
    pub fn to_value(&self) -> Value {
        match self {
            Node::Null => Value::from(()),
            Node::Bool(b) => Value::from(*b),
            Node::Num(n) => {
                if let Some(u) = n.as_u64() { Value::from(u) }
                else if let Some(i) = n.as_i64() { Value::from(i) }
                else { Value::from(n.as_f64().unwrap_or(f64::NAN)) }
            }
            Node::Str(s) => Value::from(Arc::clone(s)),
            Node::Arr(a) => Value::from_dyn_object(Arc::clone(a)),
            Node::Map(m) => Value::from_dyn_object(Arc::clone(m)),
        }
    }
    /// `map` minus its `hidden` top-level keys, as a value (O(1); no copy).
    pub fn view(map: &Arc<CtxMap>, hidden: &'static [&'static str]) -> Value {
        Value::from_object(MapView { map: Arc::clone(map), hidden })
    }
}

impl Object for CtxMap {
    fn repr(self: &Arc<Self>) -> ObjectRepr { ObjectRepr::Map }
    fn get_value(self: &Arc<Self>, key: &Value) -> Option<Value> {
        self.get_value_by_str(key.as_str()?)
    }
    /// The engine's root-scope and `a.b` lookups come here (no key `Value`).
    fn get_value_by_str(self: &Arc<Self>, key: &str) -> Option<Value> {
        self.0.get(key).map(Node::to_value)
    }
    fn enumerate(self: &Arc<Self>) -> Enumerator {
        Enumerator::Values(self.0.keys().map(|k| Value::from(Arc::clone(k))).collect())
    }
    fn enumerator_len(self: &Arc<Self>) -> Option<usize> { Some(self.0.len()) }
}

impl Object for CtxArr {
    fn repr(self: &Arc<Self>) -> ObjectRepr { ObjectRepr::Seq }
    fn get_value(self: &Arc<Self>, key: &Value) -> Option<Value> {
        // Mirror minijinja's own `Object for Vec<T>`: a non-index key is None;
        // the engine normalises negative indices before asking.
        self.0.get(key.as_usize()?).map(Node::to_value)
    }
    fn enumerate(self: &Arc<Self>) -> Enumerator { Enumerator::Seq(self.0.len()) }
    fn enumerator_len(self: &Arc<Self>) -> Option<usize> { Some(self.0.len()) }
}

/// A map minus some top-level keys (`_props` = the context minus the server's
/// `__children`/`__own`). Downcast by `json_attr` to write straight from the tree.
#[derive(Debug)]
pub struct MapView { pub(crate) map: Arc<CtxMap>, pub(crate) hidden: &'static [&'static str] }

impl Object for MapView {
    fn repr(self: &Arc<Self>) -> ObjectRepr { ObjectRepr::Map }
    fn get_value(self: &Arc<Self>, key: &Value) -> Option<Value> { self.get_value_by_str(key.as_str()?) }
    fn get_value_by_str(self: &Arc<Self>, key: &str) -> Option<Value> {
        if self.hidden.contains(&key) { return None; }
        self.map.0.get(key).map(Node::to_value)
    }
    fn enumerate(self: &Arc<Self>) -> Enumerator {
        Enumerator::Values(self.map.0.keys().filter(|k| !self.hidden.contains(&&***k)).map(|k| Value::from(Arc::clone(k))).collect())
    }
    fn enumerator_len(self: &Arc<Self>) -> Option<usize> {
        Some(self.map.0.keys().filter(|k| !self.hidden.contains(&&***k)).count())
    }
}

// ---- json_attr fast path (byte-identical to the one-pass writer: sorted keys, no undefined, serde_json's number text) ----

pub(crate) fn write_node(out: &mut String, n: &Node) {
    use std::fmt::Write as _;
    match n {
        Node::Null => out.push_str("null"),
        Node::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        // serde_json::Number's Display is the serializer's itoa/ryu text (the
        // existing one-pass number arm already relies on it).
        Node::Num(x) => { let _ = write!(out, "{x}"); }
        Node::Str(s) => crate::write_json_attr_str(out, s),
        Node::Arr(a) => {
            out.push('[');
            for (i, x) in a.0.iter().enumerate() { if i > 0 { out.push(','); } write_node(out, x); }
            out.push(']');
        }
        Node::Map(m) => write_map(out, &m.0, &[]),
    }
}

pub(crate) fn write_map(out: &mut String, m: &MapInner, hidden: &[&str]) {
    out.push('{');
    let mut first = true;
    for (k, v) in m {
        if hidden.contains(&&**k) { continue; }
        if !first { out.push(','); }
        first = false;
        crate::write_json_attr_str(out, k);
        out.push(':');
        write_node(out, v);
    }
    out.push('}');
}
```
Then `Serialize` (`Null → serialize_unit`, `Num → n.serialize(s)`, `Str → serialize_str`, `Arr → collect_seq`, `Map → collect_map(iter.map(|(k, v)| (&**k, v)))`), `Deserialize` (a `Visitor` with `visit_bool/i64/u64/f64/str/string/unit/none/some/seq/map`; `visit_f64` = `serde_json::Number::from_f64(v).map_or(Node::Null, Node::Num)` exactly as `serde_json::Value`'s visitor; map keys through a `struct Key(Arc<str>)` whose visitor does `visit_str → Arc::from(v)` so a key is ONE allocation; `visit_map` inserts into a `MapInner` — last value wins on a repeated key), `From<serde_json::Value> for Node` (recursive; `Value::Number(n) → Node::Num(n)`, `Object(o) → Node::map(o.into_iter().map(|(k, v)| (Arc::from(k), v.into())).collect())`) and `From<&Node> for serde_json::Value`. Add `pub mod ctx;` to `lib.rs` and make `write_json_attr_str` `pub(crate)`.

- [ ] **Step 3: the `json_attr` hook in `lib.rs`.** Current head of `write_json_attr` (:250):
```rust
fn write_json_attr(out: &mut String, v: &Value) -> Result<(), Bail> {
    match v.kind() {
```
→
```rust
fn write_json_attr(out: &mut String, v: &Value) -> Result<(), Bail> {
    // The render tree writes itself (M3-P P2): sorted string keys, no undefined
    // members, serde_json's own number text — never a bail-out.
    if let Some(m) = v.downcast_object_ref::<ctx::CtxMap>() {
        ctx::write_map(out, &m.0, &[]);
        return Ok(());
    }
    if let Some(a) = v.downcast_object_ref::<ctx::CtxArr>() {
        ctx::write_node(out, &ctx::Node::Arr(Arc::clone_from_ref(a)));   // see note
        return Ok(());
    }
    if let Some(p) = v.downcast_object_ref::<ctx::MapView>() {
        ctx::write_map(out, &p.map.0, p.hidden);
        return Ok(());
    }
    match v.kind() {
```
Note: there is no `Arc::clone_from_ref`; write the array arm as a `pub(crate) fn write_arr(out, a: &CtxArr)` in `ctx.rs` (the `[`…`]` loop of `write_node`) and call `ctx::write_arr(out, a)` — the snippet above shows intent only. Nested maps/arrays inside a `CtxMap` never reach this hook (they are walked by `write_node`); the hook fires for the top-level value a template pipes into `json_attr` — `_props`, a loader object, a row.

- [ ] **Step 4: Run**
```bash
cargo test -p brust-jinja 2>&1 | grep -E '^test |test result|FAILED|panicked'
cargo clippy -p brust-jinja --no-deps -- -D warnings && cargo fmt --all -- --check
cargo bench -p brust-jinja --bench json_attr --no-run
```
Expected: every existing test `ok` (`json_attr_one_pass_matches_the_three_pass_reference`, `escaping_table`, …) + the 6 new ones. If `node_renders_like_value_of_for_every_json_shape` fails on a template, the diff tells you which minijinja behaviour the `Object` impl misses (typical: `l[-1]` needs `enumerator_len` on `CtxArr`; `o == o` needs `enumerator_len` on `CtxMap`; `'a' in o` goes through `get_value`); fix the impl, never the test.

- [ ] **Step 5: Commit**
```bash
git add crates/brust-jinja/src/ctx.rs crates/brust-jinja/src/lib.rs
git commit -m "perf(jinja): ctx::Node — string-keyed Arc-shared render tree with zero-copy minijinja views (M3-P P2)

A worker response parses once into Node (BTreeMap<Arc<str>, Node> maps:
serde_json's sorted key order, so iteration, keys/entries and json_attr
paint the same bytes; arrays and strings behind Arcs). CtxMap/CtxArr/
MapView implement Object with string-keyed lookups; to_value is a refcount
bump; make_mut copies a shared node on write. json_attr writes a Node
straight from the tree (no minijinja values for x-props rows). Pinned by a
400-sample render-equivalence sweep against value_of and a 5000-sample
json_attr sweep against the three-pass reference.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: P2 — parse straight into `Node`; the pipeline over `Node`

**Files:**
- Modify: `crates/brust-server/src/protocol.rs` (`LoaderResponse` :23-40, `Verdict::NotFound` :50-53, `JobResult` :98-105, `JobCall::inputs`), `crates/brust-server/src/inputs.rs` (whole file minus parsing), `crates/brust-server/src/pipeline.rs` (every `serde_json::{Map, Value}` use), `crates/brust-server/src/cache/job_cache.rs` (`Arc<Value>` → `Arc<Node>`), `crates/brust-server/src/cache/l1.rs` (`CachedEntry.ctx`, `insert`), `crates/brust-server/src/lib.rs` (`bench::props_view` re-export is unchanged in name), `crates/brust-server/benches/render.rs`, `crates/brust-server/tests/fake_bun.rs` (`data` is a `Node` now)
- Read first: Task 5's `ctx.rs`; the mutation and read sites below

**The sites (m3p @5bd26a9 lines; the lane shifted everything after the jobs block by the m3p-a P5 diff — anchor on the text):**

Mutation (all in `pipeline.rs`): `page` :306-310 (`ctx.insert("params"…)`, `ctx.insert("path"…)`), `merge_loader_data` :750-758, `parent_slots` :1316, `entry_or` :1323, `component_map` :1335, `seed_child_slots` :1362-1400, `child_cell` :1403-1430, `merge_values` :1305, `merge_result` :1472-1517, `merge_legacy` :1519-1560 — ten functions, one file.
Reads: `inputs.rs` `Path::get` :81, `Projection::eval` :164, `PropsMap::eval` :219, `canonical` :234, `job_key` :244 (+ `project`/`child_props` wrappers); `pipeline.rs` `all_props` :1112, `job_inputs` :1125, `plan_key` :1139-1157 (`expr.get` + `canonical`), `row_count` :1201, `collect_jobs` :1208-1262 (`ch.props.eval`), `note_missing_slots` :1432, `check_value` :1451, `render_chain_html` :618-650 (`ctx.get(CHILDREN_KEY)`, `value_of`), `props_view` :657, `plan_stage::value_in`.
Stores: `JobCache` (`Arc<Value>` → `Arc<Node>`), `L1Cache::insert(ctx: Arc<Value>)` + `CachedEntry.ctx` (read by no production code; tests only).

**Interfaces:**
- `protocol.rs`: `LoaderResponse::Ok { ok: bool, data: Node, headers: BTreeMap<String, String> }`, `Verdict::NotFound { data: Node }`, `JobResult { id, value: Option<Node>, error }`, `JobCall<'a> { inputs: &'a Node, … }`. `LoaderResponse` loses `#[derive(Deserialize)]`/`#[serde(untagged)]` and gets a hand-written `Deserialize` (one pass over the object's keys, variant chosen at the end with the untagged precedence Ok → Verdict → Error).
- `inputs.rs`: `Path::get<'v>(&self, ctx: &'v Node, idx) -> &'v Node`, `Projection::eval(&self, ctx: &Node, idx) -> Result<Node, String>`, `PropsMap::eval(&self, parent_ctx: &Node, idx) -> Result<Node, String>`, `project(ctx: &Node, …) -> Result<Node, String>`, `child_props(parent_ctx: &Node, …) -> Result<Node, String>`, `canonical(v: &Node) -> Vec<u8>`, `job_key(cid, jid, inputs: &Node) -> String`.
- `pipeline.rs`: `JobPlan.inputs: Node`; `collect_jobs(idx, chain, ctx: &Node)`; `Lookup.values: Vec<Option<Arc<Node>>>`; `merge_values(ctx: &mut Node, plans, values: &[Option<Arc<Node>>])`; `seed_child_slots(…, ctx: &mut Node)`; `merge_result(ctx: &mut MapInner, plan, value: &Node)`; `render_chain_html(manifest, renderer, route_id, chain, ctx: &Node)`; `props_view(ctx: &Node) -> minijinja::Value`; `plan_stage::Planner::plan(chain, ctx: &Node)`, `seed(…, ctx: &mut Node)`, `Planned::lookup -> Vec<Option<Arc<Node>>>`, `merge(ctx: &mut Node, …)`, `warm(cache, merged: &Node)`.
- caches: `JobCache::get -> Option<Arc<Node>>`, `insert(k, Arc<Node>, …)`; `CachedEntry.ctx: Arc<Node>`, `L1Cache::insert(key, Arc<Node>, …)`.

- [ ] **Step 1: `LoaderResponse` by hand.** Replace the derive on the enum (keep `#[derive(Debug, Clone, PartialEq)]`) with:
```rust
/// `loader` call response: `{ ok: true, data, headers? } | { verdict, … } | { error }`.
/// Parsed in ONE pass straight into the render tree (M3-P P2): a `#[serde(untagged)]`
/// enum buffers the whole response into serde's `Content` tree first — that was the
/// intermediate tree. Variant precedence is the untagged one: `Ok` needs `ok` AND
/// `data`; else `Verdict` needs a valid `verdict` tag (+ its required fields); else
/// `Error` needs `error`; anything else is an error. Fields are typed as the variant
/// declares (a wrong-typed field is a parse error, where untagged would have tried the
/// next variant — the worker never emits such shapes; `packages/brust/src/worker.ts`).
impl<'de> Deserialize<'de> for LoaderResponse {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_map(LoaderVisitor)
    }
}

struct LoaderVisitor;

impl<'de> serde::de::Visitor<'de> for LoaderVisitor {
    type Value = LoaderResponse;

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a loader response object")
    }

    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut m: A) -> Result<LoaderResponse, A::Error> {
        use serde::de::Error as _;
        let (mut ok, mut data, mut headers, mut verdict) = (None::<bool>, None::<Node>, None::<BTreeMap<String, String>>, None::<String>);
        let (mut location, mut status, mut body, mut error) = (None::<String>, None::<u16>, None::<String>, None::<String>);
        while let Some(k) = m.next_key::<std::borrow::Cow<'de, str>>()? {
            match &*k {
                "ok" => ok = Some(m.next_value()?),
                "data" => data = Some(m.next_value()?),
                "headers" => headers = Some(m.next_value()?),
                "verdict" => verdict = Some(m.next_value()?),
                "location" => location = Some(m.next_value()?),
                "status" => status = Some(m.next_value()?),
                "body" => body = Some(m.next_value()?),
                "error" => error = Some(m.next_value()?),
                _ => { m.next_value::<serde::de::IgnoredAny>()?; }
            }
        }
        if let (Some(ok), Some(data)) = (ok, data.as_ref()) {
            return Ok(LoaderResponse::Ok { ok, data: data.clone(), headers: headers.unwrap_or_default() });
        }
        match verdict.as_deref() {
            Some("notFound") => return Ok(LoaderResponse::Verdict(Verdict::NotFound { data: data.unwrap_or_default() })),
            Some("redirect") => {
                let location = location.ok_or_else(|| A::Error::missing_field("location"))?;
                return Ok(LoaderResponse::Verdict(Verdict::Redirect { location, status: status.unwrap_or(302) }));
            }
            Some("httpError") => {
                let status = status.ok_or_else(|| A::Error::missing_field("status"))?;
                return Ok(LoaderResponse::Verdict(Verdict::HttpError { status, body: body.unwrap_or_default() }));
            }
            Some(other) => return Err(A::Error::unknown_variant(other, &["notFound", "redirect", "httpError"])),
            None => {}
        }
        match error {
            Some(error) => Ok(LoaderResponse::Error { error }),
            None => Err(A::Error::custom("loader response is none of ok/data, verdict, error")),
        }
    }
}
```
(The `data.clone()` in the `Ok` arm is an `Arc` bump for an object — or restructure with `data.take()`; either is O(1).) Keep `Verdict`'s own derive (`#[serde(tag = "verdict", …)]`) — `Verdict::NotFound { #[serde(default)] data: Node }`. `JobResult.value: Option<Node>`; `JobCall.inputs: &'a Node`. Protocol tests: the seven `loader_*` tests stay as written (`serde_json::from_value::<LoaderResponse>` drives the visitor through serde_json's value deserializer; `json!({"x": 1})` comparisons become `Node::from(json!({"x": 1}))`); `jobs_response_value_or_error` compares `Some(Node::from(json!({"_s1": "x"})))`.

- [ ] **Step 2: `inputs.rs` over `Node`.** `Path::get`:
```rust
    pub fn get<'v>(&self, ctx: &'v Node, idx: Option<usize>) -> &'v Node {
        static NULL: Node = Node::Null;
        let mut cur = ctx;
        for seg in &self.0 {
            cur = match seg {
                Seg::Key(k) => cur.get(k).unwrap_or(&NULL),
                Seg::Index(i) => cur.index(*i).unwrap_or(&NULL),
                Seg::Idx => match idx {
                    Some(i) => cur.index(i).unwrap_or(&NULL),
                    None => &NULL,
                },
            };
        }
        cur
    }
```
`Projection::eval` builds nested `MapInner`s (a small recursive insert instead of `serde_json::Map` + `as_object_mut`):
```rust
    pub fn eval(&self, ctx: &Node, idx: Option<usize>) -> Result<Node, String> {
        if idx.is_none() && let Some(s) = &self.first_idx {
            return Err(format!("input path {s:?}: [idx] outside a per-row instance"));
        }
        let mut out = MapInner::new();
        for (p, keys) in &self.kept {
            let (last, prefix) = keys.split_last().expect("parsed path is non-empty");
            let mut node = &mut out;
            for k in prefix {
                // Only objects we created live at prefix positions (see `new`).
                let slot = node.entry(Arc::from(k.as_str())).or_insert_with(|| Node::map(MapInner::new()));
                node = slot.map_mut().expect("projection prefix is an object");
            }
            node.insert(Arc::from(last.as_str()), p.get(ctx, idx).clone());
        }
        Ok(Node::map(out))
    }
```
(`entry` allocates the key once per kept path — the same count `serde_json::Map::insert` of a `String` key cost; `p.get(ctx, idx).clone()` is an `Arc` bump for a map/array/string — the deep clone of today is gone.) `PropsMap::eval` the same shape (`out.insert(Arc::from(name.as_str()), p.get(parent_ctx, idx).clone())`). `canonical(v: &Node) -> Vec<u8>` = `serde_json::to_vec(v)` (Node's `Serialize` writes sorted keys — the same bytes); `job_key(…, inputs_value: &Node)` = `serde_json::to_writer(&mut *buf, inputs_value)`. `project`/`child_props` just change types. Tests: `json!(…)` fixtures become `Node::from(json!(…))` on both sides of every `assert_eq!`; `job_key_hashes_length_prefixed_fields`'s reference closure takes `&Node` and uses `canonical`; add:
```rust
    /// The key is a function of the JSON text, whichever tree carries it.
    #[test]
    fn job_key_over_node_equals_job_key_over_serde_json() {
        let reference = |cid: &str, jid: &str, v: &serde_json::Value| {
            let mut h = blake3::Hasher::new();
            for field in [cid.as_bytes(), jid.as_bytes(), &serde_json::to_vec(v).unwrap()] {
                h.update(&(field.len() as u32).to_le_bytes());
                h.update(field);
            }
            h.finalize().to_hex().to_string()
        };
        for v in [json!({"z": 1, "a": [1.5, "é", null, {"y": true, "b": 18446744073709551615u64}]}), json!(null), json!("s"), json!(-7)] {
            assert_eq!(job_key("c", "j0", &Node::from(v.clone())), reference("c", "j0", &v), "{v}");
        }
    }
```

- [ ] **Step 3: `pipeline.rs` over `Node`.** Imports: `use serde_json::{Map, Value};` → `use brust_jinja::ctx::{MapInner, Node};` (+ `use std::sync::Arc` already there). Then, site by site:

`page` (:304-310):
```rust
    let mut ctx = Map::new();
    ctx.insert(
        "params".into(),
        serde_json::to_value(&params).unwrap_or_default(),
    );
    ctx.insert("path".into(), Value::String(path_only.to_string()));
```
→
```rust
    let mut ctx = MapInner::new();
    ctx.insert(
        "params".into(),
        Node::map(params.iter().map(|(k, v)| (Arc::from(k.as_str()), Node::str(v))).collect()),
    );
    ctx.insert("path".into(), Node::str(path_only));
```
and `let mut ctx = Value::Object(ctx);` (:400) → `let mut ctx = Node::map(ctx);`. `merge_loader_data(ctx: &mut MapInner, data: Node, route)`:
```rust
fn merge_loader_data(ctx: &mut MapInner, data: Node, route: &str) {
    let Node::Map(o) = data else { return };
    // The response was parsed for this request alone: the Arc is unique and
    // its entries move (no clone); a shared map (never, today) would be copied.
    let o = Arc::try_unwrap(o).unwrap_or_else(|a| (*a).clone());
    for (k, v) in o.0 {
        if is_server_slot(&k) {
            tracing::warn!(route, key = %k, "loader data key collides with a server slot; dropped");
            continue;
        }
        ctx.insert(k, v);
    }
}
```
`all_props(props: &Node) -> Node`: `Node::Map(o) → Node::map(o.0.iter().filter(|(k, _)| &***k != CHILDREN_KEY && &***k != OWN_KEY).map(|(k, v)| (Arc::clone(k), v.clone())).collect())`, else `props.clone()` (an `Arc` bump per entry, not a deep copy). `job_inputs(j, props: &Node, row) -> Result<Node, String>` (types only). `plan_key(…, props: &Node, projected: &Node)`:
```rust
        let user = match expr.get(props, None) {
            Node::Null => None,
            Node::Str(s) => Some(s.to_string()),
            v => Some(String::from_utf8(inputs::canonical(v)).expect("JSON is UTF-8")),
        };
```
`row_count(list, ctx: &Node) -> usize` = `list.get(ctx, None).as_arr().map_or(0, |a| a.0.len())`. `JobPlan.inputs: Node`. `collect_jobs(…, ctx: &Node)`, `plan_one(…, props: &Node, …)`: types only. `Lookup.values: Vec<Option<Arc<Node>>>`; `lookup_jobs` unchanged in shape. `merge_values(ctx: &mut Node, plans, values: &[Option<Arc<Node>>])`: `if let Some(map) = ctx.map_mut() { … merge_result(map, p, v) }`. The map helpers:
```rust
fn parent_slots<'a>(ctx: &'a mut MapInner, parent: &str) -> &'a mut MapInner {
    component_map(ctx, CHILDREN_KEY, parent)
}

/// `map[key]`, inserted from `make` when absent (one key allocation on insert only).
fn entry_or<'a>(map: &'a mut MapInner, key: &str, make: impl FnOnce() -> Node) -> &'a mut Node {
    if !map.contains_key(key) {
        map.insert(Arc::from(key), make());
    }
    map.get_mut(key).expect("present or just inserted")
}

/// `ctx[root][<id>]` as a map, created (or reset from a non-map) on demand.
fn component_map<'a>(ctx: &'a mut MapInner, root: &str, id: &str) -> &'a mut MapInner {
    let all = entry_or(ctx, root, || Node::map(MapInner::new()));
    if !all.is_map() {
        *all = Node::map(MapInner::new());
    }
    let all = all.map_mut().expect("map");
    let own = entry_or(all, id, || Node::map(MapInner::new()));
    if !own.is_map() {
        *own = Node::map(MapInner::new());
    }
    own.map_mut().expect("map")
}
```
`seed_child_slots(…, ctx: &mut Node)`: the `cell` closure builds `Node::map(use_ids(…).into_iter().map(|(k, v)| (Arc::from(k.as_str()), Node::Str(Arc::from(v.as_str())))).collect())`, per-row cells into `Node::arr(vec)`, and the insert loop is `if let Some(map) = ctx.map_mut() { for (parent, key, slot) in seeds { parent_slots(map, parent).insert(Arc::from(key), slot); } }`. `child_cell(ctx: &mut MapInner, parent, slot, row) -> Option<&mut MapInner>`: `entry_or(parent_slots(ctx, parent), slot, || if row.is_some() { Node::arr(vec![]) } else { Node::map(MapInner::new()) })`, then `Some(r) => { let a = slot.arr_mut()?; while a.len() <= r { a.push(Node::map(MapInner::new())); } &mut a[r] }`, and `cell.map_mut()`. `note_missing_slots`: `let Some(o) = v.as_map() else { return }; … !o.0.contains_key(n.as_str())`. `check_value`: `v.as_map().ok_or("precompute result is not an object")?;` / `JobKind::Ssr if v.is_str() => Ok(())`. `merge_result(ctx: &mut MapInner, plan, value: &Node)`:
```rust
    for (i, name) in plan.outputs.iter().enumerate() {
        let v = match plan.kind {
            // An Arc bump: the cached value is shared with the context, never copied.
            JobKind::Precompute => value.get(name).cloned().unwrap_or(Node::Null),
            JobKind::Ssr if i == 0 => value.clone(),
            JobKind::Ssr => continue,
        };
        match row {
            None => {
                obj.insert(Arc::from(name.as_str()), v);
            }
            Some(r) => {
                let slot = entry_or(obj, name, || Node::arr(vec![]));
                if !matches!(slot, Node::Arr(_)) {
                    *slot = Node::arr(vec![]);
                }
                let a = slot.arr_mut().expect("array");
                while a.len() <= r {
                    a.push(Node::Null);
                }
                a[r] = v;
            }
        }
    }
```
`merge_legacy` the same way (`spread` iterates `value.as_map()` and inserts `(Arc::clone(k), v.clone())`; `_ssr_<component>` keys via `Arc::from(format!(…).as_str())` — or `format!(…).into()`). `render_chain_html(…, ctx: &Node)`:
```rust
    let children = ctx.get(CHILDREN_KEY);
    let own_all = ctx.get(OWN_KEY);
    // The merged context as a value: an Arc bump (M3-P P2), shared by the chain.
    let base = ctx.to_value();
    let props = props_view(ctx);
    let overlay = |id: &str| {
        let slots = manifest.components.get(id).map_or(0, |c| c.use_id_slots);
        let mut out: Vec<(String, minijinja::Value)> = use_ids(route_id, id, slots)
            .into_iter()
            .map(|(k, v)| (k, minijinja::Value::from(v)))
            .collect();
        for map in [children, own_all] {
            if let Some(Node::Map(own)) = map.and_then(|c| c.get(id)) {
                for (k, v) in &own.0 {
                    out.push((k.to_string(), v.to_value()));
                }
            }
        }
        out.push((PROPS_KEY.into(), props.clone()));
        out
    };
    renderer.render_chain_value(chain, &base, &overlay)
```
(Task 8 replaces the `Vec` with the `Overlay` view; here every `value_of(v)` deep conversion is already an `Arc` bump.) `props_view(ctx: &Node) -> minijinja::Value`:
```rust
/// `_props`: the merged context minus the server's per-component maps, as an
/// O(1) view (`MapView`). A non-map context is itself.
pub fn props_view(ctx: &Node) -> minijinja::Value {
    match ctx {
        Node::Map(m) => Node::view(m, PROPS_HIDDEN),
        other => other.to_value(),
    }
}
const PROPS_HIDDEN: &[&str] = &[CHILDREN_KEY, OWN_KEY];
```
and delete `PropsView` + `is_props_hidden`. `render_document(s, route, ctx: &Node)`. The L1 insert passes `ctx` (now `Arc<Node>`). `plan_stage`: `Planner::plan(chain, ctx: &Node)`, `seed(…, ctx: &mut Node)`, `Planned::lookup -> Vec<Option<Arc<Node>>>`, `merge(ctx: &mut Node, values)`, `warm(cache, merged: &Node)` with `value_in(merged: &Node, p) -> Node`:
```rust
    fn value_in(merged: &Node, p: &JobPlan) -> Node {
        static NULL: Node = Node::Null;
        let at = |n: &Node, k: &str| n.get(k).unwrap_or(&NULL);
        let (cell, row) = match &p.dest {
            Dest::Chain { component, row } => (at(at(merged, OWN_KEY), component), *row),
            Dest::Child { parent, slot, row, .. } => {
                let slot = at(at(at(merged, CHILDREN_KEY), parent), slot);
                (row.map_or(slot, |r| slot.index(r).unwrap_or(&NULL)), None)
            }
        };
        let pick = |name: &str| match row {
            Some(r) => at(cell, name).index(r).cloned().unwrap_or(Node::Null),
            None => at(cell, name).clone(),
        };
        match p.kind {
            JobKind::Ssr => pick(&p.outputs[0]),
            JobKind::Precompute => Node::map(p.outputs.iter().map(|o| (Arc::from(o.as_str()), pick(o))).collect()),
        }
    }
```
`describe()`: `"inputs": p.inputs` works as is (`Node: Serialize`). Tests in `pipeline.rs`: `pikachu() -> Node` = `Node::from(json!(…))`; every `assert_eq!(x, json!(…))` on a `Node` becomes `assert_eq!(serde_json::Value::from(&x), json!(…))` (or compare `Node`s); `ctx["__children"]["detailPage_c3"]…` indexing becomes `ctx.get("__children").unwrap().get("detailPage_c3").unwrap()…` (add a test-only `fn at<'a>(n: &'a Node, path: &[&str]) -> &'a Node` helper); the golden test converts `merged` with `Node::from` and strips `OWN_KEY`/`CHILDREN_KEY` through `ctx.map_mut().unwrap().remove(k)`; `props_view_paints_like_the_cloned_props` renders with `ctx.to_value()` as base and `props_view(&ctx)` vs `all_props(&ctx).to_value()`. The m3p-a tests (`req_of`, `res`, `results_in_request_order_*`) take `Node` (`static NULL: Node`). Add the aliasing pin:
```rust
    #[test]
    fn merging_a_cached_value_never_mutates_the_cache_entry() {
        let m = manifest();
        let ix = PlanIndex::new(&m).unwrap();
        let plans = collect_jobs(&ix, &chain(&["detailPage_c3"]), &pikachu()).unwrap();
        // The value as the job cache holds it (Arc-shared with the context after the merge).
        let cached = Arc::new(Node::from(json!({"_s1": {"deep": [1]}})));
        let mut map = MapInner::new();
        merge_result(&mut map, &plans[0], &cached);
        let shared = map.get("__own").unwrap().get("detailPage_c3").unwrap().get("_s1").unwrap();
        let Node::Map(s) = shared else { unreachable!() };
        assert_eq!(Arc::strong_count(s), 2, "merged by sharing, not by copying");
        // Writing into the merged cell copies that level; the cache's node is untouched.
        let mut ctx = Node::map(map);
        ctx.get_mut_path(&["__own", "detailPage_c3", "_s1"]).unwrap().map_mut().unwrap().insert("x".into(), Node::Null);
        assert_eq!(serde_json::Value::from(&*cached), json!({"_s1": {"deep": [1]}}));
        assert_eq!(serde_json::Value::from(ctx.get_mut_path(&["__own", "detailPage_c3", "_s1"]).unwrap()), json!({"deep": [1], "x": null}));
    }
```

- [ ] **Step 4: caches.** `job_cache.rs`: `use serde_json::Value;` → `use brust_jinja::ctx::Node;` and `Arc<Value>` → `Arc<Node>` (7 sites: `FrontEntry.value`, `CachedJob.value`, `get`, `insert`, the eviction listener, tests); tests `Arc::new(json!(x))` → `Arc::new(Node::from(json!(x)))` (`grep -n 'json!' crates/brust-server/src/cache/job_cache.rs` lists them; `Node: PartialEq` keeps the `assert_eq!(s.get(..), Some(Arc::new(..)))` shape). `l1.rs`: `pub ctx: Arc<Node>`, `insert(…, ctx: Arc<Node>, …)`; tests likewise (≈ 25 sites; same `grep`). `tests/fake_bun.rs`: `let LoaderResponse::Ok { data, .. } = r` — compare `serde_json::Value::from(&data)` or `Node::from(json!(…))`.

- [ ] **Step 5: `benches/render.rs`.** `fn ctx(name) -> Node` = `Node::from(serde_json::from_slice::<serde_json::Value>(&raw)…)`; `ctx_to_value` bench → `b.iter(|| Node::from(black_box(&json_value).clone()).to_value())` hmm — keep the bench meaningful: rename to `ctx_parse` timing `serde_json::from_slice::<Node>(&raw)` vs a sibling `ctx_parse_serde_json` timing `serde_json::from_slice::<serde_json::Value>(&raw)` + `value_of` (the before/after of P2 in one place); `props_to_value` → `props_view(black_box(&ctx))`; `serde_json::to_vec(&ctx)` works; `Arc::new(ctx.clone())` for the L1 insert; `plan_B`/`plan_C`: `planner.plan(chain, &ctx)` etc. unchanged in shape. `cargo bench -p brust-server --bench render --no-run` must pass.

- [ ] **Step 6: Run — Rust**
```bash
cargo test --workspace --exclude bun_react_compiler 2>&1 | grep -E 'test result|FAILED|panicked' | sort | uniq -c
git diff --quiet crates/brust-server/benches/fixtures && echo GOLDEN-UNCHANGED      # plan-golden.json not rewritten
grep -c 'serde_json::Value\|serde_json::Map' crates/brust-server/src/pipeline.rs    # expect 0 outside `mod tests` (check with -n)
cargo clippy -p brust-compiler -p brust-compiler-cli -p brust-jinja -p brust-server -p brust-napi --no-deps -- -D warnings && cargo fmt --all -- --check
cargo bench -p brust-server --bench render --no-run && cargo bench -p brust-jinja --bench json_attr --no-run
```
Expected: every `test result: ok.`; `pokedex_plans_match_the_golden` green WITHOUT `BRUST_WRITE_PLAN_GOLDEN` (keys, call ids, inputs JSON and the all-miss request JSON are unchanged — if it is red on `inputs`, the `Projection::eval` key order or number text drifted; if on `seed + merge rebuild`, a helper lost a `make_mut` path).

- [ ] **Step 7: Run — TS gates with a fresh debug addon, then byte-identical with the release addon**
```bash
cd packages/brust && bun run build:debug && bun run typecheck && bun test test/routes.test.ts test/cache.test.ts test/worker.test.ts test/config.test.ts test/napi-compile.test.ts test/build-compile.test.ts && bun test test/napi-server.test.ts && bun test test/build-manifest.test.ts && bun test test/cli.test.ts && bun test --timeout 120000 test/e2e.test.ts && cd ../..
cd examples/pokedex && bun test && bun run typecheck && cd ../..
bun test --timeout 120000 tests/server/pokedex.test.ts
bun test --timeout 120000 tests/server/hydrate.chromium.test.ts
cd packages/brust && bun run build && cd ../.. && $OUT/snap.sh p2 && $OUT/cmp.sh before p2
```
Expected: all green; `IDENTICAL` ×4. A body diff here is the lane's most likely failure; `diff <(tr '>' '>\n' < $OUT/body-before-bench_dex) <(tr '>' '>\n' < $OUT/body-p2-bench_dex) | head` localises it (number text, key order, or an `x-props` member).

- [ ] **Step 8: Commit**
```bash
git diff --quiet packages/brust/src/worker.ts && echo clean && git status --short
git add crates/brust-server/src/protocol.rs crates/brust-server/src/inputs.rs crates/brust-server/src/pipeline.rs crates/brust-server/src/cache/job_cache.rs crates/brust-server/src/cache/l1.rs crates/brust-server/src/lib.rs crates/brust-server/benches/render.rs crates/brust-server/tests/fake_bun.rs
git commit -m "perf(server): parse worker responses straight into ctx::Node; pipeline over Node (M3-P P2)

LoaderResponse is deserialised by hand in one pass (the untagged enum
buffered every response into serde's Content tree first); data, verdict
data and job values are Node. collect_jobs/seed_child_slots/merge_values
and inputs::{Path,Projection,PropsMap} read and mutate the Node tree
(Arc::make_mut: in place when unique, copy-on-write when a job-cache value
is shared with the context). render_chain_html converts the context with
an Arc bump instead of a value_of walk; _props is a MapView. Job-cache and
L1 entries hold Arc<Node>. The pokedex plan golden is unchanged; the four
curl snapshots are byte-identical.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Measure after P2

**Files:** none committed.

- [ ] **Step 1: Bench (after P2)** — Task 1 Step 5 with `-p2` names; revert RESULTS. Paste D/I rows, Δ vs P1 and vs before.
- [ ] **Step 2: Attribution (after P2).** `git apply --3way bench/attribution.patch` will reject the `render_chain_html` hunk (`CTX_VALUE`/`OVERLAY`: `value_of(ctx)` is gone) and possibly the `MERGE_RESULTS`/`SEED` context lines. Place by hand: `CTX_VALUE` around `let base = ctx.to_value();` (expect ≈ 0), `OVERLAY` as before around the overlay closure body. `cargo check -p brust-server`, release addon, run both attribution commands (pokedex B/C, bench D/I) through `$OUT/locked.ts`, revert, guard `clean`, rebuild release. Paste D and I (c=120): `CW_READ_PARSE` (the parse — expected to drop by the `Content` tree + the `serde_json::Value` build), `CTX_VALUE` (→ ~0), `OVERLAY`, `MERGE_RESULTS`, `SEED`, `COLLECT_JOBS`, `RENDER_CHAIN`, `TMPL0/1`, `SVC_TOTAL`, CPU µs/req, P1 → P2.
- [ ] **Step 3: criterion** — `cargo bench -p brust-server --bench render -- 'A/|B/' 2>&1 | grep -E 'ctx_parse|props_to_value|render_chain|finish_identity'` on the lane HEAD and on `git stash`/`m3p` (or the P1 commit via a second worktree) for the same groups; paste both. Expected: `render_chain` for route B (pikachu) and A down (no `value_of` walk, cheaper overlays, `json_attr` from the tree).

---

### Task 8: P3 — overlays as a `Scope` view (no per-component map build)

**Files:**
- Modify: `crates/brust-server/src/render.rs` (`render_chain_value` :100-126 + new `Overlay`, `Scope`, `render_chain_overlay`), `crates/brust-server/src/pipeline.rs` (`render_chain_html` overlay closure)
- Read first: minijinja `src/value/merge_object.rs` (`MergeDict::get_value` looks up in REVERSE order of the spread list and skips undefined; `enumerate` = union of the map-kind layers' keys, sorted) and `src/vm/context.rs:308` (root lookups go through `get_attr_fast` → `get_value_by_str`)

**Interfaces:**
```rust
/// What one chain component sees over the base context (render.rs).
#[derive(Default)]
pub struct Overlay {
    /// Looked up after `maps`, last pair first (`_idN` useId slots; a test's ad-hoc pairs).
    pub pairs: Vec<(String, minijinja::Value)>,
    /// Map-valued layers (`ctx["__children"][id]`, `ctx["__own"][id]`), looked up LAST ONE FIRST.
    pub maps: Vec<minijinja::Value>,
    /// `_props` — beats everything but `__outlet`.
    pub props: Option<minijinja::Value>,
}
impl Renderer {
    pub fn render_chain_overlay(&self, chain: &[String], base: &minijinja::Value, overlay: &dyn Fn(&str) -> Overlay) -> Result<String, RenderError>;
    // kept, now thin wrappers over render_chain_overlay with `Overlay { pairs, ..Default::default() }`:
    pub fn render_chain(&self, chain, ctx: &serde_json::Value, overlay: &dyn Fn(&str) -> Vec<(String, Value)>) -> Result<String, RenderError>;
    pub fn render_chain_value(&self, chain, base: &Value, overlay: &dyn Fn(&str) -> Vec<(String, Value)>) -> Result<String, RenderError>;
}
```
Lookup precedence of the `Scope` (= today's `context!{ ..from_pairs(overlay), ..base }` where the pairs were pushed in the order ids, children entries, own entries, `_props`, `__outlet` and a later pair overwrote an earlier one): `__outlet` → `_props` → `maps` last-first (own, then children) → `pairs` last-first (ids) → `base`; an undefined hit falls through (MergeDict skips undefined).

- [ ] **Step 1: Failing tests** (append to `render.rs` `mod tests`):
```rust
    /// The Scope answers exactly what `context!{ ..from_pairs(overlay), ..base }` answered:
    /// __outlet > _props > own > children > ids > base, undefined skipped, union enumerated.
    #[test]
    fn scope_lookup_order_matches_the_merge_dict() {
        let r = Renderer::from_templates(&templates(&[(
            "T",
            "{{ __outlet | safe }}|{{ _props.x }}|{{ k }}|{{ _id0 }}|{{ only_base }}|{{ gone is defined }}|{% for n in self %}{{ n }},{% endfor %}",
        )]))
        .unwrap();
        let base = minijinja::context! { k => "base", _id0 => "base-id", only_base => "ob", _props => "base-props", x => 1 };
        let children = minijinja::context! { k => "children", gone => minijinja::Value::UNDEFINED };
        let own = minijinja::context! { k => "own" };
        let overlay = Overlay {
            pairs: vec![("_id0".into(), minijinja::Value::from("id")), ("k".into(), minijinja::Value::from("ids"))],
            maps: vec![children.clone(), own.clone()],
            props: Some(minijinja::context! { x => 2 }),
        };
        let got = r
            .render_chain_overlay(&["T".into()], &base, &|_| Overlay { pairs: overlay.pairs.clone(), maps: overlay.maps.clone(), props: overlay.props.clone() })
            .unwrap();
        // Reference: the former shape, built the way render_chain_value built it.
        let mut pairs = overlay.pairs.clone();
        for m in [&children, &own] {
            for k in m.try_iter().unwrap() {
                pairs.push((k.to_string(), m.get_item(&k).unwrap()));
            }
        }
        pairs.push(("_props".into(), overlay.props.clone().unwrap()));
        let want = minijinja::context! { ..minijinja::Value::from_pairs(pairs), ..base.clone() };
        let want = r.env.get_template("T").unwrap().render(want).unwrap();
        assert_eq!(got, want);
        assert!(got.starts_with("|2|own|id|ob|false|"), "{got}");
    }

    /// A scope sees the context as it was when the scope was built: a later
    /// make_mut write to the Node tree copies, it does not reach the view.
    #[test]
    fn scope_sees_the_context_as_rendered_not_as_later_mutated() {
        use brust_jinja::ctx::Node;
        let r = Renderer::from_templates(&templates(&[("T", "{{ a.b }}")])).unwrap();
        let mut ctx: Node = serde_json::from_str(r#"{"a":{"b":1}}"#).unwrap();
        let base = ctx.to_value();
        ctx.get_mut_path(&["a"]).unwrap().map_mut().unwrap().insert("b".into(), Node::Num(2.into()));
        assert_eq!(r.render_chain_overlay(&["T".into()], &base, &|_| Overlay::default()).unwrap(), "1");
        assert_eq!(r.render_chain_overlay(&["T".into()], &ctx.to_value(), &|_| Overlay::default()).unwrap(), "2");
    }
```
(`{% for n in self %}` enumerates the root scope — minijinja exposes the root as `self`; if it does not in 3.0, drop that segment and pin `enumerate` through `{{ self | length }}` or leave enumeration unpinned with a note.)

- [ ] **Step 2: Implement.** In `render.rs`:
```rust
/// One chain component's scope: the overlay layers over the base context,
/// as ONE object (M3-P P3) — no `from_pairs` map and no `MergeDict` per
/// component. Lookup order is what `context!{ ..from_pairs(overlay), ..base }`
/// gave (a later pair overwrote an earlier one): `__outlet`, `_props`, the maps
/// last-first (own, children), the pairs last-first (ids), the base. An
/// undefined hit falls through, as `MergeDict` skips it. Root lookups reach
/// `get_value_by_str` directly (no key `Value`).
#[derive(Debug)]
struct Scope {
    outlet: Option<minijinja::Value>,
    overlay: Overlay,
    base: minijinja::Value,
}

fn defined(v: Result<minijinja::Value, minijinja::Error>) -> Option<minijinja::Value> {
    v.ok().filter(|v| !v.is_undefined())
}

impl minijinja::value::Object for Scope {
    fn get_value(self: &Arc<Self>, key: &minijinja::Value) -> Option<minijinja::Value> {
        self.get_value_by_str(key.as_str()?)
    }

    fn get_value_by_str(self: &Arc<Self>, key: &str) -> Option<minijinja::Value> {
        if key == "__outlet"
            && let Some(o) = &self.outlet
        {
            return Some(o.clone());
        }
        if key == "_props"
            && let Some(p) = &self.overlay.props
        {
            return Some(p.clone());
        }
        for m in self.overlay.maps.iter().rev() {
            if let Some(v) = defined(m.get_attr(key)) {
                return Some(v);
            }
        }
        for (k, v) in self.overlay.pairs.iter().rev() {
            if k == key {
                return Some(v.clone());
            }
        }
        defined(self.base.get_attr(key))
    }

    fn enumerate(self: &Arc<Self>) -> minijinja::value::Enumerator {
        let mut keys = std::collections::BTreeSet::new();
        for m in self.overlay.maps.iter().chain(std::iter::once(&self.base)) {
            if let Ok(it) = m.try_iter() {
                keys.extend(it);
            }
        }
        keys.extend(self.overlay.pairs.iter().map(|(k, _)| minijinja::Value::from(k.as_str())));
        if self.overlay.props.is_some() {
            keys.insert(minijinja::Value::from("_props"));
        }
        if self.outlet.is_some() {
            keys.insert(minijinja::Value::from("__outlet"));
        }
        minijinja::value::Enumerator::Iter(Box::new(keys.into_iter()))
    }
}
```
(`Overlay` needs `#[derive(Debug, Default)]`.) `render_chain_overlay`:
```rust
    pub fn render_chain_overlay(
        &self,
        chain: &[String],
        base: &minijinja::Value,
        overlay: &dyn Fn(&str) -> Overlay,
    ) -> Result<String, RenderError> {
        let mut outlet: Option<String> = None;
        for id in chain.iter().rev() {
            let scope = minijinja::Value::from_object(Scope {
                outlet: outlet.take().map(minijinja::Value::from_safe_string),
                overlay: overlay(id),
                base: base.clone(),
            });
            let tmpl = self
                .env
                .get_template(id)
                .map_err(|_| RenderError::Unknown(id.clone()))?;
            outlet = Some(tmpl.render(scope).map_err(|e| render_err(id, &e))?);
        }
        Ok(outlet.unwrap_or_default())
    }
```
`render_chain_value(chain, base, overlay: &dyn Fn(&str) -> Vec<(String, Value)>)` becomes `self.render_chain_overlay(chain, base, &|id| Overlay { pairs: overlay(id), ..Default::default() })` and `render_chain` stays `render_chain_value(chain, &brust_jinja::value_of(ctx), overlay)` — both only used by tests now; say so in their docs. In `pipeline.rs` `render_chain_html` the closure returns an `Overlay`:
```rust
    let overlay = |id: &str| {
        let slots = manifest.components.get(id).map_or(0, |c| c.use_id_slots);
        let mut maps = Vec::with_capacity(2);
        for all in [children, own_all] {
            if let Some(Node::Map(m)) = all.and_then(|c| c.get(id)) {
                maps.push(minijinja::Value::from_dyn_object(Arc::clone(m)));
            }
        }
        Overlay {
            pairs: use_ids(route_id, id, slots)
                .into_iter()
                .map(|(k, v)| (k, minijinja::Value::from(v)))
                .collect(),
            maps,
            props: Some(props.clone()),
        }
    };
    renderer.render_chain_overlay(chain, &base, &overlay)
```
(`use_ids`' two `format!`s per slot per component per request stay; precomputing them per (route, component) at boot in `PlanIndex` is a follow-up for the lead.)

- [ ] **Step 3: Run + byte-identical**
```bash
cargo test -p brust-server 2>&1 | grep -E 'test result|FAILED|panicked'
grep -n 'from_pairs\|context! {' crates/brust-server/src/render.rs     # only inside `mod tests`
cargo clippy -p brust-server --no-deps -- -D warnings && cargo fmt --all -- --check
cd packages/brust && bun run build:debug && bun test test/napi-server.test.ts && cd ../.. && bun test --timeout 120000 tests/server/pokedex.test.ts
cd packages/brust && bun run build && cd ../.. && $OUT/snap.sh p3a && $OUT/cmp.sh before p3a
```
Expected: all green, `IDENTICAL` ×4.

- [ ] **Step 4: Commit**
```bash
git add crates/brust-server/src/render.rs crates/brust-server/src/pipeline.rs
git commit -m "perf(render): overlays as a Scope view — no per-component map build (M3-P P3)

Each chain component rendered under context!{ ..from_pairs(overlay), ..base }:
a BTreeMap<Value, Value> built from the component's own/child maps plus a
MergeDict, per component per request. Scope is one object holding Arc
views of those maps (string-keyed get_value_by_str) with the former lookup
precedence (test-pinned against the MergeDict shape). render_chain /
render_chain_value stay as test wrappers.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: P3 — one hinted buffer for the chain; `inject_assets` in place

**Files:**
- Modify: `crates/brust-server/src/render.rs` (`render_chain_overlay` → `render_chain_into`; `inject_assets` → `inject_assets_into` + wrapper), `crates/brust-server/src/pipeline.rs` (`render_document`, `page`), `crates/brust-server/src/config.rs` (`Server.render_hints`), `crates/brust-server/src/server/mod.rs` (`start()` literal :102-130), `crates/brust-server/benches/render.rs` (`inject_assets` bench stays on the wrapper)
- Read first: minijinja `src/template.rs` :184-232 (`render` = `String::with_capacity(buffer_size_hint)` + `Output`; `render_captured_to(ctx, io::Write)` — the only public writer path; it clones the template handle and boxes a `Captured` cell per call), `src/output.rs` :150-175 (`WriteWrapper::write_str` = `write_all(s.as_bytes())`: whole `&str`s, so a `Vec<u8>` target holds valid UTF-8 at every point)

**Interfaces:**
```rust
impl Renderer {
    /// Leaf-first chain render INTO `out` (cleared first): the root template writes straight into
    /// `out` (sized by the caller), each inner level into a String of the same capacity hint.
    pub fn render_chain_into(&self, chain: &[String], base: &Value, overlay: &dyn Fn(&str) -> Overlay, out: &mut String) -> Result<(), RenderError>;
    pub fn render_chain_overlay(..) -> Result<String, RenderError>   // = with_capacity(0) + render_chain_into (tests, bench)
}
/// S9 tags inserted before the last `</body>` (else appended) — in place.
pub fn inject_assets_into(html: &mut String, chain: &[String], m: &Manifest);
pub fn inject_assets(html: String, chain: &[String], m: &Manifest) -> String;   // wrapper (bench/tests)
pub(crate) struct Server { …, /// Last document length per manifest route (+ slack): the capacity of the next render's buffer. A size, never bytes.
    pub(crate) render_hints: Vec<AtomicUsize> }
/// Documents at least this long are rendered through the io::Write path into the hinted buffer;
/// shorter ones through `Template::render` (its own small buffer beats the Captured cell's box).
const WRITER_MIN: usize = 16 * 1024;
```

- [ ] **Step 1: Failing tests** (append to `render.rs` `mod tests`):
```rust
    #[test]
    fn render_chain_into_clears_and_never_depends_on_capacity() {
        let r = Renderer::from_templates(&templates(&[
            ("L", "<html><body>{{ __outlet | safe }}</body></html>"),
            ("P", "{% for i in range(n) %}<p>{{ i }}</p>{% endfor %}"),
        ]))
        .unwrap();
        let chain = ["L".to_string(), "P".to_string()];
        let big = minijinja::context! { n => 4000 };   // > WRITER_MIN bytes
        let small = minijinja::context! { n => 3 };
        let want_big = r.render_chain_overlay(&chain, &big, &|_| Overlay::default()).unwrap();
        let want_small = r.render_chain_overlay(&chain, &small, &|_| Overlay::default()).unwrap();
        assert!(want_big.len() > WRITER_MIN && want_small.len() < WRITER_MIN);
        // A then B into ONE buffer: B exact (no stale tail), whatever the capacity.
        for cap in [0usize, 100, WRITER_MIN, 1 << 20] {
            let mut out = String::with_capacity(cap);
            r.render_chain_into(&chain, &big, &|_| Overlay::default(), &mut out).unwrap();
            assert_eq!(out, want_big, "cap {cap}");
            r.render_chain_into(&chain, &small, &|_| Overlay::default(), &mut out).unwrap();
            assert_eq!(out, want_small, "cap {cap}");
        }
        // A junk-filled buffer is cleared first.
        let mut out = "JUNK".repeat(10_000);
        r.render_chain_into(&chain, &big, &|_| Overlay::default(), &mut out).unwrap();
        assert_eq!(out, want_big);
        // An error leaves nothing of the failed render in the caller's hands.
        let mut out = String::new();
        assert!(matches!(r.render_chain_into(&["Nope".into()], &big, &|_| Overlay::default(), &mut out), Err(RenderError::Unknown(_))));
    }

    #[test]
    fn inject_assets_into_equals_inject_assets() {
        let (_l, m) = {
            let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/dist");
            let l = crate::manifest::Manifest::load(&dir).unwrap();
            (l.templates.clone(), l.manifest)
        };
        let chain: Vec<String> = m.routes[0].chain.clone();
        for html in ["<html><body><p>x</p></body></html>", "<p>no body tag</p>", "<body></body><body></body>", ""] {
            let want = inject_assets(html.to_string(), &chain, &m);
            let mut got = String::with_capacity(4096);
            got.push_str(html);
            inject_assets_into(&mut got, &chain, &m);
            assert_eq!(got, want, "{html:?}");
        }
    }
```
and in `pipeline.rs` `mod tests` (unit-level, no server): `hint_follows_the_last_document_length` — call the pure helper `next_hint(len: usize) -> usize` (Step 2) and assert `next_hint(0) >= 1024`, `next_hint(144_000) >= 144_000`, `next_hint(144_000) < 2 * 144_000`.

- [ ] **Step 2: Implement.** `render.rs`:
```rust
const WRITER_MIN: usize = 16 * 1024;

/// Renders `tmpl` into `out` through minijinja's writer path when `out`'s
/// capacity says the document is large (the io::Write adapter + the Captured
/// cell cost a box; a growing String costs log2(n) reallocations of n bytes),
/// else through `render` into a fresh String.
fn render_into(tmpl: &minijinja::Template<'_, '_>, scope: minijinja::Value, out: &mut String) -> Result<(), minijinja::Error> {
    out.clear();
    if out.capacity() < WRITER_MIN {
        *out = tmpl.render(scope)?;
        return Ok(());
    }
    let mut buf = std::mem::take(out).into_bytes();
    let r = tmpl.render_captured_to(scope, &mut buf).map(|_| ());
    // SAFETY: minijinja writes whole `&str`s (`Output` → `WriteWrapper::write_str` →
    // `write_all(s.as_bytes())`) and a `Vec<u8>` never fails a write, so `buf` is a
    // concatenation of valid UTF-8 strings at every point, error or not.
    *out = unsafe { String::from_utf8_unchecked(buf) };
    r
}

impl Renderer {
    pub fn render_chain_into(
        &self,
        chain: &[String],
        base: &minijinja::Value,
        overlay: &dyn Fn(&str) -> Overlay,
        out: &mut String,
    ) -> Result<(), RenderError> {
        out.clear();
        let cap = out.capacity();
        let mut outlet: Option<String> = None;
        for (pos, id) in chain.iter().enumerate().rev() {
            let scope = minijinja::Value::from_object(Scope {
                outlet: outlet.take().map(minijinja::Value::from_safe_string),
                overlay: overlay(id),
                base: base.clone(),
            });
            let tmpl = self.env.get_template(id).map_err(|_| RenderError::Unknown(id.clone()))?;
            if pos == 0 {
                render_into(&tmpl, scope, out).map_err(|e| render_err(id, &e))?;
            } else {
                // An inner level: its output becomes the parent's `__outlet`
                // (an Arc<str> copy inside minijinja — unavoidable); sized like
                // the document, which bounds it.
                let mut s = String::with_capacity(cap);
                render_into(&tmpl, scope, &mut s).map_err(|e| render_err(id, &e))?;
                outlet = Some(s);
            }
        }
        if chain.is_empty() {
            out.clear();
        }
        Ok(())
    }

    pub fn render_chain_overlay(&self, chain: &[String], base: &minijinja::Value, overlay: &dyn Fn(&str) -> Overlay) -> Result<String, RenderError> {
        let mut out = String::new();
        self.render_chain_into(chain, base, overlay, &mut out)?;
        Ok(out)
    }
}
```
On an error the caller's `out` may hold a partial render — `page` returns a 500 and drops it; the test pins that `Err` is returned. `inject_assets_into(html: &mut String, chain, m)`: move the body of `inject_assets` over (`if !any_dynamic { return; }` … `match html.rfind("</body>") { Some(i) => html.insert_str(i, &tags), None => html.push_str(&tags) }`), and `pub fn inject_assets(mut html: String, chain, m) -> String { inject_assets_into(&mut html, chain, m); html }`. `config.rs` `Server`: add `pub(crate) render_hints: Vec<AtomicUsize>,` (doc above); `server/mod.rs` `start()`: `render_hints: (0..loaded.manifest.routes.len()).map(|_| AtomicUsize::new(0)).collect(),` placed before `manifest: loaded.manifest,` (it borrows `loaded.manifest` before the move). `pipeline.rs`:
```rust
/// The next render's buffer capacity after a document of `len` bytes: the
/// length plus 1/16 slack and 1 KiB, so a document a few bytes longer than the
/// last one does not reallocate (a reallocation doubles — never the hint).
fn next_hint(len: usize) -> usize {
    len + len / 16 + 1024
}

/// Leaf-first render of the route's chain (each component under its overlay)
/// plus asset tags, into ONE buffer sized from this route's last document
/// (M3-P P3): the identity document. Shared by every path that renders, so
/// the body a HIT serves is the bytes a fresh render produces.
fn render_document(s: &Server, route: &RouteRecord, ri: usize, ctx: &Node) -> Result<Bytes, RenderError> {
    let mut out = String::with_capacity(s.render_hints[ri].load(Ordering::Relaxed));
    render_chain_into(&s.manifest, &s.renderer, &route.id, &route.chain, ctx, &mut out)?;
    inject_assets_into(&mut out, &route.chain, &s.manifest);
    s.render_hints[ri].store(next_hint(out.len()), Ordering::Relaxed);
    Ok(Bytes::from(out.into_bytes()))
}
```
with `render_chain_html` renamed/refactored to `pub fn render_chain_into(manifest, renderer, route_id, chain, ctx: &Node, out: &mut String) -> Result<(), RenderError>` (the overlay closure of Task 8 + `renderer.render_chain_into(chain, &base, &overlay, out)`) and a thin `pub fn render_chain_html(…) -> Result<String, RenderError>` kept for the bench (`lib.rs` re-export unchanged). In `page`: `let ri = s.routes.route_index(route_id); let route = &s.manifest.routes[ri];` and `render_document(s, route, ri, &ctx)`.

- [ ] **Step 3: Run + byte-identical**
```bash
cargo test -p brust-server 2>&1 | grep -E 'test result|FAILED|panicked'
cargo clippy -p brust-server --no-deps -- -D warnings && cargo fmt --all -- --check
cargo bench -p brust-server --bench render --no-run
cd packages/brust && bun run build:debug && bun test test/napi-server.test.ts && cd ../.. && bun test --timeout 120000 tests/server/pokedex.test.ts
cd packages/brust && bun run build && cd ../.. && $OUT/snap.sh p3 && $OUT/cmp.sh before p3
```
Expected: all green; `IDENTICAL` ×4 (the hint only sizes the allocation; the second request of each page in `snap.sh` is served from the hinted buffer — `curl` both twice if you want the hinted path in the fixture: the bodies must still `cmp`).

- [ ] **Step 4: Validate the writer threshold with criterion** — `cargo bench -p brust-server --bench render -- 'A/render_chain|A/finish_identity|B/render_chain|B/finish_identity'` on the lane HEAD vs the Task 8 commit (second worktree or `git stash`). Route A (`/type-chart`, large) must not be slower; route B (pikachu, small) goes through `render` (below `WRITER_MIN`) and must be unchanged within noise. If A is slower by > 1 %, the `Captured` cell costs more than the reallocations it saves on this allocator: set `WRITER_MIN = usize::MAX` (everything through `render`, keeping the in-place `inject_assets_into` and the hints for the outlet copies' sizing), note it, and move on — the lever's remaining value is measured in Task 10 either way.

- [ ] **Step 5: Commit**
```bash
git add crates/brust-server/src/render.rs crates/brust-server/src/pipeline.rs crates/brust-server/src/config.rs crates/brust-server/src/server/mod.rs crates/brust-server/src/lib.rs crates/brust-server/benches/render.rs
git commit -m "perf(render): render the chain into one hinted buffer; inject_assets in place (M3-P P3)

render_chain_into writes the root template straight into a String sized
from the route's last document length (Server::render_hints, a size per
manifest route) through minijinja's writer path when the document is
large, and inject_assets_into inserts the S9 tags in place; Bytes takes the
buffer without a copy. Inner levels are sized the same way (their output is
the parent's __outlet). The buffer is cleared first and never pooled;
capacity never changes a byte (tests).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Measure after P3, refresh the attribution patch, regenerate RESULTS, READY

**Files:**
- Modify: `bench/attribution.patch` (pipeline.rs/render.rs hunks for the Node pipeline, Scope and `render_chain_into`), `bench/RESULTS.md`, `bench/RESULTS.json`

- [ ] **Step 1: Bench (after P3), the lane's D/I row** — Task 1 Step 5 commands with `tee $OUT/bench-p3.txt`, copy `RESULTS.json` to `$OUT/RESULTS-p3.json`, revert RESULTS (the committed regeneration is Step 4 with ALL apps). Paste D/I rows, Δ vs P2, vs P1, vs before.

- [ ] **Step 2: Refresh the attribution patch for the new code.** `git apply --3way bench/attribution.patch` will reject the `render.rs` hunk (`SCOPE_BUILD`/`TMPL0..3` sat in `render_chain_value`'s loop) and the `pipeline.rs` hunks around `render_document`/`render_chain_html`. Re-instrument with the same stage ids: in `Renderer::render_chain_into` `SCOPE_BUILD` around the `Scope` build + `get_template`, `TMPL0 + pos.min(3)` around each `render_into`; in `pipeline::render_document` `RENDER_CHAIN` around `render_chain_into`, `INJECT` around `inject_assets_into`, `CPU_RENDER` as before; `CTX_VALUE` around `let base = ctx.to_value();`, `OVERLAY` around the overlay closure body. Then:
```bash
cargo check -p brust-server && git diff > $OUT/attribution.patch.new
cd packages/brust && bun run build && cd ../..
BRUST_RELEASE_ADDON=1 BENCH_CONN=120,1 ATTR_SIDES=v2 ATTR_OUT=$OUT/attr-p3-pokedex.json BENCH_LOCK_WS=<ws> BENCH_LOCK_ID='m3p-b-value-path Dew' bun $OUT/locked.ts | tee $OUT/attr-p3-pokedex.txt
BRUST_RELEASE_ADDON=1 BENCH_CONN=120,1 ATTR_SIDES=v2 ATTR_APP=bench ATTR_PROBES=D,I ATTR_OUT=$OUT/attr-p3-bench.json BENCH_LOCK_WS=<ws> BENCH_LOCK_ID='m3p-b-value-path Dew' bun $OUT/locked.ts | tee $OUT/attr-p3-bench.txt
git checkout -- Cargo.lock crates/ packages/brust/src/worker.ts && rm -f crates/brust-server/src/perf.rs
cp $OUT/attribution.patch.new bench/attribution.patch && git apply --check bench/attribution.patch && echo PATCH-OK
git diff --quiet crates/ packages/brust/src/worker.ts && echo clean
grep -rn '_brust/perf\|mod perf' crates/brust-server/src || echo no-perf-in-tree
cd packages/brust && bun run build && cd ../..
```
Paste the D and I (c=120) stage tables before / P1 / P2 / P3 side by side: `CW_JS_STRINGIFY`, `CW_JS_WRITE`, `CW_SER`, `CW_READ_PARSE`, `CTX_VALUE`, `OVERLAY`, `SCOPE_BUILD`, `TMPL0`, `TMPL1`, `RENDER_CHAIN`, `INJECT`, `MERGE_RESULTS`, `SEED`, `BODY_RESP`, `SVC_TOTAL`, CPU µs/req; and the pokedex B/C `RENDER_CHAIN`/`SVC_TOTAL` for continuity with m3p-a's note.

- [ ] **Step 3: Full gate list** (every line of Global Constraints, in this order; paste the `test result` lines):
```bash
cargo fmt --all -- --check
cargo clippy -p brust-compiler -p brust-compiler-cli -p brust-jinja -p brust-server -p brust-napi --no-deps -- -D warnings
cargo clippy -p brust-compiler --no-deps -- -D warnings
cargo test --workspace --exclude bun_react_compiler 2>&1 | grep -E 'test result|FAILED' | sort | uniq -c
cargo test -p brust-jinja 2>&1 | grep -E 'test result'
cargo test -p brust-compiler 2>&1 | grep -E 'test result'
cargo bench -p brust-server --bench render --no-run && cargo bench -p brust-jinja --bench json_attr --no-run
cd packages/brust && bun run build:debug && bun run typecheck && bun test test/routes.test.ts test/cache.test.ts test/worker.test.ts test/config.test.ts test/napi-compile.test.ts test/build-compile.test.ts && bun test test/napi-server.test.ts && bun test test/build-manifest.test.ts && bun test test/cli.test.ts && bun test --timeout 120000 test/e2e.test.ts && cd ../..
cd examples/pokedex && bun test && bun run typecheck && cd ../..
bun test --timeout 120000 tests/server/pokedex.test.ts
bun test --timeout 120000 tests/server/hydrate.chromium.test.ts
bun check -p bench && bun build --no-bundle bench/run.ts > /dev/null && bun test bench/lib
git diff --quiet crates/brust-server/benches/fixtures && echo GOLDEN-UNCHANGED
```

- [ ] **Step 4: Regenerate RESULTS with every app** (the lane's committed numbers are the full table, as m3b produced it):
```bash
cd packages/brust && bun run build && cd ../..
BRUST_RELEASE_ADDON=1 BRUST_01X_DIR=$BRUST_01X_DIR BENCH_LOCK_WS=<ws> BENCH_LOCK_ID='m3p-b-value-path Dew' bun run bench | tee $OUT/bench-final.txt
git status --short      # bench/RESULTS.md, bench/RESULTS.json, bench/attribution.patch — nothing else
git add bench/RESULTS.md bench/RESULTS.json bench/attribution.patch
git commit -m "bench: results after M3-P P1+P2+P3; attribution.patch for the Node pipeline

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git log --oneline m3p..HEAD     # 8 commits: attribution D/I, P1 worker, P1 jobs_request, P2 Node, P2 wire, P3 scope, P3 buffer, results
```

- [ ] **Step 5: READY note** (post on the Conclave task; the lead merges into `m3p`):
```
READY lane/m3p-b-value-path @ <sha>  (base m3p @ <sha>, after m3p-a)

| probe (identity, oha -c 120 -z 10s) | before | after P1 | after P2 | after P3 | 0.1.x (same runs) |
| D /dex?nocache=1 rps / p50 / p99 / bytes | … | … (Δ…%) | … (Δ…%) | … (Δ…%) | … |
| I /team?nocache=1 rps / p50 / p99 / bytes | … | … | … | … | … |
bar F68 line from the final RESULTS.md: D …%  I …%  → MET / NOT MET      load at start of each run: …   host darwin/arm64, Bun …

attribution (µs/req, c=120, bench app):  D: CW_JS_WRITE …→…, CW_JS_STRINGIFY …, CW_READ_PARSE …→…→…, CTX_VALUE …→0, OVERLAY …, SCOPE_BUILD …,
TMPL0/1 …, RENDER_CHAIN …→…→…, INJECT …, MERGE_RESULTS …, SVC_TOTAL …, CPU/req …     I: (same columns)     pokedex B/C RENDER_CHAIN/SVC_TOTAL: …
criterion: A/render_chain …→…, B/render_chain …→…, ctx_parse (Node) vs ctx_parse_serde_json+value_of: …; WRITER_MIN kept at 16 KiB / set to MAX (Task 9 Step 4)
P2 decision: (a) Node tree — mutation sites ported: page, merge_loader_data, parent_slots, entry_or, component_map, seed_child_slots, child_cell, merge_values, merge_result, merge_legacy; readers: inputs.rs ×5 + pipeline ×8; plan-golden unchanged
byte-identical: snap.sh before/p1/p2/p3a/p3 → IDENTICAL ×4 at each point;   gates: <paste test result lines>
guard: `git diff --quiet crates/ packages/brust/src/worker.ts` clean at every commit; grep '_brust/perf|mod perf' → empty; attribution.patch applies on HEAD
divergence (documented): LoaderResponse by hand — a wrong-typed field is a parse error (500) where the untagged enum fell through to the next variant; the worker never emits such shapes
follow-ups for the lead: use_ids precomputed per (route, component) at boot; a per-parse key interner (151 rows × same 4 keys = 604 Arc<str> allocs on D); CachedEntry.ctx is dead weight since S10 (store nothing); P6 will move job keys to the worker — `inputs::job_key` over Node is the Rust reference until then
```

## Self-review

**Spec coverage.**
- §2 P1 "`TextEncoder.encodeInto` straight into the SAB slot (one copy, not two)" (`worker.ts:62-76`) → Task 2 Step 2; "loaders merge into one object without re-spreading per level" (`:156`) → Task 2 Step 3; "`jobs_request` stops deep-cloning `inputs` per miss" (`pipeline.rs:1288-1302`) → Task 3. Expected `CW_JS_STRINGIFY + SAB_WRITE down` → Task 4 reads `CW_JS_STRINGIFY`/`CW_JS_WRITE`.
- §2 P2 "parse loader/jobs responses straight into a render `Value` … skipping `serde_json::Value` + `value_of` over the whole ctx" (`dispatch.rs:219`, `pipeline.rs:628`, `brust-jinja/src/lib.rs:17`) → Task 5 (the tree + views + `json_attr` fast path) and Task 6 (manual `LoaderResponse`, `Node` end to end, caches). The parse target is `Node` rather than a `minijinja::Value` because the pipeline must read AND mutate the context before rendering (the KEY DESIGN QUESTION; answered (a) in Architecture with the sites listed in Task 6). Expected `−(11–14 µs parse + ctx→Value)` → Task 7 reads `CW_READ_PARSE` and `CTX_VALUE`.
- §2 P3 "string-keyed map object (`Object` impl keyed by `Arc<str>`) instead of `BTreeMap<Value,Value>`" → `CtxMap` (Task 5: `BTreeMap<Arc<str>, Node>` + `get_value_by_str`); "overlays as views (no per-component map clone)" (`render.rs:100-133`, `pipeline.rs:633-648`) → Task 8 (`Overlay`/`Scope`); "render chain writes into ONE `String`/`BytesMut` through `inject_assets`" → Task 9 (`render_chain_into`, `inject_assets_into`, `render_hints`). Expected `render −5–11% + fewer allocs per level` → Tasks 7/10 criterion + `RENDER_CHAIN`.
- §2 per-lane rule "output byte-identical (pokedex snapshot tests + bench parity), all gates green, bench probe D and I before/after + `attribution.ts` stage diff in the task note, `RESULTS.md` regenerated" → Global Constraints (four-way `curl` diff + plan golden + snapshot/e2e tests), Tasks 1/4/7/10 (bench D/I identity + attribution at four points; `run.ts`'s parity check runs on every bench), Task 10 Step 4 (full regeneration once).
- §4 lane row (complex / complex, Mellow) → Dispatch table. §5 stop rule: the lead's call; the note reports every lever's delta so it can be applied. §7 integration branch, no PR, READY to the lead → Global Constraints + Task 10 Step 5.
- Measurement rules from the brief: host lock on every measurement (`run.ts` built-in + `$OUT/locked.ts` for attribution), release addon with `BRUST_RELEASE_ADDON=1`, `attribution.patch` never committed applied (guard before every commit), `RESULTS.md` regenerated at the end only, measure after each of P1/P2/P3 → Global Constraints, Tasks 4/7/10.

**Risk ledger.**
1. **(a) is a wide mechanical port.** ~10 mutation sites, ~13 readers, two cache types, the bench harness and ~60 test fixture swaps. Pins: the plan golden (keys, inputs JSON, request JSON, `seed + merge == captured`), the Task 5 render-equivalence sweep (400 JSON samples × 10 templates), the `json_attr` sweep (5 000 samples), four `curl` snapshots at every point, every existing pipeline/inputs/cache test re-targeted without changing its assertions. If the port stalls, the fallback that still lands P2's parse win is: keep `Node` at the parse and in `render_chain_html` only and convert `Node → serde_json::Value` for the planning stage (a deep walk again) — report it as partial, never as done.
2. **Hand-written `LoaderResponse` deserializer diverges from untagged on malformed input** (a wrong-typed field is an error instead of a fallthrough). The worker (`worker.ts` `LoaderResponse` type) never produces such shapes; the seven protocol tests + `fake_bun` pin the real shapes; the divergence is written in the type's doc and the READY note.
3. **Key order / number text.** `BTreeMap<Arc<str>, _>` orders by bytes like `serde_json::Map`; `serde_json::Number`'s `Display` is the serializer's ryu/itoa text (today's one-pass `json_attr` number arm already relies on it and its 20 000-sample test passes with `1e21`, `1e-7`, `f64::MAX`, `5e-324`). Pinned by Review Focus 2/3 sweeps, which include unsorted keys and every number form.
4. **`Arc::make_mut` copy-on-write and the job cache.** A cached value merged into the context is shared; any write through it copies that level. The pipeline never writes INTO a merged value (it writes into the context's own cells), so the copies never happen in practice; `merging_a_cached_value_never_mutates_the_cache_entry` proves the invariant if a future merge does. Memory: a shared `Arc<CtxMap>` keeps the cache entry's subtree alive while an L1 entry holds the context — the same bytes the deep copy used to hold, now once.
5. **`render_captured_to` overhead vs reallocation savings** (Task 9). The writer path boxes a `Captured` cell and clones the template handle per call; a growing `String` reallocates log2(n) times. The 16 KiB threshold keeps small pages (I, 781 B) on `render`; criterion A/B before/after decides whether the writer stays for large pages (Task 9 Step 4 has the explicit `WRITER_MIN = usize::MAX` fallback). `from_utf8_unchecked` is justified by `WriteWrapper::write_str` writing whole `&str`s into a `Vec<u8>` that never fails.
6. **Scope precedence drift.** `__outlet > _props > own > children > ids > base` with undefined skipped is pinned by `scope_lookup_order_matches_the_merge_dict` against the real `context!{..}` shape, plus `jinja_round_trip` (overlay beats base) and `outlet_composes_leaf_first`.
7. **`encodeInto` on a `SharedArrayBuffer` view.** WebIDL allows `[AllowShared] Uint8Array` for `encodeInto`; the Task 2 test runs it on a real SAB like production. If Bun ever rejected it, the test is red before the e2e is.
8. **Attribution patch hygiene.** Four apply/revert cycles; the guard before every commit, `git show --stat` per commit, the `grep` at READY. The patch file itself changes once in this lane (Task 10 refresh; Task 1 only if m3p-a's Task 7 left it broken).
9. **Benches are not built by `cargo test`.** `benches/render.rs` and `json_attr.rs` use the changed APIs; `cargo bench … --no-run` is in the gate list so they cannot rot silently.
