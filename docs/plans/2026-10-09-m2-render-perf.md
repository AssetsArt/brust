# M2p — render-path performance (ledger F68) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: `v2` after `m2e-pokedex-exit` merges (the lead fills the sha in the dispatch note)

**Goal:** Meet the M2 bench bar — v2 not slower than 0.1.x on probes A (static hit), B (native miss) and C (react child), measured with `Accept-Encoding: identity` on both sides — by removing the render-path costs knock2's A/B exposed (bench/RESULTS.md on the m2e lane: A −48.9 %, B −71.7 %, C −78 %; identity vs gzip alone doubles rps), without changing any rendered byte.

**Architecture:** three independent costs, each with its own measurement before and after: (1) a cached route re-renders the whole document on every HIT and gzips it every time — cache the rendered body (+ lazy gzip) in the L1 entry (spec S10 amendment); (2) dynamic responses are gzipped at the default level on every request — level 1, only above 16 KiB; (3) the per-request render path converts the context through serde, deep-clones it per overlay, renders parent and child templates separately and rescans the HTML for `</body>` — measure each with a micro-benchmark on the real pokedex templates and fix the ones that show.

**Tech Stack:** Rust (`criterion` dev-dependency for `crates/brust-server/benches`, `flate2`), `oha` for the macro bench (`bench/run.ts` from m2e), `cargo flamegraph` optional (document the command, not required in CI).

**Spec:** S10 amendment of 2026-10-09 (cached rendered body; gzip policy; bar measured identity), S14, ledger F68.

## Global Constraints

- Not a single rendered byte changes: the m2e e2e (`tests/server/pokedex.test.ts`), `cargo test -p brust-server`, the browser suite and the battery stay green with no golden change; a body served from the cache is byte-equal to a fresh render (Task 2 pins it with a test that renders twice and compares).
- Measure first, then change: every task records before/after numbers in the task note from the SAME host and the same `oha` settings; the bar is judged on the final `bench/RESULTS.md` identity column.
- No new caches beyond the L1 entry's body; no change to keys, TTLs, tags or invalidation semantics.
- Gates: `cargo fmt`, `cargo clippy --workspace --exclude bun_react_compiler --no-deps -- -D warnings`, `cargo test -p brust-server`, `cd packages/brust && bun test`, `bun test tests/server`, `bun run battery` (no diff).
- Boundary: `crates/brust-server/**`, `bench/**`, `docs/plans/m2-exit-report.md` (regenerated), `scripts/m2-exit/**`, `docs/plans/m1a-followups.md`, `Cargo.toml`, `Cargo.lock`.

## Review Focus

1. **Cached body vs invalidation**: after `cache.invalidate({tags})` the next request must MISS and re-render (not serve a stale body) — Task 2 pins it in the server tests.
2. **Cached body vs `Vary`**: a HIT must answer identity and gzip clients correctly from one entry (gzip bytes made lazily once, `Vary: Accept-Encoding`, `Content-Length` right for each) — Task 2 pins both.
3. **Gzip threshold**: a 10 KiB dynamic response is never gzipped; a 20 KiB one is, at level 1, only when accepted — Task 3 pins it.
4. **Overlay semantics unchanged**: layout and page both numbering `_s1` still paint their own values after the clone-free overlay change — Task 4 re-runs the m2b collision test (`layout_and_page_precompute_slots_collide`) unchanged.
5. **Bench honesty**: the identity column is the bar; `RESULTS.md` states host, Bun, load average and that macOS ≠ Linux; a run with load average above the core count is rejected by `bench/run.ts` (prints and exits 2) — Task 5 pins it.

---

### Task 1: Measure (micro + macro baselines)

**Files:**
- Create: `crates/brust-server/benches/render.rs` (criterion: `render_chain` of the pokedex `type-chart` and `pokemon` templates with their real contexts captured from `examples/pokedex` via `brust build` output + a canned loader JSON; `inject_assets`; `Value` conversion of the context; gzip of the rendered HTML at levels 1 and 6)
- Modify: `crates/brust-server/Cargo.toml` (`[dev-dependencies] criterion`, `[[bench]] harness = false`), `bench/run.ts` (identity + gzip runs per probe; refuse when `os.loadavg()[0] > os.cpus().length`)
- Test: none (measurement); paste numbers in the task note

- [ ] **Step 1**: `cargo bench -p brust-server --bench render` → table of ns/op for: context→Value, render parent, render page, inject_assets, gzip L1/L6, total. Paste in the task note.
- [ ] **Step 2**: `bun run bench` on a quiet host (load average below core count) with the identity column added → paste the before table. Commit `bench: criterion render micro-bench; identity column + load guard`.

---

### Task 2: Cached rendered body on L1 HIT

