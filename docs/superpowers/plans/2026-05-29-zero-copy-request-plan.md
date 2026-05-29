# Zero-Copy Request Envelope Implementation Plan

## Spec Fixes Applied
1. **SSE/WS Dual-Payload**: `RendererTsfn` changed to `ThreadsafeFunction<napi::bindgen_prelude::Either<u32, String>, ...>`. Render and action pass `Left(len)`, while SSE, WS, and MCP pass `Right(envelope_json)`.
2. **Navigation Rewrite**: `match_path` returns an unserialized `RouteEnvelope` instead of a JSON string. `server.rs` mutates `envelope.kind` safely before serializing it.
3. **Testability**: Update `pool.rs` `register_for_test` to allocate a dummy buffer `vec![0u8; 256 * 1024].into_boxed_slice()` and use `Box::into_raw` to prevent segfaults during testing.
4. **Size Limit Enforcement**: `try_claim_render` wraps the SAB slice in `std::io::Cursor` and handles capacity errors gracefully.

## Tasks

### Task 1: Update Envelopes to Zero-Copy Types
- **File**: `crates/brust/src/routes.rs`
- **Action**: Change `RequestEnvelope`, `RouteEnvelope`, and `ActionEnvelope` to use `&'a str` and `Cow<'a, str>` instead of `String` and `HashMap`. `headers`, `cookies`, and `search` become `Vec<(&'a str, Cow<'a, str>)>`.
- **Action**: Update `build_request_envelope` to return `RequestEnvelope` without allocating `HashMap`s.
- **Action**: Update `match_path` to return a new `MatchResult<'a>` that contains the unserialized `RouteEnvelope<'a>` instead of a JSON string.

### Task 2: Dual Payload Tsfn
- **File**: `crates/brust/src/pool.rs` & `crates/brust/src/lib.rs`
- **Action**: Change `RendererTsfn` to `ThreadsafeFunction<napi::bindgen_prelude::Either<u32, String>, Promise<()>, napi::bindgen_prelude::Either<u32, String>, napi::Status, false>`.
- **Action**: Update `register_for_test` to leak a dummy buffer (`Box::into_raw(vec![0u8; 256*1024].into_boxed_slice())`).
- **Action**: Update `dispatch_sse` and `dispatch_ws` to pass `Right(envelope_json)`.

### Task 3: SAB Serialization in `server.rs`
- **File**: `crates/brust/src/server.rs`
- **Action**: Update `handle_conn` to receive the struct from `match_path`.
- **Action**: Claim the worker `try_claim_render()`. Then use `std::io::Cursor::new(slice::from_raw_parts_mut(...))` to serialize the struct using `serde_json::to_writer`.
- **Action**: Pass `Left(len as u32)` to `tsfn.call_async`.
- **Action**: Do the same for `action` dispatch. If serialization overflows the Cursor, log it and return 413.

### Task 4: JS-Side Lazy Parsing and Decoding
- **File**: `runtime/routes.ts` & `runtime/index.ts`
- **Action**: Update `RouteCall`, `RequestEnvelope` to expect arrays of tuples for headers/cookies.
- **Action**: Update `makeRenderer` signature to `(payload: number | string) => Promise<void>`.
- **Action**: If `payload` is `number`, decode from `view.subarray(0, payload)` using `TextDecoder`. If `string`, parse directly.
- **Action**: Update `composeChain` or `BrustRequest` to provide lazy getters for `.cookies` and `.headers` (converting the flat array into a Map/Object on demand).

### Task 5: Fallback & Review
- **BLOCKED Fallback**: If `napi::bindgen_prelude::Either` is not available or causes compilation issues, fallback to `ThreadsafeFunction<String>` and pass the length as a string (e.g. `len.to_string()`), parsing `parseInt(payload)` on JS side.
- Run `bun test tests/` and `cargo test --lib`.
