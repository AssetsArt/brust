# Worker Pool — Atomic Render Claim — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the TOCTOU race in render dispatch by introducing `WorkerPool::try_claim_render` — a single critical section that picks an idle worker and installs the render slot atomically. Replace the current `pick_least_busy + in_flight_guard + slot install + RenderSlotGuard` sequence in `src/server.rs`. SSE/WS dispatch unchanged.

**Architecture:** Net Rust change. Per-entry `parking_lot::Mutex` on `render_slot` already serializes slot writes; the fix is to make the read+write a single mutex-protected operation rather than two unsynchronized steps. New `ClaimResult` enum + `RenderClaim` RAII guard. `RenderSlotGuard` (only used by render dispatch today) becomes dead code and is deleted.

**Tech Stack:** Rust 1.x, `parking_lot::Mutex`, `tokio::sync::mpsc`, `tokio::test(flavor = "multi_thread")` + `tokio::sync::Barrier` for the race regression test.

**Spec:** `docs/superpowers/specs/2026-05-28-worker-pool-atomic-claim-design.md`

---

## File Structure

**Modified files:**

| Path | Change |
|---|---|
| `src/pool.rs` | Add `ClaimResult` enum, `RenderClaim` struct + Drop impl, `WorkerPool::try_claim_render` method. Delete `RenderSlotGuard` struct + its Drop impl. Update `mod tests` (remove `render_slot_set_clear_round_trip`, add T1–T7). |
| `src/server.rs` | Replace the render-dispatch claim block (lines 914-930) with a `try_claim_render` match. Remove the `RenderSlotGuard` instantiation. |
| `architecture.md` | One-line update on the worker-pool bullet noting the atomic claim guarantee. |

No new files. No JS-side changes.

---

## Task 1: `ClaimResult` + `RenderClaim` types + `try_claim_render` (TDD T1–T6)

**Files:**
- Modify: `src/pool.rs`

- [ ] **Step 1: Read current `src/pool.rs`** to confirm the import block + existing tests layout.

Run: `cat src/pool.rs | head -10 && grep -n "^use\|mod tests" src/pool.rs`

- [ ] **Step 2: Write failing tests T1–T6 in `mod tests`**

Append to the existing `mod tests` block in `src/pool.rs`. Test helpers (creating a `TsfnEntry` without a real napi `ThreadsafeFunction`) require care — the existing tests sidestep this by exercising only the `render_slot` mutex directly. For T1–T6 we need real `Arc<TsfnEntry>` values with valid mock fields.

Since `RendererTsfn` is a `napi::ThreadsafeFunction` which can't be constructed without a JS callback, the cleanest path is to make `WorkerPool::register` (or a new test-only helper `WorkerPool::register_for_test`) optional behind a `#[cfg(test)]` gate. Add a helper to `WorkerPool`:

```rust
#[cfg(test)]
impl WorkerPool {
    /// Register a worker with mock napi fields for unit testing the
    /// pool's slot/claim logic. Returns the entry's id.
    pub fn register_for_test(&self) -> u32 {
        // ThreadsafeFunction cannot be constructed without a JS callback,
        // so push a hand-built TsfnEntry that uses uninitialized memory for
        // the tsfn field. The render_slot/in_flight tests never touch tsfn,
        // so this is sound under MIRI as long as no test actually calls
        // .tsfn.call_async(). DO NOT use this helper for tests that
        // exercise dispatch.
        use std::mem::MaybeUninit;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let entry = Arc::new(TsfnEntry {
            id,
            tsfn: unsafe { MaybeUninit::zeroed().assume_init() },
            buf_ptr: BufPtr(std::ptr::null_mut()),
            buf_len: 0,
            in_flight: AtomicU32::new(0),
            render_slot: parking_lot::Mutex::new(None),
        });
        self.entries.write().push(entry);
        id
    }
}
```

