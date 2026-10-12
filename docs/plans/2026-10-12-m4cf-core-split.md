# m4cf-core-split: extract the host-agnostic `brust-core` crate (static `Host` generic); `brust-server` becomes the native host with an unchanged API
**RULED by lead Detoro 2026-10-12 (before dispatch): R1-R11 ALL ACCEPTED as their defaults — R1 RPITIT without a Send bound + the compile-time Send probe on the spawned future (fallback `trait_variant`, a task challenge if the probe fails); R2 moka L1/job cache stay in brust-server behind the core traits, stamp internals `doc(hidden) pub`; R3 `Stats` moves unchanged + a test pinning the `/_brust/cache/stats` JSON; R4 one `gzip` feature on by default, no `fs` feature, `Manifest::load` stays in core (orphan rule); R5 `Manifest::from_parts` deferred to lane 3; R6 `publish = false`; R7 benches/render.rs unedited, `--no-run` checked; R8 `doc(hidden) pub` for server-only needs; R9 the seven §4 deviations are accepted and the lane amends spec §4 with a dated note listing them; R10 boundary += `.github/workflows/ci.yml` (clippy `-p brust-core`, `cargo tree` no-tokio/hyper/moka/crossbeam step); R11 `perf.rs` into core with a server re-export, attribution.patch regenerated in-lane (reset before checkout after `--3way`). EXTRA acceptance: the log-target assumption ([I]) is verified — run `tests/logging.rs` and one boot with `RUST_LOG=brust=info` proving `brust_core::*` lines still pass the default filter; if they do not, keep explicit `target:` strings in the moved modules. Human rule: NO bench on the main host — perf is argued in code in the READY note and measured on the remote host by Illenium when the lead schedules it (bar ≤ 3% on S/D/I, two runs). Test-name baseline + no-removed-assert checks are mandatory gates of this lane.**
owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: m4cf · lane: m4cf-core-split · tier: complex · review: complex
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Lane M4-CF-1 of `docs/design/2026-10-12-m4-cloudflare-workers-design.md`. Read the header (rulings R1-R14; R1 = this lane), §0-§4 and §9 first. §3's move/stay table and §4's `Host`/`PageCache`/`JobStore`/`Clock` are the contract; R10 lists the deltas this plan proposes. Implementer: Dew (built F86/F89 read stamps and knows `pipeline.rs`). Every `path:line` below is verified at `m4cf` @0f0a136. Re-anchor on the quoted text if the base moved.

## Facts the plan rests on
- `crates/brust-server/src/lib.rs:1-34` is the whole public surface. Public modules: `cache`, `config`, `dispatch`, `http`, `inputs`, `manifest`, `pool`, `protocol`, `render`, `routing`, `server`, and `bench` (doc-hidden). Root re-exports are at `:26-34`. `actions` and `pipeline` are private.
- `brust-napi` uses exactly these `brust_server` items:
  - `server.rs:19-23`: `ActionsConfig, Config, CorsConfig, CrossSite, DEFAULT_ACTION_PREFIX, DEFAULT_MAX_ACTION_BODY_BYTES, DEFAULT_MAX_ACTION_RESPONSE_BYTES, InvalidateArgs, Server, Tuning, start`.
  - `:251-252` `plan_in_call`, `PLAN_DECLINED`; `:262` `take_fetch_body`; `:271` `put_fetch_reply`; `dispatch.rs:16` `CallKind, DispatchError, RenderDispatch`.
  - `Server` methods: `register_worker` `:233`, `request_drain` + `wait_drain_done` `:297-298`, `invalidate` `:319` (`InvalidateResult.{l1_removed,job_removed}`), `stats` `:334` (serialised with serde), `local_addr` `:341`.
  - `Config` is built field by field at `:186-197` with `..Config::default()`. `Arc<Server>`/`Weak<Server>` are held in statics (`:27,38`), so `Server: Send + Sync` is load-bearing.
- `Server` (`config.rs:251-299`) mixes core state with native state:
  - core state: routes, manifest, plans, renderer, l1, jobs, clock, counters, `missing_slots`, cors, `cors_resolved`, generator, actions, `action_prefix_tag`, `render_hints`, `plan_offer`;
  - native state: `pool`, `dist_dir`, `claim_timeout`, `call_timeout`, `ready`, `expected_workers`, `drain_*`, `local_addr`, `tls`.
  - It is built only in `server/mod.rs:109-171` (`start`). `plan_cells_in_use` (doc-hidden, used by 6 test files) is at `server/mod.rs:86-100`.
- Pipeline couplings to the native side:
  - `pipeline.rs:73` `handle(Request<Incoming>, Arc<Server>)`; `:135` `Instant` (log `dur_ms`, asserted to exist by `tests/logging.rs:59`); `:159-166` `head_only` (BoxBody size hint);
  - `:223-284` `inside_root` + `static_file` (tokio::fs, `static_asset_response` → moka `GZIP_CACHE` `http/compress.rs:24`);
  - `:370-383` loader `call_worker_planned`, which seeds `Box<PlanCell::Seed>` and downcasts the cell after the call (`:397`, `:460-463`); `:525-532` jobs `call_worker`.
  - Everything else in `:286-2318` is pure over `Server` fields.
  - `plan_in_call` `:1902-1942` reads the SAB slot (native). `plan_response` `:1857-1899` is pure, except that it takes `&JobCache`.
- Pipeline tests (`:2321-3324`): `plan_response_*` ×4 (`:3105-3219`) build a `JobCache`; `plan_in_call_*` ×2 (`:3257-3324`) boot a `Server` with `MockDispatch`. Every other test is pure. The fixtures are read from `CARGO_MANIFEST_DIR` (`:2527`, `:2546`).
- Actions:
  - `actions.rs:66-196` `handle` = admission + `read_capped` (`:266`, hyper body + tokio timeout) + `FetchRequest` build + `call_worker_fetch` + `response_from_fetch` (`:329`);
  - pure helpers: `cross_site_verdict` `:200`, `request_host` `:236`, `ambiguous_path` `:245`, `encode_body` `:285`, `b64` `:304`;
  - `take_fetch_body`/`put_fetch_reply` (`:22-61`) read `pool` + `FetchCell` (native).
- The response chokepoint `server/mod.rs:330-356` applies insert-if-absent `x-powered-by` and then `cors_resolved.stamp_response`. `powered_by` is built at `:260-272`. The spawn site is `:327`.
- `server/body.rs`:
  - `:28` `ResponseBody = BoxBody<Bytes, io::Error>`; `:134` `resp_with` boxes `Full` once. That allocation is the one the native adapter must keep, no more.
  - Pure builders: `:67-170` (`is_framing_header`, `resp`, `header_map`, `resp_with`, `resp_head`) and `:232-290` (`error_*`).
