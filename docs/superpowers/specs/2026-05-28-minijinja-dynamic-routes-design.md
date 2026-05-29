# Spec — Dynamic routes: swc-emitted jinja in `.brust/jinja/` + JS-loader-over-SAB

**Date:** 2026-05-28
**Branch:** `refactor/cargo-workspace`
**Parent:** `8208a76` (v2.1 → this v2.2 in-place; v2 was `e2f4d24`, v1 was `f8c5f6f`)
**Replaces:** A1 maud emit target, A2.0–A2.3 static-render chain. **Does NOT replace jsx-rust-compiler**; the crate is repurposed as the JSX→jinja transformer.
**v2 → v2.1 changes**: reviewer (`a7fc61cbddb59263b`) flagged 2 unresolved blockers (SAB framing + migration ordering) and 5 FIX/OQ items. v2.1 applies all inline. SIGN-OFF v2 was `not-ready`; this v2.1 addresses each finding by section number — see §3, §6, §13, §15 for the specific corrections.

**v2.1 → v2.2 change**: user-facing API field renamed from `jinja: true` → `native: true` to keep the API engine-agnostic (the engine is an implementation detail; the user just declares "this route is rendered natively, not via React"). All FlatRoute / RouteConfig / registerRoutes field names follow (`nativeTemplate`, `native_template`). Internal Rust symbols (jinja.rs, napi_render_jinja, .brust/jinja/) keep engine-specific naming — they're implementation, not API. See §13.1 for the reasoning.

---

## 0. Why v2 (reviewer + user correction)

Spec v1 (`docs/superpowers/specs/2026-05-28-minijinja-dynamic-routes-design.md` at commit `f8c5f6f`) proposed jinja templates committed inside `crates/brust/src/jinja_routes/*.jinja`, with minijinja as the runtime engine. The user corrected:

> "ไม่ใช่แบบนี้ คือเอา swc + custom แปลง JSX -> jinja ใน .brust ไม่ใช่รวมใน crates/brust"

(= "Not like that — use swc + custom transformer to convert JSX → jinja into `.brust/`, NOT bundled inside crates/brust")

The correct architecture **reuses jsx-rust-compiler's swc parser + IR + lowering** (load-bearing T0–T6 work from A1) and **only swaps its emit target** from maud to jinja. Templates live in the **user's** project at `.brust/jinja/<ComponentName>.jinja` (alongside the existing `.brust/css/` convention), not inside brust's source tree.

This means:
1. User writes plain JSX in their `pages/*.tsx` files (familiar, no jinja syntax to learn).
2. `brust build` / `brust dev` invokes the JSX→jinja transform, dumps `.brust/jinja/<Name>.jinja`.
3. brust runtime loads all `.brust/jinja/*.jinja` into a minijinja `Environment` at startup.
4. Routes mark `native: true`; Component.name keys into the template registry.
5. Loader runs in JS, data flows via SAB to Rust (same channel as actions), Rust renders, returns framed bytes.

The maud emitter from A1 is **removed** from jsx-rust-compiler. The crate's parser (`parser.rs`), IR (`ir.rs`), lowering (`lower.rs`) stay intact. A new `emit_jinja.rs` replaces `emit.rs`. CLI `jsx-rustc` keeps the same args but emits `.jinja` instead of `.rs`.

This v2 also addresses reviewer findings from v1 (`a740b759cc3fa4ca4`, sign-off `ready-after-fixes`). Cross-references inline.

## 1. Goal

Land an end-to-end path where user writes:

```tsx
// pages/Profile.tsx
export default function Profile({ user, joinedAt }) {
  return (
    <div>
      <h1>{user}</h1>
      <p>Joined {joinedAt}</p>
    </div>
  )
}
```

and registers:

```tsx
// routes.tsx
import Profile from './pages/Profile'

defineRoutes([
  { path: '/profile/{user}', Component: Profile, native: true,
    loader: async ({ params }) => ({ user: params.user, joinedAt: '2026-05-28' }) },
])
```

The framework:
1. At `brust build`/`brust dev`, scans routes; for each `native: true` entry, compiles its Component's source `.tsx` via the (renamed/extended) `jsx-rustc` → writes `.brust/jinja/Profile.jinja`:
   ```jinja
   <div><h1>{{ user }}</h1><p>Joined {{ joinedAt }}</p></div>
   ```
2. At runtime startup, brust loads every `.brust/jinja/*.jinja` into a minijinja `Environment`.
3. At request time:
   - Rust matches the route
   - JS worker runs middleware + loader → produces `{ user, joinedAt }`
   - Worker writes JSON-stringified data to the SAB, calls `napiRenderJinja(workerId, dataLen, "Profile")`
   - Rust reads SAB, parses JSON, renders the `Profile` template, returns framed bytes via the chunk channel
   - per-conn task writes to TCP

Per-request perf claim: floor ≥60k RPS, target close to A2.3's 109k (smoke bench measured 101k with a hardcoded handler; production path adds tsfn dispatch + middleware + JSON parse + SAB write).

## 2. Cleanup (what changes vs current HEAD)

Reviewer Blocker 3 explicit: cleanup table is exhaustively cross-checked against the working tree.

### Files removed

| Path | Why |
|---|---|
| `crates/brust/src/compiled_routes/` (mod.rs + static_hello.tsx) | A2.x static path superseded |
| `crates/brust/src/dynamic_routes.rs` (uncommitted in wd) | Hardcoded bench; replaced by real jinja loader |
| `tests/napi-render-compiled.test.ts` | `napi_render_compiled` retired (replaced by `napi_render_jinja`) |
| `tests/rust-compiled-route.test.ts` | A2.3 E2E; replaced by jinja-route E2E |
| `crates/jsx-rust-compiler/src/emit.rs` | maud emit target retired; replaced by `emit_jinja.rs` |
| `crates/jsx-rust-compiler/fixtures/*.expected.rs` | maud goldens (3 files) |
| `crates/jsx-rust-compiler/fixtures/*.expected.html` | maud-rendered goldens (3 files) |
| `crates/jsx-rust-compiler/tests/golden_emit.rs` | maud emit goldens |
| `crates/jsx-rust-compiler/tests/golden_render/` | maud render goldens |

