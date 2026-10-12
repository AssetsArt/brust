# beta1-f82-large-bodies: action bodies larger than the SAB slot cross by heap transfer, both directions (F82)
**RULED by lead Detoro 2026-10-12 (before dispatch): R1-R8 ALL ACCEPTED as their defaults — R1 `putFetchReply(slot, body)` sync napi + `heap: <len>` meta key, tsfn signature and `RenderDispatch` unchanged; R2 request `body: {"heap": n}` + `takeFetchBody(slot)` through the thread-local binding `planJobs` uses (two workers on one thread → declined 500, tests only); R3 fixed threshold 262144 = `SLOT_BYTES`; R4 `max_body_bytes` default 1 MiB (1 B..64 MiB), `max_response_bytes` default 8 MiB (256 KiB..64 MiB) on body bytes; R5 worker checks first, Rust re-checks; R6 actions only; R7 base64 unchanged ≤ 262144; R8 plain-text 500 bodies as today (the 403 of lane beta1-f87 is problem+json by its own ruling — a Rust-side error-shape unification is a later design call, not this lane). Existing tests that flip by design (300 KiB → 200; the 413 test pins an explicit 256 KiB cap) are changed as the plan says. ORDERING: lane `beta1-f87-cross-site-guard` edits `ActionsConfig`/`NapiActionsOptions`/`build/config.ts`/`manifest.ts`/`docs/actions.md` too — rebase onto `beta1` after F87 merges before touching those files; if F87 is not merged when you reach them, file a `task challenge` and the lead sequences the merge. The lead files the F82 ledger cell at merge if the lane does not.**
owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: beta1 · lane: beta1-f82-large-bodies · tier: standard · review: complex

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Ledger row closed by this lane (`docs/plans/m1a-followups.md:146`, quoted): *"F82 | `crates/brust-server/src/dispatch.rs` fetch framing + `packages/brust/src/actions-bridge.ts` (SAB slot 256 KB) | An action response larger than the worker's SAB slot is answered 500 `brust: action response exceeds <n> bytes` (ruled R10 on the bridge plan); request bodies are buffered up to `max_body_bytes` (262144). No streaming in either direction. | Chunked or streamed action bodies over the bridge (a second lane: multi-frame responses or a heap transfer for large bodies); raise the documented limit."*

Lead decision (fact, not a ruling): **no streaming protocol and no multi-frame continuation.** Large bodies use a HEAP TRANSFER in both directions. The SAB-slot fast path stays byte-for-byte the same for every body that fits.

## 1. Goal

- An action response whose A2 frame does not fit the 256 KiB slot (`SLOT_BYTES`, `packages/brust/src/worker.ts:296`) is answered in full, with the app's status and every header pair, up to `[actions] max_response_bytes` (default 8 MiB). A body over that cap is answered `500 text/plain` with `brust: action response exceeds <max_response_bytes> bytes`, plus one `[brust]` log line.
- A request body over 262144 bytes reaches the app as raw bytes: no text or base64 inside the JSON, and the app's `await req.arrayBuffer()` gets back exactly what was sent. Bodies of 262144 bytes or less cross exactly as today: `{text}` or `{b64}` inline.
- `max_body_bytes` defaults to 1048576 and accepts 1..=67108864. Anything above the configured cap is still 413 `payload too large`, decided before the worker is called.
- These paths are byte-identical to today: a response that fits the slot, a body of 262144 bytes or less, and every loader or jobs call. The tsfn signature (`crates/brust-napi/src/dispatch.rs:29-35`), `RenderDispatch` and `call_worker_decoded` (`crates/brust-server/src/dispatch.rs:282-360`) do not change, so `git apply --check bench/attribution.patch` stays clean.
- Pages, loaders and jobs (`ssr`) do not get heap transfer (R6).
- `docs/actions.md` §9 documents both limits and both keys. Spec E4/A1/A2/A3 carry an amendment. The F82 ledger cell reads `DONE 2026-10-xx — …`.