**Files:**
- Modify: `crates/brust-server/src/cache/l1.rs` (entry gains `body: OnceLock<Arc<RenderedBody>>` where `RenderedBody { html: Bytes, gzip: OnceLock<Bytes>, status: u16, headers: Vec<(HeaderName, HeaderValue)> }`), `crates/brust-server/src/pipeline.rs` (HIT path: if the entry has a body, serve it; MISS path: after render, store the body with the context; gzip made lazily on first gzip-accepting request), `crates/brust-server/src/render.rs` (no change expected)
- Test: `crates/brust-server/tests/server.rs` / `cache.rs` (append)

- [ ] **Step 1: Failing tests**
```rust
#[test] fn hit_serves_the_cached_body_byte_equal_to_a_fresh_render() { /* GET twice; second has x-brust-cache: HIT; bodies equal; stats.l1.hits == 1 */ }
#[test] fn hit_answers_identity_and_gzip_from_one_entry() { /* identity then gzip then identity: Content-Encoding only on the gzip one, Vary: Accept-Encoding on all, gunzip(gzip) == identity body, l1.len stays 1 */ }
#[test] fn invalidate_tags_drops_the_body_with_the_entry() { /* HIT, invalidate({tags}), next is MISS and re-renders (counter loader_calls increments) */ }
```
- [ ] **Step 2–3**: implement; `cargo bench` again for the HIT path (expect a memcpy-class number); `cargo test -p brust-server`.
- [ ] **Step 4**: commit `perf(server): L1 HIT serves the cached rendered body (+ lazy gzip) — S10 amendment`.

---

### Task 3: Gzip policy for dynamic responses

**Files:**
- Modify: `crates/brust-server/src/pipeline.rs:~607` (gzip only when `accepts_gzip && len >= 16 * 1024`, level 1), `crates/brust-server/src/http/compress.rs` (level parameter)
- Test: `crates/brust-server/tests/server.rs` (10 KiB vs 20 KiB fixture pages; `Content-Encoding` present/absent; identity client never gzipped)

- [ ] Steps: failing tests → implement → `cargo test` → commit `perf(server): dynamic gzip level 1 above 16 KiB`.

---

### Task 4: Render path allocations

**Files:**
- Modify: `crates/brust-server/src/pipeline.rs` / `render.rs` (convert the loader context to a `minijinja::Value` ONCE per request; per-component overlays as a layered `Object` over the base `Value` (no `serde_json::Value` deep clones); `render_chain` writes child HTML straight into the parent's `__outlet` without an intermediate `String` per level where the API allows; `inject_assets` finds `</body>` from the end with `rfind` on bytes), `crates/brust-server/benches/render.rs` (re-measure)
- Test: existing suites (byte equality); `cargo bench` before/after per item in the task note

- [ ] Steps: one commit per item that measurably helps (`perf(server): …`), with the micro-bench delta in the commit body; drop any change that does not move the number.

---

### Task 5: Re-run the bar, report, close F68

**Files:**
- Modify: `bench/RESULTS.md` + `.json` (fresh run, identity column is the bar, gzip column beside it, load average and host recorded), `docs/plans/m1a-followups.md` (F68 → DONE or re-filed with the remaining gap and a named cause), `scripts/m2-exit/exit.ts` (the bar sentence computed from the identity column), `docs/plans/m2-exit-report.md` (regenerated)

- [ ] **Step 1**: `bun run bench` on a quiet host → bar met on A, B, C in the identity column? If any probe is still slower, record the gap and the measured cause from the micro-bench (not a guess) and STOP — file a challenge with the numbers; the lead decides between another iteration and re-filing the bar.
- [ ] **Step 2**: `bun test scripts/m2-exit` green with `bar === 'met'` (F68 DONE flips the pinned assertion back to `met`-only); commit `docs: M2 bench bar met — F68 closed`.

## Verification (READY evidence, paste in the task note)

```
cargo bench -p brust-server --bench render | tail -20        # before/after per item (paste both)
bun run bench && sed -n 1,20p bench/RESULTS.md               # identity column: v2 >= 0.1.x on A, B, C
cargo test -p brust-server && cd packages/brust && bun test && cd ../.. && bun test tests/server && bun run battery && git status --short docs/
bun test scripts/m2-exit                                     # green with bar met
```
PR `lane/m2p-render-perf` → `v2`, CI green, lane HEAD sha.

## Dispatch table (for the Coordinator)

| slug | plan tasks | tier | role | deps | review | acceptance (READY evidence) |
|---|---|---|---|---|---|---|
| `m2p-render-perf` | 1–5 | complex | Implementer (Complex) | `m2e-pokedex-exit` merged | complex | Verification block pasted with before/after tables; `bench/RESULTS.md` identity column meets the bar or a challenge with the measured cause; PR → `v2` CI green; lane HEAD sha |

Review is `complex` because the reviewer must re-run the bench on the same host and diff the served bytes (cached vs fresh) themselves.