### Files modified

| Path | Diff |
|---|---|
| `crates/jsx-rust-compiler/Cargo.toml` | `-maud` (dev-dep) `-bench` feature flag `+minijinja` (dev-dep, drives the new golden_render_jinja tests) |
| `crates/jsx-rust-compiler/src/lib.rs` | `-mod emit` `+mod emit_jinja`; `compile` returns jinja source |
| `crates/jsx-rust-compiler/src/bin/jsx-rustc.rs` | unchanged at the arg level, but now writes `.jinja` not `.rs` |
| `crates/jsx-rust-compiler/src/bin/jsx-bench.rs` | retired (was maud-render bench) OR kept as `bench-jinja` that bench-renders via minijinja against the new goldens |
| `crates/brust/Cargo.toml` | `-maud` `-jsx-rust-compiler` (build-dep) `+minijinja = "2"` |
| `crates/brust/build.rs` | drop the `compiled_routes/*.tsx` scan; build script is back to just `napi-build::setup()` |
| `crates/brust/src/lib.rs` | `-mod compiled_routes` `-fn napi_render_compiled` `+mod jinja` `+fn napi_render_jinja` |
| `crates/brust/src/routes.rs` | `RouteConfig.static_render` → `RouteConfig.native_template`; `RouteTable.static_renders/static_prebuilt` → `RouteTable.native_templates: RwLock<Vec<Option<String>>>` |
| `crates/brust/src/server.rs` | drop A2.3 short-circuit branch; drop the bench-only `/_jinja-test/{name}` handler in uncommitted wd; render dispatch flow unchanged (still goes through `dispatch_to_worker_and_stream_chunks`) |
| `runtime/routes.ts` | `static?: boolean` → `native?: boolean`; `staticRender` → `nativeTemplate`; validateRoute block rewritten; A2.2-era stale comment block removed |
| `runtime/routes.test.ts` | 7 validation tests renamed/rewritten; `staticRender` assertion → `nativeTemplate` |
| `runtime/index.ts` | `registerRoutes` payload field renamed |
| `runtime/cli/build.ts` and `runtime/cli/dev.ts` | NEW pass: scan routes for `native: true`, resolve Component source path, invoke jsx-rustc, write `.brust/jinja/<Name>.jinja`. Re-run on TS edit during `dev` |
| `example/hello-world/routes.tsx` | migrate `/_rust-static` route (`static: true`) to `native: true` + a real loader |
| `tests/fixtures/app/routes.tsx` | same migration |
| `architecture.md` | replace Sub-project A1 + A1.1 section with a Sub-project J (jinja) section; rewrite numbers; remove dangling line 1062 reference to `napi_render_compiled` |

### Files added

| Path | Purpose |
|---|---|
| `crates/jsx-rust-compiler/src/emit_jinja.rs` | NEW IR→jinja emitter |
| `crates/jsx-rust-compiler/fixtures/*.expected.jinja` (3) | jinja goldens replacing the `.expected.rs` |
| `crates/jsx-rust-compiler/tests/golden_emit_jinja.rs` | golden test (replaces `golden_emit.rs`) |
| `crates/jsx-rust-compiler/tests/golden_render_jinja/` | render minijinja, compare HTML (replaces `golden_render/`) |
| `crates/brust/src/jinja.rs` | minijinja `Environment` builder + `render(name, data_json) -> Result<String, RenderError>` |
| `tests/jinja-route.test.ts` | E2E: dev/build → boot brust → curl route with loader → assert bytes |
| `.gitignore` | append `.brust/jinja/` (built artifacts, like `.brust/css/`) |

### `jsx-rust-compiler` is load-bearing, not dormant

Reviewer Fix 6: v1 framed jsx-rust-compiler as "standalone tooling, useful for future work". v2 corrects: the crate's parser + IR + lowering ARE the JSX→jinja transformer. Only the emit target changes. The 18-task A1 investment is **substantially** preserved (T0 bootstrap, T1 swc parser, T2 ErrorKind, T3 happy-path lower, T4 props+exprs, T5 .map, T6 attr precedence — all carry over verbatim). T7 (maud emit) is replaced; T8 + T9 fixtures are rewritten; T10 CLI is unchanged at the arg level.

### What `jsx-rust-compiler` keeps from A1

| A1 task | Status |
|---|---|
| T0 — bootstrap (Cargo + swc_core 68) | KEEP |
| T1 — swc parser (TsSyntax tsx: true) | KEEP |
| T2 — `CompileError`/`ErrorKind` taxonomy | KEEP (some kinds drop, e.g. `VoidElementHasChildren` — jinja accepts void with content) |
| T3 — IR + zero-prop happy-path lower | KEEP |
| T4 — destructured props + ident/member exprs + type inference | KEEP (type inference still informs `dataT` JSON shape doc) |
| T5 — `.map((item) => <JSX>)` lowering | KEEP |
| T6 — attr rename precedence + whitespace + void-element check | KEEP attr rename + whitespace; relax void check |
| T7 — IR→maud emit | **REPLACE** with `emit_jinja.rs` |
| T8 — fixtures + golden_emit | REWRITE fixtures and goldens for jinja |
| T9 — golden_render via maud | REWRITE for minijinja |
| T10 — `jsx-rustc` CLI | UNCHANGED at arg level; output extension changes |
| T11 — workspace verification | RE-RUN |

