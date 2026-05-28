# Spec — Dynamic routes: swc-emitted jinja in `.brust/jinja/` + JS-loader-over-SAB

**Date:** 2026-05-28
**Branch:** `refactor/cargo-workspace`
**Parent:** `f8c5f6f` (spec v1 — superseded by this v2 in-place)
**Replaces:** A1 maud emit target, A2.0–A2.3 static-render chain. **Does NOT replace jsx-rust-compiler**; the crate is repurposed as the JSX→jinja transformer.

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
4. Routes mark `jinja: true`; Component.name keys into the template registry.
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
  { path: '/profile/{user}', Component: Profile, jinja: true,
    loader: async ({ params }) => ({ user: params.user, joinedAt: '2026-05-28' }) },
])
```

The framework:
1. At `brust build`/`brust dev`, scans routes; for each `jinja: true` entry, compiles its Component's source `.tsx` via the (renamed/extended) `jsx-rustc` → writes `.brust/jinja/Profile.jinja`:
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
| `crates/jsx-rust-compiler/Cargo.toml` | `-maud` (dev-dep) `-bench` feature flag |
| `crates/jsx-rust-compiler/src/lib.rs` | `-mod emit` `+mod emit_jinja`; `compile` returns jinja source |
| `crates/jsx-rust-compiler/src/bin/jsx-rustc.rs` | unchanged at the arg level, but now writes `.jinja` not `.rs` |
| `crates/jsx-rust-compiler/src/bin/jsx-bench.rs` | retired (was maud-render bench) OR kept as `bench-jinja` that bench-renders via minijinja against the new goldens |
| `crates/brust/Cargo.toml` | `-maud` `-jsx-rust-compiler` (build-dep) `+minijinja = "2"` |
| `crates/brust/build.rs` | drop the `compiled_routes/*.tsx` scan; build script is back to just `napi-build::setup()` |
| `crates/brust/src/lib.rs` | `-mod compiled_routes` `-fn napi_render_compiled` `+mod jinja` `+fn napi_render_jinja` |
| `crates/brust/src/routes.rs` | `RouteConfig.static_render` → `RouteConfig.jinja_template`; `RouteTable.static_renders/static_prebuilt` → `RouteTable.jinja_templates: RwLock<Vec<Option<String>>>` |
| `crates/brust/src/server.rs` | drop A2.3 short-circuit branch; drop the bench-only `/_jinja-test/{name}` handler in uncommitted wd; render dispatch flow unchanged (still goes through `dispatch_to_worker_and_stream_chunks`) |
| `runtime/routes.ts` | `static?: boolean` → `jinja?: boolean`; `staticRender` → `jinjaTemplate`; validateRoute block rewritten; A2.2-era stale comment block removed |
| `runtime/routes.test.ts` | 7 validation tests renamed/rewritten; `staticRender` assertion → `jinjaTemplate` |
| `runtime/index.ts` | `registerRoutes` payload field renamed |
| `runtime/cli/build.ts` and `runtime/cli/dev.ts` | NEW pass: scan routes for `jinja: true`, resolve Component source path, invoke jsx-rustc, write `.brust/jinja/<Name>.jinja`. Re-run on TS edit during `dev` |
| `example/hello-world/routes.tsx` | migrate `/_rust-static` route (`static: true`) to `jinja: true` + a real loader |
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
  routes.tsx                    ← { path, Component: Profile, jinja: true, loader }
  .brust/
    css/                        ← (existing — built CSS extraction)
    jinja/                      ← NEW — JSX-compiled jinja templates
      Profile.jinja             ← <div><h1>{{ user }}</h1>...</div>

BRUST BUILD (runtime/cli/build.ts):
  1. scan routes for `jinja: true` entries
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
                          (route has jinjaTemplate?)
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
                             - http::build_response(200, "text/html; charset=utf-8", &[], html.bytes())
                             - send framed bytes via RenderChunk::BytesAndFinal (existing chunk channel)
                          per-conn task:
                             - receives RenderChunk::BytesAndFinal
                             - writes to TCP (existing path)
```

**Reviewer Blocker 1 resolved**: Rust calls `http::build_response()` to produce the FULL framed HTTP/1.1 bytes, then ships them as `RenderChunk::BytesAndFinal { data, ack }` on the existing chunk channel. The per-conn task `write_all`s those bytes verbatim — identical treatment to the bytes JS produces via `emitSingleChunkResponse`. NOT a new IPC primitive; the bytes-direction stays JS→Rust→TCP (Rust just inserts itself as a middleware that builds the body instead of being a dumb pipe). The previous spec's contradiction (build_response + per-conn task) is now explicit: Rust frames AND sends-to-channel. NOT `write_all` directly to socket.

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
  jinja?: boolean
  // ... existing fields
}
```

Validation (`validateRoute`):
- `jinja: true` requires `Component` and `Component.name` non-empty (named function or named class).
- ALLOWS `loader` (whole point — loader feeds data).
- ALLOWS `middleware`.
- REJECTS `sse`, `websocket`, `children`, `cache`, `static` (last as cleanup).

`FlatRoute.jinjaTemplate?: string` = `leaf.Component.name` when `leaf.jinja === true`.

`registerRoutes` payload gains `jinjaTemplate: r.jinjaTemplate ?? null`.

**Reviewer OQ 1 + 2 resolved**: keep `jinja: true` + Component.name as key, because Component IS the source file the compiler consumes. The minifier-name-mangling concern is real but addressed at build time: jsx-rustc reads the function name from the `export default function Foo(...)` AST node, NOT from minified output. The runtime registry key matches that AST-time name (which is preserved in user source). For routes registered AFTER bundling, the FlatRoute carries the build-time name in `jinjaTemplate` field — not Component.name at runtime. So minifiers can rename Component all they like; the registry still hits.

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
use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

use minijinja::{Environment, UndefinedBehavior};
use parking_lot::RwLock;

static ENV: OnceLock<RwLock<Environment<'static>>> = OnceLock::new();

/// Boot-time: load every `.brust/jinja/*.jinja` into the static Environment.
/// Called by `brust::run()` before serving. `dir` is `.brust/jinja/` resolved
/// relative to the entry's CWD (or wherever the runtime points it).
///
/// Failures (missing dir, unreadable file, parse error) panic — these are
/// developer-time bugs the build pipeline failed to catch.
pub fn load_from(dir: &Path) -> Vec<String> {
    let mut env = Environment::new();
    env.set_undefined_behavior(UndefinedBehavior::Strict); // reviewer OQ 3
    let mut names = Vec::new();

    // Read all .jinja files in dir; templates owned by the environment as
    // 'static via leaking each source string (small set, one-time leak).
    // ... (full impl in plan)

    ENV.set(RwLock::new(env)).expect("jinja env initialized once");
    names
}

/// Per-request render: `data_json` is a slice of UTF-8 bytes from SAB.
/// Returns the rendered HTML; caller wraps in HTTP response.
pub fn render(name: &str, data_json: &[u8]) -> Result<String, RenderError> {
    let env_lock = ENV.get().ok_or(RenderError::NotLoaded)?;
    let env = env_lock.read();
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
/// to verify every `jinja: true` route's Component.name maps to a built
/// template. Reviewer Fix 1.
pub fn registered_templates() -> Vec<String> {
    ENV.get()
        .map(|lock| lock.read().templates().keys().map(String::from).collect())
        .unwrap_or_default()
}
```

A napi shim exposes `napiListJinjaTemplates() -> Vec<String>` so the JS-side `defineRoutes` can validate every `jinja: true` Component.name exists in the registered set (reviewer Fix 1).

### `napi_render_jinja`

```rust
// crates/brust/src/lib.rs
#[napi]
pub async fn napi_render_jinja(
    worker_id: u32,
    data_len: u32,
    template_name: String,
) -> NapiResult<()> {
    // 1. Get the worker's BufPtr + total_len from the pool.
    // 2. Bounds-check: data_len <= total_len.
    // 3. SAFETY: BufPtr is pinned at register time; slice up to data_len.
    // 4. Call jinja::render(&template_name, sab_slice)
    // 5. Match RenderError to HTTP status:
    //      - NotLoaded → 500 (boot bug)
    //      - UnknownTemplate → 500 (config drift — Fix 1 catches at boot)
    //      - BadJson → 500 (loader bug)
    //      - Render → 500 (template bug)
    // 6. Build framed response via http::build_response(status, "text/html; ...", &[], html.into_bytes()).
    // 7. Send via RenderChunk::BytesAndFinal { data, ack: ack_tx } on the
    //    worker's chunk_tx (mirrors how napi_render_chunk_final works at
    //    crates/brust/src/lib.rs:570).
    // 8. await ack_rx (per-conn task ack semantics unchanged).
    ...
}
```

Reviewer's Blocker 1: this routes the rendered bytes through the SAME `RenderChunk` channel + ack semantics as existing chunks — no new IPC primitive, no direct socket write from napi. The bytes Rust ships look identical to the bytes JS would have shipped via `emitSingleChunkResponse`. Per-conn task can't tell the difference.

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
const jinjaRoutes = flat.filter(r => r.jinjaTemplate !== undefined)
const outDir = resolve(cwd, '.brust/jinja')
mkdirSync(outDir, { recursive: true })

for (const r of jinjaRoutes) {
  const componentName = r.jinjaTemplate!
  const sourcePath = resolveComponentSource(r) // walk r.chain, find leaf's Component import
  const outPath = resolve(outDir, `${componentName}.jinja`)
  
  const result = spawnSync('jsx-rustc', [sourcePath, '--target=jinja', '-o', outPath])
  if (result.status !== 0) throw new Error(`jsx-rustc failed for ${sourcePath}: ${result.stderr}`)
}

// Manifest for the runtime to verify against
writeFileSync(resolve(outDir, '_manifest.json'), JSON.stringify({
  templates: jinjaRoutes.map(r => r.jinjaTemplate),
  generatedAt: new Date().toISOString(),
}))
```

For dev mode (`brust dev`): the watcher already exists for TS edits. When a route's Component source changes, re-run `jsx-rustc` for THAT route only and signal the brust runtime to reload that template (via the existing dev WS channel or a new "reload jinja" command).

### `jsx-rustc` CLI changes

- Add `--target=jinja|maud` (default jinja in v2 once maud target is removed)
- Output extension follows target (`.jinja` for jinja, `.rs` for maud)
- All other args unchanged

For v2 cleanup: maud target is removed entirely; the `--target` flag accepts only `jinja` (or omit it — implicit). Plan can decide whether to keep the flag as future-proofing or drop it.

## 8. Server dispatch (server.rs)

Render dispatch flow is **unchanged** in shape from current main. The A2.3 short-circuit is removed; render goes through `dispatch_to_worker_and_stream_chunks` like any React route. The difference: the envelope JSON gains a `jinja_template` field; the JS worker reads it and branches to the SAB-write path instead of the React render path.

```rust
let envelope_json = build_render_envelope(
    method, full_path, query, raw_request,
    /* NEW */ jinja_template: routes.jinja_template_for(route_id),
);
dispatch_to_worker_and_stream_chunks(envelope_json, "render", cache_wanted, on_success).await
```

No `static_prebuilt`, no `static_render`, no short-circuit. Reviewer Blocker 2 (migration build-state) is moot because the rewrite is a CLEAN swap, not delete-then-add.

## 9. Worker-side dispatcher (`runtime/routes.ts`)

The worker's render branch currently calls `renderBranchStreaming(element, ...)` (React path). After v2, it branches on `flat.jinjaTemplate`:

```ts
if (call.kind === 'render') {
  const flat = byRouteId.get(call.route_id)
  // ... middleware chain runs (unchanged)
  // verdict._brustStream check (unchanged)

  if (flat.jinjaTemplate !== undefined) {
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
      await (native as any).napiRenderJinja(Number(workerId), dataBytes.length, flat.jinjaTemplate)
    } catch (err) {
      console.error(`[brust] napiRenderJinja failed for "${flat.jinjaTemplate}":`, err)
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
4. `bun test runtime/` passes; new validation tests cover `jinja: true`.
5. `bun test tests/jinja-route.test.ts` passes.
6. `bun test tests/integration.test.ts -t 'serves rendered html'` passes (React unchanged).
7. **Reviewer Fix 3 (lowered bar)**: `oha -c 120 -z 10s -m GET /jinja-test/X` measures **≥60,000 RPS** on M1 Pro (floor). 90k+ is a stretch goal; numbers below 60k blocked.
8. `cargo clippy -p brust --lib -- -D warnings` clean; same for `-p jsx-rust-compiler`.
9. `grep -rn -E 'maud|static: true|staticRender|rustCompiled|napi_render_compiled|compiled_routes' --include='*.rs' --include='*.ts' --include='*.tsx' --include='*.toml'` returns ZERO hits across the tree (reviewer Blocker 3 — exhaustive).
10. `.brust/jinja/_manifest.json` lists every `jinja: true` route's Component.name; `bun run build` produces a `.jinja` file for each.
11. **Reviewer Fix 1**: at brust boot, `napiListJinjaTemplates()` must include every `jinja: true` route's Component.name. Mismatch logs a warning and the route falls back to 500 at runtime; in v2 this is dev-time noise, not a panic. Future: pre-flight validation panics on boot.

## 12. Known limitations (shipped state)

- Per-app templates committed under user's `pages/*.tsx`, built to `.brust/jinja/`. Brust framework ships zero templates (no built-ins). Future: framework-supplied templates (error pages, layouts) live in `brust/templates/` and merge into the user's Environment.
- Cache integration deferred (`cache` field rejected when `jinja: true`).
- Nested `loader` for children of a `jinja: true` route is not composited (only leaf's loader runs). Composition is a follow-up.
- minijinja's `Strict` undefined mode means typos in templates fail loudly at render — a feature, but breaks if a loader sometimes returns `{}`. Recommendation: loader return value should always include the keys the template references; use `{% if x is defined %}` to gate optional vars.
- `Component` body is REAL React code. Best practice: write Components that work as both React (for unit testing the JSX shape) AND get analyzed by jsx-rustc (for jinja output). Documentation to make this explicit. In dev mode v2 does NOT fall back to React on missing template — future enhancement.
- `jsx-rust-compiler` loses the maud emit target. Past A1+A1.1 work (the maud-only T7-T11) is partially retired. The IR + parser + lower (T0-T6) are preserved verbatim.
- SAB size cap = per-worker registered length (currently ~64KB). Loader payloads larger than that get 413 — most apps stay well under.
- Hot reload of templates during `brust dev`: SUPPORTED in spec but plan-time decision on whether to land in v2 or follow-up. The minijinja Environment is wrapped in `RwLock` so the runtime can swap templates without restarting.

## 13. Open questions resolved at plan-time

1. **Field name**: `jinja: true` (per user's "true แบบ static: true"). Open to plan-time bikeshed but no functional impact.
2. **Registry key**: `Component.name` (Reviewer OQ 1+2 — keeping). Minifier safety addressed §4.
3. **Template directory**: `.brust/jinja/` (user direction — under user's project, like `.brust/css/`).
4. **Maud target retire**: full retire — no `--target=maud` flag in v2. Plan can resurrect if needed; no current consumer.
5. **Component-as-marker footgun**: resolved — Component IS the source, not a marker. Reviewer Fix 2.
6. **Undefined behavior**: minijinja `Strict` mode (reviewer OQ 3). Templates that reference undefined vars fail at render → 500.
7. **Migration atomicity**: single commit fine since the swap is symmetric (maud target → jinja target, static path → jinja path) — none of the cleanup leaves an intermediate broken state. Reviewer Blocker 2 addressed.
8. **Hot reload of templates in dev**: spec aspires; plan can defer to v2.1. Wrap minijinja Environment in `RwLock` so the reload path doesn't require a restart.
9. **Pre-flight template validation**: log-only in v2 (reviewer Fix 1 deferred to v2.1; deferred again here for scope discipline).

## 14. Out of scope (acceptable deferrals)

- Per-app templates outside of `Component`'s source file (e.g. user wants two routes pointing at the same `.jinja` — for v2, write two Component files).
- Cache integration for jinja routes.
- Streaming render via minijinja's `Environment::stream` (current spec uses sync render to String).
- Dev-mode React-fallback when `.jinja` is missing (future polish).
- Loader-side prop validation enforced by jsx-rustc parsing the loader's return type.
- minijinja extensions (custom filters, autoescape per-template) — defaults are fine for v2.
- v2 only supports JSX subset already covered by A1 (T0–T6 lowering). Conditional rendering, Fragment, custom components: deferred to A4-jinja.

## 15. Migration step ordering (responding to reviewer Blocker 2)

Reviewer's concern: cargo build red between intermediate file-write steps. v2 answers: the cleanup is a clean swap, not delete-then-add, so each file edit individually keeps the build green. The order below produces a green build at EVERY intermediate commit (proven by mental simulation; verified at plan time):

1. **jsx-rust-compiler**: replace `emit.rs` with `emit_jinja.rs` (mod boundary unchanged); rewrite fixtures + goldens to expected.jinja shape; `cargo test -p jsx-rust-compiler` green.
2. **brust crate**: add `+minijinja = "2"` to Cargo.toml; add `mod jinja; mod jinja_routes;` to lib.rs; add `napi_render_jinja` stub fn. Build still green (the new code compiles; old code untouched).
3. **brust crate cleanup**: remove `napi_render_compiled` (and its callers — only the deleted Bun test references it); remove `mod compiled_routes`; remove `mod dynamic_routes`; delete the related files. cargo build green.
4. **brust crate routes.rs**: rename `static_render` field → `jinja_template` (consistent rename via sed/Edit replace_all); rename `static_renders` → `jinja_templates`; remove `static_prebuilt`; remove `static_render_for` and `static_prebuilt_for_path`. cargo build green.
5. **brust crate server.rs**: remove the A2.3 short-circuit + the uncommitted `/_jinja-test` hardcoded handler. cargo build green.
6. **Runtime JS**: edit `runtime/routes.ts` to rename `static?` → `jinja?` + `staticRender` → `jinjaTemplate`; update validateRoute; update the worker dispatcher. `bun run build` regenerates `.node` + `.d.ts`; `bun test runtime/` runs.
7. **Build CLI**: extend `runtime/cli/build.ts` + `runtime/cli/dev.ts` to scan + spawn `jsx-rustc` + emit `.brust/jinja/`.
8. **Example + tests**: migrate routes to `jinja: true`; rewrite `tests/jinja-route.test.ts`; delete `tests/napi-render-compiled.test.ts` + `tests/rust-compiled-route.test.ts`.
9. **Documentation**: rewrite `architecture.md` Sub-project A1/A1.1 section as Sub-project J; commit.

Each step lands in 1–2 commits. The final tree state is what §10 / §11 reference.

---

End of spec v2. Reviewer next (this time focused on whether v2 actually resolves v1's blockers AND introduces no new ones).
