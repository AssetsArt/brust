# Phase B — K-slot multi-render machine — implementation plan

Plan for the GATED Phase B of
`2026-06-05-ssr-multirender-zerocopy-design.md`. Gate passed: A1 proved the
interleave win (Phase B GO). TDD-shaped; each task is independently testable and
ends green before the next starts. Standing constraints apply (commit, never
push; never commit measured numbers; stage explicit paths, never `git add -A`;
TS gate is `bun run ci`).

Folds in Phase C (zero-copy request) at Task 7, since C rides on B's
partitioning (the SAB race was an aliasing bug; disjoint per-slot regions are
its fix).

## Build order (dependency-ordered)

Rust core first (pure, unit-testable, no JS), then the napi seam, then JS, then
the two blocker fixes, then integration, then zero-copy request.

---

### Task 1 — Rust: K-slot `WorkerEntry` core (pure brust-core)

**Files:** `crates/brust-core/src/render/pool.rs`

- Replace the single `idle: AtomicBool` + `render_slot: Mutex<Option<RenderSlot>>`
  with `slots: Vec<Slot>` (len K, heap — K is runtime, NOT `[Slot;K]`).
  `Slot { claimed: AtomicBool, chunk_tx: Mutex<Option<Sender<RenderChunk>>>,
  sab_offset: usize, sab_cap: usize }`.
- `WorkerEntry::new(..., slots: usize, sab_total: usize)` computes
  `sub = sab_total / slots`, `slots[i].sab_offset = i*sub`, `sab_cap = sub`.
- `try_claim_render(chunk_tx)` / `try_claim_render_lockfree()` scan slots, CAS
  `claimed` false→true (Acquire), return `(RenderClaim, slot_index)`. `RenderClaim`
  holds `(entry, slot_index)`; `Drop` clears that slot's `chunk_tx`, decrements
  `in_flight`, stores `claimed=false` (Release) — preserving the per-render
  settlement invariant **per slot** (copy the existing Drop comment, scope it to
  the slot).
- `K=1` fast path: single slot, `sab_offset=0`, `sab_cap=sab_total` (whole SAB →
  byte-identical to today).

**Tests (`pool.rs` `#[cfg(test)]`, MockDispatch):**
- K concurrent claims all succeed; (K+1)th returns `AllBusy` until one drops.
  **Two-barrier**: spawn K threads, each claims and blocks on barrier-1; main
  asserts (K+1)th fails; release barrier-1; assert claims drop and a new claim
  succeeds. Run under `--release` (invariant must survive optimization).
- Each slot's `sab_offset/sab_cap` is disjoint and tiles `[0, sab_total)`.
- K=1 → one slot spanning the whole buffer.

**Green:** `cargo test -p brust-core pool`; clippy `-D warnings`; fmt.
**BLOCKED fallback:** if `Vec<Slot>` + RAII lifetimes fight the borrow checker,
pivot to `Arc<[Slot]>` with the claim holding `Arc<Slot>` + worker ref.

---

### Task 2 — Rust: slot-addressed `RenderDispatch` + dispatch seam

**Files:** `crates/brust-core/src/render/dispatch.rs`, `crates/brust/src/dispatch_impl.rs`

- `RenderDispatch::call(env, slot: u32)`; add `buf_slot(slot) -> (*mut u8, usize)`
  returning the slot's sub-region base+cap (default impl derives from `buf()` +
  slot geometry, or pass geometry in).
- `TsfnDispatch::call` passes `slot` to JS as an **explicit extra tsfn arg**
  (NOT folded into envelope JSON — keeps K=1 envelope bytes identical). Update
  `RendererTsfn` type to carry the slot arg.
- `MockDispatch` updated for the new signature.

**Tests:** dispatch unit tests compile + pass with slot threading; `buf_slot`
geometry matches Task 1.
**Green:** `cargo test -p brust-core`; `cargo build -p brust`.

---

### Task 3 — Rust: napi `register_renderer` + slot-addressed chunk fns

**Files:** `crates/brust/src/lib.rs`, `crates/brust-core/src/server/mod.rs`

- `register_renderer(buf, slots: u32, f)` → `pool.register(dispatch, slots,
  buf_len)`.
