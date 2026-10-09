# M2c — napi addon + `@brust/core` package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: `v2` after `m2b-server-port` (PR #122) merges (m2a @61af3c0 and m2d are already in; S6 amended @47e5c5c)

**Goal:** `crates/brust-napi` binds `brust-server` and `brust-compiler` for Bun; `packages/brust` (npm `@brust/core`) gives an app `defineRoutes`/`cache`/verdicts/`Outlet`, `brust build` (routes → compiler → `dist/` + `manifest.json` in the shape `brust_server::manifest::Manifest::load` accepts) and `brust start` (Rust serves, N Bun workers answer `loader`/`jobs`). An end-to-end bun test builds a fixture app with the CLI, starts it and proves every S7 behaviour from the outside.

**Architecture:** one cdylib (`crates/brust-napi`) with two modules: `server.rs` (process-global `Arc<brust_server::Server>`, the `TsfnDispatch` impl of `RenderDispatch`, ready/drain/invalidate/stats) and `compile.rs` (`compileTree` = `pipeline::compile_tree` inside `run_on_compiler_thread`, IR as JSON). `packages/brust/src` is plain TS run by Bun (no bundling of the package itself, like `runtime-dom`): `routes.ts` (tree + ids + verdicts), `worker.ts` (SAB slot writer + the two handlers), `build/` (scan → compile → emit → bundle → manifest), `run.ts` (boot), `cli.ts`. The manifest is the only build→server contract (S6 + amendments); the Bun call shapes are `protocol.rs`.

**Tech Stack:** Rust nightly-2026-09-15, napi-rs 3 (`napi` features `napi6`,`async`; `napi-derive` 3; `napi-build` 2), `@napi-rs/cli` ^3, Bun 1.4.2 (`Bun.build`, `Bun.resolveSync`, `Bun.Transpiler`, `Worker`), React 19 (`react-dom/server` in the jobs bundle only), bun:test.

**Spec:** `docs/design/2026-10-09-m2-server-design.md` S1, S3, S4, S5, S6 (+ amendments @47e5c5c), S7, S8, S9, S10, S12, §7, §8; map `docs/plans/2026-10-09-m2-map.md` contracts 1–9.

## Decisions (final, from the lead; this plan argues from them)

- **D1** `crates/brust-napi` binds BOTH crates (S3): `startServer`, `registerWorker` (kind FIRST tsfn arg; response = plain JSON in the slot, length returned, no meta framing — `dispatch.rs:23-26`), `untilReady`, `beginDrain`, `cacheInvalidate`, `cacheStats`; `compileTree` through lowering (contract 9).
- **D2** `packages/brust`: `routes.ts` (ONLY `path/Component/loader/cache/children`, else "<field> is not supported in M2 (M3)"), `cache.ts`, `run.ts`, `worker.ts`, `build/`, `cli.ts`, `index.ts`, `bin/brust`.
- **D3** build steps (1)–(7) of the lead's brief with the S6 amendment folded in. **D4** e2e bun test on a fixture app + CI `server` job.
- **D5** workspace member `packages/brust` = `@brust/core` 0.0.0 private; napi block `brust` / `@brust/native` / six targets; loader generated into `native/`. No `optionalDependencies` yet (m2e; the `--frozen-lockfile` 404 trap, `brust/.github/workflows/ci.yml:59-62`).
- **D6 (coordinator amendment, S6 @47e5c5c)** every manifest `jobs[]` record carries `"outputs": [...]` verbatim from `JobDecl.outputs`; a react-tier CHILD is NOT a `children[]` record — its `ssr` job sits in the PARENT's `jobs[]` as the IR emits it (parent-scope inputs, `outputs ["_ssr_<childId>"]`, `per_instance` = the list context path when `per_item` is set); `ssr` records also carry `"target": "<react component id>"`, which the server passes through as `JobCall.target` and the worker uses as `jobs[target].ssr(inputs)`; `"*"` inputs are copied as-is; `children[]` come ONLY from IR `instances[]`; every compiled component gets a record (a react component's own record has tier `react`, the island-host template and its own ssr job `inputs ["*"]`, `target` = itself).

> **Base update (lead, 2026-10-09, v2 @dba91da):** this plan was drafted against the m2b lane
> before its fix round. All `crates/brust-server/...` citations now refer to the merged crate on
> `v2`; line numbers may have shifted — locate symbols by name. The REFERENCE manifest is the live
> fixture `crates/brust-server/tests/fixtures/dist/manifest.json` on `v2` (ssr jobs sit on the
> parent with `outputs`/`target`/`props`; `children[]` only for inlined children with jobs, plus the
> `client_only` static entry), NOT the copy pasted into Task 6 below — if they differ, the fixture
> wins and Task 6's expected JSON follows it. The S6 amendments block in the spec is binding.

## Global Constraints

- Contract 1 (manifest): written from the IR exactly as S6 + amendments say; if the IR and S6 disagree, `task challenge` — never patch around in this lane. Contract 2: the island host is emitted by the compiler (`lower/mod.rs:82-86`), untouched here. Contract 3: the react shim pushes `[id, hydrate]` onto `globalThis.__brustIslands` then calls `__brustIslandReady?.()` (`packages/runtime-dom/README.md:65-78`). Contract 4: `useId` is server-allocated (`render.rs:159-168`); the build only copies `use_id_slots`. Contract 5: `outlet-outside-layout` is raised HERE from `uses_outlet` + the route tree. Contract 6: the client bootstrap mounts `document.documentElement`. Contract 7: Bun call shapes are `protocol.rs:13-98` (request inline JSON, response in the SAB slot). Contract 8: the napi surface wraps `brust_server::{start, Server::{register_worker, invalidate, stats, request_drain, wait_drain_done}}` (`config.rs:176-241`). Contract 9: a build compiles every component through lowering (`pipeline.rs:20-25`); `Err(Diagnostic)` from `compile_tree` is a build error; an IR-only pass is never a build.
- **SAB rule** (`dispatch.rs:8-21`): requests cross as inline JSON; the SAB carries responses only; the worker writes into its slot's sub-region `[slot*sub, slot*sub+sub)`, `sub = floor(len / slots)` (`dispatch.rs:89-119`), and resolves the byte length (> 0, ≤ sub). Never try an SAB request.
- **D6 contract note for m2b:** the server passes `job.target` through in `JobCall` as `target` (S6 @47e5c5c). The worker calls `jobs[call.target ?? call.componentId].ssr(call.inputs)`. The SERVER remaps prop names: an ssr job record for a react child carries `"props": { childProp: parentPath|null }` copied verbatim from the IR `JobDecl.props` (lane `m2a2-ssr-props`, S6 amendment); a `null` path is `BuildError('ssr-prop-not-a-path', '<component> job j<n>: prop <name> is not a props path')`. The server evaluates the map and sends the child's props object as `JobCall.inputs`; the WORKER then merges the job's `literals` (manifest `components[componentId].jobs[<jobId>].literals`, looked up from the `<componentId>/<jobId>` prefix of `JobCall.id`) over `call.inputs` before `jobs[target].ssr(props)` — T4 adds that merge with a unit test (`limit: 3` present in the rendered props; a path prop wins over a same-named literal never happens because the compiler puts a prop in exactly one of the two maps). The fixture app may therefore pass renamed/nested props (`<Card item={it}/>`).
- No React in `runtime-dom`; React enters only through the react shims (client) and the jobs bundle (server). Every `Bun.build` of emitted artifacts resolves relative imports against the component's SOURCE directory (both `.client.js` and `.server.ts` emit `import { x } from "./helper"` — `lower/client.rs:242`, `lower/server.rs:97`) through one plugin; nothing is copied next to generated files.
- No hand-edited generated files: `native/index.js`/`index.d.ts` come from `napi build`; `dist/` is always regenerated; the pinned manifest in T6 is regenerated by the build and reviewed, never typed.
- Resolved before this lane starts: the compiler accepts `cache` from `'@brust/core'` as well as `'brust'` (lane `m2a2-ssr-props`, merged into the base of this lane). The fixture app uses route-level `cache` only; `cache(Comp, opts)` identity + `cache.invalidate` ship regardless (T3).
- Component ids hash the path string passed to the compiler (`ir/mod.rs:133-156`): the build always passes app-root-relative paths with `root` = the app dir, so ids are stable across machines.
- Gates: `cargo fmt --all -- --check`, `cargo clippy -p brust-napi --no-deps -- -D warnings`, `cd packages/brust && bun run typecheck && bun test`. Commit per task; one PR from `lane/m2c-napi-package` to `v2`.

## Review Focus

1. **Silent manifest drift** — a `children[]`/`jobs[]` record the server accepts but that names the wrong slot (`__<id>_<k>` order, `per_instance` not a context path, missing `outputs`/`target`). Pinned by T6 `build-manifest.test.ts` (expected JSON + `Manifest::load` oracle through `startServer`) and T8 e2e per-row values painted per row.
2. **Response larger than the slot** — the worker must never write past `sub`; it writes `{"error":…}` instead and the server 500s with a log line, not a corrupted neighbour slot. Pinned by T4 `writeSlot` test (cap = 64 bytes).
3. **A loader/job that throws crosses the tsfn** — the handler never rejects: `{error}` / `{id,error}`. Pinned by T4 tests "loader throws" and "job throws keeps the other results".
4. **Build-time diagnostics swallowed** — an `Error` from lowering (`nested-instance`, `outlet-in-react`) or `outlet-outside-layout`/unsupported route field/unresolvable Component must fail `brust build` with exit 1 and the rule name. Pinned by T5 negative tests (RUN, not read).
5. **Static route touches Bun / HIT touches Bun** — pinned by T8 (`/` → `loader_calls` 0 and no `<script`; `/items/x` second request `x-brust-cache: HIT` with `loader_calls` unchanged).

---

### Task 1: `crates/brust-napi` skeleton + `compileTree`

**Files:**
- Modify: `Cargo.toml` (workspace `members` += `"crates/brust-napi"`), `Cargo.lock`
- Create: `crates/brust-napi/Cargo.toml`, `crates/brust-napi/build.rs`, `crates/brust-napi/src/lib.rs`, `crates/brust-napi/src/compile.rs`
- Create: `packages/brust/package.json`, `packages/brust/tsconfig.json`, `packages/brust/native/.gitignore` (`*.node`, `index.js`, `index.d.ts`)
- Modify: `package.json` (root `workspaces` already `packages/*` — no change), `bun.lock` (via `bun install`)
- Test: `crates/brust-napi/src/compile.rs` (unit), `packages/brust/test/napi-compile.test.ts`

