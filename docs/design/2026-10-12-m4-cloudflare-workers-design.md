# M4-CF: brust on Cloudflare Workers (workers-rs, Rust end to end): architecture design

**Status: RULED by lead Detoro 2026-10-12 (R1-R14 below) — awaiting the HUMAN'S review of this spec before lanes are cut (brainstorming gate). Rulings: R1 ACCEPT (`brust-core` crate generic over a `Host` trait; `brust-server` = native host, API unchanged; `brust-wasm` = workers-rs host). R2 ACCEPT (one app-independent wasm published as npm `@brust/core-cf`, built by brust's release CI; `--wasm-from-source` for repo dev; app authors never need a Rust toolchain). R3 ACCEPT (`#[wasm_bindgen(raw_module = "./brust-app.js")]` + the ~25-line GENERATED entry that only imports the app's own compiled modules — this is the irreducible ES-module wiring, not a runtime layer; lane 3's first task proves it survives worker-build + wrangler bundling). R4 ACCEPT (plan offer off on Workers; loader and jobs are two direct in-isolate calls). R5 AMENDED: isolate-local invalidation is NOT acceptable as the end state — lane 7 is REQUIRED (not optional): a cross-isolate tag epoch (one Durable Object or KV epoch, read once per isolate per bounded interval, default 1 s) so a mutation is visible everywhere within ~1 s instead of up to `ttl`; M4-CF-1..6 may ship behind a documented "preview" label until lane 7 lands. R6 ACCEPT (edge cache off by default). R7 ACCEPT (`--panic-unwind` on the pinned nightly). R8 ACCEPT (user's `wrangler.jsonc` supplies bindings; brust owns `main`/`assets`/`compatibility_date`). R9 ACCEPT (Workers + Static Assets; Pages is served by the same artifact only if trivially possible, otherwise documented as not targeted). R10 ACCEPT (Elysia 2 beta with a generated startup `.compile()`, gated by a real Worker test in lane 3; if it fails, actions ship later and the spec is amended). R11-R14 ACCEPT. Lane order 1 → 2 → (3 ∥ 4) → 5 → 6 → 7 → 8. Native perf bar: bench S/D/I rows within noise after lane 1 (measured on a quiet day per rule:bench-hold).**

Status before ruling: draft for the lead. Repo grounding is the `beta1` worktree, branch `beta1` @ **1a6c670**. The branch moved
from e93af49 while this was written (f6a6a30 docs, then the F89 merge that adds `crates/brust-server/src/cache/stamp.rs`). Every
`path:line` is verified at 1a6c670.

Citation key: **[C]** = Cloudflare/upstream doc, URL given, fetched 2026-10-12. **[I]** = inference that a lane must verify.

Binding human decisions (2026-10-12):
- **H1.** Support Cloudflare Workers & Pages, full Workers runtime, no spike.
- **H2.** Build on **workers-rs** (the `worker` crate, `#[event(fetch)]`, `worker-build`).
- **H3.** "ไม่เอา workers js": brust ships **no hand-written JS glue or runtime layer** for Cloudflare. The only JS in the deployed
  Worker is (1) the shim `worker-build` generates and (2) the app's own TS that `brust build` compiles: loaders, `jobs.js`,
  `actions.js`, client chunks, plus the `@brust/core` server modules those already import.

---

## 0. Verdict

**Feasible without a spike. Most of the risk is in the split, not on Cloudflare.**

About 70% of `brust-server` is already host-agnostic: routing, manifest, render, inputs, protocol, key_expr, stamps, CORS
and actions admission. Their types are `http`/`serde`/`minijinja`, which all compile to wasm32.

The non-portable parts sit in five places:
1. **hyper I/O at the pipeline edge.** `pipeline.rs:73` takes `Request<Incoming>`; the response body type is `body.rs:28`.
2. **The napi/SAB dispatch.** `dispatch.rs:68` requires `Send + Sync` and raw SAB pointers.
3. **moka + crossbeam caches with `std::time::Instant`.** See `l1.rs:39-41,356` and `job_cache.rs:27-30`. `Instant::now()` panics
   on `wasm32-unknown-unknown` [I].
4. **tokio fs/Notify.** See `pipeline.rs:225-257` and `config.rs:16,258-263`.
5. **The accept loop.** See `server/mod.rs`.

The design:
- Extract a `brust-core` crate that is generic over a `Host` trait (static dispatch, so the native path is monomorphised and
  unchanged).
- Keep `brust-server` as the hyper/tokio host.
- Add `brust-wasm`, a workers-rs host. It reaches the app's JS through **`#[wasm_bindgen(raw_module = "./brust-app.js")]`**
  imports, so one prebuilt, app-independent wasm serves every app.
- `brust build --target cloudflare` emits a complete wrangler project (`dist/cf/`). The user writes no JS.

Target **Workers + Static Assets**; Pages is not targeted. Cloudflare's Pages landing page says "Start new projects with
Workers" [C https://developers.cloudflare.com/pages/].

**The one semantic loss** is cross-isolate cache coherence. `cache.invalidate` clears only the isolate that ran the action, so
other isolates serve up to `ttl` stale. This draft makes that the documented default (R5) and plans a Workers Cache tag-purge
lane to close it.

## 1. Goals / non-goals

**Goals**
- **G1.** The same app source runs on `brust start` (native) and on Cloudflare Workers. On Workers, pages, loaders, jobs (both
  precompute and React `ssr`), stores, actions, CORS, the generator header, problem bodies and 404/redirect/httpError verdicts
  all behave the same, apart from the documented deltas in §5.
- **G2.** A crate split that leaves the native path within noise of `bench/RESULTS.md`:
  - S `/types`: 113,744 rps
  - D `/dex?nocache=1`: 13,759 rps
  - I `/team?nocache=1`: 104,889 rps
  
  Measured on 2026-10-11 at 97b944a (`bench/RESULTS.md:7-28`).
- **G3.** `brust build --target cloudflare` produces a deployable wrangler project. `wrangler deploy -c dist/cf/wrangler.jsonc`
  ships it.
- **G4.** In CI, the pokedex e2e runs against the Worker build under local workerd, with no Cloudflare account.
- **G5.** Pokedex-on-Cloudflare dogfood with D1 for the team.

**Non-goals (M4)**
- Pages Functions.
- SSG / `--ssg`. It is 0.1.x-only (`runtime/cli/build.ts:740` in the 0.1.x repo) and deferred by M2 (`docs/design/2026-10-09-m2-server-design.md:131`).
- Coherent global invalidation (a lane, not the gate).
- Durable Objects for stores.
- Streaming HTML. Bodies are fully buffered today (`pipeline.rs:157-158` comment).
- Windows.
- A Rust toolchain on the app author's machine (R2).

## 2. Architecture

```
                         ┌────────────── Cloudflare edge ──────────────┐
 GET /_brust/client/x.js │ Static Assets (dist/cf/assets) ── hit ──► 200 (Worker not invoked)
 GET /pokemon/pikachu ──►│   miss ─► shim.mjs (worker-build) ─► brust-wasm #[event(fetch)]
                         │             │ worker::Request → RequestHead (method,url,headers)
                         │             ▼
                         │   brust-core::handle::<WasmHost>   (same code as native)
                         │     preflight → actions? → method gate → /ping → static? → route match
                         │     → L1 probe (isolate LRU) ── HIT ──► Response (no JS call)
                         │     → host.loader(json) ─► raw_module "./brust-app.js" ::loader ─► JS chain in ALS scope
                         │     → plan jobs (Rust) → job cache → host.jobs(json) ─► brust-app.js::jobs (renderToString…)
                         │     → minijinja render → assets/store scripts → L1 insert → finish(): CORS + x-powered-by
                         │             ▼
                         │   worker::Response::from_bytes(..) + headers
                         └──────────────────────────────────────────────┘
 POST /_brust/action/team ─► core admission (CONNECT/TRACE 501, ambiguous path 400, content-encoding 415,
     cross-site 403, length cap 413), all Rust (actions.rs:20-80)
     → body read capped in Rust (req.stream()) → host.action(web Request rebuilt with bytes)
     → brust-app.js::action(req) → Elysia app.fetch inside runInStoreContext
       → web Response handed back as JsValue → core finish() stamps → returned as-is (no body copy)
       (the app's cache.invalidate() → raw import back into wasm: invalidate(args), isolate-local)
```

**Where each existing piece lands**

| Piece | Today | Native host (`brust-server`) | Worker host (`brust-wasm`) |
|---|---|---|---|
| Accept/TLS/drain | `server/mod.rs:109-430`, `tls.rs` | unchanged | Cloudflare edge |
| Pipeline | `pipeline.rs:73` `handle(Request<Incoming>)` | hyper adapter calls `core::handle` | workers-rs adapter calls `core::handle` |
| Worker calls | `dispatch.rs:282` tsfn + SAB slot | `NativeHost` impl over the existing pool | direct calls through `raw_module` imports (`JsFuture`) |
| Plan offer | `pipeline.rs:1902` `plan_in_call` (sync napi re-entry) | unchanged | off (R4): two direct calls cost µs, not a crossing |
| L1 / job cache | moka + 64-shard front (`l1.rs:287,356`) | unchanged (impl `PageCache`/`JobStore`) | `LocalL1`/`LocalJobs`: single-thread LRU with the same stamp/generation semantics |
| Static files | `pipeline.rs:233-284` (tokio::fs) | `NativeHost::static_file` (moved) | Static Assets; a miss under `/_brust/`, `/public/` → 404 from core |
| CORS + `x-powered-by` | service_fn chokepoint `server/mod.rs:331-356` | `core::finish()` (moved, same ops) | `core::finish()` |
| Templates/manifest | `Manifest::load` reads fs (`manifest.rs:334`) | `load` = fs read + `from_parts` | `from_parts(json, templates)`; data exported by `brust-app.js` |
| Loader chain, store scope | `worker.ts:182` `makeHandlers`, ALS `store/server-context.ts:4-14` | unchanged | same `makeHandlers`, bundled into `brust-app.js` |
| Actions | `actions-bridge.ts:96` `runFetch` (SAB frame) | unchanged | `fetchInScope(app, req)` (factored out of `runFetch`, no SAB) |

## 3. Crate / package split

**New `crates/brust-core`.** Host-agnostic, and builds for `wasm32-unknown-unknown`. Its deps are `brust-jinja`, `minijinja`,
`serde(_json)`, `http`, `bytes`, `matchit`, `percent-encoding`, `blake3`, `thiserror`, `tracing`, plus `flate2` behind the
`gzip` feature. It has no tokio, hyper, moka or crossbeam.

**`crates/brust-server`** becomes the native host. Its public API is unchanged: it re-exports `Config`, `Server`, `start`,
`RenderDispatch`, … so `brust-napi` does not change.

**New `crates/brust-wasm`** is the workers-rs host. It is a `cdylib` built only by `worker-build`, and is not a default workspace
member for `cargo test` on the host.

| Module (today, brust-server) | Verdict | Why (verified) |
|---|---|---|
| `routing/routes.rs` | **moves → core** | pure; `HeaderMap` comes from the `http` crate (`routes.rs:29,323`) |
| `manifest.rs` | **moves**, `load` included (an inherent method: the orphan rule keeps it in core; `std::fs` compiles on wasm32 and fails at runtime). `Manifest::from_parts(json, templates)` → **M4-CF-3**, its first caller (lane-1 R5) | `std::fs` only in `load` (`manifest.rs:334-385`) |
| `render.rs` | **moves** | `Renderer::from_templates(&BTreeMap)` is already fs-free (`render.rs:95`) |
| `inputs.rs`, `protocol.rs`, `cache/key_expr.rs`, `cache/stamp.rs` | **move** | pure; `stamp.rs` is an `AtomicU64` clock (`stamp.rs:6,17`) |
| `pipeline.rs` (page, l1_decision, plan/merge/slots/render helpers) | **moves**, generic over `H: Host` | the only couplings are `Incoming` (`:18,73`), `tokio::fs` (`:225-257`, moves to host) and `call_worker*` (`:22`, becomes host methods) |
| `pipeline.rs::plan_in_call`, `PlanCell` SAB read | **stays** native | sync napi re-entry over the SAB (`:1902`) |
| `actions.rs` admission (`cross_site_verdict` `:147`, `ambiguous_path` `:192`, `encode_body` `:232`, `response_from_fetch` `:276`) | **moves**; the A1 `FetchRequest` build (inline/heap body, header pairs, envelope) stays in the native host's `action` | pure over `RequestHead`/`HeaderMap` |
| `actions.rs::read_capped` (`:213`, hyper `Incoming`) | **stays**; the host provides `read_body` | body source differs per host |
| `server/cors.rs` | **moves** | `http` types only (`cors.rs:17-22,160`) |
| `server/body.rs` error helpers (`:232-290`) | **move**, returning `http::Response<Bytes>` | `BoxBody` (`:28`) stays native; the native adapter boxes once, same allocation count as `full_body` today [I] |
| `server/static_assets.rs` pure helpers, `safe_rel`/`is_hashed` | **move** | pure |
| `http/compress.rs` `gzip`/`accepts_gzip` | **move**, behind `gzip` feature | `GZIP_CACHE` moka (`compress.rs:9,24`) stays native |
| `config.rs` `CorsConfig`/`ActionsConfig`/`InvalidateArgs`/`Stats` | **move** | `Server` keeps `Notify`/addr/tls (`config.rs:16,237-282`) and becomes `Core<H>` + native extras |
| `cache/l1.rs`, `cache/job_cache.rs` | **stay**, impl `PageCache`/`JobStore` by `#[inline]` forwards; the entry/key/stats types (`CacheKey`, `RenderedBody`, `CacheStats`, `JobKey`, `build_cache_key`, `StripedCounter`) move to `brust_core::cache` | moka sync + `ShardedLock` + `Instant` (`l1.rs:39-41`, `job_cache.rs:27-30`) |
| `pool.rs`, `dispatch.rs`, `server/mod.rs`, `tls.rs`, `coarse_timer.rs` | **stay** | tokio/threads/SAB by design (`dispatch.rs:68-130`) |
| `brust-jinja` | unchanged | deps are `minijinja` + `serde` only (`crates/brust-jinja/Cargo.toml`) |
| `brust-napi` | unchanged | uses the re-exports |
| **new** `brust-core/src/host.rs` | `Host`, `PageCache`, `JobStore`, `Clock` (+ `core.rs` `Core<H>`, `plan.rs` the planned-call data) | §4 |
| **new** `brust-core/src/cache/local.rs` | `LocalL1`, `LocalJobs` | one shared conformance test suite runs against both impls (F81/F86/F89 cases) |
| **new** `crates/brust-wasm` | `lib.rs` (`#[event(start)]`, `#[event(fetch)]`), `host.rs` (`WasmHost`), `bridge.rs` (raw_module externs) | §4 |

**Status (2026-10-12):** M4-CF-1 done @15d1051 (lane `m4cf-core-split`): every "moves"/"stay" row above as amended, except the two "new" rows of later lanes (`cache/local.rs` → M4-CF-2, `brust-wasm` → M4-CF-3). `brust-server`'s public paths are pinned by `tests/public_api.rs`; `brust-napi` is unchanged.

**Packages.** In `packages/brust`:
- Split `worker.ts` into `handlers.ts`, which holds the pure `makeHandlers` plus helpers (`worker.ts:105-266`), and the Bun
  boot. The boot keeps `node:worker_threads` and napi (`worker.ts:4-7,314-345`).
- Factor `actions-bridge.ts`, so that `fetchInScope(app, req): Promise<Response>` is the shared core of `runFetch` (`:96-116`).
- Add a `build/cloudflare.ts` target.

These are refactors of existing modules, not a Cloudflare JS layer. The Bun path calls the same functions.

**Why static dispatch.** `core::handle<H: Host>` is monomorphised, so `handle::<NativeHost>` compiles to today's calls with no
`dyn` and no extra `Arc`.

The `Send` question:
- Native futures must stay `Send`, because they are spawned on multi-thread tokio (`server/mod.rs:327`).
- workers-rs futures are `!Send`.
- So `Host` methods return `impl Future` **without** a `Send` bound. The native adapter asserts `Send` on the concrete
  `handle::<NativeHost>` future at the spawn site. Auto-trait leakage through RPITIT on a concrete impl is assumed [I]; if it
  fails, the fallback is `trait_variant::make(SendHost: Send)`.
- Reentrancy on one isolate (many concurrent requests [C https://developers.cloudflare.com/workers/platform/limits/#memory]) is
  safe by the same token. A `Send` pipeline future can never hold a `parking_lot` guard across `.await`, so no lock or `RefCell`
  borrow spans a JS call [I]. A lint/test in lane 2 asserts it.

## 4. Interfaces

**Rust (brust-core)** — as merged in M4-CF-1 @15d1051 (`crates/brust-core/src/host.rs`, `core.rs`).
**Amended 2026-10-12 (lane-1 R9, ruled before dispatch):** seven deltas from the draft: (a) `RequestHead` gains `authority`
(actions R8: the HTTP/2 host); (b) `Clock::now_ns` (+ default `now_ms`) with `Host: Clock` replaces `Host::now_ms`, so the
`dur_ms` log keeps its precision; (c) `PageCache::with_clock` / `JobStore::with_clock`, so `Core::new` builds both caches on
one invalidation clock; (d) `const PLAN_OFFER: bool` on `Host` (native `true`; Workers `false`, R4); (e) `Host::action` returns
`FetchResponse` and `Core::handle` returns `http::Response<Bytes>` — `ActionReply::Passthrough`/`Outcome` arrive with M4-CF-3,
no dead variant now; (f) `Host::static_file` gets a path already `safe_rel`-checked, and core stamps `immutable`/`nosniff`
after it; (g) `X-Powered-By` is built in `Core::new`, so an invalid generator warns at `start`, not after bind.
```rust
pub struct RequestHead<'a> { pub method: &'a str, pub full: &'a str /* path?query */, pub headers: &'a http::HeaderMap,
                             pub authority: Option<&'a str> }
pub struct ActionCall<'a> { pub method: &'a str, pub full: &'a str, pub headers: &'a http::HeaderMap,
                            pub authority: Option<&'a str>, pub body: Option<bytes::Bytes> }
pub enum ReadErr { TooLarge, Io, Slow }
pub enum StaticRoot { Brust, Public }
pub trait Clock { fn now_ns(&self) -> u64; fn now_ms(&self) -> u64 { self.now_ns() / 1_000_000 } }
pub trait PageCache {                              // native: L1Cache (moka + sharded front)
    fn with_clock(capacity: u64, clock: Arc<InvalClock>) -> Self where Self: Sized;
    fn get_with<R>(&self, key: &CacheKey, f: impl FnOnce(&Arc<RenderedBody>) -> R) -> Option<R>;
    fn insert(&self, key: CacheKey, body: Arc<RenderedBody>, ttl: Duration, tags: &[String], since: ReadStamp) -> bool;
    fn read_stamp(&self) -> ReadStamp;
    fn invalidate_tags(&self, tags: &[String]) -> usize;
    fn invalidate_path(&self, method: &str, path: &str) -> usize;
    fn stats(&self) -> CacheStats;
}
pub trait JobStore {                               // native: JobCache
    fn with_clock(capacity: u64, clock: Arc<InvalClock>) -> Self where Self: Sized;
    fn get(&self, k: &JobKey) -> Option<Arc<Node>>;
    fn insert(&self, k: JobKey, v: Arc<Node>, ttl: Option<Duration>, tags: &[String], user_key: Option<&str>,
              since: ReadStamp) -> bool;
    fn read_stamp(&self) -> ReadStamp;
    fn invalidate_tags(&self, tags: &[String]) -> usize;
    fn invalidate_user_key(&self, user_key: &str) -> usize;
    fn stats(&self) -> CacheStats;
}
pub trait Host: Clock {                            // no Send bound (workers-rs futures are !Send)
    type Body;                                     // hyper Incoming | worker::Request
    type L1: PageCache; type Jobs: JobStore;
    const PLAN_OFFER: bool;                        // native true; Workers false (R4)
    fn loader(&self, req: &LoaderRequest<'_>, offer: Option<PlanSeed>)
        -> impl Future<Output = Result<(LoaderResponse, Option<PlannedCall>), CallError>>;
    fn jobs(&self, req: &JobsRequest<'_>) -> impl Future<Output = Result<JobsResponse, CallError>>;
    fn read_body(&self, body: Self::Body, cap: usize) -> impl Future<Output = Result<bytes::Bytes, ReadErr>>;
    fn action(&self, call: ActionCall<'_>) -> impl Future<Output = Result<FetchResponse, CallError>>;
    fn static_file(&self, root: StaticRoot, rel: &str, headers: &http::HeaderMap, head: bool)
        -> impl Future<Output = Option<http::Response<bytes::Bytes>>>;   // rel is safe_rel-checked; None → 404
}
pub struct CoreConfig { pub l1_capacity: u64, pub job_cache_capacity: u64, pub cors: Option<CorsConfig>,
                         pub generator: Option<String>, pub actions: Option<ActionsConfig>, pub https: bool }
pub struct Core<H: Host> { /* host, routes, manifest, plans, renderer, l1: H::L1, jobs: H::Jobs, clock, counters, cors, actions, powered_by, https */ }
impl<H: Host> Core<H> {
    pub fn new(host: H, loaded: Loaded, cfg: CoreConfig) -> Result<Self, String>; // start()'s validation, minus bind
    pub async fn handle(&self, rq: RequestHead<'_>, body: H::Body) -> http::Response<bytes::Bytes>;
    pub fn finish(&self, origin: Option<&HeaderValue>, h: &mut HeaderMap);       // x-powered-by + CORS stamp
    pub fn invalidate(&self, args: InvalidateArgs) -> InvalidateResult;  pub fn stats(&self) -> Stats;
    pub fn cors(&self) -> Option<&CorsConfig>;  pub fn cors_enabled(&self) -> bool;
}
```

**wasm ↔ app JS: the import mechanism (R3).** `brust-wasm/src/bridge.rs`:
```rust
#[wasm_bindgen(raw_module = "./brust-app.js")]
extern "C" {
    #[wasm_bindgen(js_name = loader)] fn js_loader(req_json: &str) -> js_sys::Promise;   // → string
    #[wasm_bindgen(js_name = jobs)]   fn js_jobs(req_json: &str) -> js_sys::Promise;     // → string
    #[wasm_bindgen(js_name = action)] fn js_action(req: web_sys::Request) -> js_sys::Promise; // → Response
    static MANIFEST: String; static TEMPLATES: js_sys::Object; static CONFIG: String;     // data exports
}
#[wasm_bindgen] pub fn invalidate(args: JsValue) -> JsValue;  // export: cache.invalidate on CF resolves here (R5)
```

How the import works and why it was chosen:
- `raw_module` tells wasm-bindgen to emit the specifier **verbatim** in the glue, i.e. `import { loader } from "./brust-app.js"`.
  Nothing is copied at wasm build time. The prebuilt wasm is therefore app-independent, and `brust build` only has to place
  `brust-app.js` next to the glue. Wrangler's esbuild then resolves and bundles it.
- Async calls go through `wasm_bindgen_futures::JsFuture::from(js_loader(&json)).await`, then `as_string()`. Responses are parsed
  with the **same** serde types as native: one JSON string each way, no `serde-wasm-bindgen` tree walk. P2's one-pass
  `LoaderResponse` parse is kept.
- **Rejected: init-time dispatch object.** The `worker-build` shim owns the entry, so handing in an object needs a
  `globalThis` registration plus ordering glue: more generated JS.
- **Rejected: `module = "/…"`.** It copies the file at compile time, so every app would need its own wasm build (R2).

**Why the loader chain stays JS.** The store scope is `AsyncLocalStorage.run` (`server-context.ts:4-14`). If Rust drove the chain
loader by loader, each continuation would resume from `wasm_bindgen_futures`' shared microtask queue. Concurrent requests would
then lose or swap ALS context [I]. So the scope must wrap one JS async function: the existing `makeHandlers.loader`
(`worker.ts:223-251`).

**The minimal generated glue (H3).** `dist/cf/.stage/brust-app.entry.js` is generated by `brust build` and has no hand-written
logic. It is about 25 lines, **~1.2 KB** before bundling [I]:
```js
import * as R from '<app>/routes.tsx'; import J, { stores } from '../jobs.js'; import A from '../actions.js' // if [actions]
import M from '../manifest.json'; import T from './templates.json'
import { makeHandlers, flattenRoutes, mountActions, fetchInScope } from '@brust/core/server-handlers'
const h = makeHandlers({ leaves: flattenRoutes(R.routes ?? R.default).leaves, jobs: J, manifest: M, stores })
const app = mountActions(A, M.actions.prefix).compile()          // startup-phase compile (§8)
export const loader = async (j) => JSON.stringify(await h.loader(JSON.parse(j)))
export const jobs   = async (j) => JSON.stringify(await h.jobs(JSON.parse(j)))
export const action = (req) => fetchInScope(app, req)
export const MANIFEST = JSON.stringify(M), TEMPLATES = T, CONFIG = '<baked runtime config JSON>'
```
Bun bundles this (`target: 'browser'`, `conditions: ['workerd','worker','browser']`, externals `cloudflare:*`, `node:*`) into
`dist/cf/brust-app.js`.

Two checks on the condition set:
- It resolves `react-dom/server` to `server.edge.js`, which exports `renderToString`
  (`node_modules/.bun/react-dom@19.3.0…/react-dom/package.json:59`, `server.edge.js:15`). So `buildJobs`'s
  `renderToString` import (`build/bundle.ts:347,370`) is unchanged.
- `Buffer` in `toRequest` (`actions-bridge.ts:56`) is not on the Cloudflare path, because `fetchInScope` takes a web `Request`.

**Runtime config (`brust.toml`)**
```toml
[cloudflare]                      # presence = target available; `--target cloudflare` selects it
name = "pokedex"                  # worker name (wrangler `name`)
compatibility_date = "2026-10-01" # ≥ 2026-08-04 ⇒ nodejs_compat (ALS) is default (R14)
l1_capacity = 256                 # entries per ISOLATE (native default 1000, config.rs:190)
job_cache_capacity = 512
edge_cache = "off"                # "off" | "workers-cache" (R6, lane M4-CF-7)
stats = false                     # expose /_brust/cache/stats (R11; native always does, pipeline.rs:112)
```
`[actions]` and `[cors]` are read as today. `[server]`/`[workers]` are ignored on this target, with a warning.

**CLI**
- `brust build --target cloudflare [--out-dir dist] [--wasm-from-source]`
- `brust dev --target cloudflare`: the first `dev` verb in v2 (`cli.ts:1-2` has only build/start). It builds, then runs
  `wrangler dev -c dist/cf/wrangler.jsonc`, rebuilding on change.
- `create-app` templates gain `"deploy:cf": "brust build --target cloudflare && wrangler deploy -c dist/cf/wrangler.jsonc"`, with
  `wrangler` as a devDependency.

**Generated `dist/cf/`**
- `shim.mjs`, `index.js`, `index_bg.wasm`: the worker-build output, copied from `@brust/core-cf`. The prebuilt is ~1.2–2 MB
  after `wasm-opt -Oz` [I].
- `brust-app.js`.
- `wrangler.jsonc`, with:
  - `main: "shim.mjs"`
  - `compatibility_date`
  - `assets: { directory: "assets", binding: "ASSETS", run_worker_first: false }`
  - the user's bindings merged from the app-root `wrangler.jsonc` if one exists (R8)
- `assets/_brust/client/*` and `assets/public/*`: URL-mirrored copies of `dist/client`, `dist/public`.
- `assets/_headers`: `immutable` for content-hashed names (parity with `pipeline.rs:206-219,268-279`).

**Toolchain.** `--wasm-from-source`, and brust's release CI, need:
- rustup target `wasm32-unknown-unknown`
- `worker-build` at a pinned version
- the repo's pinned `nightly-2026-09-15` with `rust-src` (`rust-toolchain.toml`), which `--panic-unwind` needs (R7)
- `worker = "0.8.7"`, whose wasm-bindgen 0.2.129 must match the version `worker-build` fetches
  [C https://github.com/cloudflare/workers-rs/blob/main/Cargo.toml]

The app author needs only `wrangler`.

## 5. Caching and store semantics on Workers

| Concern | Native (`brust start`) | Workers | Delta to document |
|---|---|---|---|
| L1 scope | one process, all workers share (`l1.rs:287`) | per isolate; many isolates per colo, recycled at will; JS heap + wasm memory share 128 MB [C limits#memory] | hit rate lower; capacity by entries is risky, so the CF default is 256 and lane 2 adds an optional byte weigher |
| `cache.invalidate` | coherent for the process (napi `cacheInvalidate`, `cache.ts:11-23`) | **only the isolate that ran the action**; others stale ≤ route `ttl` | R5; pokedex `/team` tag shows it |
| F86/F89 read stamps | `InvalClock` (`stamp.rs`) | same clock per isolate, so same guarantees within one isolate | none inside an isolate |
| TTL clock | `Instant` | `Date.now()`, which advances only across I/O on Workers [I] | TTLs coarse within one request: harmless |
| Job cache | moka, content-hashed keys (`inputs.rs:243`) | `LocalJobs`; keys identical, so cross-isolate staleness only for tagged/user-key jobs | as L1 |
| Edge cache | none | `edge_cache="workers-cache"`: Workers Cache with `Cache-Tag` + `ctx.cache.purge({tags})`, global and tiered [C https://developers.cloudflare.com/workers/cache/]; Cache API `caches.default` is per-colo, `delete` local only [C https://developers.cloudflare.com/workers/runtime-apis/cache/] | off by default (R6): it serves without running the Worker, so a `bypass`/cookie-keyed route would leak; allowed only for routes whose key is the default method+path+query |
| gzip | Rust gzip + cached gzip body (`pipeline.rs:771-785`) | `gzip` feature off; identity body, edge compresses [I] | R13 |
| Set-cookie | makes page uncacheable (`pipeline.rs:412,490`) | same; the Cache API also refuses Set-Cookie [C cache page] | none |
| Store scope | ALS per loader chain / ssr job / action (`worker.ts:223`, `actions-bridge.ts:104`) | same code; ALS supported, `enterWith` absent (unused) [C https://developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/] | none |
| App data (KV/D1) | app's business (`bun:sqlite`, `team-db.ts:3`) | app's business, via `import { env } from "cloudflare:workers"`; I/O only inside a request [C https://developers.cloudflare.com/workers/runtime-apis/bindings/#importing-env-as-a-global] | open bindings lazily (`team-db.ts:50` pattern already) |
| `/_brust/cache/stats` | always on | per-isolate numbers; off unless `stats=true` | R11 |

Global state is a deliberate exception to Cloudflare's guidance. The L1 and `Core` live in globals, which Cloudflare advises
against for request-scoped state [C https://developers.cloudflare.com/workers/best-practices/workers-best-practices/]. They hold
only Rust bytes, never JS I/O objects, so "Cannot perform I/O on behalf of a different request" cannot arise.

**workers-rs pieces we use:**
- `#[event(start)]`: panic hook + `Core::new` at startup.
- `#[event(fetch)]`
- `worker::Request` (`method`, `url`, `headers`, `stream`)
- `worker::Response::from_bytes` / `with_headers`
- `Env::assets("ASSETS")`: unused in M4.
- `worker::Cache`: only if `edge_cache` ever grows a Cache-API mode.
- `worker::d1` (the `d1` feature): **not used by brust core**. D1 is the app's data, reached from JS. It stays available for a
  future Rust-side store.

**What workers-rs cannot express (we drop to raw wasm-bindgen):**
1. Calling app JS: the `raw_module` imports above. RPC in the crate is experimental [C https://github.com/cloudflare/workers-rs#rpc-support].
2. ALS scoping: it must wrap a JS async function (§4).
3. `ctx.cache.purge` / Workers Cache: no typed API found [I]; called via `js_sys::Reflect` on the raw context.
4. Threads, tokio multi-thread, moka sync: none on Workers [C https://developers.cloudflare.com/workers/runtime-apis/webassembly/#threading].
5. Panic survival without `--panic-unwind`: the default `panic=abort` "will terminate the isolate"
   [C https://github.com/cloudflare/workers-rs#panic-recovery-with---panic-unwind].
6. Compiling wasm from bytes at runtime: `WebAssembly.compile`/`instantiate(buffer)` are disallowed
   [C https://developers.cloudflare.com/workers/runtime-apis/web-standards/#javascript-standards]. So templates are data, not
   code, which they already are.

## 6. Build, deploy, dev, CI

**`brust build --target cloudflare`** (new `packages/brust/src/build/cloudflare.ts`):
1. Run the normal build into `dist/`, unchanged (`build/index.ts:76-197`).
2. Emit `templates.json` from `dist/jinja/*`.
3. Write the generated entry (§4) and Bun-bundle it into `dist/cf/brust-app.js`.
4. Copy the prebuilt worker-build output from `@brust/core-cf`, or run
   `worker-build --release --panic-unwind crates/brust-wasm` under `--wasm-from-source`.
5. Lay out `assets/` and `_headers`.
6. Write `wrangler.jsonc` (R8).
7. Smoke-check by importing `brust-app.js` under Bun with a `cloudflare:workers` stub. This catches a missing export before
   wrangler does.

The server-only guard (`[build] server_only`) and the actions-prefix checks (`build/index.ts:100-117`) run unchanged.

**Deploy:** `bun run deploy:cf`, which is `wrangler deploy -c dist/cf/wrangler.jsonc`. Static asset requests are free and do not
invoke the Worker [C https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/].

**Dev:** `brust dev --target cloudflare` runs `wrangler dev`, which uses Miniflare/workerd locally with simulated bindings
[C https://developers.cloudflare.com/workers/local-development/#defaults]. D1 local migrations use
`wrangler d1 migrations apply <db> --local` [C https://developers.cloudflare.com/d1/best-practices/local-development/].

**CI (no account).** A new `cf-e2e` job:
1. Install the toolchain from §4.
2. Build `brust-wasm` from source. This is the release artifact path.
3. Build pokedex `--target cloudflare --wasm-from-source`.
4. Run `wrangler d1 migrations apply --local`.
5. Spawn `wrangler dev --local --port 0 -c …` and parse the "Ready on http://…" URL.
6. Run `tests/server/pokedex.test.ts` through a `startPokedexCf()` sibling of `startPokedex` (`tests/server/harness.ts:10-34`).
   Assertions on `loader_calls`/`job_calls` (`pokedex.test.ts:36-38`) stay deterministic because local workerd runs one
   isolate [I]. The job sets `stats=true`.
7. Also run `hydrate.chromium.test.ts` (Playwright, as `ci.yml:136-138`).
8. Size/startup gate: `wrangler deploy --dry-run --outdir` prints size; fail above a budget, e.g. 8 MiB raw.

Tool choice:
- `@cloudflare/vitest-plugin` and `createTestHarness()` are the current programmatic options. `unstable_dev`/
  `unstable_startWorker` are deprecated [C https://developers.cloudflare.com/workers/wrangler/api/#unstable_startworker,
  https://developers.cloudflare.com/workers/testing/vitest-integration/].
- The job reuses the bun:test harness over HTTP rather than adopting Vitest.

## 7. Pokedex-on-Cloudflare dogfood

- `lib/team-db.ts`: `TeamDb` becomes **async** (`list(): Promise<TeamMember[]>` …).
  - The Bun implementation wraps `bun:sqlite` unchanged, with the same SQL and the same `.immediate` add transaction
    (`team-db.ts:30-37`).
  - A new `lib/team-db.d1.ts` uses `env.TEAM_DB.prepare(...).bind(...).run()/first()` [C https://developers.cloudflare.com/d1/worker-api/prepared-statements/].
  - "count + insert ≤ 6" becomes one statement, `INSERT … SELECT … WHERE (SELECT COUNT(*) FROM team) < 6`, plus
    `ON CONFLICT DO NOTHING`. D1 has no interactive transaction across awaits [I].
- Selection: `brust build --target cloudflare` aliases `./lib/team-db` to `./lib/team-db.d1` via a `[cloudflare] alias` table
  (R12).
- `migrations/0001_team.sql` holds the `CREATE TABLE` from `team-db.ts:24-26`.
- `layoutLoader` (`lib/loaders.ts:12-15`) and `actions.ts:22-33` gain `await`. Behaviour is unchanged.
- **What the demo proves:**
  - Jinja native pages, React islands' `ssr` jobs (`renderToString` on workerd), store seeding (`team` store D4), Elysia actions
    with Eden types, a tag invalidate and a 409 problem body, all on one Worker.
  - The dataset is a 152,717-byte JSON import (`data/pokedex.json`), well inside the 64 MiB size limit.
  - It documents the R5 staleness live: a second isolate keeps `/team` up to `ttl` stale.

## 8. Limits and risks

| Limit / risk | Number | Design response |
|---|---|---|
| Worker size | 64 MiB uncompressed, **no compressed limit** (Free and Paid) [C https://developers.cloudflare.com/workers/platform/limits/#worker-size] | the brief's compressed caps are obsolete; the estimate is wasm 1.2–2 MB [I] + `brust-app.js` ~1–1.5 MB (react-dom edge prod 292,617 B + legacy 286,554 B unminified, Elysia, app) [I] ⇒ <4 MB |
| Startup | 1 s to parse and run global scope, error 10021 [C …/limits/#worker-startup-time] | `#[event(start)]` does manifest parse + template compile (pokedex: tens of templates, est. <30 ms [I]) + Elysia `.compile()`; CI dry-run reports `startup_time_ms` |
| CPU / request | Free 10 ms; Paid default 30 s, max 5 min via `limits.cpu_ms` [C …/limits/#cpu-time] | native D costs ≈0.73 ms CPU/request (10 cores / 13,759 rps) [I]; wasm minijinja 1.5–3× plus JS ⇒ est. 1–4 ms, fits Free; HITs are µs |
| Memory | 128 MB per isolate, JS + wasm [C …/limits/#memory] | per-isolate capacities (256/512) + optional byte weigher |
| Threads | none [C …/webassembly/#threading] | single-thread caches; no tokio |
| eval / `new Function` | disallowed, except at **startup** (`allow_eval_during_startup`, default ≥ 2025-06-01) [C https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-eval-during-startup] | **risk:** Elysia's JIT must compile at startup ⇒ generated `.compile()` (§4); a lazy compile on first request would throw. Elysia's CF guide is 1.x-only ("experimental" `CloudflareAdapter`, no `aot:false` since 1.4.7) [C https://elysiajs.com/integrations/cloudflare-worker]; installed 2.0.0-beta.30 ships only `adapter/bun` and `adapter/web-standard` (`node_modules/.bun/elysia@2.0.0-beta.30…/dist/adapter/`) but has a `test:cf` script (`package.json:194`). Lane 3 gate: the pokedex actions app round-trips under workerd |
| Subrequests | Free 50, Paid 10,000 [C …/limits/#subrequests] | brust core makes none; D1 queries count (Free: 50 queries per invocation [C https://developers.cloudflare.com/d1/platform/limits/]) |
| Static assets | Free 20,000 files, Paid 100,000; 25 MiB per file [C …/limits/#static-assets] | hashed chunks are few; documented |
| Panics | abort kills the isolate unless `--panic-unwind` (nightly, build-std) [C workers-rs README] | R7; brust already pins nightly + `rust-src` |
| wasm-bindgen skew | worker 0.8.7 pins 0.2.129 [C] | pin in `brust-wasm/Cargo.toml`; Renovate-style bump lane |
| `Instant`/`RandomState` on wasm32 | `Instant::now` panics; `RandomState` keys weak [I] | `Clock` trait; `LocalL1` uses a fixed hasher (no attacker-controlled HashDoS amplification beyond one isolate) [I] |
| Native regression | bench bar S 113,744 / D 13,759 / I 104,889 rps (`bench/RESULTS.md:9-28`) | lane 1 gate: S/D/I within noise, ≤ 3% delta on two runs (memory: "bench lied 3×"), plus full `cargo test -p brust-server` |

## 9. Milestones (lanes)

All lanes branch from `m4cf`. The lead merges each one. One PR `m4cf → v2` follows the gate.

| # | slug | tier | boundary (files) | goal |
|---|---|---|---|---|
| M4-CF-1 | `m4cf-core-split` | complex | `crates/brust-core` (new), `crates/brust-server/src/**`, `Cargo.toml` | extract `brust-core` + `Host` generic; native host identical; bench S/D/I within noise |
| M4-CF-2 | `m4cf-core-wasm` | standard | `crates/brust-core/src/{host,cache/local}.rs`, feature gates | `cargo check -p brust-core --target wasm32-unknown-unknown` green; `LocalL1`/`LocalJobs` pass the shared F81/F86/F89 conformance suite |
| M4-CF-3 | `m4cf-worker-crate` | complex | `crates/brust-wasm/**`, fixture `tests/fixtures/cf-min` | workers-rs host with raw_module bridge, actions passthrough, `--panic-unwind`; the fixture app serves page/loader/job/action under `wrangler dev`. **First task: prove `raw_module` survives worker-build + wrangler bundling** |
| M4-CF-4 | `m4cf-build-target` | standard | `packages/brust/src/{build/cloudflare.ts,handlers.ts,actions-bridge.ts,worker.ts,cli.ts}`, npm `@brust/core-cf` | `brust build/dev --target cloudflare` emits a complete `dist/cf/`; Bun path unchanged (`bun run ci` + e2e green) |
| M4-CF-5 | `m4cf-pokedex-d1` | standard | `examples/pokedex/{lib/team-db*.ts,migrations,actions.ts,lib/loaders.ts,brust.toml}`, `packages/create-app/templates/*` | async TeamDb, D1 variant, `deploy:cf` in templates |
| M4-CF-6 | `m4cf-ci` | standard | `.github/workflows/ci.yml`, `release.yml`, `tests/server/harness.ts` | `cf-e2e` job (local workerd) + prebuilt wasm artifact in release |
| M4-CF-7 | `m4cf-edge-cache` | complex, optional | `crates/brust-wasm/src/edge.rs`, core tag plumbing | `edge_cache="workers-cache"`: `Cache-Tag` + global `purge({tags})`; closes R5 for eligible routes |
| M4-CF-8 | docs | docs-only | `docs/cloudflare.md` | limits, staleness, D1 recipe; committed straight to the branch, no PR (docs rule) |

Order: 1 → 2 → (3 ∥ 4) → 5 → 6. Lane 7 comes after the gate. The **human** owns the Cloudflare account, the production D1 id and
the npm publish of `@brust/core-cf`.

## 10. Rulings requested

| R | Question | Recommended default | Alternative |
|---|---|---|---|
| R1 | How to split | new `brust-core` crate; `brust-server` = native host; static `Host` generic | `#[cfg(target_arch="wasm32")]` gates inside `brust-server` (less churn, but the wasm build drags tokio/hyper features and invites cfg rot) |
| R2 | Where `worker-build` runs | brust release CI; the app-independent wasm ships as npm `@brust/core-cf`; `--wasm-from-source` for repo dev | run `worker-build` in every `brust build` (needs Rust nightly + wasm32 + worker-build on every app machine) |
| R3 | wasm → app JS import mechanism | `#[wasm_bindgen(raw_module = "./brust-app.js")]` + ~1.2 KB generated entry (§4) | init-time dispatch object via `globalThis` registration (more glue, depends on evaluation order) / `module="/…"` (per-app wasm) |
| R4 | Plan offer (M3-P P6) on Workers | off: loader then jobs as two direct calls | port `plan_in_call` as a wasm export re-entered from JS (saves µs; adds reentrancy surface) |
| R5 | Invalidate coherence | isolate-local, staleness ≤ `ttl` documented; pokedex demo shows it | gate M4 on M4-CF-7 (Workers Cache tag purge) or a DO tag-epoch check per cached request (+1 subrequest) |
| R6 | Edge cache default | `off` | `workers-cache` auto-on for untagged default-key routes |
| R7 | Panics | `worker-build --panic-unwind` on the pinned nightly | default abort (isolate dies; rely on Cloudflare restart) |
| R8 | Wrangler config ownership | the user's app-root `wrangler.jsonc` (bindings, routes, vars) is merged; brust owns `main`/`assets`/`compatibility_date` | brust.toml `[cloudflare]` generates all of it (bindings too) |
| R9 | Product | Workers + Static Assets | Pages (Functions/`_worker.js`): not recommended per Cloudflare's "start new projects with Workers" |
| R10 | Elysia on Workers | Elysia 2 beta + generated startup `.compile()`; lane-3 gate | ship Cloudflare without actions until Elysia 2 documents a Workers adapter |
| R11 | `/_brust/cache/stats` on Cloudflare | off unless `[cloudflare] stats = true` | same as native (always on) |
| R12 | Pokedex DB selection | async `TeamDb` for both + build alias `[cloudflare] alias` → `team-db.d1.ts` | runtime branch on `globalThis.navigator?.userAgent === 'Cloudflare-Workers'` (no alias table, but D1 code is bundled into Bun too) |
| R13 | gzip on Cloudflare | off (identity; edge compresses) | keep Rust gzip (CPU on the 10 ms Free budget) |
| R14 | `compatibility_date` floor | ≥ 2026-08-04 (`nodejs_compat` on by default ⇒ ALS) [C https://developers.cloudflare.com/workers/runtime-apis/nodejs/] | older date + explicit `nodejs_compat` flag |
