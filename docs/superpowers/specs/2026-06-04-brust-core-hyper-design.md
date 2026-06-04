# brust-core extraction + hyper migration — Design Spec

- **Date:** 2026-06-04
- **Status:** approved (design locked, autonomous pipeline)
- **Scope:** single PR, no staging. Commit locally, do **not** push.

## Goal

1. Extract a new pure-Rust library crate `brust-core` (no `napi` dependency) holding the HTTP server, routing, caching, render orchestration, realtime (SSE/WS), and templating. Give it a clean module folder structure.
2. Reduce the existing `crates/brust` cdylib to a thin napi binding: `#[napi]` exports, the worker-dispatch seam implementation, and the jsx-compiler binding.
3. Replace the hand-rolled `httparse` transport/protocol layer with **hyper 1.x + hyper-util** (`auto::Builder` → HTTP/1.1 **and** HTTP/2 per connection), plus **tokio-rustls** for optional in-process TLS termination.
4. Drop `io_uring`: delete the `tokio-uring` fork dependency and the `src/io/{mod,linux,other}.rs` abstraction; run on a **multi-thread tokio** runtime. This fixes the container seccomp ENOSYS panic (memory `linux-io-uring-seccomp`).
5. Consolidate the response cache onto **moka** only; drop the `lru` crate dependency.

All five land in one PR.

## Non-goals (explicitly deferred)

- No change to the JS/TS `#[napi]` public API surface (function names, signatures, camelCase keys preserved — memory `napi-object-camelcase-keys`).
- No change to the Bun worker render protocol (SAB fast-lane / chunk-channel envelope semantics in `pool.rs` docstring stay identical).
- No new TLS cert-management/ACME tooling; TLS acceptor consumes a cert+key path from config, nothing more. TLS wiring is implemented but may be feature-gated/off by default.
- No HTTP/3 / QUIC.
- No change to `jsx-rust-compiler` crate.
- No router/middleware framework (axum/tower) — `RouteTable` (matchit) + `ActionRouter` stay as-is.
- No performance tuning pass; multi-thread tokio is expected to help the napi-crossing floor (memory `napi-crossing-floor`) but benchmarking is out of scope for this PR.

## High-level architecture

```
crates/
  brust-core/     NEW  pure-Rust lib  (crate-type = ["lib"])
  brust/          cdylib napi binding; depends on brust-core
  jsx-rust-compiler/   unchanged
```

`brust` (cdylib) → depends on → `brust-core`. The render path crosses the napi
boundary through a single trait (`RenderDispatch`), never through `napi` types
inside core.

### The seam (napi ↔ core)

The real napi coupling is two Bun-specific primitives:

1. **tsfn call** — `RendererTsfn::call_async(Either<u32, String>) -> Promise<u32>`
   (envelope: `A(u32)` = SAB framed-response length, `B(String)` = inline JSON).
2. **SAB pointer** — `BufPtr(*mut u8)` + capacity, read after the call resolves.

Everything else in `pool.rs` (claim/wait, in-flight counting, idle CAS gate,
`RenderChunk`/`RenderSlot` over tokio oneshot/mpsc, `RenderClaim` RAII) is pure
tokio/std and moves into core unchanged.

Core defines:

```rust
// brust-core::render::dispatch
pub enum RenderEnvelope {
    /// Worker staged a framed response in its SAB; u32 = byte length.
    Sab(u32),
    /// Inline JSON envelope (SSE/WS dispatch path).
    Inline(String),
}

#[derive(Debug)]
pub enum RenderError {
    /// Dispatch could not be enqueued to the worker (tsfn closed/aborted).
    EnqueueFailed(String),
    /// The worker's render promise rejected.
    PromiseRejected(String),
}

/// One render worker's Bun-side primitives. Implemented by the napi crate.
pub trait RenderDispatch: Send + Sync + 'static {
    /// Invoke the JS renderer; resolve with the framed-response length (u32).
    fn call(
        &self,
        envelope: RenderEnvelope,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<u32, RenderError>> + Send>>;

    /// Raw pointer + capacity of this worker's SAB staging buffer.
    /// SAFETY contract documented at the trait: valid for the worker's lifetime;
    /// only read by core AFTER `call` resolves (happens-before via the await).
    fn buf_ptr(&self) -> *mut u8;
    fn buf_len(&self) -> usize;
}
```