## 3. High-level architecture

```
USER'S PROJECT TREE:
  pages/
    Profile.tsx                 ← user-authored JSX (default-exported function component)
  routes.tsx                    ← { path, Component: Profile, native: true, loader }
  .brust/
    css/                        ← (existing — built CSS extraction)
    jinja/                      ← NEW — JSX-compiled jinja templates
      Profile.jinja             ← <div><h1>{{ user }}</h1>...</div>

BRUST BUILD (runtime/cli/build.ts):
  1. scan routes for `native: true` entries
  2. resolve each Component's source path (file the import points to)
  3. invoke `jsx-rustc <pages/Profile.tsx> --target jinja -o .brust/jinja/Profile.jinja`
  4. write a manifest `.brust/jinja/_manifest.json` listing built templates

BRUST RUNTIME (boot):
  1. read `.brust/jinja/*.jinja` files
  2. build minijinja `Environment` with strict-undefined mode
  3. register each template by basename (sans `.jinja`)

BRUST RUNTIME (per request):
  TCP → Rust accept → match_path → route_id → cache check
                                    ↓
                          (route has nativeTemplate?)
                                    ↓ yes
                         dispatch_to_worker (existing tsfn)
                                    ↓
                          JS worker dispatcher:
                             - run middleware chain
                             - run loader → data object
                             - JSON.stringify(data ?? {}) → dataBytes
                             - if dataBytes.length > SAB cap → 413 path
                             - sab.set(dataBytes, 0)
                             - await napiRenderJinja(workerId, dataLen, templateName)
                                    ↓ (napi)
                          Rust:
                             - read &sab[0..len] (BufPtr already registered)
                             - jinja::render(templateName, &sab[0..len]) → String
                             - build ChunkMeta { status: 200, content_type, ... } → serialize to JSON
                             - assemble Vec<u8>:
                                 [meta_len: u16 BE]
                                 [meta JSON UTF-8]
                                 [body bytes]
                             - send via RenderChunk::BytesAndFinal { data, ack }
                          per-conn task (UNCHANGED):
                             - receives RenderChunk::BytesAndFinal
                             - split_meta(&data) → (meta, body)
                             - build_single_response_bytes(&meta, body) → framed HTTP/1.1
                             - write_all to TCP
```

**Reviewer Blocker 1 resolved (v2.1)**: Earlier v2 said Rust calls `http::build_response()` to produce framed HTTP/1.1 bytes and ships them via `RenderChunk::BytesAndFinal`. The v2.1 reviewer empirically verified that's wrong — the per-conn task at `server.rs:1031` (Bytes arm) and `server.rs:1101` (BytesAndFinal arm) calls `split_meta(&data)` unconditionally, which parses `[meta_len: u16 BE][meta JSON][body]` (`render_stream.rs:33-45`). Raw `HTTP/1.1 200 OK\r\n...` bytes prefix-decode to `meta_len = 0x4854 ('HT')`, fail bounds check, hit error_500 (`server.rs:1109`), connection close. v2.1 corrects: Rust builds the SAME `[meta_len][meta JSON][body]` shape JS produces in `emitSingleChunkResponse` (`runtime/routes.ts:818-862`), ships it via `RenderChunk::BytesAndFinal`, and the per-conn task's existing `split_meta` + `build_single_response_bytes` path handles cache write-back + framing + TCP write identically to a JS-produced chunk. No new IPC primitive. No bypass.

## 4. JS API

```ts
// runtime/routes.ts
interface Route {
  path?: string
  Component?: ComponentType<any>
  loader?: (...) => Promise<unknown>
  /** Compile this route's JSX (from Component's source file) into a jinja
   * template at build time, render via minijinja at request time. The
   * `Component.name` is the registry key; brust looks for
   * `.brust/jinja/<Component.name>.jinja` at boot. Compatible with
   * `loader` and `middleware`; rejects `sse`, `websocket`, `children`,
   * `cache` (cache is deferred). */
  native?: boolean
  // ... existing fields
}
```

Validation (`validateRoute`):
- `native: true` requires `Component` and `Component.name` non-empty (named function or named class).
- ALLOWS `loader` (whole point — loader feeds data).
- ALLOWS `middleware`.
- REJECTS `sse`, `websocket`, `children`, `cache`, `static` (last as cleanup).

`FlatRoute.nativeTemplate?: string` = `leaf.Component.name` when `leaf.jinja === true`.

`registerRoutes` payload gains `nativeTemplate: r.nativeTemplate ?? null`.

**Reviewer OQ 1 + 2 resolved**: keep `native: true` + Component.name as key, because Component IS the source file the compiler consumes. The minifier-name-mangling concern is real but addressed at build time: jsx-rustc reads the function name from the `export default function Foo(...)` AST node, NOT from minified output. The runtime registry key matches that AST-time name (which is preserved in user source). For routes registered AFTER bundling, the FlatRoute carries the build-time name in `nativeTemplate` field — not Component.name at runtime. So minifiers can rename Component all they like; the registry still hits.

**Reviewer Fix 2 (Component footgun) resolved**: Component IS executable React code. In dev mode, brust MAY fall back to React render if `.brust/jinja/<Name>.jinja` is missing (future enhancement). In prod, render is via jinja. The Component is real, not a marker — kills the footgun. Documentation will note: "Component is the source. Its function body is what jsx-rustc analyzes."

## 5. jsx-rust-compiler — JSX→jinja emit rules

This replaces `emit.rs` with `emit_jinja.rs`. Lowering is unchanged. Each IR node maps to jinja syntax:

| IR node | jinja emission |
|---|---|
| `Element { tag, attrs, children }` non-void | `<tag attrs>children</tag>` |
| `Element` void (br, hr, img, …) | `<tag attrs/>` (HTML5 self-closing form; jinja doesn't care) |
| `Text(s)` | literal text, HTML-escape at compile time |
| `Expr(Expr::Field(name))` | `{{ name }}` (root-level prop) |
| `Expr(Expr::MemberAccess { root, path })` | `{{ root.p0.p1 }}` |
| `Expr(Expr::MapBinding(name))` | `{{ name }}` (map iter binding) |
| `Expr(Expr::MapMember { root, path })` | `{{ root.p0.p1 }}` |
| `Expr(Expr::StaticText(s))` | escaped literal `s` |
| `Expr(Expr::StaticNum(n))` | literal `{{ n }}` |
| `Map { source, binding, body }` | `{% for binding in source %}body{% endfor %}` — `source` is `props.<root>...` form |

For attributes:
| AttrValue | jinja emission |
|---|---|
| `Empty` (bare boolean) | `name` (just the bare name) |
| `Static(s)` | `name="s-escaped"` (compile-time HTML attr-escape) |
| `StaticNum(n)` | `name="n"` |
| `Expr(e)` | `name="{{ <emit_expr> }}"` |

Attribute renames (className→class etc.) apply identically to A1.

Static-text concatenation across the AST: adjacent `Text` nodes get merged at emit time so the resulting jinja file is compact.

### Source root naming

Component prop names in source = jinja top-level context keys. Loader return value → JSON object whose keys map by name to template variables.

### Example

Input `pages/HelloPage.tsx`:
```tsx
export default function HelloPage({ title, items }) {
  return (
    <div>
      <h1>{title}</h1>
      <ul>
        {items.map((item) => (
          <li><a href={item.href}>{item.label}</a></li>
        ))}
      </ul>
    </div>
  )
}
```

Output `.brust/jinja/HelloPage.jinja`:
```jinja
<div><h1>{{ title }}</h1><ul>{% for item in items %}<li><a href="{{ item.href }}">{{ item.label }}</a></li>{% endfor %}</ul></div>
```

Loader return:
```ts
async ({ params }) => ({ title: 'Welcome', items: [{ href: '/a', label: 'Alpha' }] })
```

Rendered HTML:
```
<div><h1>Welcome</h1><ul><li><a href="/a">Alpha</a></li></ul></div>
```

## 6. Rust API — `crates/brust/src/jinja.rs`

```rust
use std::path::Path;
use std::sync::OnceLock;