- `napi_render_chunk(worker_id, slot: u32, len)` and
  `napi_render_chunk_final(worker_id, slot, len, ...)`: bounds-check `len`
  against **sub-cap** (`buf_slot(slot).1`), read SAB at **`slot_base`** not 0,
  route to `slots[slot].chunk_tx` (array lookup, no scan). Update
  `check_chunk_dispatch` signature to take the sub-cap + slot.
- `dispatch_single_chunk` / `dispatch_streaming` / `spawn_chunk_pump` thread the
  claimed `slot`; fast-lane SAB read uses `slot_base`, not SAB base.

**Tests:** an integration test driving a 2-slot mock worker: chunk to slot 1
never reads slot 0's bytes; over-sub-cap `len` errors.
**Green:** `cargo test`; `cd runtime && bun run build` (rebuild .node — memory
`stale-napi-node-after-compiler-change`).
**BLOCKED fallback:** napi snake_case — `ServeTuning.render_slots` must be
snake_case in the `#[napi(object)]` (memory `napi-object-camelcase-keys`).

---

### Task 4 — JS: slot-aware renderer + SAB sub-view

**Files:** `runtime/routes.ts` (`makeRenderer`), `runtime/render/stream.ts`,
`runtime/index.ts`

- `makeRenderer` render fn gains `slot` param; compute
  `slotView = view.subarray(slot*sub, slot*sub + sub)` and pass it everywhere
  `view` is used today. `encodeFirstChunk`/`encodeBodyChunk` write into
  `slotView` (their offset-0 assumption becomes offset-0-of-the-subview —
  correct). `napi.renderChunk(workerId, slot, len, slotView)`.
- `register_renderer(sab, slots, fn)` from the worker boot; SAB size scales with
  K (`baseRegion * K`) so each slot keeps today's per-render capacity.
- `ServeOptions.tuning.renderSlots?: number` (default 1) → plumb to
  `register_renderer`.

**Tests:** `runtime` unit — slot 1 subview writes don't touch slot 0 bytes.
**Green:** `bun run ci` (biome); existing `bun test` green.

---

### Task 5 — JS BLOCKER B-BLK2: request-scope all render module-globals

**Files:** `runtime/components/island.tsx` (or wherever `__used` lives),
`runtime/render/stream.ts`, audit across `runtime/`

- **Audit** every module-scope mutable touched during a render (`__used` /
  `consumeIslandUsedFlag`, `getWorkerId`, action-prefix/store injection state,
  `encoder` [confirmed safe], `STREAM_MARKER` [confirmed safe, closure-local]).
  Produce the audit as a comment block + per-item verdict.
- Make the island-used signal **request-scoped**: carry it on the per-render
  context passed into `renderBranchStreaming` (a `{ islandUsed: boolean }` box
  created per render), not a module `let`. `consumeIslandUsedFlag()` reads the
  per-render box.
- Any other unsafe module mutable found → same treatment.

**Tests:** integration — two concurrent renders, one uses an `<Island>` and one
doesn't; assert each emits the island bootstrap correctly (the one without
islands must NOT get it). This is the B-BLK2 regression and MUST fail before the
fix.
**Green:** `bun run ci`; the new island-isolation test passes; `renderSlots=1`
suite unchanged.

---

### Task 6 — Rust+JS BLOCKER B-BLK1: native-jinja under K>1

**Files:** `crates/brust/src/lib.rs` (`napi_render_jinja`), `runtime/` jinja caller

**Decision (pick ONE, default = slot-address):**
- **Preferred — slot-address jinja:** `napi_render_jinja(worker_id, slot, ...)`
  reads loader JSON from and writes the response to **slot's** sub-region, not
  offset 0. The JS jinja caller holds the claimed slot and passes it.
- **Fallback — clamp:** if slot-addressing jinja is too large, a worker that can
  serve native routes clamps `renderSlots=1` at `register_renderer` (documented
  degradation, zero corruption). Guard + log.

