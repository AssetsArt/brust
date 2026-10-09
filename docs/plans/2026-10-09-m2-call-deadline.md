# M2b2 — per-call deadline for worker calls (ledger F64) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: `v2` after `m2x-minijinja-3` merges (the lead fills the sha in the dispatch note)

**Goal:** A loader or job call that does not settle within `BRUST_CALL_TIMEOUT_MS` (default 30000) answers the client with **504** at once, while the slot claim stays held by the detached task until the JS promise settles (the late result is discarded and the claim released), so one parked call can never freeze a worker's slots forever and `/_brust/cache/stats` counts such calls (`timed_out_calls`). Found by Mellow's m2c probe (one worker + one parked loader → every later request 503 after `claim_timeout_ms`).

**Architecture:** no change to the claim/release invariant in `pool.rs` (its comment at :169-172 forbids releasing before Promise settlement — this plan obeys it: the deadline races the `task.await` in `call_worker`, never the claim). One new `Tuning` field flows JS → napi → Rust like `claimTimeoutMs`. One new `CallError::Deadline` maps to a new `body::error_504`.

**Tech Stack:** Rust (tokio `select!`/`timeout`), napi-rs options struct, TypeScript config/env parsing in `packages/brust`.

**Spec:** server spec §7 (errors: "a worker claim timeout → 503"; this adds "a call deadline → 504"), S1 (two call kinds), ledger F64.

## Global Constraints

- The claim is released ONLY when the JS promise settles (success, rejection, enqueue failure) — never by the deadline. A test proves the slot is busy after the 504 and idle after the late settle.
- The late result is discarded: nothing from a timed-out call is written to any cache or context.
- `claim_timeout_ms` (waiting for a free slot → 503 "all workers busy") and `call_timeout_ms` (a claimed call not settling → 504) are distinct knobs with distinct status codes; neither changes the other's behaviour.
- Default `call_timeout_ms = 30000`; `0` is rejected at config (`BrustConfigError`), max `MAX_MS`.
- Gates before every commit: `cargo fmt --all`, `cargo clippy --workspace --exclude bun_react_compiler --no-deps -- -D warnings`, `cargo test -p brust-server -p brust-napi`; then `cd packages/brust && bun test`, and the root gates unchanged.
- Boundary: `crates/brust-server/src/{dispatch.rs,pipeline.rs,config.rs,server/mod.rs,server/body.rs}`, `crates/brust-server/tests/**`, `crates/brust-napi/src/server.rs`, `packages/brust/src/{config.ts,run.ts,native.ts}`, `packages/brust/test/**`, `packages/brust/README.md`, `docs/plans/m1a-followups.md`.

## Review Focus

1. **Deadline fires, then JS settles successfully**: the client already got 504; the late value must not enter the job cache or L1 and the slot must be released exactly once — Task 1 pins it with a gated fake.
2. **Deadline fires, then JS rejects**: same, and `PromiseRejected` must not be logged as an error for a call the client no longer awaits (log at `debug`) — Task 1 pins it.
3. **Two calls on one slot**: a 504'd call still holds its slot, so the next request with `claim_timeout_ms` small gets 503, not a second 504 — Task 1 pins the ordering.
4. **`HEAD` and static routes** are unaffected (no worker call) — Task 2 pins it in the server test.
5. **Env parsing**: `BRUST_CALL_TIMEOUT_MS=0` and `=abc` are `BrustConfigError`; unset → 30000 — Task 3 pins it.

---

### Task 1: `call_worker` deadline (Rust)

**Files:**
- Modify: `crates/brust-server/src/dispatch.rs` (`CallError` :130, `call_worker` :183-222), `crates/brust-server/src/server/mod.rs` (`Tuning` :49-74: add `call_timeout_ms: u64`, default 30_000), `crates/brust-server/src/config.rs` (`Server` field `call_timeout: Duration` beside `claim_timeout` :177; `Stats` :136 gains `timed_out_calls: u64`; a `timed_out_calls: AtomicU64` beside `loader_calls` :105), `crates/brust-server/src/server/body.rs` (add `pub(crate) fn error_504(msg: &str)` next to `error_503` :248)
- Test: `crates/brust-server/src/dispatch.rs` unit tests (reuse `GatedDispatch` :474)

**Interfaces:**
- Consumes: `claim_or_wait`, `RenderClaim` (owned, `'static`, released on `Drop`), `GatedDispatch`.
- Produces: `CallError::Deadline` (Display: `"call deadline exceeded"`); `call_worker(pool, claim_timeout, call_timeout, kind, req)` — new fourth argument `call_timeout: Duration`; `Tuning.call_timeout_ms`; `Stats.timed_out_calls`; `body::error_504`.

