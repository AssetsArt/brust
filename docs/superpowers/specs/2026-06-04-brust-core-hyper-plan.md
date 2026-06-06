# brust-core + hyper — Implementation Plan

Spec: `2026-06-04-brust-core-hyper-design.md`. Single PR, branch
`feat/brust-core-hyper`. Commit each task locally; **never push**.

## Ordering principle

Each task ends in a **compiling, test-green** state. The risky seam + cache
changes happen **in-place in the existing `brust` crate first** (so failures are
isolated from the physical crate split), then the crate is split, then the
transport is swapped, then TLS. Order:

1. Cache → moka (in-place)
2. RenderDispatch seam (in-place)
3. Drop io_uring → tokio multi-thread (in-place, still hand-rolled server)
4. Physically extract `brust-core` crate (mechanical module move)
5. Swap hand-rolled server → hyper
6. TLS acceptor (tokio-rustls)

Build/test commands (memory-informed):
- Rust unit: `cargo test -p brust` (pre-split) / `cargo test --workspace` (post-split)
- Rust gates: `cargo fmt --check` + `cargo clippy --all-targets --locked -D warnings`
  (memory `release-mirror-ci-gates`)
- After any Rust compiler/runtime change, rebuild the addon:
  `cd runtime && bun run build` (memory `stale-napi-node-after-compiler-change`)
- TS gate: `bun run ci` (biome — memory `brust-ts-ci-gates-biome-not-cargo`)
- Integration + cli-build run **separately** (memory `native-island-integration-flake`)

NOTE for implementers: do NOT `git add -A` (memory `brust-ts-ci-gates...`: it once
swept untracked `tools/` into a commit). Stage explicit paths.

---

## Task 1 — Response cache: lru → moka (in-place)

**Files:** `crates/brust/src/cache.rs`, `crates/brust/Cargo.toml`, plus rename
`LruCache` → `ResponseCache` repo-wide.

**TDD:** the four existing tests in `cache.rs` (≈144-212) are the spec. Adapt two
for moka eventual invalidation, keep all four green.

Steps:
1. `crates/brust/Cargo.toml`: remove `lru = "0.18"`. `moka` already present
   (`features = ["sync"]`).
2. Rewrite `cache.rs`:
   - `CachedEntry`: drop `inserted_at`; keep `response_bytes` + `ttl`. Remove
     `is_expired()`.
   - Add `struct ResponseExpiry;` impl `moka::Expiry<CacheKey, CachedEntry>`:
     ```rust
     impl moka::Expiry<CacheKey, CachedEntry> for ResponseExpiry {
         fn expire_after_create(&self, _k: &CacheKey, v: &CachedEntry, _now: std::time::Instant) -> Option<Duration> {
             Some(v.ttl)
         }
     }
     ```
   - `ResponseCache` (renamed from `LruCache`): field
     `inner: moka::sync::Cache<CacheKey, CachedEntry>`, `hits`/`misses` AtomicU64.
     Build:
     ```rust
     moka::sync::Cache::builder()
         .max_capacity(CACHE_CAPACITY as u64)
         .support_invalidation_closures()
         .expire_after(ResponseExpiry)
         .build()
     ```
   - `get`: `inner.get(key)` → Some → hit + clone bytes; None → miss. (moka handles
     expiry; no manual check.)
   - `insert(key, bytes, ttl)`: `inner.insert(key, CachedEntry { response_bytes: bytes, ttl })`.
   - `stats`: `len: inner.entry_count() as usize`, `capacity: CACHE_CAPACITY`.
   - `invalidate_path(method, path)`: snapshot intent → 
     `let _ = inner.invalidate_entries_if(move |k, _| k.method == method && k.path == path);`
     (log+swallow Err). Return a best-effort count: since moka invalidation is
     async, return the pre-invalidation match count by iterating `inner.iter()`
     filtered (iter is allowed on moka sync), OR return 0 and document. **Decision:**
     count via `inner.iter().filter(...).count()` BEFORE issuing the predicate (the
     route only logs the count). Then `run_pending_tasks()`.
   - `resize(_max)`: log `warn!("ResponseCache::resize is a no-op on moka")`. No-op.
   - `clear`: `let n = inner.entry_count() as usize; inner.invalidate_all(); inner.run_pending_tasks(); n`.
3. Tests: in `invalidate_path_removes_only_matching_entries` and
   `clear_removes_all_entries_and_returns_count`, add `c.inner.run_pending_tasks()`
   after the mutating call. (Expose a `#[cfg(test)] fn run_pending(&self)` if `inner`
   is private.) Keep the hits/misses-preserved test as-is.
