# Worker Pool — Atomic Render Claim — Design

**Date:** 2026-05-28
**Status:** Designed, awaiting plan
**Scope:** Close the TOCTOU race in `pool::WorkerPool::pick_least_busy` + render-slot install. Two simultaneous render dispatches can claim the same worker, then the second overwrites the first's `render_slot.chunk_tx` — silently in release builds. The fix introduces an atomic `try_claim_render` that picks an idle worker and installs the slot in one critical section. SSE/WS dispatch is out of scope (their existing semantics are correct).

---

## The bug

`src/server.rs:914-928` (render dispatch):

```rust
let Some(entry) = pool.pick_least_busy() else { ... };     // (1) read in_flight
let _busy_guard = entry.in_flight_guard();                 // (2) fetch_add(1)
{
    let mut slot = entry.render_slot.lock();
    debug_assert!(slot.is_none(),                          // (3) ⚠
        "worker {} double-dispatch (JS thread should serialise)", entry.id);
    *slot = Some(RenderSlot { chunk_tx });
}
```

`pick_least_busy` (`src/pool.rs:118-124`) does `entries.iter().min_by_key(|e| e.in_flight.load(...))`. Between the load and the subsequent `fetch_add(1)`, another caller can pick the same worker. Result: two dispatch sites for the same worker.

The race window is widened by the in-flight increment happening AFTER pick. Even if pick atomically returned an entry, the in_flight counter is updated separately, so two pickers both see in_flight=0 for the same entry.