## 2. Rulings requested

**R1 — napi surface for a large response.** *Recommended:* add a new sync napi function, `putFetchReply(slot: number, body: Uint8Array): boolean`.
- It takes the body only. Status and headers still travel in the slot as a normal A2 frame, whose meta gains one key, `heap: <body length>`, and whose slot body is empty.
- Rust copies the body once into `Bytes` and stores it in a per-call `FetchCell`. `call_worker_fetch` seeds that cell into the claimed slot's existing plan cell (`pool.rs:62`, `RenderClaim::put_plan` at `:231`), and the cell is dropped with the claim.
- The worker then resolves its Promise with the small frame length, as it does today. `decode_fetch_reply` reads the body out of the cell. `call_worker_decoded` gets no new branch.
- *Alternative A:* the lead's literal shape. One `[meta][body]` buffer goes to Rust, and the Promise resolves with a sentinel such as `u32::MAX`. That needs a branch in `call_worker_decoded` between `dispatch.rs:312` and `:328`. Those lines are hunk-2 context of `bench/attribution.patch`, so the patch would have to be regenerated.
- *Alternative B:* the Promise resolves `Either<u32, Uint8Array>`. That changes `RenderDispatch::call` and all 7 implementors, including `tests/single_roundtrip.rs:365`.

**R2 — request body transport.** *Recommended:* pull it through the same cell. When a body is over the threshold, A1 carries `body: {"heap": <len>}`, and Rust puts the `Bytes` into the call's `FetchCell` before the call.
- The worker calls `takeFetchBody(slot): Uint8Array | null`.
- napi-rs 3.14 `Uint8Array::new(Vec<u8>)` hands over an external ArrayBuffer, so there is no copy. It falls back to a copy when the host refuses external buffers.
- The tsfn is unchanged.
- *Alternative:* a fourth tsfn argument `Option<Uint8Array>`. That changes `WorkerTsfn`, `register_worker`'s JS signature (`server.rs:205`), `WorkerFn` (`native.ts:49`), `RenderDispatch::call` and all 7 implementors.
- *Both R1 and R2 as recommended* find the worker through the thread-local `BOUND` binding (`server.rs:32-67`), exactly as `planJobs` does. When the binding is ambiguous (two workers of one server registered on one JS thread, which happens in tests only and never in `run.ts`), the heap transfer declines and the call answers 500. *Alternative:* pass the worker id explicitly from JS.

**R3 — inline threshold.** *Recommended:* a fixed Rust const, `ACTION_INLINE_BODY_BYTES = 262_144`, equal to `SLOT_BYTES`. A body is inline when its length is ≤ 262144 and goes by heap when it is larger, whatever its content type. *Alternative:* a separate `[actions] inline_body_bytes` knob, or heap for every non-textual body.

**R4 — defaults and bounds.**
- *Recommended `max_body_bytes`:* default 1048576 (1 MiB), allowed 1..=67108864.
- *Recommended `max_response_bytes`:* default 8388608 (8 MiB), allowed 262144..=67108864. It counts response body bytes, not the meta. The minimum equals the slot, so a body that fits the slot can never be over the cap, and the fast path needs no cap check.
- Both bounds are enforced in `brust build` (`BuildError config`) and in `ActionsConfig::validate` (`start` → `actions: …`).
- *Alternative:* keep the u32 upper bound (`build/config.ts:13`), or use a 4 MiB response default.

**R5 — where the response cap is enforced.** *Recommended:* in both places.
- The manifest A3 gains `maxResponseBytes`, which `brust build` always writes. `StartOptions.actions` gains `maxResponseBytes`.
- The worker checks first, so it never copies an over-cap body into Rust. It reads the cap from `manifest.actions.maxResponseBytes`, or uses the default when the key is absent. `putFetchReply` checks again against the `ActionsConfig`.
- *Alternative:* check in Rust only. The worker would then copy up to the full body before being refused.