- [ ] **Step 1: Failing unit tests** (append to the `mod tests` in `dispatch.rs`; model on `call_worker_keeps_slot_claimed_after_caller_drops` :499)
```rust
#[tokio::test]
async fn deadline_returns_504_error_and_keeps_the_claim_until_js_settles() {
    let (gated, release) = GatedDispatch::new();              // resolves when `release` fires
    let pool = Arc::new(WorkerPool::new());
    pool.register(Box::new(gated));
    let r = call_worker::<_, serde_json::Value>(&pool, Duration::from_millis(100), Duration::from_millis(50), CallKind::Loader, &serde_json::json!({})).await;
    assert!(matches!(r, Err(CallError::Deadline)), "{r:?}");
    assert!(matches!(pool.try_claim_render_lockfree(), ClaimResult::AllBusy), "slot must still be claimed after the deadline");
    release.send(Ok(2)).unwrap();                              // late settle (a 2-byte reply)
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(matches!(pool.try_claim_render_lockfree(), ClaimResult::Claimed(_)), "slot released once JS settled");
}

#[tokio::test]
async fn late_rejection_after_deadline_releases_the_claim_quietly() {
    let (gated, release) = GatedDispatch::new();
    let pool = Arc::new(WorkerPool::new());
    pool.register(Box::new(gated));
    let r = call_worker::<_, serde_json::Value>(&pool, Duration::from_millis(100), Duration::from_millis(50), CallKind::Jobs, &serde_json::json!({})).await;
    assert!(matches!(r, Err(CallError::Deadline)));
    release.send(Err(DispatchError::PromiseRejected("boom".into()))).unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(matches!(pool.try_claim_render_lockfree(), ClaimResult::Claimed(_)));
}

#[tokio::test]
async fn a_timed_out_call_still_occupies_its_slot_so_the_next_caller_gets_timeout_not_deadline() {
    let (gated, _release) = GatedDispatch::new();              // never released during the test
    let pool = Arc::new(WorkerPool::new());
    pool.register(Box::new(gated));                            // one slot
    let first = call_worker::<_, serde_json::Value>(&pool, Duration::from_millis(100), Duration::from_millis(30), CallKind::Loader, &serde_json::json!({})).await;
    assert!(matches!(first, Err(CallError::Deadline)));
    let second = call_worker::<_, serde_json::Value>(&pool, Duration::from_millis(60), Duration::from_millis(30), CallKind::Loader, &serde_json::json!({})).await;
    assert!(matches!(second, Err(CallError::Timeout)), "{second:?}");
}
```
(If `GatedDispatch::new` does not return a sender of `Result<u32, DispatchError>`, extend it so a test can settle with either outcome; keep the existing tests green.)

- [ ] **Step 2: Run to verify failure** — `cargo test -p brust-server deadline` → compile error (no `Deadline`, wrong arity).

- [ ] **Step 3: Implement**
```rust
// dispatch.rs — CallError
#[error("call deadline exceeded")] Deadline,

// call_worker: after `let task = tokio::spawn(async move { ... })` (the task owns the claim and
// releases it on every path exactly as today), replace `task.await` with:
match tokio::time::timeout(call_timeout, task).await {
    Ok(joined) => joined.map_err(|e| CallError::BadResponse(format!("worker call task: {e}")))?,
    Err(_elapsed) => {
        // The task keeps running and keeps the claim until JS settles (pool.rs:169-172 rule);
        // its late result is dropped with the JoinHandle.
        return Err(CallError::Deadline);
    }
}
```
Inside the spawned task, when the result is `PromiseRejected`/`EnqueueFailed`, keep the existing behaviour; the caller is gone, so no extra logging there. Add `call_timeout_ms` to `Tuning` + `Default`, `Server.call_timeout`, the `timed_out_calls` counter, `Stats.timed_out_calls`, `body::error_504`.

- [ ] **Step 4: Run** `cargo test -p brust-server` → the three new tests pass; `ping_and_stats_shape` (`tests/server.rs:19`) is updated for `/timed_out_calls`.

- [ ] **Step 5: Commit**
```bash
git commit -am "feat(server): per-call deadline — 504 to the client, claim held until JS settles (F64)"
```

---

### Task 2: Pipeline mapping and server tests

