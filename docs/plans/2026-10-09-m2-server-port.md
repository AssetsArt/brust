# M2b — `brust-server`: the Rust request path ported from brust-core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: `v2` @a456712

Lead ruling 2026-10-09 (recorded in spec S6 amendments): the four contract notes in Task 2 are ACCEPTED as the manifest contract; m2a emits them (its Task 10), m2c writes them. `/public/<rel>` from `dist/public` and the immutable `Cache-Control` rule on a `-<hex6+>` suffix are accepted as S7 step 1 detail.

**Goal:** A new v2 crate `crates/brust-server` that answers every HTTP request in Rust from a build-time `dist/manifest.json`: routes, L1 cache on JSON context, per-component job cache, at most one `loader` and one `jobs` call to the worker pool, minijinja render on tokio with server-side `Outlet` composition and asset injection — with NO Bun and NO napi in the crate (the worker is a `RenderDispatch` trait object; tests use a fake).

**Architecture:** The hyper accept loop, worker pool, SAB dispatch seam, TLS, CORS, static assets, gzip, route table and the `key_expr` grammar are copied from `main`'s `crates/brust-core` at `d04718f` (table in Task 1, owned by v2 from then on). Everything that used to run in the Bun worker for a page (`handle_request` 447-833, `napi_render_jinja`) is replaced by `pipeline.rs`: manifest → match → L1 → loader verdicts → job keys/cache/batch → `useId` seeds → leaf-first render → asset tags → L1 store. The m2c lane (napi + `@brust/brust`) consumes `brust_server::{Config, start, Server::{register_worker, invalidate, stats, request_drain}}`; the m2a lane (compiler) produces the manifest fields consumed here.