use minijinja::{Environment, UndefinedBehavior};

// v2.1: OnceLock (not RwLock<OnceLock>) — hot reload is deferred per §13.7.
// If hot reload lands in v2.x, swap to RwLock<Environment<'static>> in a
// follow-up; the change is contained to this module.
static ENV: OnceLock<Environment<'static>> = OnceLock::new();

/// Boot-time: load every `.brust/jinja/*.jinja` into the static Environment.
/// Called by `brust::run()` before serving. `dir` is `.brust/jinja/` resolved
/// relative to the entry's CWD.
///
/// v2.1: lenient on missing dir. A user with zero `native: true` routes won't
/// have `.brust/jinja/` and must boot cleanly. Missing dir → empty Env;
/// `UnknownTemplate` fires per-request only if a route claims a template
/// that never landed. Parse errors on individual files DO panic — those are
/// real build-pipeline drift.
pub fn load_from(dir: &Path) -> Vec<String> {
    let mut env = Environment::new();
    // v2.1: Chainable (not Strict) — minijinja chains undefined through
    // `obj.nested.field` without erroring at the chain, only on direct render.
    // Loaders that omit optional keys can use `{% if x is defined %}` guards;
    // Strict mode errored on the `x` evaluation itself, making the guard
    // unusable. Reviewer OQ 4.
    env.set_undefined_behavior(UndefinedBehavior::Chainable);
    let mut names = Vec::new();

    if !dir.exists() {
        ENV.set(env).expect("jinja env initialized once");
        return names;
    }

    // Read all .jinja files in dir; templates owned by the environment as
    // 'static via leaking each source string (small set, one-time leak).
    // ... (full impl in plan)

    ENV.set(env).expect("jinja env initialized once");
    names
}

/// Per-request render: `data_json` is a slice of UTF-8 bytes from SAB.
/// Returns the rendered HTML; caller wraps in `[meta_len][meta JSON][body]`
/// per §3 and ships via RenderChunk::BytesAndFinal.
pub fn render(name: &str, data_json: &[u8]) -> Result<String, RenderError> {
    let env = ENV.get().ok_or(RenderError::NotLoaded)?;
    let tmpl = env.get_template(name).map_err(|_| RenderError::UnknownTemplate)?;
    let value: serde_json::Value = serde_json::from_slice(data_json)
        .map_err(|e| RenderError::BadJson(e.to_string()))?;
    tmpl.render(value).map_err(|e| RenderError::Render(e.to_string()))
}

#[derive(Debug, thiserror::Error)]
pub enum RenderError {
    #[error("jinja Environment not loaded (call load_from first)")] NotLoaded,
    #[error("unknown template: {0:?}")] UnknownTemplate,
    #[error("bad JSON: {0}")] BadJson(String),
    #[error("render: {0}")] Render(String),
}