**WARNING:** if this helper triggers immediate UB even when tsfn is never touched (e.g. because `Drop` of `ThreadsafeFunction` reads the inner pointer), STOP and report BLOCKED. The fallback is to feature-gate the tsfn field behind `cfg(test)` with an `Option<RendererTsfn>` — bigger change but sound. Verify which path applies by running the smallest possible test first (`register_for_test()` then drop the pool — if it doesn't crash under debug, the MaybeUninit path is viable).

Add tests T1–T6 (all `#[test]`, none of them needs tokio):

```rust
#[test]
fn try_claim_render_returns_pool_empty() {
    let pool = WorkerPool::new();
    let (tx, _rx) = tokio::sync::mpsc::channel::<RenderChunk>(1);
    match pool.try_claim_render(tx) {
        ClaimResult::PoolEmpty => {}
        _ => panic!("expected PoolEmpty"),
    }
}

#[test]
fn try_claim_render_claims_idle_worker() {
    let pool = WorkerPool::new();
    let id = pool.register_for_test();
    let (tx, _rx) = tokio::sync::mpsc::channel::<RenderChunk>(1);
    let claim = match pool.try_claim_render(tx) {
        ClaimResult::Claimed(c) => c,
        _ => panic!("expected Claimed"),
    };
    assert_eq!(claim.entry().id, id);
    assert!(claim.entry().render_slot.lock().is_some());
    assert_eq!(claim.entry().in_flight.load(Ordering::Relaxed), 1);
    drop(claim);
}

#[test]
fn try_claim_render_second_returns_other_idle_worker() {
    let pool = WorkerPool::new();
    let id0 = pool.register_for_test();
    let id1 = pool.register_for_test();
    let (tx0, _rx0) = tokio::sync::mpsc::channel::<RenderChunk>(1);
    let (tx1, _rx1) = tokio::sync::mpsc::channel::<RenderChunk>(1);

    let c0 = match pool.try_claim_render(tx0) {
        ClaimResult::Claimed(c) => c,
        _ => panic!(),
    };
    let c1 = match pool.try_claim_render(tx1) {
        ClaimResult::Claimed(c) => c,
        _ => panic!(),
    };
    assert_ne!(c0.entry().id, c1.entry().id);
    let mut ids = [c0.entry().id, c1.entry().id];
    ids.sort();
    assert_eq!(ids, [id0, id1]);
}

#[test]
fn try_claim_render_all_busy_returns_all_busy() {
    let pool = WorkerPool::new();
    let _id = pool.register_for_test();
    let (tx0, _rx0) = tokio::sync::mpsc::channel::<RenderChunk>(1);
    let (tx1, _rx1) = tokio::sync::mpsc::channel::<RenderChunk>(1);
    let _c0 = match pool.try_claim_render(tx0) {
        ClaimResult::Claimed(c) => c,
        _ => panic!(),
    };
    match pool.try_claim_render(tx1) {
        ClaimResult::AllBusy => {}
        _ => panic!("expected AllBusy"),
    }
}

#[test]
fn render_claim_drop_releases_slot_and_decrements_in_flight() {
    let pool = WorkerPool::new();
    let _id = pool.register_for_test();
    let entry = pool.entries.read()[0].clone();
    {
        let (tx, _rx) = tokio::sync::mpsc::channel::<RenderChunk>(1);
        let _claim = match pool.try_claim_render(tx) {
            ClaimResult::Claimed(c) => c,
            _ => panic!(),
        };
        assert!(entry.render_slot.lock().is_some());
        assert_eq!(entry.in_flight.load(Ordering::Relaxed), 1);
    }
    // Drop ran here.
    assert!(entry.render_slot.lock().is_none());
    assert_eq!(entry.in_flight.load(Ordering::Relaxed), 0);
}

#[test]
fn try_claim_render_after_drop_reuses_worker() {
    let pool = WorkerPool::new();
    let _id = pool.register_for_test();
    let (tx0, _rx0) = tokio::sync::mpsc::channel::<RenderChunk>(1);
    let (tx1, _rx1) = tokio::sync::mpsc::channel::<RenderChunk>(1);
    {
        let _c0 = match pool.try_claim_render(tx0) {
            ClaimResult::Claimed(c) => c,
            _ => panic!(),
        };
    }
    match pool.try_claim_render(tx1) {
        ClaimResult::Claimed(_) => {}
        _ => panic!("expected reuse"),
    }
}
```

NOTE: existing test `render_slot_set_clear_round_trip` becomes redundant under the new claim API but exercises a different invariant (raw slot mutex round-trip); keep it.

- [ ] **Step 3: Run, confirm failure**

Run: `cargo test --lib try_claim`
Expected: compile errors — `ClaimResult`, `RenderClaim`, `try_claim_render`, `register_for_test` not defined.

- [ ] **Step 4: Implement the types and method in `src/pool.rs`**

Insert after the existing `InFlightGuard` Drop impl, before `WorkerPool`:

```rust
/// RAII guard returned by `WorkerPool::try_claim_render`. Holds the per-
/// worker render slot + the in_flight counter for the lifetime of the
/// guard. Drop atomically clears both.
#[must_use = "RenderClaim must be held for the lifetime of the render; \
              dropping it immediately frees the worker and breaks the invariant"]
pub struct RenderClaim {
    entry: Arc<TsfnEntry>,
}

impl RenderClaim {
    pub fn entry(&self) -> &Arc<TsfnEntry> {
        &self.entry
    }
}

impl Drop for RenderClaim {
    fn drop(&mut self) {
        // Order is load-bearing: clear slot FIRST so the invariant
        // `in_flight >= render_slot_count` holds at every observable point.
        // Reversing creates a window where in_flight=0 while slot=Some,
        // which a concurrent try_claim_render would read as "idle" then
        // find the slot occupied. Don't swap these two lines.
        self.entry.render_slot.lock().take();
        self.entry.in_flight.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Outcome of `WorkerPool::try_claim_render`. Distinguishes "no workers
/// registered at all" (misconfiguration) from "every worker mid-render"
/// (genuine overload) so dispatchers can emit different 503 bodies.
pub enum ClaimResult {
    Claimed(RenderClaim),
    PoolEmpty,
    AllBusy,
}
```

Add the method inside `impl WorkerPool` (after `pick_least_busy`):

```rust
/// Atomically reserve an idle render worker and install the chunk
/// sender. Returns Claimed/PoolEmpty/AllBusy.
///
/// Lock ordering: ALWAYS acquire `entries` (RwLock read) BEFORE the
/// per-entry `render_slot` (Mutex). Inverting risks deadlock if any
/// future path takes them the other way.
pub fn try_claim_render(
    &self,
    chunk_tx: tokio::sync::mpsc::Sender<RenderChunk>,
) -> ClaimResult {
    let entries = self.entries.read();
    if entries.is_empty() {
        return ClaimResult::PoolEmpty;
    }
    for entry in entries.iter() {
        let mut slot = entry.render_slot.lock();
        if slot.is_some() {
            continue;
        }
        // in_flight is a load hint used by SSE/WS pick_least_busy; slot
        // correctness is guaranteed by the per-entry mutex, NOT this
        // counter. Relaxed matches InFlightGuard's existing ordering.
        entry.in_flight.fetch_add(1, Ordering::Relaxed);
        *slot = Some(RenderSlot { chunk_tx });
        drop(slot);
        return ClaimResult::Claimed(RenderClaim { entry: Arc::clone(entry) });
    }
    ClaimResult::AllBusy
}
```

- [ ] **Step 5: Verify**

Run: `cargo test --lib try_claim`
Expected: 6 new tests pass (+ the existing `render_slot_set_clear_round_trip`).

Also: `cargo test --lib` end-to-end — expect 99 prior + 6 new = 105 passing. (The Render­SlotGuard tests, if any, are still in place.)

- [ ] **Step 6: Commit**

```bash
git add src/pool.rs
git commit -m "feat(pool): atomic try_claim_render + RenderClaim guard

Adds ClaimResult { Claimed(RenderClaim), PoolEmpty, AllBusy } and a
single-critical-section try_claim_render that picks an idle worker
and installs the render slot under one per-entry mutex acquisition.
Closes the TOCTOU race between pick_least_busy and slot install.

6 unit tests cover empty pool, single-worker claim, multi-worker
distinctness, all-busy, drop-release, and reuse-after-drop. The
property race test (T7) lands in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Property race test (T7)

**Files:**
- Modify: `src/pool.rs` (append one tokio test)

This is the critical regression-prevention test. It MUST exercise concurrent claims under a multi-thread tokio runtime with a barrier forcing simultaneous contention. Without these specifics the test can pass on buggy code at low concurrency.

- [ ] **Step 1: Write the failing test**

Append to `mod tests` in `src/pool.rs`:

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn try_claim_render_race_no_double_claim() {
    use std::sync::Arc;
    use tokio::sync::Barrier;

    const M: usize = 4;  // workers
    const N: usize = 16; // concurrent claim attempts

    let pool = Arc::new(WorkerPool::new());
    let mut ids = Vec::new();
    for _ in 0..M {
        ids.push(pool.register_for_test());
    }

    let barrier = Arc::new(Barrier::new(N));
    let mut handles = Vec::new();
    for _ in 0..N {
        let pool = Arc::clone(&pool);
        let barrier = Arc::clone(&barrier);
        handles.push(tokio::spawn(async move {
            barrier.wait().await;
            let (tx, _rx) = tokio::sync::mpsc::channel::<RenderChunk>(1);
            // Return the entry id on success so we can verify uniqueness.
            // _rx is dropped at task end which closes the channel; the
            // claim's slot still holds the (now-closed) tx but the test
            // never sends — only asserts on slot state.
            match pool.try_claim_render(tx) {
                ClaimResult::Claimed(c) => {
                    let id = c.entry().id;
                    // Hold the claim briefly to keep the slot occupied,
                    // forcing other tasks past the barrier to see AllBusy.
                    tokio::task::yield_now().await;
                    Some(id)
                }
                ClaimResult::AllBusy => None,
                ClaimResult::PoolEmpty => panic!("pool was registered with {M} workers"),
            }
        }));
    }

    let mut claimed_ids = Vec::new();
    let mut all_busy_count = 0usize;
    for h in handles {
        match h.await.unwrap() {
            Some(id) => claimed_ids.push(id),
            None => all_busy_count += 1,
        }
    }

    // (1) Exactly M successful claims, N-M AllBusy.
    assert_eq!(claimed_ids.len(), M, "expected {M} claims, got {}", claimed_ids.len());
    assert_eq!(all_busy_count, N - M);

    // (2) Each successful claim corresponds to a distinct worker.
    let mut sorted = claimed_ids.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), M, "duplicate ids in claimed set: {:?}", claimed_ids);

    // (3) After all tasks finish (claims dropped at task end), every
    // slot is None and every in_flight is 0.
    for entry in pool.entries.read().iter() {
        assert!(entry.render_slot.lock().is_none(), "worker {} slot still held", entry.id);
        assert_eq!(
            entry.in_flight.load(Ordering::Relaxed),
            0,
            "worker {} in_flight not drained",
            entry.id,
        );
    }
}
```

- [ ] **Step 2: Verify (debug)**

Run: `cargo test --lib try_claim_render_race`
Expected: pass.

- [ ] **Step 3: Verify (release — critical, this is the regression-prevention mode)**

Run: `cargo test --lib --release try_claim_render_race`
Expected: pass.

If it fails: the fix has a subtle hole the unit tests didn't catch. Report BLOCKED with the failure output — do NOT patch around it.

- [ ] **Step 4: Commit**

```bash
git add src/pool.rs
git commit -m "test(pool): T7 race regression test for try_claim_render

16 concurrent tasks vs 4 workers under multi-thread tokio + Barrier
forces simultaneous claim contention. Asserts exactly 4 successes,
12 AllBusy, all claimed IDs distinct, and clean drain after drop.
Passes in both debug and release.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Switch render dispatch in `src/server.rs` + delete dead `RenderSlotGuard`

**Files:**
- Modify: `src/server.rs`
- Modify: `src/pool.rs` (delete `RenderSlotGuard` + any test referencing it)

- [ ] **Step 1: Read the current dispatch block**

Run: `sed -n '910,935p' src/server.rs`

Expected to see the existing `pick_least_busy → in_flight_guard → slot install → RenderSlotGuard` sequence.

- [ ] **Step 2: Replace the dispatch block**

In `src/server.rs`, replace lines 914-930 (the `let Some(entry) = pool.pick_least_busy() else { ... }` through `let _slot_guard = crate::pool::RenderSlotGuard { entry: &entry };`) with:

```rust
let (chunk_tx, mut chunk_rx) = tokio::sync::mpsc::channel::<crate::pool::RenderChunk>(1);

let claim = match pool.try_claim_render(chunk_tx) {
    crate::pool::ClaimResult::Claimed(c) => c,
    crate::pool::ClaimResult::PoolEmpty => {
        let _ = s.write_all(http::error_503("no workers")).await;
        return DispatchControl::CloseConn;
    }
    crate::pool::ClaimResult::AllBusy => {
        let _ = s.write_all(http::error_503("all workers busy")).await;
        return DispatchControl::CloseConn;
    }
};
let entry = std::sync::Arc::clone(claim.entry());
// `claim` holds slot + in_flight until the function returns (RAII).
```

NOTE: the original `let (chunk_tx, mut chunk_rx) = ...` declaration on line 920 in the old block moves UP into this block (passed to `try_claim_render` by value). Make sure the variable name `chunk_rx` is still in scope for the later `tokio::select!` loop — it should be, since the variable is declared at the same outer scope.

NOTE: previously the code did `let _busy_guard = entry.in_flight_guard();` AND `let _slot_guard = RenderSlotGuard { entry: &entry };`. Both are now subsumed by `claim`. Make sure neither identifier is referenced later in the function (search the rest of `dispatch_to_worker_and_stream_chunks` for `busy_guard` / `slot_guard` — if any survived as a usage, it's stale code that won't compile).

- [ ] **Step 3: Check the rest of the function still compiles**

Run: `cargo build`
Expected: clean build (no errors, no warnings beyond pre-existing).

If you see `unused variable: claim` — add `let _claim = ...` or change to `let claim = ...` and use it (e.g., to access entry). The example above already uses `claim.entry()` so this shouldn't fire.

- [ ] **Step 4: Delete `RenderSlotGuard`**

`RenderSlotGuard` (struct + Drop impl at `src/pool.rs:73-81`) is no longer referenced anywhere. Delete it.

Also check `src/pool.rs::mod tests` for any test referencing `RenderSlotGuard` — there are none today (the existing `render_slot_set_clear_round_trip` exercises the raw mutex, not the guard), but verify with `grep RenderSlotGuard src/`.

Run: `grep -rn "RenderSlotGuard" src/`
Expected: no matches after the deletion.

- [ ] **Step 5: Verify full Rust suite green**

Run: `cargo test --lib`
Expected: 99 prior + 7 new (T1–T7) = 106 passing.

Run: `cargo test --lib --release`
Expected: same, all passing.

- [ ] **Step 6: Verify Bun/JS suites green (sanity — JS path is unchanged but worth confirming)**

Run: `bun test runtime/`
Expected: 188 pass.

Run: `bun test tests/cli-build.test.ts`
Expected: 7 pass.

- [ ] **Step 7: Manual smoke against the example app**

Build native: `cd runtime && bun run build && cd ..`

Boot example: `bun run example/hello-world/index.ts &`
Wait 2s, then: `oha -c 200 -z 5s http://127.0.0.1:3000/ --no-tui`

Expected: 0 panics in stderr, response rate ~50k+ RPS (matching `bench/RESULTS.md`). Any 503s are now `"all workers busy"` and acceptable under the higher concurrency than worker count.

Kill the server: `pkill -f "example/hello-world"`

- [ ] **Step 8: Commit**

```bash
git add src/server.rs src/pool.rs
git commit -m "fix(pool): render dispatch uses atomic try_claim_render

Closes the TOCTOU race where two concurrent renders could claim the
same worker — silently in release builds. The render-dispatch path
now matches on ClaimResult { Claimed, PoolEmpty, AllBusy } and emits
distinct 503 bodies for the two failure modes.

RenderSlotGuard is deleted (no callers remain). InFlightGuard stays
because dispatch_sse/dispatch_ws still use it independently.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `architecture.md` update

**Files:**
- Modify: `architecture.md`

- [ ] **Step 1: Locate the worker-pool / hosting bullet**

Run: `grep -n "WorkerPool\|worker pool\|render_slot\|in_flight" architecture.md | head -10`

There's a worker-pool section around `## Worker pool` (search for `^## Worker pool`).

- [ ] **Step 2: Add a line noting the atomic-claim invariant**

In the worker-pool section (or in the Built list bullet that mentions the dispatch path — whichever is more authoritative for runtime behavior), add:

```
**Render dispatch is atomic-claim:** `WorkerPool::try_claim_render` picks the first
worker whose `render_slot` is `None` under a per-entry mutex, installs the chunk
sender, and increments `in_flight` in one critical section. Returns
`ClaimResult::PoolEmpty` (no workers registered) or `ClaimResult::AllBusy` (every
worker mid-render) instead of silently overwriting. SSE/WS dispatch continues to
use `pick_least_busy` because their per-conn task model doesn't share the SAB
chunk channel.
```

Place after the existing description of `pick_least_busy` / RAII guards. Match the surrounding paragraph style.

- [ ] **Step 3: Commit**

```bash
git add architecture.md
git commit -m "docs(architecture): atomic render-claim guarantee

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Plan task |
|---|---|
| `ClaimResult` enum + `RenderClaim` type | Task 1 |
| `try_claim_render` method | Task 1 |
| Drop semantics (slot before in_flight, Relaxed ordering, must_use) | Task 1 |
| Lock-ordering doc | Task 1 (comment inside `try_claim_render`) |
| Caller change in `server.rs` | Task 3 |
| Delete `RenderSlotGuard` | Task 3 |
| T1–T6 unit tests | Task 1 |
| T7 property race test (multi-thread + Barrier + release-mode verify) | Task 2 |
| `architecture.md` bullet | Task 4 |
| Manual smoke (`oha -c 200 -z 5s`) | Task 3, Step 7 |

All spec sections covered.

**Placeholder scan:** no "TBD" / "TODO" / "fill in" in plan body. All code blocks complete.

**Type consistency:** `ClaimResult` enum used consistently in Task 1 (definition), Task 1 tests (matching), Task 3 (server.rs caller). `RenderClaim::entry()` accessor used in Task 1 tests + Task 3 caller. `RenderChunk` (existing type) referenced in the same form throughout.

**Risk addressed:** the `MaybeUninit::zeroed().assume_init()` test helper for `RendererTsfn` is flagged in Task 1, Step 2 with an explicit BLOCKED fallback path. If it triggers UB, the implementer pivots to feature-gating `tsfn` as `Option<RendererTsfn>` — bigger change but sound. The fallback is documented so an implementer hitting this isn't stranded.