4. `astedit rename LruCache ResponseCache --apply` (catches lib.rs `State.cache`,
   server.rs, route stats). Verify `rg -n "LruCache" crates/` is empty.

**Verify:** `cargo test -p brust` green; `cargo clippy --all-targets --locked -D warnings`
green; `cargo tree -p brust | grep -i '\blru\b'` empty.

**Commit:** `refactor(cache): response cache on moka, drop lru`

**BLOCKED fallback:** if `invalidate_entries_if` count semantics fight the tests,
return `0` from `invalidate_path` and weaken the two assertions to "entry absent
after `run_pending_tasks`" (presence is what matters; the count is only logged).

---

## Task 2 — RenderDispatch seam (in-place, still one crate)

**Files:** new `crates/brust/src/render/mod.rs` + `render/dispatch.rs`; modify
`pool.rs`, `server.rs`, `lib.rs`. Goal: remove every `napi::` reference from the
modules that will become core, replacing with the `RenderDispatch` trait. The
napi impl (`TsfnDispatch`) stays in `brust`.

**TDD:** add `MockDispatch` + a `WorkerPool` claim/dispatch test that exercises a
render without napi symbols.

Steps:
1. `render/dispatch.rs`: define `RenderEnvelope { Sab(u32), Inline(String) }`,
   `RenderError { EnqueueFailed(String), PromiseRejected(String) }` (derive
   `Debug`; impl `Display` + `std::error::Error`), and
   ```rust
   pub trait RenderDispatch: Send + Sync + 'static {
       fn call(&self, env: RenderEnvelope)
           -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<u32, RenderError>> + Send>>;
       fn buf_ptr(&self) -> *mut u8;
       fn buf_len(&self) -> usize;
   }
   ```
2. `pool.rs`:
   - `TsfnEntry`: replace `tsfn: Option<RendererTsfn>`, `buf_ptr`, `buf_len` with
     `dispatch: Box<dyn RenderDispatch>`. Keep `id`, `in_flight`, `idle`, `render_slot`.
   - `register(...)` takes `Box<dyn RenderDispatch>` instead of `(tsfn, buf_ptr, buf_len)`.
   - **Delete** `dispatch_sse`/`dispatch_ws` (they return `napi::Error`); their logic
     moves to call sites (step 4).
   - Delete `RendererTsfn`, `BufPtr` from pool.rs (they move to `brust`'s
     `dispatch_impl.rs` in Task 4; for now define them there or keep a temporary
     `mod tsfn` — simplest: move `RendererTsfn`/`BufPtr` to a new
     `crates/brust/src/dispatch_impl.rs` now, with `TsfnDispatch`).
   - `register_for_test` → delete; tests use `MockDispatch`.
   - Add `#[cfg(test)] MockDispatch` (in pool.rs tests or dispatch.rs): owns a
     `Box::leak(vec![0u8; 256*1024])` buffer, `call` returns `ready(Ok(0))`.
3. `dispatch_impl.rs` (new, in `brust`): move `RendererTsfn` type + `BufPtr` here;
   define `struct TsfnDispatch { tsfn: RendererTsfn, buf_ptr: BufPtr, buf_len: usize }`
   impl `RenderDispatch` (map `Sab(n)→Either::A(n)`, `Inline(s)→Either::B(s)`; map
   `napi::Error` → `RenderError::{EnqueueFailed,PromiseRejected}` matching the old
   `RenderOutcome` arms; `buf_ptr/buf_len` return the fields).
4. `server.rs`:
   - `RenderOutcome` variants carry `RenderError`, not `napi::Error`.
   - The two `entry.tsfn.as_ref().expect(..).call_async(Either::A(envelope_len))`
     sites → `entry.dispatch.call(RenderEnvelope::Sab(envelope_len)).await`.
   - SAB reads `entry.buf_ptr.0` → `entry.dispatch.buf_ptr()`; `entry.buf_len` →
     `entry.dispatch.buf_len()`.
   - SSE/WS dispatch call sites (≈840/979, were `pool.dispatch_sse/ws`) →
     `entry.dispatch.call(RenderEnvelope::Inline(json)).await.map(|_| ())`.
5. `lib.rs`: `napi_register_worker` builds `TsfnDispatch` and calls
   `pool.register(Box::new(dispatch))`. SAB reads in napi fns (`napi_render_chunk`
   etc.) read through their own `TsfnDispatch` via `entry.dispatch.buf_ptr()`
   (add a downcast-free accessor, or keep those reads using `dispatch.buf_ptr()`
   since the trait exposes it).

