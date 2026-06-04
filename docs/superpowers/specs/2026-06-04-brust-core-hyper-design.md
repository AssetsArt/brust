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

The rest of `pool.rs` (claim/wait, in-flight counting, idle CAS gate,
`RenderChunk`/`RenderSlot` over tokio oneshot/mpsc, `RenderClaim` RAII) is pure
tokio/std and moves into core unchanged.

**Two functions are NOT pure and must be rewritten (not moved):**

- `pool.rs::dispatch_sse` and `pool.rs::dispatch_ws` (≈ lines 316/338) call
  `entry.tsfn.call_async(Either::B(json))` directly and return
  `Result<(), napi::Error>`. They are **deleted from `pool.rs`**. Their callers
  (`server.rs` ≈ 840/979) instead call
  `entry.dispatch.call(RenderEnvelope::Inline(json)).await.map(|_| ())` and match
  `Err(RenderError)`. The resolved `u32` is discarded as today.
- `server.rs::dispatch_to_worker_and_stream_chunks` / `dispatch_single_chunk`
  contain an inline `RenderOutcome { EnqueueFailed(napi::Error), PromiseRejected(napi::Error) }`
  enum (≈ 1277-1279) and two direct `entry.tsfn.call_async(Either::A(envelope_len))`
  sites (≈ 1310/1628). These move to `server/conn.rs`; `RenderOutcome` is
  rewritten to carry **`RenderError`** (not `napi::Error`) and the call sites
  become `entry.dispatch.call(RenderEnvelope::Sab(envelope_len)).await`. The
  `tracing::error!(error = %e)` sites work because `RenderError` impls `Display`
  (the `String` payload). **These were the only `napi::` references in the
  soon-to-be-core code; after this rewrite `brust-core` has zero `napi` deps.**

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
`RenderDispatch` (no napi symbols needed in `cargo test`). `MockDispatch` owns the
leaked fake SAB allocation that `register_for_test` currently does
(`Box::leak(vec![0u8; 256*1024])`), returned from its `buf_ptr()/buf_len()`.

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

- **Builder:** `Cache::builder().max_capacity(CACHE_CAPACITY)` (1000, unchanged
  default) **`.support_invalidation_closures()`** (REQUIRED — without it
  `invalidate_entries_if` returns `Err(PredicateError::InvalidationClosuresDisabled)`
  at runtime, silently breaking every `invalidate_path` call) `.expire_after(ResponseExpiry)`.
- **Per-entry TTL:** moka's cache-wide `time_to_live` is **insufficient** — each
  `CacheConfig` carries its own `ttl_seconds`. Implement
  `moka::Expiry<CacheKey, CachedEntry>` (call it `ResponseExpiry`) whose
  `expire_after_create(&self, _k, value, _created) -> Option<Duration>` returns
  `Some(value.ttl)`. `CachedEntry` keeps `ttl`; `inserted_at`/`is_expired()` are
  removed (moka owns expiration). `get()` no longer hand-checks expiry.
- **Hits/misses:** keep the manual `AtomicU64` counters (moka's own stats are not
  wired); increment in `get()`.
- **`invalidate_path(method, path)`:** moka has no snapshot-iter under lock like
  `lru`. Use `invalidate_entries_if(|k, _v| k.method == method && k.path == path)`,
  which returns `Result<PredicateId, PredicateError>` — log+swallow the `Err`
  (only fires if `support_invalidation_closures()` was omitted, which it is not).
  moka `invalidate_entries_if` is **asynchronous** (applied on the next maintenance
  tick / `run_pending_tasks`). The route returns a best-effort count; call
  `run_pending_tasks()` before reading `entry_count()` where a synchronous view
  is needed. **This is a behavior-visible change from `lru`'s immediate removal —
  call it out in the PR.** All four existing `cache.rs` unit tests must be ported
  and pass; the two that assert post-invalidate state
  (`invalidate_path_removes_only_matching_entries`, `clear_removes_all_entries`)
  get a `cache.run_pending_tasks()` after the invalidate/clear and before the
  assertions.
- **`resize`:** moka 0.12 `Cache` capacity is fixed at build (no live
  `set_max_capacity` on `Cache`/`Policy`). **Decision: `resize` becomes a
  documented no-op that logs a `warn!`** rather than a conditional. The only caller
  is the tuning setter; capacity stays at the build-time default.
- **`clear`:** read `entry_count()` FIRST (prior count, matching `lru`'s
  `removed = guard.len()`), then `invalidate_all()` + `run_pending_tasks()`;
  return the saved prior count.
- Drop `lru` from the dependency tree (it moves nowhere — `brust-core/Cargo.toml`
  uses only `moka`).

## hyper wiring

- `crates/brust-core/Cargo.toml` adds (pin minors at plan-time to what the
  workspace resolves — currently `hyper` 1.8.x, `hyper-util` 0.1.20): `hyper`
  (features `http1`, `http2`, `server`), `hyper-util` (`tokio`, `server-auto`,
  `server-graceful`), `http-body-util` (for `Full`/`StreamBody`/`BoxBody`), `http`,
  `tokio` (`rt-multi-thread`, `net`, `io-util`, `macros`, `signal`, `sync`, `time`,
  `fs`), `tokio-rustls` + `rustls` + `rustls-pemfile` (TLS). **`flume` is dropped**
  (see accept-model note below).
