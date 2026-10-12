# m4cf-worker-crate: `crates/brust-wasm` (workers-rs host over `brust-core`) serves a fixture app's page, loader, ssr job and Elysia action under local workerd
**RULED by lead Detoro 2026-10-12 (before dispatch): R1-R13 ALL ACCEPTED as their defaults — R1 literal `raw_module "./brust-app.js"` first, `cloudflare:brust-app` placeholder rewritten by `crates/brust-wasm/scripts/build.ts` as the pre-ruled fallback (Task 2 proves it before anything else); R2 the lane-4 contract table adopted verbatim (`loader`, `jobs`, `action`, `MANIFEST`/`TEMPLATES`/`CONFIG` statics; `CONFIG.abi = 1`, `edgeCache "off"`, unknown keys fail startup); R3 no env/ctx through wasm — apps import from `cloudflare:workers`; R4 `ActionReply::{Fetch, Built}` with the JS Response held host-side (brust-server change ≤ 3 lines in host.rs, pipeline.rs and attribution.patch untouched); R5 fixture `tests/fixtures/cf-min` as a workspace member, entry = lane-4 generated text with fixture paths + a test-only shim for `@brust/core/server-handlers`; R6 e2e via pinned `bunx wrangler dev` (local workerd) + `deploy --dry-run`, new CI `cf` job without credentials, clippy on brust-wasm for host + wasm32; R7 ✓; R8 PATH shim `cargo +nightly` → nightly-2026-09-15 for `worker-build --panic-unwind` + `catch_unwind` per request; R9 wasm < 4 MiB, CPU not asserted; R10 `.compile()` at module top level with warm-up fallback; R11 stats gated in the adapter, startup failure throws; R12 `Manifest::from_parts` keyed by template path, client/asset file checks skipped, `load` keeps its error order; R13 THIS lane writes `npm/core-cf/package.json` (`workerBuild` pinned 0.8.7) and its `worker/` contents = the build script output. The four lane-4 corrections (invalidate unverified → lane 4 waits for Task 2's verdict before wiring the stub; `--wasm-from-source` calls `bun crates/brust-wasm/scripts/build.ts`; `npm/core-cf/worker/` = build-script output; lane 3 owns `npm/core-cf/package.json`) are applied to lane 4's plan. Task 12 (real-edge proof) follows bb rule:cloudflare-account — always delete, never record ids. Base: m4cf after `m4cf-core-wasm` merges. Implementer Dew (after lane 2), reviewer Mellow.**

> **Contract amendment (lead ruling 19753649, 2026-10-12, on lane 3 Task 2 evidence under worker-build 0.8.7 + wrangler 4.149.0):** `invalidate` is NOT a glue export (worker-build's bundled `index.js` only exports its own symbols). The R2a path is binding: `brust-app.js` exports `install` from `@brust/core/server-handlers`; `#[event(start)]` calls `install({ invalidate })`; the napi stub's `cacheInvalidate` calls the installed `rt.invalidate` (`{key?,tags?,path?,method?}` → `{l1Removed, jobRemoved}`). The sentinel rewrite in `crates/brust-wasm/scripts/build.ts` touches only the import specifiers (`from "cloudflare:brust-app"`), never the wasm imports-object key. Verified layout: `{main: "index.js", glue: "index.js", appModuleDir: "."}`; dry-run size 246 KiB (gzip 65 KiB).

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: m4cf (after lane/m4cf-core-wasm merges) · lane: m4cf-worker-crate · tier: complex · review: complex
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

This is lane M4-CF-3 of `docs/design/2026-10-12-m4-cloudflare-workers-design.md`. Read first: the header (R1-R14, esp. R2/R3/R7/R10/R11/R13/R14), §2 :76-114, §4 bridge :235-261 and entry :263-283, §5 :325-364, §6 :366-404, §8 :424-439, §9 lane-3 row :449.
- Lane 1 (`docs/plans/2026-10-12-m4cf-core-split.md` R5, :81) hands `Manifest::from_parts` to this lane.
- Lane 2 (`docs/plans/2026-10-12-m4cf-core-wasm.md`, in progress) supplies `brust_core::cache::local::{LocalL1<T: Clock>, LocalJobs<T: Clock>, WORKERS_L1_CAPACITY = 256, WORKERS_JOB_CAPACITY = 512}` (`with_clock` needs `T: Clock + Default`), `brust_core::host::JsClock` (wasm32-unknown-unknown only, `Default`), the CI `rustup target add wasm32-unknown-unknown` step, and `Manifest::load` compiled out on wasm (its R9a).
- Lane 4 (`m4cf-build-target`) runs in parallel; its contract table is mirrored in "Contract with lane 4".

Every `path:line` was verified at **m4cf @7a87e6e**; re-anchor on the quoted text after lane 2 merges.

## Facts the plan rests on
- **Host seam** (`crates/brust-core/src/host.rs:136-171`): `trait Host: Clock { type Body; type L1: PageCache; type Jobs: JobStore; const PLAN_OFFER: bool; loader(&self, &LoaderRequest, Option<PlanSeed>) -> impl Future<Output = Result<(LoaderResponse, Option<PlannedCall>), CallError>>; jobs(..); read_body(&self, Self::Body, cap) -> ..Result<Bytes, ReadErr>; action(&self, ActionCall<'_>) -> ..Result<FetchResponse, CallError>; static_file(..) -> ..Option<http::Response<Bytes>> }`. `RequestHead { method, full /* path?query */, headers, authority }` is at :23-30, `CallError` at :54-74.
- **Core:** `core.rs:89` `Core::new(host, Loaded, CoreConfig) -> Result<Self, String>`; `CoreConfig { l1_capacity, job_cache_capacity, cors, generator, actions, https }` (:27-37, **no `stats` field**); `:181` `handle(&self, RequestHead, H::Body) -> Response<Bytes>`; `:201` `finish(&self, origin, &mut HeaderMap)` (x-powered-by insert-if-absent, then CORS); `:151` `invalidate(InvalidateArgs) -> InvalidateResult` (snake_case, `config.rs:173-177`).
- **Pipeline order** (`pipeline.rs:63-148`): CORS preflight (:73-82) → actions prefix → `actions::handle` (:86-91) → method gate (:94) → `/ping` (:97) → `/_brust/cache/stats` **always on** (:101-105) → `/_brust/`, `/public/` → `host.static_file`, `None` → `body::error_404()` (:106-120, :150-174) → page.
  - `bench/attribution.patch` has hunks inside `handle` from :97 on. **This lane does not edit `pipeline.rs`.**
- **Actions admission** (`actions.rs:17-107`): 501 CONNECT/TRACE/TRACK, 400 ambiguous path, 415 content-encoding, 403 cross-site (problem+json, `body.rs:143-158`), `host.read_body(body, max_body_bytes)` (:64: TooLarge→413, Io→400, Slow→408), `host.action` (:74-83), `response_from_fetch` (:89, :212-233: status 200..=599, framing dropped). Native `action`: `brust-server/src/host.rs:92-148`.
- **Manifest** (`manifest.rs:331-422`): `load` reads `manifest.json`, checks version 1 and the chain components, then per component in BTreeMap order: `check_paths`, job targets, **the template** (`must_exist(id, &c.template)` + `read_to_string`, :383-386), the `client` file, the children's job inputs; finally `assets.*` (:411-414). `Loaded { manifest, templates: BTreeMap<component id, source>, dist_dir }` (:183-188). `Manifest` derives `Debug, Deserialize` only (:12); unknown keys (`actions`) are ignored.
- **workers-rs 0.8.7** [C docs.rs + crates.io, 2026-10-12]: no default features; deps `wasm-bindgen ^0.2.129`, `js-sys ^0.3.106`, `wasm-bindgen-futures ^0.4.79`, `web-sys ^0.3.106`, `futures-util`, `tokio` (no features), `matchit ^0.7`. `Request::{inner() -> &web_sys::Request, headers(), stream(&mut self)}`, `Response: From<web_sys::Response>`; `#[event(start)]` "merely creates a wasm-bindgen start function". `Cargo.lock` already holds `wasm-bindgen 0.2.129` (:2418), `js-sys 0.3.106` (:1525).
- **worker-build 0.8.7** (2026-09-25) [C `worker-build/src/main.rs`, `src/build/{mod,target}.rs` @ main]:
  - wasm-bindgen `--target module --out-name index`, then **esbuild bundles `./shim.js` → `build/index.js`** with only `--external:./index_bg.wasm --external:cloudflare:* --format=esm --bundle --minify`; `build/worker/shim.mjs` is a back-compat `export * from '../index.js'`.
  - `--panic-unwind` runs **`cargo +nightly build --lib --target wasm32-unknown-unknown -Z build-std=std,panic_unwind`** (`RUSTFLAGS+=-Cpanic=unwind`): the floating `nightly`, **not** `rust-toolchain.toml`'s `nightly-2026-09-15`.
  - So worker-build's own esbuild resolves the `raw_module` specifier at wasm build time (R1).
- **Elysia 2.0.0-beta.30** declares `compile(): this` (`dist/base.d.ts:987-990`); `brust()` = `{...WebStandardAdapter, name:'brust'}` (`packages/brust/src/actions/elysia.ts:10-12`).
- **JS side:** `packages/brust/src/worker.ts:183` `makeHandlers` is pure but its module imports napi `./native` and `node:worker_threads` (:5, :8); `cache.ts:10-21` `cache.invalidate` → napi `cacheInvalidate` → `{l1Removed, jobRemoved}`; `config.ts:14-21` `CorsConfig {origins, methods?, headers?, exposeHeaders?, credentials, maxAgeSeconds?}`. `packages/**` is lane 4's.
- **Repo traps:** `tests/fixtures/` is the compiler golden dir (`crates/brust-compiler/tests/fixtures.rs:61-64`, `dual_eval.rs:56-59` scan every dir **with an `input.tsx`**). Bun's isolated linker (`node_modules/.bun/`) means the fixture must be a workspace member. `ci.yml` rust job: :20-21 toolchain, :39 clippy, :44 `cargo test --workspace --exclude bun_react_compiler`. `npm/*` is a workspace glob, so `npm/core-cf/package.json` changes `bun.lock`.

## Goal
- `crates/brust-wasm` (cdylib, `worker = "=0.8.7"`): `#[event(start)]` reads `brust-app.js`'s `MANIFEST`/`TEMPLATES`/`CONFIG`, builds the per-isolate `Core<WasmHost>` via the new `Manifest::from_parts`, and installs a `console.error` panic hook plus a WARN+ tracing subscriber. `#[event(fetch)]` converts the request to `RequestHead`, runs `Core::handle` and `Core::finish`, and answers a web Response. `WasmHost` = `LocalL1<JsClock>`/`LocalJobs<JsClock>`/`JsClock`, `PLAN_OFFER = false`, `static_file` → `None` (Static Assets serves hits; a miss under `/_brust/`/`/public/` is core's 404).
- Actions: core admission unchanged; the body is read in Rust, capped at `max_body_bytes` (stream, early abort); a web `Request` is rebuilt with those bytes; the app's web `Response` is answered with its body untouched (R4); `cache.invalidate` reaches the wasm export `invalidate` (R2).
- `tests/fixtures/cf-min` (static page, cached loader page with a precompute job, React island page with an `ssr` job, Elysia GET + validated POST calling `cache.invalidate`) runs under `wrangler dev` (local workerd) from `tests/cf/cf-min.test.ts`: Task 9's 13 assertions pass; a deliberate panic answers 500 and the isolate keeps serving.
- `npm/core-cf/package.json` carries the `brust` layout field (values proven in Task 2); `crates/brust-wasm/scripts/build.ts` fills `npm/core-cf/worker/` (pinned nightly, `--panic-unwind`, R1 rewrite, size bar).
- CI: a `cf` job on ubuntu runs the e2e; the rust job clippies `brust-wasm` on host and wasm32.
- Native unchanged: `pipeline.rs` untouched; `brust-server` changes only the `ActionReply::Fetch` wrap (R4); `git apply --check bench/attribution.patch` passes.

## Rulings requested
**R1 — Making `raw_module` survive worker-build's esbuild, and where `brust-app.js` sits.**
- *Default:*
  - Task 2 first tries the literal `raw_module = "./brust-app.js"`.
  - If worker-build fails ("Could not resolve") or inlines a placeholder, use the sentinel `raw_module = "cloudflare:brust-app"`. worker-build's `--external:cloudflare:*` keeps it external. `scripts/build.ts` then rewrites that exact string literal to `"./brust-app.js"` in `index.js`, asserting ≥1 occurrence before and 0 after.
  - The published `@brust/core-cf` therefore already says `./brust-app.js`.
  - Location: `brust-app.js` goes beside the bundled glue, i.e. `dist/cf/worker/brust-app.js` next to `dist/cf/worker/index.js` and `index_bg.wasm`. The specifier is **`./brust-app.js`**, never `../`.
  - wrangler `main` = `worker/index.js`. `shim.mjs` is back-compat only.
  - This yields `brust = {main: "index.js", glue: "index.js", appModuleDir: "."}`, lane 4's defaults, which Task 2 confirms or corrects.
- *Alternatives:*
  - the sentinel plus a per-app wrangler `"alias": {"cloudflare:brust-app": "./worker/brust-app.js"}` (unverified that it beats wrangler's own `cloudflare:*` external);
  - `globalThis` registration (rejected by spec R3).

**R2 — `brust-app.js` contract v1 = lane 4's table, with Rust-side corrections.**
- *Default: adopt lane 4's names and shapes exactly:*
  - `loader(json) / jobs(json): Promise<string>` (never reject);
  - `action(req: Request): Promise<Response>`;
  - `MANIFEST: string`, `TEMPLATES: Record<templateRelPath, source>`, `CONFIG: string`.
  - Rust imports the three as `#[wasm_bindgen(thread_local_v2, js_name = MANIFEST)] static MANIFEST: js_sys::JsString` (TEMPLATES as `js_sys::Object`, walked with `Object::entries`). wasm-bindgen cannot import a `String` static. Task 2 verifies this [I].
- *Rust-side corrections to lane 4 (amend there):*
  - (a) **`invalidate`.** Lane 4's virtual napi stub imports `invalidate` from `./index.js` (the glue), which forms an import cycle. Two things are unverified:
    - worker-build's esbuild bundle (`shim.js` → `index.js`) may not re-export wasm-bindgen exports at all;
    - workerd may reject a plain function as a named export of the main module [I].
    - Default: keep lane 4's shape (`#[wasm_bindgen] pub fn invalidate(args: JsValue) -> Result<JsValue, JsValue>`; `args` = `{key?,tags?,path?,method?}`, the result is `{l1Removed, jobRemoved}`), **conditional on Task 2**.
    - Pre-ruled fallback if Task 2 fails: `brust-app.js` also exports `install(rt)`, and `#[event(start)]` calls it with `{ invalidate }` (a leaked `Closure`). Lane 4's stub then calls the installed `rt.invalidate` and its entry adds `export { install } from "@brust/core/server-handlers"`.
  - (b) **`--wasm-from-source` must run `bun crates/brust-wasm/scripts/build.ts --out <dir>`**, not bare `worker-build --release --panic-unwind`. The bare command builds on the floating nightly (R8) and skips the R1 rewrite. This changes lane 4's `cf-core.test.ts` expectation.
  - (c) **"files under `worker/` = the worker-build `build/` dir verbatim"** becomes "= `scripts/build.ts` output": `index.js` (R1-rewritten), `index_bg.wasm`, `worker/shim.mjs`.
  - (d) `CONFIG` is accepted as written: `{abi, generator, l1Capacity, jobCacheCapacity, stats, edgeCache, cors?, actions?}`. Rust adds these checks:
    - `abi != 1` → boot error;
    - `edgeCache != "off"` → boot error naming M4-CF-7;
    - unknown keys → boot error (a new key means `abi` 2);
    - `https` is fixed to `true` on Workers.
  - (e) `TEMPLATES` keyed by template rel path is fine from Rust (`from_parts` looks up `c.template`, R12). No change.
- *Alternatives:* function exports for the data (`manifestJson()` …) with `install(rt)` as the default invalidate path; that is a bigger amendment to lane 4.

**R3 — How `env`/`ctx` reach loaders and actions.**
- Passing `env, ctx` as 2nd/3rd JS args needs per-request data inside `Host::loader/jobs/action`, which get only `&self` + the request. That means a per-request context parameter on the `Host` trait (core + native signatures).
- *Default:* do not pass them. App code uses `import { env } from "cloudflare:workers"` [C …/runtime-apis/bindings/#importing-env-as-a-global] (I/O only inside a request, which loaders and actions always are) and `waitUntil` from the same module [I, Task 2 checks]. Spec §5 :338 already plans this. Lane 4's entry already passes nothing.
- *Alternative:* add `type Req` to `Host` and thread it through the pipeline (a challenge to lane 1's API).

**R4 — Action passthrough.**
- *Default:*
  - `host.rs` gains `pub enum ActionReply { Fetch(FetchResponse), Built(http::Response<Bytes>) }`, and `Host::action` returns `Result<ActionReply, CallError>`.
  - `actions.rs:88-99` maps `Fetch` through `response_from_fetch` and returns `Built` as is.
  - Native wraps `.map(ActionReply::Fetch)` (`brust-server/src/host.rs`: import, :92 signature, :140-147; a move, the same bytes on the wire).
  - `WasmHost::action` returns `Built` with the app's status and headers (framing dropped), an empty body, and an `Extensions` entry `ReplyId(u64)`. The JS `Response` waits in `WasmHost.replies: RefCell<HashMap<u64, web_sys::Response>>`.
  - After `finish`, the adapter answers `new Response(js.body /* null for HEAD */, {status, headers: <finished map>})`, so the body is never copied.
  - Delta: `max_response_bytes` is not enforced on Workers.
- *Alternative:* no trait change: copy status, headers and `arrayBuffer()` into `FetchResponse` (two body copies, no streaming, zero native edit).

**R5 — The fixture's JS before lane 4 merges.**
- *Default:* `tests/fixtures/cf-min/cf/brust-app.entry.js` is **lane 4's generated entry text** (`draft-m4cf-build-target.md` Task 6, the with-actions form) with fixture paths. Lane 4's generator gets a byte-for-byte test against it, modulo the six import paths and the `CONFIG` literal.
- The fixture's Bun plugin (`scripts/build-cf.ts`) maps:
  - `@brust/core/server-handlers` → `cf/server-handlers.shim.ts` (`makeHandlers` from `worker.ts`, `flattenRoutes`, plus local `jsonCall`, `fetchInScope = (app, req) => runInStoreContext(() => app.fetch(req))`, `noActions`);
  - `@brust/core/server-handlers/actions` → `packages/brust/src/actions/load.ts`;
  - `packages/brust/native/index.js` (napi) → `cf/native.stub.ts`, which has lane 4's R8 virtual-module semantics: `cacheInvalidate` → `import { invalidate } from "./index.js"` (external), and the other napi functions throw;
  - `node:worker_threads` → an empty stub;
  - `@brust/core[/*]` → the package's `default` (server) entries.
- If lane 4 merges first, delete the shim and resolve the real modules.
- *Alternatives:* hand-written minimal handlers (does not exercise the real `makeHandlers`/ALS); hold the e2e until lane 4 merges.

**R6 — The e2e driver.**
- *Default:* `wrangler dev` (local workerd) spawned from `bun test`. It runs as `bunx wrangler@<exact pin>` on Node ≥ 20, not as a lockfile dependency, so other CI jobs never download workerd. Flags: `--port <free> --ip 127.0.0.1 --inspector-port <free> --persist-to $OUT/state --show-interactive-dev-session=false`; env `WRANGLER_SEND_METRICS=false CI=1`. Readiness is the stdout/stderr regex `/Ready on (http:\/\/\S+)/`. `wrangler deploy --dry-run --outdir $OUT/bundle` proves the deploy bundling and prints the upload size. Real deploys only in the optional Task 12 (human rule).
- *Alternatives:* `workerd serve` with a capnp config (skips wrangler's bundling, which R1 must prove); `@cloudflare/vitest-plugin` (a second test runner).

**R7 — Workspace membership and clippy.**
- *Default:* a workspace member. `worker`/`wasm-bindgen`/`wasm-bindgen-futures`/`js-sys`/`web-sys`/`futures-util` go under `[target.'cfg(all(target_arch = "wasm32", target_os = "unknown"))'.dependencies]`. The JS-touching modules (`entry`, `host`, `bridge`, `respond`, `log`) are cfg'd to that target. The pure modules (`head`, `config`, `capped`) are `pub` and host-compiled. So `cargo build/test --workspace` covers them, and host clippy gains `-p brust-wasm`. A new step runs `cargo clippy -p brust-wasm --target wasm32-unknown-unknown --no-deps -- -D warnings`. `brust-core` is a **path** dependency with `default-features = false`: `workspace = true` cannot drop the `gzip` default (spec R13).
- *Alternative:* `exclude` the crate with its own `Cargo.lock` (isolated, but no host tests and a separate cache).

**R8 — Panic strategy.**
- *Default:* the e2e, release and `--dev` builds all use `--panic-unwind`, pinned to `nightly-2026-09-15` by a PATH shim. `scripts/pinned-bin/{cargo,rustc}` rewrite a leading `+nightly` to `+<channel of rust-toolchain.toml>`, log `[pinned] …` to stderr, and exec the next binary on PATH. worker-build hard-codes `cargo +nightly`. The fetch future is wrapped in `AssertUnwindSafe(..).catch_unwind()` → 500 `500 Internal Server Error` + `console.error`. A panic therefore never depends on how the shim treats async unwinds. Hard aborts fall to worker-build's reset-state reinit (`start` re-runs). `[profile.release]` is unchanged (no `panic` key).
- *Alternatives:* the floating nightly; `rustup toolchain link nightly <pinned sysroot>` in CI only.

**R9 — Size/CPU bars.**
- *Default:* assert `index_bg.wasm` raw < **4 MiB**; print its gzip size and the dry-run "Total Upload". CPU is not asserted: local workerd has no CPU accounting, and timing guards flake on Linux CI. The READY note reports p50 wall time of 50 MISS requests, and Task 12's real "Worker Startup Time" when run. Over 4 MiB: first add `[profile.release.package.brust-wasm] opt-level = "s"`.
- *Alternatives:* spec §6's 8 MiB; 2 MiB.

**R10 — Elysia on workerd.**
- *Default:* `.compile()` at the entry's top level (lane 4 R9). Task 9's GET/POST 200/422 under workerd are the spec R10 gate.
- If a lazily compiled validator still evals on the first request ("Code generation from strings disallowed"), the fallback is a top-level `await app.handle(new Request("http://localhost<prefix>/__warm"))` in the entry (lane 4 amendment). If that also fails → task challenge, and actions ship later per spec R10.
- *Alternative:* ship lane 3 without actions.

**R11 — The stats endpoint and boot failure.**
- *Default, stats:* gated in the adapter. Unless `CONFIG.stats`, a GET/HEAD of `/_brust/cache/stats` answers `body::resp(404, "text/plain", &[], b"not found".to_vec())` (the bytes of `error_404`) before `Core::handle`. No `CoreConfig` field, so no native edit.
- *Default, boot errors:* bad CONFIG, `from_parts` and `Core::new` errors are `console.error`'d and thrown from `start` (`wasm_bindgen::throw_str`). Module evaluation fails, and `wrangler dev`/`deploy` refuse the bundle (native parity: no partial boot).
- *Alternatives:* a `CoreConfig::stats` field (brust-server edit); 500 on every request after a failed boot.

**R12 — `Manifest::from_parts` semantics.**
- *Default:* `pub fn from_parts(manifest_json: &str, files: &BTreeMap<String, String>) -> Result<Loaded, ManifestError>`, on all targets:
  - `files` is keyed by `components[id].template` (lane 4's `TEMPLATES`); `Loaded.templates` stays keyed by component id;
  - same parse/version/reference checks, in `load`'s order;
  - a missing template → `MissingFile { component, path: PathBuf::from(&c.template) }`;
  - `client`/`assets.*` existence is **not** checked (Static Assets owns those);
  - extra keys are ignored; `Parse.path` = `"manifest.json"`; `dist_dir = PathBuf::new()`.
  - `load` and `from_parts` share one private walk with a file callback, so `load`'s error order stays byte-identical (lane-1 R5's concern).
- *Alternative:* `files` keyed by component id.

**R13 — Who writes `npm/core-cf`.**
- *Default:* this lane creates `npm/core-cf/{package.json, .gitignore (worker/)}` with lane 4's Task 9 content:
  - name `@brust/core-cf`, version `2.0.0-alpha.2` (= `packages/brust/package.json:3`), description, license, repository;
  - `files: ["worker","README.md"]`, `publishConfig.access: public`;
  - `"brust": {"abi":1,"main":"index.js","glue":"index.js","appModuleDir":".","compatibilityDate":"2026-10-01","workerBuild":"0.8.7","wasmBindgen":"0.2.129"}` with the Task 2 values;
  - plus `bun.lock`.
  - Lane 4's Task 9 then only adds `README.md` and reads the file; amend lane 4 so it does not recreate it.
  - `workerBuild` becomes the exact `0.8.7` (not `^0.8`), because the R1 rewrite is tied to its esbuild flags.
- *Alternative:* lane 4 owns the file, and this lane changes values only through a challenge.

## Contract with lane 4 (both sides must agree; lane 4's generator test diffs against `tests/fixtures/cf-min/cf/brust-app.entry.js`)
| Name | Value | Rust side (this lane) |
|---|---|---|
| raw_module specifier | `./brust-app.js` (after the R1 rewrite) | `bridge.rs` `#[wasm_bindgen(raw_module = …)]` |
| bundle location | `dist/cf/worker/<brust.appModuleDir>/brust-app.js` = `dist/cf/worker/brust-app.js`; ONE Bun bundle | resolved relative to `worker/index.js` |
| wrangler `main` | `worker/<brust.main>` = `worker/index.js` | — |
| `loader` | `(json: string) => Promise<string>` (never rejects) | `js_loader(&str) -> Result<Promise, JsValue>` |
| `jobs` | `(json: string) => Promise<string>` | `js_jobs(&str)` |
| `action` | `(req: Request) => Promise<Response>` | `js_action(web_sys::Request)` |
| `MANIFEST` | `string`, the manifest.json text | `static MANIFEST: JsString` (thread_local_v2) |
| `TEMPLATES` | `Record<string,string>` keyed by `components[id].template` | `static TEMPLATES: js_sys::Object` → `from_parts` |
| `CONFIG` | `string`; JSON `{abi:1, generator, l1Capacity, jobCacheCapacity, stats, edgeCache:"off", cors?:{origins, methods?, headers?, exposeHeaders?, credentials, maxAgeSeconds?}, actions?:{prefix, maxBodyBytes, maxResponseBytes, crossSite}}` | `config.rs` `CfConfig`, `deny_unknown_fields` |
| `invalidate` | glue export, `(args: {key?,tags?,path?,method?}) => {l1Removed, jobRemoved}`; the throw on bad args is a `TypeError` | `#[wasm_bindgen] pub fn invalidate` (fallback `install(rt)`, R2a) |
| `.compile()` | at the entry's top level (module init = startup) | — |
| `@brust/core-cf` `brust` field | R13 values; `worker/` = `scripts/build.ts` output | written by this lane |
| `--wasm-from-source` | `bun crates/brust-wasm/scripts/build.ts --out <worker dir>` | R2b |

## Boundary
- `crates/brust-wasm/**` (new): `Cargo.toml`, `.gitignore` (`build/`), `src/{lib,entry,host,bridge,respond,log,head,config,capped}.rs`, `scripts/build.ts`, `scripts/pinned-bin/{cargo,rustc}`.
- `crates/brust-core/src/manifest.rs` (from_parts + the shared walk), `host.rs` (`ActionReply`), `actions.rs` (:88-99 only), `lib.rs` (module doc).
- `crates/brust-server/src/host.rs` (the R4 wrap only).
- `Cargo.toml` (members), `Cargo.lock`, root `package.json` (`workspaces` += `tests/fixtures/cf-min`), `bun.lock`, `npm/core-cf/{package.json,.gitignore}`.
- `tests/fixtures/cf-min/**` (no root `input.tsx`), `tests/cf/**`.
- `.github/workflows/ci.yml`; `bench/attribution.patch` only if `git apply --check` fails; the spec (Task 11 status lines).
- NOT: `crates/brust-core/src/{pipeline,core,render,routing,cache}/**`, `crates/brust-napi/**`, `packages/**`, `rust-toolchain.toml`. Anything else → `conclave task challenge`.

## Tasks
Every Rust task ends green on:
- `cargo fmt --all -- --check`;
- `cargo clippy -p brust-core -p brust-compiler -p brust-compiler-cli -p brust-jinja -p brust-server -p brust-napi -p brust-wasm --no-deps -- -D warnings`;
- `cargo test -p brust-core -p brust-server -p brust-wasm`;
- from Task 6 on: `cargo clippy -p brust-wasm --target wasm32-unknown-unknown --no-deps -- -D warnings`.

`OUT=/tmp/m4cf-worker-crate` (never committed). Commit per task.

### Task 1 — worktree, base, tools, baseline
- [ ] `git -C /Users/detoro/code/brust fetch origin m4cf && git -C /Users/detoro/code/brust worktree add /Users/detoro/code/brust-lane-m4cf-worker-crate -b lane/m4cf-worker-crate origin/m4cf && cd /Users/detoro/code/brust-lane-m4cf-worker-crate && test -f crates/brust-core/src/cache/local.rs && grep -q 'pub struct JsClock' crates/brust-core/src/host.rs && echo base-ok` → `base-ok`. Otherwise lane 2 is not merged: challenge and stop.
- [ ] `bun install --frozen-lockfile && (cd packages/brust && bun run build:debug)` → exit 0. `rustup target add wasm32-unknown-unknown` → installed/up to date.
- [ ] `cargo install worker-build --version 0.8.7 --locked && worker-build --version` → `0.8.7`. `node --version` → ≥ v20.
- [ ] `npm view wrangler@4 version | tail -1` → `X.Y.Z`; write `export const WRANGLER = 'wrangler@X.Y.Z'` to `tests/cf/tools.ts`.
- [ ] `bunx wrangler@X.Y.Z dev --help | grep -E -- '--(port|ip|inspector-port|persist-to|show-interactive-dev-session|local)'` → record which flags exist; the R6 flag set follows the help text.
- [ ] `mkdir -p $OUT && cargo test -p brust-core -p brust-server 2>&1 | tee $OUT/t1.txt | grep -c '^test result: ok'`; `grep FAILED $OUT/t1.txt` → empty.
- [ ] `cargo test -p brust-core -p brust-server -- --list 2>/dev/null | grep ': test$' | sort > $OUT/names-before.txt`. `git apply --check bench/attribution.patch` → exit 0.

### Task 2 — prove the import mechanism and the contract (spec R3's "first task"; R1, R2, R3, R13)
- [ ] Skeleton crate (Task 5's `Cargo.toml`, R7). `bridge.rs` imports from the R1 specifier: `MANIFEST`/`CONFIG` as `JsString` and `TEMPLATES` as `Object` (thread_local_v2 statics), plus `loader`.
  - It exports `#[wasm_bindgen] pub fn invalidate(args: JsValue) -> JsValue` (returns `{l1Removed: 0, jobRemoved: 0}`).
  - `entry.rs` `#[event(fetch)]` answers `CONFIG + "|" + keys(TEMPLATES) + "|" + await loader("{}")`.
- [ ] `cd crates/brust-wasm && PATH=$PWD/scripts/pinned-bin:$PATH worker-build --release --panic-unwind 2>&1 | tee $OUT/wb-literal.txt | tail -5`. Record:
  - does it fail with `Could not resolve "./brust-app.js"`?
  - does `grep -c 'brust-app' build/index.js` show the import verbatim?
  - does `grep -c '\[pinned\] +nightly -> +nightly-2026-09-15' $OUT/wb-literal.txt` show ≥ 1?
- [ ] If the literal fails or is inlined: switch to the sentinel `cloudflare:brust-app` and rebuild. `grep -o '"cloudflare:brust-app"' build/index.js | wc -l` → ≥ 1. Rewrite it (`sed` for now; Task 7 scripts it).
- [ ] Record `ls build build/worker` and `grep -oE 'export\{[^}]*\}' build/index.js | head -3` (is `invalidate` among index.js's exports?).
- [ ] Spike dir `$OUT/spike/worker/` = `build/*`, plus `$OUT/spike/worker/brust-app.js`:
  ```js
  import { invalidate } from './index.js'
  export const MANIFEST = '{"m":1}', CONFIG = '{"c":1}', TEMPLATES = { 'jinja/a.jinja': 'x' }
  export async function loader(j) { const w = await import('cloudflare:workers'); return 'L' + j + typeof w.env + typeof w.waitUntil + JSON.stringify(invalidate({ tags: ['t'] })) }
  ```
  - `$OUT/spike/wrangler.jsonc` = `{"name":"spike","main":"worker/index.js","compatibility_date":"2026-10-01"}`.
  - Spawn `wrangler dev` (R6 flags) and run `curl -s <url>/`. Expected: `{"c":1}|jinja/a.jinja|L{}objectfunction{"l1Removed":0,"jobRemoved":0}`.
  - `bunx $WRANGLER deploy --dry-run --outdir $OUT/spike-bundle -c $OUT/spike/wrangler.jsonc` → exit 0.
- [ ] If the `invalidate` import from `./index.js` fails (wrangler resolve error, workerd export error, or `undefined`): retry with R2a's `install(rt)` fallback. Write the outcome to `$OUT/spike.md`: literal or sentinel; glue export or install; the statics OK; the pinned line; `waitUntil` typeof.
- [ ] Write `npm/core-cf/{package.json,.gitignore}` (R13) with the proven `main`/`glue`/`appModuleDir`. `bun install` → `bun.lock` gains the workspace; `bun install --frozen-lockfile` → 0.
- [ ] Any deviation from the lane-4 contract table → `conclave task challenge` with `$OUT/spike.md`, before Task 3. Commit.

### Task 3 — `Manifest::from_parts` (R12)
- [ ] **Tests first** (`manifest.rs`, host), red until implemented:
  - `from_parts_equals_load_on_the_fixture_dist`: read `../brust-server/tests/fixtures/dist/manifest.json` and every `jinja/*.jinja` keyed `"jinja/<file>"`. Assert `format!("{:?}", a.manifest) == format!("{:?}", b.manifest)` and `a.templates == b.templates`.
  - `from_parts_missing_template_names_component`: drop `jinja/homePage_b2.jinja` → `MissingFile { component: "homePage_b2", path: "jinja/homePage_b2.jinja" }`.
  - `from_parts_ignores_client_and_assets_files`.
  - `from_parts_bad_version` → `Version(2)`.
  - `from_parts_bad_json` → `Parse { path: "manifest.json", .. }`.
- [ ] Refactor:
  - add a private `fn walk(manifest, file: &mut dyn FnMut(&str /*component*/, &str /*rel*/, FileUse) -> Result<Option<String>, ManifestError>) -> Result<(Manifest, BTreeMap<String, String>), ManifestError>`, with `enum FileUse { Template, Client, Asset }`, holding the :358-415 checks in today's order;
  - `load`'s callback is `must_exist` (+ `read_to_string` for `Template`), and stays under lane 2's wasm cfg;
  - `from_parts`' callback is `files.get(rel).cloned()` for `Template` and `Ok(None)` otherwise.
- [ ] `cargo test -p brust-core manifest` → 5 new tests pass. `cargo test -p brust-server --test manifest` → unchanged, 0 failed. Commit `feat(core): Manifest::from_parts (M4-CF-3, lane-1 R5)`.

### Task 4 — `ActionReply` (R4)
- [ ] **Test first** (`actions.rs`): the extracted `fn reply_to_response(r: ActionReply) -> Response<Bytes>`:
  - `Built` (201, `x-a: 1`) comes back identical;
  - `Fetch` with status 99 → 500 (today's rule).
- [ ] `host.rs`: add `ActionReply`. Its doc: `Built` = the host built the response, and core returns it as is apart from `finish`; a host may carry the body out of band in `Extensions`. Change `Host::action`'s output.
- [ ] `actions.rs:88-99`: `Ok(r) => reply_to_response(r)`. `brust-server/src/host.rs`: the import, the signature, `.await.map(ActionReply::Fetch)`.
- [ ] Checks:
  - `cargo test -p brust-core -p brust-server` → the `$OUT/t1.txt` count + new;
  - `cargo test -p brust-server --test actions` → 0 failed;
  - `git apply --check bench/attribution.patch` → 0;
  - `(cd packages/brust && bun run build:debug && bun test)` → green.
  - Commit.

### Task 5 — crate + pure modules (host-tested)
- [ ] `crates/brust-wasm/Cargo.toml`:
  - `[lib] crate-type = ["cdylib"]`;
  - `brust-core = { path = "../brust-core", default-features = false }`, `http`, `bytes`, `serde`/`serde_json` (workspace), `tracing = "0.1"`;
  - the R7 wasm table: `worker = "=0.8.7"`, `wasm-bindgen = "=0.2.129"`, `wasm-bindgen-futures = "0.4.79"`, `js-sys = "0.3.106"`, `web-sys` (features `Request, RequestInit, Response, ResponseInit, Headers, ReadableStream, console`), `futures-util = { version = "0.3", default-features = false, features = ["std"] }`;
  - `[lints] workspace = true`.
  - Root members += `"crates/brust-wasm"`.
- [ ] **Tests first**, then code:
  - `head.rs`:
    - `split_url("https://a.example:8443/x?q=1") == Some(("a.example:8443", "/x?q=1"))`; a missing path → `"/"`; the fragment is dropped;
    - `header_map(pairs)` keeps repeats and skips invalid pairs;
    - `action_url(headers, authority, full)` = `http://<host>` + full when the host matches `^[A-Za-z0-9.\-:\[\]]+$`, else `http://localhost` (parity with `actions-bridge.ts:71-77`);
    - `is_stats(method, full)` is true only for GET/HEAD of `/_brust/cache/stats`.
  - `config.rs`: `CfConfig` (the contract `CONFIG`) → `(CoreConfig, stats: bool)`. Required: `abi == 1` and `edgeCache == "off"`; defaults `WORKERS_*`; `https: true`. Tests: bad `crossSite`, `abi: 2`, `edgeCache: "workers-cache"`, and an unknown key → `Err` naming the field.
  - `capped.rs`: `Capped { cap, buf }`. `declared(Option<&str>)` → TooLarge when the Content-Length is over the cap; `push(&[u8])` → TooLarge the moment `len > cap`.
- [ ] `cargo test -p brust-wasm` → passed. `cargo build --workspace` → 0. Host clippy incl. `-p brust-wasm` → 0 warnings. Commit.

### Task 6 — `WasmHost`, bridge, entry, respond, log (wasm32 only)
- [ ] `bridge.rs`: the contract externs (`#[wasm_bindgen(catch)]` on the three functions), the statics, and `#[wasm_bindgen] pub fn invalidate(args: JsValue) -> Result<JsValue, JsValue>`:
  - `JSON.stringify(args)` → `InvalidateArgs` (bad → `TypeError`);
  - `CORE.with(..).invalidate` → `{l1Removed, jobRemoved}`;
  - before boot → a `TypeError("brust core not started")`.
  - The module doc reproduces the contract table.
- [ ] `host.rs`: `WasmHost { clock: JsClock, replies: RefCell<HashMap<u64, web_sys::Response>>, next: Cell<u64> }`.
  - `type Body = worker::Request; type L1 = LocalL1<JsClock>; type Jobs = LocalJobs<JsClock>; const PLAN_OFFER = false`.
  - `loader`/`jobs`: `serde_json::to_string(req)` → `JsFuture::from(promise).await`. A non-string → `BadResponse`; a rejection → `Rejected(js_error_string)`; parse errors → `BadResponse`. `loader` returns `(r, None)`.
  - `read_body`: `Capped::declared(content-length)`; a body of `None` → empty; else `stream()` chunks → `push`. A stream error → `Io`. Never `Slow`.
  - `action`: builds a `web_sys::RequestInit`:
    - method;
    - headers minus framing, plus `host` from `authority` when absent (native :122-126);
    - a `Uint8Array` body unless GET/HEAD;
    - URL `action_url(..)`.
    - It awaits `js_action` → `dyn_into::<web_sys::Response>()` (else `BadResponse`) → `Built` + `ReplyId` (R4).
  - `static_file` → `None`.
- [ ] `respond.rs`:
  - `to_web(http::Response<Bytes>, head) -> worker::Result<worker::Response>`: values appended one by one (repeated `set-cookie` kept), framing skipped, the body a `Uint8Array` or null;
  - `rewrap(js, parts, head)`.
- [ ] `log.rs`: a minimal `tracing::Subscriber`. fixed level WARN and up. ERROR → `console.error`, WARN → `console.warn`. A `Visit` builds one line. No time.
- [ ] `entry.rs`:
  - `thread_local! { static CORE: OnceCell<&'static Core<WasmHost>> }`.
  - `#[event(start)]`: set the panic hook (`console_error!`) and the subscriber; read `CONFIG`/`MANIFEST`/`TEMPLATES` → `CfConfig` → `from_parts` → `Core::new` → `Box::leak`. Errors → R11 throw.
  - `#[event(fetch)]`:
    - method = `req.inner().method()`; `split_url(&req.inner().url())`; `header_map(req.headers().entries())`; `origin`; `head`;
    - the R11 stats gate;
    - `if option_env!("BRUST_WASM_E2E").is_some() && full == "/__brust_e2e/panic" { panic!("brust e2e: deliberate panic") }`;
    - `AssertUnwindSafe(core.handle(rq, req)).catch_unwind().await`. `Err` → `console_error!` + 500. `Ok(mut r)` → `core.finish(origin.as_ref(), r.headers_mut())`, then `ReplyId` → `rewrap(host.take(id), ..)`, else `to_web`.
- [ ] Checks:
  - wasm clippy → 0;
  - `cargo tree -p brust-wasm --target wasm32-unknown-unknown -e features | grep -c flate2` → 0 (spec R13).
  - Commit.

### Task 7 — `crates/brust-wasm/scripts/build.ts` (the packaging step; R1, R8, R9)
- [ ] `bun crates/brust-wasm/scripts/build.ts [--dev] [--e2e] --out <dir>` (default `--out npm/core-cf/worker`):
  1. prepend `scripts/pinned-bin` to PATH;
  2. under `--e2e`, set `BRUST_WASM_E2E=1`;
  3. run `worker-build --release --panic-unwind` (or `--dev --panic-unwind`) in `crates/brust-wasm`, and exit 1 when stderr lacks the `[pinned]` line;
  4. apply the R1 rewrite, asserting the counts;
  5. copy `index.js`, `index_bg.wasm` and `worker/shim.mjs` to `--out`;
  6. print `wasm raw=<n> gzip=<n>`, and exit 1 when raw ≥ 4 MiB.
- [ ] `bun crates/brust-wasm/scripts/build.ts` → exit 0; `ls npm/core-cf/worker` → the three files. Commit.

### Task 8 — fixture `tests/fixtures/cf-min`
- [ ] `package.json`: `@brust/fixture-cf-min`, private; deps `@brust/core: workspace:*`, `react`, `react-dom`, `elysia 2.0.0-beta.30` (the pokedex versions).
- [ ] `brust.toml`: `[actions]` with `max_body_bytes = 1024`.
- [ ] `routes.tsx`:
  - `/` → `pages/Home.tsx` (static, the text `cf-min home`);
  - `/items/{id}` → `pages/Item.tsx` with `loader: ({params}) => ({ item: { id: params.id, price: Number(params.id) * 100 } })` and `cache: { ttl_seconds: 60, tags: ['items'] }`. The page calls `formatPrice(item.price)` from `lib/money.ts` → a precompute job, as in `tests/fixtures/product-card`;
  - `/island` → `pages/Island.tsx` with `components/Counter.tsx` (`useState` + `useContext` → the React tier with an `ssr` job).
- [ ] `actions.ts`: `new Elysia({ adapter: brust() }).get('/hello', () => ({ hello: 'cf' })).post('/bump', ({ body }) => cache.invalidate({ tags: [body.tag] }), { body: t.Object({ tag: t.String({ minLength: 1 }) }) })`.
- [ ] `public/app.css`; `.gitignore` (`dist/`, `.wrangler/`). **No root `input.tsx`.**
- [ ] `cf/brust-app.entry.js`: lane 4's Task 6 text (with actions) with fixture paths (R `../routes.tsx`, J/JM `../dist/jobs.js` (lane 4 uses `.stage/jobs.ts`, which `brust build` deletes), A `../actions.ts`, M `../dist/manifest.json`, T `../dist/cf/templates.json`) and the `CONFIG` literal for `{abi:1, generator:"brust/cf-e2e", l1Capacity:256, jobCacheCapacity:512, stats:true, edgeCache:"off", cors:{origins:["https://ok.example"], credentials:false}, actions:{prefix:"/_brust/action", maxBodyBytes:1024, maxResponseBytes:8388608, crossSite:"reject"}}`. Also `cf/server-handlers.shim.ts`, `cf/native.stub.ts`, `cf/empty.ts` (R5).
- [ ] `scripts/build-cf.ts`:
  1. `packages/brust/bin/brust build routes.tsx`;
  2. `dist/cf/templates.json` = `{components[id].template: read(dist/<that>)}`;
  3. `Bun.build` the entry → `dist/cf/worker/brust-app.js` (`target: 'browser'`, `conditions: ['workerd','worker']`, `external: ['cloudflare:*','node:*','./index.js']`, NODE_ENV production, the R5 plugin). Fail on `/\bBun\.|import\.meta\.require|\.node["']/` in the output;
  4. copy `npm/core-cf/worker/*` → `dist/cf/worker/` (build them first with `--e2e` unless `BRUST_CF_WASM_READY=1`);
  5. `dist/cf/assets/_brust/client/*` ← `dist/client/*`, `dist/cf/assets/public/*` ← `dist/public/*`;
  6. `dist/cf/wrangler.jsonc` = `{ name: "brust-cf-min", main: "worker/index.js", compatibility_date: <npm/core-cf brust.compatibilityDate>, assets: { directory: "assets", binding: "ASSETS", run_worker_first: false } }`.
- [ ] Root workspaces += `"tests/fixtures/cf-min"`; `bun install` → `bun.lock` gains only that workspace; `--frozen-lockfile` → 0. `cargo test -p brust-compiler --test fixtures --test dual_eval` → unchanged counts. `bun tests/fixtures/cf-min/scripts/build-cf.ts` → exit 0. Commit.

### Task 9 — e2e `tests/cf/cf-min.test.ts`
- [ ] `describe.skipIf(process.env.BRUST_CF_E2E !== '1')`.
  - `beforeAll`: run `build-cf.ts`; run `wrangler deploy --dry-run --outdir $OUT/bundle -c dist/cf/wrangler.jsonc` → 0 and print "Total Upload"; spawn `wrangler dev` (R6) and wait ≤ 120 s for `Ready on`.
  - `afterAll`: SIGINT our PID, SIGKILL after 5 s; the port then refuses. The test never kills a process it did not spawn.
- [ ] Assertions, one `test` each, in order (`S()` = GET `/_brust/cache/stats`):
  1. `GET /` → 200 `text/html`, has `cf-min home`, `x-powered-by: brust/cf-e2e`; `S().loader_calls == 0`.
  2. `GET /items/7` → 200, has `$7.00`, `x-brust-cache: MISS`; repeated → `HIT`; `S().loader_calls == 1`, `S().job_calls == 1`.
  3. `GET /island` → 200, has the island's SSR markup and its client `<script>`; `S().job_calls == 2`.
  4. `HEAD /items/7` → 200, empty body.
  5. `GET /_brust/action/hello` with `Origin: https://ok.example` → 200 `{"hello":"cf"}`, ACAO `https://ok.example`, `x-powered-by` present.
  6. `POST /_brust/action/bump` `{"tag":"items"}` (same-origin, JSON) → 200 with `l1Removed ≥ 1`; then `GET /items/7` → `MISS`; `S().loader_calls == 2`.
  7. `POST …/bump` `{}` → 422.
  8. `POST …/bump` with `Origin: https://evil.example` → 403 `application/problem+json`, `title == "CrossSiteRejected"`.
  9. A 2048-byte POST → 413; `content-encoding: gzip` → 415.
  10. `OPTIONS /items/7` with `Origin: https://ok.example` + `Access-Control-Request-Method: GET` → 204 with ACAO.
  11. `GET /_brust/client/<manifest runtime>` → 200 **without** `x-powered-by`; `/_brust/client/nope.js` → 404 `not found` **with** it; `/public/app.css` → 200; `/public/nope.txt` → 404.
  12. `GET /__brust_e2e/panic` → 500 within 10 s; the output has `panicked at`; then `GET /` → 200 and `/items/7` → `HIT` (same isolate).
  13. `index_bg.wasm` < 4 MiB.
- [ ] `BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf` → 13 pass, 0 fail. Without the env → 0 run, exit 0. p50 of 50 distinct-id MISSes → `$OUT/latency.txt`. Commit.

### Task 10 — CI
- [ ] `ci.yml` rust job: `:39` += `-p brust-wasm`; after lane 2's wasm steps, add the wasm clippy step.
- [ ] New `cf` job (ubuntu-latest):
  - checkout;
  - `dtolnay/rust-toolchain@master` `nightly-2026-09-15`, `rust-src`, targets `wasm32-unknown-unknown`;
  - the rust job's cargo cache with key prefix `cargo-cf-`;
  - cache `~/.cargo/bin/worker-build` (key `worker-build-0.8.7`), then `cargo install worker-build --version 0.8.7 --locked` if missing;
  - `actions/setup-node@v4` node 22; `oven-sh/setup-bun@v2` canary;
  - cache `~/.bun/install/cache` on `hashFiles('bun.lock','tests/cf/tools.ts')`;
  - `bun install --frozen-lockfile`; `cd packages/brust && bun run build:debug`;
  - `BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf`.
  - **No Cloudflare credentials in CI** (Task 12 is local-only).
- [ ] Run the cf job commands locally → 0 (`$OUT/ci.txt`).
- [ ] If `git apply --check bench/attribution.patch` fails, regenerate it as lane 2's Task 8 did (`--3way`, reset before checkout, `git clean -fq crates/brust-core/src/perf.rs`, guard `git status --short` → only ` M bench/attribution.patch`). Commit.

### Task 11 — docs
- [ ] Spec §3 status line under :151: "M4-CF-3 done @<sha>: brust-wasm, `from_parts`, `ActionReply` (R4), contract v1 (R2), import <literal|sentinel> (R1), invalidate <glue export|install>".
- [ ] Spec §4: the bridge (:235-245) and the entry (:265-275) follow the contract table; "Generated dist/cf" uses `worker/` and `main: worker/index.js`. Commit `docs(m4cf): worker crate landed`.

### Task 12 (optional, after Task 9 is green) — real-edge proof (human rule 2026-10-12)
This is the one proof local workerd cannot give: Static Assets routing on the edge, the real startup limit, and `--panic-unwind` in production. Local workerd stays the e2e and CI default. Run it on the lead's host only (logged-in `wrangler`). Never paste the URL, account id, `whoami` or `deployments list` output; record only commands with `$NAME` expanded, status codes and header presence.
- [ ] `tests/cf/edge-proof.ts`, run as `bun tests/cf/edge-proof.ts`, with deploy → verify → delete in `try/finally`, so the delete runs on every path:
  ```sh
  NAME=brust-test-m4cf-worker-crate-$(git rev-parse --short HEAD)   # ≤ 63 chars
  bunx $WRANGLER deploy -c tests/fixtures/cf-min/dist/cf/wrangler.jsonc --name $NAME > $OUT/edge-deploy.txt 2>&1
  URL=$(grep -oE 'https://[^ ]+\.workers\.dev' $OUT/edge-deploy.txt | head -1)
  grep -oE 'Worker Startup Time: [0-9]+ ms' $OUT/edge-deploy.txt    # must be < 1000
  curl -s -o /dev/null -w '%{http_code}\n' $URL/                       # 200
  curl -sI $URL/_brust/client/<runtime> | grep -ci '^x-powered-by'     # 0 (served by Static Assets)
  curl -sI $URL/_brust/client/nope.js | head -1; curl -sI $URL/_brust/client/nope.js | grep -ci '^x-powered-by'   # 404, 1
  curl -s -o /dev/null -w '%{http_code}\n' $URL/items/7                # 200; again → header x-brust-cache HIT
  curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -H "origin: $URL" -d '{"tag":"items"}' $URL/_brust/action/bump   # 200
  curl -s -o /dev/null -w '%{http_code}\n' $URL/__brust_e2e/panic      # 500
  curl -s -o /dev/null -w '%{http_code}\n' $URL/                       # 200 (isolate survived)
  bunx $WRANGLER delete --name $NAME --force                           # finally
  ```
- [ ] Verify the cleanup:
  - `bunx $WRANGLER deployments list --name $NAME >/dev/null 2>&1; echo $?` → non-zero (the Worker is gone); record the exit code only;
  - poll `curl -s -o /dev/null -w '%{http_code}' $URL/` for ≤ 60 s → `404`.
  - No KV/D1/R2 is created by this lane, so the Worker is the only resource.
- [ ] If the delete fails, retry it, then challenge immediately with the name (not the URL).

## Acceptance
- **A1:** wasm clippy and the host clippy line (incl. `-p brust-wasm`) → 0. `cargo test --workspace --exclude bun_react_compiler` → no FAILED.
- **A2:**
  - `cargo tree -p brust-wasm --target wasm32-unknown-unknown -e features | grep -E 'flate2'` → empty;
  - `cargo tree -p brust-wasm --target wasm32-unknown-unknown -i wasm-bindgen | head -1` → `wasm-bindgen v0.2.129`;
  - the host `cargo tree -p brust-wasm -e normal` has no `worker`.
- **A3:** `BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf` → 13 pass. The READY note pastes the summary, the size line, the dry-run Total Upload and `$OUT/spike.md`.
- **A4 (native untouched):**
  - `git diff origin/m4cf --stat -- crates/brust-server crates/brust-core/src/pipeline.rs` → only `crates/brust-server/src/host.rs` (≤ 6 lines);
  - `git diff origin/m4cf -- crates | grep -E '^-\s*(debug_)?assert'` → empty;
  - the names list vs `$OUT/names-before.txt` → only `>` lines;
  - `git apply --check bench/attribution.patch` → 0.
- **A5:** `test ! -e tests/fixtures/cf-min/input.tsx` → 0. The compiler `fixtures`/`dual_eval` counts are unchanged.
- **A6:** `rg -n 'raw_module' crates/brust-wasm/src` → only the R1 specifier. `rg -n 'unsafe' crates/brust-wasm/src` → empty.
- **A7:** `git diff origin/m4cf --stat -- packages` → empty. `grep -c '^export const \(loader\|jobs\|action\|MANIFEST\|TEMPLATES\|CONFIG\) ' tests/fixtures/cf-min/cf/brust-app.entry.js` → 6, and the file's line count matches lane 4's with-actions snapshot. The byte-for-byte diff modulo paths is lane 4's test.
- **A8 (if Task 12 ran):**
  - the note lists the exact `deploy --name brust-test-m4cf-worker-crate-<sha>` and `delete --name … --force` commands;
  - `deployments list --name` exits non-zero afterwards and the URL returns 404;
  - no account id, URL or wrangler listing appears anywhere in the note or the repo (`git grep -nE 'workers\.dev|account_id' -- tests crates npm` → empty).

## Gates
- `cargo fmt --all -- --check`; the clippy line with `-p brust-wasm`; `cargo test --workspace --exclude bun_react_compiler`; release `cargo test -p brust-server --release --test single_roundtrip`.
- `cd packages/brust && bun run build:debug && bun run build && bun run typecheck && bun test` (`ActionReply` + the addon rebuild).
- `tests/server/pokedex.test.ts`, `tests/server/hydrate.chromium.test.ts`, `bun run browser-test`, `bun run battery` (+ report diff), `bun run m2-exit` (+ diff, `bun test scripts/m2-exit`): the native actions path changed type-only, and `bun.lock` gained two workspaces.
- bench `lib` tests + `bench/apps/brust` tests + typecheck; `git apply --check bench/attribution.patch`.
- New: the wasm clippy step and the `cf` job.
- No bench (no hot-path change; `ActionReply::Fetch` is a move). Do not take `bench:host-lock`.

## Risk ledger
- **R1/R2 mechanism.** A later worker-build may change its esbuild flags or shim exports, so the version is pinned (`=0.8.7`). The rewrite asserts its counts. Task 2 proves the import, the statics and `invalidate` before any other work, and the e2e's #6 re-proves `invalidate` on every run.
- **Import cycle** (`index.js` ↔ `brust-app.js`). It is safe only while `brust-app.js`'s top level never calls `invalidate`, and the entry's top level calls `makeHandlers` and `.compile()` only. A cycle-order bug shows as a startup `ReferenceError` in `wrangler dev`.
- **Pinned toolchain.** If the PATH shim is bypassed, worker-build uses (and may install) the floating nightly. `build.ts` fails without the `[pinned]` stderr line.
- **Async panics.** `catch_unwind` covers panics while the request future is polled. A panic inside `invalidate` throws into JS → the action rejects → the app's error → 500. Hard aborts reinit the instance, and L1 is lost.
- **`LocalL1` RefCell reentrancy.** `invalidate` runs while request futures are parked at `.await`, never inside a borrow (lane 2's interleaving test). A `BorrowMutError` would show in #6 as a 500 + `panicked at`.
- **The reply slab** leaks one entry per panic between `action` and `rewrap`. This is noted in a doc comment.
- **Bundle drift (R5).** The fixture shim tracks lane 4's entry text. Lane 4's snapshot diff (A7) catches drift. `@brust/core` resolving its `browser` entry would drop `cache.invalidate`; the plugin pins it, and #6 catches a slip.
- **Elysia JIT (R10).** "Code generation from strings disallowed" in the wrangler output fails #6/#7 → the R10 fallback, then challenge.
- **URL normalisation.** workerd resolves `..` and `\` before brust sees the URL, so `ambiguous_path` cannot fire on Workers. This is an accepted delta, documented in `bridge.rs`.
- **Determinism.** Local workerd runs one isolate [I], so the stats counts are exact. If not, assert deltas around each step instead.
- **Shared host.** Ports and the inspector port are probed per run; never pattern-kill (memory). Task 12 resources are always deleted in `finally`; a failed delete is escalated at once.
- **Lock churn.** `worker` adds `matchit 0.7`, `wasm-bindgen-futures`, `chrono`, `url` and others. A2 pins `wasm-bindgen 0.2.129`; a bump breaks worker-build's CLI download match.
- **Stale addon.** After Task 4, run `bun run build:debug` before any JS test.

## Reporting
`conclave task note 838f12fb-70c1-41b7-acf2-d4065cf6bb64 m4cf-worker-crate READY @<sha> …`. The note must contain:
- the commit list;
- R1-R13 as implemented and `$OUT/spike.md` (literal or sentinel; glue export or install; the statics; the pinned proof; `env`/`waitUntil`);
- A1-A8 outputs;
- the e2e summary (13/13), the wasm raw/gzip sizes, the dry-run Total Upload, and p50 (info only);
- if Task 12 ran: the deploy and delete commands, the startup ms, the status codes, and the post-delete exit code and 404;
- the `Cargo.lock`/`bun.lock` additions;
- every gate with its result;
- the line: "native path: `pipeline.rs` untouched; brust-server = the `ActionReply::Fetch` wrap only".

Escalate with `conclave task challenge 838f12fb-70c1-41b7-acf2-d4065cf6bb64 m4cf-worker-crate "<what, evidence>"` for any of these:
- Task 2 deviates from the lane-4 contract table;
- neither R1 variant survives;
- worker-build cannot be pinned;
- Elysia fails after the R10 fallback;
- any change needed in `pipeline.rs`/`core.rs`, lane 2's `local.rs` or `packages/**`;
- an existing assertion must change;
- a Task 12 delete fails;
- a file outside the Boundary.


> **Contract-table amendments (lead ruling on Mellow's drift findings D1-D3, 2026-10-12):** D1 strike any `#[wasm_bindgen] pub fn invalidate` glue-export wording — `install(rt)` is binding (ruling 19753649). D3 THIS lane owns the byte-for-byte test: drive lane 4's `cfEntrySource` with the fixture's paths/CONFIG and diff against `tests/fixtures/cf-min/cf/brust-app.entry.js` (which includes the `install` re-export line); Mellow checks for it in review.
