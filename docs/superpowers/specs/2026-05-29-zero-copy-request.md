# Zero-Copy Request Envelope + SAB Input

## Goal
Eliminate the severe performance regression on paths crossing the NAPI boundary (e.g., POST actions, React SSR) by removing eager `HashMap` allocations in Rust and avoiding `String` passage across the `tsfn` boundary.

## Non-goals
- Full zero-copy binary decoding in V8 (we will still serialize to JSON, but write the bytes directly to SAB).
- Eliminating `JSON.parse()` on the JS side (V8's `JSON.parse` is highly optimized for flat byte buffers).

## High-level architecture
Currently, Rust eagerly builds 3 `HashMap<String, String>` (headers, cookies, search) per request, serializes the envelope to a `String`, and passes it across NAPI via `tsfn.call_async(envelope_json: String)`. V8 receives the `String` (which causes a cross-boundary string copy) and parses it.

The optimized flow:
1. **Zero-copy `RequestEnvelope`**: In `crates/brust/src/routes.rs`, change `RequestEnvelope` fields to `Vec<(&str, Cow<str>)>` (or similar zero-copy structures). Rust parses headers, cookies, and search params into flat vectors without allocating `HashMap`s or multiple `String`s.
2. **SAB for Input**: Instead of `tsfn.call_async(String)`, Rust will serialize the zero-copy envelope into JSON bytes *directly* into the worker's `SharedArrayBuffer` (SAB) at offset 0.
3. **u32 `tsfn` payload**: Change `RendererTsfn` type signature to pass `u32` (the byte length of the JSON envelope written to the SAB) instead of `String`.
4. **JS side decoding**: In `runtime/routes.ts`, `makeRenderer` signature changes from `(envelopeJson: string) => Promise<void>` to `(envelopeLen: number) => Promise<void>`. It reads `envelopeLen` bytes from `view`, decodes via `TextDecoder`, and calls `JSON.parse`.
5. **Lazy Maps in JS**: The TS `RouteEnvelope` will define `headers`, `cookies`, and `search` as flat arrays (e.g., `[string, string][]`). `BrustRequest` (or the middleware chain) will construct Maps or object dictionaries lazily only if accessed.

## File structure
- `crates/brust/src/routes.rs`: Update `RequestEnvelope`, `ActionEnvelope`, etc., to use lifetimes and flat arrays. Modify `build_request_envelope` to return zero-copy vectors.
- `crates/brust/src/pool.rs`: Change `RendererTsfn` definition to `ThreadsafeFunction<u32, Promise<()>, u32, napi::Status, false>`. Update `WorkerPool::try_claim_render` to write `serde_json::to_writer` directly into the `buf_ptr` slice before calling `tsfn.call_async(len)`.
- `crates/brust/src/server.rs`: Adjust callers that build envelopes to pass `buf_ptr` or just serialize into it. Wait: `handle_conn` matches the path and builds the envelope *before* claiming a worker. If we write to the worker SAB, we can only serialize *after* claiming the worker! So `match_path` should return a struct or closure that allows serializing into the SAB after the worker is claimed.
- `crates/brust/src/lib.rs`: Update `register_renderer` signature to `Function<u32, Promise<()>>`.
- `runtime/index.ts` & `runtime/routes.ts`: Update `makeRenderer` and `BrustRequest` types.

## Behavior/concurrency invariants
- **SAB strict alternation**: The SAB slot is exclusively owned by the active render. Rust writes the request to SAB at offset 0. JS reads it synchronously upon `tsfn` callback wake. JS then writes the response (or streaming chunks) to the SAB. The request bytes are overwritten, which is safe because JS has already parsed them.
- **Envelope size limit**: The JSON serialized envelope must not exceed the 256 KB SAB size. If it does, `try_claim_render` or the serializer must return a 413 Payload Too Large (or similar).

## Acceptance criteria
- `bun run bench` shows a significant RPS increase for `POST /_brust/action/createNote` (e.g., from ~47k RPS to >75k RPS).
- `GET /` SSR RPS improves.
- All integration tests pass (`bun test tests/`).
- Rust unit tests pass (`cargo test --lib`).

## Open questions resolved at plan-time
- **How does `match_path` defer serialization?** Currently `match_path` returns `MatchResult::Matched { route_id, envelope_json: String }`. We will change it to return an un-serialized `RouteEnvelope` or a closure. Then `handle_conn` claims the worker, gets the `buf_ptr`, and serializes the envelope into `&mut [u8]` via `serde_json::to_writer`.