**Interfaces:**
- Consumes: `brust_compiler::pipeline::compile_tree(path, None, &AnalyzeOptions{server_only, root}, runtime_import) -> Result<Vec<Lowered>, Diagnostic>` (`pipeline.rs:20-25`), `Lowered{ir: Rc<ComponentIR>, artifacts: Artifacts{jinja, server_ts, client_js, diagnostics}}` (`pipeline.rs:12-15`, `lower/mod.rs:29-37`), `parse::run_on_compiler_thread` (`parse/mod.rs:118-132`), `AnalyzeOptions{server_only, root}` (`analyze/component.rs:79-84`), `Diagnostic{class, rule, message, line, col, remediation}` (`ir/mod.rs:33-41`), `DEFAULT_RUNTIME_IMPORT` (`lower/mod.rs:26`).
- Produces (JS, camelCased by napi-rs — snake_case keys are silently dropped, memory `napi-object-camelcase-keys`):
  - `compileTree(path: string, root: string, runtimeImport: string, serverOnly: string[]): CompiledTree`
  - `interface CompiledTree { components: CompiledComponent[]; error?: NapiDiagnostic }`
  - `interface CompiledComponent { id: string; source: string; ir: string /* ComponentIR JSON */; jinja: string; serverTs?: string; clientJs?: string; diagnostics: NapiDiagnostic[] }`
  - `interface NapiDiagnostic { class: 'error'|'fallback'|'warning'|'info'; rule: string; message: string; line: number; col: number; remediation: string }`

- [ ] **Step 1: Workspace + crate skeleton**

`Cargo.toml` members: add `"crates/brust-napi"` after `"crates/brust-server"`. Create `crates/brust-napi/Cargo.toml`:
```toml
[package]
name = "brust-napi"
version.workspace = true
edition.workspace = true
license.workspace = true
description = "napi-rs binding of brust-server and brust-compiler for Bun (@brust/native)"

[lib]
crate-type = ["cdylib"]
[dependencies]
brust-server = { path = "../brust-server" }
brust-compiler = { path = "../brust-compiler" }
napi = { version = "3", default-features = false, features = ["napi6", "async"] }
napi-derive = "3"
parking_lot = "0.12"
serde_json.workspace = true
tokio = { version = "1", features = ["rt-multi-thread", "time", "sync"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
[build-dependencies]
napi-build = "2"
[lints]
workspace = true
```
`build.rs` is the 0.1.x one verbatim (`brust/crates/brust/build.rs:1-5`): `fn main() { napi_build::setup(); }`.

- [ ] **Step 2: Write the failing Rust test** (in `src/compile.rs`, bottom)

```rust
#[cfg(test)]
mod tests {
    #[test]
    fn compiles_outlet_layout_fixture_through_lowering() {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
        let t = super::compile_tree_impl("tests/fixtures/outlet-layout/input.tsx", root, "brust/runtime-dom", vec![]);
        assert!(t.error.is_none(), "{:?}", t.error);
        let c = &t.components[0];
        assert_eq!(c.id, "input_a0366a49"); // relative path ⇒ the fixture's id (ir/mod.rs:136)
        assert!(c.ir.contains("\"uses_outlet\":true"));
        assert!(c.jinja.contains("{{ __outlet | safe }}"));
        assert!(c.client_js.is_none() && c.server_ts.is_none());
    }
    #[test]
    fn lowering_error_is_returned_not_panicked() {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
        let t = super::compile_tree_impl("tests/fixtures/server-leak/input.tsx", root, "brust/runtime-dom", vec![]);
        assert_eq!(t.error.as_ref().map(|d| d.class.as_str()), Some("error"));
    }
}
```

- [ ] **Step 3: Run it to see it fail**

Run: `cargo test -p brust-napi` → FAIL: `compile_tree_impl` not found.

- [ ] **Step 4: Implement `src/compile.rs` + `src/lib.rs`**

```rust
// crates/brust-napi/src/compile.rs
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::Diagnostic;
use napi_derive::napi;

#[napi(object)] #[derive(Clone, Debug)]
pub struct NapiDiagnostic { pub class: String, pub rule: String, pub message: String, pub line: u32, pub col: u32, pub remediation: String }
#[napi(object)]
pub struct CompiledComponent { pub id: String, pub source: String, pub ir: String, pub jinja: String, pub server_ts: Option<String>, pub client_js: Option<String>, pub diagnostics: Vec<NapiDiagnostic> }
#[napi(object)]
pub struct CompiledTree { pub components: Vec<CompiledComponent>, pub error: Option<NapiDiagnostic> }
fn diag(d: &Diagnostic) -> NapiDiagnostic {
    NapiDiagnostic { class: d.class.as_str().into(), rule: d.rule.clone(), message: d.message.clone(), line: d.line, col: d.col, remediation: d.remediation.clone() }
}
/// `compile_tree` on the compiler thread; `path` is relative to `root` so ids are stable.
pub(crate) fn compile_tree_impl(path: &str, root: &str, runtime_import: &str, server_only: Vec<String>) -> CompiledTree {
    let opts = AnalyzeOptions { server_only, root: std::path::PathBuf::from(root) };
    let res = brust_compiler::parse::run_on_compiler_thread(|| brust_compiler::pipeline::compile_tree(path, None, &opts, runtime_import));
    match res {
        Err(d) => CompiledTree { components: vec![], error: Some(diag(&d)) },
        Ok(tree) => CompiledTree { error: None, components: tree.iter().map(|l| CompiledComponent {
            id: l.ir.id.clone(), source: l.ir.source.clone(),
            ir: serde_json::to_string(&*l.ir).expect("ComponentIR serialises"),
            jinja: l.artifacts.jinja.clone(), server_ts: l.artifacts.server_ts.clone(), client_js: l.artifacts.client_js.clone(),
            diagnostics: l.ir.diagnostics.iter().chain(&l.artifacts.diagnostics).map(diag).collect(),
        }).collect() },
    }
}
#[napi]
pub fn compile_tree(path: String, root: String, runtime_import: String, server_only: Vec<String>) -> CompiledTree { compile_tree_impl(&path, &root, &runtime_import, server_only) }
```
`src/lib.rs`: `#![deny(clippy::all)] mod compile; pub use compile::*;` plus `pub(crate) fn init_tracing()` copied from `brust/crates/brust/src/lib.rs:34-41` (env filter default `brust=info`, stderr), called from `compile_tree` and later from `start_server`.

- [ ] **Step 5: Run the Rust tests**

Run: `cargo test -p brust-napi` → `2 passed`. Then `cargo clippy -p brust-napi --no-deps -- -D warnings` clean.

- [ ] **Step 6: Package skeleton and the addon build**

`packages/brust/package.json`:
```json
{ "name": "@brust/core", "version": "0.0.0", "private": true, "type": "module",
  "bin": { "brust": "./bin/brust" },
  "exports": { ".": "./src/index.ts", "./routes": "./src/routes.ts", "./server": "./src/server.ts", "./native": "./native/index.js" },
  "scripts": {
    "build": "napi build --platform --release --js index.js --dts index.d.ts --manifest-path ../../crates/brust-napi/Cargo.toml --output-dir native",
    "build:debug": "napi build --platform --js index.js --dts index.d.ts --manifest-path ../../crates/brust-napi/Cargo.toml --output-dir native",
    "test": "bun test", "typecheck": "bunx tsc --noEmit -p ." },
  "napi": { "binaryName": "brust", "packageName": "@brust/native",
    "targets": ["x86_64-apple-darwin", "aarch64-apple-darwin", "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"] },
  "dependencies": { "@brust/runtime-dom": "workspace:*" },
  "peerDependencies": { "react": "^19.0.0", "react-dom": "^19.0.0" },
  "devDependencies": { "@napi-rs/cli": "^3.0.0", "@types/bun": "^1.4.0", "react": "^19.2.0", "react-dom": "^19.2.0", "typescript": "^5.9.0" } }
```
(scripts mirror `brust/runtime/package.json`; the napi block mirrors `brust/package.json:24-35` with the v2 names.) `tsconfig.json`: copy `packages/runtime-dom/tsconfig.json`, add `"jsx": "react-jsx"`, include `src`, `test`, `bin`.

Run: `bun install && cd packages/brust && bun run build:debug`
Expected: `native/brust.<plat>.node`, `native/index.js`, `native/index.d.ts` written; `index.d.ts` contains `export declare function compileTree(path: string, root: string, runtimeImport: string, serverOnly: Array<string>): CompiledTree`.

- [ ] **Step 7: bun test that drives the addon**

```ts
// packages/brust/test/napi-compile.test.ts
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { compileTree } from '../native/index.js'
const repo = resolve(import.meta.dir, '../../..')

test('compileTree lowers a fixture and returns IR JSON + artifacts', () => {
  const t = compileTree('tests/fixtures/keyed-list-child-job/input.tsx', repo, 'brust/runtime-dom', [])
  expect(t.error).toBeUndefined()
  expect(t.components.map((c) => c.id)).toEqual(['input_7833a2e1', 'priceRow_845bcd56'])
  const ir = JSON.parse(t.components[0]!.ir)
  expect(ir.instances[0]).toEqual({ child_id: 'priceRow_845bcd56', k: 1, loops: ['items'], props: { item: 'items[idx]', unit: 'unit' } })
  expect(t.components[1]!.serverTs).toContain('export function precompute')
  expect(t.components[0]!.clientJs).toContain('from "brust/runtime-dom"')
})

```
Run: `cd packages/brust && bun test test/napi-compile.test.ts` → `1 pass`. (This is the gate that the cdylib with the vendored Bun crates loads under Bun at all.)

- [ ] **Step 8: Commit**

```bash
git add Cargo.toml Cargo.lock crates/brust-napi packages/brust/package.json packages/brust/tsconfig.json packages/brust/native/.gitignore packages/brust/test/napi-compile.test.ts bun.lock
git commit -m "feat(napi): brust-napi cdylib with compileTree through lowering; @brust/core package skeleton"
```

---

### Task 2: Server bindings

**Files:**
- Create: `crates/brust-napi/src/server.rs`, `crates/brust-napi/src/dispatch.rs`
- Modify: `crates/brust-napi/src/lib.rs`
- Test: `packages/brust/test/napi-server.test.ts`

