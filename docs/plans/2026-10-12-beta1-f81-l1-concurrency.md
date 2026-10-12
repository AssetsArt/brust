# beta1-f81-l1-concurrency: commit the L1 concurrency probes as `tests/l1_concurrency.rs`

**RULED by lead Detoro 2026-10-12 (plan written by the lead; decisions final). Routine lane; this lane touches NO line of `l1.rs` — the gate-free rationale and the invariant comment are owned by lane `beta1-f86-l1-generation` (its ruling R6), which also changes the `insert` signature; if `beta1` already carries that change when you start, call `insert(key, body, ttl, tags, cache.read_stamp())` and check the return value where the plan says the insert must land. If a probe FINDS a defect, that is a `task challenge` with the failing test attached, never a fix in this lane. Dispatch after `beta1-release-prep` is READY (same implementer).**

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: beta1 · lane: beta1-f81-l1-concurrency · tier: routine · review: standard

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Ledger row (docs/plans/m1a-followups.md:145, F81): "writer progress under ≥ 10 readers and `invalidate_path` racing inserts/capacity churn have no committed test (`l1_front.rs` covers 4 HTTP readers); Mellow's two scratch probes (12 readers on a hot key vs 300 writer ops, worst writer op 10 ms; 8 owners × 3000 insert→read→invalidate rounds under cap 64/500 keys + global tag invalidation + `clear()`) passed ×10 but were not committed. `invalidate_path` is gate-free on purpose (front is a superset of moka; the key stripe orders same-key writers) and the doc does not say so."

**Goal.** After this lane merges into `beta1`:
- `crates/brust-server/tests/l1_concurrency.rs` exists with two deterministic tests (no wall-clock latency assertions) that exercise the `L1Cache` API directly (`crates/brust-server/src/cache/l1.rs:295-508`: `new`, `with_capacity`, `get`, `get_with`, `insert`, `invalidate_path`, `invalidate_tags`, `clear`, `stats`, `build_cache_key` at :554).
- Ledger row F81 starts with `DONE 2026-10-12 — …`.

## Decisions (lead rulings, final)

- **R1 No latency assertions.** CI runs on Linux under load; "worst writer op 10 ms" is a local observation, not a test oracle. Assert PROGRESS and CONSISTENCY instead: every writer op completes (the writer thread joins within a generous budget of 30 s, enforced by a watchdog thread that panics the test, never by timing an op); every reader observation is one of the values the writer ever inserted or `None`.
- **R2 Source of the probes.** Ask Mellow once for the scratch sources (`conclave tell ab26f5eb-ccdd-4961-818e-c0f9f04b416b "F81: please paste or path your two L1 probes from m3p-c spot-check b1f95371"`). Do not block on the answer: if nothing arrives by the time Task 1 is done, write them from the description below. Either way the committed tests follow R1.
- **R3 Test-only visibility.** Integration tests in `tests/` cannot see `#[cfg(test)]` items, and no feature flag is added for this. Use `stats()` (:449) and observable behaviour as oracles: `get` after `clear()` returns `None` for every key; `stats()` entries == 0; `get` after `invalidate_path` returns `None`.
- **R4 Runtime budget.** Both tests together must run under 5 s in `cargo test` (debug). Scale the loop counts down from the probe (e.g. 8 owners × 500 rounds) until that holds; the counts are constants at the top of the file with a comment citing the original probe sizes.

## Boundary

`crates/brust-server/tests/l1_concurrency.rs` (new), `docs/plans/m1a-followups.md` (row F81 only). NOT `l1.rs`.

## Tasks

### Task 1 — lane worktree, read the API

- [ ] `conclave lane start 838f12fb-70c1-41b7-acf2-d4065cf6bb64 beta1-f81-l1-concurrency` (worktree `../brust-lane-beta1-f81-l1-concurrency`, branch `lane/beta1-f81-l1-concurrency` from `beta1`).
- [ ] Send the R2 tell to Mellow. Continue.
- [ ] Read `crates/brust-server/src/cache/l1.rs:240-560` and `crates/brust-server/tests/l1_front.rs` (how a test builds keys and bodies: `build_cache_key`, `RenderedBody`). Note the exact constructor for `RenderedBody` used there and reuse it.
- [ ] `cargo test -p brust-server --test l1_front` → green baseline.

### Task 2 — `tests/l1_concurrency.rs`, test A: hot key, 12 readers vs 1 writer