- Caches:
  - `cache/l1.rs`: `CacheKey` `:51`, `RenderedBody` `:62`, `StripedCounter` `:120-145` (pub(crate)), `CacheStats` `:192`, `build_cache_key`/`sort_query` `:676-696`.
  - `cache/job_cache.rs:38` `JobKey`.
  - `cache/stamp.rs` (36 lines): `ReadStamp(pub(crate) u64)`, `InvalClock::next` pub(crate), `INVAL_SLOTS`/`inval_slots` pub(crate); `since.0` is read at `l1.rs:453` and `job_cache.rs:298`.
  - Cache API that core needs: `L1Cache::{with_clock :339, get_with :396, read_stamp :436, insert :464, stats :536, invalidate_path :558, invalidate_tags :595}` and `JobCache::{with_clock :203, get :251, read_stamp :286, insert :309, invalidate_tags :390, invalidate_user_key :396, stats :440}`.
- `benches/render.rs:51-56,306,329-330,409` imports `brust_server::{bench::*, cache::l1::*, cache::job_cache::JobCache, manifest::Manifest, render::*, protocol::LoaderResponse, routing::*}` and calls `Planned::{lookup, warm}(&JobCache)` (`pipeline.rs:2209,2220`).
- `.github/workflows/ci.yml:37` clippy lists 5 crates. `bench/attribution.patch` (693 lines) patches `Cargo.lock`, `brust-server/{Cargo.toml,src/{dispatch,lib,perf(new),pipeline,render,server/mod}.rs}` and `packages/brust/src/worker.ts`. `perf.rs` needs `libc` + `parking_lot`.
- Untargeted `tracing` events in moved code change target `brust_server::*` → `brust_core::*`. The default filter is `brust=info` (`brust-napi/src/lib.rs:27`) and matches by prefix [I]. The explicit targets `brust::{request,cache,actions}` do not change.
- Name collision: code comments citing "brust-core `…` @ d04718f" mean the 0.1.x crate. Leave them as they are.

## Goal
- `crates/brust-core` exists. It is a workspace member with `publish = false`, and it carries §3's "moves" rows: routing, manifest, render, inputs, protocol, key_expr, stamp, CORS, body builders, static path rules, compress (pure part), config types, actions admission/flow, and the pipeline as `Core<H: Host>`.
  - Its normal deps are exactly `brust-jinja, minijinja, serde, serde_json, http, bytes, matchit, percent-encoding, blake3, thiserror, tracing`, plus `flate2` behind `gzip`.
  - `cargo tree -p brust-core -e normal | grep -E 'tokio|hyper|moka|crossbeam'` prints nothing.
- `brust-server` is the native host:
  - `Server { core: Core<NativeHost>, native extras }`;
  - `NativeHost` wraps the pool, `dist_dir` and timeouts;
  - `L1Cache`/`JobCache` stay in brust-server and implement `PageCache`/`JobStore`.
  - Every path that resolved through `brust_server::` before still resolves, pinned by the new `tests/public_api.rs`. `crates/brust-napi` has zero diff and builds.
- `core::handle::<NativeHost>` is monomorphised: no `dyn`, no new `Arc`, the same Box count per response. A compile-time probe at the spawn site asserts the per-request future is `Send`.
- Every existing test passes, with assertions unchanged. Unit tests moved with their code. The multiset of test fn names across `brust-core` + `brust-server` equals the baseline `brust-server` set plus the new tests.
- `bench/attribution.patch` applies (`git apply --check`) and its patched tree compiles, with F83 `READ_UTF8`/`READ_SERDE` kept.
- No bench measurement runs. The READY note carries the code-level perf argument, and the lead schedules S/D/I on the remote host (G2 bar: S 113,744 / D 13,759 / I 104,889 rps, `bench/RESULTS.md:7-28`).

## Rulings requested
**R1 — `Send`.** *Default:*
- `Host` methods are written `fn …(&self, …) -> impl Future<Output = …>`, with no `Send` bound (not `async fn`, which trips `async_fn_in_trait` under `-D warnings`).
- A non-called probe fn in `server/mod.rs` asserts that `crate::pipeline::handle(req, &server)` is `Send`. It is written in T6 and must stay green through T7/T8.
- If T7 hits "implementation of `Send` is not general enough", switch to `#[trait_variant::make(SendHost: Send)]`: `NativeHost` implements `SendHost`, and the trait_variant proc-macro is added as a core dep.

*Alternative:* `trait_variant` from the start, at the cost of one extra dep and macro-generated docs. Boxed `dyn Future` is never an option: it adds one allocation per worker call.

**R2 — caches.** *Default:* `cache/l1.rs` and `cache/job_cache.rs` stay in brust-server (moka/crossbeam/`Instant`) and implement the core traits. Two consequences:
- core exposes `#[doc(hidden)] pub` stamp internals: `ReadStamp(pub u64)`, `InvalClock::next`, `INVAL_SLOTS`, `inval_slots`;
- `StripedCounter` moves to core (std-only), and `CacheKey`, `RenderedBody`, `build_cache_key`, `CacheStats` and `JobKey` move to `brust_core::cache`, re-exported from `l1.rs`/`job_cache.rs`.

*Alternative:* move both caches into core behind `cfg(not(wasm32))`, which drags moka into core.

**R3 — `/_brust/cache/stats` shape.** *Default:* move `Stats` + `CacheStats` verbatim to core (same field order, same derives) and re-export them from `brust_server::config`. A new core test pins the exact JSON string of a `Stats` value, every key in order. `Server::stats()` forwards. *Alternative:* `Stats` stays native and `Core` exposes raw counters, which puts the shape in two places once lane 3 serves stats on Workers.

**R4 — features.** *Default:*
- One feature: `gzip = ["dep:flate2"]`, default-on. brust-server depends with default features.
- With it off, `compress::gzip` returns `None`, so pages are served identity; `accepts_gzip` stays pure.
- No `fs` feature: `Manifest::load` stays an inherent method in core, because orphan rules forbid adding it from brust-server. It uses `std::fs`, which compiles on wasm32-unknown-unknown (runtime `Unsupported`); lane 2 may gate it.

*Alternative:* an `fs` feature now, or a free `brust_server::manifest::load`. The free fn would change `Manifest::load` call sites in `tests/{manifest,render}.rs` and `benches/render.rs`.

**R5 — `Manifest::from_parts`.** *Default:* defer it to M4-CF-3, its first caller, and amend §3's row in T11. `load` interleaves fs checks (`must_exist`, template reads) with reference checks per component (`manifest.rs:359-416`), so splitting them can change which error a multi-fault manifest reports. *Alternative:* add it here, with `load` = reads + `from_parts` + file checks, and accept the reordering.