**Tech Stack:** Rust nightly-2026-09-15 (workspace `rust-toolchain.toml`), hyper 1 + hyper-util (auto H1/H2), tokio multi-thread, moka 0.12 (`sync`), matchit 0.9, minijinja 2 (workspace dep; `add_template_owned` is ungated), `brust-jinja` (M1 filters), blake3 1, flate2 1, tokio-rustls 0.26 (aws-lc-rs provider, carried), serde/serde_json (BTreeMap maps → canonical key order), tracing 0.1. Dev: tempfile 3, tracing-subscriber 0.3, hyper `client` feature (as brust-core's dev-dep).

**Spec:** `docs/design/2026-10-09-m2-server-design.md` §1 S1 (call table, SAB rule), §2 S2 (port table), §3 S6 (manifest), §4 S7–S9 (request order, outlet, assets), §5 S10 (caches), §7 (errors, `/_brust/cache/stats`, log line), §8 (env), §10 (tests), §11 (risks). Source of truth for carried code: `/Users/detoro/code/brust` at `d04718f`, `crates/brust-core/src/…` (cited `file:line` per task).

## Global Constraints

- **SAB carries responses only; requests cross as inline JSON.** `brust-core/src/render/dispatch.rs:8-21` records two failed SAB-request attempts. The comment block is copied verbatim into `src/dispatch.rs` and the trait's `call(kind, request_json: String, slot)` keeps the inline `String`. Do not retry.
- **L1 stores JSON context, never HTML or framed bytes.** `cache/l1.rs` value is `Arc<serde_json::Value>` (the merged context after jobs); Rust re-renders on every hit. Store only when status is 200 and no `Set-Cookie` was produced (0.1.x `meta_cacheable`, `server/mod.rs:1809-1815`).
- **No Bun on hit.** A page whose L1 hits, or whose jobs all hit the job cache and has no loader, makes zero `RenderDispatch::call`s. `/_brust/cache/stats` exposes `loader_calls`/`job_calls` so tests prove it; the fake dispatch counts independently.
- **Autoescape None with explicit `| e`.** Every `Environment` is built through `brust_jinja::register` (sets `AutoEscape::None` + `UndefinedBehavior::Chainable`); the server never adds a second escaper and never registers another `e`. Fixture templates write `| e` on every dynamic text/attribute and `| safe` only on `__outlet` / `_ssr_*`.
- **Render runs on tokio**, inside the hyper service task; no render on a worker thread, no blocking I/O after boot (templates are parsed once in `Manifest::load`).
- **Carried modules keep their tests.** Verbatim modules compile with their 0.1.x inline tests unchanged (`body` 7, `tls` 4, `cors` 20, `static_assets` 18, `compress` 5, `key_expr` 22, `pool` 14, `dispatch` 3). Adapted modules keep every test whose subject survives (`routes` 29 of 45, `response_cache`→`l1` 10, `page_cache`→`job_cache` 9, `jinja`→`render` 2 of 4); the port table lists what was dropped and why.
- **Boot fails closed** (spec §7): manifest `version != 1`, a route whose `chain` names an unknown component, a missing template or chunk file, a child `props` map that does not cover a job input root → `Manifest::load` returns `Err` naming the path/id; `start` returns that `Err`; no partial boot.
- **Boundary:** `crates/brust-server/**`, root `Cargo.toml` (members), `Cargo.lock`, `docs/design/brust-core-port.md`. No edits to `brust-jinja`, `brust-compiler`, packages, or CI (the CI `server` job is the m2c lane's).

## Review Focus

1. **A hit that still wakes Bun.** Any path where L1 HIT or all-jobs-hit calls `dispatch.call` — Task 7 pins it (`hit_makes_zero_dispatch_calls`, `static_route_makes_zero_calls_on_first_request`, `all_jobs_cached_makes_zero_calls`).
2. **Job key collisions across different inputs.** `null` vs `{}` (F33), reordered object keys, a per-row key that depends on row position instead of row content — Task 3 pins all three.
3. **Caching a non-200 or a cookie-setting response.** `notFound` verdict (404) or a loader that returns `Set-Cookie` must never land in L1 — Task 7 pins it (`not_found_verdict_is_404_with_own_template_and_not_cached`).
4. **Outlet / asset composition order.** Child HTML must land in the parent's `__outlet`, assets before `</body>` exactly once, none when every chain component is static — Task 6 unit-pins, Task 7 end-to-end pins.
5. **Worker starvation.** A dispatch that never resolves must produce 503 after `claim_timeout_ms`, not a hung connection, and the claim must be released on every return path — Task 8 pins it with a never-completing fake.

---

### Task 1: Crate skeleton, port table, verbatim modules

**Files:** `Cargo.toml` (add member), `crates/brust-server/Cargo.toml`, `crates/brust-server/src/lib.rs`, `src/server/{mod.rs,body.rs,tls.rs,cors.rs,static_assets.rs}`, `src/http/{mod.rs,compress.rs}`, `src/cache/{mod.rs,key_expr.rs}`, `src/config.rs` (only `CorsConfig` for now), `docs/design/brust-core-port.md`

**Interfaces**
- Consumes: `/Users/detoro/code/brust/crates/brust-core/src/{server/body.rs (340 lines, 7 tests), server/tls.rs (227, 4), server/cors.rs (517, 20), server/static_assets.rs (307, 18), http/compress.rs (176, 5), cache/key_expr.rs (405, 22)}` at `d04718f`; `config.rs:27-78` (`CorsConfig` + `validate`).
- Produces: crate `brust-server` compiling with those six modules and their 76 tests green; `docs/design/brust-core-port.md` (the risk-table mitigation, spec §11).

- [ ] Add `"crates/brust-server"` to `[workspace] members` in `/Users/detoro/code/brust-v2/Cargo.toml`.
- [ ] Write `crates/brust-server/Cargo.toml`:
  ```toml
  [package]
  name = "brust-server"
  version.workspace = true
  edition.workspace = true
  license.workspace = true
  description = "brust v2 HTTP server: manifest routing, L1/job caches, minijinja render, worker dispatch seam"

  [dependencies]
  brust-jinja.workspace = true
  minijinja.workspace = true
  serde.workspace = true
  serde_json.workspace = true
  thiserror.workspace = true
  parking_lot = "0.12"
  tracing = "0.1"
  once_cell = "1"
  matchit = "0.9"
  percent-encoding = "2.3"
  moka = { version = "0.12", features = ["sync"] }
  flate2 = "1"
  blake3 = "1"
  bytes = "1"
  tokio = { version = "1", features = ["rt-multi-thread", "net", "io-util", "macros", "sync", "time", "fs"] }
  tokio-stream = "0.1"
  hyper = { version = "1", features = ["http1", "http2", "server"] }
  hyper-util = { version = "0.1", features = ["tokio", "server-auto"] }
  http = "1"
  http-body = "1"
  http-body-util = "0.1"
  tokio-rustls = "0.26"
  rustls = "0.23"
  rustls-pemfile = "2"

  [dev-dependencies]
  tempfile = "3"
  tracing-subscriber = "0.3"
  hyper = { version = "1", features = ["client"] }
  hyper-util = { version = "0.1", features = ["tokio", "client-legacy", "http1"] }

  [lints]
  workspace = true
  ```
- [ ] Copy verbatim (`cp` from the 0.1.x checkout, then fix only `use crate::…` paths): `server/body.rs`, `server/tls.rs`, `server/cors.rs`, `server/static_assets.rs`, `http/compress.rs`, `cache/key_expr.rs`. `cors.rs:25` imports `crate::config::CorsConfig` — create `src/config.rs` holding `CorsConfig` + `impl CorsConfig { is_wildcard, validate }` copied from `config.rs:27-78`. `static_assets.rs:5` imports `crate::server::body::{ResponseBody, resp, resp_head}` — unchanged path.
- [ ] `src/lib.rs` for this task:
  ```rust
  //! brust v2 server. No Bun, no napi: the worker is a `RenderDispatch` trait object.
  #![deny(clippy::all)]
  pub mod cache;
  pub mod config;
  pub mod http;
  pub mod server;
  ```
  `src/cache/mod.rs`: `pub mod key_expr;` · `src/http/mod.rs`: `pub mod compress;` · `src/server/mod.rs` for now: `pub mod body; pub(crate) mod cors; pub mod static_assets; pub mod tls;` (the accept loop arrives in Task 7).
- [ ] Silence the only expected dead-code warnings in this task with targeted `#[allow(dead_code)]` on `cors::ResolvedCors`, `static_assets::is_safe_css_filename`, `body::{error_400,error_411,error_413,error_415,response_from_framed_bytes,channel_body,empty_body}` — Task 7 removes the allows it makes live; leftover allows at the end of the lane are a review finding.
- [ ] Run `cargo test -p brust-server 2>&1 | tail -3` → expect `test result: ok. 76 passed`. Run `cargo clippy -p brust-server --no-deps -- -D warnings` → clean.
- [ ] Write `docs/design/brust-core-port.md`:
  ```markdown
  # brust-core → brust-server port table
  Source: github.com/AssetsArt/brust `main` @ d04718f, `crates/brust-core/src/`. Copied once (2026-10-09), owned by v2; `main` fixes are NOT auto-merged — re-port by hand and bump the SHA column.
  | v2 module | source | treatment | tests (src → v2) |
  |---|---|---|---|
  | server/body.rs | server/body.rs | carry verbatim | 7 → 7 |
  | server/tls.rs | server/tls.rs | carry verbatim | 4 → 4 |
  | server/cors.rs | server/cors.rs | carry verbatim | 20 → 20 |
  | server/static_assets.rs | server/static_assets.rs | carry verbatim | 18 → 18 |
  | http/compress.rs | http/compress.rs | carry verbatim | 5 → 5 |
  | cache/key_expr.rs | cache/key_expr.rs | carry verbatim | 22 → 22 |
  | config.rs CorsConfig | config.rs:27-78 | carry verbatim | 0 |
  | (filled by Tasks 2–8: routes, l1, job_cache, pool, dispatch, render, config, server/mod) |
  Not carried (spec S2): cache/island_cache.rs, render/stream.rs, realtime/*, routing/action.rs, `/_brust/islands`, `/_brust/page`, MCP, SSE/WS, AI, `handle_action`, `dispatch_streaming`, `spawn_chunk_pump`.
  ```
- [ ] Commit `feat(server): brust-server crate skeleton + verbatim carries (body, tls, cors, static_assets, compress, key_expr) + port table`.

---

### Task 2: Manifest + RouteTable from the manifest

**Files:** `src/manifest.rs`, `src/routing/{mod.rs,routes.rs}`, `tests/fixtures/dist/manifest.json`, `tests/fixtures/dist/jinja/*.jinja`, `tests/fixtures/dist/client/*.js`, `tests/fixtures/dist/public/app.css`, `tests/manifest.rs`, `docs/design/brust-core-port.md` (row for routes)

**Interfaces**
- Consumes: spec §3 S6 JSON; `routing/routes.rs:1-631` (1497 lines, 45 tests) — keep `CompiledCache` (:12-17), `RequestEnvelope` (:31-41), `MatchResult` (:216-228, drop `envelope.kind`), `RouteConfig` (:230-250, drop `native_template`), `RouteTable` + `install_with_config` + `compiled_cache_for` + `cache_for` + `match_path` (:252-448), `RouteInstallError` (:450-460), `build_request_envelope` (:462-524), `decode_path_param` (:535-562), `url_decode` (:566-600), `select_not_found` (:618-631). Drop: `ActionEnvelope/McpEnvelope/SseEnvelope/WsEnvelope` + their `build_*` (:68-213), `native_template_for` (:367-372), `rewrite_envelope_kind` (:645-651), and the 16 tests that exercise them (`action_envelope_*` ×4, `mcp_envelope_*` ×2, `sse_envelope_*` ×2, `ws_envelope_*` ×2, `swap_render_to_navigation`, `replaces_only_first_occurrence`, `missing_kind_returns_input_unchanged`, `route_table_natives_indexed_by_route_id`, `envelope_includes_native_template_when_set`, `envelope_omits_native_template_when_unset`); adapt `render_envelope_has_kind_discriminant` to assert `route_id`+`path` instead of `kind`; delete the 16 `native_template: None,` struct-literal lines. 29 tests remain.
- Produces (public, consumed by m2a as the contract it must emit, by m2c as `start(Config{dist_dir})`):
  ```rust
  // src/manifest.rs — spec §3 S6, field names exact. BTreeMap so iteration is deterministic.
  #[derive(Debug, Deserialize)] pub struct Manifest { pub version: u32, pub routes: Vec<RouteRecord>, pub components: BTreeMap<String, ComponentRecord>, pub assets: Assets, pub jobs_module: String }
  #[derive(Debug, Clone, Deserialize)] pub struct RouteRecord { pub id: String, pub pattern: String, pub chain: Vec<String>, pub loaders: Vec<String>, pub cache: Option<RouteCache>, pub catch_all: bool }
  #[derive(Debug, Clone, Deserialize)] pub struct RouteCache { pub ttl_seconds: u64, #[serde(default)] pub prefix: Option<String>, #[serde(default)] pub bypass: Option<BypassSpec>, #[serde(default)] pub tags: Vec<String> }
  #[derive(Debug, Clone, Deserialize)] #[serde(untagged)] pub enum BypassSpec { Always(bool), Expr(String) }   // response_cache.rs:15-20
  #[derive(Debug, Clone, Deserialize)] pub struct ComponentRecord { pub tier: Tier, pub template: String, #[serde(default)] pub jobs: Vec<JobRecord>, #[serde(default)] pub children: Vec<ChildRecord>, #[serde(default)] pub client: Option<String>, #[serde(default)] pub needs_worker: bool, #[serde(default)] pub use_id_slots: u32 }
  #[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)] #[serde(rename_all = "lowercase")] pub enum Tier { Static, Native, React }
  #[derive(Debug, Clone, Deserialize)] pub struct JobRecord { pub id: String, pub kind: JobKind, pub inputs: Vec<String>, #[serde(default)] pub per_instance: Option<String>, #[serde(default)] pub cache: JobCache }
  #[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)] #[serde(rename_all = "lowercase")] pub enum JobKind { Precompute, Ssr }
  #[derive(Debug, Clone, Default, Deserialize)] pub struct JobCache { #[serde(default)] pub key: Option<String>, #[serde(default)] pub tags: Vec<String>, #[serde(default)] pub ttl_seconds: Option<u64> }
  #[derive(Debug, Clone, Deserialize)] pub struct ChildRecord { pub id: String, pub instances: Instances, #[serde(default)] pub props: BTreeMap<String, String> }
  #[derive(Debug, Clone, PartialEq, Eq)] pub enum Instances { Static, PerRow(String) }  // custom Deserialize: "static" | "per-row:<list path>"
  #[derive(Debug, Clone, Deserialize)] pub struct Assets { pub runtime: String, #[serde(default)] pub react: Option<String> }
  pub struct Loaded { pub manifest: Manifest, pub templates: BTreeMap<String, String> /* component id → source */, pub dist_dir: PathBuf }
  impl Manifest { pub fn load(dist_dir: &Path) -> Result<Loaded, ManifestError>; }
  #[derive(Debug, thiserror::Error)] pub enum ManifestError { #[error("read {path}: {source}")] Read { path: PathBuf, source: std::io::Error }, #[error("parse {path}: {source}")] Parse { path: PathBuf, source: serde_json::Error }, #[error("manifest version {0} unsupported (want 1)")] Version(u32), #[error("route {route}: unknown component {component}")] UnknownComponent { route: String, component: String }, #[error("component {component}: missing file {path}")] MissingFile { component: String, path: PathBuf }, #[error("component {component}: child {child} job {job} input root {root} is not in the child's `props` map")] UncoveredInput { component: String, child: String, job: String, root: String } }
  // src/routing/routes.rs
  pub struct RouteConfig { pub path: String, pub cache: Option<RouteCache>, pub not_found: bool, pub not_found_prefix: String }
  impl RouteTable { pub fn from_manifest(m: &Manifest) -> Result<Self, RouteInstallError>; pub fn match_path<'a>(&self, method: &'a str, full_path: &'a str, headers: &'a http::HeaderMap) -> MatchResult<'a>; pub fn route_index(&self, route_id: u32) -> usize; }
  pub enum MatchResult<'a> { Matched { route_id: u32, envelope: RouteEnvelope<'a> }, NotFound { route_id: u32, envelope: RouteEnvelope<'a> }, NoMatch }
  #[derive(Serialize)] pub struct RouteEnvelope<'a> { pub route_id: u32, pub path: &'a str, #[serde(serialize_with = "serialize_as_map")] pub params: Vec<(Cow<'a, str>, Cow<'a, str>)>, pub req: RequestEnvelope<'a> }
  ```
  **Contract notes for m2a (record in the port doc's "manifest notes"):** (1) `per_instance` is the **context path of the list** (`"pokemon.moves"`), not the client member `_l1`; (2) `ChildRecord.props` maps each child prop name → a parent-context path, with the literal `[idx]` standing for the current row of `per_instance` (`"move": "pokemon.moves[idx]"`); it must cover the root segment of every `inputs` entry of the child's jobs (boot rule `UncoveredInput`); (3) `inputs` are relative to the component's props (`"item.price"`, as the M1 IR emits); a leading `props.` segment (spec §3 example) is accepted and stripped; (4) `k` in `__<childId>_<k>` is the 1-based ordinal of that child id within `children` (template order). Flag (1)–(2) to the lead as an additive extension of S6.
- Fixture: `tests/fixtures/dist/manifest.json` (hand-written, exact S6 shape; this is the M2 integration contract):
  ```json
  { "version": 1,
    "routes": [
      { "id": "r1", "pattern": "/",               "chain": ["appLayout_a1", "homePage_b2"],     "loaders": [],     "cache": null, "catch_all": false },
      { "id": "r2", "pattern": "/pokemon/{name}", "chain": ["appLayout_a1", "detailPage_c3"],   "loaders": ["r2"], "cache": { "ttl_seconds": 60, "prefix": null, "bypass": null, "tags": ["pokemon"] }, "catch_all": false },
      { "id": "r3", "pattern": "/tenant",         "chain": ["appLayout_a1", "tenantPage_e5"],   "loaders": ["r3"], "cache": { "ttl_seconds": 60, "prefix": "header(x-tenant)", "bypass": "cookie(session)", "tags": [] }, "catch_all": false },
      { "id": "r4", "pattern": "*",               "chain": ["appLayout_a1", "notFoundPage_f6"], "loaders": [],     "cache": null, "catch_all": true },
      { "id": "r5", "pattern": "/team",           "chain": ["appLayout_a1", "teamPage_g7"],     "loaders": ["r5"], "cache": null, "catch_all": false },
      { "id": "r6", "pattern": "/ids",            "chain": ["appLayout_a1", "idsPage_i9"],      "loaders": [],     "cache": null, "catch_all": false }
    ],
    "components": {
      "appLayout_a1":    { "tier": "static", "template": "jinja/appLayout_a1.jinja", "jobs": [], "children": [], "client": null, "needs_worker": false, "use_id_slots": 0 },
      "homePage_b2":     { "tier": "static", "template": "jinja/homePage_b2.jinja", "jobs": [], "children": [], "client": null, "needs_worker": false, "use_id_slots": 0 },
      "detailPage_c3":   { "tier": "native", "template": "jinja/detailPage_c3.jinja",
                           "jobs": [ { "id": "j0", "kind": "precompute", "inputs": ["pokemon.stats"], "per_instance": null, "cache": { "key": null, "tags": [], "ttl_seconds": null } } ],
                           "children": [ { "id": "moveCard_d4", "instances": "per-row:pokemon.moves", "props": { "move": "pokemon.moves[idx]" } } ],
                           "client": "client/detailPage_c3-1a2b3c.js", "needs_worker": true, "use_id_slots": 0 },
      "moveCard_d4":     { "tier": "static", "template": "jinja/moveCard_d4.jinja",
                           "jobs": [ { "id": "j0", "kind": "precompute", "inputs": ["move.name"], "per_instance": null, "cache": { "key": null, "tags": ["moves"], "ttl_seconds": 30 } } ],
                           "children": [], "client": null, "needs_worker": true, "use_id_slots": 0 },
      "tenantPage_e5":   { "tier": "static", "template": "jinja/tenantPage_e5.jinja", "jobs": [], "children": [], "client": null, "needs_worker": false, "use_id_slots": 0 },
      "notFoundPage_f6": { "tier": "static", "template": "jinja/notFoundPage_f6.jinja", "jobs": [], "children": [], "client": null, "needs_worker": false, "use_id_slots": 0 },
      "teamPage_g7":     { "tier": "native", "template": "jinja/teamPage_g7.jinja", "jobs": [], "children": [ { "id": "teamBuilder_h8", "instances": "static", "props": { "team": "team" } } ], "client": "client/teamPage_g7-4d5e6f.js", "needs_worker": true, "use_id_slots": 0 },
      "teamBuilder_h8":  { "tier": "react",  "template": "jinja/teamBuilder_h8.jinja", "jobs": [ { "id": "ssr", "kind": "ssr", "inputs": ["team"], "per_instance": null, "cache": { "key": null, "tags": [], "ttl_seconds": null } } ], "children": [], "client": "client/react-teamBuilder_h8.js", "needs_worker": true, "use_id_slots": 0 },
      "idsPage_i9":      { "tier": "native", "template": "jinja/idsPage_i9.jinja", "jobs": [], "children": [], "client": "client/idsPage_i9-7a8b9c.js", "needs_worker": false, "use_id_slots": 2 }
    },
    "assets": { "runtime": "client/runtime-8b1c.js", "react": "client/react-19.2.0.js" },
    "jobs_module": "jobs.js" }
  ```
  Templates (M1 conventions, every dynamic output `| e`, outlet `| safe`; one line each):
  `appLayout_a1.jinja`: `<!doctype html><html><head><title>fx</title></head><body><nav>fx</nav>{{ __outlet | safe }}</body></html>`
  `homePage_b2.jinja`: `<main><h1>Home</h1></main>`
  `detailPage_c3.jinja`: `<main x-data="detailPage_c3" x-props='{{ {"pokemon": pokemon} | json_attr }}'><h1>{{ pokemon["name"] | e }}</h1><p>{{ _s1 | e }}</p><ul>{% for m in pokemon["moves"] %}{% set _i1 = loop.index0 %}<li>{{ m["name"] | e }}: {{ __moveCard_d4_1[_i1]["_s1"] | e }}</li>{% endfor %}</ul></main>`
  `moveCard_d4.jinja`: `<li>{{ move["name"] | e }}: {{ _s1 | e }}</li>`
  `tenantPage_e5.jinja`: `<main><p>{{ who | e }}</p></main>`
  `notFoundPage_f6.jinja`: `<main><h1>Not found: {{ path | e }}</h1></main>`
  `teamPage_g7.jinja`: `<main><brust-island data-brust-island="teamBuilder_h8" x-props='{{ {"team": team} | json_attr }}'>{{ _ssr_teamBuilder_h8 | safe }}</brust-island></main>`
  `teamBuilder_h8.jinja`: `{{ _ssr_teamBuilder_h8 | safe }}`
  `idsPage_i9.jinja`: `<main><input id="{{ _id1 | attr_str | e }}"><label for="{{ _id2 | attr_str | e }}">x</label></main>`
  Chunks: `client/{runtime-8b1c,react-19.2.0,detailPage_c3-1a2b3c,teamPage_g7-4d5e6f,react-teamBuilder_h8,idsPage_i9-7a8b9c}.js` each containing `// fixture\n`; `public/app.css` containing `body{margin:0}\n`.

- [ ] Write `tests/manifest.rs` first (red):
  ```rust
  use brust_server::manifest::{Instances, Manifest, ManifestError, Tier};
  fn fx() -> std::path::PathBuf { std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/dist") }
  #[test] fn loads_fixture_and_reads_every_template() {
      let l = Manifest::load(&fx()).unwrap();
      assert_eq!(l.manifest.routes.len(), 6);
      assert_eq!(l.manifest.components["detailPage_c3"].tier, Tier::Native);
      assert_eq!(l.manifest.components["detailPage_c3"].children[0].instances, Instances::PerRow("pokemon.moves".into()));
      assert!(l.templates["appLayout_a1"].contains("__outlet"));
  }
  #[test] fn missing_template_fails_with_path() {
      let tmp = tempfile::tempdir().unwrap();
      std::fs::copy(fx().join("manifest.json"), tmp.path().join("manifest.json")).unwrap();
      let err = Manifest::load(tmp.path()).unwrap_err();
      match err { ManifestError::MissingFile { component, path } => { assert_eq!(component, "appLayout_a1"); assert!(path.ends_with("jinja/appLayout_a1.jinja")); } e => panic!("{e}") }
  }
  #[test] fn wrong_version_is_rejected() { /* write {"version":2,...} minimal → Err(Version(2)) */ }
  #[test] fn uncovered_child_input_is_rejected() { /* copy fixture dir, strip `"props"` from detailPage_c3's child → Err(UncoveredInput{child:"moveCard_d4", job:"j0", root:"move"}) */ }
  ```
- [ ] Implement `src/manifest.rs`: `load` = read+parse `manifest.json` → `Version` check → for every route, every `chain` id must exist in `components` (`UnknownComponent`) → for every component, `std::fs::read_to_string(dist_dir.join(&template))` (`MissingFile`), `client` file must exist if `Some` (`MissingFile`) → `assets.runtime` and `assets.react` (if `Some`) must exist → for every child record, for every job of the child component, `root(input) ∈ child.props.keys()` else `UncoveredInput` (root = text before the first `.` or `[`, with a leading `props.` stripped).
  ```rust
  impl<'de> Deserialize<'de> for Instances {
      fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
          let s = String::deserialize(d)?;
          match s.as_str() {
              "static" => Ok(Instances::Static),
              _ => s.strip_prefix("per-row:").filter(|p| !p.is_empty()).map(|p| Instances::PerRow(p.to_string()))
                  .ok_or_else(|| serde::de::Error::custom(format!("instances: want \"static\" or \"per-row:<list path>\", got {s:?}"))),
          }
      }
  }
  pub(crate) fn input_root(input: &str) -> &str {
      let s = input.strip_prefix("props.").unwrap_or(input);
      s.split(['.', '[']).next().unwrap_or(s)
  }
  impl Manifest {
      pub fn load(dist_dir: &Path) -> Result<Loaded, ManifestError> {
          let mpath = dist_dir.join("manifest.json");
          let raw = std::fs::read(&mpath).map_err(|source| ManifestError::Read { path: mpath.clone(), source })?;
          let manifest: Manifest = serde_json::from_slice(&raw).map_err(|source| ManifestError::Parse { path: mpath.clone(), source })?;
          if manifest.version != 1 { return Err(ManifestError::Version(manifest.version)); }
          let must_exist = |component: &str, rel: &str| -> Result<PathBuf, ManifestError> {
              let p = dist_dir.join(rel);
              if p.is_file() { Ok(p) } else { Err(ManifestError::MissingFile { component: component.into(), path: p }) }
          };
          for r in &manifest.routes {
              for c in &r.chain {
                  if !manifest.components.contains_key(c) { return Err(ManifestError::UnknownComponent { route: r.id.clone(), component: c.clone() }); }
              }
          }
          let mut templates = BTreeMap::new();
          for (id, c) in &manifest.components {
              let tp = must_exist(id, &c.template)?;
              templates.insert(id.clone(), std::fs::read_to_string(&tp).map_err(|source| ManifestError::Read { path: tp, source })?);
              if let Some(cl) = &c.client { must_exist(id, cl)?; }
              for ch in &c.children {
                  let Some(child) = manifest.components.get(&ch.id) else { return Err(ManifestError::UnknownComponent { route: id.clone(), component: ch.id.clone() }); };
                  for j in &child.jobs { for i in &j.inputs {
                      let root = input_root(i);
                      if !ch.props.contains_key(root) { return Err(ManifestError::UncoveredInput { component: id.clone(), child: ch.id.clone(), job: j.id.clone(), root: root.into() }); }
                  } }
              }
          }
          must_exist("assets", &manifest.assets.runtime)?;
          if let Some(r) = &manifest.assets.react { must_exist("assets", r)?; }
          Ok(Loaded { manifest, templates, dist_dir: dist_dir.to_path_buf() })
      }
  }
  ```
- [ ] Carry `routing/routes.rs` per the Interfaces list; `from_manifest` builds `RouteConfig` per route in manifest order (`route_id == index`): `path = pattern`, `not_found = catch_all`, `not_found_prefix = ""` for M2 (catch-alls are root-level in `defineRoutes`; nested prefixes are M3 — keep `select_not_found` verbatim so they work when the compiler emits them) — then `install_with_config`. `CompiledCache` parsing of `prefix`/`bypass` is unchanged (`routes.rs:303-333`). Add to the 29 carried tests: `from_manifest_installs_catch_all_outside_matchit` (fixture: `/nope` → `NotFound{route_id:3}`, `/pokemon/pikachu` → `Matched{route_id:1}` with `params[0] == ("name","pikachu")`).
- [ ] `cargo test -p brust-server` → `76 + 4 (manifest) + 30 (routes) = 110 passed`. Add the routes row to the port doc (`routing/routes.rs | adapt: RouteConfig from manifest, envelopes reduced to loader `req` | 45 → 30 (16 dropped with action/mcp/sse/ws/native-template/rewrite, 1 added)`).
- [ ] Commit `feat(server): manifest loader (spec S6, fail-closed boot) + RouteTable from manifest; fixture dist/`.

---

### Task 3: Input evaluation and job keys

**Files:** `src/inputs.rs`, `tests/inputs.rs`

**Interfaces**
- Consumes: `serde_json::Value` loader context; `JobRecord.inputs`, `ChildRecord.props`, `JobCache.key`.
- Produces:
  ```rust
  /// Dotted path with optional `[<n>]`/`[idx]` segments: `a.b`, `a[0].b`, `list[idx].name`. A leading `props.` is stripped.
  pub struct Path(Vec<Seg>);  pub enum Seg { Key(String), Index(usize), Idx }
  impl Path { pub fn parse(s: &str) -> Result<Path, String>; pub fn root(&self) -> &str; pub fn get<'v>(&self, ctx: &'v Value, idx: Option<usize>) -> &'v Value /* Null when absent or Idx without a row */; }
  /// The object a job receives: every `inputs` path materialised at its own position (`{"item":{"price":3}}` for `item.price`).
  pub fn project(ctx: &Value, inputs: &[String], idx: Option<usize>) -> Result<Value, String>;
  /// Child props object from the parent's context through `ChildRecord.props` (`[idx]` = row).
  pub fn child_props(parent_ctx: &Value, props: &BTreeMap<String, String>, idx: Option<usize>) -> Result<Value, String>;
  /// Canonical bytes: serde_json with BTreeMap maps (sorted keys), no whitespace.
  pub fn canonical(v: &Value) -> Vec<u8>;
  /// blake3 hex of canonical(inputs_value); `component_id`/`job_id` are mixed in as length-prefixed fields so (a,bc) != (ab,c).
  pub fn job_key(component_id: &str, job_id: &str, inputs_value: &Value) -> String;
  ```
- [ ] Tests first (`tests/inputs.rs`):
  ```rust
  use brust_server::inputs::{canonical, child_props, job_key, project, Path};
  use serde_json::{json, Value};
  #[test] fn path_reads_dotted_and_indexed() { let c = json!({"a":{"b":[{"n":1},{"n":2}]}}); assert_eq!(Path::parse("a.b[1].n").unwrap().get(&c, None), &json!(2)); assert_eq!(Path::parse("props.a.b[idx].n").unwrap().get(&c, Some(0)), &json!(1)); assert_eq!(Path::parse("a.zz").unwrap().get(&c, None), &Value::Null); }
  #[test] fn project_materialises_only_read_paths() { let c = json!({"item":{"id":"p1","name":"Mug","price":3}}); assert_eq!(project(&c, &["item.price".into()], None).unwrap(), json!({"item":{"price":3}})); }
  #[test] fn null_and_empty_object_hash_differently() { let a = job_key("c","j",&json!({"user":null})); let b = job_key("c","j",&json!({"user":{}})); assert_ne!(a, b); assert_eq!(a.len(), 64); }
  #[test] fn key_is_independent_of_object_key_order() { let a: Value = serde_json::from_str(r#"{"b":1,"a":{"y":2,"x":1}}"#).unwrap(); let b: Value = serde_json::from_str(r#"{"a":{"x":1,"y":2},"b":1}"#).unwrap(); assert_eq!(canonical(&a), canonical(&b)); assert_eq!(job_key("c","j",&a), job_key("c","j",&b)); }
  #[test] fn per_row_key_depends_on_row_content_not_position() { let c = json!({"moves":[{"name":"tackle"},{"name":"growl"},{"name":"tackle"}]}); let props = [("move".to_string(), "moves[idx]".to_string())].into_iter().collect(); let k = |i| job_key("moveCard_d4","j0",&project(&child_props(&c,&props,Some(i)).unwrap(), &["move.name".into()], None).unwrap()); assert_eq!(k(0), k(2)); assert_ne!(k(0), k(1)); }
  #[test] fn component_and_job_ids_are_length_prefixed() { assert_ne!(job_key("a","bc",&json!(1)), job_key("ab","c",&json!(1))); }
  ```
- [ ] Implement: `canonical` = `serde_json::to_vec(v)` (workspace serde_json has no `preserve_order` → `Map` is a `BTreeMap`; add the test `canonical(&json!({"b":1,"a":2})) == b"{\"a\":2,\"b\":1}"` so a future `preserve_order` feature unification fails loudly). `project` rebuilds nested objects (`serde_json::Map`) along each path; an `Idx` segment is replaced by the row (`Seg::Index(idx)`), erroring when `idx` is `None`.
  ```rust
  impl Path {
      pub fn parse(s: &str) -> Result<Path, String> {
          let s = s.strip_prefix("props.").unwrap_or(s);
          let mut segs = Vec::new();
          for part in s.split('.') {
              let (head, rest) = match part.find('[') { Some(i) => (&part[..i], &part[i..]), None => (part, "") };
              if head.is_empty() && segs.is_empty() { return Err(format!("input path {s:?}: empty segment")); }
              if !head.is_empty() { segs.push(Seg::Key(head.to_string())); }
              let mut rest = rest;
              while let Some(r) = rest.strip_prefix('[') {
                  let Some(end) = r.find(']') else { return Err(format!("input path {s:?}: unclosed '['")); };
                  segs.push(match &r[..end] { "idx" => Seg::Idx, n => Seg::Index(n.parse().map_err(|_| format!("input path {s:?}: bad index {n:?}"))?) });
                  rest = &r[end + 1..];
              }
          }
          Ok(Path(segs))
      }
      pub fn root(&self) -> &str { match &self.0[0] { Seg::Key(k) => k, _ => "" } }
      pub fn get<'v>(&self, ctx: &'v Value, idx: Option<usize>) -> &'v Value {
          static NULL: Value = Value::Null;
          let mut cur = ctx;
          for seg in &self.0 {
              cur = match seg {
                  Seg::Key(k) => cur.get(k).unwrap_or(&NULL),
                  Seg::Index(i) => cur.get(*i).unwrap_or(&NULL),
                  Seg::Idx => match idx { Some(i) => cur.get(i).unwrap_or(&NULL), None => &NULL },
              };
          }
          cur
      }
  }
  pub fn canonical(v: &Value) -> Vec<u8> { serde_json::to_vec(v).expect("Value serialises") }
  pub fn job_key(component_id: &str, job_id: &str, inputs_value: &Value) -> String {
      let mut h = blake3::Hasher::new();
      for field in [component_id.as_bytes(), job_id.as_bytes(), &canonical(inputs_value)] {
          h.update(&(field.len() as u32).to_le_bytes());
          h.update(field);
      }
      h.finalize().to_hex().to_string()
  }
  ```
- [ ] `cargo test -p brust-server --test inputs` → `7 passed`. Commit `feat(server): job input evaluation (dotted paths, [idx] rows, projection) + blake3 canonical job keys (F33 null vs {})`.

---

### Task 4: Job cache and L1

**Files:** `src/cache/{mod.rs,job_cache.rs,l1.rs}`, port doc rows

**Interfaces**
- Consumes: `cache/response_cache.rs` (537 lines, 10 tests: `CacheKey` :36-42, `ResponseExpiry` :62-83, `CacheStats` :86-92, `ResponseCache` :97-287) → `l1.rs`; `cache/page_cache.rs` (215 lines, 9 tests) tags pattern → `job_cache.rs`.
- Produces:
  ```rust
  // src/cache/l1.rs — response_cache.rs with the value re-typed; API otherwise byte-for-byte.
  #[derive(Debug, Clone, PartialEq, Eq, Hash)] pub struct CacheKey { pub prefix: String, pub method: String, pub path: String, pub sorted_query: String }
  #[derive(Clone)] pub struct CachedEntry { pub ctx: Arc<serde_json::Value>, pub ttl: Duration, pub tags: Arc<[String]> }
  #[derive(Debug, Clone, Serialize)] pub struct CacheStats { pub hits: u64, pub misses: u64, pub len: usize, pub capacity: usize }
  pub struct L1Cache { /* moka::sync::Cache<CacheKey, CachedEntry> + tag_index + hits/misses, as response_cache.rs:97-112 */ }
  impl L1Cache { pub fn new() -> Self; pub fn with_capacity(max: u64) -> Self; pub fn get(&self, key: &CacheKey) -> Option<Arc<Value>>; pub fn insert(&self, key: CacheKey, ctx: Arc<Value>, ttl: Duration, tags: &[String]); pub fn stats(&self) -> CacheStats; pub fn invalidate_path(&self, method: &str, path: &str) -> usize; pub fn invalidate_tags(&self, tags: &[String]) -> usize; pub fn clear(&self) -> usize; }
  pub fn build_cache_key(method: &str, full_path: &str, prefix: String) -> CacheKey;   // server/mod.rs:1787-1798 + sort_query :1817-1824, moved here with its test :1888-1894
  // src/cache/job_cache.rs
  #[derive(Debug, Clone, PartialEq, Eq, Hash)] pub struct JobKey(pub String);   // job_key() hex, or `cache({key})`'s evaluated key prefixed "k:" 
  pub struct JobCache { /* moka::sync::Cache<JobKey, CachedJob> with Expiry (ttl per entry, None = no expiry) + tag_index + hits/misses */ }
  impl JobCache { pub fn new(max: u64) -> Self; pub fn get(&self, k: &JobKey) -> Option<Arc<Value>>; pub fn insert(&self, k: JobKey, value: Arc<Value>, ttl: Option<Duration>, tags: &[String]); pub fn invalidate_key(&self, k: &JobKey) -> bool; pub fn invalidate_tags(&self, tags: &[String]) -> usize; pub fn clear(&self); pub fn stats(&self) -> CacheStats; }
  ```
- [ ] `job_cache.rs`: copy `page_cache.rs` and change: key `String` → `JobKey`, payload `Vec<u8>` → `Arc<Value>`, replace the hand-rolled `expires_at: Option<Instant>` with a `moka::Expiry` impl returning `value.ttl` (`None` → `None`, i.e. never) mirroring `ResponseExpiry` (`response_cache.rs:62-83`, both `expire_after_create` and `expire_after_update`), add `hits/misses` atomics incremented in `get`, make `invalidate_tags` return the number of keys it collected. Carry the 9 tests re-typed (`b"PAYLOAD".to_vec()` → `Arc::new(json!("PAYLOAD"))`), `zero_ttl_expires_immediately` stays valid (moka expires `Duration::ZERO` on the next read). Add `ttl_none_survives_until_invalidated` and `stats_count_hits_and_misses`.
- [ ] `l1.rs`: copy `response_cache.rs`, rename `ResponseCache` → `L1Cache`, `response_bytes: Vec<u8>` → `ctx: Arc<Value>`; `invalidate_tags` returns the collected key count. Carry the 10 tests (values become `Arc::new(json!({"k":1}))`). Move `build_cache_key` + `sort_query` + test `build_cache_key_sorts_query_and_applies_prefix` here.
- [ ] `src/cache/mod.rs`: `pub mod job_cache; pub mod key_expr; pub mod l1;`. `cargo test -p brust-server` → `110 + 12 (job_cache) + 11 (l1) = 133 passed`; clippy clean. Port doc rows: `cache/l1.rs | cache/response_cache.rs | adapt: value = JSON ctx | 10 → 11`, `cache/job_cache.rs | cache/page_cache.rs | adapt: typed key, Expiry, stats | 9 → 11`.
- [ ] Commit `feat(server): L1 cache on JSON context (carried response_cache) + job cache (moka, per-entry ttl, tags, stats)`.

---

### Task 5: Dispatch seam, pool, protocol structs, fake worker

**Files:** `src/dispatch.rs`, `src/pool.rs`, `src/protocol.rs`, `tests/common/{mod.rs,fake_bun.rs}`, port doc rows

**Interfaces**
- Consumes: `render/dispatch.rs` (226 lines, 3 tests; module doc :1-21 copied verbatim), `render/pool.rs` (794 lines, 14 tests; verbatim, `use crate::render::RenderDispatch` → `use crate::dispatch::RenderDispatch`), `server/mod.rs:1262-1293` (`ClaimWaitErr`, `claim_or_wait`) and `:1311-1371` (`dispatch_single_chunk` claim/serialize/call/bounds-check skeleton — the framed decode `:1373-1404` is NOT carried; v2 responses are plain JSON in the slot).
- Produces:
  ```rust
  // src/dispatch.rs
  #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)] #[serde(rename_all = "lowercase")] pub enum CallKind { Loader, Jobs }
  #[derive(Debug, thiserror::Error)] #[non_exhaustive] pub enum DispatchError { #[error("enqueue failed: {0}")] EnqueueFailed(String), #[error("promise rejected: {0}")] PromiseRejected(String) }
  pub trait RenderDispatch: Send + Sync + 'static {
      /// `request_json` is INLINE (see module doc); the worker writes the response JSON into `buf_slot(slot)` and resolves with its byte length (> 0).
      fn call(&self, kind: CallKind, request_json: String, slot: u32) -> Pin<Box<dyn Future<Output = Result<u32, DispatchError>> + Send>>;
      fn slot_count(&self) -> usize { 1 }
      fn buf(&self) -> (*mut u8, usize);
      fn buf_slot(&self, slot: u32) -> (*mut u8, usize) { /* dispatch.rs:80-99 verbatim */ }
      fn buf_len(&self) -> usize { self.buf().1 }
  }
  #[derive(Debug, thiserror::Error)] pub enum CallError { #[error("no workers")] NoWorkers, #[error("all workers busy")] Timeout, #[error("worker dead: {0}")] Enqueue(String), #[error("worker rejected: {0}")] Rejected(String), #[error("bad response: {0}")] BadResponse(String) }
  pub async fn claim_or_wait(pool: &WorkerPool, timeout: Duration, try_claim: impl FnMut() -> ClaimResult) -> Result<RenderClaim, CallError>;   // server/mod.rs:1272-1293, `tuning()` replaced by the `timeout` arg
  /// One round trip: claim (lockfree) → serialize → call → bounds-check len → from_slice → release claim on every path.
  pub async fn call_worker<Req: Serialize, Resp: DeserializeOwned>(pool: &Arc<WorkerPool>, timeout: Duration, kind: CallKind, req: &Req) -> Result<Resp, CallError>;
  // src/protocol.rs — spec §1 S1 table, camelCase on the wire
  #[derive(Serialize)] #[serde(rename_all = "camelCase")] pub struct LoaderRequest<'a> { pub route_id: &'a str, pub params: BTreeMap<String, String>, pub path: &'a str, pub req: RequestEnvelope<'a> }
  #[derive(Deserialize)] #[serde(untagged)] pub enum LoaderResponse { Ok { ok: bool, data: Value }, Verdict(Verdict), Error { error: String } }
  #[derive(Deserialize)] #[serde(tag = "verdict", rename_all = "camelCase")] pub enum Verdict { NotFound { #[serde(default)] data: Value }, Redirect { location: String, #[serde(default = "d302")] status: u16 }, HttpError { status: u16, #[serde(default)] body: String } }
  #[derive(Serialize)] #[serde(rename_all = "camelCase")] pub struct JobsRequest { pub jobs: Vec<JobCall> }
  #[derive(Serialize)] #[serde(rename_all = "camelCase")] pub struct JobCall { pub id: String /* "<componentId>/<jobId>[/<row>]" */, pub component_id: String, pub kind: JobKind, pub inputs: Value }
  #[derive(Deserialize)] pub struct JobsResponse { pub results: Vec<JobResult> }
  #[derive(Deserialize)] pub struct JobResult { pub id: String, #[serde(default)] pub value: Option<Value>, #[serde(default)] pub error: Option<String> }
  // tests/common/fake_bun.rs (shared by every integration test binary via `mod common;`)
  pub struct FakeBun { pub loader: Box<dyn Fn(Value) -> Value + Send + Sync>, pub jobs: Box<dyn Fn(Value) -> Value + Send + Sync>, pub loader_calls: AtomicU32, pub job_calls: AtomicU32, pub never_complete: bool, ptr: *mut u8, len: usize }
  impl FakeBun { pub fn new(loader: impl Fn(Value)->Value + Send + Sync + 'static, jobs: impl Fn(Value)->Value + Send + Sync + 'static) -> Arc<Self>; pub fn counts(&self) -> (u32, u32); }
  ```
- [ ] `FakeBun::call`: parse `request_json`, bump the counter for `kind`, compute the canned response, `serde_json::to_vec`, `assert!(bytes.len() <= cap)`, `unsafe { ptr::copy_nonoverlapping }` into `buf_slot(slot)`, `Box::pin(async move { Ok(len as u32) })`; when `never_complete` return `Box::pin(std::future::pending())`. Buffer: leaked `vec![0u8; 256*1024]` like `MockDispatch::with_slots` (`dispatch.rs:125-131`); `unsafe impl Send + Sync` with the same justification comment. `impl RenderDispatch for Arc<FakeBun>` is not possible → tests register `Box::new(FakeBunHandle(Arc<FakeBun>))` where `FakeBunHandle` forwards.
- [ ] `call_worker` (the only place that reads the SAB; every `return` drops `claim` — the RAII invariant from `pool.rs:147-181`):
  ```rust
  pub async fn call_worker<Req: Serialize, Resp: DeserializeOwned>(pool: &Arc<WorkerPool>, timeout: Duration, kind: CallKind, req: &Req) -> Result<Resp, CallError> {
      let claim = claim_or_wait(pool, timeout, || pool.try_claim_render_lockfree()).await?;
      let entry = Arc::clone(claim.entry());
      let slot = claim.slot();
      let json = serde_json::to_string(req).map_err(|e| CallError::BadResponse(format!("request serialise: {e}")))?;
      let len = match entry.dispatch.call(kind, json, slot).await {
          Ok(n) => n,
          Err(DispatchError::EnqueueFailed(m)) => {
              tracing::error!(worker_id = entry.id(), ?kind, error = %m, "enqueue failed — worker dead, removing from pool");
              pool.remove(entry.id());
              return Err(CallError::Enqueue(m));
          }
          Err(DispatchError::PromiseRejected(m)) => return Err(CallError::Rejected(m)),
      };
      let (ptr, cap) = entry.dispatch.buf_slot(slot);
      if len == 0 || len as usize > cap { return Err(CallError::BadResponse(format!("resp_len {len} outside (0, {cap}]"))); }
      // SAFETY: the worker's Promise resolved (happens-before through the dispatch future), JS is done writing this slot's sub-region; `len` is bounds-checked above; `claim` is still held so no other request can write the slot.
      let bytes = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
      let parsed = serde_json::from_slice::<Resp>(bytes).map_err(|e| CallError::BadResponse(e.to_string()));
      drop(claim);
      parsed
  }
  ```
  (`WorkerEntry.id` is `pub(crate)` in `pool.rs:67`; add `pub fn id(&self) -> u32` next to `slot_len`.) The 0.1.x `process::exit(1)` on "no workers left" (`server/mod.rs:1349-1352`) is NOT carried: the m2c lane decides process policy; here it is a 503 on the next request.
- [ ] Unit tests in `src/dispatch.rs` (besides the 3 carried `buf_slot_*`): `call_worker_round_trips_json` (MockDispatch extended to echo a canned `{"ok":true,"data":{"x":1}}` into the slot), `call_worker_returns_bad_response_on_len_over_capacity`, `claim_or_wait_times_out_when_all_busy` (claim the only slot, `timeout = 50ms`, expect `Err(CallError::Timeout)` in ≥ 50 ms and < 500 ms).
- [ ] `cargo test -p brust-server` → `133 + 14 (pool) + 6 (dispatch) = 153 passed`. Port doc rows: `pool.rs | render/pool.rs | carry verbatim | 14 → 14`, `dispatch.rs | render/dispatch.rs + server/mod.rs:1262-1371 | adapt: CallKind, JSON response, claim_or_wait(timeout) | 3 → 6`.
- [ ] Commit `feat(server): RenderDispatch seam with Loader/Jobs call kinds, carried pool, protocol structs, FakeBun test double`.

---

### Task 6: Render — environment, chain composition, assets, useId

**Files:** `src/render.rs`, `tests/render.rs`, port doc row

**Interfaces**
- Consumes: `template/jinja.rs:38-85` (`base_env` → `register`, `load_from` → `from_templates`); tests `jinja_round_trip` (:243) adapted, `style_safe_scrubs_close_tag_sequences` (:350) dropped (filter is M1's `style_css` now), dynamic-tier tests (:294, :388) dropped (M3). `brust_jinja::register`; `Loaded.templates`; `render_debug.rs:16-27` for the context merge (`props` top-level + `_props`).
- Produces:
  ```rust
  pub struct Renderer { env: minijinja::Environment<'static> }
  #[derive(Debug, thiserror::Error)] pub enum RenderError { #[error("unknown template {0}")] Unknown(String), #[error("render {name}: {msg}")] Render { name: String, msg: String /* minijinja Display with line */ } }
  impl Renderer {
      pub fn from_templates(templates: &BTreeMap<String, String>) -> Result<Self, RenderError>;   // env = Environment::new(); brust_jinja::register(&mut env); add_template_owned(id, src) each
      pub fn render(&self, name: &str, ctx: &Value) -> Result<String, RenderError>;
      /// S7 step 7 / S8: leaf-first; each result becomes the parent's `__outlet`. `ctx` is the merged context; per-component overlays carry that component's `_idN`.
      pub fn render_chain(&self, chain: &[String], ctx: &Value, ids: &dyn Fn(&str) -> Vec<(String, String)>) -> Result<String, RenderError>;
  }
  /// S9: `<script type="module" src="/_brust/<p>">` for runtime, each `client` of the chain + inlined children (dedup, chain order), then `react` + each react child chunk. No tags when every component in the chain (and its children) is `static`. Inserted before the last `</body>`, else appended.
  pub fn inject_assets(html: String, chain: &[String], m: &Manifest) -> String;
  /// S7 step 6 / F39: `brust-<routeId>-<instance>-<n>` for n in 1..=use_id_slots; instance = component id for chain entries, `<childId>_<k>` for static child instances, `<childId>_<k>-<row>` for per-row instances.
  pub fn use_ids(route_id: &str, instance: &str, slots: u32) -> Vec<(String, String)>;   // [("_id1","brust-r6-idsPage_i9-1"), ...]
  ```
- [ ] Tests first (`tests/render.rs`), using `Manifest::load(fx())` + `Renderer::from_templates(&l.templates)`:
  `outlet_composes_leaf_first` → `render_chain(["appLayout_a1","homePage_b2"], json!({}))` equals `<!doctype html><html><head><title>fx</title></head><body><nav>fx</nav><main><h1>Home</h1></main></body></html>`;
  `outlet_is_not_escaped` → leaf containing `<b>` arrives intact (autoescape None + `| safe`);
  `dynamic_text_is_escaped` → `render("notFoundPage_f6", json!({"path":"<x>"}))` contains `&lt;x&gt;`;
  `inject_assets_static_chain_adds_nothing` → `["appLayout_a1","homePage_b2"]` unchanged;
  `inject_assets_native_chain_adds_runtime_then_chunk_before_body_close` → `["appLayout_a1","detailPage_c3"]` ends with `<script type="module" src="/_brust/client/runtime-8b1c.js"></script><script type="module" src="/_brust/client/detailPage_c3-1a2b3c.js"></script></body></html>` and contains no `react-19.2.0`;
  `inject_assets_react_child_adds_react_bundle_and_island_chunk` → `["appLayout_a1","teamPage_g7"]` contains, in order, runtime, `teamPage_g7-4d5e6f.js`, `react-19.2.0.js`, `react-teamBuilder_h8.js`;
  `inject_assets_without_body_appends` → `inject_assets("<p>x</p>".into(), …native…)` ends with `</script>`;
  `use_ids_are_stable_and_distinct` → `use_ids("r6","idsPage_i9",2) == [("_id1","brust-r6-idsPage_i9-1"),("_id2","brust-r6-idsPage_i9-2")]` on two calls;
  `render_error_names_template_and_line` → a tmp template `{{ 1 +* }}`: `Err(Render{name,msg})` with `msg.contains("line")`.
- [ ] Implement `render_chain` and `inject_assets`; `render` returns `RenderError::Render{ msg: format!("{e:#}") }` so minijinja's line number reaches the server log (spec §7):
  ```rust
  pub fn render_chain(&self, chain: &[String], ctx: &Value, ids: &dyn Fn(&str) -> Vec<(String, String)>) -> Result<String, RenderError> {
      let base = minijinja::Value::from_serialize(ctx);          // one conversion for the whole chain
      let mut outlet: Option<String> = None;
      for id in chain.iter().rev() {                                // leaf first (S7 step 7 / S8)
          let mut overlay: Vec<(String, minijinja::Value)> = ids(id).into_iter().map(|(k, v)| (k, minijinja::Value::from(v))).collect();
          if let Some(o) = outlet.take() { overlay.push(("__outlet".into(), minijinja::Value::from(o))); }
          let scope = if overlay.is_empty() { base.clone() } else { minijinja::context! { ..minijinja::Value::from_iter(overlay), ..base.clone() } };
          let tmpl = self.env.get_template(id).map_err(|_| RenderError::Unknown(id.clone()))?;
          outlet = Some(tmpl.render(scope).map_err(|e| RenderError::Render { name: id.clone(), msg: format!("{e:#}") })?);
      }
      Ok(outlet.unwrap_or_default())
  }
  pub fn inject_assets(mut html: String, chain: &[String], m: &Manifest) -> String {
      let mut chunks: Vec<&str> = Vec::new();     // chain order, then children, deduped
      let mut react: Vec<&str> = Vec::new();
      let mut any_dynamic = false;
      let mut visit = |id: &str| { if let Some(c) = m.components.get(id) {
          if c.tier != Tier::Static { any_dynamic = true; }
          if let Some(cl) = &c.client { let bucket = if c.tier == Tier::React { &mut react } else { &mut chunks }; if !bucket.contains(&cl.as_str()) { bucket.push(cl); } }
      } };
      for id in chain { visit(id); if let Some(c) = m.components.get(id) { for ch in &c.children { visit(&ch.id); } } }
      if !any_dynamic { return html; }
      let tag = |p: &str| format!("<script type=\"module\" src=\"/_brust/{p}\"></script>");
      let mut tags = tag(&m.assets.runtime);
      for c in &chunks { tags.push_str(&tag(c)); }
      if !react.is_empty() { if let Some(r) = &m.assets.react { tags.push_str(&tag(r)); } for c in &react { tags.push_str(&tag(c)); } }
      match html.rfind("</body>") { Some(i) => html.insert_str(i, &tags), None => html.push_str(&tags) }
      html
  }
  pub fn use_ids(route_id: &str, instance: &str, slots: u32) -> Vec<(String, String)> {
      (1..=slots).map(|n| (format!("_id{n}"), format!("brust-{route_id}-{instance}-{n}"))).collect()
  }
  ```
  If `minijinja::context!{ ..a, ..b }` does not accept two spreads in the pinned version, replace `scope` with `minijinja::Value::from_object(Layered{ overlay, base })` implementing `minijinja::value::Object::get_value` (overlay first, then base) — same semantics, no cloning of `ctx`.
- [ ] `cargo test -p brust-server --test render` → `9 passed`; total `153 + 9 + 1 (jinja_round_trip carried into src/render.rs) = 163`. Port doc row: `render.rs | template/jinja.rs | adapt: owned env from manifest, no globals, no dynamic tier | 4 → 1 (+9 integration)`.
- [ ] Commit `feat(server): minijinja renderer from manifest templates, leaf-first outlet composition (S8), asset injection (S9), useId seeds (F39)`.

---

### Task 7: Pipeline, server state, accept loop, integration suite

**Files:** `src/pipeline.rs`, `src/config.rs` (full), `src/server/mod.rs` (full), `src/lib.rs` (public API), `tests/common/mod.rs` (boot + HTTP client), `tests/server.rs`, port doc rows

**Interfaces**
- Consumes: `server/mod.rs:33-109` (`Tuning` minus `max_action_body_bytes`, `TUNING`/`CORS` OnceLocks, `tuning()`, `resolved_cors()`), `:111-382` (`start`: boot channel, runtime thread, bind, TLS acceptor, ready gate, semaphore, `service_fn` with X-Powered-By + CORS stamping, drain wiring), `:384-434` (`serve_io`), `:436-442` (`header_str`); `config.rs:82-190` (`AppState` fields: `pool, routes, cache, ready, drain_start, drain_done, drain_timeout_ms, expected_workers, generator, tls, cors` + their accessors `:195-300`; drop island/page/action/dev/islands_dir/css_dir/public_assets). `handle_request` is replaced; its L1 decision block `:710-808` (EvalCtx assembly from headers/cookies/query/params, `bypass`/`prefix` evaluation, `build_cache_key`) is carried into `pipeline.rs` as `l1_decision`.
- Produces (the m2c contract):
  ```rust
  // src/lib.rs
  pub use config::{Config, CorsConfig, Server, Stats, InvalidateArgs, InvalidateResult};
  pub use dispatch::{CallKind, DispatchError, RenderDispatch};
  pub use server::{start, Tuning};
  // src/config.rs
  pub struct Config { pub addr: SocketAddr, pub dist_dir: PathBuf, pub expected_workers: u32 /* 0 = serve immediately */, pub tuning: Tuning, pub l1_capacity: u64 /* 1000 */, pub job_cache_capacity: u64 /* 1000 */, pub tls: Option<TlsConfig>, pub cors: Option<CorsConfig>, pub generator: Option<String> /* X-Powered-By */ }
  impl Default for Config { /* addr 127.0.0.1:1337, dist_dir "dist", expected_workers 0, caps 1000 */ }
  pub struct Server { pub(crate) pool: Arc<WorkerPool>, pub(crate) routes: RouteTable, pub(crate) manifest: Manifest, pub(crate) renderer: Renderer, pub(crate) l1: L1Cache, pub(crate) jobs: JobCache, pub(crate) dist_dir: PathBuf, pub(crate) loader_calls: AtomicU64, pub(crate) job_calls: AtomicU64, pub(crate) ready: Arc<Notify>, pub(crate) expected_workers: AtomicU32, pub(crate) drain_start: Arc<Notify>, pub(crate) drain_done: Arc<Notify>, pub(crate) drain_timeout_ms: AtomicU64, pub(crate) local_addr: OnceLock<SocketAddr>, pub(crate) tls: Option<TlsConfig>, pub(crate) cors: Option<CorsConfig>, pub(crate) generator: Option<String>, pub(crate) claim_timeout: Duration }
  impl Server {
      pub fn register_worker(&self, d: Box<dyn RenderDispatch>) -> u32;   // pool.register; when registered_count() >= expected_workers → ready.notify_one()
      pub fn local_addr(&self) -> SocketAddr;                              // bound address (port 0 resolves here)
      pub fn invalidate(&self, args: InvalidateArgs) -> InvalidateResult;  // key → jobs.invalidate_key(JobKey("k:"+key)); tags → both caches; path(+method, default "GET") → l1.invalidate_path
      pub fn stats(&self) -> Stats;
      pub fn request_drain(&self, timeout_ms: u64);  pub async fn wait_drain_done(&self);   // config.rs:269-300 carried
  }
  #[derive(Default, Deserialize)] pub struct InvalidateArgs { pub key: Option<String>, pub tags: Vec<String>, pub path: Option<String>, pub method: Option<String> }
  #[derive(Serialize)] pub struct InvalidateResult { pub l1_removed: usize, pub job_removed: usize }
  #[derive(Serialize)] pub struct Stats { pub l1: CacheStats, pub job: CacheStats, pub loader_calls: u64, pub job_calls: u64 }
  // src/server/mod.rs
  pub fn start(cfg: Config) -> Result<Arc<Server>, String>;   // Manifest::load → RouteTable::from_manifest → Renderer → Server; then the carried thread/bind (boot_tx now sends Ok(local_addr)); Err strings: "manifest: {e}", "routes: {e}", "bind failed on {addr}: {e}", "tls acceptor build failed: {e}"
  // src/pipeline.rs
  pub(crate) async fn handle(req: Request<Incoming>, s: Arc<Server>) -> Response<ResponseBody>;
  pub(crate) enum CacheOutcome { Hit, Miss, Bypass, None }   // for the log line (Task 8)
  ```
- [ ] `tests/common/mod.rs`: `pub fn boot(fake: Arc<FakeBun>) -> Arc<Server>` = `start(Config{ addr: "127.0.0.1:0".parse().unwrap(), dist_dir: fx(), expected_workers: 1, tuning: Tuning{ claim_timeout_ms: 500, ..Default::default() }, ..Default::default() })` then `register_worker(Box::new(FakeBunHandle(fake)))`; `pub fn get(s: &Server, path: &str, headers: &[(&str,&str)]) -> (u16, http::HeaderMap, String)` = blocking helper that builds a `tokio` current-thread runtime, `TcpStream::connect(s.local_addr())`, `hyper::client::conn::http1::handshake`, sends `Request::get(path)` with `Host`, collects the body (gzip is not requested: no `Accept-Encoding`); `pub fn stats(s) -> serde_json::Value` = `get(s, "/_brust/cache/stats")` parsed. Default fakes: `loader` returns `{"ok":true,"data":{"pokemon":{"name":<params.name>,"stats":{"hp":35},"moves":[{"name":"tackle"},{"name":"growl"}]},"team":["a"],"who":"anon"}}` for every route unless the test overrides; `jobs` returns for each call `id` ending in `detailPage_c3/j0` → `{"_s1":"HP 35"}`, `moveCard_d4/j0/<row>` → `{"_s1":"MOVE <name>"}`, `teamBuilder_h8/ssr` → `"<ul><li>a</li></ul>"`.
- [ ] `tests/server.rs` (red first; each test boots its own server on port 0 — no shared state across tests):
  - `ping_and_stats_shape`: `/ping` → 200 `pong\n`; stats JSON has keys `l1.hits, l1.misses, job.hits, job.misses, loader_calls, job_calls`.
  - `static_route_makes_zero_calls_on_first_request`: `/` → 200, body contains `<main><h1>Home</h1></main>`, no `<script`, `x-brust-cache` header absent, `fake.counts() == (0,0)`, stats `loader_calls == 0`.
  - `miss_makes_exactly_one_loader_and_one_jobs_call`: `/pokemon/pikachu` → 200, body contains `<h1>pikachu</h1>`, `<p>HP 35</p>`, `<li>tackle: MOVE tackle</li><li>growl: MOVE growl</li>`, `x-brust-cache: MISS`, counts `(1,1)`, the single jobs request carried 3 job calls (fake records the last `JobsRequest`: ids `detailPage_c3/j0`, `moveCard_d4/j0/0`, `moveCard_d4/j0/1`).
  - `hit_makes_zero_dispatch_calls`: two requests to `/pokemon/pikachu`: second has `x-brust-cache: HIT`, identical body, counts still `(1,1)`, stats `l1.hits == 1`.
  - `all_jobs_cached_across_routes_skips_jobs_call`: `/pokemon/pikachu` then `/pokemon/raichu` (same moves): second makes `(2,2)`? No — detailPage's input `pokemon.stats` is equal (`{"hp":35}`) and both rows hit → second request makes 1 loader + **0** jobs calls: counts `(2,1)`, stats `job.hits == 3`.
  - `bypass_skips_l1_and_prefix_keys_it`: `/tenant` with `Cookie: session=1` twice → both `x-brust-cache: BYPASS`, loader calls 2; without the cookie and `x-tenant: acme` twice → MISS then HIT; then `x-tenant: beta` → MISS (prefix in key).
  - `invalidate_by_tag_forces_miss`: HIT established on `/pokemon/pikachu`; `s.invalidate(InvalidateArgs{ tags: vec!["pokemon".into()], ..Default::default() })` returns `l1_removed == 1`; next request `MISS` and loader calls +1; `tags: ["moves"]` then removes the 2 moveCard entries (`job_removed == 2`) and the next request's jobs call carries only the two `moveCard` ids.
  - `not_found_verdict_is_404_with_own_template_and_not_cached`: loader override returns `{"verdict":"notFound","data":{"pokemon":{"name":"nothing","stats":{},"moves":[]}}}` for `/pokemon/nothing` → 404, body contains `<h1>nothing</h1>` (detailPage's template, not the catch-all), no `x-brust-cache: HIT` on a second request (loader calls 2), `stats.l1.len == 0`.
  - `redirect_and_http_error_verdicts`: `{"verdict":"redirect","location":"/pokemon/pikachu"}` → 302 with `location`; `{"verdict":"redirect","location":"/x","status":301}` → 301; `{"verdict":"httpError","status":418,"body":"teapot"}` → 418 body `teapot`.
  - `loader_error_is_500_plain`: `{"error":"boom"}` → 500, body `500 Internal Server Error`, not cached.
  - `job_error_is_500_and_not_cached`: jobs override returns `{"results":[{"id":"detailPage_c3/j0","error":"bad"}, …]}` → 500; `stats.job.len == 0` (nothing stored, not even the good rows — one bad job fails the request before any insert).
  - `unmatched_path_renders_catch_all_at_404`: `/nope?x=1` → 404, body contains `Not found: /nope`, `0` dispatch calls.
  - `react_child_island_ssr_and_assets`: `/team` → body contains `<brust-island data-brust-island="teamBuilder_h8" x-props='{"team":["a"]}'><ul><li>a</li></ul></brust-island>` and the four script tags in Task 6's order.
  - `use_ids_stable_across_two_requests`: `/ids` twice → both bodies contain `id="brust-r6-idsPage_i9-1"` and `for="brust-r6-idsPage_i9-2"`.
  - `static_assets_and_method_gate`: `/_brust/client/runtime-8b1c.js` → 200, `content-type: application/javascript; charset=utf-8`, `cache-control: public, max-age=31536000, immutable`; `/public/app.css` → 200 `text/css; charset=utf-8`, `cache-control: public, max-age=3600`; `/_brust/client/../manifest.json` → 404; `HEAD /` → 200 with empty body; `POST /` → 405.
  - `set_cookie_from_loader_is_not_cached`: loader returns `{"ok":true,"data":{…},"headers":{"set-cookie":"a=1"}}` — **M2 rule:** `LoaderResponse::Ok` gains `#[serde(default)] headers: BTreeMap<String,String>` copied onto the response; a `set-cookie` key → status 200 but `x-brust-cache: MISS` on every request and `l1.len == 0`.
- [ ] Job planning and merge, the heart of step 5 (written before `handle`, unit-tested in `src/pipeline.rs` with the fixture manifest: `plan_lists_chain_jobs_then_child_rows_in_template_order`, `plan_uses_cache_key_expression_when_set`):
  ```rust
  pub(crate) enum Target { Chain { component: String }, Child { component: String, k: u32, row: Option<usize> } }
  pub(crate) struct JobPlan { pub key: JobKey, pub call_id: String, pub component_id: String, pub job_id: String, pub kind: JobKind, pub inputs: Value, pub ttl: Option<Duration>, pub tags: Vec<String>, pub target: Target }
  pub(crate) fn collect_jobs(m: &Manifest, chain: &[String], ctx: &Value) -> Result<Vec<JobPlan>, String> {
      let mut out = Vec::new();
      let plan_one = |out: &mut Vec<JobPlan>, cid: &str, j: &JobRecord, props: &Value, target: Target, row: Option<usize>| -> Result<(), String> {
          let inputs = inputs::project(props, &j.inputs, None)?;
          let key = match &j.cache.key { Some(expr) => JobKey(format!("k:{}", inputs::Path::parse(expr)?.get(props, None))), None => JobKey(inputs::job_key(cid, &j.id, &inputs)) };
          let call_id = match row { Some(r) => format!("{cid}/{}/{r}", j.id), None => format!("{cid}/{}", j.id) };
          out.push(JobPlan { key, call_id, component_id: cid.into(), job_id: j.id.clone(), kind: j.kind, inputs, ttl: j.cache.ttl_seconds.map(Duration::from_secs), tags: j.cache.tags.clone(), target });
          Ok(())
      };
      for id in chain {
          let c = &m.components[id];
          for j in &c.jobs { plan_one(&mut out, id, j, ctx, Target::Chain { component: id.clone() }, None)?; }
          let mut ordinal: BTreeMap<&str, u32> = BTreeMap::new();
          for ch in &c.children {
              let k = { let e = ordinal.entry(ch.id.as_str()).or_insert(0); *e += 1; *e };
              let child = &m.components[&ch.id];
              match &ch.instances {
                  Instances::Static => { let props = inputs::child_props(ctx, &ch.props, None)?; for j in &child.jobs { plan_one(&mut out, &ch.id, j, &props, Target::Child { component: ch.id.clone(), k, row: None }, None)?; } }
                  Instances::PerRow(list) => {
                      let rows = inputs::Path::parse(list)?.get(ctx, None).as_array().map(|a| a.len()).unwrap_or(0);
                      for r in 0..rows { let props = inputs::child_props(ctx, &ch.props, Some(r))?; for j in &child.jobs { plan_one(&mut out, &ch.id, j, &props, Target::Child { component: ch.id.clone(), k, row: Some(r) }, Some(r))?; } }
                  }
              }
          }
      }
      Ok(out)
  }
  /// Writes one job's value into the context slot its target names (S7 step 5 names).
  pub(crate) fn merge_result(ctx: &mut serde_json::Map<String, Value>, plan: &JobPlan, value: &Value) {
      match &plan.target {
          Target::Chain { component } => match plan.kind {
              JobKind::Precompute => { if let Some(o) = value.as_object() { for (k, v) in o { ctx.insert(k.clone(), v.clone()); } } }
              JobKind::Ssr => { ctx.insert(format!("_ssr_{component}"), value.clone()); }
          },
          Target::Child { component, k, row } => {
              let slot = ctx.entry(format!("__{component}_{k}")).or_insert_with(|| if row.is_some() { Value::Array(vec![]) } else { Value::Object(Default::default()) });
              let cell = match row { Some(r) => { let a = slot.as_array_mut().expect("array"); while a.len() <= *r { a.push(Value::Object(Default::default())); } &mut a[*r] } None => slot };
              let obj = cell.as_object_mut().expect("object");
              match plan.kind { JobKind::Precompute => { if let Some(o) = value.as_object() { for (k, v) in o { obj.insert(k.clone(), v.clone()); } } } JobKind::Ssr => { obj.insert(format!("_ssr_{component}"), value.clone()); } }
          }
      }
  }
  ```
  Per-row slots are pre-sized to the row count before merging so a row whose child has no jobs still gets `{}` (the template indexes `__<id>_<k>[_i1]` for every row).
- [ ] Implement `pipeline::handle` in S7 order: (1) method/`HEAD` gate (`HEAD` → run the page path and drop the body); `/ping`; `/_brust/cache/stats` (`serde_json::to_vec(&s.stats())`); `/_brust/<rel>` and `/public/<rel>`: reject when `rel` has `..`, a leading `/` or `\`, or a segment failing `is_safe_island_filename`-style checks (letters/digits/`-`/`_`/`.`), read `dist_dir/<rel>` (`/_brust/client/x.js` → `dist/client/x.js`), `static_asset_response(accept_enc, content_type_for(path), path, bytes, head, false)` and overwrite `Cache-Control` with `public, max-age=31536000, immutable` when the stem matches `-[0-9a-f]{6,}$`; (2) `routes.match_path`; `NoMatch` → `body::error_404()`; `NotFound{route_id}` → render that route at 404; (3) `l1_decision` carried from `server/mod.rs:713-808` producing `(Option<CacheKey>, CacheOutcome)`; on `Some(key)` with `l1.get` hit → render from the cached ctx, header `x-brust-cache: HIT`; (4) `ctx = { params: {…}, path }`; if `route.loaders` non-empty → `call_worker::<_, LoaderResponse>(pool, claim_timeout, CallKind::Loader, &LoaderRequest{…})`, `loader_calls += 1`; `Ok{data}` → merge `data` keys over `ctx` (child keys win = `data` wins); `Verdict::NotFound{data}` → merge, `status = 404`, `cacheable = false`; `Redirect` → `body::resp(status, "text/plain", &[("Location", location)], b"")`, return; `HttpError` → `body::resp(status, "text/plain", &[], body)`, return; `Error{error}` → `tracing::error!` + `error_500()`; `CallError::NoWorkers | Timeout` → `error_503(msg)`; (5) `collect_jobs(&s.manifest, chain, &ctx)` walks each chain component's `jobs` then its `children` (static: `child_props`; per-row: `Path::parse(list).get(&ctx)` as array, one `JobPlan` per row with `idx`), computing `key = JobCache.key` → `cache.key` expression evaluated via `Path` when set (`JobKey("k:"+value)`), else `JobKey(job_key(cid, jid, &projected))`; look up; misses → `JobsRequest`; if non-empty → one `call_worker::<_, JobsResponse>` (`job_calls += 1`); any `error` → `tracing::error!(component_id, job_id)` + `error_500()` (nothing inserted); insert each result with `ttl_seconds.map(Duration::from_secs)` and `tags`; merge: chain precompute → object keys into `ctx`; chain ssr → `ctx["_ssr_<cid>"]`; child static instance → `ctx["__<cid>_<k>"] = value-object`; per-row → `ctx["__<cid>_<k>"] = [row values in list order]`; (6) `use_ids` per chain component (overlay through `render_chain`'s `ids` closure) and per child instance (`ctx["__<cid>_<k>"]["_idN"]`, rows likewise) — inserted BEFORE the L1 store so a HIT re-renders identical ids; (7) `render_chain` → `inject_assets` → gzip when `accepts_gzip` and len ≥ 1024 (`compress::gzip`, `Content-Encoding: gzip`, `Vary: Accept-Encoding`) → `body::resp(status, "text/html; charset=utf-8", &headers, bytes)` with `x-brust-cache: MISS|BYPASS` (none when the route has no `cache`) → store `Arc<Value>` in L1 when `cache_key.is_some() && status == 200 && cacheable && !headers.has("set-cookie")`.
- [ ] `src/server/mod.rs`: carry `start` with these edits only: `state: Arc<AppState>` → `Arc<Server>`; `state.cache` snapshot removed; `boot_tx` sends `Ok(listener.local_addr())` and `start` stores it in `server.local_addr`; `conn_workers` param dropped (`accept_cap = tuning.conn_queue_cap.max(1)`); ready gate `if cfg.expected_workers == 0 { ready.notify_one() }` before awaiting; the `service_fn` body calls `pipeline::handle(req, state).await` (keeps the X-Powered-By insert-if-absent and the CORS stamp exactly as `:300-307`). Carry the test `start_returns_err_when_addr_already_bound` (`:1868-1886`) adapted to `Config`.
- [ ] The blocking test client in `tests/common/mod.rs` (no reqwest; hyper's `client` feature as in brust-core's dev-deps):
  ```rust
  pub fn get(s: &Server, path: &str, headers: &[(&str, &str)]) -> (u16, http::HeaderMap, String) { request(s, "GET", path, headers) }
  pub fn request(s: &Server, method: &str, path: &str, headers: &[(&str, &str)]) -> (u16, http::HeaderMap, String) {
      let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
      rt.block_on(async {
          let tcp = tokio::net::TcpStream::connect(s.local_addr()).await.unwrap();
          let (mut sender, conn) = hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(tcp)).await.unwrap();
          tokio::spawn(conn);
          let mut b = http::Request::builder().method(method).uri(path).header("host", "fx");
          for (k, v) in headers { b = b.header(*k, *v); }
          let resp = sender.send_request(b.body(http_body_util::Empty::<bytes::Bytes>::new()).unwrap()).await.unwrap();
          let (parts, body) = resp.into_parts();
          let bytes = http_body_util::BodyExt::collect(body).await.unwrap().to_bytes();
          (parts.status.as_u16(), parts.headers, String::from_utf8_lossy(&bytes).into_owned())
      })
  }
  ```
- [ ] `cargo test -p brust-server` → `163 + 1 (start test) + 2 (pipeline unit) + 17 (server.rs) = 183 passed`; `cargo clippy -p brust-server --no-deps -- -D warnings` clean (remove every `#[allow(dead_code)]` from Task 1 that is now live; `response_from_framed_bytes`/`channel_body` stay allowed with a `// kept for parity with body.rs @ d04718f` comment). Port doc rows: `server/mod.rs | server/mod.rs:33-442 | carry: start/Tuning/serve_io/drain; handle_request replaced by pipeline.rs | 3 → 1 (+17 integration)`, `config.rs Server | config.rs:82-300 | adapt: stripped AppState | 6 → 0 (covered by tests/server.rs)`.
- [ ] Commit `feat(server): request pipeline (S7: L1, loader verdicts, batched jobs, per-instance arrays, useId, outlet, assets), Server API, carried accept loop; 17 integration tests`.

---

### Task 8: Per-request log line and 503 on claim timeout

**Files:** `src/pipeline.rs` (log line), `tests/logging.rs`, `tests/busy.rs`

**Interfaces**
- Consumes: `CacheOutcome`, counters local to `handle`; `claim_or_wait` (Task 5) and `Tuning.claim_timeout_ms`.
- Produces: one `tracing::info!(target: "brust::request", route = %route_id, status, cache = %outcome /* HIT|MISS|BYPASS|- */, bun_calls = n /* 0|1|2 */, dur_ms = f64, "request")` per page request, emitted on every return path of the page branch (wrap the page path in an inner `async fn page(...) -> (Response, Option<&str> route, CacheOutcome, u8 calls)` and log once after it); static/ping/stats paths log at `debug`.
- [ ] The wrapper in `src/pipeline.rs` (page branch only; the inner `page` returns the response plus what the line needs so there is exactly one emit site):
  ```rust
  pub(crate) struct PageMeta { pub route: String, pub cache: CacheOutcome, pub bun_calls: u8 }
  impl std::fmt::Display for CacheOutcome { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(match self { Self::Hit => "HIT", Self::Miss => "MISS", Self::Bypass => "BYPASS", Self::None => "-" }) } }
  async fn page_logged(req: Request<Incoming>, s: Arc<Server>) -> Response<ResponseBody> {
      let t0 = std::time::Instant::now();
      let (resp, meta) = page(req, s).await;              // every early return inside `page` still yields a `PageMeta`
      tracing::info!(target: "brust::request", route = %meta.route, status = resp.status().as_u16(), cache = %meta.cache, bun_calls = meta.bun_calls, dur_ms = t0.elapsed().as_secs_f64() * 1e3, "request");
      resp
  }
  ```
- [ ] `tests/logging.rs` (own binary, so the global subscriber is private): install `tracing_subscriber::fmt().with_writer(MockWriter)` where `MockWriter` pushes lines into a `static Mutex<Vec<String>>`; boot with defaults; `/pokemon/pikachu` then `/` then `/pokemon/pikachu`; assert the three captured `brust::request` lines contain, in order, `route=r2 status=200 cache=MISS bun_calls=2`, `route=r1 status=200 cache=- bun_calls=0`, `route=r2 status=200 cache=HIT bun_calls=0`, and each has `dur_ms=`.
- [ ] `tests/busy.rs`: `FakeBun` with `never_complete: true`; `Tuning{ claim_timeout_ms: 150, .. }`; spawn a thread that issues `/pokemon/a` (it never returns; the thread is detached); `std::thread::sleep(50ms)`; `/pokemon/b` from the test thread → `(503, _, "all workers busy")` and the elapsed time is in `[150ms, 2s)`; `/` still answers 200 (static path never claims). Then `expected_workers: 0` and no worker registered → `/pokemon/a` → 503 `no workers` immediately (< 50 ms).
- [ ] `cargo test -p brust-server` → `183 + 1 + 2 = 186 passed`; clippy and fmt clean. Finish `docs/design/brust-core-port.md` (every row filled, "manifest notes" section with the four m2a contract notes from Task 2, and the dropped-test list from Task 2).
- [ ] Commit `feat(server): per-request tracing line (route, cache outcome, bun calls, duration) + 503 on worker claim timeout`.

---

## Self-review notes

- **Spec coverage:** S1 call kinds/SAB rule → Task 5; S2 port table → Tasks 1, 2, 4–7 + `docs/design/brust-core-port.md`; S6 manifest → Task 2; S7 steps 1–7 → Task 7 (3: Task 4+7, 5: Tasks 3+4+7, 6: Task 6, 7: Task 6+7); S8 → Task 6; S9 → Task 6; S10 → Task 4; §7 errors/stats/log → Tasks 7, 8; §10 "crates/brust-server/tests" list (manifest loading, L1 key evaluation, job key hashing F33, outlet composition, asset injection, useId stability) → Tasks 2, 7, 3, 6, 6, 6/7.
- **Review Focus → tests:** 1 → Task 7 (`hit_makes_zero_dispatch_calls`, `static_route_…`, `all_jobs_cached_…`); 2 → Task 3; 3 → Task 7 (`not_found_verdict_…`, `set_cookie_…`); 4 → Tasks 6, 7; 5 → Task 8.
- **Decisions this plan makes that the spec left open (lead to ack before m2a emits them):** `per_instance` = list context path; `ChildRecord.props` additive map with `[idx]`; `inputs` relative to props with optional `props.` prefix; `LoaderResponse.headers` for `Set-Cookie`; `/public/<rel>` served from `dist/public` (spec §4 step 1) rather than 0.1.x root-mapped assets; immutable `Cache-Control` keyed on a `-<hex6+>` suffix.
- **Soft spots:** aws-lc-rs build time on first `cargo test` (carried from 0.1.x, needs cmake on the box); `tests/busy.rs` timing on a loaded CI runner (bounds are wide: 150 ms..2 s); moka's `Duration::ZERO` expiry semantics in `zero_ttl_expires_immediately` (if moka reads it as "no expiry" in 0.12.x, assert through `run_pending_tasks()` + a 1 ms ttl instead).

## Dispatch table (for the Coordinator)

| slug | plan tasks | tier | role | deps | review | acceptance (READY evidence) |
|---|---|---|---|---|---|---|
| `m2b-server-port` | 1–8 | complex | Implementer (Complex) | none (lane starts from `v2` HEAD; m2a/m2c are parallel and consume the Interfaces blocks, not this branch) | complex | `cargo test -p brust-server` → `186 passed` (paste the per-binary counts: lib ≈ 146 — 76 verbatim + 30 routes + 22 caches + 20 pool/dispatch + 1 render + 1 start + 2 pipeline — manifest 4, inputs 7, render 9, server 17, logging 1, busy 2; paste the real split, a lower total needs a named reason per missing test); `cargo clippy -p brust-server --no-deps -- -D warnings` clean; `cargo fmt --all -- --check` clean; `cargo test --workspace --exclude bun_react_compiler` still green (M1 crates untouched); `docs/design/brust-core-port.md` pasted (every row filled with SHA `d04718f`); the fixture `manifest.json` and the four m2a contract notes pasted into the lane report; PR → `v2` with CI `rust` job green; lane HEAD sha. |
