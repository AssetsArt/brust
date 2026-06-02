# Static asset gzip compression (Rust)

> **Status:** design · 2026-06-03 · branch `feat/static-compression` (off main, independent of the store work)

## Goal

The brust server serves `/_brust/islands/*`, `/_brust/css/*`, and root-mapped
`public/*` **uncompressed**. The production-minified `_react-dom.js` is ~185 KB on
the wire (verified: `Content-Length: 184663`, no `Content-Encoding`). Gzip would cut
it to ~50–55 KB. The build already minifies (`runtime/islands/build.ts` →
`minify: true`, `NODE_ENV=production`); the missing piece is **HTTP transfer
compression**.

Add gzip content-negotiated compression for static asset responses.

## Decisions (locked in brainstorm)

- **Algorithm:** gzip only (v1), via `flate2`. Universal browser support, good ratio.
  Brotli deferred.
- **Strategy:** on-the-fly compression + in-memory cache. No build-pipeline change;
  works in every run mode (dev / source / prebuilt).
- **Scope:** static assets only (islands, css, public). Dynamic SSR HTML / SAB
  fast-lane / chunked streaming / action responses are **out of scope** (compressing
  the hot per-request render path is a separate, riskier change).

## Non-goals (loud)

- **No brotli, deflate, or zstd.** gzip only.
- **No compression of dynamic responses** — the SAB fast-lane, chunked React
  streaming, action dispatch, and SSE paths are untouched.
- **No build-pipeline change.** `brust build` and `runtime/islands/build.ts` are not
  modified; no `.gz` sidecar files.
- **No new request-parsing stack.** Reuse the existing `httparse`-based
  `parse_header_value`.
- **No change to minification** (already done) or to the static-wins routing order.

## High-level architecture

```
request → server.rs static branch (islands / css / public)
   read file bytes (disk, as today)  +  content_type  +  dev flag
        │
        ▼
   compress::negotiate(accept_encoding, content_type, bytes.len())
        │ accepts gzip?  &&  is_compressible(ct)?  &&  len >= MIN_SIZE (1024)?
        ├── no  → identity: build_response(…, encoding = None)
        └── yes → body = compress::gzip_cached(path, bytes, dev)
                  build_response(…, encoding = Some("gzip"))   + Vary: Accept-Encoding
```

### New module `crates/brust/src/compress.rs`

```rust
/// True if the client's Accept-Encoding offers gzip with a non-zero q-value.
/// `None`/absent header → false. "gzip;q=0" → false. "br, gzip" → true.
pub fn accepts_gzip(accept_encoding: Option<&str>) -> bool;

/// Allowlist of compressible content types (prefix/exact match):
/// text/*, application/javascript, application/json, application/xml,
/// image/svg+xml. Everything else (image/png, image/jpeg, font/woff2,
/// application/gzip, …) → false.
pub fn is_compressible(content_type: &str) -> bool;

/// gzip the bytes (flate2 GzEncoder, level 6). Returns None if the compressed
/// output is not smaller than the input (incompressible) — caller serves identity.
pub fn gzip(bytes: &[u8]) -> Option<Vec<u8>>;

/// Production: memoize the gzipped bytes per asset path (assets are immutable
/// within a server run). Dev: compress fresh every call (no cache) so a
/// hot-reloaded asset is never served stale. Returns None → serve identity.
pub fn gzip_cached(path: &str, bytes: &[u8], dev: bool) -> Option<Arc<Vec<u8>>>;
```

- `MIN_SIZE: usize = 1024`. Files below this skip compression (header overhead +
  per-request work outweigh the saving).
- **Cache:** a process-global `moka::sync::Cache<String, Arc<Vec<u8>>>` (moka is
  already a dependency), bounded (e.g. `max_capacity(512)` — there are only a handful
  of island/css assets). Key = the asset's absolute path string. Populated lazily on
  first compressible hit. **Dev bypasses the cache** (`if dev { gzip(bytes).map(Arc::new) }`)
  so hot-reloaded edits never serve a stale compressed body; dev traffic is low and
  already `Cache-Control: no-store`. Prod assets are immutable for the process
  lifetime, so a path key needs no mtime.

### Integration — `crates/brust/src/server.rs`

Three static branches (islands ≈ 273–310, css ≈ 314–345, public ≈ 352–367). At each,
after the file bytes are read and `content_type` + `dev` are known:

1. Read the request's Accept-Encoding via `parse_header_value(&buf, "accept-encoding")`.
   NOTE (spec-review correction): `header_end` is a LOCAL computed only inside the
   action/sse/ws branches — it is NOT in scope at the static branches. The
   function-level `buf` (server.rs:210) IS in scope; `parse_header_value` runs
   `httparse` and stops at the header terminator itself, so passing the whole `&buf`
   is correct (slicing to `header_end` is only an optimization).
2. `let (body, enc): (Cow/Arc bytes, Option<&str>) = match compress::gzip_cached(...)`
   gated by `accepts_gzip && is_compressible && len >= MIN_SIZE`.
3. Pass `enc` to `http::build_response`.

### `crates/brust/src/http.rs` — NO signature change (use `extra_headers`)

Spec-review finding: `build_response` already takes an `extra_headers` Vec and writes
through every header except content-type/content-length/connection (http.rs:62-65),
and sets `Content-Length = body.len()`. So compression needs **no change to
`build_response`'s signature** (which has 11 callers + 4 unit tests). The static
branches simply:

- pass the **compressed bytes** as the body → `Content-Length` is automatically the
  compressed length.
- push `("Content-Encoding", "gzip")` and `("Vary", "Accept-Encoding")` into the
  `extra_headers` Vec they already build for `Cache-Control`.

When the response is identity, push only `("Vary", "Accept-Encoding")` (correct shared-
cache keying) and no `Content-Encoding`. Non-static callers are byte-for-byte unchanged.

## Behavior / invariants

1. **Correctness:** the gzipped body, when decoded, byte-equals the original asset.
2. **Negotiation:** no `gzip` in Accept-Encoding (or `gzip;q=0`, or header absent) →
   identity response, no `Content-Encoding`, body unchanged.
3. **Type gating:** only allowlisted content types compress; png/jpeg/woff2/gz served
   identity (already compressed — gzip would waste CPU and可能 enlarge).
4. **Size gating:** assets `< 1024` bytes served identity.
5. **No-larger guarantee:** if gzip output ≥ input, serve identity (the `gzip` fn
   returns `None`).
6. **Cache headers preserved:** existing `Cache-Control` (prod `max-age=3600`, dev
   `no-store`) is unchanged; `Content-Length` always matches the bytes actually sent;
   `Vary: Accept-Encoding` added.
7. **Dev freshness:** a hot-reloaded asset is never served from a stale compressed
   cache (dev bypasses the cache).
8. **Scope fence:** dynamic/SSR/action/SSE responses are byte-for-byte unchanged.

## File structure

```
crates/brust/src/compress.rs   # accepts_gzip, is_compressible, gzip, gzip_cached + #[cfg(test)] (new)
crates/brust/src/server.rs     # 3 static branches: negotiate + push Content-Encoding/Vary into extra_headers (edit)
crates/brust/src/lib.rs        # `mod compress;` (edit)  — http.rs NOT touched (use existing extra_headers)
crates/brust/Cargo.toml        # + flate2 = "1" (edit)
tests/static-compression.test.ts  # integration (new)
```

## Tests

**Rust unit (`compress.rs` `#[cfg(test)]`):**
- `accepts_gzip`: `Some("gzip")`→true; `Some("gzip, br")`/`Some("br, gzip")`→true;
  `Some("gzip;q=0")`→false; `Some("identity")`→false; `Some("br")`→false; `None`→false.
- `is_compressible`: `text/css`, `application/javascript; charset=utf-8`,
  `image/svg+xml`, `application/json`→true; `image/png`, `font/woff2`,
  `application/gzip`→false.
- `gzip`: round-trip (flate2 decode == input) for a JS-like buffer; returns `None`
  for tiny/incompressible input where output ≥ input.

**Integration (`tests/static-compression.test.ts` — boots the server; rebuild the
addon first):**
- `GET /_brust/islands/_react-dom.js` with `Accept-Encoding: gzip` → `200`,
  `Content-Encoding: gzip`, `Vary: Accept-Encoding`, body gunzips to the on-disk file,
  `Content-Length` == compressed length < raw length.
- same path **without** `Accept-Encoding` → `200`, no `Content-Encoding`, raw bytes.
- a `public/*` PNG (or any image) with `Accept-Encoding: gzip` → no `Content-Encoding`
  (type not compressible). (Use an existing fixture asset; if none, a small svg
  compresses and a tiny file stays identity — assert at least the type/size gating.)
- `Cache-Control` unchanged on the compressed response.

## Acceptance criteria

- `bun run ci` (biome) clean — TS lint gate.
- **Rust CI mirror** (cf. memory `release-mirror-ci-gates`): `cargo fmt --check`,
  `cargo clippy --all-targets --locked -D warnings`, `cargo test` (incl. the new
  `compress` unit tests) — all green.
- Addon rebuilt (`cd runtime && bun run build:debug`) before the integration test
  (cf. memory `stale-napi-node-after-compiler-change`); integration test green.
- Existing `bun test runtime/` + `bun test tests/` suites still green (no regression).
- Manual smoke: `curl -H 'Accept-Encoding: gzip' …/_react-dom.js` shows
  `Content-Encoding: gzip` and a transfer size ≈ a third of 185 KB.

## Known limitations (intentional)

- gzip only (no brotli) — brotli's ~15–20 % extra is a follow-up.
- Static assets only — dynamic SSR HTML is not compressed (separate change with
  perf implications on the render hot path).
- Compression level fixed at 6 (balanced); not tunable in v1.
- No `.gz` precompression sidecars; first prod request for each asset pays the
  one-time compression cost, then it's cached for the process lifetime.

## Open questions — resolved by spec review (2026-06-03)

1. **Read Accept-Encoding:** call `parse_header_value(&buf, "accept-encoding")` at each
   static branch (`buf` is in scope; `header_end` is NOT — it's local to other
   branches). Verified.
2. **`build_response`:** NO signature change. Thread `Content-Encoding`/`Vary` through
   the existing `extra_headers` Vec (it passes through all non-reserved headers).
   Verified: 11 callers + 4 tests stay untouched.
3. **`dev` flag:** use `crate::is_dev_mode()` (global atomic, available everywhere) —
   there is no local `dev` binding at the static branches. Verified.
4. **`is_compressible` must substring/prefix-match** — content types carry a
   `; charset=utf-8` suffix (e.g. `text/css; charset=utf-8`), so exact `==` fails.