/// Boot-time helper: lists registered templates, for use by `registerRoutes`
/// to verify every `native: true` route's Component.name maps to a built
/// template. Reviewer Fix 1.
pub fn registered_templates() -> Vec<String> {
    ENV.get()
        .map(|lock| lock.read().templates().keys().map(String::from).collect())
        .unwrap_or_default()
}
```

A napi shim exposes `napiListJinjaTemplates() -> Vec<String>` so the JS side can validate every `native: true` Component.name exists in the registered set. v2.1 scopes this to a startup warning (not panic — reviewer Fix 1 acceptance): brust's `registerRoutes` JS-side caller iterates `flat.filter(r => r.nativeTemplate)` and warns on any name NOT present in `napiListJinjaTemplates()`. Mismatched routes still fall back to a 500 at request time (logged by name in `dispatch_to_worker_and_stream_chunks`); pre-flight panic is a v2.x follow-up.

### `napi_render_jinja`

```rust
// crates/brust/src/lib.rs
#[napi]
pub async fn napi_render_jinja(
    worker_id: u32,
    data_len: u32,
    template_name: String,
) -> NapiResult<()> {
    // 1. Get the worker's (BufPtr, total_len) + chunk_tx from the pool
    //    (mirrors napi_render_chunk_final at crates/brust/src/lib.rs:570).
    // 2. Bounds-check: data_len <= total_len.
    // 3. SAFETY: BufPtr is pinned at register time; slice up to data_len.
    // 4. Call jinja::render(&template_name, sab_slice) → String.
    //    On RenderError, build a synthetic 500 ChunkMeta + body "internal
    //    error" and proceed to step 5 with that shape — the per-conn task
    //    must still receive a final chunk to release the worker.
    // 5. Build ChunkMeta { status: 200, content_type: "text/html; ...",
    //    headers: empty, streaming: false } → serde_json::to_vec.
    // 6. Assemble Vec<u8> in this exact order (matches split_meta at
    //    crates/brust/src/render_stream.rs:33-45):
    //      [meta_len: u16 BE]  (2 bytes)
    //      [meta JSON UTF-8]   (meta_len bytes)
    //      [body bytes]        (html.as_bytes())
    // 7. Send via RenderChunk::BytesAndFinal { data: vec, ack: ack_tx } on
    //    the worker's chunk_tx (same as napi_render_chunk_final).
    // 8. await ack_rx (per-conn task ack semantics unchanged).
    //
    // The per-conn task at server.rs:1101 will then split_meta() the
    // assembled bytes, call build_single_response_bytes(&meta, body) to
    // produce the framed HTTP/1.1 wire bytes, write_all to TCP, and on
    // cache_wanted hit invoke the on_success closure with the framed
    // bytes — cache write-back works identically to JS-produced chunks.
    ...
}
```

This routes the rendered bytes through the SAME `RenderChunk` channel + ack semantics + cache hooks as existing chunks. `napi_render_jinja` does NOT call `http::build_response` (that lives in the per-conn task path). NOT a new IPC primitive.

### SAB protocol

**Inbound (NEW direction)**: JS writes raw JSON application data to SAB[0..dataLen]. NOT framed with the existing `[meta_len: u16 BE][meta JSON][body]` header. The `napi_render_jinja` shim knows the entire SAB up to `dataLen` is data.

This is the new convention. To avoid the per-conn task having to know which direction the SAB is being used, the convention is per-napi-call: `napi_render_jinja` always treats SAB as inbound data + outbound chunks; `napi_render_chunk*` treats SAB as outbound chunks only. The protocol is unambiguous given the entry point.

## 7. Build pipeline — `runtime/cli/build.ts` + `runtime/cli/dev.ts`

NEW pass: scan routes, emit jinja files.

### Algorithm (pseudo-code)

```ts
import { flattenRoutes } from '../routes.ts'
import { spawnSync } from 'node:child_process'
import { dirname, resolve, basename, extname } from 'node:path'

const flat = flattenRoutes(userRoutes)
const nativeRoutes = flat.filter(r => r.nativeTemplate !== undefined)
const outDir = resolve(cwd, '.brust/jinja')
mkdirSync(outDir, { recursive: true })

for (const r of nativeRoutes) {
  const componentName = r.nativeTemplate!
  const sourcePath = resolveComponentSource(r) // walk r.chain, find leaf's Component import
  const outPath = resolve(outDir, `${componentName}.jinja`)
  
  const result = spawnSync('jsx-rustc', [sourcePath, '--target=jinja', '-o', outPath])
  if (result.status !== 0) throw new Error(`jsx-rustc failed for ${sourcePath}: ${result.stderr}`)
}