`TsfnEntry` in core changes from `{ tsfn: Option<RendererTsfn>, buf_ptr, buf_len }`
to `{ dispatch: Box<dyn RenderDispatch> }` (plus the existing pure fields:
`id`, `in_flight`, `idle`, `render_slot`). The `Option`/`register_for_test`
affordance is replaced by a core test-only `MockDispatch` implementing
`RenderDispatch` (no napi symbols needed in `cargo test`).

The napi crate provides:

```rust
// brust (cdylib)::dispatch_impl
struct TsfnDispatch { tsfn: RendererTsfn, buf_ptr: BufPtr, buf_len: usize }
impl brust_core::RenderDispatch for TsfnDispatch { /* map RenderEnvelope→Either, RenderError */ }
```

`napi_register_worker` builds the tsfn + reads the SAB pointer, wraps in
`TsfnDispatch`, and calls `pool.register(Box::new(dispatch))`.

The SAB-read sites that live in core (`server.rs` 1290/1495/1610/1667 reading the
framed response) go through `entry.dispatch.buf_ptr()/buf_len()`. The SAB sites in
`lib.rs` (`napi_render_chunk`, `napi_sse_write`, etc.) stay in the binding crate
and read their own `TsfnDispatch` buffer.

## File structure

### `crates/brust-core/src/`

```
lib.rs                  crate root, pub re-exports of the public core API
config.rs               AppState/ServerConfig (pure): dirs, dev_mode, action_prefix, tuning
server/
  mod.rs                serve() entry, accept loop, hyper auto::Builder wiring, runtime
  conn.rs               per-request service: route → cache → dispatch → stream (was handle_conn)
  tls.rs                tokio-rustls acceptor (config-driven; optional)
  static_assets.rs      static file + public-asset serving (extracted from server.rs)
http/
  response.rs           canned/framed responses (was http.rs)
  compress.rs           gzip + moka compression cache (was compress.rs)
routing/
  routes.rs             RouteTable (matchit) (was routes.rs)
  action.rs             ActionRouter (was action_router.rs)
cache/
  response_cache.rs     ResponseCache on moka (was cache.rs::LruCache; renamed)
  island_cache.rs       CacheStore + MokaStore (was island_cache.rs)
render/
  dispatch.rs           RenderDispatch trait + RenderEnvelope + RenderError (THE seam)
  pool.rs               WorkerPool / TsfnEntry / RenderClaim (was pool.rs, napi stripped)
  stream.rs             RenderChunk framing / chunk loop helpers (was render_stream.rs)
realtime/
  sse.rs                SSE registry + framing (was sse.rs)
  ws.rs                 WS handshake/driver (was ws.rs; upgrade via hyper)
template/
  jinja.rs              minijinja env (was jinja.rs)
```

### `crates/brust/src/` (cdylib napi binding)

```
lib.rs                  #[napi] exports, State wiring, calls brust_core::serve(...)
dispatch_impl.rs        TsfnDispatch (RendererTsfn + BufPtr) impl brust_core::RenderDispatch
jsx_compile.rs          #[napi] jsx-rust-compiler binding (unchanged)
```

`LruCache` is renamed to `ResponseCache` repo-wide (use `astedit rename`). The
`/_brust/cache/stats` route and `CacheStats` shape are preserved.

## Cache consolidation (lru → moka)

`ResponseCache` (was `LruCache`) is reimplemented on `moka::sync::Cache<CacheKey, CachedEntry>`:

- **Capacity:** `max_capacity(CACHE_CAPACITY)` (1000), unchanged default.
- **Per-entry TTL:** moka's cache-wide `time_to_live` is **insufficient** — each
  `CacheConfig` carries its own `ttl_seconds`. Use moka's **`Expiry` trait**
  (`expire_after_create` returning the entry's `ttl`) so per-entry TTL is honored
  natively. `CachedEntry` keeps `ttl`; `inserted_at`/`is_expired()` are removed
  (moka owns expiration). `get()` no longer hand-checks expiry.
- **Hits/misses:** keep the manual `AtomicU64` counters (moka's own stats are not
  wired); increment in `get()`.
- **`invalidate_path(method, path)`:** moka has no snapshot-iter under lock like
  `lru`. Use `invalidate_entries_if(predicate)` (requires moka `sync` predicate
  support) matching `k.method == method && k.path == path`. Note: moka
  `invalidate_entries_if` is **asynchronous** (applied on the next maintenance
  tick / `run_pending_tasks`). The route returns a best-effort count; call
  `run_pending_tasks()` before reading `entry_count()` where a synchronous view
  is needed. **This is a behavior-visible change from `lru`'s immediate removal —
  call it out in the PR.** All four existing `cache.rs` unit tests must be ported
  and pass (adjusting for moka's eventual-invalidation where the test asserts
  post-invalidate state — insert a `run_pending_tasks()` in the test).
- **`resize`:** moka `Cache` capacity is fixed at build; expose resize via
  rebuild-or-`policy().set_max_capacity` if available in the pinned moka version,
  else document as a known limitation (the `resize` caller is the tuning setter).
- **`clear`:** `invalidate_all()` + `run_pending_tasks()`; return prior `entry_count`.
- Drop `lru` from `crates/brust/Cargo.toml` (now `brust-core/Cargo.toml`).

## hyper wiring

- `crates/brust-core/Cargo.toml` adds: `hyper` (features `http1`, `http2`,
  `server`), `hyper-util` (`tokio`, `server-auto`, `server-graceful`), `http-body-util`,
  `tokio` (multi-thread `rt-multi-thread`, `net`, `io-util`, `macros`, `signal`,
  `sync`, `time`, `fs`), `tokio-rustls` + `rustls` + `rustls-pemfile` (TLS).
- `server/mod.rs::serve()`:
  - Build a `tokio::runtime::Builder::new_multi_thread()` runtime on the dedicated
    server OS thread (replaces `run_io`'s current-thread / uring start).
  - `tokio::net::TcpListener::bind`, accept loop. Per accepted stream: optionally
    wrap with the rustls acceptor (`server/tls.rs`), then
    `hyper_util::server::conn::auto::Builder::new(TokioExecutor).serve_connection_with_upgrades(io, service)`.
  - `service` = `service_fn` closure → `conn.rs::handle_request(req, state)` returning
    `Response<BoxBody>`.
- `conn.rs`: port the routing/decision logic from `handle_conn`. hyper owns
  parsing/keep-alive/chunked. Request method/path/headers come from `http::Request`.
  Streaming responses (React Suspense chunk channel, SSE) use
  `http_body_util::StreamBody` / channel body fed by the worker chunk loop.
- **WebSocket:** replace manual `s.into_inner()` + `from_raw_socket` with
  `hyper::upgrade::on(req)`; wrap the `Upgraded` in `hyper_util::rt::TokioIo` (which is
  `AsyncRead+AsyncWrite+Unpin`) and hand to
  `tokio_tungstenite::WebSocketStream::from_raw_socket`. The handshake validation in
  `ws.rs::parse_handshake` is unchanged; the 101 response is returned via hyper's
  upgrade mechanism. Delete the `SseIo`/`into_inner` platform abstraction.
- **SSE:** the per-conn SSE task writes through the response body stream instead of
  the raw socket; the `SseIo` trait is removed (hyper body handles the socket).

## Behavior / concurrency invariants (must hold)

- napi public API unchanged: every existing `#[napi]` fn keeps name + signature +
  camelCase object keys.
- Worker render protocol unchanged: fast-lane (`u32 > 0` → SAB framed response) and
  chunk-channel (`0` → streamed via `napi_render_chunk`) behave identically.
- `RenderClaim` RAII still frees the worker + fires `idle_notify` on drop (panic /
  cancel / early-return safe).
- Cache invalidation semantics: documented eventual-vs-immediate change is the only
  intended behavior delta.
- XSS escaping (memory `brust-jinja-autoescape-none`) untouched — jinja module moves
  verbatim.
- Multi-thread runtime: render-dispatch futures are now `Send`. Verify nothing in the
  moved code relied on `!Send` single-thread affinity (the only reason was uring `Rc`,
  now gone).

## Tests

- All existing unit tests move with their modules and pass (`cargo test -p brust-core`
  + `cargo test -p brust`). Cache tests adapted for moka eventual invalidation.
- New: `MockDispatch` in `brust-core` exercising `WorkerPool` claim/dispatch without napi.
- New: hyper integration smoke (in `brust-core` tests or a small harness) — bind an
  ephemeral port, serve a fixed handler, assert HTTP/1.1 GET + an HTTP/2 (h2c) GET both
  return 200. WS upgrade round-trip if feasible in-crate.
- TS/Bun suites unchanged and green: `bun run ci` (biome — memory
  `brust-ts-ci-gates-biome-not-cargo`), the integration + cli-build suites
  (run files separately — memory `native-island-integration-flake`).
- Linux io_uring seccomp test/assumption (memory `linux-io-uring-seccomp`) is now moot;
  remove or repurpose any uring-specific guard.

## Acceptance criteria

1. `cargo build --workspace` green; `crates/brust-core` has **zero** `napi`/`napi-derive`
   dependency (verify: `cargo tree -p brust-core | grep -i napi` is empty).
2. `lru` no longer in the dependency tree (`cargo tree | grep -i '^.*lru'` empty);
   response cache runs on moka.
3. No `tokio-uring` / `io_uring` references remain; `src/io/` deleted.
4. `cargo test --workspace` green (incl. ported cache tests + MockDispatch + hyper smoke).
5. Release-mirror gates green (memory `release-mirror-ci-gates`): `cargo fmt --check`,
   `cargo clippy --all-targets --locked -D warnings`.
6. `bun run ci` green; integration + cli-build suites green (run separately).
7. Runtime smoke: `brust build` + boot a scaffold app, `curl` a page (200, correct
   body), a native route, an SSE endpoint, a WS upgrade — all work over HTTP/1.1.
   Rebuild the `.node` after Rust changes (memory `stale-napi-node-after-compiler-change`).
8. Every change committed locally; **nothing pushed**.

## Known limitations / call-outs

- Cache `invalidate_path`/`clear` become eventually-consistent (moka maintenance tick)
  vs `lru`'s immediate removal. Mitigated with `run_pending_tasks()` where a sync view
  is required.
- `ResponseCache::resize` semantics depend on the pinned moka version's capability;
  may degrade to a documented no-op-with-warning if `set_max_capacity` is unavailable.
- TLS is wired but cert management is out of scope; default deployment remains
  HTTP/1.1 plaintext behind a reverse proxy unless TLS config is provided.
- Linux React-SSR slow path (memory `linux-react-ssr-perf`) is unaffected and not
  addressed here.

## Open questions resolved at plan-time

- Exact pinned versions of hyper/hyper-util/rustls/moka (latest compatible).
- Whether `WorkerPool` uses `Box<dyn RenderDispatch>` (chosen — avoids generic spread)
  vs generic `WorkerPool<D>` (rejected: propagates through State).
- Whether TLS is feature-gated (`features = ["tls"]`) or always-compiled-off-by-config
  (lean: always compiled, off by default via config — simpler build matrix).