**R6 — page/ssr path.** *Recommended (lead default):* NO. Loader and jobs responses keep today's slot-only behaviour; `putFetchReply` declines outside a fetch call. *Alternative:* extend the heap reply to loader responses, which is a separate lane.

**R7 — small binary bodies.** *Recommended (lead default):* unchanged. A non-textual body of 262144 bytes or less stays `{b64}` (`actions.rs:164-181`). *Alternative:* send every binary body by heap.

**R8 — user-facing failure bodies.** *Recommended:*
- Over `max_response_bytes`: 500 `text/plain; charset=utf-8`, body `brust: action response exceeds <max_response_bytes> bytes` (today's text, with n = the cap). Log line: `[brust] action response body <n> bytes exceeds max_response_bytes <max> — answered 500`.
- Heap transfer declined, or the heap request body is missing or the wrong length: 500 `brust: action failed` plus a log line naming F82.
- Rust's decode of a malformed heap frame: today's `BadResponse` → `error_500`.
- *Alternative:* RFC 9457 `application/problem+json` bodies.

## 3. Boundary

- `crates/brust-server/src/{actions.rs,config.rs,dispatch.rs,protocol.rs,lib.rs}`. In `dispatch.rs`, only `call_worker_fetch` (`:238-255`), `decode_fetch_frame` (`:258-278`) with new items next to them, and the `#[cfg(test)]` module. Lines `:282-360` are NOT touched.
- `crates/brust-server/tests/{actions.rs,common/fake_bun.rs,common/mod.rs}`
- `crates/brust-napi/src/server.rs`
- `packages/brust/src/{actions-bridge.ts,native.ts,worker.ts,run.ts,actions/prefix.ts,build/config.ts,build/manifest.ts,build/index.ts}`
- `packages/brust/test/{actions-bridge.test.ts,actions-napi.test.ts,e2e-actions.test.ts,build-config-actions.test.ts,build-actions.test.ts,run-options.test.ts}` and `packages/brust/test/fixtures/actions-app/{actions.ts,brust.toml}`
- `packages/create-app/templates/blank/brust.toml` (comment line 5 only)
- `docs/actions.md`, `docs/design/2026-10-11-m3f-actions-elysia-create-app-design.md` (amendment only), `docs/plans/m1a-followups.md` (row F82 only)
- NOT touched: `pool.rs`, `pipeline.rs`, `crates/brust-napi/src/dispatch.rs`, `tests/single_roundtrip.rs`, `bench/**`, `.github/**`.

## 4. Tasks

Ground truth (v2 @79885d3, read by the drafter):
- The worker completes a call by resolving the tsfn Promise with the frame length (`makeDispatch`, `worker.ts:268-292`). No separate completion function exists.
- The precedent for a sync worker→Rust call inside a call is `planJobs` → `plan_in_call`, which writes the claimed slot's plan cell (`server.rs:235-241`, `pipeline.rs:1885-1925`).
- `RenderClaim::drop` always clears the plan cell (`pool.rs:265-267`).
- `FakeBun` is bound to its server and worker id (`tests/common/mod.rs:301-314`), so Rust tests can call `brust_server::take_fetch_body` and `put_fetch_reply` the way they already call `plan_in_call` (`fake_bun.rs:192`).

### Task 1 — worktree, install, addon, baseline green
- [ ] `git -C /Users/detoro/code/brust-v2 fetch && git -C /Users/detoro/code/brust-v2 worktree add ~/code/brust-f82 -b lane/beta1-f82-large-bodies beta1`
- [ ] `cd ~/code/brust-f82 && bun install --frozen-lockfile && (cd packages/brust && bun run build:debug)`. Expect the build to end with `native/brust.<plat>.node` written.
- [ ] Baseline. Each command must pass; record the pass counts for the READY note.
  - `cargo test -p brust-server --test actions`
  - `cargo test -p brust-server --lib dispatch::`
  - `cargo test -p brust-napi`
  - `cd packages/brust && bun test test/actions-bridge.test.ts test/build-config-actions.test.ts test/run-options.test.ts`
  - `bun test test/actions-napi.test.ts`
  - `bun test test/build-actions.test.ts`
  - `bun test --timeout 120000 test/e2e-actions.test.ts`
- [ ] `git apply --check bench/attribution.patch`. Expect no output and exit 0 (the baseline for Task 3).

### Task 2 — config: `max_response_bytes`, new defaults, bounds (Rust + napi)
- [ ] Test first, in `config.rs` `actions_validation_table` (`:377-427`): `max_body_bytes` 67108864 is Ok and 67108865 is Err. `max_response_bytes` 262143 and 67108865 are Err; 262144 and 8388608 are Ok. Each message contains its key name.
- [ ] Test first, in napi `actions_options_default` (`server.rs:372-390`): the absent key maps to 8388608, and `maxResponseBytes: Some(1<<20)` maps through.
- [ ] Implement:
  - `config.rs:84-85`: `DEFAULT_MAX_ACTION_BODY_BYTES = 1_048_576`, plus new `pub const DEFAULT_MAX_ACTION_RESPONSE_BYTES: usize = 8_388_608`, `pub const MAX_ACTION_BYTES: usize = 67_108_864`, `pub const ACTION_INLINE_BODY_BYTES: usize = 262_144`.
  - `ActionsConfig` (`:91-103`) gains `pub max_response_bytes: usize` with its default.
  - `validate` (`:145-147`) gains the R4 bounds: `"maxBodyBytes must be in 1..=67108864"` and `"maxResponseBytes must be in 262144..=67108864"`.
  - `lib.rs:26-29` re-exports the new consts.
  - napi `NapiActionsOptions` (`server.rs:104-109`) gains `max_response_bytes: Option<u32>`, mapped in `actions_config` (`:124-131`).
- [ ] Fix the literal `ActionsConfig { … }` sites: `server.rs:385` (test) and `tests/actions.rs:37,682` already spread `..Default`.
- [ ] Run `cargo test -p brust-server --lib config:: && cargo test -p brust-napi`. Expect them to pass.

### Task 3 — protocol + dispatch: `FetchBody::Heap`, `FetchMeta.heap`, `FetchCell`, `decode_fetch_reply`
- [ ] Tests first:
  - `protocol.rs` `fetch_request_json_is_pinned` (`:538-549`): `FetchBody::Heap(262145)` serialises `"body":{"heap":262145}`.
  - `fetch_meta_reads_pairs` (`:551-569`): `{"status":200,"heap":5}` → `heap: Some(5)`; no key → `None`.
  - `dispatch.rs` tests:
    - `decode_fetch_reply_table`: a heap meta with an empty slot body plus a 5-byte cell gives those bytes. A heap meta with a non-empty slot body is `BadResponse` containing `heap`. A missing cell value gives `heap reply missing`. A length mismatch gives `heap reply 4 != 5`. A frame with no `heap` key behaves exactly like `decode_fetch_frame`.
    - `call_worker_fetch_seeds_a_fetch_cell`: a `MockDispatch` whose reply is a normal frame. Afterwards the slot is claimable again and `entry.slot(0).plan` is empty.
- [ ] Implement:
  - `protocol.rs:240-243`: add `Heap(usize)`.
  - `FetchMeta` (`:247-251`): add `#[serde(default)] pub heap: Option<u64>`.
  - `dispatch.rs`: add `pub struct FetchCell { pub(crate) body: Option<bytes::Bytes>, pub(crate) reply: Arc<parking_lot::Mutex<Option<bytes::Bytes>>> }`.
  - `call_worker_fetch(pool, timeout, call_timeout, req, heap_body: Option<bytes::Bytes>)` always seeds `Some(Box::new(FetchCell{…}))` and decodes with `move |b| decode_fetch_reply(b, &reply)`.
  - `decode_fetch_frame` keeps its signature and delegates to a shared meta reader.
- [ ] Run `cargo test -p brust-server --lib && git apply --check bench/attribution.patch`. Both must pass. The patch check proves `:282-360` is untouched.

### Task 4 — `actions.rs`: threshold, `take_fetch_body`, `put_fetch_reply`; FakeBun; HTTP tests
- [ ] Extend FakeBun (`tests/common/fake_bun.rs`):
  - Add `last_fetch_body: Mutex<Option<Vec<u8>>>`.
  - In `reply()` for `Fetch` (`:177-179`): when `req["body"]["heap"]` is a number and the fake is bound, call `brust_server::take_fetch_body(&s, id, slot)` and record the bytes.
  - When the responder's frame is larger than the slot (256 KiB), split it: `put_fetch_reply(&s, id, slot, body)`, then return a frame whose meta adds `"heap": body.len()` and whose body is empty, as the real worker does.
- [ ] Tests first, in `tests/actions.rs`:
  1. `body_at_threshold_is_inline_and_one_over_is_heap`: cap 1 MiB. 262144 bytes of `text/plain` gives `{"text":…}`. 262145 bytes gives `{"heap":262145}`, and `last_fetch_body` is byte-equal.
  2. `heap_body_binary_is_lossless`: 300 KiB of `application/octet-stream` with bytes `i % 251` round-trips byte-equal.
  3. `response_over_slot_crosses_by_heap`: the responder returns 1 MiB with two `set-cookie` headers. Expect 200, a byte-equal body, both cookies and `content-length` 1048576.
  4. `heap_reply_over_max_response_bytes_is_declined`: `put_fetch_reply` returns false when the body is larger than `max_response_bytes`, then the fake writes the 500 frame. Expect 500 with the exact text.
  5. `heap_meta_without_reply_is_500`: the responder writes meta `heap: 10` and never puts. Expect 500.
  6. `put_fetch_reply_declines_outside_a_fetch_call`: on an idle slot or an unknown worker it returns false.
  7. Change `chunked_body_over_cap_is_413` (`:119-124`) to `server_cap(ok, 262_144)`, because 300 KiB is now under the 1 MiB default.
- [ ] Implement in `actions.rs`:
  - In `handle` (`:45-62`), for `b.len() > ACTION_INLINE_BODY_BYTES`: `(Some(FetchBody::Heap(b.len())), Some(b))`; otherwise `encode_body` as today. Pass the bytes to `call_worker_fetch` (`:94`).
  - Add these pub fns, re-exported from `lib.rs:31` next to `plan_in_call`:

```rust
/// F82, on the worker's JS thread inside its `fetch` call for `slot`: the heap request body, once.
pub fn take_fetch_body(s: &Server, worker: u32, slot: u32) -> Option<Vec<u8>>
/// F82: hand Rust a response body too large for the slot. `false` = declined: no actions config,
/// `body.len() > max_response_bytes`, the slot is not in a `fetch` call, or a reply was already put.
pub fn put_fetch_reply(s: &Server, worker: u32, slot: u32, body: &[u8]) -> bool
```
  - Both use `s.pool.entry(worker)?.claimed_plan_cell(slot)?` and `downcast_mut::<FetchCell>()`.
  - Copy `body` before taking the lock.
  - Never panic: same `catch_unwind` discipline as `plan_in_call`.
- [ ] Run `cargo test -p brust-server --test actions`. Expect every old test plus the 6 new ones to pass.

### Task 5 — napi `takeFetchBody` / `putFetchReply`
- [ ] Implement in `server.rs`, after `plan_jobs` (`:235-241`), using the same `BOUND.with_borrow(bound)` and never throwing:
  - `#[napi] pub fn take_fetch_body(slot: u32) -> Option<Uint8Array>` returns `Uint8Array::new(vec)`.
  - `#[napi] pub fn put_fetch_reply(slot: u32, body: Uint8Array) -> bool` returns `false` when nothing is bound.
  - Update the module doc (`:1-2`).
- [ ] Run `cargo clippy -p brust-napi --no-deps -- -D warnings && cargo test -p brust-napi && (cd packages/brust && bun run build:debug)`. Expect a clean build.

### Task 6 — TS plumbing: config, manifest, StartOptions, native binding
- [ ] Tests first:
  - `build-config-actions.test.ts:36-54`:
    - The defaults become `maxBodyBytes: 1048576, maxResponseBytes: 8388608`.
    - `max_response_bytes = 1048576` parses.
    - The new range messages are `actions.max_body_bytes must be an integer in 1..67108864 (got …)` and `actions.max_response_bytes must be an integer in 262144..67108864 (got …)`.
  - `build-actions.test.ts:94`: the manifest has `maxResponseBytes`.
  - `run-options.test.ts:13-16`: keys `['prefix','maxBodyBytes','maxResponseBytes']`.
- [ ] Implement:
  - `actions/prefix.ts:3`: `DEFAULT_MAX_BODY_BYTES = 1_048_576`, plus `DEFAULT_MAX_RESPONSE_BYTES = 8_388_608` and `MAX_ACTION_BYTES = 67_108_864`.
  - `build/config.ts:10-48`: parse `max_response_bytes`; replace the `MAX_U32` bound.
  - `build/manifest.ts:54-59` `ActionsRecord`, and `build/index.ts:181`.
  - `run.ts:25,38`, `worker.ts:74`.
  - `native.ts:44-48` `ActionsOptions.maxResponseBytes?`. In `NativeBinding` (`:50-60`) add `takeFetchBody(slot: number): Uint8Array | null` and `putFetchReply(slot: number, body: Uint8Array): boolean`, plus their exports next to `:85`.
- [ ] Run `cd packages/brust && bun run typecheck && bun test test/build-config-actions.test.ts test/run-options.test.ts && bun test test/build-actions.test.ts`. Expect them to pass.

### Task 7 — worker bridge: heap in, heap out (`actions-bridge.ts`)
- [ ] Tests first, in `actions-bridge.test.ts`. Inject `io: HeapIo` the way `makeDispatch` injects `plan`.
  1. `{heap: 300000}` with `takeBody` returning 300000 bytes: the app sees byte-equal `arrayBuffer()`.
  2. `takeBody` returns `null`, or a length that is not `heap`: 500 `brust: action failed`, one `console.error`.
  3. A 300 KiB response: `putReply` is called once with the body. The frame meta is `{status, headers, heap: 307200}` and the slot body is empty.
  4. A response over the cap (`setActionsLimits({maxResponseBytes: 262144})`, body 262145): `putReply` is NOT called. 500 with the R8 text and log line.
  5. `putReply` returns false: 500 `brust: action failed`.
  6. A response that fits the slot: `putReply` is not called, and the slot bytes equal today's `writeFramed` output, compared byte for byte.
  - Replace the old `'oversize body → 500 frame'` test (`:167-182`) with cases 3 and 4.
- [ ] Implement:
  - `FetchRequest.body` gains `{ heap: number }` and `FetchMeta` gains `heap?: number`.
  - `export interface HeapIo { takeBody(slot: number): Uint8Array | null; putReply(slot: number, body: Uint8Array): boolean }`, with the default backed lazily by `native()`.
  - `export function setActionsLimits(l: { maxResponseBytes: number }): void`.
  - `toRequest(r, heapBody?)`.
  - `runFetch(requestJson, view, slot, slots, io = nativeHeapIo)`, which makes the R1/R5/R8 decision before calling `writeFramed`.
  - `worker.ts:326-330` calls `setActionsLimits({ maxResponseBytes: manifest.actions.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES })`.
- [ ] Run `cd packages/brust && bun test test/actions-bridge.test.ts test/worker.test.ts`. Expect them to pass.

### Task 8 — real addon + real CLI
- [ ] `actions-napi.test.ts`: after the first test's `beginDrain` (`:137`), add a second `test(...)`.
  - It runs `startServer` with `actions: { prefix: '/api', maxBodyBytes: 4 << 20, maxResponseBytes: 2 << 20 }`, sets a fresh 2-slot view with `registerWorker`, and calls `setActionsLimits({maxResponseBytes: 2 << 20})`.
  - Assert:
    - `/api/bin` echoes 300 KiB of binary byte-equal.
    - A 3 MiB JSON POST to `/api/team` echoes (heap in and out).
    - `/api/huge` (2 MiB + 1) is 500 `brust: action response exceeds 2097152 bytes`.
    - `(4 << 20) + 1` bytes is 413.
    - 8 concurrent 1 MiB echoes are all byte-equal (slot isolation of the cell).
  - In the first test, `/api/big` (`:125-128`) now answers 200 with 307200 bytes.
- [ ] `e2e-actions.test.ts`:
  - The fixture `brust.toml` adds `max_response_bytes = 1048576`. Its `actions.ts` adds `.get('/huge', () => 'x'.repeat(1048577))`.
  - Test 7 (`:111-115`) becomes "`/big` (300 KiB) is 200 and full length".
  - New test 7b: `/huge` is 500 `brust: action response exceeds 1048576 bytes`.
- [ ] Run `cd packages/brust && bun test test/actions-napi.test.ts && bun test --timeout 120000 test/e2e-actions.test.ts`. Expect them to pass.

### Task 9 — docs, spec amendment, ledger
- [ ] `docs/actions.md`:
  - Config block `:36-41`: `max_body_bytes = 1048576  # 1..67108864` and `max_response_bytes = 8388608  # 262144..67108864`.
  - Manifest sentence `:43`: add `maxResponseBytes`.
  - Rewrite §9 bullets `:379-380`: both caps; inline ≤ 256 KiB vs heap above; still buffered, so no streaming; 413 vs 500 texts.
- [ ] Spec: append `> **Amendment (beta1-f82-large-bodies, 2026-10-xx):** …` under E4 (`:20`), E9 (`:25`) and the A1/A2/A3 rows (`:72-74`). The amendment covers `{heap:n}`, meta `heap`, `maxResponseBytes`, and the new defaults and bounds.
- [ ] `packages/create-app/templates/blank/brust.toml:5`: change the comment to say `max_body_bytes = 1048576, max_response_bytes = 8388608`.
- [ ] Ledger `m1a-followups.md:146`: replace the last cell with `DONE 2026-10-xx — heap transfer both ways (lane beta1-f82-large-bodies @<sha>): bodies > 256 KiB cross by napi takeFetchBody/putFetchReply; max_body_bytes 1 MiB (≤ 64 MiB), max_response_bytes 8 MiB (≤ 64 MiB); no streaming (lead)`.

### Task 10 — gates, then READY (section 6)

## 5. Acceptance

- [ ] `cargo test -p brust-server --test actions`: all old tests pass, plus the 6 new ones.
- [ ] `cargo test -p brust-server --lib`: the `decode_fetch_reply_table` and `call_worker_fetch_seeds_a_fetch_cell` tests pass.
- [ ] `git diff beta1 -- crates/brust-server/src/pool.rs crates/brust-server/src/pipeline.rs crates/brust-napi/src/dispatch.rs crates/brust-server/tests/single_roundtrip.rs bench/` is empty.
- [ ] `git apply --check bench/attribution.patch` exits 0.
- [ ] `cd packages/brust && bun test test/actions-napi.test.ts`: 2 tests pass, including 8 concurrent 1 MiB echoes.
- [ ] `bun test --timeout 120000 test/e2e-actions.test.ts`: `/big` is 200 and `/huge` is 500 with the exact text.
- [ ] `grep -n "262144" docs/actions.md` shows only the inline threshold sentence. `grep -n "F82" docs/plans/m1a-followups.md` shows `DONE 2026-10-`.

## 6. Gates (all green before READY)

- [ ] `cargo fmt --all -- --check`
- [ ] `cargo clippy -p brust-compiler -p brust-compiler-cli -p brust-jinja -p brust-server -p brust-napi --no-deps -- -D warnings`
- [ ] `cargo test --workspace --exclude bun_react_compiler`
- [ ] `cargo test -p brust-server --release --test single_roundtrip -- --nocapture`
- [ ] `cd packages/brust && bun run build:debug && bun run build && bun run typecheck`, then every `bun test` line of `ci.yml:120-129`, each server-starting file run alone.
- [ ] `cd examples/pokedex && bun test && bun run typecheck`
- [ ] `bun test --timeout 120000 tests/server/pokedex.test.ts`
- [ ] `cd packages/create-app && bun run typecheck && bun test test/templates.test.ts test/sync-template.test.ts`
- [ ] `git apply --check bench/attribution.patch`
- [ ] Unaffected, but the lead runs them at merge: runtime-dom, `hydrate.chromium`, browser-test, battery, m2-exit, bench lib.

## 7. Risk ledger

- **Plan-cell sharing.** A fetch call's cell is now always a `FetchCell`, and a planned loader's cell is a `PlanCell`.
  - Breaks if `put_fetch_reply` or `take_fetch_body` writes into a loader cell.
  - Detected by: Task 4 test 6, and the `single_roundtrip` release stress (0 plan cells left).
- **BOUND binding.** Heap transfers decline under an ambiguous binding. Bun test files that register two workers of one server on one thread would see 500 for bodies over 256 KiB.
  - Detected by: `actions-napi.test.ts` registers one worker per server (keep it so).
  - If a test needs two, challenge R2 (explicit worker id).
- **External ArrayBuffer under Bun.** `Uint8Array::new(Vec)` may fall back to a copy (napi-rs handles `napi_no_external_buffers_allowed`). That is correct either way.
  - Breaks if the body handed to `new Request` is detached or zeroed after GC.
  - Detected by: the 8 × 1 MiB concurrent byte-equal echo in Task 8. Run it ×5 before READY.
- **Memory.** In-flight memory is bounded by slots × (max_body + max_response), about 72 MiB per slot at the caps; the default is about 9 MiB per slot. This is documented in §9. No test.
- **Deadline mid-transfer.** A call past `call_timeout` keeps its claim until JS settles (`pool.rs` drop invariant), so a late `putFetchReply` lands in a cell that is dropped with the claim. The deadline test at `tests/actions.rs:425` must stay green.
- **Fast path regression.** Detected by: Task 7 case 6 (byte-equal slot bytes), `fetch_request_json_is_pinned` and the unchanged `decode_fetch_frame_table`.
- **Stale addon.** After every Rust edit, run `bun run build:debug` before any `bun test`, or JS tests run the old binary.

## 8. Reporting

- READY: `conclave task note 838f12fb-70c1-41b7-acf2-d4065cf6bb64 beta1-f82-large-bodies "READY @<sha> …"`. The note must contain:
  - the final branch sha;
  - pass counts before and after for each Task 1 command;
  - the `single_roundtrip` release line;
  - `git apply --check bench/attribution.patch` exit 0;
  - the empty `git diff beta1 -- pool.rs pipeline.rs brust-napi/src/dispatch.rs single_roundtrip.rs bench/` output;
  - the ×5 result of the concurrent heap echo;
  - which R1-R8 alternatives, if any, were forced by the code.
- Escalate with `conclave task challenge 838f12fb-70c1-41b7-acf2-d4065cf6bb64 beta1-f82-large-bodies "<what, evidence, proposed change>"` when:
  - any boundary file outside section 3 is needed;
  - `attribution.patch` stops applying;
  - napi-rs or Bun rejects the `Uint8Array` return or argument shape;
  - a ruling turns out to be unimplementable as ruled.