**Interfaces:**
- Consumes: `brust_server::{Config, Tuning, start, Server, InvalidateArgs, InvalidateResult, Stats, CallKind, DispatchError, RenderDispatch}` (`lib.rs:16-18`, `config.rs:85-98`, `config.rs:118-142`, `server/mod.rs:49-74`, `server/mod.rs:82`, `dispatch.rs:41-44`, `dispatch.rs:55-60`, `dispatch.rs:65-87`), `Server::{register_worker, invalidate, stats, request_drain, wait_drain_done}` (`config.rs:176-182, 191-207, 219-226, 232-241`). 0.1.x pattern: `TsfnDispatch` (`brust/crates/brust/src/dispatch_impl.rs:40-107`), `register_renderer` (`lib.rs:312-340`), `until_ready`/`begin_drain` (`lib.rs:272-310`), `resolve_bind_addr` (`lib.rs:146-154`).
- Produces (JS):
  - `startServer(opts: StartOptions): void` — `interface StartOptions { host: string; port: number; distDir: string; workers: number; claimTimeoutMs?: number; l1Capacity?: number; jobCacheCapacity?: number; generator?: string }`; throws on any `start` `Err` (bind, manifest, routes, render). Stores the `Arc<Server>` as the CURRENT server in a `parking_lot::RwLock<Option<Arc<Server>>>` (deviation from D1's `OnceCell`, reason: `bun test` runs every file in one process, and T2 + T6 both start a server; the old server keeps running until drained).
  - `registerWorker(buf: Uint8Array, slots: number, f: (kind: 'loader'|'jobs', requestJson: string, slot: number) => Promise<number>): number`
  - `untilReady(timeoutMs: number): Promise<void>` — resolves when the binding-side `REGISTERED >= EXPECTED` (atomics set by `startServer`/`registerWorker`; `brust-server` has no until-ready API and `pool` is `pub(crate)` — `config.rs:146`); rejects after the timeout (the TS layer decides exit policy).
  - `beginDrain(timeoutMs: number): Promise<void>` — `request_drain` then `wait_drain_done`.
  - `cacheInvalidate(args: { key?: string; tags?: string[]; path?: string; method?: string }): { l1Removed: number; jobRemoved: number }`
  - `cacheStats(): string` — `serde_json::to_string(&Stats)` (`/_brust/cache/stats` shape, `config.rs:137-142`). `localAddr(): string` — `Server::local_addr()` as `host:port` (port 0 in tests).

- [ ] **Step 1: `dispatch.rs`** — copy `brust/crates/brust/src/dispatch_impl.rs:40-107` and apply exactly four changes:

```rust
use brust_server::{CallKind, DispatchError, RenderDispatch};               // (1) brust_core → brust_server; RenderError → DispatchError
pub type WorkerTsfn = ThreadsafeFunction<FnArgs<(String, String, u32)>, Promise<u32>, FnArgs<(String, String, u32)>, napi::Status, false>; // (2) kind first
fn kind_str(k: CallKind) -> &'static str { match k { CallKind::Loader => "loader", CallKind::Jobs => "jobs" } }
// (3) the trait method gains `kind: CallKind` (dispatch.rs:68-73) and calls
//     tsfn.call_async((kind_str(kind).to_string(), request_json, slot).into()).await
//     mapping Err → DispatchError::EnqueueFailed, promise Err → DispatchError::PromiseRejected.
// (4) `BufPtr`/`TsfnDispatch` fields become `pub` (the binding builds them in server.rs).
```

- [ ] **Step 2: `server.rs`**

```rust
use brust_server::{Config, InvalidateArgs, Server, Tuning, start};
use crate::dispatch::{BufPtr, TsfnDispatch, WorkerTsfn};
static SERVER: parking_lot::RwLock<Option<Arc<Server>>> = parking_lot::RwLock::new(None);
static EXPECTED: AtomicU32 = AtomicU32::new(0);
static REGISTERED: AtomicU32 = AtomicU32::new(0);
fn current() -> NapiResult<Arc<Server>> { SERVER.read().clone().ok_or_else(|| napi::Error::from_reason("startServer has not been called")) }

#[napi(object)]
pub struct StartOptions { pub host: String, pub port: u16, pub dist_dir: String, pub workers: u32,
    pub claim_timeout_ms: Option<u32>, pub l1_capacity: Option<u32>, pub job_cache_capacity: Option<u32>, pub generator: Option<String> }

#[napi]
pub fn start_server(opts: StartOptions) -> NapiResult<()> {
    crate::init_tracing();
    let mut tuning = Tuning::default();
    if let Some(ms) = opts.claim_timeout_ms { tuning.claim_timeout_ms = u64::from(ms.max(1)); }
    let cfg = Config {
        addr: resolve_bind_addr(opts.host.trim(), opts.port)?,      // lib.rs:146-154 verbatim (prefer IPv4)
        dist_dir: opts.dist_dir.into(), expected_workers: opts.workers, tuning,
        l1_capacity: opts.l1_capacity.map_or(1000, u64::from), job_cache_capacity: opts.job_cache_capacity.map_or(1000, u64::from),
        generator: opts.generator, ..Config::default() };
    let s = start(cfg).map_err(napi::Error::from_reason)?;   // "manifest: …" / "bind failed on …" reach JS as thrown errors
    EXPECTED.store(opts.workers, Ordering::SeqCst); REGISTERED.store(0, Ordering::SeqCst);
    *SERVER.write() = Some(s);
    Ok(())
}
#[napi]
pub fn register_worker(mut buf: Uint8Array, slots: u32, f: Function<FnArgs<(String, String, u32)>, Promise<u32>>) -> NapiResult<u32> {
    let s = current()?;
    let (buf_ptr, buf_len) = unsafe { let sl = buf.as_mut(); (BufPtr(sl.as_mut_ptr()), sl.len()) }; // lib.rs:326-329
    let tsfn: WorkerTsfn = f.build_threadsafe_function().build()?;
    let id = s.register_worker(Box::new(TsfnDispatch { tsfn: Arc::new(tsfn), buf_ptr, buf_len, slots: slots.max(1) as usize }));
    REGISTERED.fetch_add(1, Ordering::SeqCst);
    Ok(id)
}
#[napi]
pub async fn until_ready(timeout_ms: u32) -> NapiResult<()> {
    let wait = async { while REGISTERED.load(Ordering::SeqCst) < EXPECTED.load(Ordering::SeqCst) { tokio::time::sleep(Duration::from_millis(10)).await; } };
    tokio::time::timeout(Duration::from_millis(u64::from(timeout_ms)), wait).await
        .map_err(|_| napi::Error::from_reason(format!("workers failed to register within {timeout_ms} ms")))
}
#[napi]
pub async fn begin_drain(timeout_ms: u32) -> NapiResult<()> { let s = current()?; s.request_drain(u64::from(timeout_ms)); s.wait_drain_done().await; Ok(()) }
#[napi(object)] pub struct NapiInvalidateArgs { pub key: Option<String>, pub tags: Option<Vec<String>>, pub path: Option<String>, pub method: Option<String> }
#[napi(object)] pub struct NapiInvalidateResult { pub l1_removed: u32, pub job_removed: u32 }
#[napi]
pub fn cache_invalidate(args: NapiInvalidateArgs) -> NapiResult<NapiInvalidateResult> {
    let r = current()?.invalidate(InvalidateArgs { key: args.key, tags: args.tags.unwrap_or_default(), path: args.path, method: args.method });
    Ok(NapiInvalidateResult { l1_removed: r.l1_removed as u32, job_removed: r.job_removed as u32 })
}
#[napi] pub fn cache_stats() -> NapiResult<String> { Ok(serde_json::to_string(&current()?.stats()).expect("Stats serialises")) }
#[napi] pub fn local_addr() -> NapiResult<String> { Ok(current()?.local_addr().to_string()) }
```
`lib.rs`: `mod dispatch; mod server; pub use server::*;`. Note the `until_ready` 0.1.x `process::exit(1)` (`lib.rs:285-288`) is NOT carried: the error is returned.

- [ ] **Step 3: Write the failing bun test** (fixture dist = brust-server's; the canned handler is the FakeBun default — `crates/brust-server/tests/common/mod.rs:20-68`)

```ts
// packages/brust/test/napi-server.test.ts
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { startServer, registerWorker, untilReady, beginDrain, cacheInvalidate, cacheStats, localAddr } from '../native/index.js'
import { writeSlot } from '../src/worker'   // Task 4 moves it there; until then inline the 8-line helper here

const dist = resolve(import.meta.dir, '../../../crates/brust-server/tests/fixtures/dist')
function jobValue(call: { id: string; componentId: string; target?: string; inputs: any }) {
  const job = call.id.split('/').at(call.id.startsWith(call.componentId + '/') ? 1 : 2)
  if (call.componentId === 'detailPage_c3' && job === 'j0') return { _s1: 'HP 35' }
  if (call.componentId === 'moveCard_d4' && job === 'j0') return { _s1: `MOVE ${call.inputs.move.name}` }
  if ((call.target ?? call.componentId) === 'teamBuilder_h8') return '<ul><li>a</li></ul>'
  throw new Error(`unexpected job ${call.id}`)
}
const sab = new Uint8Array(new SharedArrayBuffer(256 * 1024))
const handler = async (kind: string, requestJson: string, slot: number) => {
  const req = JSON.parse(requestJson)
  return writeSlot(sab, slot, 1, JSON.stringify(kind === 'loader'
    ? { ok: true, data: { pokemon: { name: req.params.name ?? null, stats: { hp: 35 }, moves: [{ name: 'tackle' }, { name: 'growl' }] }, team: ['a'], who: 'anon' } }
    : { results: req.jobs.map((j: any) => ({ id: j.id, value: jobValue(j) })) }))
}

test('startServer + one worker answers pages, HIT skips Bun, invalidate forces MISS', async () => {
  startServer({ host: '127.0.0.1', port: 0, distDir: dist, workers: 1, claimTimeoutMs: 500 })
  registerWorker(sab, 1, handler)
  await untilReady(2000)
  const base = `http://${localAddr()}`
  const home = await fetch(`${base}/`)
  expect(home.status).toBe(200)
  expect(await home.text()).toContain('<main><h1>Home</h1></main>')
  expect(JSON.parse(cacheStats()).loader_calls).toBe(0)
  const r1 = await fetch(`${base}/pokemon/pikachu`)
  expect(r1.headers.get('x-brust-cache')).toBe('MISS')
  const body = await r1.text()
  expect(body).toContain('<p>HP 35</p>')
  expect(body).toContain('<li>tackle: MOVE tackle</li><li>growl: MOVE growl</li>')
  const r2 = await fetch(`${base}/pokemon/pikachu`)
  expect(r2.headers.get('x-brust-cache')).toBe('HIT')
  expect(JSON.parse(cacheStats()).loader_calls).toBe(1)
  expect(cacheInvalidate({ tags: ['pokemon'] })).toEqual({ l1Removed: 1, jobRemoved: 0 })
  expect((await fetch(`${base}/pokemon/pikachu`)).headers.get('x-brust-cache')).toBe('MISS')
  await beginDrain(1000)
  expect(() => startServer({ host: '127.0.0.1', port: 0, distDir: '/nonexistent', workers: 0 })).toThrow(/manifest: read .*manifest\.json/)
})
```

- [ ] **Step 4: Run, fail, build, pass**

Run: `cd packages/brust && bun test test/napi-server.test.ts` → FAIL (`startServer is not a function`). Then `bun run build:debug && bun test test/napi-server.test.ts` → `1 pass`.

- [ ] **Step 5: Gates + commit**

Run: `cargo fmt --all -- --check && cargo clippy -p brust-napi --no-deps -- -D warnings && cargo test -p brust-napi`
```bash
git add crates/brust-napi packages/brust/test/napi-server.test.ts
git commit -m "feat(napi): startServer/registerWorker/untilReady/beginDrain/cacheInvalidate/cacheStats over brust-server"
```

---

### Task 3: `@brust/core` routes, verdicts, cache

**Files:**
- Create: `packages/brust/src/routes.ts`, `packages/brust/src/cache.ts`, `packages/brust/src/index.ts`, `packages/brust/src/server.ts` (re-exports `cache`, verdicts for server code)
- Test: `packages/brust/test/routes.test.ts`, `packages/brust/test/cache.test.ts`

**Interfaces:**
- Consumes: 0.1.x semantics `notFound/redirect/isNativeVerdict/httpError/isHttpErrorTrigger` (`brust/runtime/routes.ts:271-390`), `Route` (`routes.ts:502-575`, trimmed), S4.
- Produces:
  - `export interface RouteCacheConfig { ttl_seconds: number; prefix?: string; bypass?: true | string; tags?: string[] }`
  - `export interface Route<P = Record<string,string>, D = unknown> { path?: string; Component?: ComponentType<any>; loader?: (ctx: LoaderCtx<P>) => Promise<D> | D; cache?: RouteCacheConfig; children?: Route[] }`
  - `export interface LoaderCtx<P> { params: P; path: string; req: { method: string; url: string; headers: Record<string,string>; cookies: Record<string,string>; search: Record<string,string> } }` (= `RequestEnvelope`, `routing/routes.rs:32-41`)
  - `export function defineRoutes(routes: Route[]): Route[]` — validates every node: unknown field → `throw new BrustRouteError('<field> is not supported in M2 (M3)')`; `cache.key`/`cache.key_ttl_seconds` → same message; a leaf without `Component` or without `path` → error; `path: '*'` must be a leaf.
  - `export function Outlet(): null` — a React component rendering `null` (the compiler replaces `<Outlet/>` imported from `@brust/core/routes`, `analyze/jsx.rs:45`).
  - `export const ALLOWED_ROUTE_FIELDS = ['path','Component','loader','cache','children'] as const`
  - `export interface FlatRoute { id: string; pattern: string; chain: Route[]; chainIds: string[]; catchAll: boolean }`
  - `export function flattenRoutes(routes: Route[]): { nodes: Map<Route, string>; leaves: FlatRoute[] }` — DFS pre-order ids `r0, r1, …` for EVERY node; a leaf is a node without `children`; `pattern` = join of ancestor `path`s (`'/'`-normalised, `'*'` → `'*'` or `'<prefix>/*'`).
  - `export function notFound(data?: unknown): Verdict`, `export function redirect(location: string, status: 301|302|303|307|308 = 302): Verdict`, `export function httpError(status: number, body?: string | object, opts?: { contentType?: string; headers?: Record<string,string> }): never`, `isVerdict(x)`, `isHttpErrorTrigger(x)` — same symbol keys (`Symbol.for('brust.nativeVerdict')`, `Symbol.for('brust.httpError')`) and same checks as 0.1.x `routes.ts:271-390`.
  - `cache.ts`: `export function cache<C>(Comp: C, opts: { key?: (p: any) => unknown; tags?: (p: any) => string[]; revalidate?: number }): C` (identity, `Object.assign(Comp, { __brustCache: opts })` for debugging only) and `cache.invalidate(args: { key?: string; tags?: string[]; path?: string; method?: string }): { l1Removed: number; jobRemoved: number }` → napi `cacheInvalidate` (throws "cache.invalidate needs a running server" outside `brust start`).

- [ ] **Step 1: Failing tests**

```ts
// packages/brust/test/routes.test.ts
import { expect, test } from 'bun:test'
import { defineRoutes, flattenRoutes, notFound, redirect, httpError, isVerdict, isHttpErrorTrigger, Outlet } from '../src/routes'
const L = () => null, H = () => null, D = () => null, N = () => null