The `debug_assert!` documents the invariant: "worker holds at most one in-flight render at a time." In debug it crashes. In release it overwrites — the second request's `chunk_tx` replaces the first's, the first's chunks flow into a dropped channel, the first request's HTTP response stalls or 500s, and the SAB is written by Bun for two interleaved renders (because the first JS callback is still mid-render; Bun's tsfn queue serializes callback **dispatch**, not callback **resolution**).

The bug is masked at low load: when there are more workers than concurrent requests, pickers usually pick distinct min-tied entries. At 100k+ RPS or when worker count is small, the race fires.

---

## Goal

The render dispatch path returns one of:

1. **A claim** — an idle worker, slot installed, in_flight incremented, all in a single critical section. The caller holds an RAII guard that releases everything on Drop.
2. **None** — every worker is mid-render. The caller responds with HTTP 503 (matching the existing "no workers" branch).

Other paths unaffected: SSE/WS continue to use `pick_least_busy` (they don't need exclusive slot ownership — their per-conn task model is independent of the SAB chunk channel).

---

## Non-goals

- Queueing requests when all workers are busy. MVP returns 503; if user reports 503s under load, add a bounded wait queue in a follow-up.
- Replacing `RwLock<Vec<Arc<TsfnEntry>>>` with `ArcSwap` for lock-free reads. The hot path of an 18-entry RwLock with `parking_lot`'s uncontended fast path is not the bottleneck. Revisit if benchmarks show otherwise.
- Eager cancellation signal to JS. Existing lazy cancellation via `chunk_tx.send` failure remains. Eager cancel via `AbortController` is a separate spec.
- Changes to SSE/WS dispatch. `pick_least_busy` stays the load-balancer for those — they don't share the render-slot resource.
- Worker fairness / starvation guarantees beyond "first idle worker wins" (linear scan). Workers don't accumulate priority.

---

## Approaches considered

**(a) Atomic CAS on `in_flight` to claim** — `compare_exchange(0, 1)` per entry. Picks the first entry where CAS succeeds. *Rejected:* in_flight is a load-balancing counter shared with SSE/WS, which can legitimately push it above 1. Strict-binary semantics on the same counter breaks SSE/WS.

**(b) Separate `render_in_flight: AtomicBool` per entry** — clean separation from the load counter. CAS on the bool. *Considered, but:* requires synchronizing the bool with the slot mutex anyway (otherwise the slot install can still race against a stale bool). Adds a second atomic without removing the mutex.

**(c) Per-entry mutex IS the claim** — *recommended.* The existing `render_slot: Mutex<Option<RenderSlot>>` already serializes slot writes. Reuse it: a single critical section per entry that checks `slot.is_none()` and installs if free. Linear scan over entries; first entry with a free slot wins. No new atomics, no separate locking domain.

---

## Design

### New types

```rust
// src/pool.rs

/// RAII guard returned by `try_claim_render`. On Drop, clears the render
/// slot and decrements in_flight in a single deterministic order. Holds an
/// Arc to the entry so the guard remains valid even if the pool removes the
/// entry concurrently.
pub struct RenderClaim {
    pub entry: Arc<TsfnEntry>,
}

impl RenderClaim {
    pub fn entry(&self) -> &Arc<TsfnEntry> { &self.entry }
}

impl Drop for RenderClaim {
    fn drop(&mut self) {
        self.entry.render_slot.lock().take();
        self.entry.in_flight.fetch_sub(1, Ordering::AcqRel);
    }
}
```

The existing `RenderSlotGuard` and `InFlightGuard` are no longer needed by the render dispatch path; they remain on the SSE/WS path because those paths still hold an `in_flight_guard()` for the duration of their tsfn enqueue.

### New pool method

```rust
// src/pool.rs

impl WorkerPool {
    /// Atomically reserve an idle render worker and install the chunk
    /// sender. Returns the claim (and the entry it owns) or None if every
    /// worker has a render in flight.
    ///
    /// Linear scan; first entry whose slot is currently None wins. The
    /// per-entry mutex serialises slot read+write so two callers cannot
    /// both observe `None` and both install. The in_flight increment
    /// happens inside the same critical section, so the load counter
    /// stays consistent with the slot state.
    pub fn try_claim_render(
        &self,
        chunk_tx: tokio::sync::mpsc::Sender<RenderChunk>,
    ) -> Option<RenderClaim> {
        let entries = self.entries.read();
        for entry in entries.iter() {
            let mut slot = entry.render_slot.lock();
            if slot.is_some() { continue; }
            entry.in_flight.fetch_add(1, Ordering::AcqRel);
            *slot = Some(RenderSlot { chunk_tx });
            drop(slot);
            return Some(RenderClaim { entry: Arc::clone(entry) });
        }
        None
    }
}
```

Notes:
- `chunk_tx` is taken by value because the slot install consumes it. If `try_claim_render` returns None, the sender is dropped — the receiver in the caller drops immediately, no leak.
- The slot mutex is released before the function returns. The RenderClaim owns logical ownership of "this worker has a render in flight"; the only synchronization needed thereafter is the mpsc channel + the ack oneshots already in place.

### Caller change

`src/server.rs:914-930` becomes:

```rust
let (chunk_tx, mut chunk_rx) = tokio::sync::mpsc::channel::<RenderChunk>(1);

let Some(claim) = pool.try_claim_render(chunk_tx) else {
    let _ = s.write_all(http::error_503("all workers busy")).await;
    return DispatchControl::CloseConn;
};
let entry = Arc::clone(claim.entry());
// `claim` holds slot + in_flight until dropped (RAII).

let entry_for_future = Arc::clone(&entry);
let render_future = async move {
    match entry_for_future.tsfn.call_async(envelope_json).await {
        ...
    }
};
// rest unchanged
```

The old `let _busy_guard = entry.in_flight_guard();` and `let _slot_guard = RenderSlotGuard { entry: &entry };` are removed — the `claim` is the unified guard.

### Error path semantics

| Failure | Behavior |
|---|---|
| No workers registered | `try_claim_render` returns None (entries.is_empty), caller writes 503 with "all workers busy". Matches today's "no workers" path. |
| All workers mid-render | Returns None, same 503. *New* behavior — today this is the silent overwrite bug. |
| Worker dies mid-render | `RenderClaim` drops normally, slot cleared. `pool.remove(id)` still runs on `EnqueueFailed`. New claim attempts skip the removed entry. |
| Tokio cancellation (handle_conn aborts mid-render) | `RenderClaim` drops via standard cancellation unwinding. Slot freed, in_flight decremented. |

### Existing `pick_least_busy` lifecycle

- `pool.rs:118-124` (`pick_least_busy`) — **kept.**
- `server.rs:572` (SSE) — **unchanged.**
- `server.rs:680` (WS) — **unchanged.**
- `server.rs:914` (render) — **removed**, replaced by `try_claim_render`.
- `pool.rs::dispatch_sse` / `dispatch_ws` — **unchanged.**

### Existing guards (`RenderSlotGuard`, `InFlightGuard`)

- `RenderSlotGuard` — used only by the render dispatch path today. With render dispatch switched to `RenderClaim`, `RenderSlotGuard` becomes dead code. **Delete it** along with its test.
- `InFlightGuard` — still used by `dispatch_sse` and `dispatch_ws`. **Keep.**
- `TsfnEntry::in_flight_guard()` — keep (called by dispatch_sse/dispatch_ws).

---

## Concurrency invariant (proof sketch)

**Claim:** at any instant, for every `TsfnEntry`, at most one `RenderSlot` exists in its slot, and `in_flight ≥ count_of_render_slots_held`.

The slot install in `try_claim_render` is the only path that writes a `Some(RenderSlot { ... })` into the slot. It executes under the per-entry mutex, after observing `slot.is_some() == false`. Two callers cannot both observe `false` because mutex serializes; the loser sees `true` and continues.

The slot clear is the only path that takes the `Some` back. It executes inside `RenderClaim::drop`, which also decrements `in_flight`. The decrement is paired 1-to-1 with the increment inside `try_claim_render` (both inside the same critical section for the increment, both inside the Drop for the decrement). No `RenderClaim` can outlive its drop because Rust's ownership prevents double-drop.

`in_flight` is also incremented/decremented by SSE/WS via `InFlightGuard` (independent paths, not paired with render slots). That's fine: the invariant is `in_flight ≥ render_slot_count`, not equality. `pick_least_busy` (used by SSE/WS) reads `in_flight` and is a load hint — its correctness doesn't depend on render-slot semantics.

---

## Tests

All in `src/pool.rs` `mod tests` (existing test module pattern).

| # | Name | Verifies |
|---|---|---|
| T1 | `try_claim_render_returns_none_when_empty` | Empty pool → None. |
| T2 | `try_claim_render_claims_idle_worker` | One registered worker, slot=None → returns Some, slot becomes Some, in_flight=1. |
| T3 | `try_claim_render_second_returns_other_idle_worker` | Two workers, claim once → second claim returns the other worker, not the same one. |
| T4 | `try_claim_render_all_busy_returns_none` | All workers' slots are Some → returns None. |
| T5 | `render_claim_drop_releases_slot_and_decrements_in_flight` | Drop the claim → slot=None, in_flight=0. |
| T6 | `try_claim_render_after_drop_reuses_worker` | Claim, drop, claim again → second claim succeeds on the same worker (or any worker — at minimum, succeeds). |
| T7 | **Property test** — race: `try_claim_render` from N tokio tasks vs M registered workers, M < N. Asserts: (1) at most M concurrent successful claims, (2) every successful claim corresponds to a distinct worker, (3) after all claims drop, all workers' slots are None and in_flight values are 0. Use `tokio::test(flavor = "multi_thread")` so the scheduler actually overlaps the tasks. |

T7 is the critical regression-prevention test. Without it, the fix could silently regress to the TOCTOU pattern.

Manual smoke (not codified): `bun run example/hello-world/index.ts`, run `oha -c 200 -z 5s http://127.0.0.1:3000/`, observe no 500s, no panics, no stuck connections.

---

## Risks

- **Throughput regression under sustained N+1 RPS** — when concurrent requests exceed worker count, the new path returns 503 immediately where the old path silently overwrote slots (data loss but no 503). The old behavior was wrong, so 503 is an improvement, but operators monitoring 5xx rates will see a new signal. Document in the release note that 503s under burst load are now visible.
- **Linear scan cost** — pool size is small (~18), scan is cheap. If pool grows to hundreds of workers, replace with `crossbeam::SegQueue` or `async_channel` idle queue. Not in scope.
- **First-idle bias** — earliest-registered worker tends to be picked when many are idle. Workers are identical in capability, so this doesn't matter for correctness. If observed to cause hot-worker cache effects, rotate the scan start index (single atomic counter, ~4 LOC).

---

## Acceptance criteria

The implementation is done when:

1. `src/pool.rs::try_claim_render` exists with the signature above.
2. `src/server.rs` render-dispatch path uses `try_claim_render` instead of `pick_least_busy + in_flight_guard + slot install + RenderSlotGuard`.
3. `RenderSlotGuard` is deleted (no callers remain).
4. All 7 new tests pass under `cargo test --lib` (T7 specifically under `--release` to confirm the fix isn't debug-only).
5. Existing `cargo test --lib` baseline (99 tests today) still green.
6. Existing `bun test runtime/` (188), `bun test tests/cli-build.test.ts` (7), `bun test tests/cli-new.test.ts` (20) — all still green.
7. Manual smoke: `oha -c 200 -z 5s http://127.0.0.1:3000/` against the example app shows no 5xx (or only the new "all workers busy" 503s under genuine overload), no panics in stderr.
8. `architecture.md` Built list bullet for the worker pool gains a one-liner noting the atomic claim guarantee.

---

## Open questions for plan-time

1. Should `try_claim_render` rotate the scan start index across calls to spread load? **Default no**, fairness is acceptable with FIFO claiming.
2. Should the 503 response body / log message be a specific string to support ops dashboards filtering? **Default yes**, use `"all workers busy"` so it's grep-able and distinct from the existing `"no workers"` (no workers registered at all).