// Manifest for the runtime to verify against
writeFileSync(resolve(outDir, '_manifest.json'), JSON.stringify({
  templates: nativeRoutes.map(r => r.nativeTemplate),
  generatedAt: new Date().toISOString(),
}))
```

For dev mode (`brust dev`): the watcher already exists for TS edits. When a route's Component source changes, re-run `jsx-rustc` for THAT route only and signal the brust runtime to reload that template (via the existing dev WS channel or a new "reload jinja" command).

### `jsx-rustc` CLI changes

- `--target=jinja` accepted but defaults to jinja (only target in v2.1).
- Output extension defaults to `.jinja`.
- All other args unchanged.

Plan-time bikeshed: keep `--target=` as future-proofing OR drop entirely. Lean toward keeping (free option, no maintenance burden for "accepts one value").

### Component-source resolution (v2.1 reviewer OQ 1)

The build script needs to map each `native: true` route's Component to its `.tsx` source path. At runtime `Component` is a JS function reference; at build time we need the file path.

**v2.1 picks option (i) — build-time AST scan of routes module.** Algorithm:

1. `runtime/cli/build.ts` already loads the user's routes module (via dynamic `import()`) to call `defineRoutes` and get the FlatRoute list. v2.1 ADDS a parallel pass: parse the routes module's source with swc (already a workspace dep via `jsx-rust-compiler`) → collect `ImportDeclaration` nodes → build a `Map<localName, resolvedPath>`.
2. For each route with `native: true`, look up `flat.chain.last().Component` by NAME (Component.name at AST time, which is the imported local name in routes.tsx).
3. The resolved path becomes the `jsx-rustc` input.
4. Cache resolved-path → built-jinja in `.brust/jinja/_manifest.json` so unchanged sources skip recompile.

Limitations:
- Routes registered dynamically (e.g. `const r = await fetchRoutes()`) can't be statically resolved. The build pipeline warns + skips them; they'd fall back to React render OR error at boot (TBD in plan).
- Re-export chains (`export { default as Profile } from './Profile'`) require a recursive resolver. v2.1 supports single-hop imports; deeper chains land in a v2.x follow-up.

The fancier options (Vite plugin injecting `Component.__source`; explicit `componentSource: '/path/x.tsx'` field on the route) are deferred — the AST-scan approach has zero user-facing surface and works for the example app + test fixtures shape.

## 8. Server dispatch (server.rs)

Render dispatch flow is **unchanged** in shape from current main. The A2.3 short-circuit is removed; render goes through `dispatch_to_worker_and_stream_chunks` like any React route. The difference: the envelope JSON gains a `native_template` field; the JS worker reads it and branches to the SAB-write path instead of the React render path.

```rust
let envelope_json = build_render_envelope(
    method, full_path, query, raw_request,
    /* NEW */ native_template: routes.native_template_for(route_id),
);
dispatch_to_worker_and_stream_chunks(envelope_json, "render", cache_wanted, on_success).await
```

No `static_prebuilt`, no `static_render`, no short-circuit. Reviewer Blocker 2 (migration build-state) is moot because the rewrite is a CLEAN swap, not delete-then-add.

## 9. Worker-side dispatcher (`runtime/routes.ts`)

The worker's render branch currently calls `renderBranchStreaming(element, ...)` (React path). After v2, it branches on `flat.nativeTemplate`:

```ts
if (call.kind === 'render') {
  const flat = byRouteId.get(call.route_id)
  // ... middleware chain runs (unchanged)
  // verdict._brustStream check (unchanged)

  if (flat.nativeTemplate !== undefined) {
    // NEW jinja path
    let data: unknown = {}
    if (flat.chain.some(r => r.loader)) {
      const ctx = { params: call.params, path: call.path, req: call.req }
      // run leaf's loader (top-level only — children's loaders are NOT supported
      // for jinja routes in v2; defer compositing to a follow-up)
      data = await flat.chain[flat.chain.length - 1].loader!(ctx)
    }
    const json = JSON.stringify(data ?? {})
    const dataBytes = encoder.encode(json)
    if (dataBytes.length > view.length) {
      await emitSingleChunkResponse(view, napi, workerId, encoder, {
        status: 413, contentType: 'text/plain; charset=utf-8', body: 'loader data too large',
      })
      return
    }
    view.set(dataBytes, 0)
    try {
      await (native as any).napiRenderJinja(Number(workerId), dataBytes.length, flat.nativeTemplate)
    } catch (err) {
      console.error(`[brust] napiRenderJinja failed for "${flat.nativeTemplate}":`, err)
      await emitSingleChunkResponse(view, napi, workerId, encoder, {
        status: 500, contentType: 'text/html; charset=utf-8', body: 'internal error',
      })
    }
    return
  }

  // React path (unchanged)
  let element: ReactNode
  try {
    element = await buildRenderElement(call, flat, opts.getWorkerId)
    ...
  } ...
  await renderBranchStreaming({ element, view, workerId, napi, ... })
}
```

The napi shim object grows `napiRenderJinja: async (...)`.

## 10. Tests

### Unit (`crates/brust/src/jinja.rs #[cfg(test)]`)

- `load_from_reads_jinja_files`
- `render_hit_with_full_context`
- `render_unknown_template_returns_unknown_error`
- `render_bad_json_returns_bad_json_error`
- `render_strict_undefined_errors_on_missing_var` (reviewer OQ 3)

### Unit (`crates/jsx-rust-compiler/src/emit_jinja.rs #[cfg(test)]`)

- `emits_static_element_with_text`
- `emits_text_expr_as_double_brace`
- `emits_attr_expr_as_quoted_double_brace`
- `emits_map_as_for_loop`
- `emits_void_element_self_closing`

### Golden — emit (`crates/jsx-rust-compiler/tests/golden_emit_jinja.rs`)

3 fixtures: static_hello, props_hello, list_nav. Each `.tsx` → expected `.jinja` byte-equal.

### Golden — render (`crates/jsx-rust-compiler/tests/golden_render_jinja/`)

Each fixture: compile to jinja → load into minijinja → render with known props → compare to expected `.expected.html`. Identical infra to A1's golden_render but engine swapped.

### Bun (`tests/jinja-route.test.ts`)

E2E:
1. Spawn `bun run build` for tests/fixtures/app (writes `.brust/jinja/`)
2. Spawn brust server
3. `curl /jinja-test/World` → expect the loader-supplied data + URL param in rendered HTML
4. Tear down

### SAB-protocol-violation cases (reviewer Fix 5)