test('defineRoutes rejects every non-M2 field with the M3 message', () => {
  for (const field of ['native', 'errorBoundary', 'ssg', 'middleware', 'sse', 'websocket', 'index'])
    expect(() => defineRoutes([{ path: '/', Component: H, [field]: 1 } as any])).toThrow(`${field} is not supported in M2 (M3)`)
  expect(() => defineRoutes([{ path: '/', Component: H, cache: { ttl_seconds: 1, key: () => 'k' } } as any])).toThrow('cache.key is not supported in M2 (M3)')
  expect(() => defineRoutes([{ path: '/x', children: [{ Component: H }] }])).toThrow(/leaf .* needs a path/)
  expect(() => defineRoutes([{ path: '*', Component: N, children: [{ path: '/a', Component: H }] }])).toThrow(/'\*' must be a leaf/)
})

test('flattenRoutes assigns DFS ids, patterns and chains', () => {
  const routes = defineRoutes([{ Component: L, loader: async () => ({ a: 1 }), children: [
    { path: '/', Component: H }, { path: '/items/{id}', Component: D, loader: async () => ({}) }, { path: '*', Component: N } ] }])
  const { leaves, nodes } = flattenRoutes(routes)
  expect([...nodes.values()]).toEqual(['r0', 'r1', 'r2', 'r3'])
  expect(leaves.map((l) => [l.id, l.pattern, l.chainIds, l.catchAll])).toEqual([
    ['r1', '/', ['r0', 'r1'], false], ['r2', '/items/{id}', ['r0', 'r2'], false], ['r3', '*', ['r0', 'r3'], true]])
  expect(leaves[1]!.chain.map((r) => r.Component)).toEqual([L, D])
})

test('verdicts keep the 0.1.x wire shape', () => {
  expect(notFound()).toMatchObject({ status: 404, render: true, data: {} }); expect(isVerdict({ status: 404 })).toBe(false)
  expect(redirect('/x')).toMatchObject({ status: 302, headers: { Location: '/x' } })
  try { httpError(418, 'teapot') } catch (e) { expect(isHttpErrorTrigger(e)).toBe(true); expect(e).toMatchObject({ status: 418, body: 'teapot', contentType: 'text/plain; charset=utf-8' }) }
  expect(() => httpError(302, '')).toThrow(/400-599/); expect(Outlet()).toBeNull()
})
```
`cache.test.ts`: `cache(C, opts)` returns `C` itself; `cache.invalidate` throws the "needs a running server" message when the addon has no server (mock `../native/index.js` via a thin `src/native.ts` indirection that tests can swap — NOT `mock.module`, memory `bun-mock-module-leaks-suite`).

- [ ] **Step 2: Run → FAIL, implement, run → `4 pass`** (`bun test test/routes.test.ts test/cache.test.ts`)

Implementation notes: `flattenRoutes` walks with `(node, prefix, chain)`; `pattern = node.path === '*' ? (prefix ? prefix + '/*' : '*') : joinPath(prefix, node.path ?? '')`; `joinPath` collapses `//`, strips a trailing `/` except for `/`. Ids are assigned on entry (pre-order) so a layout precedes its children, matching the S6 example `"loaders": ["r0","r3"]`.

- [ ] **Step 3: Commit**

```bash
git add packages/brust/src/routes.ts packages/brust/src/cache.ts packages/brust/src/index.ts packages/brust/src/server.ts packages/brust/src/native.ts packages/brust/test/routes.test.ts packages/brust/test/cache.test.ts
git commit -m "feat(brust): defineRoutes/flattenRoutes, Outlet, verdicts, cache() identity + invalidate"
```

---

### Task 4: Worker handlers

**Files:**
- Create: `packages/brust/src/worker.ts`
- Test: `packages/brust/test/worker.test.ts`

**Interfaces:**
- Consumes: `flattenRoutes`, verdict helpers (T3); wire shapes `LoaderRequest{routeId, params, path, req}` → `LoaderResponse` (`protocol.rs:13-64`), `JobsRequest{jobs:[{id, componentId, kind, inputs, target?}]}` → `{results:[{id, value}|{id, error}]}` (`protocol.rs:66-98` + D6); chain-loader semantics `runNativeChainLoaders` (`brust/runtime/routes.ts:463-491`); 0.1.x worker branch (`brust/runtime/index.ts:1148-1201`: SAB = `sabBytes * renderSlots`, `BRUST_RENDER_SLOTS`, `registerRenderer(view, slots, fn)`).
- Produces:
  - `export function writeSlot(view: Uint8Array, slot: number, slots: number, json: string): number` — `sub = Math.floor(view.byteLength / slots)`; encodes `json`; if longer than `sub`, encodes `{"error":"response too large: <n> > <sub>"}` instead; copies into `view.subarray(slot*sub, slot*sub+sub)`; returns the byte length (> 0).
  - `export type JobsModule = Record<string, { precompute?: (props: any) => unknown; ssr?: (props: any) => string }>`
  - `export function makeHandlers(opts: { leaves: FlatRoute[]; jobs: JobsModule }): { loader(req: LoaderRequest): Promise<LoaderResponse>; jobs(req: JobsRequest): Promise<JobsResponse> }`
  - `export function makeDispatch(handlers, view, slots): (kind: string, requestJson: string, slot: number) => Promise<number>` — never rejects; unknown kind → `{error}`.
  - `export async function startWorker(): Promise<void>` — reads `BRUST_WORKER_ID`, `BRUST_RENDER_SLOTS` (default 1), `BRUST_DIST_DIR`, `BRUST_APP_ENTRY`; allocates `new SharedArrayBuffer(256*1024 * slots)`; imports the app entry (`routes` default or named export) and `<dist>/jobs.js`; `registerWorker(view, slots, makeDispatch(...))`. The SAB stays rooted in module scope.