**Verify:** `cargo test -p brust` green (incl. new MockDispatch pool test);
`rg -n "napi" crates/brust/src/{pool,server,routes,render_stream,sse,ws,cache,island_cache,compress,http,jinja,action_router}.rs`
shows only comment/docstring mentions (no `use napi`/`napi::`/`#[napi]`);
clippy green. Rebuild addon `cd runtime && bun run build`; `bun run ci` green.

**Commit:** `refactor(render): RenderDispatch seam decouples core from napi`

**BLOCKED fallback:** if `Box<dyn RenderDispatch>` Send/Sync fights the tsfn (it
shouldn't — `ThreadsafeFunction` is Send+Sync), wrap as
`Arc<dyn RenderDispatch>`; if the future's Send bound fights tsfn's `call_async`
return, box via `async move { ... }.boxed()` from `futures::FutureExt`.

---

## Task 3 — Drop io_uring → tokio multi-thread (in-place)

**Files:** delete `crates/brust/src/io/linux.rs`; collapse `io/mod.rs` + `io/other.rs`
into a single tokio impl (or inline `tokio::net` directly); `Cargo.toml`; `server.rs`
`run_io`/`spawn` call sites; `lib.rs` `IO_NAME`.

Steps:
1. `Cargo.toml`: delete the `[target.'cfg(target_os = "linux")']` block
   (`tokio-uring` + the linux tokio feature set). Single `tokio` dep with
   `features = ["rt-multi-thread", "net", "io-util", "macros", "signal", "sync", "time", "fs"]`.
2. Delete `io/linux.rs`. Replace `io/mod.rs` so `TcpListener`/`TcpStream`/`run_io`/
   `spawn`/`IO_NAME`/`SseIo` all resolve to the tokio impl (former `other.rs`),
   with the `#[cfg]` gates removed. `run_io` builds a
   `tokio::runtime::Builder::new_multi_thread().enable_all().build()` runtime.
   `spawn` = `tokio::spawn` (now requires `F: Send` — fine, futures are Send once
   uring `Rc` is gone).
3. Fix any `IO_NAME` reference (`"tokio"`).

**Verify:** `cargo test -p brust` green on this (mac) host; clippy green; rebuild
addon; boot a scaffold app and `curl` a page (200). `rg -n "uring|io_uring|tokio-uring"`
empty. This already resolves the container seccomp issue (memory `linux-io-uring-seccomp`).

**Commit:** `refactor(io): drop io_uring, run on tokio multi-thread runtime`

**BLOCKED fallback:** if a moved future is unexpectedly `!Send` (some `Rc`/`RefCell`
the spec-review scan missed), identify it via the compiler error and either make it
`Send` (Arc/Mutex) or, if isolated to one task, use `tokio::task::spawn_local` on a
`LocalSet` for just that task — but record it as a finding (contradicts spec
invariant "only uring forced !Send").

---

## Task 4 — Extract `brust-core` crate (mechanical move)

**Files:** new `crates/brust-core/` (Cargo.toml + src tree per spec §"File structure");
workspace `Cargo.toml`; move modules out of `crates/brust/src/`.

Steps:
1. Workspace `Cargo.toml`: add `"crates/brust-core"` to members.
2. `crates/brust-core/Cargo.toml`: `crate-type = ["lib"]`, edition 2024. Deps that
   the moved modules need: `tokio` (same features minus none), `parking_lot`,
   `thiserror`, `tracing`, `once_cell`, `matchit`, `serde`, `serde_json`, `moka`,
   `flate2`, `base64`, `tokio-tungstenite`, `sha1`, `futures`, `bytes`, `minijinja`,
   `httparse` (still used by hand-rolled server until Task 5), `jsx-rust-compiler`
   (path). **No `napi`/`napi-derive`/`lru`/`tokio-uring`.**
3. Move files into the spec's folder structure:
   - `jinja.rs`→`template/jinja.rs`; `compress.rs`→`http/compress.rs`;
     `http.rs`→`http/response.rs`; `cache.rs`→`cache/response_cache.rs`;
     `island_cache.rs`→`cache/island_cache.rs`; `action_router.rs`→`routing/action.rs`;
     `routes.rs`→`routing/routes.rs`; `pool.rs`→`render/pool.rs`;
     `render/dispatch.rs` stays; `render_stream.rs`→`render/stream.rs`;
     `sse.rs`→`realtime/sse.rs`; `ws.rs`→`realtime/ws.rs`; `server.rs`→`server/mod.rs`
     (+ split static-asset helpers into `server/static_assets.rs`); `io/mod.rs`→
     `server/` inline (tokio transport) for now.
   - Extract the pure parts of `lib.rs::State` into `config.rs` as `AppState`
     (everything except napi-built fields). The `STATE` OnceCell + `#[napi]` fns
     stay in `brust`; core exposes `pub fn serve(addr, app_state: Arc<AppState>, ...)`.
   - Create `mod.rs` files for each subdir re-exporting their modules; `lib.rs`
     re-exports the public API (`serve`, `AppState`, `RenderDispatch`, `RenderEnvelope`,
     `RenderError`, `WorkerPool`, route/cache types the binding needs).
4. `crates/brust/Cargo.toml`: add `brust-core = { path = "../brust-core" }`.
5. `crates/brust/src/lib.rs`: replace `mod X;` with `use brust_core::...`. Keep
   `#[napi]` fns; they call `brust_core::serve(...)` and build `AppState`. Keep
   `dispatch_impl.rs`, `jsx_compile.rs`. Fix all `crate::` → `brust_core::` paths.
6. Move tests with their modules. Adjust `super::`/`crate::` paths.

**Verify:** `cargo build --workspace` green; `cargo test --workspace` green;
**`cargo tree -p brust-core | grep -iE 'napi|lru|uring'` EMPTY** (acceptance #1-3);
clippy `--workspace --all-targets --locked -D warnings` green; rebuild addon;
`bun run ci` green; integration + cli-build suites (run separately) green.

**Commit:** `refactor: extract brust-core crate (pure Rust, no napi)`

**BLOCKED fallback:** if visibility/orphan-rule issues block a trait impl (e.g. a
core trait impl'd in `brust` for a `brust` type — that's fine; the reverse is the
risk), keep the impl on the side that owns the trait. If `AppState` extraction
tangles with the `STATE` OnceCell, leave `State` in `brust` and pass `&AppState`
sub-references into `serve` rather than extracting wholesale — record as a follow-up.

---

## Task 5 — Swap hand-rolled server → hyper

**Files:** `crates/brust-core/Cargo.toml` (+hyper deps); `server/mod.rs`,
`server/conn.rs` (new), `realtime/{sse,ws}.rs`; delete the tokio `io` transport
shim + `SseIo` + manual response-byte builders that hyper replaces.

**TDD:** add `crates/brust-core/tests/hyper_smoke.rs`: bind ephemeral port, serve a
fixed handler via the real `serve` wiring (or a minimal harness), assert an
HTTP/1.1 GET returns 200 and an HTTP/2 prior-knowledge (h2c) GET returns 200.

Steps:
1. `Cargo.toml`: add `hyper` (`http1`,`http2`,`server`), `hyper-util`
   (`tokio`,`server-auto`,`server-graceful`), `http-body-util`, `http`. Drop
   `httparse` if no longer referenced.
2. `server/mod.rs::serve`:
   - multi-thread runtime (from Task 3) unchanged.
   - accept loop: `let permit = sem.clone().acquire_owned().await; let (io,_)=listener.accept().await?;`
     then `tokio::spawn(async move { let _permit = permit; let svc = service_fn(move |req| handle_request(req, state.clone())); auto::Builder::new(TokioExecutor::new()).serve_connection_with_upgrades(TokioIo::new(io), svc).await; });`
     `sem = Arc::new(Semaphore::new(conn_queue_cap))`.
3. `server/conn.rs::handle_request(req: Request<Incoming>, state) -> Result<Response<BoxBody<Bytes, io::Error>>, Infallible>`:
   port the `handle_conn` decision tree (method/path gates, static assets, action
   prefix, cache get/set, render dispatch). Bodies:
   - canned/fast-lane `Vec<u8>` → `Full::new(Bytes::from(v)).map_err(|e| match e {}).boxed()`.
   - streaming → `mpsc::channel`, spawn the worker chunk loop feeding it, body =
     `StreamBody::new(ReceiverStream::new(rx).map(|b| Ok::<_,io::Error>(Frame::data(b)))).boxed()`.
4. WS in `conn.rs` (3-step per spec): validate (`ws::parse_handshake`) →
   `hyper::upgrade::on(&mut req)` → return 101 response with accept headers →
   spawned task awaits upgrade, `TokioIo::new(upgraded)` →
   `WebSocketStream::from_raw_socket(.., Role::Server, None)` → existing `ws` driver.
5. SSE: `sse_conn_task` drops `S: SseIo`, takes the mpsc `Sender`; delete `SseIo`
   trait + the tokio transport shim.
6. Delete dead manual response-byte head builders superseded by hyper (keep the
   ones still used for body content, e.g. framed meta prefix).

**Verify:** `cargo test --workspace` green (incl. hyper_smoke H1+H2); clippy green;
rebuild addon; **runtime smoke (acceptance #7):** `brust build` a scaffold, boot,
`curl` a page, a native route, an SSE endpoint, and a WS upgrade — all work.
`bun run ci` + integration + cli-build green.

**Commit:** `feat(server): serve over hyper (HTTP/1.1 + HTTP/2), drop hand-rolled parser`

**BLOCKED fallback:** if `serve_connection_with_upgrades` + streaming-body
backpressure misbehaves for Suspense streaming, fall back to `http1`/`http2`
explicit builders per-connection (peek first bytes for the H2 preface) — but try
`auto` first. If WS upgrade headers fight hyper, compute `Sec-WebSocket-Accept`
manually (sha1 of key+GUID, base64) as the current code already does in `ws.rs`.

---

## Task 6 — TLS acceptor (tokio-rustls)

**Files:** `crates/brust-core/Cargo.toml` (+rustls); `server/tls.rs` (new);
`server/mod.rs` (wire acceptor); `config.rs` (TLS config fields).

Steps:
1. `Cargo.toml`: add `tokio-rustls`, `rustls`, `rustls-pemfile`.
2. `config.rs`: `AppState` gains optional `tls: Option<TlsConfig { cert_path, key_path }>`.
3. `server/tls.rs`: load cert+key (`rustls_pemfile`), build `ServerConfig`
   (`with_no_client_auth`, ALPN `h2`,`http/1.1`), return `TlsAcceptor`.
4. `server/mod.rs`: if `state.tls.is_some()`, `acceptor.accept(io).await?` before
   `TokioIo::new` + `serve_connection_with_upgrades`. ALPN lets `auto` negotiate H2.
   Off by default (no TLS config → plaintext, unchanged).

**Verify:** `cargo build --workspace` + clippy green. Optional: a `tests/tls_smoke`
with a self-signed cert asserting an HTTPS GET 200 + ALPN `h2` (skip if cert
generation is heavy — document). `bun run ci` green.

**Commit:** `feat(server): optional in-process TLS termination (tokio-rustls, ALPN h2)`

**BLOCKED fallback:** if ALPN/H2-over-TLS negotiation is flaky, ship TLS with
HTTP/1.1-only ALPN and note H2-over-TLS as a follow-up (h2c still works plaintext).

---

## Spec-coverage table

| Spec section | Task(s) |
|---|---|
| Goal 1 — extract brust-core | 4 |
| Goal 2 — thin napi binding | 2 (seam), 4 (split) |
| Goal 3 — hyper H1/H2 | 5 |
| Goal 3 — TLS | 6 |
| Goal 4 — drop io_uring / multi-thread | 3 |
| Goal 5 — cache → moka, drop lru | 1 |
| Seam (RenderDispatch / RenderEnvelope / RenderError) | 2 |
| dispatch_sse/ws + RenderOutcome rewrite | 2 |
| moka Expiry + support_invalidation_closures + eventual invalidation | 1 |
| File structure (folders) | 4 |
| WS upgrade via hyper | 5 |
| SSE via body channel, delete SseIo | 5 |
| BoxBody (Full/StreamBody) | 5 |
| Accept model (spawn + Semaphore, flume dropped) | 5 |
| MockDispatch tests | 2 |
| hyper smoke test (H1+H2) | 5 |
| Acceptance #1 (no napi in core) | 4 |
| Acceptance #2 (no lru) | 1 |
| Acceptance #3 (no uring, io/ deleted) | 3 (uring), 5 (io shim) |
| Acceptance #4 (cargo test workspace) | every task |
| Acceptance #5 (fmt+clippy) | every task |
| Acceptance #6 (bun run ci + suites) | every task touching addon |
| Acceptance #7 (runtime smoke) | 5 |
| Acceptance #8 (commit, no push) | every task |

## Pre-flight type-consistency check

- `RenderDispatch::call` return: `Pin<Box<dyn Future<Output=Result<u32, RenderError>> + Send>>` — used by both `Sab` (server.rs) and `Inline` (sse/ws) paths. ✓
- `BoxBody<Bytes, std::io::Error>` consistent across canned + streaming. ✓
- `ResponseExpiry: moka::Expiry<CacheKey, CachedEntry>` returns `Some(v.ttl)`. ✓
- `WorkerPool` holds `Box<dyn RenderDispatch>` (no generic on `AppState`). ✓