- **Body type:** the service returns `Response<BoxBody<Bytes, std::io::Error>>`.
  - Fast-lane / canned responses (raw `Vec<u8>`): wrap as
    `Full::new(Bytes::from(vec)).map_err(|e| match e {}).boxed()`.
  - Streaming (React Suspense chunk channel, SSE): a `tokio::sync::mpsc` channel
    fed by the worker chunk loop, wrapped as
    `StreamBody::new(ReceiverStream::new(rx).map(|b| Ok(Frame::data(b)))).boxed()`.
    The existing `RenderChunk` ack handshake drives the sender.
- `server/mod.rs::serve()`:
  - Build a `tokio::runtime::Builder::new_multi_thread()` runtime on the dedicated
    server OS thread (replaces `run_io`'s current-thread / uring start).
  - `tokio::net::TcpListener::bind`, accept loop. **Accept model change:** the old
    `flume` bounded queue → N conn-worker tasks is replaced by hyper's per-connection
    model: each accepted stream is `tokio::spawn`-ed directly. Render backpressure
    is unchanged — it lives in `WorkerPool::claim_or_wait` (the pool gate), NOT the
    accept queue. **Accept-level backpressure (the old `conn_queue_cap`) is dropped;**
    if a bound is still wanted, gate spawns behind a `tokio::sync::Semaphore` sized
    to `conn_queue_cap`. Decision: keep a `Semaphore` to preserve the tunable's
    meaning. Per accepted stream: optionally wrap with the rustls acceptor
    (`server/tls.rs`), then
    `auto::Builder::new(TokioExecutor::new()).serve_connection_with_upgrades(TokioIo::new(io), service)`.
  - `service` = `service_fn` closure → `conn.rs::handle_request(req, state)`.
- `conn.rs`: port the routing/decision logic from `handle_conn`. hyper owns
  parsing/keep-alive/chunked. Method/path/headers come from `http::Request<Incoming>`;
  request body via `http_body_util::BodyExt::collect` for sized POST/action bodies.
- **WebSocket** (upgrade is a 3-step departure from the write-then-wrap pattern):
  1. validate via the unchanged `ws.rs::parse_handshake`, then call
     `hyper::upgrade::on(&mut req)` to get the `OnUpgrade` future BEFORE responding.
  2. return a `101 Switching Protocols` `Response` (empty body) with the computed
     `Sec-WebSocket-Accept` / chosen subprotocol headers — hyper performs the upgrade.
  3. in a spawned task, `let upgraded = on_upgrade.await?;` wrap in
     `hyper_util::rt::TokioIo::new(upgraded)` (→ `AsyncRead+AsyncWrite+Unpin`) and
     hand to `tokio_tungstenite::WebSocketStream::from_raw_socket(.., Role::Server, None)`.
     The existing `ws.rs` driver loop runs unchanged on that stream.
- **SSE:** the per-conn SSE task pushes frames into the streaming-body `mpsc` sender
  (type above) instead of writing the raw socket. `sse_conn_task`'s `S: SseIo`
  generic is removed; it takes the channel sender. The `SseIo` trait and the whole
  `src/io/{mod,linux,other}.rs` platform abstraction (incl. `into_inner`) are deleted.

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
- `ResponseCache::resize` is a documented no-op (logs `warn!`) — moka 0.12 `Cache`
  capacity is fixed at build. The tuning setter that called it no longer resizes.
- Accept-level backpressure changes from a flume bounded queue to a
  `tokio::sync::Semaphore` sized to `conn_queue_cap`; render backpressure
  (`WorkerPool::claim_or_wait`) is unchanged.
- TLS is wired but cert management is out of scope; default deployment remains
  HTTP/1.1 plaintext behind a reverse proxy unless TLS config is provided.
- Linux React-SSR slow path (memory `linux-react-ssr-perf`) is unaffected and not
  addressed here.

## Open questions resolved at plan-time

- Exact pinned versions of hyper/hyper-util/rustls/moka (latest compatible; the
  workspace currently resolves hyper 1.8.x, hyper-util 0.1.20).
- `WorkerPool` uses `Box<dyn RenderDispatch>` (chosen — avoids generic spread vs
  generic `WorkerPool<D>` which propagates through State).
- TLS is always-compiled, off by default via config (simpler build matrix than a
  `["tls"]` feature gate).
- Response body is `BoxBody<Bytes, std::io::Error>`; fast-lane → `Full`, streaming/SSE
  → `StreamBody` over a tokio mpsc channel (resolved above).
- Accept model: direct `tokio::spawn` per connection + `Semaphore(conn_queue_cap)`,
  flume dropped (resolved above).
- WS upgrade: `hyper::upgrade::on` → 101 response → spawned task wraps `TokioIo`
  into `from_raw_socket` (resolved above).