- [ ] **Step 1: Failing tests**

```ts
// packages/brust/test/worker.test.ts
import { expect, test } from 'bun:test'
import { makeHandlers, makeDispatch, writeSlot } from '../src/worker'
import { defineRoutes, flattenRoutes, notFound, redirect, httpError } from '../src/routes'
const C = () => null
const ctx = (routeId: string) => ({ routeId, params: { id: '7' }, path: '/items/7', req: { method: 'GET', url: '/items/7', headers: {}, cookies: {}, search: {} } })
const leaves = (o: { parent?: any; child?: any }) => flattenRoutes(defineRoutes([{ Component: C, loader: o.parent, children: [{ path: '/items/{id}', Component: C, loader: o.child }] }])).leaves

test('loader: chain runs top-down, flat merge, child keys win', async () => {
  const h = makeHandlers({ leaves: leaves({ parent: async () => ({ a: 1, b: 'parent' }), child: async ({ params }: any) => ({ b: params.id }) }), jobs: {} })
  expect(await h.loader(ctx('r1'))).toEqual({ ok: true, data: { a: 1, b: '7' } })
})
test('loader: first verdict wins and stops the chain; httpError throw is a verdict', async () => {
  let childRan = false
  const h = makeHandlers({ leaves: leaves({ parent: async () => notFound({ why: 'x' }), child: async () => { childRan = true; return {} } }), jobs: {} })
  expect(await h.loader(ctx('r1'))).toEqual({ verdict: 'notFound', data: { why: 'x' } })
  expect(childRan).toBe(false)
  const r = makeHandlers({ leaves: leaves({ child: async () => redirect('/login', 303) }), jobs: {} })
  expect(await r.loader(ctx('r1'))).toEqual({ verdict: 'redirect', location: '/login', status: 303 })
  const e = makeHandlers({ leaves: leaves({ child: async () => httpError(403, 'no') }), jobs: {} })
  expect(await e.loader(ctx('r1'))).toEqual({ verdict: 'httpError', status: 403, body: 'no' })
})
test('loader: a throw becomes {error}; unknown routeId too', async () => {
  const h = makeHandlers({ leaves: leaves({ child: async () => { throw new Error('boom') } }), jobs: {} })
  expect(await h.loader(ctx('r1'))).toEqual({ error: 'Error: boom' })
  expect(await h.loader(ctx('r9'))).toEqual({ error: 'unknown routeId r9' })
})
test('jobs: precompute by componentId, ssr by target, errors per job', async () => {
  const h = makeHandlers({ leaves: [], jobs: {
    price_1: { precompute: (p) => ({ _s1: `${p.item.price}${p.unit}` }) },
    team_2: { ssr: (p) => `<ul>${p.team.join('')}</ul>` },
    bad_3: { precompute: () => { throw new Error('nope') } } } })
  const r = await h.jobs({ jobs: [
    { id: 'page_0/price_1_1/j0/0', componentId: 'price_1', kind: 'precompute', inputs: { item: { price: 3 }, unit: 'x' } },
    { id: 'page_0/j1', componentId: 'page_0', kind: 'ssr', target: 'team_2', inputs: { team: ['a', 'b'] } },
    { id: 'bad_3/j0', componentId: 'bad_3', kind: 'precompute', inputs: {} }, { id: 'zzz/j0', componentId: 'zzz', kind: 'precompute', inputs: {} } ] })
  expect(r).toEqual({ results: [{ id: 'page_0/price_1_1/j0/0', value: { _s1: '3x' } }, { id: 'page_0/j1', value: '<ul>ab</ul>' },
    { id: 'bad_3/j0', error: 'Error: nope' }, { id: 'zzz/j0', error: 'no precompute job for component zzz' }] })
})
test('writeSlot stays inside the slot and substitutes an error when too large', () => {
  const view = new Uint8Array(new SharedArrayBuffer(128)); view.fill(0x41)
  const n = writeSlot(view, 1, 2, '{"ok":true}')
  expect(new TextDecoder().decode(view.subarray(64, 64 + n))).toBe('{"ok":true}'); expect(view[0]).toBe(0x41)   // slot 0 untouched
  const big = writeSlot(view, 0, 2, JSON.stringify({ data: 'x'.repeat(100) }))
  expect(big).toBeLessThanOrEqual(64); expect(JSON.parse(new TextDecoder().decode(view.subarray(0, big)))).toEqual({ error: 'response too large: 111 > 64' })
})
test('dispatch never rejects', async () => {
  const view = new Uint8Array(new SharedArrayBuffer(1024)), d = makeDispatch(makeHandlers({ leaves: [], jobs: {} }), view, 1)
  const n = await d('bogus', '{not json', 0)
  expect(JSON.parse(new TextDecoder().decode(view.subarray(0, n))).error).toMatch(/JSON/)
})
```

- [ ] **Step 2: Run → FAIL; implement `src/worker.ts`**

```ts
// packages/brust/src/worker.ts — the Bun side of contract 7. Requests arrive inline; responses go into the SAB slot.
import { registerWorker } from './native'
import { type FlatRoute, flattenRoutes, isVerdict, isHttpErrorTrigger } from './routes'

export function writeSlot(view: Uint8Array, slot: number, slots: number, json: string): number {
  const sub = Math.floor(view.byteLength / Math.max(1, slots)), base = slot * sub
  let bytes = new TextEncoder().encode(json)
  if (bytes.byteLength > sub) bytes = new TextEncoder().encode(JSON.stringify({ error: `response too large: ${bytes.byteLength} > ${sub}` }))
  view.set(bytes, base)
  return bytes.byteLength
}

const verdictJson = (v: any) => v.status === 404 ? { verdict: 'notFound', data: v.data ?? {} } : { verdict: 'redirect', location: v.headers.Location, status: v.status }
export function makeHandlers({ leaves, jobs }: { leaves: FlatRoute[]; jobs: JobsModule }) {
  const byId = new Map(leaves.map((l) => [l.id, l]))
  return {
    async loader(req: LoaderRequest): Promise<LoaderResponse> {   // runNativeChainLoaders (routes.ts:463-491) + {error} capture
      const leaf = byId.get(req.routeId)
      if (!leaf) return { error: `unknown routeId ${req.routeId}` }
      let merged: Record<string, unknown> = {}
      try {
        for (const node of leaf.chain) {
          if (!node.loader) continue
          let r: unknown
          try { r = await node.loader({ params: req.params, path: req.path, req: req.req }) }
          catch (e) { if (isHttpErrorTrigger(e)) return { verdict: 'httpError', status: e.status, body: e.body }; throw e }
          if (isVerdict(r)) return verdictJson(r)
          if (r && typeof r === 'object') merged = { ...merged, ...(r as object) }
        }
        return { ok: true, data: merged }
      } catch (e) { return { error: String(e) } }
    },
    async jobs(req: JobsRequest): Promise<JobsResponse> {
      const results = []
      for (const call of req.jobs) {
        const owner = call.kind === 'ssr' ? (call.target ?? call.componentId) : call.componentId   // D6
        const fn = jobs[owner]?.[call.kind]
        if (!fn) { results.push({ id: call.id, error: `no ${call.kind} job for component ${owner}` }); continue }
        try { results.push({ id: call.id, value: await fn(call.inputs) }) } catch (e) { results.push({ id: call.id, error: String(e) }) }
      }
      return { results }
    } }
}

export function makeDispatch(h: ReturnType<typeof makeHandlers>, view: Uint8Array, slots: number) {
  return async (kind: string, requestJson: string, slot: number): Promise<number> => {
    let out: unknown
    try { const req = JSON.parse(requestJson); out = kind === 'loader' ? await h.loader(req) : kind === 'jobs' ? await h.jobs(req) : { error: `unknown call kind ${kind}` } }
    catch (e) { out = { error: String(e) } }
    return writeSlot(view, slot, slots, JSON.stringify(out))
  }
}
```
`startWorker()`: `slots = max(1, BRUST_RENDER_SLOTS)`, `view = new Uint8Array(new SharedArrayBuffer(256*1024*slots))` kept in module scope, `app = await import(BRUST_APP_ENTRY)`, `jobs = (await import(BRUST_DIST_DIR + '/jobs.js')).default`, `registerWorker(view, slots, makeDispatch(makeHandlers({ leaves: flattenRoutes(app.routes ?? app.default).leaves, jobs }), view, slots))`; the file ends with `if (process.env.BRUST_WORKER_ID !== undefined && import.meta.main) await startWorker()`. Wire types mirror `protocol.rs`; job ids are opaque (`protocol.rs:76-79`) — the owner is `componentId`/`target` only.

- [ ] **Step 3: Run → `6 pass`; typecheck; commit**

```bash
git add packages/brust/src/worker.ts packages/brust/test/worker.test.ts
git commit -m "feat(brust): worker handlers — chain loaders with verdicts, jobs by componentId/target, SAB slot writer"
```

---

### Task 5: Build — route scan, component resolution, compile, emit, diagnostics

**Files:**
- Create: `packages/brust/src/build/scan.ts`, `packages/brust/src/build/compile.ts`, `packages/brust/src/build/errors.ts`
- Create fixture app: `packages/brust/test/fixtures/app/{routes.tsx,AppLayout.tsx,HomePage.tsx,ItemPage.tsx,PriceRow.tsx,Team.tsx,money.ts,loaders.ts,public/app.css}`
- Test: `packages/brust/test/build-compile.test.ts`