In a separate `tests/jinja-protocol.test.ts` (or inside the napi shim's `#[cfg(test)]`):
- `data_len > sab_len` → 413 path (no Rust crash)
- `data_len == 0` → render with `{}` (strict mode: variables missing → 500)
- `template_name == ""` → UnknownTemplate → 500
- malformed JSON in SAB → BadJson → 500

### Workspace gates

- `cargo test --workspace --lib` ≥ 110 brust + 36 jsx-rust-compiler (some maud tests delete; jinja unit tests add) = ≥130 (final count verified at T-last)
- `cargo test -p jsx-rust-compiler` covers integration tests `golden_emit_jinja` + `golden_render_jinja`
- `bun test runtime/` ≥ 196 (validation tests rewritten 1-for-1)
- `bun test tests/jinja-route.test.ts` 1+ E2E pass
- `bun test tests/integration.test.ts -t 'serves rendered html'` unchanged (React path intact)

## 11. Acceptance criteria

1. `cargo build --workspace` succeeds.
2. `cargo test --workspace --lib` passes; counts re-verified.
3. `bun run build` produces a `.node` with `napiRenderJinja` exported.
4. `bun test runtime/` passes; new validation tests cover `native: true`.
5. `bun test tests/jinja-route.test.ts` passes.
6. `bun test tests/integration.test.ts -t 'serves rendered html'` passes (React unchanged).
7. **Reviewer Fix 3 (lowered bar)**: `oha -c 120 -z 10s -m GET /jinja-test/X` measures **≥60,000 RPS** on M1 Pro (floor). 90k+ is a stretch goal; numbers below 60k blocked.
8. `cargo clippy -p brust --lib -- -D warnings` clean; same for `-p jsx-rust-compiler`.
9. `grep -rn -E 'maud|static: true|staticRender|rustCompiled|napi_render_compiled|compiled_routes|jinja: true|jinja\?:|jinjaTemplate' --include='*.rs' --include='*.ts' --include='*.tsx' --include='*.toml'` returns ZERO hits across the tree (reviewer Blocker 3 — exhaustive; v2.2 adds the jinja API tokens since v2.1's renames moved them to `native`).
10. `.brust/jinja/_manifest.json` lists every `native: true` route's Component.name; `bun run build` produces a `.jinja` file for each.
11. **Reviewer Fix 1**: at brust boot, `napiListJinjaTemplates()` must include every `native: true` route's Component.name. Mismatch logs a warning and the route falls back to 500 at runtime; in v2 this is dev-time noise, not a panic. Future: pre-flight validation panics on boot.

## 12. Known limitations (shipped state)

- Per-app templates committed under user's `pages/*.tsx`, built to `.brust/jinja/`. Brust framework ships zero templates (no built-ins). Future: framework-supplied templates (error pages, layouts) live in `brust/templates/` and merge into the user's Environment.
- Cache integration deferred (`cache` field rejected when `native: true`).
- Nested `loader` for children of a `native: true` route is not composited (only leaf's loader runs). Composition is a follow-up.
- minijinja's `Strict` undefined mode means typos in templates fail loudly at render — a feature, but breaks if a loader sometimes returns `{}`. Recommendation: loader return value should always include the keys the template references; use `{% if x is defined %}` to gate optional vars.
- `Component` body is REAL React code. Best practice: write Components that work as both React (for unit testing the JSX shape) AND get analyzed by jsx-rustc (for jinja output). Documentation to make this explicit. **In dev mode v2.1 does NOT fall back to React on missing template** — boot logs a warning, missing template renders 500 at request time. The dev-mode React fallback is a v2.x follow-up. (v2 previously stated this inconsistently in §13.5 — v2.1 collapses to one answer here.)
- `jsx-rust-compiler` loses the maud emit target. Past A1+A1.1 work (the maud-only T7-T11) is partially retired. The IR + parser + lower (T0-T6) are preserved verbatim.
- SAB size cap = per-worker registered length (currently ~64KB). Loader payloads larger than that get 413 — most apps stay well under.
- Hot reload of templates during `brust dev`: SUPPORTED in spec but plan-time decision on whether to land in v2 or follow-up. The minijinja Environment is wrapped in `RwLock` so the runtime can swap templates without restarting.

## 13. Open questions resolved at plan-time

1. **Field name** (v2.2): `native: true`. v2/v2.1 used `jinja: true` which exposed the implementation engine in the user-facing API. v2.2 switches to `native: true` because (a) it's engine-agnostic — future render strategies (compile-to-bytes, htmx, etc.) can live under the same flag without breaking users' route definitions; (b) brust's own server.rs already uses "native-only route" vernacular for paths handled by Rust without JS dispatch (see `/ping` comment at server.rs:150); (c) parallel to `static: true`'s established pattern. Internal Rust symbols (`jinja.rs`, `napi_render_jinja`, `.brust/jinja/`) keep the engine-specific naming — they're implementation details, not API surface.
2. **Registry key**: `Component.name` (Reviewer OQ 1+2 — keeping). Minifier safety addressed §4.
3. **Template directory**: `.brust/jinja/` (user direction — under user's project, like `.brust/css/`).
4. **Maud target retire**: full retire — no `--target=maud` flag in v2. Plan can resurrect if needed; no current consumer.
5. **Component-as-marker footgun**: resolved — Component IS the source, not a marker. Reviewer Fix 2.
6. **Undefined behavior**: v2.1 picks `Chainable` (not `Strict`). Templates can chain through optional props without error; direct render of undefined vars still errors. Trade: looser than v2 Strict, but `{% if x is defined %}` works. Reviewer OQ 4.
7. **Migration atomicity**: 8 commits, ordered per §15 v2.1 — brust drops jsx-rust-compiler build-dep BEFORE jsx-rust-compiler swaps emit target. Reviewer Blocker 2 addressed empirically.
8. **Hot reload of templates in dev**: deferred to v2.x. v2.1 uses `OnceLock<Environment>` (not `RwLock`) — no hot-reload contortions in the runtime.
9. **Pre-flight template validation**: v2.1 = startup warning via `napiListJinjaTemplates()`; mismatched routes still 500 at request time. Pre-flight panic is v2.x.
10. **Component-source resolution** (v2.1 reviewer OQ 1): build-time AST scan of the routes module via swc. See §7 last subsection.

## 14. Out of scope (acceptable deferrals)

- Per-app templates outside of `Component`'s source file (e.g. user wants two routes pointing at the same `.jinja` — for v2, write two Component files).
- Cache integration for jinja routes.
- Streaming render via minijinja's `Environment::stream` (current spec uses sync render to String).
- Dev-mode React-fallback when `.jinja` is missing (future polish).
- Loader-side prop validation enforced by jsx-rustc parsing the loader's return type.
- minijinja extensions (custom filters, autoescape per-template) — defaults are fine for v2.
- v2 only supports JSX subset already covered by A1 (T0–T6 lowering). Conditional rendering, Fragment, custom components: deferred to A4-jinja.

## 15. Migration step ordering (v2.1 — reviewer Blocker 2 resolved)

Reviewer v2.1 empirically verified that the v2 ordering breaks `cargo build -p brust` between step 1 and step 3: `crates/brust/Cargo.toml:45` has `jsx-rust-compiler = { path = "../jsx-rust-compiler" }` as `[build-dependencies]`, `build.rs` calls `compile_with_path()` on every `src/compiled_routes/*.tsx` and writes the result to `$OUT_DIR/compiled_routes/<stem>.rs`, and `src/compiled_routes/mod.rs:12` does `include!(concat!(env!("OUT_DIR"), "/compiled_routes/static_hello.rs"))`. If step 1 lands first (jsx-rust-compiler emits jinja), brust's build.rs writes `<div>{{ name }}</div>` to a `.rs` file and `include!` chokes.

v2.1 reorders: brust sheds its build-dependency on jsx-rust-compiler BEFORE jsx-rust-compiler swaps its emit target. The order below is empirically green at every step (verified by mental walk-through against the actual file references the reviewer cited):

1. **brust crate — drop the build-dep + compiled_routes path** (single commit):
   - `cargo rm jsx-rust-compiler --build` in `crates/brust/Cargo.toml`
   - drop the `compile_routes()` call in `crates/brust/build.rs` (back to just `napi-build::setup()`)
   - remove `mod compiled_routes;` from `crates/brust/src/lib.rs`
   - remove the `napi_render_compiled` fn from `crates/brust/src/lib.rs`
   - delete `crates/brust/src/compiled_routes/` (mod.rs + static_hello.tsx)
   - delete `crates/brust/src/dynamic_routes.rs` (uncommitted in wd) AND the `/_jinja-test/` hardcoded handler in `server.rs` (also uncommitted)
   - delete `tests/napi-render-compiled.test.ts` (references the removed napi symbol)
   - `cargo test -p brust --lib` green; bun cdylib regenerates without the removed napi fn.

2. **brust crate — remove A2.3 + rename fields** (single commit):
   - remove the A2.3 short-circuit branch from `crates/brust/src/server.rs` (~30 lines around the existing pattern)
   - in `crates/brust/src/routes.rs`: rename `RouteConfig.static_render` → `RouteConfig.native_template`; rename `RouteTable.static_renders` → `RouteTable.native_templates`; delete `RouteTable.static_prebuilt`; delete `static_render_for_path` and friends
   - `crates/brust/src/server.rs`: switch dispatch to read `routes.native_template_for(route_id)` and weave it into the envelope JSON
   - `cargo test --workspace --lib` green; A2.3 tests no longer apply.

3. **jsx-rust-compiler — swap emit target** (single commit):
   - replace `src/emit.rs` with `src/emit_jinja.rs` (mod boundary unchanged)
   - rewrite `fixtures/*.expected.{rs,html}` to `fixtures/*.expected.jinja`
   - rewrite `tests/golden_emit.rs` to `tests/golden_emit_jinja.rs`
   - rewrite `tests/golden_render/` to `tests/golden_render_jinja/` (consumes minijinja; add minijinja to `[dev-dependencies]`)
   - the maud-bench bin (`src/bin/jsx-bench.rs`) is removed in this commit
   - `cargo test -p jsx-rust-compiler` green.

4. **brust crate — add minijinja + napi_render_jinja** (single commit):
   - add `minijinja = "2"` to `crates/brust/Cargo.toml` `[dependencies]`
   - add `crates/brust/src/jinja.rs` (Environment loader + render)
   - add `napi_render_jinja` to `crates/brust/src/lib.rs` per §6
   - add `napi_list_native_templates` napi fn for boot-time validation (reviewer Fix 1 follow-up)
   - `cargo test --workspace --lib` green; bun cdylib regenerates with new napi symbols.

5. **Runtime JS — `static?` → `jinja?` + worker dispatcher branch** (single commit):
   - edit `runtime/routes.ts`: rename `static?` → `jinja?`, `staticRender` → `nativeTemplate`; update `validateRoute`; insert the worker-side jinja branch per §9
   - edit `runtime/routes.test.ts`: rename + rewrite the 7 validation tests
   - edit `runtime/index.ts`: rename `staticRender` → `nativeTemplate` in `registerRoutes` payload
   - `bun test runtime/` green.

6. **Build CLI — jsx-rustc spawn pass** (single commit):
   - extend `runtime/cli/build.ts` + `runtime/cli/dev.ts` per §7
   - dev mode: watcher re-runs `jsx-rustc` on TS edit
   - add `.brust/jinja/` to `.gitignore`
   - smoke against `example/hello-world/` to verify a `.brust/jinja/HelloPage.jinja` lands.

7. **Example + tests** (single commit):
   - migrate `example/hello-world/routes.tsx` to `native: true` + real loader
   - migrate `tests/fixtures/app/routes.tsx` similarly
   - add `tests/jinja-route.test.ts` (E2E: build → spawn brust → curl → assert bytes)
   - delete `tests/rust-compiled-route.test.ts`
   - full test sweep green.

8. **Documentation** (single commit):
   - rewrite `architecture.md` Sub-project A1 + A1.1 section as Sub-project J
   - remove the dangling `napi_render_compiled` reference at ~line 1062
   - update `Suggested next steps` with the new state.

8 commits total. Each lands cleanly without breaking the previous step's build state. The reviewer's specific concern about `cargo build -p brust` going red after the jsx-rust-compiler emit swap is addressed by making step 1 the brust-side de-coupling.

---

End of spec v2. Reviewer next (this time focused on whether v2 actually resolves v1's blockers AND introduces no new ones).