- [ ] File header: `//! F81 — the two L1 concurrency probes from the m3p-c spot-check (b1f95371), made deterministic: progress + consistency, no latency oracles.` Constants: `READERS = 12`, `WRITER_OPS = 300`, `OWNERS = 8`, `ROUNDS = 500` (probe: 3000), `CAP_SMALL = 64`, `CAP_LARGE = 500`.
- [ ] Test `hot_key_writer_makes_progress_under_twelve_readers`: one `L1Cache::new()`; one key `build_cache_key("GET", "/hot", …)`; `AtomicBool stop`; 12 reader threads loop `cache.get(&key)` until `stop`, and for each `Some(body)` assert the body bytes are one of the writer's values (encode the op index into the body, e.g. `format!("v{i}")`, and check it parses and is ≤ the current max op; a `None` is fine). Writer thread: for `i in 0..WRITER_OPS` alternate `insert(key, body(i), ttl 60 s, &["hot"])` and, every 7th op, `invalidate_path("GET", "/hot")` (gate-free path); after the loop set `stop`. Watchdog: `std::thread::spawn` that sleeps 30 s and then `std::process::abort()` unless a `done` flag is set — use a scoped-thread join with the flag set right after joins; keep it simple: `std::thread::scope` and assert the writer's join returns before a 30 s `Instant` deadline measured ONLY as a hard ceiling (`assert!(start.elapsed() < Duration::from_secs(30))`).
- [ ] After the join: `cache.get(&key)` is either `None` (last op was an invalidate) or the LAST inserted value; `stats()` is consistent (entries ≤ 1).
- [ ] `cargo test -p brust-server --test l1_concurrency hot_key` → pass; run it 10× in a shell loop → 10/10.

### Task 3 — test B: 8 owners × ROUNDS insert→read→invalidate under capacity churn

- [ ] Test `owners_churn_under_capacity_with_tag_invalidation_and_clear`, parameterised over `[CAP_SMALL, CAP_LARGE]` (two loops in one test or two tests — your call): `L1Cache::with_capacity(cap)`; 8 owner threads, owner `o` works keys `/o{o}/k{j}` for `j in 0..ROUNDS`: `insert(key_j, body, ttl 60 s, &[format!("owner{o}"), "all"])`, then `get(&key_j)` must be `Some(body)` OR `None` (moka may reject admission under cap; NEVER a different body), then every 3rd round `invalidate_path` on that key and assert the next `get` is `None`; every 50th round `invalidate_tags(&["all"])`; a 9th thread calls `clear()` 5 times at random points (seeded `rand`? `brust-server` dev-deps — check `Cargo.toml` and reuse what `l1_front.rs` uses; if no RNG is available use a fixed stride).
- [ ] After all joins: `cache.clear()` returns the remaining count; then for a sample of 50 keys `get` is `None`; `stats()` entries == 0. No panic anywhere is the main oracle (the listener/stripe/gate invariants panic or deadlock when wrong — a deadlock is caught by the 30 s ceiling as in Task 2).
- [ ] `cargo test -p brust-server --test l1_concurrency` → both pass, wall time printed by cargo < 5 s. Run 10× → 10/10. If a run fails: do not weaken the test — `conclave task challenge` with the output.

### Task 4 — fmt, ledger, READY

- [ ] `cargo fmt --all -- --check` and `cargo clippy -p brust-server --all-targets -- -D warnings` → clean (doc comment lines ≤ 120 chars if rustfmt complains).
- [ ] `docs/plans/m1a-followups.md` F81 "what to do" cell → prefix `DONE 2026-10-12 — tests/l1_concurrency.rs (2 deterministic tests); gate-free rationale documented by F86; `.
- [ ] Commit: `test(l1): commit the F81 concurrency probes as deterministic tests` + `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- [ ] `conclave task note … beta1-f81-l1-concurrency READY @<sha> — 2 tests, 10/10 × 2, <t> s; probes from Mellow: yes/no`.

## Acceptance (Afrojack, standard)

1. `cargo test -p brust-server --test l1_concurrency` green; `for i in $(seq 10); do cargo test -p brust-server --test l1_concurrency -q || echo FAIL; done` → no FAIL; total time < 5 s per run.
2. No `sleep`-based or elapsed-time-per-op assertion in the file; the only time check is the 30 s hard ceiling.
3. `git diff beta1...lane/… -- crates/brust-server/src` is EMPTY.
4. fmt + clippy clean; ledger F81 cell starts with `DONE`.

## Gates (lead, at merge)

fmt, clippy, `cargo test --workspace --exclude bun_react_compiler` (fail-fast; your new test is in it), release `single_roundtrip`; JS gates unaffected; `bun run m2-exit` (ledger row changed → report may change; regen with a fresh addon).

## Risk ledger

- Flakiness under CI load is the whole risk; R1 removes the latency oracle and the 30 s ceiling only catches deadlocks. If a run is slow but correct, lower ROUNDS, not the assertions.
- moka admission (TinyLFU) may reject inserts under cap; `get` after `insert` returning `None` is legal, a DIFFERENT body is not.
- `clear()` racing `insert` must not panic (the listener drops only matching generations) — if it does, that is a real finding: challenge with the backtrace.

## Reporting

READY note as in Task 4; challenges via `conclave task challenge 838f12fb-70c1-41b7-acf2-d4065cf6bb64 beta1-f81-l1-concurrency --claim <text>`.
