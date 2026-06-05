# Multi-render-per-worker + zero-copy TS↔Rust — design

**Branch:** `perf/ssr-multirender-zerocopy` (off `feat/brust-core-hyper`)
**Date:** 2026-06-05
**Status:** design (research-backed; gated on a decision microbenchmark)

## Goal

Raise brust's React-SSR throughput on Bun by:

1. **Letting one Bun worker hold N renders in-flight concurrently** so the
   isolate's CPU is reclaimed while a render is parked awaiting async data
   (Suspense / `await`ed loaders), instead of the current strict
   one-render-per-worker gate.
2. **Cutting the per-render TS↔Rust copy cost** toward zero-copy where Bun's
   primitives actually allow it.

Optimized against Bun's *real* execution model (verified from
`/Users/detoro/code/bun` source), not an assumed one.

## The physics that bounds this work (READ FIRST — it reframes the goal)

Verified from Bun source. These are hard constraints; the design respects them.

1. **CPU-bound SSR serializes inside one isolate.** Each Bun `Worker` is one
   JSC `VirtualMachine` with one cooperative event loop
   (`src/jsc/web_worker.rs`). Two `renderToPipeableStream` calls that never
   `await` run back-to-back, not in parallel. **Concurrency only buys anything
   when a render yields** — i.e. when components suspend on async data. A purely
   synchronous page (the bench's `/`, native jinja) gets **zero** speedup from
   multi-render and pays a small scheduling tax.

   → **This feature targets data-driven / Suspense pages.** We will say so in
   every user-facing place. We are NOT claiming in-isolate CPU parallelism;
   that is physically impossible on JSC.

2. **`napi_call_threadsafe_function` enqueue is a `SeqCst` full barrier** in Bun
   (`src/runtime/napi/napi_body.rs`, `fetch_add(1, SeqCst)` at enqueue, concurrent
   task posted to the worker loop). This **contradicts** the assumption recorded
   in the prior SAB-request-race fix ("the tsfn call is not a release barrier for
   the preceding SAB store"). The contradiction is load-bearing for the zero-copy
   request question and is **resolved empirically by Task 0's microbenchmark, not
   by argument.** Until then we treat SAB-for-request as unproven, exactly as the
   current `RenderEnvelope::Inline`-only code does.

3. **SAB backing stores are pinned for non-growable buffers** (JSC mmap, not
   GC-relocated) — a native `*mut u8` captured at `register_renderer` stays valid
   for the SAB's life. Growable/resizable SAB is unsafe to borrow. We use
   fixed-size SAB only (already the case).

4. **No zero-copy stream→socket for dynamic bodies.** `Bun.serve` memcpys
   ReadableStream chunks into the uWS send buffer; only static-file `sendfile(2)`
   is true zero-copy. So "zero-copy" here means the **TS↔Rust boundary**, not
   TS→socket. Out of scope to change Bun.

## Non-goals (loud)

- **NOT** parallel CPU execution of renders within one isolate. Impossible on
  JSC; see physics #1.
- **NOT** a speedup for synchronous pages. `/ping`, native jinja, and
  non-suspending React see no benefit; the design must not regress them
  (acceptance criterion below).
- **NOT** changing Bun, `Bun.serve`, or the stream→socket path.
- **NOT** reintroducing SAB-for-request *unless* Task 0 proves it safe AND
  faster under multi-thread load. The current `Inline(String)` request path is
  the baseline and the fallback.
- **NOT** touching the worker→Rust response chunk/ack protocol semantics, only
  extending its addressing (add a slot index).
- **NOT** removing the per-render-settlement claim invariant (the disconnect /
  drain correctness rule from the hyper migration). Per-slot claims keep it.

## High-level architecture

Today: per worker, a binary `idle: AtomicBool` gate + a single
`render_slot: Mutex<Option<RenderSlot>>` + a single SAB region at offset 0. One
render owns the whole worker until its Promise settles AND its response drains.

Proposed: **K slots per worker.**

```
WorkerEntry
 ├─ permits: Semaphore(K)            // replaces binary `idle`; K in-flight max
 ├─ slots: [Slot; K]                 // each Slot owns a disjoint SAB sub-region
 │    └─ Slot { chunk_tx: Mutex<Option>, sab_offset, sab_cap }
 └─ dispatch: Box<dyn RenderDispatch>  // tsfn; now called with a slot index
```

- **Claim** = acquire one permit + reserve a free slot index (CAS over a small
  bitset, or per-slot `AtomicBool`). `RenderClaim` holds **one slot**, not the
  whole worker. Release on Promise settlement (invariant preserved per-slot).
- **SAB partitioning.** The worker's SAB is split into K disjoint sub-regions of
  `floor(cap/K)` bytes. Render in slot `i` reads/writes only
  `[i*sub .. (i+1)*sub]`. Disjoint regions mean concurrent renders never alias —
  which *also* removes the request/response aliasing that the original
  SAB-request race lived in.
- **Response routing for N in-flight.** `napi_render_chunk(worker_id, slot, len)`
  gains a `slot` arg; Rust routes the chunk to that slot's `chunk_tx`. No global
  scan. (nylon-ring's sharded/keyed routing idea, scaled to K-per-worker.)
- **JS side.** `renderFn(envelope, slot)` is already `async`; multiple concurrent
  invocations are fine on the event loop. Each invocation uses **its slot's SAB
  sub-view** (`view.subarray(off, off+sub)`) for `encodeFirstChunk` / chunks.
  Concurrent renders interleave at their `await` points — the entire point.

### Dispatch envelope / SAB ownership

`RenderEnvelope::Inline(String)` stays the request carrier (proven safe).
The `slot` index travels alongside the envelope (new tsfn arg or folded into the
JSON). Zero-copy request (SAB) is a **Task 0-gated** follow-up: with disjoint
per-slot regions the original aliasing is gone, so it may now be safe — but only
the microbench decides.

### Request-id correlation (nylon-ring transfer)

For K-per-worker we don't need a global SID space — `(worker_id, slot)` is a
sufficient, dense key (K small, e.g. 2–4). We adopt nylon-ring's **idea**
(thread-local block IDs, sharded maps) only if a global render registry proves
necessary; for the dense `(worker, slot)` keying it is **not** needed. Recorded
so we don't over-engineer.

## CLI / API surface

Additive, backward-compatible:

- `ServeOptions.tuning.renderSlots?: number` (TS) → `ServeTuning.render_slots:
  Option<u32>` (napi, snake_case-aware — see memory `napi-object-camelcase-keys`).
  Default **1** (today's behavior exactly; opt-in to >1).
- Bench env `BRUST_RENDER_SLOTS` (read in `bench/apps/brust/index.ts`,
  default unset = 1).
- `register_renderer` gains the slot count so the worker knows how to partition
  its SAB; `napi_render_chunk` / `napi_render_chunk_final` gain a `slot: u32` arg.

`renderSlots = 1` MUST be byte-identical and perf-identical to current `main`
behavior (the single-slot path is the existing path).

## File structure

- `crates/brust-core/src/render/pool.rs` — `WorkerEntry` slots + semaphore;
  `RenderClaim` per-slot; `try_claim_render` returns a slot index.
- `crates/brust-core/src/render/dispatch.rs` — `RenderDispatch::call` carries a
  slot; per-slot `buf()` sub-region accessor `buf_slot(slot) -> (*mut u8, len)`.
- `crates/brust/src/dispatch_impl.rs` — `TsfnDispatch` passes slot to JS.
- `crates/brust/src/lib.rs` — `register_renderer(buf, slots, f)`;
  `napi_render_chunk(worker_id, slot, len)` + `_final`.
- `crates/brust-core/src/server/mod.rs` — `dispatch_single_chunk` /
  `dispatch_streaming` / `spawn_chunk_pump` thread the slot.
- `runtime/routes.ts` (`makeRenderer`) — accept slot arg, use slot sub-view.
- `runtime/render/stream.ts` — `encodeFirstChunk`/chunk encoders write into the
  slot sub-view; `napi.renderChunk(workerId, slot, len, view)`.
- `runtime/index.ts` — `ServeOptions.tuning.renderSlots` type + plumb to
  `register_renderer`.
- `bench/apps/brust/index.ts` — `BRUST_RENDER_SLOTS` env.

## Behavior / concurrency invariants

1. **Per-slot claim settlement.** A slot is released only after its render
   Promise settles (drain-on-disconnect rule preserved, now per-slot). Two slots
   on one worker settle independently.
2. **Disjoint SAB regions.** Slot `i` touches only its sub-region. Bounds checks
   in `napi_render_chunk` are against the **sub-region** cap, not the whole SAB.
3. **`renderSlots=1` ≡ today.** Single-slot collapses to the current single
   region at offset 0, single `chunk_tx`. No semaphore contention on the hot path
   when K=1 (fast-path the K=1 case).
4. **No cross-slot ordering.** Chunks from slot 0 and slot 1 are independent
   streams to independent client connections; never interleaved in one response.
5. **Backpressure unchanged.** Each slot keeps the chunk→ack oneshot handshake.

## Tests

- **Rust unit (`pool.rs`):** K-slot claim/release; K concurrent claims succeed,
  K+1th blocks until one releases (two-barrier design per skill — hold all K
  open simultaneously before any drops, else sequential reuse inflates the
  count). `--release` (invariant must survive optimization).
- **Rust unit:** disjoint-region bounds — a chunk `len` exceeding the *sub*-cap
  errors; a write in slot 1 never reads slot 0's bytes (`MockDispatch` with a
  partitioned buffer).
- **Integration:** a route with two Suspense boundaries resolving on staggered
  timers, `renderSlots=2`, two concurrent requests; assert both complete and
  total wall-clock < sum-of-serial (proves interleave). Assert bytes correct
  (no cross-slot corruption) under a 50-request concurrent loop.
- **Regression:** `renderSlots=1` integration suite stays 75/0; byte-identical
  envelope vs current.
- **Decision microbench (Task 0):** see below.

## Task 0 — decision-gating microbenchmark (DO THIS FIRST)

Before any refactor, prove the win exists and resolve the SeqCst/barrier
contradiction. **Do NOT commit results** (standing constraint).

1. **Interleave win:** a worker render that `await`s a timer-backed Suspense
   (say 20ms data) ×2 concurrently vs serially in one isolate. Measure wall
   clock. If concurrent ≈ serial (no win) → the feature is pointless for this
   workload; **STOP and report**, do not build the machine.
2. **SAB-request barrier:** under the multi-thread tokio runtime + per-slot
   disjoint regions, hammer SAB-request passing at 120-conn (the config that
   originally surfaced the race) for 60s. Zero corruption + ≥ Inline throughput
   → SAB request is back on the table. Any corruption → Inline stays, zero-copy
   request is closed for good with evidence.

This is the `debug-mantra` reproduce/falsify gate. The spec's zero-copy-request
arm is explicitly conditional on its outcome.

## Acceptance criteria

- `renderSlots=1`: integration 75/0, byte-identical envelopes, no throughput
  regression vs branch baseline (`/`, native-profile, action within noise).
- `renderSlots=2` on a Suspense route: two concurrent requests interleave
  (wall-clock < serial sum) with zero cross-slot corruption under concurrent
  load.
- cargo tests green incl. new K-slot tests (`--release` for the invariant test);
  clippy `-D warnings`; fmt; biome clean (`bun run ci`).
- No `bench/RESULTS.*` committed. Commit, do not push (standing constraints).

## Known limitations / deferred

- **Synchronous pages get no win** (physics #1) — documented, not fixed.
- **Zero-copy request (SAB)** ships only if Task 0 proves it; else Inline stays.
- **Response `.to_vec()` copy** (worker→Rust): borrowing the SAB sub-region
  without copying needs the slot claim pinned across the socket write — deferred
  as a separate sub-project; this spec keeps the `.to_vec()` copy.
- **Stream→socket copy** is Bun-owned — out of scope.
- **Optimal K** is workload-dependent; default 1, bench sweeps it. Not
  auto-tuned.

## Open questions resolved at plan time

- **Slot arg transport:** new explicit tsfn arg vs folding into envelope JSON →
  plan picks the explicit arg (keeps envelope bytes stable for the K=1 identity
  check).
- **Slot reservation primitive:** per-slot `AtomicBool` array vs bitset CAS →
  plan picks per-slot `AtomicBool` (mirrors today's `idle`, simplest correct).