**B-BLK3 — SSE/WS slot-0 dispatch (surfaced by the Rust core review).** SSE and
WS call `dispatch.call(env, 0)` WITHOUT holding a per-slot `RenderClaim` (they
use `in_flight_guard` and own their socket via the napiSse*/napiWs* registries).
At K=1 this is byte-identical to today and safe (those handlers never touch the
SAB). At K>1 it is a latent hazard: a concurrent HTTP render legitimately owns
slot 0 while SSE/WS also passes slot 0 — safe ONLY because SSE/WS never write the
SAB, an invariant enforced by JS contract, not Rust. Before enabling K>1, add a
**no-SAB dispatch variant** (e.g. a `RenderEnvelope`/call path that carries no
slot / cannot touch the response region) for SSE/WS, OR assert at the boundary
that those handlers never write the slot. The call sites carry a LOAD-BEARING
comment (`server/mod.rs` SSE ~762, WS ~882). Do not enable `render_slots>1`
until this is resolved.

**Tests:** integration — a native route + a React route, `renderSlots=2`, two
concurrent requests (one native, one React); assert both bytes-correct, no
cross-corruption. MUST fail first if jinja still hardcodes offset 0. Add an
SSE-during-render concurrent test once the no-SAB variant lands (B-BLK3).
**Green:** `cargo test`; `bun run ci`; native-island integration suite green
(run files separately — memory `native-island-integration-flake`).

---

### Task 7 — Phase C: zero-copy SAB request into the slot region

**Files:** `crates/brust-core/src/render/dispatch.rs`, `server/mod.rs`,
`crates/brust/src/dispatch_impl.rs`, `runtime/routes.ts`

- Revive `RenderEnvelope::Sab(len)` writing the request envelope into the
  claimed slot's sub-region (disjoint from its response framing — no aliasing).
  Pass `Sab(len)` + slot; JS reads the request from `slotView.subarray(0,len)`.
- Keep `Inline(String)` as the K=1 path + fallback + safety net.
- **A2 load test (folded here):** hammer the SAB-request path at 120-conn / 60s
  under the multi-thread runtime (the config that originally surfaced the race).
  Zero corruption + throughput ≥ Inline → keep `Sab`. Any corruption → revert to
  `Inline`, update the load-bearing warning with the evidence. Numbers NOT
  committed.
- Update the `RenderEnvelope::Sab` warning comment with the A2 outcome either
  way.

**Green:** `cargo test`; 120-conn soak shows 0 corruption; `bun run ci`.
**BLOCKED fallback:** corruption recurs even with disjoint regions → C is closed
for good; `Inline` stays; document with the soak evidence. (Does not block B —
B ships on `Inline`.)

---

### Task 8 — Integration + bench wiring + verification

- `bench/apps/brust/index.ts`: `BRUST_RENDER_SLOTS` env → `tuning.renderSlots`.
- Add a Suspense-heavy bench route so `bun run bench` can show the win with
  `BRUST_RENDER_SLOTS=4`. (Numbers NOT committed.)
- Full gate: `cargo test` (incl. `--release` invariant), clippy `-D warnings`,
  fmt, `bun run ci`, integration 75/0 at `renderSlots=1` (byte-identical), the
  new concurrent-render + island-isolation + native-cross tests green.
- Re-run A1 to confirm no harness regression; manual smoke with a real
  Suspense page at `renderSlots=2`.

---

## Acceptance (whole of B+C)

- `renderSlots=1`: 75/0 integration, byte-identical envelopes, no throughput
  regression vs branch baseline.
- `renderSlots=2+`: two concurrent Suspense requests interleave (wall-clock <
  serial sum), zero cross-slot/island/native corruption under concurrent load.
- All gates green (cargo fmt/clippy/test incl. `--release`; `bun run ci`).
- Phase C: `Sab` request kept only if the soak proves it; else `Inline` stays,
  documented.
- Nothing pushed; no measured numbers committed.

## Risk register

- **R1** module-global leak missed in the Task 5 audit → silent cross-render
  corruption. Mitigation: the audit is exhaustive + the island-isolation test.
- **R2** jinja slot-addressing larger than estimated → use the clamp fallback,
  ship B for React, file jinja-partition as a follow-up.
- **R3** SAB-request race recurs (Task 7) → B is unaffected (ships on Inline);
  close C with evidence.
- **R4** SAB size scales with K (memory) → document; K small (2–4) keeps it
  modest; cap K.