**Interfaces:**
- Consumes: T3 `flattenRoutes`; napi `compileTree` (T1); `Bun.Transpiler().scanImports`, `Bun.resolveSync`.
- Produces:
  - `export class BuildError extends Error { constructor(public rule: string, message: string) }` — `brust build` prints `error <rule> <message>` and exits 1.
  - `scan.ts`: `export async function scanRoutes(entryFile: string): Promise<{ routes: Route[]; componentFile: Map<Function, string> }>` — (1) `await import(entryFile)`, take `routes` (named) or `default`; (2) read the entry source, collect default-import declarations with `/^\s*import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s+from\s+['"]([^'"]+)['"]/gm`, cross-check every specifier appears in `new Bun.Transpiler({ loader: 'tsx' }).scanImports(src)`; (3) `Bun.resolveSync(spec, dirname(entryFile))` must end in `.tsx` else `BuildError('component-source', "<Name> is not a default import of a .tsx file")`; (4) `componentFile.set((await import(file)).default, file)` (Bun's module cache makes it the same function object the routes tree holds).
  - `compile.ts`: `export interface Compiled { id: string; file: string; ir: ComponentIR; jinja: string; serverTs?: string; clientJs?: string }`, `export function compileApp(opts: { appRoot: string; leaves: FlatRoute[]; componentFile: Map<Function,string>; runtimeImport: string; serverOnly: string[]; log: (s: string) => void }): { compiled: Map<string, Compiled>; routeComponent: Map<string /*route id*/, string /*component id*/> }` — dedupes by file; calls `compileTree(relative(appRoot, file), appRoot, runtimeImport, serverOnly)`; `error` → `BuildError(error.rule, rendered line)`; prints `fallback`/`warning` diagnostics as `warning <rule> <file>:<line>:<col> <message>`; after compiling, checks `outlet-outside-layout`: a route node whose component IR has `uses_outlet` but which has no `children` → `BuildError('outlet-outside-layout', '<Name> renders <Outlet/> but route <id> has no children')`.

- [ ] **Step 1: Fixture app** (every D4 ingredient; props of the react child are same-named top-level loader keys — Global Constraints)

```tsx
// routes.tsx
import { defineRoutes } from '@brust/core/routes'
import AppLayout from './AppLayout'
import HomePage from './HomePage'
import ItemPage from './ItemPage'
import { itemLoader } from './loaders'
export const routes = defineRoutes([{ Component: AppLayout, children: [
  { path: '/', Component: HomePage },
  { path: '/items/{id}', Component: ItemPage, loader: itemLoader, cache: { ttl_seconds: 60, tags: ['items'] } },
]}])
// AppLayout.tsx — document root (contract 6) + useState ⇒ native tier ⇒ runtime + chunk tags on every page
import { useState } from 'react'
import { Outlet } from '@brust/core/routes'
export default function AppLayout() {
  const [dark, setDark] = useState(false)
  return (<html lang="en"><head><title>fixture</title><link rel="stylesheet" href="/public/app.css" /></head>
    <body data-theme={dark ? 'dark' : 'light'}><button onClick={() => setDark(!dark)}>theme</button><main><Outlet /></main></body></html>)
}
// HomePage.tsx
export default function HomePage() { return <section><h1>Home</h1></section> }
// loaders.ts
import { notFound } from '@brust/core/routes'
export async function itemLoader({ params }: { params: { id: string } }) {
  if (params.id === 'nothing') return notFound({ item: { id: 'nothing', name: 'missing', price: 0, rows: [] }, unit: '', team: [] })
  return { item: { id: params.id, name: `Item ${params.id}`, price: 12.5, rows: [{ id: 'a', price: 1 }, { id: 'b', price: 2.25 }] }, unit: '€', team: ['ann', 'bob'] }
}
// ItemPage.tsx — useId, precompute via helper, keyed list with a child that has its own job, react child
import { useId } from 'react'
import PriceRow from './PriceRow'
import Team from './Team'
import { fmt } from './money'
export default function ItemPage(props: { item: { id: string; name: string; price: number; rows: { id: string; price: number }[] }; unit: string; team: string[] }) {
  const id = useId()
  return (<article><h1 id={id}>{props.item.name}</h1><p className="total">{fmt(props.item.price, props.unit)}</p>
    <ul>{props.item.rows.map((r) => <PriceRow key={r.id} item={r} unit={props.unit} />)}</ul><Team team={props.team} /></article>)
}
// PriceRow.tsx — the keyed-list-child-job fixture shape (own precompute job ⇒ per-row instance)
import { fmt } from './money'
export default function PriceRow(props: { item: { id: string; price: number }; unit: string }) { return <li>{fmt(props.item.price, props.unit)}</li> }
// money.ts
export const fmt = (n: number, u: string) => n.toFixed(1) + u
// Team.tsx — useReducer ⇒ react tier ⇒ ssr job on ItemPage
import { useReducer } from 'react'
export default function Team(props: { team: string[] }) {
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  return <div className="team"><button onClick={bump}>+{n}</button>{props.team.map((m) => <span key={m}>{m}</span>)}</div>
}
```
`public/app.css`: `body{margin:0}`.

- [ ] **Step 2: Failing tests**

```ts
// packages/brust/test/build-compile.test.ts
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { scanRoutes } from '../src/build/scan'
import { compileApp } from '../src/build/compile'
import { flattenRoutes } from '../src/routes'
const app = join(import.meta.dir, 'fixtures/app')

test('scanRoutes maps every Component to its .tsx file', async () => {
  const { routes, componentFile } = await scanRoutes(join(app, 'routes.tsx'))
  const { leaves } = flattenRoutes(routes)
  expect(leaves.flatMap((l) => l.chain.map((r) => componentFile.get(r.Component!)?.split('/').pop()))).toEqual(['AppLayout.tsx', 'HomePage.tsx', 'AppLayout.tsx', 'ItemPage.tsx'])
})
test('compileApp compiles each file once, through lowering, with children', async () => {
  const { routes, componentFile } = await scanRoutes(join(app, 'routes.tsx'))
  const { compiled, routeComponent } = compileApp({ appRoot: app, leaves: flattenRoutes(routes).leaves, componentFile, runtimeImport: '/_brust/client/runtime-test.js', serverOnly: [], log: () => {} })
  expect([...compiled.keys()].map((i) => i.split('_')[0]).sort()).toEqual(['appLayout', 'homePage', 'itemPage', 'priceRow', 'team'])
  const item = compiled.get(routeComponent.get('r2')!)!
  expect(item.ir.jobs.map((j: any) => [Object.keys(j.kind)[0] ?? j.kind, j.outputs])).toEqual([['Precompute', ['_s1']], ['Ssr', [expect.stringMatching(/^_ssr_team_/)]]])
  expect(item.ir.instances[0].loops).toEqual(['item.rows'])
  expect(item.ir.use_id_slots).toBe(1)
  expect(compiled.get(routeComponent.get('r0')!)!.ir.uses_outlet).toBe(true)
  expect(item.clientJs).toContain('from "/_brust/client/runtime-test.js"')
})
test('outlet-outside-layout, unresolvable Component and lowering Error are build errors (run, not read)', async () => {
  const bad = join(import.meta.dir, 'fixtures/bad')   // three tiny apps written in Step 3
  await expect(buildFixture(join(bad, 'outlet-leaf'))).rejects.toMatchObject({ rule: 'outlet-outside-layout' })
  await expect(buildFixture(join(bad, 'inline-component'))).rejects.toMatchObject({ rule: 'component-source' })
  await expect(buildFixture(join(bad, 'nested-instance'))).rejects.toMatchObject({ rule: 'nested-instance' })
})
```
(`buildFixture` = scan + flatten + compileApp; `bad/outlet-leaf/routes.tsx` puts the `AppLayout` with `<Outlet/>` as a leaf `path: '/'`; `bad/inline-component` declares `Component: () => <p/>` inline; `bad/nested-instance` nests `<PriceRow/>` inside two `.map`s.)

- [ ] **Step 3: Run → FAIL; implement `scan.ts`, `compile.ts`, `errors.ts`; add the three `bad/` apps; run → `3 pass`**

Compiler fact used by `compile.ts`: `Tier` serialises externally tagged (`"Static"`, `"Native"`, `{"React":{reason,client_only}}`, `ir/mod.rs:14-20`) and `JobKind` likewise (`"Precompute"`, `{"Ssr":{client_only}}`, `decls.rs:56-60`); `use_id_slots`/`uses_outlet`/`instances` are ABSENT when default (`ir/mod.rs:199-209`) — normalise with `?? 0`, `?? false`, `?? []`.

- [ ] **Step 4: Commit**

```bash
git add packages/brust/src/build packages/brust/test/fixtures packages/brust/test/build-compile.test.ts
git commit -m "feat(brust): build front half — static route scan, per-file compileTree, outlet/source/lowering build errors"
```

---

### Task 6: Build — bundles, manifest writer, pinned manifest + `Manifest::load` oracle

**Files:**
- Create: `packages/brust/src/build/bundle.ts`, `packages/brust/src/build/manifest.ts`, `packages/brust/src/build/index.ts` (`runBuild`)
- Test: `packages/brust/test/build-manifest.test.ts`, pinned `packages/brust/test/fixtures/app.expected-manifest.json`

**Interfaces:**
- Consumes: T5 `Compiled`; `Bun.build`; runtime-dom `src/index.ts` (`mount`); island protocol (`runtime-dom/README.md:65-78`); S5 `dist/` layout; S6 shape (`manifest.rs:12-155`) + D6; safe asset names: `/_brust/client/<file>.js` with `[A-Za-z0-9_.-]` only, no `..`, no leading dot (`pipeline.rs:155-175`, `static_assets.rs:136-151`); immutable caching on a `-<hex6+>` suffix (`pipeline.rs:177-186`).
- Produces:
  - `bundle.ts`: `export function sourceDirPlugin(sourceDirOf: Map<string, string>): BunPlugin` — `onResolve({ filter: /^\.\.?\// }, (a) => sourceDirOf.has(a.importer) ? { path: Bun.resolveSync(a.path, sourceDirOf.get(a.importer)!) } : undefined)` so a staged artifact's `./money` resolves against its component's source dir; `export async function buildRuntime(dist): Promise<string /* "client/runtime-<hash>.js" */>` (`Bun.build` of a generated `dist/.stage/runtime.ts` = `import { mount } from '@brust/runtime-dom'; mount(document.documentElement)`, `naming: 'runtime-[hash].js'`, target browser, minify); `export async function buildClientChunks(dist, compiled, sourceDirOf): Promise<Map<id, "client/<id>-<hash>.js">>` (entrypoints = every `dist/.stage/client/<id>.client.js`, `naming: '[name]-[hash].js'` → `<id>.client-<hash>.js`; `external: ['/_brust/*']` keeps the absolute runtime import as-is); `export async function buildReactChunks(dist, compiled, sourceDirOf): Promise<Map<id, "client/react-<id>-<hash>.js">>` (one `Bun.build` with `splitting: true`, entrypoints = `dist/.stage/react/<id>.shim.tsx`, `naming: { entry: 'react-[name]-[hash].js', chunk: 'chunk-[hash].js' }`, the shim imports the ORIGINAL file by absolute path); `export async function buildJobs(dist, compiled, sourceDirOf): Promise<void>` (generated `dist/.stage/jobs.ts` → `dist/jobs.js`, `target: 'bun'`, `external: ['react', 'react/*', 'react-dom', 'react-dom/*']` — the 0.1.x single-React rule, `brust/runtime/cli/build.ts:584-594`).
  - `manifest.ts`: `export function writeManifest(opts): ManifestJson` — pure function of `{ leaves, routeComponent, compiled, assets, chunks }`; `export function jobRecords(c: Compiled): JobRecord[]`; `export function childRecords(c: Compiled): ChildRecord[]`; `export function cacheRecord(ir.cache): JobCache`.
  - `index.ts`: `export async function runBuild(opts: { appRoot: string; entry: string; outDir: string; log }): Promise<void>` — steps: clean `outDir`; `buildRuntime` FIRST (its path is the `runtimeImport` of every chunk); scan + compile (T5); write `dist/jinja/<id>.jinja`, `dist/jobs/<id>.server.ts`, `dist/.stage/client/<id>.client.js`; bundles; `dist/jobs.js`; `manifest.json`; copy `public/` → `dist/public`; copy the addon `native/brust.<plat>.node` → `dist/native/`; write `dist/index.js`; `rm -rf dist/.stage`.

Manifest rules (`manifest.ts`, every line cited to the consumer):
- `routes[]` from `leaves`: `{ id, pattern, chain: chainIds.map(routeComponent), loaders: chain route ids with a loader (top-down), cache: route.cache ? { ttl_seconds, prefix: prefix ?? null, bypass: bypass ?? null, tags: tags ?? [] } : null, catch_all }` (`manifest.rs:21-53`).
- `components[id]` for EVERY compiled component: `tier` = `Static→"static"`, `Native→"native"`, `React{..}→"react"` (`manifest.rs:71-77`); `template: "jinja/<id>.jinja"`; `client`: native/static-linked → the hashed client chunk, react → the react chunk, else `null`; `needs_worker`; `use_id_slots`.
- `jobs[]` from `ir.jobs` in order, ids `j0..`: `kind` `"precompute"`/`"ssr"`; `inputs` verbatim (incl. `"*"`); `outputs` verbatim (D6); `props` verbatim for ssr jobs when present (a `null` value → `BuildError('ssr-prop-not-a-path')`); `literals` verbatim for ssr jobs when present (S6 amendment, lane m2a3-ssr-literals); an IR job whose kind is `Ssr { client_only: true }` is NOT written to the manifest (S6: client-only islands get no ssr job; the host paints empty) — instead the parent's `children[]` gets `{ id: <childId>, instances: 'static', props: {} }` so `inject_assets` links the child's chunk (S6 amendment on Mellow's challenge 01d6722a); every react-tier component (pages and children, client_only included) gets a `components` record with its `client` react chunk; `per_instance`: `null` unless `per_item` is set → the context path of the `For` node in `ir.template` whose `item === per_item`, taken from its `source` when it is a plain `Prop` path (`Ident{kind:Prop}` / `Member` chain), else `BuildError('per-instance-path', '<id> job j<n>: list for item <per_item> is not a props path')`; `target` for ssr jobs = the child id named by `outputs[0]` (`_ssr_<childId>` / `_ssr_<childId>_<k>` → strip prefix and a trailing `_<k>` that matches no compiled id); for a react component's own record `target` = itself; `cache` from `ir.cache` (`decls.rs:115-119`): `key` = the arrow's body as a props path (`(p) => p.item.id` → `"item.id"`) or `BuildError('cache-key-not-a-path')`, `tags` = string literals of an array literal or `BuildError('cache-tags-not-static')`, `ttl_seconds = revalidate ?? null`; otherwise `{ key: null, tags: [], ttl_seconds: null }`.
- `children[]` from `ir.instances` IN ORDER: `{ id: child_id, instances: loops.length === 0 ? "static" : "per-row:" + loops[0], props }`; `loops[0] === null` → `BuildError('instance-list-path', '<id>: child <child_id> sits in a list that is not a props path')`; a `null` prop value → `BuildError('instance-prop-path', '<id>: child <child_id> prop <name> is not a props path')`; `loops.length > 1` cannot occur (compile Error `nested-instance`, S6 amendment).
- `assets: { runtime }` (no `react` key — React is a split chunk the island chunk imports relatively, D3); `jobs_module: "jobs.js"`; `version: 1`.

- [ ] **Step 1: Failing test**

```ts
// packages/brust/test/build-manifest.test.ts
import { expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { runBuild } from '../src/build'
import { startServer, beginDrain } from '../native/index.js'
const app = join(import.meta.dir, 'fixtures/app'), dist = join(app, 'dist')

test('brust build writes the S6 manifest (pinned) and every file it names', async () => {
  await runBuild({ appRoot: app, entry: join(app, 'routes.tsx'), outDir: dist, log: () => {} })
  const m = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
  expect(m).toEqual(JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/app.expected-manifest.json'), 'utf8')))
  // Structural rules independent of the pinned bytes:
  const item = m.components[m.routes[1].chain[1]]
  expect(m.routes.map((r: any) => [r.id, r.pattern, r.loaders, r.catch_all])).toEqual([['r1', '/', [], false], ['r2', '/items/{id}', ['r2'], false]])
  expect(m.routes[1].cache).toEqual({ ttl_seconds: 60, prefix: null, bypass: null, tags: ['items'] })
  expect(item.jobs[0]).toMatchObject({ id: 'j0', kind: 'precompute', inputs: ['item.price', 'unit'], outputs: ['_s1'], per_instance: null })
  expect(item.jobs[1]).toMatchObject({ id: 'j1', kind: 'ssr', inputs: ['team'], outputs: [expect.stringMatching(/^_ssr_team_/)], target: expect.stringMatching(/^team_/) })
  expect(item.children).toEqual([{ id: expect.stringMatching(/^priceRow_/), instances: 'per-row:item.rows', props: { item: 'item.rows[idx]', unit: 'unit' } }])
  expect(item.use_id_slots).toBe(1)
  expect(m.components[item.jobs[1].target]).toMatchObject({ tier: 'react', client: expect.stringMatching(/^client\/react-team_[0-9a-f]{8}\.shim-[0-9a-f]+\.js$/), jobs: [{ kind: 'ssr', inputs: ['*'] }] })
  expect(m.assets.react).toBeUndefined()
  for (const p of [m.assets.runtime, ...Object.values(m.components).map((c: any) => c.client).filter(Boolean), 'jobs.js', 'public/app.css', 'index.js']) expect(existsSync(join(dist, p))).toBe(true)
  for (const f of readdirSync(join(dist, 'client'))) expect(f).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.js$/)   // pipeline.rs:155-175
  const jobs = (await import(join(dist, 'jobs.js'))).default
  expect(jobs[item.children[0].id].precompute({ item: { price: 2.25 }, unit: '€' })).toEqual({ _s1: '2.3€' }); expect(jobs[item.jobs[1].target].ssr({ team: ['ann'] })).toContain('<span>ann</span>')
})

test('the generated dist passes Manifest::load (startServer with 0 workers is the oracle)', async () => {
  startServer({ host: '127.0.0.1', port: 0, distDir: dist, workers: 0 })   // start() = Manifest::load + RouteTable + Renderer (server/mod.rs:82-89)
  await beginDrain(500)
})
```

- [ ] **Step 2: Run → FAIL; implement `bundle.ts`, `manifest.ts`, `index.ts`**

Shim text (contract 3) and jobs module text:
```ts
// dist/.stage/react/<id>.shim.tsx
import { hydrateRoot } from 'react-dom/client'; import { createElement } from 'react'; import Comp from '<abs source path>'
;(globalThis.__brustIslands ||= []).push(['<id>', (host, props) => { hydrateRoot(host, createElement(Comp, props)) }])
globalThis.__brustIslandReady?.()
// dist/.stage/jobs.ts
import { createElement } from 'react'; import { renderToString } from 'react-dom/server'
import * as j_<id> from './jobs/<id>.server'           // one per component with serverTs
import C_<id> from '<abs source path>'                 // one per react-tier, non client_only component
export default { '<id>': { precompute: j_<id>.precompute }, '<reactId>': { ssr: (props) => renderToString(createElement(C_<reactId>, props)) } }
```
`dist/index.js` = the 0.1.x banner (`brust/runtime/cli/build.ts:238-244`: `BRUST_PREBUILT='1'`, `BRUST_DIST_DIR=import.meta.dir`) + `process.env.BRUST_APP_ENTRY = new URL('<dist-relative path to routes.tsx>', import.meta.url).pathname` + `const { run } = await import('@brust/core'); await run()`.
First run of Step 1 writes `dist/manifest.json`; copy it to `test/fixtures/app.expected-manifest.json` ONLY after checking every rule above against it by hand (lane report pastes it). The pinned file changes whenever the compiler output changes — regenerate and re-review, never edit.

- [ ] **Step 3: Run → `2 pass`; `bun run typecheck`; commit**

```bash
git add packages/brust/src/build packages/brust/test/build-manifest.test.ts packages/brust/test/fixtures/app.expected-manifest.json
git commit -m "feat(brust): build back half — runtime/client/react/jobs bundles with source-dir resolution, S6 manifest writer (D6 outputs/target), dist/index.js"
```
(`.gitignore` gains `packages/brust/test/fixtures/app/dist/` in this commit.)

---

### Task 7: `run.ts`, `cli.ts`, `bin/brust`, config precedence

**Files:**
- Create: `packages/brust/src/run.ts`, `packages/brust/src/config.ts`, `packages/brust/src/cli.ts`, `packages/brust/bin/brust`
- Modify: `packages/brust/src/index.ts` (export `run`)
- Test: `packages/brust/test/config.test.ts`, `packages/brust/test/cli.test.ts`

**Interfaces:**
- Consumes: napi `startServer/untilReady/beginDrain`; 0.1.x `serve()` main branch (`brust/runtime/index.ts:256-323`: worker spawn with `BRUST_WORKER_ID`/`BRUST_RENDER_SLOTS` env, SIGINT/SIGTERM → `beginDrain` → `process.exit`, second signal exits at once); `loadConfig` (`brust/runtime/config.ts:66-100`, precedence env > toml > defaults; messages `config.ts:102-251`).
- Produces:
  - `config.ts`: `export interface BrustConfig { host: string; port: number; workers: number; renderSlots: number; drainTimeoutMs: number }`, `export async function loadConfig(cwd = process.cwd(), cli: Partial<BrustConfig> = {}): Promise<BrustConfig>` — precedence `env (BRUST_ADDR/BRUST_PORT/BRUST_WORKERS/BRUST_RENDER_SLOTS/BRUST_DRAIN_TIMEOUT_MS) > CLI flags > brust.toml ([server] address/port, [workers] count) > defaults (localhost, 1337, availableParallelism(), 1, 10000)`; toml read with `await import(tomlPath)` (Bun's native TOML loader); validation messages as 0.1.x.
  - `run.ts`: `export async function run(opts: { distDir?: string; entry?: string } = {}): Promise<void>` — `distDir = opts.distDir ?? process.env.BRUST_DIST_DIR ?? 'dist'`; no `manifest.json` → `console.error('[brust] run brust build first (<path>)'); process.exit(1)`; `startServer({ host, port, distDir, workers, generator: 'brust/<pkg version>' })`; spawn `workers` × `new Worker(new URL('./worker.ts', import.meta.url), { env: { ...process.env, BRUST_WORKER_ID: i, BRUST_RENDER_SLOTS, BRUST_DIST_DIR, BRUST_APP_ENTRY } })`; signal handlers; `await untilReady(bootTimeoutMs ?? 5000)` (a rejection exits 1 with the message); then `await new Promise(() => {})` (the process lives until a signal; `untilShutdown` has no v2 counterpart).
  - `cli.ts`: `brust build [entry=routes.tsx] [--out-dir dist]`, `brust start [--port N] [--workers N] [--dist-dir dist]`; `BuildError` → `error <rule> <message>` + exit 1; `--help`. `bin/brust`: `#!/usr/bin/env bun` + `import '../src/cli.ts'`.

- [ ] **Step 1: Failing tests** — `config.test.ts` (2 tests): "precedence" writes a temp `brust.toml` `[server] port = 4000` and asserts toml wins over defaults, CLI `{port: 4500}` wins over toml, `BRUST_PORT=5000` wins over both; "validation" asserts `BRUST_PORT=abc` throws `BRUST_PORT must be an integer in 1..65535` and `[workers] count = 0` throws `workers.count must be a positive integer`. `cli.test.ts`: `Bun.spawnSync([bin, 'start', '--dist-dir', '/nonexistent'])` → exit 1, stderr contains `run brust build first`; `Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: bad/outlet-leaf })` → exit 1, stderr `error outlet-outside-layout`.

- [ ] **Step 2: Run → FAIL; implement; run → pass; commit**

```bash
git add packages/brust/src/run.ts packages/brust/src/config.ts packages/brust/src/cli.ts packages/brust/bin/brust packages/brust/src/index.ts packages/brust/test/config.test.ts packages/brust/test/cli.test.ts
git commit -m "feat(brust): brust build/start CLI, run() boot with N workers + graceful drain, env > toml > defaults config"
```

---

### Task 8: e2e test, CI `server` job, README

**Files:**
- Create: `packages/brust/test/e2e.test.ts`, `packages/brust/README.md`
- Modify: `.github/workflows/ci.yml` (add job `server`), `.gitignore`

**Interfaces:**
- Consumes: everything above; 0.1.x integration pattern (spawn, free port, wait for the `[brust] listening on` line — `server/mod.rs:185`, SIGINT).
- Produces: the READY evidence; CI gate for this package.

- [ ] **Step 1: e2e test**

```ts
// packages/brust/test/e2e.test.ts — builds the fixture app with the CLI, starts it, asserts from the outside (D4).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
const app = join(import.meta.dir, 'fixtures/app'), bin = join(import.meta.dir, '../bin/brust')
let proc: ReturnType<typeof Bun.spawn>, base = ''
const stats = async () => (await fetch(`${base}/_brust/cache/stats`)).json()

beforeAll(async () => {
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app }); if (b.exitCode !== 0) throw new Error(b.stderr.toString())
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, stdout: 'pipe', stderr: 'inherit' })
  for await (const chunk of proc.stdout) {                       // "[brust] listening on 127.0.0.1:NNNN (io: hyper(tokio))" (server/mod.rs:185)
    const m = /listening on (\S+)/.exec(new TextDecoder().decode(chunk)); if (m) { base = `http://${m[1]}`; break } }
}, 120_000)
afterAll(() => { proc.kill('SIGINT') })

test('static route: 200, layout composed, zero Bun calls, no script tags', async () => {
  const r = await fetch(`${base}/`), html = await r.text()
  expect(r.status).toBe(200)
  expect(html).toContain('<main><section><h1>Home</h1></section></main>')
  expect(html).toContain('<script type="module" src="/_brust/client/runtime-')     // the layout is native (useState) ⇒ runtime + its chunk
  expect((await stats()).loader_calls).toBe(0)
})
test('loader route: precompute, per-row child values, useId, island SSR + chunk tag; second request is HIT', async () => {
  const r1 = await fetch(`${base}/items/7`), h1 = await r1.text()
  expect(r1.status).toBe(200); expect(r1.headers.get('x-brust-cache')).toBe('MISS')
  expect(h1).toContain('<h1 id="brust-r2-')                                         // useId allocated by the server (render.rs:159-168)
  expect(h1).toContain('<p class="total">12.5€</p>'); expect(h1).toMatch(/1\.0€<\/li>.*2\.3€<\/li>/s)   // per-row child values painted per row
  expect(h1).toMatch(/<brust-island data-id="team_[0-9a-f]{8}" x-props='[^']*'><div class="team"><button>\+0<\/button><span>ann<\/span><span>bob<\/span><\/div><\/brust-island>/)
  expect(h1).toMatch(/<script type="module" src="\/_brust\/client\/react-team_[0-9a-f]{8}\.shim-[0-9a-f]+\.js"><\/script>/)
  const s1 = await stats(); expect([s1.loader_calls, s1.job_calls]).toEqual([1, 1])
  const r2 = await fetch(`${base}/items/7`), h2 = await r2.text()
  expect(r2.headers.get('x-brust-cache')).toBe('HIT')
  expect(h2).toBe(h1)                                                                 // same useId values, same HTML
  expect((await stats()).loader_calls).toBe(1)
  const chunk = await fetch(`${base}${/src="(\/_brust\/client\/react-[^"]+)"/.exec(h1)![1]}`)
  expect(chunk.status).toBe(200); expect(chunk.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  expect(await chunk.text()).toContain('__brustIslands')
})
test('notFound verdict renders the route template at 404 and is not cached', async () => {
  const r = await fetch(`${base}/items/nothing`)
  expect(r.status).toBe(404); expect(await r.text()).toContain('<h1 id="brust-r2-')
  expect((await fetch(`${base}/items/nothing`)).headers.get('x-brust-cache')).toBe('MISS')
})
```
Plus a fourth test: `/nope` → 404 and `/public/app.css` → `body{margin:0}`. Run: `cd packages/brust && bun test test/e2e.test.ts` → `4 pass`. If the island assertion fails on `+0` text or attribute order, fix the EXPECTATION to the actual `renderToString` output only after reading it — never loosen to a bare `contains('team')`.

- [ ] **Step 2: CI job** (append to `.github/workflows/ci.yml`; same toolchain/cache steps as the `rust` job, lines 7-21)

```yaml
  server:
    runs-on: ubuntu-latest
    steps:
      # checkout / rust-toolchain (+ clippy) / setup-bun / actions/cache: the same four steps as `rust` (ci.yml:9-21)
      - run: bun install --frozen-lockfile
      - run: cargo clippy -p brust-napi --no-deps -- -D warnings && cargo test -p brust-napi
      - run: cd packages/brust && bun run build:debug
      - run: cd packages/brust && bun run typecheck
      # Unit files together; each server-starting file on its own (port/process hygiene, 0.1.x rule).
      - run: cd packages/brust && bun test test/routes.test.ts test/cache.test.ts test/worker.test.ts test/config.test.ts test/napi-compile.test.ts test/build-compile.test.ts
      - run: cd packages/brust && bun test test/napi-server.test.ts
      - run: cd packages/brust && bun test test/build-manifest.test.ts
      - run: cd packages/brust && bun test test/cli.test.ts
      - run: cd packages/brust && bun test --timeout 120000 test/e2e.test.ts
```
Also add `-p brust-napi` to the `rust` job's clippy line (line 27) so `cargo build --workspace` + clippy cover the crate there too.

- [ ] **Step 3: README** (`packages/brust/README.md`, ≤ 60 lines): install, `routes.tsx` example (S4), `brust build` → `dist/` layout (S5), `brust start` + env/toml precedence (§8), the loader/jobs wire shapes with a pointer to `protocol.rs`, "M2 limits" (route fields, one-level per-row instances, react props must be same-named loader keys — Global Constraints note), gates.

- [ ] **Step 4: Commit**

```bash
git add packages/brust/test/e2e.test.ts packages/brust/README.md .github/workflows/ci.yml .gitignore
git commit -m "test(brust): e2e over the built fixture app; ci server job; package README"
```

---

## Verification (READY evidence, paste in the task note)

```
cargo fmt --all -- --check && cargo clippy -p brust-napi --no-deps -- -D warnings && cargo test -p brust-napi   # 2 passed
cd packages/brust && bun run build:debug && bun run typecheck
bun test test/routes.test.ts test/cache.test.ts test/worker.test.ts test/config.test.ts test/napi-compile.test.ts test/build-compile.test.ts   # 16 pass (3+1+6+2+1+3)
bun test test/napi-server.test.ts        # 1 pass
bun test test/build-manifest.test.ts     # 2 pass
bun test test/cli.test.ts                # 2 pass
bun test --timeout 120000 test/e2e.test.ts   # 4 pass
cd ../.. && cargo test --workspace --exclude bun_react_compiler && bun run browser-test && bun run battery && git status --short docs/   # unchanged
```
Paste `packages/brust/test/fixtures/app.expected-manifest.json` and the challenge ids filed (`cache` import specifier; ssr prop-name remap). PR `lane/m2c-napi-package` → `v2`, CI green on all jobs (`rust`, `runtime-dom`, `battery`, `browser`, `server`), lane HEAD sha.

## Dispatch table (for the Coordinator)

| slug | plan tasks | tier | role | deps | review | acceptance (READY evidence) |
|---|---|---|---|---|---|---|
| `m2c-napi-package` | 1–8 | complex | Implementer (Complex) | `m2a-compiler`, `m2b-server-port`, `m2d-island-hydration` merged (base = `v2` after PR #122) | complex | Verification block pasted with counts (Rust 2; bun 16 + 1 + 2 + 2 + 4); pinned manifest pasted and reviewed against the T6 rules; challenges filed for the two contract gaps; PR → `v2` with all five CI jobs green; lane HEAD sha |