**R6 — publishing.** *Default:* `publish = false`; internal crate, not on crates.io or npm. `@brust/core` (npm) is unrelated. *Alternative:* none proposed.

**R7 — `benches/render.rs`.** *Default:* it stays in brust-server, unedited, and compiles through re-exports (`Planned::{lookup,warm}` become generic over `JobStore`; `&JobCache` still infers). The gate is `cargo bench -p brust-server --bench render --no-run`, which builds and does not measure. *Alternative:* move it to core, which needs a core `JobStore` impl that does not exist until lane 2.

**R8 — native-seam visibility.** *Default:* items brust-server must reach become `#[doc(hidden)] pub`, with a module doc "native-host seam, not an API". Examples: `Core` fields, `pipeline::{PlanSeed, PlannedCall, PlanCell, plan_response, PlanIndex, collect_jobs, jobs_request, merge_loader_data, Lookup}`, `routes::build_request_envelope`, `body::*`, `static_rules::content_type_for`, `actions::encode_body`. After T8, every one that brust-server no longer reads is narrowed back to `pub(crate)`. *Alternative:* a `native` cargo feature that unlocks them.

**R9 — interface deltas from §4 (lane 1 only).** *Default:*
- (a) `RequestHead` gains `authority: Option<&str>` (actions R8 HTTP/2 host).
- (b) `trait Clock { fn now_ns(&self) -> u64; fn now_ms(&self) -> u64 { self.now_ns() / 1_000_000 } }` with `Host: Clock`, instead of `Host::now_ms`. This keeps `dur_ms` at today's precision.
- (c) `PageCache::with_clock(cap, Arc<InvalClock>)` / `JobStore::with_clock`, so `Core::new` builds the caches.
- (d) `const PLAN_OFFER: bool` on `Host` (native `true`; R4 makes it `false` on Workers).
- (e) `Host::action` returns `FetchResponse` and `Core::handle` returns `http::Response<Bytes>`; `ActionReply::Passthrough`/`Outcome` arrive with lane 3 (no dead variant now).
- (f) `Host::static_file` gets a path already `safe_rel`-checked; core stamps `IMMUTABLE`/`nosniff` after it, as `pipeline.rs:269-283` does.
- (g) `powered_by` is built in `Core::new`, so the invalid-generator `warn!` fires at `start` instead of after bind.

*Alternative:* match §4 literally, which costs the log precision and adds a dead `Passthrough` arm.

**R10 — CI.** *Default:* extend the boundary to `.github/workflows/ci.yml`: add `-p brust-core` to the clippy line `:37`, and add one step `! cargo tree -p brust-core -e normal | grep -E 'tokio|hyper|moka|crossbeam'` after `:35`. *Alternative:* the lead edits CI at merge.

**R11 — attribution layout.** *Default:*
- `perf.rs` moves to `crates/brust-core/src/perf.rs`; the patch adds `libc` + `parking_lot` to brust-core's `Cargo.toml` (patch-only).
- brust-core's `lib.rs` gets `pub mod perf;` and brust-server's gets `pub use brust_core::perf;`, so the native hunks (`dispatch.rs`, `server/mod.rs`, `pipeline.rs::plan_in_call`) keep `crate::perf::…`.
- The revert cleans `crates/brust-core/src/perf.rs`.

*Alternative:* two perf modules, one per crate, with stage ids split; this breaks `attribution.ts`'s single `/_brust/perf` snapshot.

## Boundary
- `crates/brust-core/**` (new)
- `crates/brust-server/src/**`, `crates/brust-server/Cargo.toml`
- `crates/brust-server/tests/public_api.rs` (new). No other file under `crates/brust-server/{tests,benches}` may change; fixtures are read in place.
- `Cargo.toml`, `Cargo.lock`, `bench/attribution.patch`
- `.github/workflows/ci.yml` (R10 only)
- `docs/design/2026-10-12-m4-cloudflare-workers-design.md` (T11 only)
- NOT in the boundary: `crates/brust-napi/**`, `packages/**`, `crates/brust-jinja/**`, the compiler. Anything else goes through `conclave task challenge`.

## Tasks
Every task ends green on: `cargo fmt --all -- --check`, `cargo clippy -p brust-core -p brust-compiler -p brust-compiler-cli -p brust-jinja -p brust-server -p brust-napi --no-deps -- -D warnings` (`-p brust-core` from T2), and `cargo test --workspace --exclude bun_react_compiler`. Rebuild the addon (`cd packages/brust && bun run build:debug`) before any JS test. `OUT=/tmp/m4cf-core-split` (never committed). Commit at the end of each task with a `refactor(core): …` message.