**Files:**
- Modify: `crates/brust-server/src/pipeline.rs` (`:325` loader call and `:437` jobs call pass `s.call_timeout`; the error arms `:385`/`:444`: `CallError::Deadline => { s.timed_out_calls.fetch_add(1, Relaxed); return body::error_504("call deadline exceeded") }`; the `loader_calls`/`job_calls` increment at `:327`/`:438` still counts a Deadline call as a call made)
- Modify: `crates/brust-server/tests/common/fake_bun.rs` (add a gated mode: `FakeBun::gated(loader, jobs) -> (FakeBun, Sender)` so a test can settle late), `crates/brust-server/tests/common/mod.rs` (`config()` sets `call_timeout_ms: 300`)
- Test: `crates/brust-server/tests/busy.rs` (append)

- [ ] **Step 1: Failing tests**
```rust
#[test]
fn parked_loader_is_504_and_static_routes_still_answer() {
    let (fake, _release) = FakeBun::gated(default_loader, default_jobs);
    let s = boot_with(fake, |cfg| { cfg.tuning.call_timeout_ms = 200; cfg.tuning.claim_timeout_ms = 150; });
    let (status, body) = get(&s, "/pokemon/a");
    assert_eq!((status, body.as_str()), (504, "call deadline exceeded"));
    assert_eq!(get(&s, "/").0, 200, "static route unaffected");
    assert_eq!(get(&s, "/pokemon/b").0, 503, "the slot is still held → all workers busy");
    let st = stats(&s);
    assert_eq!(st["timed_out_calls"], 1);
    assert_eq!(st["loader_calls"], 1);
}

#[test]
fn late_result_after_504_is_not_cached() {
    let (fake, release) = FakeBun::gated(default_loader, default_jobs);
    let s = boot_with(fake, |cfg| { cfg.tuning.call_timeout_ms = 100; });
    assert_eq!(get(&s, "/pokemon/a").0, 504);
    release.settle_all();                                      // the parked loader now returns its data
    std::thread::sleep(std::time::Duration::from_millis(50));
    let st = stats(&s);
    assert_eq!(st["l1"]["len"], 0, "nothing stored from a timed-out call");
    assert_eq!(get(&s, "/pokemon/a").0, 200, "a fresh request works and is a MISS");
}
```
(Use the helper names `tests/common/mod.rs` actually exports — `config()`, `stats()`, a boot helper; add `boot_with(fake, tweak)` if absent.)
- [ ] **Step 2–3**: run (fails), implement the pipeline arms and the fake's gated mode.
- [ ] **Step 4: Commit** `test(server): 504 on call deadline, late results discarded, slot stays busy`.

---

### Task 3: Config plumbing and docs

**Files:**
- Modify: `crates/brust-napi/src/server.rs` (`StartOptions` :52-64: add `call_timeout_ms: Option<u32>`; map at :72-74 like `claim_timeout_ms`), `packages/brust/src/native.ts` (`StartOptions.callTimeoutMs?`), `packages/brust/src/config.ts` (`BrustConfig.callTimeoutMs`, default 30000, `BRUST_CALL_TIMEOUT_MS` via `envInt(…, 1, MAX_MS, …)`, header comment), `packages/brust/src/run.ts:48` (pass `callTimeoutMs: cfg.callTimeoutMs`), `packages/brust/README.md:66-72` (env list + "504 on call deadline; `timed_out_calls` in stats")
- Test: `packages/brust/test/config.test.ts` (template `:44-53`), `packages/brust/test/lifecycle.test.ts` (`start(entry, extraEnv)`) — an app whose loader `await new Promise(() => {})` under `BRUST_CALL_TIMEOUT_MS=300` returns 504 and `/_brust/cache/stats` shows `timed_out_calls: 1`; `BRUST_CALL_TIMEOUT_MS=0` → `BrustConfigError` at start.
- Ledger: `docs/plans/m1a-followups.md` F64 → DONE with the commit.

- [ ] **Steps**: failing config test → implement → failing lifecycle e2e → run → commit `feat(brust): BRUST_CALL_TIMEOUT_MS (default 30 s) → 504; stats.timed_out_calls`.

---

## Verification (READY evidence, paste in the task note)

```
cargo fmt --all -- --check && cargo clippy --workspace --exclude bun_react_compiler --no-deps -- -D warnings
cargo test -p brust-server -p brust-napi            # green; paste dispatch/busy counts
cd packages/brust && bun test                       # green incl. the 504 lifecycle test
bun run battery && git status --short docs/         # unchanged
```
PR `lane/m2b2-call-deadline` → `v2`, CI green (all jobs incl. `server`), lane HEAD sha.

## Dispatch table (for the Coordinator)

| slug | plan tasks | tier | role | deps | review | acceptance (READY evidence) |
|---|---|---|---|---|---|---|
| `m2b2-call-deadline` | 1–3 | routine | Implementer (Routine) | `m2x-minijinja-3` merged | standard | Verification block pasted; PR → `v2` CI green; lane HEAD sha |
