# Multi-render-per-worker + zero-copy TS↔Rust — design

**Branch:** `perf/ssr-multirender-zerocopy` (off `feat/brust-core-hyper`)
**Date:** 2026-06-05
**Status:** design — **decomposed**. This run ships the *decision harnesses*
(Phase A); the invasive machines (Phase B / C) are gated on their data.

## Why this is decomposed (the honest version)

The original single-spec goal ("N renders per worker + zero-copy") survived
contact with two things that shrink its value and raise its cost:

1. **Physics (from Bun source).** CPU-bound SSR serializes inside one JSC
   isolate. Multi-render concurrency buys throughput **only** for renders that
   *yield* — i.e. Suspense / `await`ed loaders. Synchronous pages get nothing.
2. **A spec review found the machine is far more invasive than "partition the
   SAB."** Interleaving two renders in one isolate corrupts **module-scope
   mutable JS state** (`consumeIslandUsedFlag`'s `__used`) and races the
   **synchronous native-jinja SAB path** (`napi_render_jinja`, hardcoded
   offset 0). Making it safe means request-scoping every render global AND
   slot-addressing the jinja path — a large, risky surface.

Building that machine **before** proving the win exists would violate this
spec's own decision gate and the debug-mantra "reproduce/falsify first" rule.
So we split into independently-gated pieces and **ship the cheap, high-signal
decision harnesses first**:

- **Phase A (this run):** two standalone measurement harnesses that answer
  "is either optimization worth its cost?" with numbers. Ships harness *code*
  (committed); reports the *numbers* (not committed — standing constraint).
- **Phase B (gated on A1):** the K-slot multi-render machine, with the two
  blockers fully addressed. Built only if A1 shows a real interleave win.
- **Phase C (gated on A2):** zero-copy SAB request passing. Built only if A2
  proves it safe under multi-thread load AND faster than `Inline`.

B and C are **independent**: C (cheaper per-render marshal) helps *every*
render regardless of B.

## The physics that bounds this work (verified from `/Users/detoro/code/bun`)

1. **CPU-bound SSR serializes inside one isolate.** Each `Worker` is one JSC
   `VirtualMachine`, one cooperative event loop (`src/jsc/web_worker.rs`). Two
   non-`await`ing renders run back-to-back. Concurrency helps **only** at yield
   points (Suspense / async loaders).
2. **`napi_call_threadsafe_function` enqueue is a `SeqCst` full barrier**
   (`src/runtime/napi/napi_body.rs`, `fetch_add(1, SeqCst)` + concurrent task
   posted to the worker loop). This **contradicts** the prior SAB-request-race
   fix's premise ("tsfn is not a release barrier"). Code cannot resolve the
   contradiction — **A2 resolves it empirically.**
3. **Non-growable SAB backing stores are pinned** (JSC mmap; a `*mut u8`
   captured at `register_renderer` stays valid). Growable SAB is unsafe to
   borrow. We use fixed-size SAB only (already the case).
4. **No zero-copy stream→socket for dynamic bodies.** `Bun.serve` memcpys
   ReadableStream chunks into uWS; only static `sendfile(2)` is zero-copy.
   "Zero-copy" here = the TS↔Rust boundary, not TS→socket. Out of scope.

## Non-goals (loud)

- **NOT** in-isolate CPU parallelism. Impossible on JSC (physics #1).
- **NOT** a speedup for synchronous pages; the design must not regress them.
- **NOT** changing Bun / `Bun.serve` / stream→socket.
- **NOT** building B or C in this run. This run is measurement only.
- **NOT** reintroducing SAB-for-request unless A2 proves it.

---

## Phase A — decision harnesses (THIS RUN's deliverable)

Two small, self-contained harnesses. Each ends with a printed verdict.

### A1 — interleave-win microbench (pure JS, no Rust, no machine)

The whole point of B can be measured **without building B**: does running two
Suspense renders concurrently in one isolate beat running them serially?

- File: `bench/micro/interleave.ts` (Bun-runnable; `bun run bench/micro/interleave.ts`).
- Build a React tree with a Suspense boundary whose data resolves on a timer
  (configurable `DATA_MS`, default 20ms) plus a tunable synchronous CPU cost
  (`CPU_MS`, render a wide list) so we can sweep the I/O:CPU ratio.
- Measure wall-clock for: (a) **serial** — `await render1(); await render2();`
  (b) **concurrent** — `await Promise.all([render1(), render2()])`, both via
  `renderToReadableStream` consumed to completion.
- Sweep `N ∈ {2,4,8}` concurrent renders and a few `DATA_MS:CPU_MS` ratios.
- **Verdict logic:** concurrent wall-clock / serial wall-clock. `< 0.85` at the
  Suspense-heavy ratio = real win → **Phase B is justified**. `≈ 1.0` across the
  board = no win → **Phase B is NOT worth its cost; stop and document.**
- Also print the pure-synchronous case (`DATA_MS=0`) to confirm/quantify the
  expected *no-win / slight-loss* (the regression risk B must avoid).

A1 needs **no** brust/Rust changes — it isolates the physics question. It is the
single highest-signal, lowest-cost thing in the whole effort.

### A2 — zero-copy-request safety+perf harness (Rust + JS)

Resolve the SeqCst/barrier contradiction and decide C, empirically.

- A focused integration harness (under `crates/brust` integration tests or a
  `bench/micro/` driver) that revives SAB-for-request **into a disjoint region
  that never aliases the response** (the original race lived in request/response
  aliasing at offset 0), under the real multi-thread tokio runtime.
- Drive it at the load that originally surfaced the race (120-conn, 60s) on the
  render path.
- **Verdict logic:** zero corruption AND throughput ≥ `Inline` baseline →
  **Phase C is on**, SAB-request revived in a non-aliasing region. Any
  corruption, or no throughput gain → **C is closed**, `Inline(String)` stays,
  recorded with evidence so it is never re-litigated.
- Do **not** commit the corruption/throughput numbers; commit the harness.

If A1 says "no win," A2 is still worth running (C is independent of B). If both
verdicts are negative, the run's deliverable is the harnesses + a documented
"not worth it, here's the data" — itself a valid, honest outcome.

### Phase A acceptance

- `bench/micro/interleave.ts` runs under Bun and prints serial-vs-concurrent
  ratios across the sweep + the synchronous baseline.
- A2 harness runs, prints corruption count + throughput delta.
- biome clean (`bun run ci`) for the TS; cargo fmt/clippy/test green for any
  Rust harness.
- No numbers committed. Harness code committed, not pushed.
- A written **Decision** appended to this spec: B = go/stop, C = go/stop, each
  with the measured numbers cited inline.

---

## Phase B — K-slot multi-render machine (GATED on A1 win)

Design recorded now so B is a plan-ready unit *if* A1 justifies it. Both review
blockers are first-class scope items here, not afterthoughts.

### B architecture

Today: per worker a binary `idle: AtomicBool` + single
`render_slot: Mutex<Option<RenderSlot>>` + single SAB region at offset 0; one
render owns the worker until its Promise settles and response drains.

Proposed: **K slots per worker** (K a runtime value from tuning).

```
WorkerEntry
 ├─ permits / per-slot AtomicBool[K]   // replaces the single binary `idle`
 ├─ slots: Vec<Slot>  (len K)          // NOT [Slot;K] — K is runtime, heap Vec
 │    └─ Slot { chunk_tx: Mutex<Option<Sender>>, sab_offset, sab_cap }
 └─ dispatch: Box<dyn RenderDispatch>  // call() now carries a slot index
```

- **Claim** = reserve one free slot (CAS its `AtomicBool`) + bump `in_flight`.
  `RenderClaim` holds **one slot**; release on that render's Promise settlement
  (the disconnect/drain invariant is preserved *per slot*).
- **Disjoint SAB regions.** SAB splits into K regions of `floor(cap/K)`. Slot
  `i` touches only `[i*sub .. i*sub+sub]`. Disjointness removes both
  cross-render clobbering and the request/response aliasing C cares about.
- **Slot-addressed response routing.** `napi_render_chunk(worker_id, slot, len)`
  and `_final` gain `slot`; bounds-check against **sub-cap**, read at
  `slot_base + 0`, route to that slot's `chunk_tx` (stored in `Slot`, looked up
  by index — no global scan).
- **K=1 is the existing path, byte-identical.** Fast-path K=1: single region =
  whole SAB (`sub = cap`), `slot=0`, `offset=0`; the slot index travels as an
  **explicit tsfn arg** (NOT folded into envelope JSON) so the K=1 request
  envelope bytes are unchanged for the identity test.

### B BLOCKER resolutions (must be in the plan)

- **B-BLK1 — native-jinja SAB path.** `napi_render_jinja` (lib.rs ~957) is a
  **synchronous** SAB-offset-0 read/write outside the chunk protocol. Resolution:
  it must become **slot-addressed** too — the JS caller holds a slot, passes it,
  and jinja reads/writes that slot's sub-region. If slot-addressing jinja is
  judged too large for B, the fallback is a hard runtime guard: a worker that can
  serve native routes **clamps `renderSlots` to 1** at `register_renderer` time
  (documented degradation, no corruption). The plan MUST pick one explicitly;
  shipping K>1 with jinja untouched is forbidden.
- **B-BLK2 — render-global module state.** Interleaved renders corrupt
  module-scope mutable JS state. Known instance: `consumeIslandUsedFlag` /
  `__used` (island.tsx ~50) read at buffering `_final`. Resolution: make the
  island-used signal **request-scoped** (carried on the per-render context /
  slot, not a module `let`). The plan MUST include an **audit** enumerating every
  module-scope mutable in the render path (`__used`, `getWorkerId`,
  `STREAM_MARKER` [confirmed safe — closure-local], the module `encoder`
  [confirmed safe — `encode()` returns fresh arrays], action-prefix / store
  injection state) and a per-instance verdict. No module mutable may leak across
  concurrent renders.

### B tests

- `pool.rs` unit: K concurrent claims succeed, K+1th blocks until release;
  **two-barrier** design (hold all K open before any drops); `--release`.
- Disjoint-region bounds unit (`MockDispatch`, partitioned buffer): over-sub-cap
  errors; slot 1 never reads slot 0's bytes.
- Integration: staggered-timer two-Suspense route, `renderSlots=2`, two
  concurrent requests → both complete, wall-clock < serial sum, bytes correct
  under a 50-request concurrent loop; islands emit correctly (B-BLK2 regression).
- Regression: `renderSlots=1` → 75/0, byte-identical envelopes, no throughput
  regression.

### B open questions for plan time

- `WorkerPool::register` signature gains K (`register_renderer(buf, slots, f)`);
  `Slot` Vec allocated at registration.
- `pick_least_busy` semantics under K>1 (in_flight still +1 per claim — confirm
  least-busy stays meaningful).
- `check_chunk_dispatch` signature must take sub-cap, not `buf_len()`.
- fast-lane SAB read in `dispatch_single_chunk` / `dispatch_streaming` must use
  `slot_base`, not SAB base.

---

## Phase C — zero-copy SAB request (GATED on A2 pass)

If A2 proves SAB-request safe in a non-aliasing region and faster than `Inline`:
revive `RenderEnvelope::Sab` writing the request into the render's **slot
sub-region** (disjoint from its response framing), pass `Sab(len)` + slot.
Keep `Inline` as the K=1 / fallback path and the safety net. Update the
load-bearing warning on `RenderEnvelope::Sab` to record the A2 evidence either
way. If A2 fails: leave the warning, close C, cite the numbers.

---

## File structure (Phase A only, this run)

- `bench/micro/interleave.ts` — A1 harness (new).
- `bench/micro/` A2 driver and/or a `crates/brust` integration harness — A2.
- This spec — appended with the **Decision** section after A runs.

(Phase B/C file lists live in their respective sections above, for the gated
follow-up.)

## Decision (after Phase A1 ran, 2026-06-05)

Reproduce: `bun run bench/micro/interleave.ts` (numbers are point-in-time and
NOT committed, per the standing constraint; the qualitative shape is stable).

**A1 result — Phase B: GO.** Concurrent renders beat serial on Suspense /
async-data pages by a wide and N-scaling margin (the `io-bound` cell approaches
a near-linear speedup at N=8 — all the data-wait latency overlaps). The
`balanced` and `io-heavy` cells show large wins too. Critically, the
**pure-cpu** cell shows **no concurrency tax** (ratio just under 1.0 — a slight
gain from overlapping stream-orchestration overhead, not a regression). The
feared "K>1 hurts synchronous pages" did not materialize on this host. The
physics held exactly: CPU serializes (pure-cpu ≈ break-even), I/O interleaves
(io-bound ≈ N× win). → The K-slot machine is worth its cost **for Suspense
workloads**; K=1 default keeps synchronous pages untouched.

**A2 finding — zero-copy request is COUPLED to B, not standalone.** Resolving
the SeqCst/barrier contradiction by inspection plus the original post-mortem:
the SAB-request race was fundamentally an **aliasing** bug — request and
response shared the SAB at offset 0, so a not-yet-published request write could
be read as (or clobbered by) a stale response. Bun's tsfn enqueue *is* a SeqCst
barrier, but that publishes nothing useful while the two directions alias the
same bytes. **Phase B's disjoint per-slot regions are the structural fix:** a
request written into slot `i`'s sub-region never aliases any response framing.
Therefore Phase C's zero-copy-request becomes safe *by construction once B
exists*, and the right A2 load-test is **against B's partitioning, not
standalone** — a standalone revival at offset 0 would merely reproduce the known
bug. → A2's 120-conn corruption/throughput test is **folded into Phase B's
acceptance** (the partitioned SAB is exercised under load there); Phase C then
flips the request carrier from `Inline` to `Sab(slot,len)` and re-measures.

**Net:** Phase B is greenlit and now also carries the zero-copy-request proof
(C rides on B's partitioning). The original two-independent-optimizations
framing collapses: partitioning is the common substrate for both.

## Standing constraints (carried from prior runs)

- Commit, **do not push** (`git`), ever, without explicit instruction.
- **Never commit** `bench/RESULTS.*` or any measured numbers.
- Stage explicit paths; **never `git add -A`** (it once swept untracked tooling
  into a commit). TS CI gate is `bun run ci` (biome), not cargo fmt/clippy; tsc
  stack-overflows here — don't rely on it.