### Task 1 — worktree, baseline
- [ ] `git -C /Users/detoro/code/brust fetch origin m4cf && git -C /Users/detoro/code/brust worktree add /Users/detoro/code/brust-lane-m4cf-core-split -b lane/m4cf-core-split origin/m4cf && cd /Users/detoro/code/brust-lane-m4cf-core-split && git log -1 --format=%h` → `0f0a136` (or the lead's newer m4cf head).
- [ ] `bun install --frozen-lockfile && (cd packages/brust && bun run build:debug)` → exit 0.
- [ ] `mkdir -p $OUT && cargo test --workspace --exclude bun_react_compiler 2>&1 | tee $OUT/t1.txt | grep -c '^test result: ok'`. Note the count; `grep FAILED $OUT/t1.txt` → empty.
- [ ] Name baseline (no doctests): `cargo test -p brust-server --lib --tests -- --list 2>/dev/null | grep ': test$' | sed 's/: test$//; s/.*:://' | sort > $OUT/names-before.txt; wc -l < $OUT/names-before.txt`. Note N.
- [ ] `cargo test -p brust-server --release --test single_roundtrip` → ok. `git apply --check bench/attribution.patch` → exit 0.

### Task 2 — crate skeleton + public-API pin
Files: `Cargo.toml`, `crates/brust-core/{Cargo.toml,src/lib.rs}`, `crates/brust-server/Cargo.toml`, `crates/brust-server/tests/public_api.rs`.
- [ ] **Test first:** create `tests/public_api.rs`:
  - `#![allow(unused_imports)]`;
  - one private `mod` per source path, each with `pub use` of every item below;
  - one empty `#[test] fn public_api_paths_resolve() {}`.

  Items:
  - root: `ACTION_INLINE_BODY_BYTES, ActionsConfig, CallKind, Config, CorsConfig, CrossSite, DEFAULT_ACTION_PREFIX, DEFAULT_MAX_ACTION_BODY_BYTES, DEFAULT_MAX_ACTION_RESPONSE_BYTES, DispatchError, InvalidateArgs, InvalidateResult, MAX_ACTION_BYTES, PLAN_DECLINED, RenderDispatch, Server, Stats, Tuning, plan_in_call, put_fetch_reply, start, take_fetch_body`
  - `bench::{Planned, Planner, cached_body, next_hint, props_view, render_chain_html, render_chain_into}`
  - `cache::job_cache::{JobCache, JobKey}`
  - `cache::key_expr::{EvalCtx, Expr, ParseError}`
  - `cache::l1::{CacheKey, CacheStats, L1Cache, ReadStamp, RenderedBody, build_cache_key}`
  - `cache::stamp::{InvalClock, ReadStamp}`
  - `config::{CacheStats, TlsConfig}`
  - `dispatch::{CallError, FetchCell, call_worker, call_worker_fetch, call_worker_planned, claim_or_wait, decode_fetch_frame}`
  - `http::compress::{accepts_gzip, gzip, is_compressible, maybe_compress}`
  - `inputs::{Path, Projection, PropsMap, Seg, canonical, child_props, job_key, project}`
  - `manifest::{ALL_PROPS, Assets, BypassSpec, ChildRecord, ComponentRecord, Instances, JobCache, JobKind, JobRecord, Loaded, Manifest, ManifestError, RouteCache, RouteRecord, Tier}`
  - `pool::{ClaimResult, PlanBox, RenderClaim, WorkerPool}`
  - `protocol::{FetchBody, FetchMeta, FetchRequest, FetchResponse, JobCall, JobResult, JobsRequest, JobsResponse, LoaderRequest, LoaderResponse, Verdict}`
  - `render::{Overlay, RenderError, Renderer, inject_assets, inject_assets_into, inject_document_assets_into, inject_page_assets_into, store_scripts_into, use_ids}`
  - `routing::{MatchResult, RequestEnvelope, RouteConfig, RouteEnvelope, RouteInstallError, RouteMatch, RouteTable}`
  - `routing::routes::{CompiledCache, Search, decode_search}`
  - `server::coarse_timer::CoarseTimer`
  - `server::tls::{TlsConfig, TlsMinVersion, build_acceptor}`

  Then run `cargo test -p brust-server --test public_api` → `1 passed` on the unmodified tree.
- [ ] Workspace `members` += `"crates/brust-core"`; `[workspace.dependencies]` += `brust-core = { path = "crates/brust-core" }`.
- [ ] `crates/brust-core/Cargo.toml`:
  - name, workspace version/edition/license, `publish = false` (R6);
  - `[features] default = ["gzip"]`, `gzip = ["dep:flate2"]`;
  - deps exactly as in Goal: `tracing = "0.1"`, `http = "1"`, `bytes = "1"`, `matchit = "0.9"`, `percent-encoding = "2.3"`, `blake3 = "1"`, `flate2 = { version = "1", optional = true }`, and the workspace ones;
  - `[lints] workspace = true`.
- [ ] `src/lib.rs`: a `//!` doc (host-agnostic core; `brust-server` = native host; `brust-wasm` = Workers host, later) plus `#![deny(clippy::all)]`. brust-server gets `brust-core.workspace = true`.
- [ ] `! cargo tree -p brust-core -e normal | grep -E 'tokio|hyper|moka|crossbeam'` → exit 0 (no output). Then the three green commands.

### Task 3 — move the pure data modules
Files: `git mv` `crates/brust-server/src/{inputs.rs,manifest.rs,protocol.rs,render.rs,routing/,cache/key_expr.rs,cache/stamp.rs}` → `crates/brust-core/src/…` (same relative paths).
- [ ] **Test first:** the T2 pin plus the name multiset (Acceptance A3) are the tests. Both must hold after this task.
- [ ] Core `lib.rs`:
  - `pub mod cache;` (with `cache/mod.rs`: `pub mod key_expr; pub mod stamp;`);
  - `pub mod inputs; pub mod manifest; pub mod protocol; pub mod render; pub mod routing;`.
- [ ] Internal `crate::` paths resolve unchanged (same tree shape). `stamp.rs` gets the R2 doc-hidden `pub` items. `routes.rs:323` `build_request_envelope` becomes `#[doc(hidden)] pub`.
- [ ] brust-server `lib.rs`: drop `pub mod inputs/manifest/protocol/render/routing`; add `pub use brust_core::{inputs, manifest, protocol, render, routing};`.
- [ ] `cache/mod.rs` = `pub mod job_cache; pub mod l1; pub use brust_core::cache::{key_expr, stamp};`, so `crate::manifest::…`, `super::stamp::…` and `use super::*` in brust-server still resolve.
- [ ] Moved unit tests that read fixtures (`render.rs:696`, `routes.rs:1021`) switch to `Path::new(env!("CARGO_MANIFEST_DIR")).join("../brust-server/tests/fixtures/dist")`. Only the path changes.
- [ ] Green + A3 (multiset equal, so far without new tests apart from `public_api_paths_resolve`).

### Task 4 — move the pure HTTP/config/cache-type helpers
Files: core `{config.rs, cors.rs, body.rs, static_rules.rs, compress.rs, cache/mod.rs, host.rs}`; brust-server `{config.rs, server/{mod.rs,body.rs,static_assets.rs}, http/compress.rs, cache/{l1.rs,job_cache.rs}, dispatch.rs}`.
- [ ] **Test first:** extend the T2 pin if the step adds paths (it does not). Write the core test `config::tests::stats_json_shape_is_stable`: `serde_json::to_string(&Stats{ l1: CacheStats{hits:1,misses:2,len:3,capacity:4}, job: …, loader_calls:5, job_calls:6, worker_calls:7, timed_out_calls:8, missing_slots:9 })` equals the literal `{"l1":{"hits":1,"misses":2,"len":3,"capacity":4},"job":{…},"loader_calls":5,"job_calls":6,"worker_calls":7,"timed_out_calls":8,"missing_slots":9}` (R3).
- [ ] Core `config.rs` ← brust-server `config.rs:30-177` (`CorsConfig`, consts, `RESERVED`, `ActionsConfig`, `CrossSite`, `under`) and `:214-249` (`InvalidateArgs`, `InvalidateResult`, `Stats`), with its 3 tests (fixture path as in T3). brust-server `config.rs` keeps `Config`, `Server`, `TlsConfig` and adds `pub use brust_core::config::{…every moved pub item…}; pub use brust_core::cache::CacheStats;`.
- [ ] Core `cache/mod.rs` += `CacheKey`, `RenderedBody`, `build_cache_key`, `sort_query` (from `l1.rs:51-73,676-696`), `CacheStats` (`:190-197`), `StripedCounter` + `PaddedU64` (`:118-145`, doc-hidden pub), `JobKey` (`job_cache.rs:36-38`). `l1.rs`/`job_cache.rs` re-export them with `pub use`.
- [ ] Core `cors.rs` ← `git mv server/cors.rs` (`ResolvedCors` + `append_vary_token` doc-hidden pub; `preflight_response` returns `Response<Bytes>`). Remove `pub(crate) mod cors` from `server/mod.rs:28`.
- [ ] Core `body.rs` ← `server/body.rs:63-170,229-290`, returning `http::Response<Bytes>`, plus `header_str` (`server/mod.rs:500-505`) and `head_only` on `Response<Bytes>` (`Content-Length = body.len()`, empty body).
  - Native `body.rs` keeps `ResponseBody`, `full_body`, `empty_body`, `channel_body`, `canned_500`, `response_from_framed_bytes`, and adds `bytes_body(Bytes) -> ResponseBody` (the one `Full…boxed()`, as at `:134-143`).
  - The pure-builder tests move to core as `#[test]` with `fn body_bytes(r: Response<Bytes>) -> Vec<u8> { r.into_body().to_vec() }`. The framed-bytes tests stay native.
- [ ] Core `static_rules.rs` ← `static_assets.rs:62-168` (`percent_decode_path`, `asset_lookup_key`, `content_type_for`, `is_safe_*`) + `pipeline.rs:71,169-220` (`IMMUTABLE`, `StaticRoot` → `host.rs`, `safe_rel`, `is_hashed`). Their tests come along: `static_assets.rs` tests except `dev_assets_are_no_store_prod_cacheable`, plus `pipeline.rs:3020-3057`. `static_asset_response` + `asset_cache_control` stay native and now return `Response<Bytes>`.
- [ ] Core `compress.rs` ← `http/compress.rs:26-72` (`accepts_gzip`, `is_compressible`, `gzip` under `#[cfg(feature="gzip")]`, plus a `#[cfg(not(feature="gzip"))] pub fn gzip(_: &[u8], _: u32) -> Option<Vec<u8>> { None }`), with its 4 pure tests. Native `compress.rs` keeps `MIN_SIZE`, `STATIC_LEVEL`, `GZIP_CACHE`, `gzip_cached`, `maybe_compress` + `maybe_compress_gates` and re-exports the rest.
- [ ] Core `host.rs` (first part): `CallError` moved verbatim from `dispatch.rs:131-153`; brust-server `dispatch.rs` does `pub use brust_core::host::CallError;`.
- [ ] `cargo check -p brust-core --no-default-features` → exit 0. Green + A3.

### Task 5 — the traits (`host.rs`)
- [ ] **Test first:** in brust-server, `cache::tests::caches_forward_through_the_core_traits`. It runs generic fns `fn page<C: PageCache>(c: &C)` and `fn jobs<C: JobStore>(c: &C)` against `L1Cache::with_clock` / `JobCache::with_clock`: insert at `read_stamp()` → `get_with`/`get` hit → `invalidate_tags` returns 1 → miss → `stats().hits == 1`. It fails to compile until the traits exist.
- [ ] `brust-core/src/host.rs`, exact shapes (R9):
```rust
pub struct RequestHead<'a> { pub method: &'a str, pub full: &'a str, pub headers: &'a http::HeaderMap, pub authority: Option<&'a str> }
#[derive(Debug, PartialEq, Eq)] pub enum ReadErr { TooLarge, Io, Slow }            // from actions.rs:254-262
#[derive(Clone, Copy, PartialEq, Eq, Debug)] pub enum StaticRoot { Brust, Public }   // from pipeline.rs:168-175
pub struct ActionCall<'a> { pub method: &'a str, pub full: &'a str, pub headers: &'a http::HeaderMap, pub authority: Option<&'a str>, pub body: Option<bytes::Bytes> }
pub trait Clock { fn now_ns(&self) -> u64; fn now_ms(&self) -> u64 { self.now_ns() / 1_000_000 } }
pub trait PageCache {
    fn with_clock(capacity: u64, clock: Arc<InvalClock>) -> Self where Self: Sized;
    fn get_with<R>(&self, key: &CacheKey, f: impl FnOnce(&Arc<RenderedBody>) -> R) -> Option<R>;
    fn insert(&self, key: CacheKey, body: Arc<RenderedBody>, ttl: Duration, tags: &[String], since: ReadStamp) -> bool;
    fn read_stamp(&self) -> ReadStamp;
    fn invalidate_tags(&self, tags: &[String]) -> usize;
    fn invalidate_path(&self, method: &str, path: &str) -> usize;
    fn stats(&self) -> CacheStats;
}
pub trait JobStore {
    fn with_clock(capacity: u64, clock: Arc<InvalClock>) -> Self where Self: Sized;
    fn get(&self, k: &JobKey) -> Option<Arc<Node>>;
    fn insert(&self, k: JobKey, v: Arc<Node>, ttl: Option<Duration>, tags: &[String], user_key: Option<&str>, since: ReadStamp) -> bool;
    fn read_stamp(&self) -> ReadStamp;
    fn invalidate_tags(&self, tags: &[String]) -> usize;
    fn invalidate_user_key(&self, user_key: &str) -> usize;
    fn stats(&self) -> CacheStats;
}
pub trait Host: Clock {                       // no Send bound (R1)
    type Body; type L1: PageCache; type Jobs: JobStore;
    const PLAN_OFFER: bool;
    fn loader(&self, req: &LoaderRequest<'_>, offer: Option<PlanSeed>)
        -> impl Future<Output = Result<(LoaderResponse, Option<PlannedCall>), CallError>>;
    fn jobs(&self, req: &JobsRequest<'_>) -> impl Future<Output = Result<JobsResponse, CallError>>;
    fn read_body(&self, body: Self::Body, cap: usize) -> impl Future<Output = Result<Bytes, ReadErr>>;
    fn action(&self, call: ActionCall<'_>) -> impl Future<Output = Result<FetchResponse, CallError>>;
    fn static_file(&self, root: StaticRoot, rel: &str, headers: &HeaderMap, head: bool)
        -> impl Future<Output = Option<http::Response<Bytes>>>;
}
```
- [ ] `PlanSeed` and `PlannedCall`/`Lookup`/`PlanRow` are still in brust-server's `pipeline.rs` at this point. Move those four structs plus `PlanCell` into a new core module `plan.rs` first (struct definitions only; `JobPlan::to_row`/`rehydrate` stay with `JobPlan`): pure data, fields doc-hidden pub (R8). Re-import them in the native `pipeline.rs`; in T7 the moved `pipeline.rs` uses `crate::plan::*`.
- [ ] In brust-server `cache/mod.rs`, add `impl PageCache for L1Cache` and `impl JobStore for JobCache`, each method an `#[inline]` forward to the inherent method (inherent methods keep priority at existing call sites).
- [ ] Green + A3 (+1 new test).

### Task 6 — `Core<H>` + `NativeHost` + `Server` composition (pipeline still native)
- [ ] **Tests first:**
  - **(a)** In `server/mod.rs` (non-test, `#[allow(dead_code)]`): `fn _pipeline_future_is_send(req: Request<Incoming>, s: &Server) { fn is_send<T: Send>(_: &T) {} let f = crate::pipeline::handle(req, s); is_send(&f); }` and `const _: () = { const fn ok<T: Send + Sync>() {} ok::<Server>(); };`.
  - **(b)** Rerun the T4 stats golden.
  - **(c)** Rerun `tests/server.rs`, `tests/cache.rs`, `tests/http_hygiene.rs` and `tests/actions.rs` (CORS, HEAD, stats, `x-powered-by`); all pass unchanged.
- [ ] Core `core.rs`:
  - `pub struct CoreConfig { pub l1_capacity: u64, pub job_cache_capacity: u64, pub cors: Option<CorsConfig>, pub generator: Option<String>, pub actions: Option<ActionsConfig>, pub https: bool }`.
  - `pub struct Core<H: Host>`: the core-state fields listed in Facts plus `host: H`, `powered_by: Option<HeaderValue>`, `https: bool`; `generator`/`tls` are dropped. All fields are doc-hidden pub (R8).
  - `Core::new(host, loaded: Loaded, cfg) -> Result<Self, String>` reproduces `server/mod.rs:111-170` in the same order and with the same prefixes (`routes: `, `render: `, `manifest: `, `cors: `, `actions: `). It builds the caches with `H::L1::with_clock`/`H::Jobs::with_clock` on one `Arc<InvalClock>`, and builds `powered_by` as at `:260-272` (leaked static, same warn).
  - `invalidate`/`stats` are moved from `config.rs:317-359` with their docs. `finish(&self, origin: Option<&HeaderValue>, h: &mut HeaderMap)` = `:345-354` (insert-if-absent `x-powered-by`, then CORS stamp). Add `cors(&self)` and `cors_enabled(&self) -> bool`.
- [ ] brust-server `host.rs` (new): `pub(crate) struct NativeHost { pool: Arc<WorkerPool>, dist_dir: PathBuf, claim_timeout: Duration, call_timeout: Duration }`, with `Clock` (`LazyLock<Instant>` epoch, `as_nanos() as u64`) and `Host` (`Body = Incoming`, `L1 = L1Cache`, `Jobs = JobCache`, `PLAN_OFFER = true`):
  - `loader`: `call_worker_planned(…, CallKind::Loader, req, offer.map(|s| Box::new(PlanCell::Seed(s)) as PlanBox))`, then maps the returned cell to `Option<PlannedCall>`: `Planned` → `Some`, anything else → `None`. That is one Box, as today.
  - `jobs`: `call_worker(… CallKind::Jobs …)`.
  - `read_body`: `read_capped(b, cap, self.call_timeout)` (moved into `host.rs` with its 2 tests).
  - `action`: the `FetchRequest` build of `actions.rs:136-166`, using core `encode_body`, `body::is_framing_header` and `build_request_envelope`, then `call_worker_fetch`. Below `ACTION_INLINE_BODY_BYTES` it encodes inline; above it, `Heap` + `heap_body`.
  - `static_file`: `pipeline.rs:246-268` (the `safe_rel` step at `:240-243` and `IMMUTABLE`/`nosniff` at `:269-283` stay in core), with `inside_root` moved here.
- [ ] `Server` = `{ pub(crate) core: Core<NativeHost>, ready, expected_workers, drain_start, drain_done, drain_timeout_ms, local_addr, tls }`.
  - `invalidate`, `stats`, `cors` forward to `core`; `register_worker` and `plan_cells_in_use` read `core.host.pool`.
  - `start` = `Manifest::load` (`manifest: ` prefix) → `Core::new(NativeHost{…}, loaded, CoreConfig{ https: cfg.tls.is_some(), … })` → the rest unchanged.
- [ ] Native `pipeline.rs`/`actions.rs`:
  - Every fn taking `s: &Server` takes `s: &Core<NativeHost>`, and `handle(req, server: &Server)` starts with `let s = &server.core;`, so field accesses keep spelling `s.x`.
  - Worker calls become `s.host.loader/jobs/action/read_body/static_file`. `l1_decision` uses `s.https`. The `dur_ms` log uses `s.host.now_ns()` deltas `/ 1e6`.
  - Responses are built with core `body::*`; `handle` ends with `.map(body::bytes_body)`.
- [ ] Service fn (`server/mod.rs:330-356`): `let origin = state.core.cors_enabled().then(|| req.headers().get(ORIGIN).cloned()).flatten(); let mut resp = crate::pipeline::handle(req, &state).await; state.core.finish(origin.as_ref(), resp.headers_mut());`. That is one `Arc` clone per request (today: one, plus one with CORS).
- [ ] Green + A3 + `cargo test -p brust-server --release --test single_roundtrip`.

### Task 7 — move the pipeline into core, generic over `H: Host`
- [ ] **Test first:** the T6 `Send` probe and the A3 multiset. A failing probe here = apply R1's fallback, then `conclave task note` it.
- [ ] `git mv crates/brust-server/src/pipeline.rs crates/brust-core/src/pipeline.rs` (keeps blame), then:
  - `s: &Core<NativeHost>` → `s: &Core<H>` with `<H: Host>` on `handle`, `page`, `apply_job_results`, `render_document`, `l1_decision`, `note_missing_slots`;
  - `lookup_jobs`/`plan_response`/`plan_stage::Planned::{lookup,warm}` take `&impl JobStore`;
  - `Core::handle(&self, rq: RequestHead<'_>, body: H::Body) -> Response<Bytes>` in `core.rs` calls `pipeline::handle(self, rq, body)`.
- [ ] A new native `crates/brust-server/src/pipeline.rs` holds:
  - the hyper adapter (`into_parts` → `RequestHead{ method, full: path_and_query or path, headers, authority }` → `server.core.handle(head, incoming).await.map(body::bytes_body)`);
  - `PLAN_DECLINED` + `plan_in_call` (`:1823,1902-1942`, now calling `brust_core::pipeline::plan_response(&s.core.plans, &s.core.jobs, …)`);
  - a `#[cfg(test)] mod tests` with `plan_response_*` ×4, `plan_server`/`claim`/`seed`/`write_slot` and `plan_in_call_*` ×2, verbatim except for imports, duplicated helpers (`n`, `j`, `manifest`, `pikachu`, `base`, `r2`, `PIKACHU`) and `s.plans`/`s.manifest`/`s.pool` → `s.core.…`/`s.core.host.pool`.
  - Every other pipeline test stays in core, with fixture paths per T3 (`golden_dir()` → `../brust-server/benches/fixtures/pokedex`; `BRUST_WRITE_PLAN_GOLDEN=1` still writes there).
- [ ] `lib.rs` `bench` module → `pub use brust_core::pipeline::{plan_stage::{Planned, Planner}, cached_body, next_hint, props_view, render_chain_html, render_chain_into};`.
- [ ] If clippy reports the `#[expect(clippy::result_large_err)]` on `apply_job_results` (`pipeline.rs:621-624`) as unfulfilled (the Err is now `Response<Bytes>`), delete the attribute; change nothing else.
- [ ] Green + A3 + release `single_roundtrip` + `cargo bench -p brust-server --bench render --no-run`.

### Task 8 — move the actions flow into core
- [ ] **Test first:** `tests/actions.rs` (944 lines, HTTP) and the actions unit tests are the guard; A3.
- [ ] `git mv crates/brust-server/src/actions.rs crates/brust-core/src/actions.rs`. Keep `handle<H: Host>(s: &Core<H>, a, rq: &RequestHead, body: H::Body, head: bool)`: admission (`:74-110`), `s.host.read_body` (`ReadErr` → 413/400/408 as `:111-135`), `s.host.action(ActionCall{…})`, counters, `response_from_fetch`, `head_only`. `cross_site_verdict`/`request_host` read `rq.authority` instead of `parts.uri`. Unit tests stay, except the `read_capped_*` ×2, which went native in T6.
- [ ] A new native `actions.rs` keeps `take_fetch_body`/`put_fetch_reply` (`:22-61`, now `s.core.host.pool`/`s.core.actions`) and `FetchCell` use.
- [ ] Narrow every R8 seam item brust-server no longer reads back to `pub(crate)` (`rg 'brust_core::' crates/brust-server/src` is the list of what it reads).
- [ ] Green + A3 + release `single_roundtrip`.

### Task 9 — verification sweep (no measurement)
- [ ] `git diff --stat origin/m4cf -- crates/brust-napi` → empty. `cargo clippy -p brust-napi --no-deps -- -D warnings && cargo test -p brust-napi` → ok.
- [ ] `! cargo tree -p brust-core -e normal | grep -E 'tokio|hyper|moka|crossbeam'`, `cargo check -p brust-core --no-default-features`, and `cargo bench -p brust-server --bench render --no-run` → all exit 0.
- [ ] R10: `ci.yml:37` += `-p brust-core`; the new tree step goes after `:35`.
- [ ] `cd packages/brust && bun run build:debug && bun run build && bun run typecheck && bun test`, then `bun test --timeout 120000 tests/server/pokedex.test.ts`, `… tests/server/hydrate.chromium.test.ts`, `bun run m2-exit` (report diff empty), and `bun test bench/lib && (cd bench/apps/brust && bun test)` → all green. Run server files one at a time if a port flakes.

### Task 10 — regenerate `bench/attribution.patch` (R11; never commit the applied tree)
- [ ] `git status --short` → clean. `git apply --3way bench/attribution.patch`; the `pipeline.rs`/`render.rs`/`lib.rs`/`perf.rs` hunks conflict or land at the old paths.
- [ ] Re-place them by hand with the same stage ids:
  - `perf.rs` → `crates/brust-core/src/perf.rs`, and `git rm -q --cached crates/brust-server/src/perf.rs` if 3-way staged it;
  - brust-core `Cargo.toml` += `libc = "0.2"`, `parking_lot = "0.12"`; core `lib.rs` += `pub mod perf;`; brust-server `lib.rs` += `pub use brust_core::perf;`;
  - `/_brust/perf` + `PAGE_TOTAL`/`HANDLE_TOTAL` (a local `let t0 = std::time::Instant::now();`) + every `page()`/`render_document`/`render_chain_into`/`plan_one`/`plan_response` hunk → core `pipeline.rs`; `SCOPE_BUILD`/`TMPL*` → core `render.rs`; `PLAN_IN_CALL` → native `pipeline.rs::plan_in_call`;
  - `dispatch.rs` (incl. F83 `READ_UTF8`/`READ_SERDE`), `server/mod.rs` `SVC_TOTAL` and `worker.ts` unchanged.
- [ ] `git add -N crates/brust-core/src/perf.rs && cargo check -p brust-core -p brust-server -p brust-napi` → exit 0.
- [ ] `git diff HEAD -- Cargo.lock crates packages/brust/src/worker.ts > $OUT/attr.patch && cp $OUT/attr.patch bench/attribution.patch`.
- [ ] Revert: `git reset -q HEAD -- Cargo.lock crates packages/brust/src/worker.ts && git checkout -- Cargo.lock crates packages/brust/src/worker.ts && git clean -fq crates/brust-core/src/perf.rs crates/brust-server/src/perf.rs`.
- [ ] Guard:
  - `git status --short` → only ` M bench/attribution.patch`;
  - `grep -rn 'mod perf\|_brust/perf\|brust_core::perf' crates/` → empty;
  - `git apply --check bench/attribution.patch` → exit 0.
- [ ] Rebuild the debug addon. Commit `bench: attribution.patch follows the core split`.

### Task 11 — docs
- [ ] Spec §3: add a "Status" column (or a line under the table): "M4-CF-1 done @<sha>" per row. Amend: the `Manifest::from_parts` row → M4-CF-3 (R5); the actions `FetchRequest` build stays native; the cache rows note the traits.
- [ ] Spec §4: update the Rust block to the merged `host.rs` signatures (R9 a-g).
- [ ] Module docs: `brust-core/src/lib.rs` (seam rule R8, features R4, Send rule R1) and `brust-server/src/lib.rs:1` ("native host over brust-core").
- [ ] Commit `docs(m4cf): core split landed`.

## Acceptance
- **A1:** `git diff --stat origin/m4cf -- crates/brust-napi crates/brust-server/benches packages` → empty. `git diff --stat origin/m4cf -- crates/brust-server/tests` → only `public_api.rs` (new).
- **A2:** `git diff -M origin/m4cf -- crates | grep -E '^[-+]\s*(debug_)?assert'` → only `+` lines inside the new tests (`stats_json_shape_is_stable`, `caches_forward_through_the_core_traits`). No `-` lines.
- **A3:** `(cargo test -p brust-core --lib --tests -- --list; cargo test -p brust-server --lib --tests -- --list) 2>/dev/null | grep ': test$' | sed 's/: test$//; s/.*:://' | sort > $OUT/names-after.txt; diff $OUT/names-before.txt $OUT/names-after.txt` → only `>` lines naming the 3 new tests.
- **A4:** `cargo test --workspace --exclude bun_react_compiler` → no `FAILED`; the `test result: ok` count is the T1 count + the brust-core binaries.
- **A5:** `! cargo tree -p brust-core -e normal | grep -E 'tokio|hyper|moka|crossbeam'` and `cargo check -p brust-core --no-default-features` → exit 0.
- **A6:** `rg -n 'dyn (Host|PageCache|JobStore)|Box<dyn Future' crates/brust-core crates/brust-server/src/host.rs` → empty. `rg -n 'Arc::new' crates/brust-server/src/pipeline.rs crates/brust-core/src/pipeline.rs` → the same sites as `git show origin/m4cf:crates/brust-server/src/pipeline.rs | rg -n 'Arc::new'`.
- **A7:** the Send probe and the `Server: Send + Sync` const are present, and `cargo build -p brust-server` succeeds. `rg 'trait_variant' Cargo.lock` matches only if R1's fallback was used, and the READY note says so.
- **A8:** `cargo bench -p brust-server --bench render --no-run` → exit 0. `git apply --check bench/attribution.patch` → exit 0.
- **A9:** `/_brust/cache/stats` shape: `cargo test -p brust-core stats_json_shape_is_stable` and `cargo test -p brust-server --test server` (stats pointers, `server.rs:23-34`) pass; `bun test` in `packages/brust` (the `e2e*.test.ts` files read the same endpoint) passes.

## Gates
- `cargo fmt --all -- --check`
- `cargo clippy -p brust-core -p brust-compiler -p brust-compiler-cli -p brust-jinja -p brust-server -p brust-napi --no-deps -- -D warnings`
- `cargo test --workspace --exclude bun_react_compiler`
- `cargo test -p brust-server --release --test single_roundtrip -- --nocapture`
- `cargo bench -p brust-server --bench render --no-run` (build only)
- `! cargo tree -p brust-core -e normal | grep -E 'tokio|hyper|moka|crossbeam'` and `cargo check -p brust-core --no-default-features` (new)
- `cd packages/brust && bun run build:debug && bun run build && bun run typecheck && bun test`
- `bun test --timeout 120000 tests/server/pokedex.test.ts` and `bun test --timeout 120000 tests/server/hydrate.chromium.test.ts`
- `bun run m2-exit` (report diff empty), `bun test scripts/m2-exit`
- `bun test bench/lib && (cd bench/apps/brust && bun test && bun run typecheck)` (bench `typecheck` = `cd bench && bun run typecheck`)
- `git apply --check bench/attribution.patch`
- Not affected (compiler/runtime-dom untouched): battery, browser-test, runtime-dom. The lead runs them at merge as usual.
- **No `bun run bench`, oha, or `bench/attribution.ts` on this host.** Do not take `bench:host-lock`.

## Risk ledger
- **`Send` through RPITIT on a generic `Core<H>`** fails as "implementation of `Send` is not general enough" at T7. The T6 probe flags it at compile time, at a named line. Response: R1 fallback, never boxing.
- **Orphan rule.** A native method on a moved type (`impl Manifest`, `impl RouteTable` …) cannot be written in brust-server. A compile error `cannot define inherent impl for a type outside of the crate` means it becomes a free fn in brust-server or stays in core (R4 for `load`).
- **Hidden `pub(crate)` reach.** brust-server code calling a now-foreign `pub(crate)` item fails to compile. Fix with R8 doc-hidden pub, then narrow in T8.
- **Silent behaviour drift in the move:**
  - header order on static/HIT/page responses; HEAD `Content-Length`; `x-powered-by` insert-if-absent before CORS;
  - error prefixes of `start`; the 503/504 bodies (CallError Display strings).
  - Guard: the unchanged HTTP tests (`server.rs`, `http_hygiene.rs`, `cache.rs`, `actions.rs`, `review_fixes.rs`, `l1_front.rs`) and A2.
- **Perf drift without measurement.** Code-level guard: A6, the single `bytes_body` boxing per response (`rg -n 'boxed\(\)' crates/brust-server/src` → `body.rs` only), `#[inline]` cache forwards, and thin LTO + `codegen-units = 1` in `[profile.release]` (`Cargo.toml`), which allow cross-crate inlining of non-generic core helpers. A regression shows only in the lead's remote S/D/I run. If D or I loses more than 3%, the first suspects are non-inlined `body::*`/`cached_body` calls (add `#[inline]`) and the `Response::map` move.
- **Logging.** Untargeted events change target to `brust_core::…`; the default filter `brust=info` still prefix-matches [I]. `tests/logging.rs` (target `brust::request`, `dur_ms=`) is the guard.
- **Test-count lies.** A moved test that silently stops being compiled (wrong `#[cfg(test)]` module) disappears from A3. A3 must be exactly the 3 additions.
- **attribution.patch.** `--3way` stages into the index, so the revert must `git reset` first (T10). A forgotten `perf.rs` is caught by the T10 guard grep.
- **Stale addon.** The JS gates on a stale `.node` lie: rebuild after every Rust edit (memory "stale napi node").
- **Shared host.** Never kill a process you did not spawn. No broad `pkill`.

## Reporting
`conclave task note 838f12fb-70c1-41b7-acf2-d4065cf6bb64 m4cf-core-split READY @<sha> …`. The note must contain:
- the commit list (one per task);
- R1-R11 as implemented, including whether R1's fallback was needed;
- the A3 diff output (3 lines), the core/server/napi test counts, and T1 N vs final;
- the outputs of A1, A5, A6 and A8;
- every gate with its result;
- the code-level perf argument:
  - `handle::<NativeHost>` is monomorphised; no `dyn`, no new `Arc` (one per request, the CORS clone removed);
  - one `Full` boxing per response (`bytes_body`), as `resp_with` did;
  - the plan seed is one `Box`, as before;
  - cache trait calls are `#[inline]` forwards;
  - `now_ns` = 2 `Instant` reads per page, as before;
  - one extra `Response::map` (`Parts` move, no allocation);
  - thin LTO keeps cross-crate inlining;
- the line "S/D/I NOT measured on this host (rule). Lead: schedule `bun run bench` S/D/I on the remote host against `bench/RESULTS.md:7-28`; bar ≤ 3% on two runs."

Escalate with `conclave task challenge 838f12fb-70c1-41b7-acf2-d4065cf6bb64 m4cf-core-split "<what, evidence>"` for any of these:
- an existing assertion that must change;
- any edit `brust-napi` would need;
- a `public_api.rs` path that cannot be kept;
- the Send probe failing under both R1 options;
- the patched attribution tree failing to compile;
- an A3 mismatch you cannot explain;
- a file outside the Boundary.
