# beta1-ci-late-plan: make `a_late_planned_call_leaves_no_plan_behind` deterministic on a slow CI runner

**RULED by lead Detoro 2026-10-12 (plan written by the lead). Routine test-only lane, blocks PR #143. CI (Linux, debug, loaded) failed `crates/brust-server/tests/single_roundtrip.rs:216` with `the late call took the offer: left (1, 0) right (1, 1)`; the lead's local debug loop passes 10/10 and the stress test is unchanged since PR #140. Treat it as a test-ordering race, not a product bug, unless the investigation below proves otherwise (then: task challenge with evidence, no product patch here).**

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: beta1 @551f4f5 · lane: beta1-ci-late-plan · tier: routine · review: standard

**Goal.** The test asserts the same invariants (504 on the first call; the seed waits in its claimed slot; after `settle_all` the detached remainder plans, takes the offer, releases the cell; `timed_out_calls == 1`) without racing the fake's call counters against the cell release.

## Boundary
`crates/brust-server/tests/single_roundtrip.rs` (this test only) and, if a helper is needed, `crates/brust-server/tests/common/fake_bun.rs` (additive only).

## Tasks
1. `conclave lane start 838f12fb-70c1-41b7-acf2-d4065cf6bb64 beta1-ci-late-plan`; `cargo test -p brust-server --test single_roundtrip a_late_planned_call` green baseline.
2. Read the test (:197-219) and the detached-remainder path it exercises (`pipeline.rs` plan offer / `RenderClaim::drop` in `pool.rs`; `FakeBun::gated`, `settle_all`, `counts()` in `tests/common/fake_bun.rs`). Establish the ORDER in which (a) the fake records the jobs call and (b) `plan_cells_in_use()` drops to 0. If (b) can precede (a) — the claim drops when the remainder's future completes while the fake's counter increments on its own thread/after the reply — the test's `assert_eq!(f.counts(), (1, 1))` right after the cell loop is the race. Write that finding in the READY note.
3. Fix the TEST: after `settle_all`, wait (≤ 5 s, 1 ms polls) until BOTH `f.counts() == (1, 1)` AND `s.plan_cells_in_use() == 0` (and `timed_out_calls == 1`), then assert all three; the deadline failure message prints the observed counts/cells. No sleeps as oracles; the 50 ms `call_timeout_ms` stays. If step 2 shows the late call can legitimately NOT take the offer under load (e.g. the offer window closes before JS settles), the test must instead assert "no plan cell is left behind" as the primary invariant and accept counts (1,0) OR (1,1) with a comment explaining why — and say so in READY; the lead decides whether that is acceptable.
4. Loop: `for i in $(seq 30); do cargo test -p brust-server --test single_roundtrip -q 2>&1 | grep -E "FAILED|panicked" && echo FAIL$i; done` → no FAIL; also run once under load (`cargo build -p brust-compiler --release` in parallel) to mimic CI. fmt + clippy clean.
5. Commit `test(server): the late planned call test waits for the counters before asserting (CI race)`; READY note with the ordering finding and the 30× result.

## Acceptance (Afrojack)
Only the one test changed (plus an additive helper if any); 30× green; the three invariants still asserted; fmt/clippy clean.
